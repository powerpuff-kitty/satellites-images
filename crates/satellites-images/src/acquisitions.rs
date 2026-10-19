//! Official ESA Sentinel-1/Sentinel-2 future acquisition plans.
//! Planned swaths are not published scenes or guaranteed future products.
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, SecondsFormat, Utc};
use regex::Regex;
use reqwest::{Client, Url};
use roxmltree::{Document, Node};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Mutex,
    time::{Duration as StdDuration, Instant},
};

use crate::{bounds_around, Error};

const ORIGIN: &str = "https://sentinels.copernicus.eu";
const S1_INDEX: &str = "https://sentinels.copernicus.eu/copernicus/sentinel-1/acquisition-plans";
const S2_INDEX: &str = "https://sentinels.copernicus.eu/copernicus/sentinel-2/acquisition-plans";
const MISSIONS: &[&str] = &["S1C", "S1D", "S2A", "S2B", "S2C"];
type QueryWindow = (DateTime<Utc>, DateTime<Utc>, [f64; 4]);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcquisitionQuery {
    pub latitude: f64,
    pub longitude: f64,
    pub radius_meters: f64,
    pub from: Option<String>,
    pub to: Option<String>,
    pub days: u32,
    pub missions: Vec<String>,
}
impl AcquisitionQuery {
    pub fn new(lat: f64, lon: f64, radius: f64, days: u32) -> Result<Self, Error> {
        let query = Self {
            latitude: lat,
            longitude: lon,
            radius_meters: radius,
            from: None,
            to: None,
            days,
            missions: MISSIONS.iter().map(|s| (*s).into()).collect(),
        };
        query.validate()?;
        Ok(query)
    }
    pub fn validate(&self) -> Result<(), Error> {
        bounds_around(self.latitude, self.longitude, self.radius_meters)?;
        if !(1..=366).contains(&self.days) {
            return Err(Error::InvalidQuery("days must be between 1 and 366".into()));
        }
        if self.missions.is_empty()
            || self
                .missions
                .iter()
                .any(|m| !MISSIONS.contains(&m.as_str()))
        {
            return Err(Error::InvalidQuery("Unsupported ESA mission filter".into()));
        }
        Ok(())
    }
    fn window(&self, now: DateTime<Utc>) -> Result<QueryWindow, Error> {
        self.validate()?;
        let start = self
            .from
            .as_deref()
            .map(|s| parse_day(s, "from"))
            .transpose()?
            .unwrap_or(now)
            .max(now);
        let end = self
            .to
            .as_deref()
            .map(|s| parse_day(s, "to"))
            .transpose()?
            .map(|d| d + Duration::days(1) - Duration::milliseconds(1))
            .unwrap_or(now + Duration::days(i64::from(self.days)));
        if end < start || end - start > Duration::days(367) {
            return Err(Error::InvalidQuery(
                "Invalid upcoming window (maximum 367 days)".into(),
            ));
        }
        Ok((
            start,
            end,
            bounds_around(self.latitude, self.longitude, self.radius_meters)?,
        ))
    }
}
fn parse_day(s: &str, field: &str) -> Result<DateTime<Utc>, Error> {
    if s.len() != 10 || !s.is_ascii() {
        return Err(Error::InvalidQuery(format!("{field} must be YYYY-MM-DD")));
    }
    let date = NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|_| Error::InvalidQuery(format!("{field} must be a valid YYYY-MM-DD date")))?;
    let result = date
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| Error::InvalidQuery("Invalid day".into()))?;
    Ok(result.and_utc())
}
fn utc(text: &str) -> Option<DateTime<Utc>> {
    let value = text.trim();
    let parsed = if value.ends_with('Z')
        || value.ends_with('z')
        || value.as_bytes().iter().skip(10).any(|b| *b == b'+')
    {
        value.to_owned()
    } else {
        format!("{value}Z")
    };
    DateTime::parse_from_rfc3339(&parsed)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ESAPlan {
    pub mission: String,
    pub url: String,
    pub starts_at: String,
    pub ends_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquisitionOpportunity {
    pub id: String,
    pub provider_id: String,
    pub mission: String,
    pub expected_at: String,
    pub end_at: Option<String>,
    pub status: String,
    pub source_url: String,
    pub footprint: Value,
    pub mode: Option<String>,
    pub orbit_relative: Option<u32>,
}

/// One selected plan contributing to an upcoming query.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ESAPlanDiagnostic {
    pub mission: String,
    pub source_url: String,
    pub starts_at: String,
    pub ends_at: String,
    pub from_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ESAUpcomingResult {
    pub opportunities: Vec<AcquisitionOpportunity>,
    /// UTC time the query last downloaded a plan body, or None when none was read.
    pub fetched_at: Option<String>,
    pub plans: Vec<ESAPlanDiagnostic>,
    /// "ok" | "no-current-plan" | "no-overlap".
    pub status: String,
}

pub fn parse_esa_plan_index(html: &str) -> Result<Vec<ESAPlan>, Error> {
    if html.len() > 2_000_000 {
        return Err(Error::InvalidResponse(
            "ESA index size limit exceeded".into(),
        ));
    }
    let href = Regex::new(r#"(?i)href\s*=\s*["']([^"']+)["']"#)
        .map_err(|e| Error::InvalidResponse(e.to_string()))?;
    let slug = Regex::new(r"(?i)(s[12][a-d]_mp_(?:acq__kml|user)_(\d{8}t\d{6})_(\d{8}t\d{6}))")
        .map_err(|e| Error::InvalidResponse(e.to_string()))?;
    let origin = Url::parse(ORIGIN).map_err(|e| Error::InvalidResponse(e.to_string()))?;
    let mut seen = HashMap::new();
    for item in href.captures_iter(html) {
        let Some(raw) = item.get(1) else { continue };
        let Ok(url) = origin.join(&raw.as_str().replace("&amp;", "&")) else {
            continue;
        };
        if url.scheme() != "https"
            || url.host_str() != Some("sentinels.copernicus.eu")
            || url.port_or_known_default() != Some(443)
            || !url.path().starts_with("/documents/")
        {
            continue;
        }
        let Some(parts) = slug.captures(url.path()) else {
            continue;
        };
        let stem = parts.get(1).unwrap().as_str().to_lowercase();
        let mission = stem[..3].to_uppercase();
        if !MISSIONS.contains(&mission.as_str()) {
            continue;
        }
        let parse_slug = |idx: usize| {
            NaiveDateTime::parse_from_str(parts.get(idx).unwrap().as_str(), "%Y%m%dt%H%M%S")
                .ok()
                .map(|n| n.and_utc().to_rfc3339_opts(SecondsFormat::Secs, true))
        };
        let (Some(start), Some(end)) = (parse_slug(2), parse_slug(3)) else {
            continue;
        };
        if start > end {
            continue;
        }
        seen.insert(
            format!("{mission}:{stem}"),
            ESAPlan {
                mission,
                url: url.to_string(),
                starts_at: start,
                ends_at: end,
            },
        );
    }
    let mut result: Vec<_> = seen.into_values().collect();
    result.sort_by(|a, b| {
        a.mission
            .cmp(&b.mission)
            .then_with(|| b.starts_at.cmp(&a.starts_at))
            .then_with(|| b.ends_at.cmp(&a.ends_at))
    });
    Ok(result)
}

type Pt = [f64; 2];
fn coordinates(value: &str) -> Vec<Pt> {
    let mut result = Vec::new();
    for word in value.split_whitespace() {
        let mut fields = word.split(',');
        let (Some(x), Some(y)) = (fields.next(), fields.next()) else {
            return Vec::new();
        };
        let (Ok(x), Ok(y)) = (x.parse::<f64>(), y.parse::<f64>()) else {
            return Vec::new();
        };
        if !x.is_finite()
            || !y.is_finite()
            || !(-180.0..=180.0).contains(&x)
            || !(-90.0..=90.0).contains(&y)
        {
            return Vec::new();
        }
        result.push([x, y]);
        if result.len() > 50_000 {
            return Vec::new();
        }
    }
    if result.len() < 3 {
        return Vec::new();
    }
    if result.last() != result.first() {
        let first = result[0];
        result.push(first);
    }
    result
}
fn point_inside(p: Pt, ring: &[Pt]) -> bool {
    let mut inside = false;
    for win in ring.windows(2) {
        let (a, b) = (win[0], win[1]);
        if (a[1] > p[1]) != (b[1] > p[1])
            && p[0] < a[0] + (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1])
        {
            inside = !inside;
        }
    }
    inside
}
fn segment_intersects(a: Pt, b: Pt, c: Pt, d: Pt) -> bool {
    let cross = |u: Pt, v: Pt, w: Pt| (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
    let on = |u: Pt, v: Pt, w: Pt| {
        w[0] >= u[0].min(v[0]) - 1e-9
            && w[0] <= u[0].max(v[0]) + 1e-9
            && w[1] >= u[1].min(v[1]) - 1e-9
            && w[1] <= u[1].max(v[1]) + 1e-9
    };
    let (ac, ad, ca, cb) = (
        cross(a, b, c),
        cross(a, b, d),
        cross(c, d, a),
        cross(c, d, b),
    );
    if ((ac > 0.0 && ad < 0.0) || (ac < 0.0 && ad > 0.0))
        && ((ca > 0.0 && cb < 0.0) || (ca < 0.0 && cb > 0.0))
    {
        return true;
    }
    (ac.abs() < 1e-9 && on(a, b, c))
        || (ad.abs() < 1e-9 && on(a, b, d))
        || (ca.abs() < 1e-9 && on(c, d, a))
        || (cb.abs() < 1e-9 && on(c, d, b))
}
fn intersects(ring: &[Pt], bbox: [f64; 4]) -> bool {
    let [w, s, e, n] = bbox;
    let rect = [[w, s], [w, n], [e, n], [e, s]];
    if ring
        .iter()
        .any(|p| p[0] >= w && p[0] <= e && p[1] >= s && p[1] <= n)
        || rect.iter().any(|p| point_inside(*p, ring))
    {
        return true;
    }
    ring.windows(2)
        .any(|seg| (0..4).any(|j| segment_intersects(seg[0], seg[1], rect[j], rect[(j + 1) % 4])))
}
fn child_text(node: Node<'_, '_>, name: &str) -> Option<String> {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == name)
        .and_then(|n| n.text())
        .map(str::to_owned)
}
fn data(pm: Node<'_, '_>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for node in pm.descendants().filter(|n| n.has_tag_name("Data")) {
        if let (Some(name), Some(value)) = (node.attribute("name"), child_text(node, "value")) {
            map.insert(name.to_owned(), value);
        }
    }
    map
}

pub fn parse_esa_plan_kml(
    kml: &str,
    plan: &ESAPlan,
    bbox: [f64; 4],
    start: DateTime<Utc>,
    stop: DateTime<Utc>,
) -> Result<Vec<AcquisitionOpportunity>, Error> {
    if kml.len() > 20_000_000 || kml.to_ascii_uppercase().contains("<!DOCTYPE") {
        return Err(Error::InvalidResponse("Unsafe or oversized ESA KML".into()));
    }
    let doc = Document::parse(kml).map_err(|e| Error::InvalidResponse(e.to_string()))?;
    let root = doc.root_element();
    if root.tag_name().name() != "kml"
        || root.tag_name().namespace() != Some("http://www.opengis.net/kml/2.2")
    {
        return Err(Error::InvalidResponse(
            "Unexpected ESA KML namespace".into(),
        ));
    }
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    for pm in doc.descendants().filter(|n| n.has_tag_name("Placemark")) {
        let style = child_text(pm, "styleUrl").unwrap_or_default();
        if plan.mission.starts_with("S2") && !style.to_uppercase().contains("NOMINAL") {
            continue;
        }
        let details = data(pm);
        let timespan = pm.descendants().find(|n| n.has_tag_name("TimeSpan"));
        let raw_time = details
            .get("ObservationTimeStart")
            .map(String::as_str)
            .or_else(|| {
                timespan.and_then(|n| {
                    n.children()
                        .find(|c| c.has_tag_name("begin"))
                        .and_then(|c| c.text())
                })
            });
        let Some(at) = raw_time.and_then(utc) else {
            continue;
        };
        if at < start || at > stop {
            continue;
        }
        let mut rings = Vec::<Vec<Pt>>::new();
        for poly in pm.descendants().filter(|n| n.has_tag_name("Polygon")) {
            let coord = poly
                .descendants()
                .find(|n| n.has_tag_name("outerBoundaryIs"))
                .and_then(|outer| outer.descendants().find(|n| n.has_tag_name("coordinates")))
                .and_then(|n| n.text());
            if let Some(value) = coord {
                let ring = coordinates(value);
                if !ring.is_empty() {
                    rings.push(ring);
                }
            }
        }
        if rings.is_empty() || !rings.iter().any(|r| intersects(r, bbox)) {
            continue;
        }
        let timestamp = at.to_rfc3339_opts(SecondsFormat::Millis, true);
        let name = details
            .get("ID")
            .or_else(|| details.get("DatatakeId"))
            .cloned()
            .or_else(|| child_text(pm, "name"))
            .unwrap_or_else(|| timestamp.clone());
        let id = format!("{}:{}:{}", plan.mission, name, timestamp);
        if !seen.insert(id.clone()) {
            continue;
        }
        let stop_time = details
            .get("ObservationTimeStop")
            .map(String::as_str)
            .or_else(|| {
                timespan.and_then(|n| {
                    n.children()
                        .find(|c| c.has_tag_name("end"))
                        .and_then(|c| c.text())
                })
            });
        let end_at = stop_time
            .and_then(utc)
            .map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true));
        let footprint = if rings.len() == 1 {
            json!({"type":"Polygon","coordinates":[rings[0]]})
        } else {
            json!({"type":"MultiPolygon","coordinates":rings.into_iter().map(|r|vec![r]).collect::<Vec<_>>()})
        };
        results.push(AcquisitionOpportunity {
            id,
            provider_id: "esa-sentinel-plans".into(),
            mission: plan.mission.clone(),
            expected_at: timestamp,
            end_at,
            status: "planned".into(),
            source_url: plan.url.clone(),
            footprint,
            mode: details.get("Mode").cloned(),
            orbit_relative: details
                .get("OrbitRelative")
                .and_then(|n| n.parse::<u32>().ok()),
        });
    }
    Ok(results)
}

/// Cached ESA document: (fetched-at, body, ETag, Last-Modified).
type PlanCacheEntry = (Instant, String, Option<String>, Option<String>);

pub struct ESAPlansProvider {
    client: Client,
    missions: Vec<String>,
    cache: Mutex<HashMap<String, PlanCacheEntry>>,
}
impl Default for ESAPlansProvider {
    fn default() -> Self {
        Self::new().expect("ESA provider client")
    }
}
impl ESAPlansProvider {
    pub const ID: &'static str = "esa-sentinel-plans";
    pub fn new() -> Result<Self, Error> {
        Ok(Self {
            client: Client::builder()
                .timeout(StdDuration::from_secs(25))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            missions: MISSIONS.iter().map(|m| (*m).to_owned()).collect(),
            cache: Mutex::new(HashMap::new()),
        })
    }
    fn ttl(url: &str) -> u64 {
        if url == S1_INDEX || url == S2_INDEX {
            900
        } else {
            3600
        }
    }
    async fn fetch_text(&self, url: &str, max_bytes: usize) -> Result<(String, bool), Error> {
        let parsed = Url::parse(url).map_err(|e| Error::InvalidResponse(e.to_string()))?;
        if parsed.scheme() != "https"
            || parsed.host_str() != Some("sentinels.copernicus.eu")
            || parsed.port_or_known_default() != Some(443)
            || (url != S1_INDEX && url != S2_INDEX && !parsed.path().starts_with("/documents/"))
        {
            return Err(Error::InvalidResponse("Unexpected ESA URL".into()));
        }
        let validators = {
            let cache = self
                .cache
                .lock()
                .map_err(|_| Error::InvalidResponse("Cache lock poisoned".into()))?;
            match cache.get(url) {
                Some((created, value, etag, last_modified)) => {
                    if created.elapsed() < StdDuration::from_secs(Self::ttl(url))
                        && value.len() <= max_bytes
                    {
                        return Ok((value.clone(), true));
                    }
                    (etag.clone(), last_modified.clone())
                }
                None => (None, None),
            }
        };
        // RFC 9110 conditional request: only send validators ESA actually supplied.
        let mut request = self.client.get(parsed).header(
            "Accept",
            "text/html, application/xml, application/vnd.google-earth.kml+xml",
        );
        if let (Some(etag), _) = &validators {
            request = request.header("If-None-Match", etag);
        }
        if let (_, Some(last_modified)) = &validators {
            request = request.header("If-Modified-Since", last_modified);
        }
        let mut response = request.send().await?;
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            let mut cache = self
                .cache
                .lock()
                .map_err(|_| Error::InvalidResponse("Cache lock poisoned".into()))?;
            if let Some((_, value, etag, last_modified)) = cache.get(url).cloned() {
                if value.len() > max_bytes {
                    return Err(Error::InvalidResponse(
                        "ESA response exceeds size limit".into(),
                    ));
                }
                cache.insert(
                    url.to_owned(),
                    (Instant::now(), value.clone(), etag, last_modified),
                );
                return Ok((value, true));
            }
            return Err(Error::InvalidResponse(
                "ESA returned 304 without a cached plan".into(),
            ));
        }
        if !response.status().is_success() {
            return Err(Error::Http(response.status().as_u16()));
        }
        if response
            .content_length()
            .is_some_and(|size| size > max_bytes as u64)
        {
            return Err(Error::InvalidResponse(
                "ESA response exceeds size limit".into(),
            ));
        }
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let last_modified = response
            .headers()
            .get(reqwest::header::LAST_MODIFIED)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > max_bytes {
                return Err(Error::InvalidResponse(
                    "ESA response exceeds size limit".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        {
            let mut cache = self
                .cache
                .lock()
                .map_err(|_| Error::InvalidResponse("Cache lock poisoned".into()))?;
            if cache.len() >= 12 {
                cache.clear();
            }
            cache.insert(
                url.to_owned(),
                (Instant::now(), text.clone(), etag, last_modified),
            );
        }
        Ok((text, false))
    }
    pub async fn upcoming_with_diagnostics(
        &self,
        query: &AcquisitionQuery,
    ) -> Result<ESAUpcomingResult, Error> {
        let (start, stop, bbox) = query.window(Utc::now())?;
        let missions: HashSet<&str> = query.missions.iter().map(String::as_str).collect();
        let mut pages = Vec::new();
        if missions.iter().any(|m| m.starts_with("S1")) {
            pages.push(S1_INDEX);
        }
        if missions.iter().any(|m| m.starts_with("S2")) {
            pages.push(S2_INDEX);
        }
        let mut plans = Vec::new();
        for page in pages {
            plans.extend(parse_esa_plan_index(
                &self.fetch_text(page, 2_000_000).await?.0,
            )?);
        }
        let mut newest: BTreeMap<String, ESAPlan> = BTreeMap::new();
        for plan in plans {
            if !missions.contains(plan.mission.as_str())
                || utc(&plan.ends_at).is_none_or(|d| d < start)
                || utc(&plan.starts_at).is_none_or(|d| d > stop)
            {
                continue;
            }
            let replacing = newest.get(&plan.mission).is_none_or(|current| {
                (plan.starts_at.as_str(), plan.ends_at.as_str())
                    > (current.starts_at.as_str(), current.ends_at.as_str())
            });
            if replacing {
                newest.insert(plan.mission.clone(), plan);
            }
        }
        let mut items = Vec::new();
        let mut diagnostics = Vec::new();
        let mut fetched_at: Option<DateTime<Utc>> = None;
        for plan in newest.into_values() {
            let (kml, from_cache) = self.fetch_text(&plan.url, 20_000_000).await?;
            if !from_cache {
                let now = Utc::now();
                if fetched_at.is_none_or(|previous| now > previous) {
                    fetched_at = Some(now);
                }
            }
            diagnostics.push(ESAPlanDiagnostic {
                mission: plan.mission.clone(),
                source_url: plan.url.clone(),
                starts_at: plan.starts_at.clone(),
                ends_at: plan.ends_at.clone(),
                from_cache,
            });
            items.extend(parse_esa_plan_kml(&kml, &plan, bbox, start, stop)?);
        }
        items.sort_by(|a, b| {
            a.expected_at
                .cmp(&b.expected_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        let status = if !items.is_empty() {
            "ok"
        } else if diagnostics.is_empty() {
            "no-current-plan"
        } else {
            "no-overlap"
        };
        Ok(ESAUpcomingResult {
            opportunities: items,
            fetched_at: fetched_at.map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true)),
            plans: diagnostics,
            status: status.into(),
        })
    }
    pub async fn upcoming(
        &self,
        query: &AcquisitionQuery,
    ) -> Result<Vec<AcquisitionOpportunity>, Error> {
        Ok(self.upcoming_with_diagnostics(query).await?.opportunities)
    }
    pub fn missions(&self) -> &[String] {
        &self.missions
    }
    pub fn clear_cache(&self) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const OLD:&str="https://sentinels.copernicus.eu/documents/d/sentinel/s2b_mp_acq__kml_20260924t120000_20261012t150000";
    const NEW:&str="https://sentinels.copernicus.eu/documents/d/sentinel/s2b_mp_acq__kml_20261008t120000_20261026t150000";
    #[test]
    fn official_index_filters_host_and_dates() {
        let html = format!(
            r#"<a href="{OLD}">old</a><a href="{NEW}">latest</a><a href="https://evil.invalid/documents/d/sentinel/s2b_mp_acq__kml_20261009t120000_20261029t150000">evil</a>"#
        );
        let plans = parse_esa_plan_index(&html).unwrap();
        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].url, NEW);
    }
    #[test]
    fn kml_extended_data_and_nominal_mode() {
        let coords = "116.0,-8.7,0 116.3,-8.7,0 116.3,-8.4,0 116.0,-8.4,0 116.0,-8.7,0";
        let mark = |name: &str, style: &str| {
            format!(
                r#"<Placemark><name>{name}</name><styleUrl>{style}</styleUrl><ExtendedData>
            <Data name="ObservationTimeStart"><value>2026-10-15T02:12:00.000</value></Data>
            <Data name="ObservationTimeStop"><value>2026-10-15T02:14:00.000</value></Data>
            <Data name="OrbitRelative"><value>47</value></Data>
            </ExtendedData><Polygon><outerBoundaryIs><LinearRing>
            <coordinates>{coords}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>"#
            )
        };
        let kml = format!(
            r#"<kml xmlns="http://www.opengis.net/kml/2.2"><Document>{}{}</Document></kml>"#,
            mark("id1", "S2B_NOBS_NOMINAL"),
            mark("bad", "S2B_VIC")
        );
        let plan = ESAPlan {
            mission: "S2B".into(),
            url: NEW.into(),
            starts_at: "2026-10-08T12:00:00Z".into(),
            ends_at: "2026-10-26T15:00:00Z".into(),
        };
        let start = utc("2026-10-12T00:00:00").unwrap();
        let stop = utc("2026-10-20T00:00:00").unwrap();
        let res = parse_esa_plan_kml(
            &kml,
            &plan,
            bounds_around(-8.5833, 116.1167, 5000.0).unwrap(),
            start,
            stop,
        )
        .unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].mission, "S2B");
        assert_eq!(res[0].status, "planned");
        assert_eq!(res[0].orbit_relative, Some(47));
    }
    #[test]
    fn real_esa_kml_observation_fixture() {
        let xml = include_str!("../tests/fixtures/esa-s2-sample.kml");
        let plan = ESAPlan {
            mission: "S2A".into(),
            url: "https://sentinels.copernicus.eu/copernicus/sentinel-2/acquisition-plans".into(),
            starts_at: "2024-11-28T00:00:00Z".into(),
            ends_at: "2024-12-14T00:00:00Z".into(),
        };
        let results = parse_esa_plan_kml(
            xml,
            &plan,
            bounds_around(40.97507, -27.63923, 1000.0).unwrap(),
            utc("2024-11-28T00:00:00").unwrap(),
            utc("2024-12-01T00:00:00").unwrap(),
        )
        .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].expected_at, "2024-11-28T12:50:30.621Z");
        assert_eq!(results[0].orbit_relative, Some(95));
        assert_eq!(results[0].mode.as_deref(), Some("NOBS"));
    }
    #[test]
    fn reject_doctype_and_bad_query() {
        let p = ESAPlan {
            mission: "S2B".into(),
            url: NEW.into(),
            starts_at: "".into(),
            ends_at: "".into(),
        };
        let start = Utc::now();
        assert!(parse_esa_plan_kml(
            "<!DOCTYPE kml><kml/>",
            &p,
            [0.0, 0.0, 1.0, 1.0],
            start,
            start
        )
        .is_err());
        assert!(AcquisitionQuery::new(0.0, 0.0, 1000.0, 0).is_err());
    }
}
