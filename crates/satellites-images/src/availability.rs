//! Actual UTC acquisition-date counts from bounded STAC search result pages.
//! Complete means all *requested-provider* next links were exhausted, not a full global census.
use std::collections::{BTreeMap, BTreeSet, HashSet};
use serde::{Deserialize, Serialize};
use crate::{Error, Scene, SearchPage};

#[derive(Debug,Clone,Serialize,Deserialize,PartialEq)]
pub struct AvailabilityDay {
    pub date:String,
    pub count:usize,
    pub missions:BTreeMap<String,usize>,
    pub collections:BTreeMap<String,usize>,
}
#[derive(Debug,Clone,Serialize,Deserialize,PartialEq)]
pub struct AvailabilityMonth {
    pub month:String,
    pub count:usize,
    pub days_with_observations:usize,
    pub missions:BTreeMap<String,usize>,
}
#[derive(Debug,Clone,Serialize,Deserialize,PartialEq)]
pub struct ProviderAvailability {
    pub id:String,
    pub pages_scanned:usize,
    pub raw_items:usize,
    pub unique_items:usize,
    pub matched:Option<u64>,
    pub has_more:bool,
}
#[derive(Debug,Clone,Serialize,Deserialize,PartialEq)]
pub struct AvailabilitySummary {
    pub days:Vec<AvailabilityDay>,
    pub months:Vec<AvailabilityMonth>,
    pub providers:Vec<ProviderAvailability>,
    pub pages_scanned:usize,
    pub raw_items:usize,
    pub unique_items:usize,
    pub complete:bool,
    pub truncated_providers:Vec<String>,
    pub errored_providers:Vec<String>,
}
#[derive(Default)]
struct MonthlyCounts {
    count:usize,
    days:HashSet<String>,
    missions:BTreeMap<String,usize>,
}
#[derive(Default)]
pub struct AvailabilityAccumulator {
    seen:HashSet<(String,String,String)>,
    days:BTreeMap<String,AvailabilityDay>,
    months:BTreeMap<String,MonthlyCounts>,
    providers:BTreeMap<String,ProviderAvailability>,
    errors:BTreeSet<String>,
    pages_scanned:usize,
    raw_items:usize,
}
fn increment(map:&mut BTreeMap<String,usize>,key:&str) {
    *map.entry(key.to_string()).or_insert(0)+=1;
}
impl AvailabilityAccumulator {
    pub fn new()->Self {Self::default()}

    /// Record that a provider's scan failed part-way; partial counts are retained.
    pub fn mark_error(&mut self,provider_id:&str) {
        if !provider_id.is_empty() {self.errors.insert(provider_id.to_string());}
    }

    pub fn add_page(&mut self,page:&SearchPage)->Result<Vec<Scene>,Error> {
        if page.provider_id.is_empty()||page.page_number==0 {
            return Err(Error::InvalidResponse("Invalid page identity".into()));
        }
        let provider=self.providers.entry(page.provider_id.clone()).or_insert(
            ProviderAvailability{
                id:page.provider_id.clone(),pages_scanned:0,raw_items:0,
                unique_items:0,matched:None,has_more:false,
            }
        );
        provider.pages_scanned+=1;
        provider.raw_items+=page.items.len();
        provider.has_more=page.has_next;
        if let Some(matched)=page.matched {provider.matched=Some(matched);}
        self.pages_scanned+=1;
        self.raw_items+=page.items.len();
        let mut novel=Vec::new();
        for scene in &page.items {
            let key=(page.provider_id.clone(),scene.collection.clone(),scene.id.clone());
            if !self.seen.insert(key){continue;}
            provider.unique_items+=1;
            novel.push(scene.clone());
            let day=scene.acquired_at.get(0..10)
                .ok_or_else(||Error::InvalidResponse("Invalid normalized UTC date".into()))?
                .to_string();
            let parsed=chrono::NaiveDate::parse_from_str(&day,"%Y-%m-%d")
                .map_err(|_|Error::InvalidResponse("Invalid normalized UTC date".into()))?;
            let month=parsed.format("%Y-%m").to_string();
            let mission=scene.mission.as_deref().unwrap_or("unknown");
            let collection=if scene.collection.is_empty(){"unknown"}else{&scene.collection};
            let daily=self.days.entry(day.clone()).or_insert(AvailabilityDay{
                date:day.clone(),count:0,missions:BTreeMap::new(),collections:BTreeMap::new(),
            });
            daily.count+=1;
            increment(&mut daily.missions,mission);
            increment(&mut daily.collections,collection);
            let monthly=self.months.entry(month).or_default();
            monthly.count+=1;
            monthly.days.insert(day);
            increment(&mut monthly.missions,mission);
        }
        Ok(novel)
    }
    pub fn summary(&self)->AvailabilitySummary {
        let providers:Vec<_>=self.providers.values().cloned().collect();
        let truncated_providers:Vec<_>=providers.iter()
            .filter(|provider|provider.has_more).map(|provider|provider.id.clone()).collect();
        let months=self.months.iter().map(|(month,counts)|AvailabilityMonth{
            month:month.clone(),count:counts.count,
            days_with_observations:counts.days.len(),
            missions:counts.missions.clone(),
        }).collect();
        AvailabilitySummary {
            days:self.days.values().cloned().collect(),months,
            providers, pages_scanned:self.pages_scanned, raw_items:self.raw_items,
            unique_items:self.seen.len(),complete:!self.providers.is_empty()&&truncated_providers.is_empty(),
            truncated_providers,
            errored_providers:self.errors.iter().cloned().collect(),
        }
    }
}
pub fn summarize_availability(pages:&[SearchPage])->Result<AvailabilitySummary,Error> {
    let mut accumulator=AvailabilityAccumulator::new();
    for page in pages {accumulator.add_page(page)?;}
    Ok(accumulator.summary())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(id:&str,time:&str)->Scene {
        Scene {
            provider_id:"earth-search".into(),
            id:id.into(),collection:"sentinel-2-l2a".into(),
            acquired_at:time.into(),mission:Some("sentinel-2a".into()),
            geometry:None,bbox:None,cloud_cover_percent:None,coverage_percent:None,preview_url:None,
            access:"unknown".into(),assets:Vec::new(),source_url:None,raw:json!({}),
        }
    }
    fn page(provider:&str,items:Vec<Scene>,number:usize,has_next:bool)->SearchPage {
        SearchPage{
            provider_id:provider.into(),items,page_number:number,has_next,matched:None,
        }
    }
    #[test]
    fn grouping_and_duplication_keep_utc_dates(){
        let mut acc=AvailabilityAccumulator::new();
        acc.add_page(&page("earth-search",vec![
            item("a","2025-01-31T23:55:00.000Z"),
            item("b","2025-02-01T00:05:00.000Z"),
        ],1,true)).unwrap();
        assert!(!acc.summary().complete);
        acc.add_page(&page("earth-search",vec![
            item("a","2025-01-31T23:55:00.000Z"),
            item("c","2025-02-01T02:00:00.000Z"),
        ],2,false)).unwrap();
        let summary=acc.summary();
        assert!(summary.complete);
        assert_eq!(summary.unique_items,3);
        assert_eq!(summary.raw_items,4);
        assert_eq!(summary.months.len(),2);
        assert_eq!(summary.months[1].days_with_observations,1);
        assert_eq!(summary.days[1].count,2);
    }
    #[test]
    fn different_providers_are_not_falsely_collapsed(){
        let scene=item("a","2025-02-01T00:05:00.000Z");
        let summary=summarize_availability(&[
            page("earth-search",vec![scene.clone()],1,true),
            page("planetary-computer",vec![scene],1,false),
        ]).unwrap();
        assert_eq!(summary.unique_items,2);
        assert_eq!(summary.truncated_providers,vec!["earth-search"]);
        assert!(!summary.complete);
    }
    #[test]
    fn empty_summary_is_not_complete(){
        let result=summarize_availability(&[]).unwrap();
        assert!(!result.complete);
    }
}
