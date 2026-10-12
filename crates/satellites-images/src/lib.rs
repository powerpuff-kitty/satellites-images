//! Open, provider-aware satellite imagery catalogue discovery.
//!
//! Initial scope: bounded Earth Search STAC queries and metadata normalization.
//! Published observations are distinct from planned or predicted acquisitions.

pub mod acquisitions;
pub use acquisitions::{AcquisitionOpportunity, AcquisitionQuery, ESAPlansProvider, ESAPlan,
    ESAPlanDiagnostic, ESAUpcomingResult, parse_esa_plan_index, parse_esa_plan_kml};

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{collections::{BTreeMap, BTreeSet, HashSet}, time::Duration};

const EARTH_SEARCH: &str = "https://earth-search.aws.element84.com/v1/";
const PLANETARY_COMPUTER: &str = "https://planetarycomputer.microsoft.com/api/stac/v1";
const COPERNICUS_DATA_SPACE: &str = "https://stac.dataspace.copernicus.eu/v1";
const USGS_LANDSATLOOK: &str = "https://landsatlook.usgs.gov/stac-server";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Invalid search query: {0}")]
    InvalidQuery(String),
    #[error("Invalid provider configuration: {0}")]
    InvalidProvider(String),
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
    /// Centre latitude. Present unless `aoi` supplies the geometry.
    pub latitude: Option<f64>,
    /// Centre longitude. Present unless `aoi` supplies the geometry.
    pub longitude: Option<f64>,
    /// Radius in metres (0 < r <= 100000). Present unless `aoi` supplies the geometry.
    pub radius_meters: Option<f64>,
    /// Optional GeoJSON Polygon/MultiPolygon area of interest (RFC 7946 lon/lat).
    #[serde(default)]
    pub aoi: Option<Value>,
    pub start: String,
    pub end: String,
    pub collections: Vec<String>,
    pub limit: usize,
    pub max_pages: usize,
}

impl SearchQuery {
    pub fn new(lat: f64, lon: f64, radius: f64, start: &str, end: &str) -> Result<Self, Error> {
        let query = Self {
            latitude: Some(lat),
            longitude: Some(lon),
            radius_meters: Some(radius),
            aoi: None,
            start: start.into(),
            end: end.into(),
            collections: vec!["sentinel-2-l2a".into(), "landsat-c2-l2".into()],
            limit: 50,
            max_pages: 3,
        };
        query.validate()?;
        Ok(query)
    }

    /// Build a query from a GeoJSON Polygon/MultiPolygon area of interest.
    pub fn for_aoi(aoi: Value, start: &str, end: &str) -> Result<Self, Error> {
        let query = Self {
            latitude: None,
            longitude: None,
            radius_meters: None,
            aoi: Some(aoi),
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
        if self.aoi.is_some() {
            resolve_areas(self)?;
        } else {
            match (self.latitude, self.longitude, self.radius_meters) {
                (Some(lat), Some(lon), Some(radius)) => {
                    radius_boxes(lat, lon, radius)?;
                }
                _ => {
                    return Err(Error::InvalidQuery(
                        "Provide latitude/longitude/radius_meters or a GeoJSON aoi".into(),
                    ))
                }
            }
        }
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
}

/// Convert a centre/radius search into one or two STAC-safe bounding boxes.
///
/// Antimeridian-crossing searches are split at +/-180; pole-crossing searches use
/// the full longitude range instead of returning an error.
pub fn radius_boxes(lat: f64, lon: f64, radius: f64) -> Result<Vec<[f64; 4]>, Error> {
    if !lat.is_finite() || !lon.is_finite() || !radius.is_finite()
        || !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon)
        || radius <= 0.0 || radius > 100_000.0
    {
        return Err(Error::InvalidQuery("Invalid coordinates or radius (0..100km)".into()));
    }
    let lat_delta = radius / 110_574.0;
    let mut south = lat - lat_delta;
    let mut north = lat + lat_delta;
    let touches_pole = south <= -90.0 || north >= 90.0;
    south = south.max(-90.0);
    north = north.min(90.0);
    let cos = lat.to_radians().cos();
    if touches_pole || cos < 0.001 {
        return Ok(vec![[-180.0, south, 180.0, north]]);
    }
    let lon_delta = radius / (111_320.0 * cos);
    let west = lon - lon_delta;
    let east = lon + lon_delta;
    if east > 180.0 {
        return Ok(vec![[west, south, 180.0, north], [-180.0, south, east - 360.0, north]]);
    }
    if west < -180.0 {
        return Ok(vec![[west + 360.0, south, 180.0, north], [-180.0, south, east, north]]);
    }
    Ok(vec![[west, south, east, north]])
}

fn polygon_rings(aoi: &Value) -> Result<Vec<Vec<[f64; 2]>>, Error> {
    let coordinates = aoi
        .get("coordinates")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::InvalidQuery("AOI geometry has no rings".into()))?;
    let rings: Vec<&Value> = match aoi.get("type").and_then(Value::as_str) {
        Some("Polygon") => coordinates.iter().collect(),
        Some("MultiPolygon") => {
            let mut rings = Vec::new();
            for polygon in coordinates {
                let polygon = polygon.as_array().ok_or_else(|| {
                    Error::InvalidQuery("AOI MultiPolygon coordinates must be arrays".into())
                })?;
                rings.extend(polygon.iter());
            }
            rings
        }
        _ => return Err(Error::InvalidQuery("AOI must be a GeoJSON Polygon or MultiPolygon".into())),
    };
    if rings.is_empty() {
        return Err(Error::InvalidQuery("AOI geometry has no rings".into()));
    }
    let mut parsed = Vec::with_capacity(rings.len());
    for ring in rings {
        let positions = ring
            .as_array()
            .ok_or_else(|| Error::InvalidQuery("AOI ring must be an array".into()))?;
        if positions.len() < 4 {
            return Err(Error::InvalidQuery("AOI ring must hold at least 4 positions".into()));
        }
        let mut points = Vec::with_capacity(positions.len());
        for position in positions {
            let pair = position
                .as_array()
                .filter(|p| p.len() == 2)
                .ok_or_else(|| Error::InvalidQuery("AOI position must be [lon,lat]".into()))?;
            let lon = pair[0].as_f64().unwrap_or(f64::NAN);
            let lat = pair[1].as_f64().unwrap_or(f64::NAN);
            if !lon.is_finite() || !lat.is_finite()
                || !(-180.0..=180.0).contains(&lon) || !(-90.0..=90.0).contains(&lat)
            {
                return Err(Error::InvalidQuery("AOI position is out of range".into()));
            }
            points.push([lon, lat]);
        }
        parsed.push(points);
    }
    Ok(parsed)
}

fn crosses_antimeridian(rings: &[Vec<[f64; 2]>]) -> bool {
    rings.iter().any(|ring| {
        (0..ring.len()).any(|index| {
            let a = ring[index];
            let b = ring[(index + 1) % ring.len()];
            (b[0] - a[0]).abs() > 180.0
        })
    })
}

/// Convert a GeoJSON polygon AOI into one or two STAC-safe bounding boxes.
pub fn polygon_boxes(aoi: &Value) -> Result<Vec<[f64; 4]>, Error> {
    let rings = polygon_rings(aoi)?;
    let mut south = f64::INFINITY;
    let mut north = f64::NEG_INFINITY;
    for ring in &rings {
        for point in ring {
            south = south.min(point[1]);
            north = north.max(point[1]);
        }
    }
    if !crosses_antimeridian(&rings) {
        let mut west = f64::INFINITY;
        let mut east = f64::NEG_INFINITY;
        for ring in &rings {
            for point in ring {
                west = west.min(point[0]);
                east = east.max(point[0]);
            }
        }
        return Ok(vec![[west, south, east, north]]);
    }
    let mut east_of_line = 180.0;
    let mut west_of_line = -180.0;
    for ring in &rings {
        for point in ring {
            if point[0] > 0.0 && point[0] < east_of_line {
                east_of_line = point[0];
            }
            if point[0] <= 0.0 && point[0] > west_of_line {
                west_of_line = point[0];
            }
        }
    }
    let mut boxes = Vec::new();
    if east_of_line < 180.0 {
        boxes.push([east_of_line, south, 180.0, north]);
    }
    if west_of_line > -180.0 {
        boxes.push([-180.0, south, west_of_line, north]);
    }
    if boxes.is_empty() {
        return Err(Error::InvalidQuery("AOI geometry is degenerate".into()));
    }
    boxes.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap_or(std::cmp::Ordering::Equal));
    Ok(boxes)
}

/// Resolve a query into STAC-safe bounding boxes plus an optional intersects geometry.
pub fn resolve_areas(query: &SearchQuery) -> Result<(Vec<[f64; 4]>, Option<Value>), Error> {
    if let Some(aoi) = &query.aoi {
        let boxes = polygon_boxes(aoi)?;
        let polygon = if boxes.len() == 1 { Some(aoi.clone()) } else { None };
        return Ok((boxes, polygon));
    }
    match (query.latitude, query.longitude, query.radius_meters) {
        (Some(lat), Some(lon), Some(radius)) => Ok((radius_boxes(lat, lon, radius)?, None)),
        _ => Err(Error::InvalidQuery(
            "Provide latitude/longitude/radius_meters or a GeoJSON aoi".into(),
        )),
    }
}

fn box_area(box_: &[f64; 4]) -> f64 {
    (box_[2] - box_[0]).max(0.0) * (box_[3] - box_[1]).max(0.0)
}

/// bbox-overlap percentage of a scene within the requested area boxes (0-100).
pub fn coverage_percent(scene_bbox: Option<&Vec<f64>>, boxes: &[[f64; 4]]) -> Option<f64> {
    let bbox = scene_bbox?;
    if bbox.len() != 4 || !bbox.iter().all(|v| v.is_finite()) {
        return None;
    }
    let total: f64 = boxes.iter().map(box_area).sum();
    if total <= 0.0 {
        return None;
    }
    let covered: f64 = boxes
        .iter()
        .map(|box_| {
            let width = box_[2].min(bbox[2]) - box_[0].max(bbox[0]);
            let height = box_[3].min(bbox[3]) - box_[1].max(bbox[1]);
            width.max(0.0) * height.max(0.0)
        })
        .sum();
    Some((covered / total * 100.0).clamp(0.0, 100.0))
}

/// Backwards-compatible single bounding box; returns the first STAC-safe box.
pub fn bounds_around(lat: f64, lon: f64, radius: f64) -> Result<[f64; 4], Error> {
    Ok(radius_boxes(lat, lon, radius)?[0])
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
    /// Approximate bbox-overlap percentage of the requested AOI (0-100), or None.
    pub coverage_percent: Option<f64>,
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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayAvailability {
    pub date: String,
    pub count: usize,
    pub providers: Vec<String>,
    pub missions: Vec<String>,
    pub collections: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonthAvailability { pub month: String, pub count: usize }
type DailyBucket = (usize, BTreeSet<String>, BTreeSet<String>, BTreeSet<String>);
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvailabilitySummary {
    pub days: Vec<DayAvailability>,
    pub months: Vec<MonthAvailability>,
    pub total_scenes: usize,
    /// False when any collected page still advertised a `next` link (truncated search).
    pub complete: bool,
    pub truncated_providers: Vec<String>,
    pub providers: BTreeMap<String, usize>,
    pub missions: BTreeMap<String, usize>,
    pub collections: BTreeMap<String, usize>,
}

/// Summarize collected search pages into UTC day/month availability.
///
/// De-duplicates by provider-native item id while retaining cross-provider
/// provenance, and marks the summary incomplete when any page was truncated.
/// It never asserts that absent days have no imagery.
pub fn availability_summary(pages: &[SearchPage]) -> AvailabilitySummary {
    let mut seen: HashSet<String> = HashSet::new();
    let mut days: BTreeMap<String, DailyBucket> = BTreeMap::new();
    let mut months: BTreeMap<String, usize> = BTreeMap::new();
    let mut providers: BTreeMap<String, usize> = BTreeMap::new();
    let mut missions: BTreeMap<String, usize> = BTreeMap::new();
    let mut collections: BTreeMap<String, usize> = BTreeMap::new();
    let mut truncated: BTreeSet<String> = BTreeSet::new();
    let mut total_scenes = 0usize;
    let mut complete = true;
    for page in pages {
        if page.has_next { complete = false; truncated.insert(page.provider_id.clone()); }
        for scene in &page.items {
            if !seen.insert(format!("{}:{}", page.provider_id, scene.id)) { continue; }
            total_scenes += 1;
            let date = scene.acquired_at.get(0..10).unwrap_or("").to_owned();
            let day = days.entry(date.clone()).or_insert_with(|| (0, BTreeSet::new(), BTreeSet::new(), BTreeSet::new()));
            day.0 += 1;
            day.1.insert(page.provider_id.clone());
            if let Some(mission) = &scene.mission { day.2.insert(mission.clone()); }
            if !scene.collection.is_empty() { day.3.insert(scene.collection.clone()); }
            *months.entry(scene.acquired_at.get(0..7).unwrap_or("").to_owned()).or_insert(0) += 1;
            *providers.entry(page.provider_id.clone()).or_insert(0) += 1;
            if let Some(mission) = &scene.mission { *missions.entry(mission.clone()).or_insert(0) += 1; }
            if !scene.collection.is_empty() { *collections.entry(scene.collection.clone()).or_insert(0) += 1; }
        }
    }
    AvailabilitySummary {
        days: days.into_iter().map(|(date, (count, providers, missions, collections))| DayAvailability {
            date, count,
            providers: providers.into_iter().collect(),
            missions: missions.into_iter().collect(),
            collections: collections.into_iter().collect(),
        }).collect(),
        months: months.into_iter().map(|(month, count)| MonthAvailability { month, count }).collect(),
        total_scenes,
        complete,
        truncated_providers: truncated.into_iter().collect(),
        providers, missions, collections,
    }
}

pub fn list_sources() -> Result<Value, Error> {
    serde_json::from_str(include_str!("sources.json"))
        .map_err(|e| Error::InvalidResponse(format!("Bundled source registry: {e}")))
}

pub fn normalize_stac_item(item: Value, provider_id: &str, boxes: &[[f64; 4]]) -> Result<Scene, Error> {
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
    let coverage = coverage_percent(bbox.as_ref(), boxes);
    Ok(Scene {
        provider_id: provider_id.into(), id: id.into(),
        collection: item.get("collection").and_then(Value::as_str).unwrap_or("").into(),
        acquired_at: acquired,
        mission: props.get("platform").and_then(Value::as_str).map(str::to_owned),
        geometry: item.get("geometry").filter(|g| g.is_object()).cloned(),
        bbox, cloud_cover_percent: cloud,
        coverage_percent: coverage,
        preview_url,
        access: "unknown".into(), assets, source_url, raw: item,
    })
}

#[derive(Clone)]
pub struct StacProvider {
    id: String,
    client: Client,
    endpoint: Url,
}
/// Backwards-compatible alias for the default Earth Search provider.
pub type EarthSearch = StacProvider;
impl Default for StacProvider {
    fn default() -> Self {
        Self::earth_search().expect("Constant Earth Search endpoint is valid")
    }
}
impl StacProvider {
    pub fn new(id: &str, base_url: &str) -> Result<Self, Error> {
        let client = Client::builder().timeout(Duration::from_secs(20)).build()?;
        let endpoint = Url::parse(base_url)
            .map_err(|e| Error::InvalidResponse(e.to_string()))?;
        let host = endpoint.host_str();
        if endpoint.scheme() != "https" && host != Some("localhost") && host != Some("127.0.0.1") {
            return Err(Error::InvalidProvider("Provider must use HTTPS except localhost".into()));
        }
        Ok(Self { id: id.into(), client, endpoint })
    }
    /// Element 84 Earth Search (Sentinel-2 L2A, Landsat C2 L2).
    pub fn earth_search() -> Result<Self, Error> {
        Self::new("earth-search", EARTH_SEARCH)
    }
    /// Microsoft Planetary Computer STAC.
    pub fn planetary_computer() -> Result<Self, Error> {
        Self::new("planetary-computer", PLANETARY_COMPUTER)
    }
    /// Copernicus Data Space Ecosystem STAC.
    pub fn copernicus_data_space() -> Result<Self, Error> {
        Self::new("copernicus", COPERNICUS_DATA_SPACE)
    }
    /// USGS LandsatLook STAC server (server-side use; browser CORS is restricted).
    pub fn usgs_landsat_look() -> Result<Self, Error> {
        Self::new("usgs-landsatlook", USGS_LANDSATLOOK)
    }
    /// NASA CMR-STAC for a given CMR provider id (e.g. `ASF`, `USGS_LTA`).
    pub fn cmr_stac(provider: &str) -> Result<Self, Error> {
        if provider.is_empty()
            || !provider.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(Error::InvalidProvider("CMR provider id must be alphanumeric".into()));
        }
        Self::new("nasa-cmr", &format!("https://cmr.earthdata.nasa.gov/stac/{provider}"))
    }
    pub fn id(&self) -> &str { &self.id }
    pub async fn search(&self, query: &SearchQuery) -> Result<Vec<Scene>, Error> {
        Ok(self.search_pages(query).await?.into_iter().flat_map(|p| p.items).collect())
    }
    pub async fn search_pages(&self, query: &SearchQuery) -> Result<Vec<SearchPage>, Error> {
        let (boxes, polygon) = resolve_areas(query)?;
        let mut pages = Vec::new();
        let mut seen_items: HashSet<String> = HashSet::new();
        let mut page_number = 0usize;
        for box_ in &boxes {
            let mut body = json!({
                "bbox": box_,
                "datetime": format!("{}T00:00:00Z/{}T23:59:59Z", query.start, query.end),
                "collections": query.collections,
                "limit": query.limit,
            });
            if let Some(poly) = &polygon {
                body["intersects"] = poly.clone();
            }
            let mut href = self.endpoint.join("search")
                .map_err(|e| Error::InvalidResponse(e.to_string()))?;
            let mut method = Method::POST;
            let mut seen_requests: HashSet<String> = HashSet::new();
            let mut box_pages = 0usize;
            while box_pages < query.max_pages {
                let key = format!("{method} {href} {body}");
                if !seen_requests.insert(key) { return Err(Error::PaginationLoop); }
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
                let mut items: Vec<Scene> = Vec::new();
                for item in features.iter().cloned() {
                    let scene = normalize_stac_item(item, &self.id, &boxes)?;
                    if seen_items.insert(scene.id.clone()) {
                        items.push(scene);
                    }
                }
                let next_link = data.get("links").and_then(Value::as_array)
                    .and_then(|links| links.iter().find(|link| link.get("rel").and_then(Value::as_str) == Some("next")));
                let matched = data.pointer("/context/matched").and_then(Value::as_u64)
                    .or_else(|| data.get("numberMatched").and_then(Value::as_u64));
                box_pages += 1;
                page_number += 1;
                pages.push(SearchPage {
                    provider_id: self.id.clone(),
                    items, page_number,
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
                    // STAC pagination: `merge` defaults to false, so the next body replaces the query.
                    if next.get("merge").and_then(Value::as_bool) == Some(true) {
                        let mut combined: Map<String, Value> = body.as_object().cloned().unwrap_or_default();
                        combined.extend(next_body);
                        body = Value::Object(combined);
                    } else {
                        body = Value::Object(next_body);
                    }
                }
                href = new_url;
            }
        }
        Ok(pages)
    }
    pub async fn upcoming(&self) -> Result<Vec<Value>, Error> {
        Err(Error::Unsupported("Future acquisition plans are not yet implemented"))
    }
}

const ASF_ENDPOINT: &str = "https://api.daac.asf.alaska.edu/services/search/param";

/// Map one ASF Search API GeoJSON feature to a normalized scene.
pub fn normalize_asf_feature(item: &Value, provider_id: &str) -> Result<Scene, Error> {
    let props = item.get("properties").cloned().unwrap_or(Value::Null);
    let id = props.get("granuleName").and_then(Value::as_str)
        .or_else(|| props.get("sceneName").and_then(Value::as_str))
        .or_else(|| item.get("id").and_then(Value::as_str))
        .ok_or_else(|| Error::InvalidResponse("ASF feature lacks a granule name".into()))?;
    let raw_date = props.get("startTime").and_then(Value::as_str)
        .or_else(|| props.get("stopTime").and_then(Value::as_str))
        .ok_or_else(|| Error::InvalidResponse("ASF feature lacks a start time".into()))?;
    let acquired = DateTime::parse_from_rfc3339(raw_date)
        .map_err(|_| Error::InvalidResponse("Invalid ASF start time".into()))?
        .with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut assets: Vec<SceneAsset> = Vec::new();
    let download = props.get("downloadUrl").and_then(Value::as_str);
    if let Some(href) = download {
        assets.push(SceneAsset { key: "data".into(), href: href.into(), media_type: None,
            roles: vec!["data".into()], access: "unknown".into() });
    }
    let mut preview = None;
    if let Some(browse) = props.get("browse").and_then(Value::as_array) {
        for (index, value) in browse.iter().enumerate() {
            if let Some(href) = value.as_str() {
                if preview.is_none() { preview = Some(href.to_owned()); }
                assets.push(SceneAsset { key: format!("browse_{index}"), href: href.into(), media_type: None,
                    roles: vec!["thumbnail".into()], access: "unknown".into() });
            }
        }
    }
    Ok(Scene {
        provider_id: provider_id.into(), id: id.into(),
        collection: props.get("processingLevel").and_then(Value::as_str).unwrap_or("asf").into(),
        acquired_at: acquired,
        mission: props.get("platform").and_then(Value::as_str).map(str::to_owned),
        geometry: item.get("geometry").filter(|g| g.is_object()).cloned(),
        bbox: None, cloud_cover_percent: None, coverage_percent: None,
        preview_url: preview,
        access: "unknown".into(), assets,
        source_url: download.map(str::to_owned),
        raw: item.clone(),
    })
}

fn asf_features(data: &Value) -> Vec<Value> {
    if let Some(features) = data.get("features").and_then(Value::as_array) {
        return features.clone();
    }
    if let Some(array) = data.as_array() {
        return array.iter().flat_map(asf_features).collect();
    }
    if let Some(object) = data.as_object() {
        return object.values().flat_map(asf_features).collect();
    }
    Vec::new()
}

/// Alaska Satellite Facility (ASF) Search API adapter (keyword query, GeoJSON output).
///
/// SAR metadata search is anonymous; downloading products needs Earthdata authentication.
#[derive(Clone)]
pub struct AsfProvider {
    id: String,
    client: Client,
    platforms: Vec<String>,
}
impl AsfProvider {
    pub fn new(platforms: &[&str]) -> Result<Self, Error> {
        if platforms.is_empty()
            || platforms.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        {
            return Err(Error::InvalidProvider("ASF platform must be alphanumeric".into()));
        }
        Ok(Self {
            id: "asf-vertex".into(),
            client: Client::builder().timeout(Duration::from_secs(20)).build()?,
            platforms: platforms.iter().map(|s| (*s).to_owned()).collect(),
        })
    }
    pub fn sentinel1() -> Result<Self, Error> { Self::new(&["SENTINEL-1"]) }
    pub fn id(&self) -> &str { &self.id }
    pub async fn search_pages(&self, query: &SearchQuery) -> Result<Vec<SearchPage>, Error> {
        let (boxes, _) = resolve_areas(query)?;
        let mut seen: HashSet<String> = HashSet::new();
        let mut pages = Vec::new();
        for (index, box_) in boxes.iter().enumerate() {
            let bbox = box_.iter().map(|value| format!("{value:.6}")).collect::<Vec<_>>().join(",");
            let response = self.client.get(ASF_ENDPOINT)
                .query(&[
                    ("platform", self.platforms.join(",")),
                    ("start", query.start.clone()),
                    ("end", query.end.clone()),
                    ("bbox", bbox),
                    ("maxResults", query.limit.to_string()),
                    ("output", "geojson".to_string()),
                ])
                .header("Accept", "application/geo+json, application/json")
                .send().await?;
            if !response.status().is_success() {
                return Err(Error::Http(response.status().as_u16()));
            }
            let data: Value = response.json().await?;
            let mut items = Vec::new();
            for feature in asf_features(&data) {
                let scene = normalize_asf_feature(&feature, &self.id)?;
                if seen.insert(scene.id.clone()) { items.push(scene); }
            }
            pages.push(SearchPage { provider_id: self.id.clone(), items, page_number: index + 1, has_next: false, matched: None });        }
        Ok(pages)
    }
    pub async fn search(&self, query: &SearchQuery) -> Result<Vec<Scene>, Error> {
        Ok(self.search_pages(query).await?.into_iter().flat_map(|page| page.items).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_validate() {
        assert!(bounds_around(-8.5833, 116.1167, 5000.0).is_ok());
        // Antimeridian and pole areas are split/clamped instead of rejected.
        assert_eq!(radius_boxes(0.0, 180.0, 5000.0).unwrap().len(), 2);
        assert_eq!(radius_boxes(89.999, 10.0, 50_000.0).unwrap()[0][0], -180.0);
        assert!(matches!(bounds_around(f64::NAN, 10.0, 1.0), Err(Error::InvalidQuery(_))));
    }
    #[test]
    fn polygon_aoi_and_coverage() {
        let aoi = json!({"type":"Polygon","coordinates":[[[116.0,-8.7],[116.3,-8.7],[116.3,-8.4],[116.0,-8.4],[116.0,-8.7]]]});
        let boxes = polygon_boxes(&aoi).unwrap();
        assert_eq!(boxes, vec![[116.0, -8.7, 116.3, -8.4]]);
        let query = SearchQuery::for_aoi(aoi.clone(), "2025-01-01", "2025-01-02").unwrap();
        let (resolved, polygon) = resolve_areas(&query).unwrap();
        assert!(polygon.is_some());
        assert_eq!(coverage_percent(Some(&vec![116.0, -8.7, 116.3, -8.4]), &resolved), Some(100.0));
        let crossing = json!({"type":"Polygon","coordinates":[[[179.9,-1],[-179.9,-1],[-179.9,1],[179.9,1],[179.9,-1]]]});
        assert_eq!(polygon_boxes(&crossing).unwrap().len(), 2);
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
    fn stac_reuse_adapters() {
        assert_eq!(StacProvider::earth_search().unwrap().id(), "earth-search");
        assert_eq!(StacProvider::copernicus_data_space().unwrap().id(), "copernicus");
        assert_eq!(StacProvider::usgs_landsat_look().unwrap().id(), "usgs-landsatlook");
        assert_eq!(StacProvider::planetary_computer().unwrap().id(), "planetary-computer");
        assert_eq!(StacProvider::cmr_stac("ASF").unwrap().id(), "nasa-cmr");
        assert!(matches!(StacProvider::cmr_stac("bad id"), Err(Error::InvalidProvider(_))));
    }
    #[test]
    fn rejects_insecure_provider_url() {
        assert!(matches!(StacProvider::new("x", "http://example.com"), Err(Error::InvalidProvider(_))));
        assert!(StacProvider::new("y", "http://localhost:8080").is_ok());
        assert!(StacProvider::new("z", "https://example.com").is_ok());
    }
    #[test]
    fn asf_feature_normalizes() {
        let feature = json!({"type":"Feature","geometry":{"type":"Point","coordinates":[116.1,-8.6]},
            "properties":{"granuleName":"S1A_example","startTime":"2025-01-10T02:00:00Z",
                "platform":"Sentinel-1","processingLevel":"GRD_HD",
                "browse":["https://example.test/b.png"],"downloadUrl":"https://x/y.zip"}});
        let scene = normalize_asf_feature(&feature, "asf-vertex").unwrap();
        assert_eq!(scene.provider_id, "asf-vertex");
        assert_eq!(scene.mission.as_deref(), Some("Sentinel-1"));
        assert_eq!(scene.acquired_at, "2025-01-10T02:00:00.000Z");
        assert_eq!(scene.preview_url.as_deref(), Some("https://example.test/b.png"));
        assert_eq!(scene.access, "unknown");
        assert_eq!(AsfProvider::sentinel1().unwrap().id(), "asf-vertex");
    }
    #[test]
    fn rejects_malformed_multipolygon() {
        let bad = json!({"type":"MultiPolygon","coordinates":[[[[0.0,0.0],[1.0,0.0],[1.0,1.0],[0.0,0.0]]],5]});
        assert!(matches!(polygon_boxes(&bad), Err(Error::InvalidQuery(_))));
    }
    #[test]
    fn availability_summary_dedup_and_truncation() {
        let first = normalize_stac_item(json!({"id":"a","collection":"sentinel-2-l2a",
            "properties":{"datetime":"2025-01-10T02:00:00Z","platform":"sentinel-2a"},"bbox":[1.0,2.0,3.0,4.0]}),
            "earth-search", &[]).unwrap();
        let later = normalize_stac_item(json!({"id":"c","collection":"sentinel-2-l2a",
            "properties":{"datetime":"2025-02-02T02:00:00Z"}}), "earth-search", &[]).unwrap();
        let p1 = SearchPage{provider_id:"earth-search".into(),items:vec![first.clone(),first.clone()],page_number:1,has_next:true,matched:None};
        let p2 = SearchPage{provider_id:"earth-search".into(),items:vec![first,later],page_number:2,has_next:false,matched:None};
        let summary = availability_summary(&[p1,p2]);
        assert_eq!(summary.total_scenes,2);
        assert!(!summary.complete);
        assert_eq!(summary.truncated_providers,vec!["earth-search"]);
        assert_eq!(summary.days.len(),2);
        assert_eq!(summary.days[0].date,"2025-01-10");
        assert_eq!(summary.days[0].count,1);
        assert_eq!(summary.months.len(),2);
    }
    #[test]
    fn parse_stac_scene() {
        let fixture = json!({
            "id": "example", "collection": "sentinel-2-l2a",
            "properties": {"datetime": "2025-01-10T02:12:00Z", "platform": "sentinel-2a", "eo:cloud_cover": 12.0},
            "assets": {"thumbnail": {"href":"https://example.test/preview.png", "roles":["thumbnail"]}},
            "links":[{"rel":"self","href":"https://earth-search.aws.element84.com/v1/items/example"}]
        });
        let scene = normalize_stac_item(fixture, "earth-search", &[]).unwrap();
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
