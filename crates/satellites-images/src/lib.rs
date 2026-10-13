//! Open, provider-aware satellite imagery catalogue discovery.
//!
//! Initial scope: bounded Earth Search STAC queries and metadata normalization.
//! Published observations are distinct from planned or predicted acquisitions.

pub mod availability;
pub use availability::{
    AvailabilityAccumulator, AvailabilitySummary, AvailabilityDay, AvailabilityMonth,
    ProviderAvailability, summarize_availability,
};
pub mod acquisitions;
pub use acquisitions::{AcquisitionOpportunity, AcquisitionQuery, ESAPlansProvider, ESAPlan,
    ESAPlanDiagnostic, ESAUpcomingResult, parse_esa_plan_index, parse_esa_plan_kml};

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{collections::HashSet, sync::OnceLock, time::Duration};

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
#[serde(rename_all = "camelCase")]
pub struct SceneAsset {
    pub key: String,
    pub href: String,
    #[serde(rename = "type")]
    pub media_type: Option<String>,
    pub roles: Vec<String>,
    pub access: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scene {
    pub provider_id: String,
    pub id: String,
    pub collection: String,
    pub acquired_at: String,
    pub mission: Option<String>,
    pub geometry: Option<Value>,
    pub bbox: Option<Vec<f64>>,
    pub cloud_cover_percent: Option<f64>,
    /// Ground sample distance in metres when the provider exposes `gsd`.
    pub gsd_meters: Option<f64>,
    /// Approximate bbox-overlap percentage of the requested AOI (0-100), or None.
    pub coverage_percent: Option<f64>,
    pub preview_url: Option<String>,
    pub access: String,
    pub assets: Vec<SceneAsset>,
    pub source_url: Option<String>,
    pub raw: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub provider_id: String,
    pub items: Vec<Scene>,
    pub page_number: usize,
    pub has_next: bool,
    pub matched: Option<u64>,
    /// Count of provider items skipped because they failed normalization.
    #[serde(default)]
    pub skipped: usize,
}

pub fn list_sources() -> Result<Value, Error> {
    serde_json::from_str(include_str!("sources.json"))
        .map_err(|e| Error::InvalidResponse(format!("Bundled source registry: {e}")))
}

fn registry_value() -> Option<&'static Value> {
    static REGISTRY: OnceLock<Option<Value>> = OnceLock::new();
    REGISTRY.get_or_init(|| list_sources().ok()).as_ref()
}

/// Map the registry's coarse `imageryAccess` vocabulary onto the scene-level enum.
const IMAGERY_ACCESS_CLASS: &[(&str, &str)] = &[
    ("open", "open"),
    ("account", "authentication-required"),
    ("paid", "payment-required"),
    ("paid-or-entitlement", "payment-required"),
];
/// Collection-level refinements for sources whose registry entry is deliberately coarse.
/// Each entry mirrors verified provider behaviour rather than an aspiration.
const COLLECTION_ACCESS_OVERRIDES: &[(&str, &str)] = &[
    // Sentinel-2 L2A assets live in the public `sentinel-cogs` bucket.
    ("earth-search:sentinel-2-l2a", "open"),
    // Landsat C2 L2 assets are `s3://usgs-landsat/...`: reading them needs an AWS account
    // that accepts requester-pays transfer charges.
    ("earth-search:landsat-c2-l2", "authentication-required"),
    // Planetary Computer returns anonymous, CORS-enabled SAS URLs for its open collections.
    ("planetary-computer:sentinel-2-l2a", "open"),
    ("planetary-computer:landsat-c2-l2", "open"),
    ("planetary-computer:sentinel-1-rtc", "open"),
    ("planetary-computer:naip", "open"),
];
/// Sub-provider refinements: the provider id already carries the DAAC (e.g. `nasa-cmr:ASF`).
const PROVIDER_ACCESS_OVERRIDES: &[(&str, &str)] = &[("nasa-cmr:ASF", "authentication-required")];

/// The access class a provider declares for its image bytes, derived from the shared
/// registry (`sources/registry.json`) plus the refinements above.
///
/// This describes the published catalogue, not a per-asset entitlement: an individual href
/// can still be expired, signed or gone, so `SceneAsset.access` stays `unknown` until that
/// specific asset can be verified.
pub fn declared_imagery_access(provider_id: &str, collection: Option<&str>) -> String {
    let key = format!("{provider_id}:{}", collection.unwrap_or(""));
    if let Some((_, class)) = COLLECTION_ACCESS_OVERRIDES.iter().find(|(k, _)| *k == key)
        .or_else(|| PROVIDER_ACCESS_OVERRIDES.iter().find(|(k, _)| *k == provider_id))
    {
        return (*class).to_string();
    }
    let source_id = provider_id.split(':').next().unwrap_or(provider_id);
    let access = registry_value()
        .and_then(|value| value.get("sources"))
        .and_then(Value::as_array)
        .and_then(|sources| sources.iter().find(|s| s.get("id").and_then(Value::as_str) == Some(source_id)))
        .and_then(|source| source.get("imageryAccess"))
        .and_then(Value::as_str)
        .unwrap_or("");
    IMAGERY_ACCESS_CLASS.iter().find(|(value, _)| *value == access)
        .map(|(_, class)| (*class).to_string())
        .unwrap_or_else(|| "unknown".to_string())
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
    let asset_preview = assets.iter().find(|a| a.roles.iter().any(|r| r == "thumbnail"))
        .or_else(|| assets.iter().find(|a| ["thumbnail", "preview", "rendered_preview"].contains(&a.key.as_str())))
        .map(|a| a.href.clone());
    // Prefer an http(s) preview: an asset thumbnail, else the item's `thumbnail` link
    // (Earth Search serves this for Landsat, whose asset hrefs are s3:// URIs).
    let is_http = |value: &str| value.starts_with("http://") || value.starts_with("https://");
    let thumbnail_link = item.get("links").and_then(Value::as_array)
        .and_then(|links| links.iter().filter_map(Value::as_object)
            .find(|link| link.get("rel").and_then(Value::as_str) == Some("thumbnail"))
            .and_then(|link| link.get("href")).and_then(Value::as_str))
        .map(str::to_owned);
    let preview_url = [asset_preview.clone(), thumbnail_link].into_iter().flatten()
        .find(|href| is_http(href)).or(asset_preview);
    let cloud = props.get("eo:cloud_cover").and_then(Value::as_f64)
        .filter(|n| n.is_finite() && (0.0..=100.0).contains(n));
    let gsd_meters = props.get("gsd").and_then(Value::as_f64).filter(|n| n.is_finite() && *n > 0.0);
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
        gsd_meters,
        coverage_percent: coverage,
        preview_url,
        access: declared_imagery_access(provider_id, item.get("collection").and_then(Value::as_str)),
        assets, source_url, raw: item,
    })
}

/// Backoff delay for a retry attempt, honouring a Retry-After value when present (capped at 60 s).
pub fn retry_delay_ms(attempt: u32, retry_after_secs: Option<u64>, base_ms: u64) -> u64 {
    let requested = match retry_after_secs {
        Some(secs) => secs.saturating_mul(1000),
        None => base_ms.saturating_mul(1u64 << attempt.min(10)),
    };
    requested.min(60_000)
}

/// Upper bound on a provider JSON response body, to bound memory under a hostile response.
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

/// Read a JSON body with a byte ceiling; malformed JSON is `InvalidResponse`, I/O is `Network`.
async fn read_json_bounded(response: reqwest::Response, max_bytes: usize) -> Result<Value, Error> {
    let mut response = response;
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > max_bytes {
            return Err(Error::InvalidResponse("Provider response exceeds size limit".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|error| Error::InvalidResponse(format!("Invalid JSON response: {error}")))
}

#[derive(Clone)]
pub struct StacProvider {
    id: String,
    client: Client,
    endpoint: Url,
    retries: u32,
    retry_base_delay_ms: u64,
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
        let client = Client::builder().timeout(Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).build()?;
        let endpoint = Url::parse(base_url)
            .map_err(|e| Error::InvalidResponse(e.to_string()))?;
        let host = endpoint.host_str();
        if endpoint.scheme() != "https" && host != Some("localhost") && host != Some("127.0.0.1") {
            return Err(Error::InvalidProvider("Provider must use HTTPS except localhost".into()));
        }
        Ok(Self { id: id.into(), client, endpoint, retries: 0, retry_base_delay_ms: 500 })
    }
    /// Retry transient HTTP 429/503 responses up to `retries` times, honouring Retry-After.
    pub fn with_retries(mut self, retries: u32, retry_base_delay_ms: u64) -> Self {
        self.retries = retries.min(10);
        self.retry_base_delay_ms = retry_base_delay_ms.min(10000);
        self
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
        Self::new(&format!("nasa-cmr:{provider}"), &format!("https://cmr.earthdata.nasa.gov/stac/{provider}"))
    }
    pub fn id(&self) -> &str { &self.id }
    pub async fn availability(&self, query: &SearchQuery) -> Result<AvailabilitySummary, Error> {
        let mut accumulator = AvailabilityAccumulator::new();
        let (pages, error) = self.search_pages_partial(query).await;
        for page in &pages {
            if let Err(page_error) = accumulator.add_page(page) {
                accumulator.mark_error(&self.id);
                return Err(page_error);
            }
        }
        if let Some(_search_error) = error {
            accumulator.mark_error(&self.id);
        }
        Ok(accumulator.summary())
    }
    async fn send_with_retries(&self, method: &Method, href: &Url, body: &Value) -> Result<reqwest::Response, Error> {
        let mut attempt = 0u32;
        loop {
            let request = self.client.request(method.clone(), href.clone())
                .header("Accept", "application/geo+json, application/json");
            let request = if *method == Method::POST { request.json(body) } else { request };
            let response = request.send().await?;
            let status = response.status();
            let transient = status == reqwest::StatusCode::TOO_MANY_REQUESTS
                || status == reqwest::StatusCode::SERVICE_UNAVAILABLE;
            if transient && attempt < self.retries {
                let retry_after = response.headers().get(reqwest::header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|text| text.trim().parse::<u64>().ok());
                let delay = retry_delay_ms(attempt, retry_after, self.retry_base_delay_ms);
                tokio::time::sleep(Duration::from_millis(delay)).await;
                attempt += 1;
                continue;
            }
            return Ok(response);
        }
    }
    pub async fn search(&self, query: &SearchQuery) -> Result<Vec<Scene>, Error> {
        Ok(self.search_pages(query).await?.into_iter().flat_map(|p| p.items).collect())
    }
    pub async fn search_pages(&self, query: &SearchQuery) -> Result<Vec<SearchPage>, Error> {
        let mut pages = Vec::new();
        self.collect_pages(query, &mut pages).await?;
        Ok(pages)
    }
    /// Like `search_pages`, but returns any pages collected before a failure alongside the error.
    pub async fn search_pages_partial(&self, query: &SearchQuery) -> (Vec<SearchPage>, Option<Error>) {
        let mut pages = Vec::new();
        let error = self.collect_pages(query, &mut pages).await.err();
        (pages, error)
    }
    async fn collect_pages(&self, query: &SearchQuery, pages: &mut Vec<SearchPage>) -> Result<(), Error> {
        let (boxes, polygon) = resolve_areas(query)?;
        let mut seen_items: HashSet<String> = HashSet::new();
        let mut page_number = 0usize;
        let mut truncated_earlier = false;
        // A polygon already constrains the query, so one request suffices.
        let used_boxes: Vec<[f64; 4]> = if polygon.is_some() {
            boxes.iter().take(1).copied().collect()
        } else {
            boxes.clone()
        };
        for (box_index, box_) in used_boxes.iter().enumerate() {
            let last_box = box_index + 1 == used_boxes.len();
            let mut body = json!({
                "datetime": format!("{}T00:00:00Z/{}T23:59:59Z", query.start, query.end),
                "collections": query.collections,
                "limit": query.limit,
            });
            // STAC allows exactly one spatial filter: bbox OR intersects.
            if let Some(poly) = &polygon {
                body["intersects"] = poly.clone();
            } else {
                body["bbox"] = json!(box_);
            }
            let mut href = self.endpoint.join("search")
                .map_err(|e| Error::InvalidResponse(e.to_string()))?;
            let mut method = Method::POST;
            let mut seen_requests: HashSet<String> = HashSet::new();
            let mut box_pages = 0usize;
            let mut last_had_next = false;
            while box_pages < query.max_pages {
                let key = format!("{method} {href} {body}");
                if !seen_requests.insert(key) { return Err(Error::PaginationLoop); }
                let response = self.send_with_retries(&method, &href, &body).await?;
                if !response.status().is_success() {
                    return Err(Error::Http(response.status().as_u16()));
                }
                let data = read_json_bounded(response, MAX_RESPONSE_BYTES).await?;
                let features = data.get("features").and_then(Value::as_array)
                    .ok_or_else(|| Error::InvalidResponse("STAC response has no features".into()))?;
                if features.len() > 10000 { return Err(Error::InvalidResponse("Provider page exceeds the 10000-feature limit".into())); }
                let mut items: Vec<Scene> = Vec::new();
                let mut skipped = 0usize;
                for item in features.iter().cloned() {
                    match normalize_stac_item(item, &self.id, &boxes) {
                        Ok(scene) => { if seen_items.insert(scene.id.clone()) { items.push(scene); } }
                        Err(_) => skipped += 1,
                    }
                }
                let next_link = data.get("links").and_then(Value::as_array)
                    .and_then(|links| links.iter().find(|link| link.get("rel").and_then(Value::as_str) == Some("next")));
                let matched = data.pointer("/context/matched").and_then(Value::as_u64)
                    .or_else(|| data.get("numberMatched").and_then(Value::as_u64));
                box_pages += 1;
                page_number += 1;
                last_had_next = next_link.is_some();
                pages.push(SearchPage {
                    provider_id: self.id.clone(),
                    items, page_number,
                    has_next: next_link.is_some() || (last_box && truncated_earlier),
                    matched,
                    skipped,
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
            if box_pages >= query.max_pages && last_had_next { truncated_earlier = true; }
        }
        Ok(())
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
        bbox: None, cloud_cover_percent: None, gsd_meters: None, coverage_percent: None,
        preview_url: preview,
        access: declared_imagery_access(provider_id, None), assets,
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
            client: Client::builder().timeout(Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).build()?,
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
            let data = read_json_bounded(response, MAX_RESPONSE_BYTES).await?;
            let features = asf_features(&data);
            if features.len() > 10000 { return Err(Error::InvalidResponse("Provider page exceeds the 10000-feature limit".into())); }
            let mut items = Vec::new();
            for feature in &features {
                let scene = normalize_asf_feature(&feature, &self.id)?;
                if seen.insert(scene.id.clone()) { items.push(scene); }
            }
            let items_len = items.len() as u64;
            pages.push(SearchPage { provider_id: self.id.clone(), items, page_number: index + 1, has_next: false, matched: Some(items_len), skipped: 0 });
        }
        Ok(pages)
    }
    pub async fn search(&self, query: &SearchQuery) -> Result<Vec<Scene>, Error> {
        Ok(self.search_pages(query).await?.into_iter().flat_map(|page| page.items).collect())
    }
}

const JAXA_CSW_ENDPOINT: &str = "https://gportal.jaxa.jp/csw/csw";

/// Map one JAXA G-Portal CSW granule (GeoJSON output) to a normalized scene.
pub fn normalize_jaxa_feature(item: &Value, provider_id: &str) -> Result<Scene, Error> {
    let props = item.get("properties").cloned().unwrap_or(Value::Null);
    let gpp = props.get("gpp").cloned().unwrap_or(Value::Null);
    let id = props.get("identifier").and_then(Value::as_str)
        .ok_or_else(|| Error::InvalidResponse("JAXA feature lacks an identifier".into()))?;
    // beginPosition is the real observation start, distinct from processingDate.
    let raw_date = props.get("beginPosition").and_then(Value::as_str)
        .or_else(|| props.get("endPosition").and_then(Value::as_str))
        .ok_or_else(|| Error::InvalidResponse("JAXA feature lacks a begin position".into()))?;
    let acquired = DateTime::parse_from_rfc3339(raw_date)
        .map_err(|_| Error::InvalidResponse("Invalid JAXA begin position".into()))?
        .with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true);
    let product = props.get("product").cloned().unwrap_or(Value::Null);
    let download = product.get("fileName").and_then(Value::as_str);
    let mut assets: Vec<SceneAsset> = Vec::new();
    if let Some(href) = download {
        assets.push(SceneAsset { key: "data".into(), href: href.into(),
            media_type: product.get("DataFormatType").and_then(Value::as_str).map(str::to_owned),
            roles: vec!["data".into()], access: "unknown".into() });
    }
    let mut preview = None;
    if let Some(browse) = props.get("browse").and_then(Value::as_array) {
        for (index, entry) in browse.iter().enumerate() {
            if let Some(href) = entry.get("fileName").and_then(Value::as_str) {
                if preview.is_none() { preview = Some(href.to_owned()); }
                assets.push(SceneAsset { key: format!("browse_{index}"), href: href.into(), media_type: None,
                    roles: vec!["thumbnail".into()], access: "unknown".into() });
            }
        }
    }
    let cloud = gpp.get("cloudCoverPercentage").and_then(Value::as_str)
        .and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && (0.0..=100.0).contains(n));
    Ok(Scene {
        provider_id: provider_id.into(), id: id.into(),
        collection: props.get("platformShortName").and_then(Value::as_str).unwrap_or("jaxa").into(),
        acquired_at: acquired,
        mission: props.get("platformShortName").and_then(Value::as_str).map(str::to_owned),
        geometry: item.get("geometry").filter(|g| g.is_object()).cloned(),
        bbox: None, cloud_cover_percent: cloud, gsd_meters: None, coverage_percent: None,
        preview_url: preview,
        access: declared_imagery_access(provider_id, None), assets,
        source_url: download.map(str::to_owned),
        raw: item.clone(),
    })
}

/// JAXA G-Portal granule adapter (CSW 3.0.0 GET returning GeoJSON).
///
/// Metadata search is anonymous; only GET is supported (POST is WAF-blocked).
#[derive(Clone)]
pub struct JaxaProvider {
    id: String,
    client: Client,
    dataset_id: String,
    resolution: Option<String>,
    count: u32,
}
impl JaxaProvider {
    pub fn new(dataset_id: &str) -> Result<Self, Error> {
        if dataset_id.is_empty() || !dataset_id.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Error::InvalidProvider("A numeric JAXA datasetId is required".into()));
        }
        Ok(Self { id: "jaxa-gportal".into(),
            client: Client::builder().timeout(Duration::from_secs(25)).redirect(reqwest::redirect::Policy::none()).build()?,
            dataset_id: dataset_id.into(), resolution: None, count: 100 })
    }
    pub fn with_resolution(mut self, resolution: &str) -> Self { self.resolution = Some(resolution.into()); self }
    pub fn id(&self) -> &str { &self.id }
    pub async fn search_pages(&self, query: &SearchQuery) -> Result<Vec<SearchPage>, Error> {
        let (boxes, _) = resolve_areas(query)?;
        let mut seen: HashSet<String> = HashSet::new();
        let mut pages = Vec::new();
        for (index, box_) in boxes.iter().enumerate() {
            let bbox = box_.iter().map(|value| format!("{value:.6}")).collect::<Vec<_>>().join(",");
            let mut params: Vec<(&str, String)> = vec![
                ("service", "CSW".to_string()), ("version", "3.0.0".to_string()),
                ("request", "GetRecords".to_string()), ("outputFormat", "application/json".to_string()),
                ("datasetId", self.dataset_id.clone()),
                ("startTime", format!("{}T00:00:00Z", query.start)),
                ("endTime", format!("{}T23:59:59Z", query.end)),
                ("bbox", bbox), ("count", self.count.to_string()), ("startIndex", "1".to_string()),
            ];
            if let Some(resolution) = &self.resolution { params.push(("resolution", resolution.clone())); }
            let response = self.client.get(JAXA_CSW_ENDPOINT).query(&params)
                .header("Accept", "application/json").send().await?;
            if !response.status().is_success() { return Err(Error::Http(response.status().as_u16())); }
            let data = read_json_bounded(response, MAX_RESPONSE_BYTES).await?;
            let features = data.get("features").and_then(Value::as_array)
                .ok_or_else(|| Error::InvalidResponse("JAXA response lacks a features array".into()))?;
            if features.len() > 10000 { return Err(Error::InvalidResponse("Provider page exceeds the 10000-feature limit".into())); }
            let mut items = Vec::new();
            for feature in features {
                let scene = normalize_jaxa_feature(feature, &self.id)?;
                if seen.insert(scene.id.clone()) { items.push(scene); }
            }
            let matched = data.get("properties").and_then(|p| p.get("numberOfRecordsMatched")).and_then(Value::as_u64);
            pages.push(SearchPage { provider_id: self.id.clone(), items, page_number: index + 1, has_next: false, matched, skipped: 0 });
        }
        Ok(pages)
    }
    pub async fn search(&self, query: &SearchQuery) -> Result<Vec<Scene>, Error> {
        Ok(self.search_pages(query).await?.into_iter().flat_map(|page| page.items).collect())
    }
}

pub const OPEN_AERIAL_MAP_ENDPOINT: &str = "https://api.openaerialmap.org/meta";

/// A GeoJSON Polygon/MultiPolygon from a record, or None when the shape is unusable.
fn geojson_geometry(value: &Value) -> Option<Value> {
    let usable = value.get("coordinates").and_then(Value::as_array).is_some();
    match (value.get("type").and_then(Value::as_str), usable) {
        (Some("Polygon"), true) | (Some("MultiPolygon"), true) => Some(value.clone()),
        _ => None,
    }
}

/// Map one OpenAerialMap record to a normalized scene.
///
/// These are drone/aircraft images rather than satellite scenes: there is no cloud metadata, and
/// the provider reports `gsd` in **degrees** at scales that disagree between records (observed
/// 1.9e-7 and 2.8e-3 for comparable UAV captures), so it is kept in `raw` instead of being
/// guessed into metres. Per-image licences vary — the API itself is CC-BY 4.0 — so the declared
/// access class stays `unknown`.
pub fn normalize_oam_record(item: &Value, provider_id: &str, boxes: &[[f64; 4]]) -> Result<Scene, Error> {
    let id = item.get("_id").and_then(Value::as_str)
        .ok_or_else(|| Error::InvalidResponse("OpenAerialMap record missing _id".into()))?;
    let raw_when = item.get("acquisition_start").and_then(Value::as_str)
        .or_else(|| item.get("acquisition_end").and_then(Value::as_str))
        .ok_or_else(|| Error::InvalidResponse("OpenAerialMap record missing an acquisition time".into()))?;
    let acquired = DateTime::parse_from_rfc3339(raw_when)
        .map_err(|_| Error::InvalidResponse("Invalid OpenAerialMap acquisition time".into()))?
        .with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut assets: Vec<SceneAsset> = Vec::new();
    if let Some(tilejson) = item.get("properties").and_then(|p| p.get("tilejson")).and_then(Value::as_str) {
        assets.push(SceneAsset { key: "tilejson".into(), href: tilejson.into(),
            media_type: Some("application/json".into()), roles: vec!["tiles".into()], access: "unknown".into() });
    }
    if let Some(source) = item.get("uuid").and_then(Value::as_str) {
        assets.push(SceneAsset { key: "data".into(), href: source.into(),
            media_type: None, roles: vec!["data".into()], access: "unknown".into() });
    }
    let bbox = item.get("bbox").and_then(Value::as_array)
        .and_then(|values| values.iter().map(Value::as_f64).collect::<Option<Vec<f64>>>())
        .filter(|values| values.len() == 4);
    // The provider's own `geojson` when present, else the bbox as a rectangle (the WKT
    // `footprint` is retained in `raw`).
    let geometry = item.get("geojson").and_then(geojson_geometry).or_else(|| bbox.as_ref().map(|b| json!({
        "type": "Polygon",
        "coordinates": [[[b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]], [b[0], b[3]]]],
    })));
    Ok(Scene {
        provider_id: provider_id.into(), id: id.into(),
        collection: "openaerialmap".into(),
        acquired_at: acquired,
        mission: Some(item.get("platform").and_then(Value::as_str).unwrap_or("openaerialmap").to_owned()),
        geometry,
        bbox: bbox.clone(), cloud_cover_percent: None, gsd_meters: None,
        coverage_percent: coverage_percent(bbox.as_ref(), boxes),
        preview_url: None,
        access: declared_imagery_access(provider_id, None),
        assets,
        source_url: item.get("meta_uri").and_then(Value::as_str).map(str::to_owned),
        raw: item.clone(),
    })
}

/// OpenAerialMap metadata adapter.
///
/// Crowdsourced aerial imagery (drone/aircraft, not satellite) over an anonymous API:
/// `GET api.openaerialmap.org/meta?bbox=&acquisition_from=&acquisition_to=&limit=&page=`.
/// The acquisition window is filtered server-side from the query's start/end; `meta.found` is
/// the provider's total for that filter and `has_next` derives from it. No preview thumbnail is
/// published — each record instead carries a `tilejson` asset, which the explorer can render on
/// the map at native resolution.
#[derive(Clone)]
pub struct OamProvider {
    id: String,
    client: Client,
    limit: u32,
}
impl OamProvider {
    pub fn new(limit: u32) -> Result<Self, Error> {
        if limit == 0 || limit > 100 {
            return Err(Error::InvalidProvider("OpenAerialMap limit must be between 1 and 100".into()));
        }
        Ok(Self { id: "open-aerial-map".into(),
            client: Client::builder().timeout(Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none()).build()?,
            limit })
    }
    pub fn id(&self) -> &str { &self.id }
    pub async fn search_pages(&self, query: &SearchQuery) -> Result<Vec<SearchPage>, Error> {
        let (boxes, _) = resolve_areas(query)?;
        let limit = self.limit.min(query.limit as u32) as usize;
        let mut seen: HashSet<String> = HashSet::new();
        let mut pages = Vec::new();
        let mut page_number = 0usize;
        'boxes: for box_ in boxes.iter() {
            let bbox = box_.iter().map(|value| format!("{value:.6}")).collect::<Vec<_>>().join(",");
            let mut number = 1u32;
            loop {
                let params: Vec<(&str, String)> = vec![
                    ("bbox", bbox.clone()),
                    ("acquisition_from", query.start.clone()),
                    ("acquisition_to", query.end.clone()),
                    ("limit", limit.to_string()),
                    ("page", number.to_string()),
                ];
                let response = self.client.get(OPEN_AERIAL_MAP_ENDPOINT).query(&params)
                    .header("Accept", "application/json").send().await?;
                if !response.status().is_success() { return Err(Error::Http(response.status().as_u16())); }
                let data = read_json_bounded(response, MAX_RESPONSE_BYTES).await?;
                let records = data.get("results").and_then(Value::as_array)
                    .ok_or_else(|| Error::InvalidResponse("OpenAerialMap response lacks a results array".into()))?;
                if records.len() > 10000 {
                    return Err(Error::InvalidResponse("Provider page exceeds the 10000-record limit".into()));
                }
                let mut items = Vec::new();
                for record in records {
                    let scene = normalize_oam_record(record, &self.id, &boxes)?;
                    if seen.insert(scene.id.clone()) { items.push(scene); }
                }
                let matched = data.get("meta").and_then(|meta| meta.get("found")).and_then(Value::as_u64);
                let has_next = records.len() == limit
                    && matched.is_none_or(|total| (number as u64) * (limit as u64) < total);
                page_number += 1;
                pages.push(SearchPage { provider_id: self.id.clone(), items, page_number, has_next, matched, skipped: 0 });
                // Pages are materialised here, so stop at the query's page cap like the STAC
                // provider instead of looping over a large result set.
                if !has_next || page_number >= query.max_pages { break 'boxes; }
                number += 1;
            }
        }
        Ok(pages)
    }
    pub async fn search(&self, query: &SearchQuery) -> Result<Vec<Scene>, Error> {
        Ok(self.search_pages(query).await?.into_iter().flat_map(|page| page.items).collect())
    }
}
/// OpenAerialMap provider with a default page size.
pub fn open_aerial_map(limit: u32) -> Result<OamProvider, Error> { OamProvider::new(limit) }

/// A provider that can be registered with a [`SatelliteCatalog`].
#[derive(Clone)]
pub enum CatalogProvider {
    Stac(StacProvider),
    Asf(AsfProvider),
    Jaxa(JaxaProvider),
    Oam(OamProvider),
}
impl CatalogProvider {
    pub fn id(&self) -> &str {
        match self {
            CatalogProvider::Stac(p) => p.id(),
            CatalogProvider::Asf(p) => p.id(),
            CatalogProvider::Jaxa(p) => p.id(),
            CatalogProvider::Oam(p) => p.id(),
        }
    }
    /// Returns pages collected before any error, alongside the error.
    pub async fn pages_partial(&self, query: &SearchQuery) -> (Vec<SearchPage>, Option<Error>) {
        match self {
            CatalogProvider::Stac(p) => p.search_pages_partial(query).await,
            CatalogProvider::Asf(p) => match p.search_pages(query).await {
                Ok(pages) => (pages, None), Err(error) => (Vec::new(), Some(error)),
            },
            CatalogProvider::Jaxa(p) => match p.search_pages(query).await {
                Ok(pages) => (pages, None), Err(error) => (Vec::new(), Some(error)),
            },
            CatalogProvider::Oam(p) => match p.search_pages(query).await {
                Ok(pages) => (pages, None), Err(error) => (Vec::new(), Some(error)),
            },
        }
    }
}

/// Cross-provider aggregator: query several providers and preserve per-provider identity.
pub struct SatelliteCatalog {
    providers: Vec<CatalogProvider>,
}
impl SatelliteCatalog {
    pub fn new(providers: Vec<CatalogProvider>) -> Result<Self, Error> {
        if providers.is_empty() {
            return Err(Error::InvalidProvider("Provide at least one provider".into()));
        }
        let mut seen = HashSet::new();
        for provider in &providers {
            if !seen.insert(provider.id().to_string()) {
                return Err(Error::InvalidProvider(format!("Duplicate provider id: {}", provider.id())));
            }
        }
        Ok(Self { providers })
    }
    pub fn provider_ids(&self) -> Vec<&str> { self.providers.iter().map(CatalogProvider::id).collect() }
    pub async fn search_pages(&self, query: &SearchQuery) -> Result<Vec<SearchPage>, Error> {
        let mut all = Vec::new();
        for provider in &self.providers {
            let (pages, error) = provider.pages_partial(query).await;
            all.extend(pages);
            if let Some(error) = error { return Err(error); }
        }
        Ok(all)
    }
    pub async fn search(&self, query: &SearchQuery) -> Result<Vec<Scene>, Error> {
        Ok(self.search_pages(query).await?.into_iter().flat_map(|page| page.items).collect())
    }
    /// Availability across providers: a provider failure is recorded, not propagated.
    pub async fn availability(&self, query: &SearchQuery) -> AvailabilitySummary {
        let mut accumulator = AvailabilityAccumulator::new();
        for provider in &self.providers {
            let (pages, error) = provider.pages_partial(query).await;
            for page in &pages { let _ = accumulator.add_page(page); }
            if error.is_some() { accumulator.mark_error(provider.id()); }
        }
        accumulator.summary()
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
    fn retry_delay_prefers_retry_after() {
        assert_eq!(retry_delay_ms(0, Some(2), 500), 2000);
        assert_eq!(retry_delay_ms(0, None, 500), 500);
        assert_eq!(retry_delay_ms(3, None, 500), 4000);
    }
    #[test]
    fn stac_reuse_adapters() {
        assert_eq!(StacProvider::earth_search().unwrap().id(), "earth-search");
        assert_eq!(StacProvider::copernicus_data_space().unwrap().id(), "copernicus");
        assert_eq!(StacProvider::usgs_landsat_look().unwrap().id(), "usgs-landsatlook");
        assert_eq!(StacProvider::planetary_computer().unwrap().id(), "planetary-computer");
        assert_eq!(StacProvider::cmr_stac("ASF").unwrap().id(), "nasa-cmr:ASF");
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
        assert_eq!(scene.access, "authentication-required", "ASF downloads need Earthdata login");
        assert_eq!(AsfProvider::sentinel1().unwrap().id(), "asf-vertex");
    }
    #[test]
    fn oam_record_normalizes_aerial_imagery() {
        let record = json!({
            "_id": "a1",
            "acquisition_start": "2021-04-30T22:00:00.000Z",
            "acquisition_end": "2021-05-01T02:00:00.000Z",
            "bbox": [5.847374, 50.87125, 5.847564, 50.871908],
            "footprint": "POLYGON ((5.847374 50.87125, 5.847564 50.87125, 5.847564 50.871908, 5.847374 50.871908, 5.847374 50.87125))",
            "geojson": {"type":"Polygon","coordinates":[[[5.847374,50.871908],[5.847564,50.87125],[5.847374,50.871908]]]},
            "gsd": 0.0027583900000251026,
            "platform": "uav",
            "meta_uri": "https://oin-hotosm.s3.amazonaws.com/a1/0/meta.json",
            "uuid": "https://oin-hotosm.s3.amazonaws.com/a1/0/a1.tif",
            "properties": {"tilejson": "https://tiles.openaerialmap.org/cog/tilejson.json?url=a1"}
        });
        let scene = normalize_oam_record(&record, "open-aerial-map", &[]).unwrap();
        assert_eq!(scene.provider_id, "open-aerial-map");
        assert_eq!(scene.id, "a1");
        assert_eq!(scene.collection, "openaerialmap");
        assert_eq!(scene.acquired_at, "2021-04-30T22:00:00.000Z");
        assert_eq!(scene.mission.as_deref(), Some("uav"));
        assert_eq!(scene.bbox.as_ref().map(Vec::len), Some(4));
        assert_eq!(scene.geometry.as_ref().and_then(|g| g.get("type")).and_then(Value::as_str), Some("Polygon"));
        assert_eq!(scene.gsd_meters, None, "the provider's gsd is in degrees and inconsistently scaled");
        assert_eq!(scene.access, "unknown", "per-image licences vary");
        assert_eq!(scene.preview_url, None, "OpenAerialMap publishes no preview thumbnail");
        let tiles = scene.assets.iter().find(|a| a.roles.iter().any(|r| r == "tiles")).unwrap();
        assert!(tiles.href.contains("tilejson"));
        // A bbox rectangle is used when the provider omits `geojson`.
        let without = json!({"_id":"b1","acquisition_start":"2021-04-30T22:00:00.000Z",
            "bbox":[5.847374,50.87125,5.847564,50.871908]});
        let fallback = normalize_oam_record(&without, "open-aerial-map", &[]).unwrap();
        let ring = fallback.geometry.unwrap()["coordinates"][0].clone();
        assert_eq!(ring[0], json!([5.847374, 50.871908]));
        // Unusable records and provider options are explicit failures.
        assert!(matches!(normalize_oam_record(&json!({"acquisition_start":"2021-04-30T22:00:00.000Z"}),
            "open-aerial-map", &[]), Err(Error::InvalidResponse(_))));
        assert!(matches!(OamProvider::new(0), Err(Error::InvalidProvider(_))));
        assert!(matches!(OamProvider::new(101), Err(Error::InvalidProvider(_))));
        assert!(OamProvider::new(50).is_ok());
    }
    #[test]
    fn declared_imagery_access_maps_registry_and_refinements() {
        // Registry-derived defaults.
        assert_eq!(declared_imagery_access("usgs-landsatlook", None), "open");
        assert_eq!(declared_imagery_access("copernicus", None), "authentication-required");
        assert_eq!(declared_imagery_access("asf-vertex", None), "authentication-required");
        assert_eq!(declared_imagery_access("jaxa-gportal", None), "authentication-required");
        // Coarse registry values stay unknown instead of being guessed.
        assert_eq!(declared_imagery_access("earth-search", None), "unknown");
        assert_eq!(declared_imagery_access("earth-search", Some("unknown-collection")), "unknown");
        assert_eq!(declared_imagery_access("not-a-source", None), "unknown");
        // Collection and sub-provider refinements.
        assert_eq!(declared_imagery_access("earth-search", Some("sentinel-2-l2a")), "open");
        assert_eq!(declared_imagery_access("earth-search", Some("landsat-c2-l2")), "authentication-required");
        assert_eq!(declared_imagery_access("planetary-computer", Some("naip")), "open");
        assert_eq!(declared_imagery_access("nasa-cmr:ASF", None), "authentication-required");
        assert_eq!(declared_imagery_access("nasa-cmr:LPCLOUD", Some("HLSL30")), "unknown");
    }
    #[test]
    fn jaxa_feature_normalizes() {
        let feature = json!({"type":"Feature",
            "geometry":{"type":"Polygon","coordinates":[[[140.88,46.45],[141.0,46.5],[140.9,46.6],[140.88,46.45]]]},
            "properties":{"identifier":"GC1SG1_202107070007J00424_L2SG_SSTNQ_3000",
                "beginPosition":"2021-07-07T00:07:08.58Z","endPosition":"2021-07-07T00:09:48.22Z",
                "processingDate":"2022-03-02T16:33:32.00Z","platformShortName":"GCOM-C",
                "product":{"fileName":"https://gportal.jaxa.jp/download/standard/x.h5","DataFormatType":"HDF5"},
                "browse":[{"type":"QUICKLOOK","fileName":"https://gportal.jaxa.jp/gpr/img/x.jpg"}],
                "gpp":{"datasetId":"10002002","Resolution":"250m","cloudCoverPercentage":"6"}}});
        let scene = normalize_jaxa_feature(&feature, "jaxa-gportal").unwrap();
        assert_eq!(scene.provider_id, "jaxa-gportal");
        assert_eq!(scene.acquired_at, "2021-07-07T00:07:08.580Z");
        assert_eq!(scene.mission.as_deref(), Some("GCOM-C"));
        assert_eq!(scene.cloud_cover_percent, Some(6.0));
        assert_eq!(scene.preview_url.as_deref(), Some("https://gportal.jaxa.jp/gpr/img/x.jpg"));
        assert!(matches!(JaxaProvider::new("GCOM-C_SGLI_L2_SST_250m"), Err(Error::InvalidProvider(_))));
        assert!(JaxaProvider::new("10002002").is_ok());
    }

    #[tokio::test]
    async fn catalog_aggregates_and_rejects_duplicates() {
        let bodies = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let empty = json!({"type":"FeatureCollection","features":[],"links":[]}).to_string();
        let base = spawn_mock(vec![(200, empty.clone()), (200, empty)], bodies.clone());
        let catalog = SatelliteCatalog::new(vec![
            CatalogProvider::Stac(StacProvider::new("earth-search", &base).unwrap()),
            CatalogProvider::Stac(StacProvider::new("copernicus", &base).unwrap()),
        ]).unwrap();
        assert_eq!(catalog.provider_ids(), vec!["earth-search", "copernicus"]);
        let query = SearchQuery::new(-8.5, 116.1, 5000.0, "2025-01-01", "2025-01-31").unwrap();
        assert!(!catalog.search_pages(&query).await.unwrap().is_empty());
        assert!(!SatelliteCatalog::new(vec![]).is_ok());
        let a = StacProvider::new("dupe", &base).unwrap();
        let b = StacProvider::new("dupe", &base).unwrap();
        assert!(matches!(SatelliteCatalog::new(vec![CatalogProvider::Stac(a), CatalogProvider::Stac(b)]), Err(Error::InvalidProvider(_))));
    }

    fn spawn_mock(responses: Vec<(u16, String)>, bodies: std::sync::Arc<std::sync::Mutex<Vec<String>>>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let mut iter = responses.into_iter();
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break; };
                let Some((status, body)) = iter.next() else { break; };
                let mut buffer = vec![0u8; 8192];
                let n = stream.read(&mut buffer).unwrap_or(0);
                if let Ok(text) = std::str::from_utf8(&buffer[..n]) {
                    if let Some(index) = text.find("\r\n\r\n") {
                        bodies.lock().unwrap().push(text[index + 4..].to_string());
                    }
                }
                let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    #[tokio::test]
    async fn http_merge_defaults_to_body_replacement() {
        let bodies = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let page1 = json!({"type":"FeatureCollection","features":[],"links":[{"rel":"next","href":"/v1/search","method":"POST","body":{"token":"t2"}}]}).to_string();
        let page2 = json!({"type":"FeatureCollection","features":[],"links":[]}).to_string();
        let base = spawn_mock(vec![(200, page1), (200, page2)], bodies.clone());
        let provider = StacProvider::new("earth-search", &base).unwrap();
        let query = SearchQuery::new(-8.5, 116.1, 5000.0, "2025-01-01", "2025-01-31").unwrap();
        let pages = provider.search_pages(&query).await.unwrap();
        assert_eq!(pages.len(), 2);
        assert_eq!(bodies.lock().unwrap().get(1).map(|s| s.trim().to_string()), Some("{\"token\":\"t2\"}".to_string()));
    }

    #[tokio::test]
    async fn http_retries_429_then_succeeds() {
        let bodies = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let ok = json!({"type":"FeatureCollection","features":[],"links":[]}).to_string();
        let base = spawn_mock(vec![(429, "{}".to_string()), (200, ok)], bodies.clone());
        let provider = StacProvider::new("earth-search", &base).unwrap().with_retries(2, 1);
        let query = SearchQuery::new(-8.5, 116.1, 5000.0, "2025-01-01", "2025-01-31").unwrap();
        assert_eq!(provider.search_pages(&query).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn http_pagination_loop_is_rejected() {
        let bodies = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let page = json!({"type":"FeatureCollection","features":[],"links":[{"rel":"next","href":"/v1/search","method":"POST","body":{"token":"same"}}]}).to_string();
        let base = spawn_mock(vec![(200, page.clone()), (200, page.clone()), (200, page.clone()), (200, page)], bodies.clone());
        let mut query = SearchQuery::new(-8.5, 116.1, 5000.0, "2025-01-01", "2025-01-31").unwrap();
        query.max_pages = 5;
        let provider = StacProvider::new("earth-search", &base).unwrap();
        assert!(matches!(provider.search_pages(&query).await, Err(Error::PaginationLoop)));
    }
    #[test]
    fn rejects_malformed_multipolygon() {
        let bad = json!({"type":"MultiPolygon","coordinates":[[[[0.0,0.0],[1.0,0.0],[1.0,1.0],[0.0,0.0]]],5]});
        assert!(matches!(polygon_boxes(&bad), Err(Error::InvalidQuery(_))));
    }
    #[test]
    fn scene_serializes_camel_case() {
        let item = json!({"id":"x","collection":"sentinel-2-l2a",
            "properties":{"datetime":"2025-01-10T02:00:00Z","platform":"sentinel-2a"},"raw_key":"kept"});
        let scene = normalize_stac_item(item, "earth-search", &[]).unwrap();
        let value = serde_json::to_value(&scene).unwrap();
        for key in ["providerId", "acquiredAt", "cloudCoverPercent", "coveragePercent", "previewUrl", "sourceUrl"] {
            assert!(value.get(key).is_some(), "missing {key}");
        }
        assert_eq!(value["raw"]["raw_key"], json!("kept"));
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
        // Sentinel-2 L2A assets live in the public `sentinel-cogs` bucket.
        assert_eq!(scene.access, "open");
        assert_eq!(scene.preview_url.as_deref(), Some("https://example.test/preview.png"));
    }
    #[test]
    fn query_accepts_radar_and_aerial_collections() {
        // Collections live on the query in Rust, so callers opt in per search.
        let mut query = SearchQuery::new(0.0, 0.0, 1000.0, "2025-01-01", "2025-01-31").unwrap();
        query.collections = vec!["sentinel-1-rtc".into(), "naip".into()];
        assert!(query.validate().is_ok());
    }
    #[test]
    fn stac_preview_falls_back_to_thumbnail_link() {
        let fixture = json!({
            "id": "LC09_1", "collection": "landsat-c2-l2",
            "properties": {"datetime": "2025-01-10T02:12:00Z", "platform": "landsat-9"},
            "assets": {"thumbnail": {"href":"s3://usgs-landsat/collection02/LC09_1_thumb_small.jpeg",
                "type":"image/jpeg", "roles":["thumbnail"]}},
            "links": [
                {"rel":"self","href":"https://earth-search.aws.element84.com/v1/collections/landsat-c2-l2/items/LC09_1"},
                {"rel":"thumbnail","href":"https://earth-search.aws.element84.com/v1/collections/landsat-c2-l2/items/LC09_1/thumbnail"}
            ]
        });
        let scene = normalize_stac_item(fixture, "earth-search", &[]).unwrap();
        assert_eq!(scene.preview_url.as_deref(),
            Some("https://earth-search.aws.element84.com/v1/collections/landsat-c2-l2/items/LC09_1/thumbnail"));
    }
    #[tokio::test]
    async fn future_plan_is_explicitly_unavailable() {
        let err = EarthSearch::default().upcoming().await.unwrap_err();
        assert!(matches!(err, Error::Unsupported(_)));
    }
}
