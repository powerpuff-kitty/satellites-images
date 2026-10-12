//! Open, provider-aware satellite imagery catalogue discovery.
//!
//! Initial scope: bounded Earth Search STAC queries and metadata normalization.
//! Published observations are distinct from planned or predicted acquisitions.

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{collections::HashSet, time::Duration};

const EARTH_SEARCH: &str = "https://earth-search.aws.element84.com/v1/";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Invalid search query: {0}")]
    InvalidQuery(String),
    #[error("Unsupported area: {0}")]
    UnsupportedArea(String),
    #[error("Invalid provider response: {0}")]
    InvalidResponse(String),
    #[error("Provider returned HTTP {0}")]
    Http(u16),
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("Unsafe cross-origin STAC pagination link")]
    UnsafeNextLink,
    #[error("STAC pagination loop")]
    PaginationLoop,
    #[error("Unsupported feature: {0}")]
    Unsupported(&'static str),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchQuery {
    pub latitude: f64,
    pub longitude: f64,
    pub radius_meters: f64,
    pub start: String,
    pub end: String,
    pub collections: Vec<String>,
    pub limit: usize,
    pub max_pages: usize,
}

impl SearchQuery {
    pub fn new(lat: f64, lon: f64, radius: f64, start: &str, end: &str) -> Result<Self, Error> {
        let query = Self {
            latitude: lat,
            longitude: lon,
            radius_meters: radius,
            start: start.into(),
            end: end.into(),
            collections: vec!["sentinel-2-l2a".into(), "landsat-c2-l2".into()],
            limit: 50,
            max_pages: 3,
        };
        query.validate()?;
        Ok(query)
    }

    pub fn validate(&self) -> Result<(), Error> {
        bounds_around(self.latitude, self.longitude, self.radius_meters)?;
        if self.limit == 0 || self.limit > 100 || self.max_pages == 0 || self.max_pages > 50 {
            return Err(Error::InvalidQuery("limit must be 1..100 and max_pages 1..50".into()));
        }
        let start = NaiveDate::parse_from_str(&self.start, "%Y-%m-%d")
            .map_err(|_| Error::InvalidQuery("start must be YYYY-MM-DD".into()))?;
        let end = NaiveDate::parse_from_str(&self.end, "%Y-%m-%d")
            .map_err(|_| Error::InvalidQuery("end must be YYYY-MM-DD".into()))?;
        if start > end {
            return Err(Error::InvalidQuery("start must not follow end".into()));
        }
        if self.collections.is_empty() || self.collections.iter().any(|s| s.trim().is_empty()) {
            return Err(Error::InvalidQuery("Provide at least one collection".into()));
        }
        Ok(())
    }

    fn stac_body(&self) -> Result<Value, Error> {
        self.validate()?;
        Ok(json!({
            "bbox": bounds_around(self.latitude, self.longitude, self.radius_meters)?,
            "datetime": format!("{}T00:00:00Z/{}T23:59:59Z", self.start, self.end),
            "collections": self.collections,
            "limit": self.limit,
        }))
    }
}

pub fn bounds_around(lat: f64, lon: f64, radius: f64) -> Result<[f64; 4], Error> {
    if !lat.is_finite() || !lon.is_finite() || !radius.is_finite()
        || !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon)
        || radius <= 0.0 || radius > 100_000.0
    {
        return Err(Error::InvalidQuery("Invalid coordinates or radius (0..100km)".into()));
    }
    let lat_delta = radius / 110_574.0;
    if lat - lat_delta < -90.0 || lat + lat_delta > 90.0 {
        return Err(Error::UnsupportedArea("Area crosses a pole".into()));
    }
    let cos = lat.to_radians().cos();
    if cos < 0.001 {
        return Err(Error::UnsupportedArea("Area is too close to a pole".into()));
    }
    let lon_delta = radius / (111_320.0 * cos);
    if lon - lon_delta < -180.0 || lon + lon_delta > 180.0 {
        return Err(Error::UnsupportedArea("Area crosses the antimeridian".into()));
    }
    Ok([lon - lon_delta, lat - lat_delta, lon + lon_delta, lat + lat_delta])
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SceneAsset {
    pub key: String,
    pub href: String,
    pub media_type: Option<String>,
    pub roles: Vec<String>,
    pub access: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scene {
    pub provider_id: String,
    pub id: String,
    pub collection: String,
    pub acquired_at: String,
    pub mission: Option<String>,
    pub geometry: Option<Value>,
    pub bbox: Option<Vec<f64>>,
    pub cloud_cover_percent: Option<f64>,
    pub preview_url: Option<String>,
    pub access: String,
    pub assets: Vec<SceneAsset>,
    pub source_url: Option<String>,
    pub raw: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchPage {
    pub provider_id: String,
    pub items: Vec<Scene>,
    pub page_number: usize,
    pub has_next: bool,
    pub matched: Option<u64>,
}

pub fn list_sources() -> Result<Value, Error> {
    serde_json::from_str(include_str!("sources.json"))
        .map_err(|e| Error::InvalidResponse(format!("Bundled source registry: {e}")))
}

pub fn normalize_stac_item(item: Value, provider_id: &str) -> Result<Scene, Error> {
    let id = item.get("id").and_then(Value::as_str)
        .ok_or_else(|| Error::InvalidResponse("STAC item missing id".into()))?;
    let props = item.get("properties").ok_or_else(|| Error::InvalidResponse("Missing properties".into()))?;
    let raw_datetime = props.get("datetime").and_then(Value::as_str)
        .or_else(|| props.get("start_datetime").and_then(Value::as_str))
        .ok_or_else(|| Error::InvalidResponse("No acquisition datetime".into()))?;
    let acquired = DateTime::parse_from_rfc3339(raw_datetime)
        .map_err(|_| Error::InvalidResponse("Invalid acquisition datetime".into()))?
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut assets: Vec<SceneAsset> = Vec::new();
    if let Some(map) = item.get("assets").and_then(Value::as_object) {
        for (key, data) in map {
            if let Some(href) = data.get("href").and_then(Value::as_str) {
                let roles = data.get("roles").and_then(Value::as_array).map(|r| {
                    r.iter().filter_map(Value::as_str).map(str::to_owned).collect()
                }).unwrap_or_default();
                assets.push(SceneAsset {
                    key: key.clone(), href: href.into(),
                    media_type: data.get("type").and_then(Value::as_str).map(str::to_owned),
                    roles, access: "unknown".into(),
                });
            }
        }
    }
    let preview_url = assets.iter().find(|a| a.roles.iter().any(|r| r == "thumbnail"))
        .or_else(|| assets.iter().find(|a| ["thumbnail", "preview", "rendered_preview"].contains(&a.key.as_str())))
        .map(|a| a.href.clone());
    let cloud = props.get("eo:cloud_cover").and_then(Value::as_f64)
        .filter(|n| n.is_finite() && (0.0..=100.0).contains(n));
    let source_url = item.get("links").and_then(Value::as_array)
        .and_then(|links| links.iter().find(|link| link.get("rel").and_then(Value::as_str) == Some("self")))
        .and_then(|link| link.get("href").and_then(Value::as_str)).map(str::to_owned);
    let bbox = item.get("bbox").and_then(Value::as_array).and_then(|values| {
        values.iter().map(Value::as_f64).collect::<Option<Vec<f64>>>()
    });
    Ok(Scene {
        provider_id: provider_id.into(), id: id.into(),
        collection: item.get("collection").and_then(Value::as_str).unwrap_or("").into(),
        acquired_at: acquired,
        mission: props.get("platform").and_then(Value::as_str).map(str::to_owned),
        geometry: item.get("geometry").filter(|g| g.is_object()).cloned(),
        bbox, cloud_cover_percent: cloud, preview_url,
        access: "unknown".into(), assets, source_url, raw: item,
    })
}

#[derive(Clone)]
pub struct EarthSearch {
    client: Client,
    endpoint: Url,
}
impl Default for EarthSearch {
    fn default() -> Self {
        Self::new().expect("Constant Earth Search endpoint is valid")
    }
}
impl EarthSearch {
    pub fn new() -> Result<Self, Error> {
        let client = Client::builder().timeout(Duration::from_secs(20)).build()?;
        let endpoint = Url::parse(EARTH_SEARCH)
            .map_err(|e| Error::InvalidResponse(e.to_string()))?;
        Ok(Self { client, endpoint })
    }
    pub async fn search(&self, query: &SearchQuery) -> Result<Vec<Scene>, Error> {
        Ok(self.search_pages(query).await?.into_iter().flat_map(|p| p.items).collect())
    }
    pub async fn search_pages(&self, query: &SearchQuery) -> Result<Vec<SearchPage>, Error> {
        let mut body = query.stac_body()?;
        let mut href = self.endpoint.join("search")
            .map_err(|e| Error::InvalidResponse(e.to_string()))?;
        let mut method = Method::POST;
        let mut seen = HashSet::new();
        let mut pages = Vec::new();
        for index in 0..query.max_pages {
            let key = format!("{method} {href} {body}");
            if !seen.insert(key) { return Err(Error::PaginationLoop); }
            let request = self.client.request(method.clone(), href.clone())
                .header("Accept", "application/geo+json, application/json");
            let request = if method == Method::POST { request.json(&body) } else { request };
            let response = request.send().await?;
            if !response.status().is_success() {
                return Err(Error::Http(response.status().as_u16()));
            }
            let data: Value = response.json().await?;
            let features = data.get("features").and_then(Value::as_array)
                .ok_or_else(|| Error::InvalidResponse("STAC response has no features".into()))?;
            let items = features.iter().cloned().map(|item| normalize_stac_item(item, "earth-search"))
                .collect::<Result<Vec<_>, _>>()?;
            let next_link = data.get("links").and_then(Value::as_array)
                .and_then(|links| links.iter().find(|link| link.get("rel").and_then(Value::as_str) == Some("next")));
            let matched = data.pointer("/context/matched").and_then(Value::as_u64)
                .or_else(|| data.get("numberMatched").and_then(Value::as_u64));
            pages.push(SearchPage {
                provider_id: "earth-search".into(),
                items, page_number: index + 1,
                has_next: next_link.is_some(),
                matched,
            });
            let Some(next) = next_link else { break; };
            let link_href = next.get("href").and_then(Value::as_str)
                .ok_or_else(|| Error::InvalidResponse("Missing STAC next URL".into()))?;
            let new_url = href.join(link_href)
                .map_err(|e| Error::InvalidResponse(e.to_string()))?;
            if new_url.scheme() != self.endpoint.scheme()
                || new_url.host_str() != self.endpoint.host_str()
                || new_url.port_or_known_default() != self.endpoint.port_or_known_default()
            {
                return Err(Error::UnsafeNextLink);
            }
            let next_method = next.get("method").and_then(Value::as_str).unwrap_or("GET").to_uppercase();
            method = match next_method.as_str() {
                "GET" => Method::GET,
                "POST" => Method::POST,
                _ => return Err(Error::InvalidResponse("Unsupported STAC next method".into())),
            };
            if method == Method::POST {
                let next_body = next.get("body").and_then(Value::as_object).cloned().unwrap_or_default();
                if next.get("merge").and_then(Value::as_bool) == Some(false) {
                    body = Value::Object(next_body);
                } else {
                    let mut combined: Map<String, Value> = body.as_object().cloned().unwrap_or_default();
                    combined.extend(next_body);
                    body = Value::Object(combined);
                }
            }
            href = new_url;
        }
        Ok(pages)
    }
    pub async fn upcoming(&self) -> Result<Vec<Value>, Error> {
        Err(Error::Unsupported("Future acquisition plans are not yet implemented"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_validate() {
        assert!(bounds_around(-8.5833, 116.1167, 5000.0).is_ok());
        assert!(matches!(bounds_around(0.0, 180.0, 5000.0), Err(Error::UnsupportedArea(_))));
        assert!(matches!(bounds_around(f64::NAN, 10.0, 1.0), Err(Error::InvalidQuery(_))));
    }
    #[test]
    fn date_validate() {
        assert!(SearchQuery::new(0.0, 0.0, 500.0, "2025-02-31", "2025-03-01").is_err());
        assert!(SearchQuery::new(0.0, 0.0, 500.0, "2025-03-01", "2025-02-01").is_err());
    }
    #[test]
    fn registry_marks_unsupported_providers() {
        let registry = list_sources().unwrap();
        let sources = registry["sources"].as_array().unwrap();
        assert!(sources.len() >= 12);
        assert_eq!(sources.iter().find(|s| s["id"] == "skyfi").unwrap()["implemented"]["rust"], false);
    }
    #[test]
    fn parse_stac_scene() {
        let fixture = json!({
            "id": "example", "collection": "sentinel-2-l2a",
            "properties": {"datetime": "2025-01-10T02:12:00Z", "platform": "sentinel-2a", "eo:cloud_cover": 12.0},
            "assets": {"thumbnail": {"href":"https://example.test/preview.png", "roles":["thumbnail"]}},
            "links":[{"rel":"self","href":"https://earth-search.aws.element84.com/v1/items/example"}]
        });
        let scene = normalize_stac_item(fixture, "earth-search").unwrap();
        assert_eq!(scene.acquired_at, "2025-01-10T02:12:00.000Z");
        assert_eq!(scene.access, "unknown");
        assert_eq!(scene.preview_url.as_deref(), Some("https://example.test/preview.png"));
    }
    #[tokio::test]
    async fn future_plan_is_explicitly_unavailable() {
        let err = EarthSearch::default().upcoming().await.unwrap_err();
        assert!(matches!(err, Error::Unsupported(_)));
    }
}
