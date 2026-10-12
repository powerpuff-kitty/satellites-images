"""Provider-agnostic discovery and an Earth Search STAC adapter."""
from __future__ import annotations

import json
import math
import re
import time
from dataclasses import dataclass
from datetime import date, datetime, timezone
from importlib.resources import files
from typing import Any, Callable, Iterator, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urljoin, urlsplit
from urllib.request import Request, urlopen


class SatelliteError(Exception):
    """Explicit failure: never treat unavailable catalogues as empty results."""

    def __init__(self, code: str, message: str, provider_id: str | None = None):
        super().__init__(message)
        self.code = code
        self.provider_id = provider_id


#: Upper bound on a provider response body, to bound memory under a hostile/oversized response.
MAX_RESPONSE_BYTES = 32 * 1024 * 1024


@dataclass(frozen=True)
class SearchQuery:
    #: Centre latitude. Required unless ``aoi`` is supplied.
    latitude: float | None = None
    #: Centre longitude. Required unless ``aoi`` is supplied.
    longitude: float | None = None
    #: Radius in metres (0 < r <= 100000). Required unless ``aoi`` is supplied.
    radius_meters: float | None = None
    start: str = ""
    end: str = ""
    #: Optional GeoJSON Polygon/MultiPolygon (RFC 7946 ``[lon, lat]``). Overrides centre/radius.
    aoi: dict[str, Any] | None = None
    collections: tuple[str, ...] | None = None
    limit: int = 50
    max_pages: int = 3

    def __post_init__(self) -> None:
        if not 1 <= self.limit <= 100 or type(self.limit) is not int:
            raise SatelliteError("INVALID_QUERY", "limit must be 1..100")
        if not 1 <= self.max_pages <= 50 or type(self.max_pages) is not int:
            raise SatelliteError("INVALID_QUERY", "max_pages must be 1..50")
        for name, value in [("start", self.start), ("end", self.end)]:
            try:
                if date.fromisoformat(value).isoformat() != value:
                    raise ValueError(value)
            except (TypeError, ValueError):
                raise SatelliteError("INVALID_QUERY", name + " must be YYYY-MM-DD") from None
        if self.start > self.end:
            raise SatelliteError("INVALID_QUERY", "start must be <= end")
        if self.collections is not None and (
            not self.collections or any(not isinstance(c, str) or not c.strip() for c in self.collections)
        ):
            raise SatelliteError("INVALID_QUERY", "collections cannot be empty")
        has_radius = (
            self.latitude is not None and self.longitude is not None and self.radius_meters is not None
        )
        if self.aoi is None and not has_radius:
            raise SatelliteError(
                "INVALID_QUERY", "Provide latitude/longitude/radius_meters or a GeoJSON aoi"
            )


@dataclass(frozen=True)
class SceneAsset:
    key: str
    href: str
    type: str | None
    roles: tuple[str, ...]
    access: str = "unknown"


@dataclass(frozen=True)
class Scene:
    provider_id: str
    id: str
    collection: str
    acquired_at: str
    mission: str | None
    geometry: dict[str, Any] | None
    bbox: list[float] | None
    cloud_cover_percent: float | None
    preview_url: str | None
    access: str
    assets: tuple[SceneAsset, ...]
    source_url: str | None
    raw: dict[str, Any]
    #: Ground sample distance in metres when the provider exposes `gsd`.
    gsd_meters: float | None = None
    #: Approximate bbox-overlap percentage of the requested AOI (0-100), or None.
    coverage_percent: float | None = None


@dataclass(frozen=True)
class SearchPage:
    provider_id: str
    items: tuple[Scene, ...]
    page_number: int
    has_next: bool
    matched: int | None
    #: Count of provider items skipped because they failed normalization.
    skipped: int = 0


class SearchProvider(Protocol):
    """The minimal contract the aggregator requires of any search provider (STAC or bespoke)."""

    id: str

    def search(self, query: SearchQuery) -> Iterator[SearchPage]: ...


def list_sources() -> list[dict[str, Any]]:
    """Return detached registry entries; this does not imply implemented adapters."""
    return json.loads(files("satellites_images").joinpath("sources.json").read_text(encoding="utf-8"))["sources"]


def radius_boxes(latitude: float, longitude: float, radius_meters: float) -> list[list[float]]:
    """Convert a centre/radius search into one or two STAC-safe bounding boxes.

    Antimeridian-crossing searches are split at +/-180; pole-crossing searches use
    the full longitude range instead of raising.
    """
    if not all(math.isfinite(x) for x in (latitude, longitude, radius_meters)) or not (
        -90 <= latitude <= 90 and -180 <= longitude <= 180 and 0 < radius_meters <= 100000
    ):
        raise SatelliteError("INVALID_QUERY", "Invalid coordinates or radius")
    lat_delta = radius_meters / 110574
    south = latitude - lat_delta
    north = latitude + lat_delta
    touches_pole = south <= -90 or north >= 90
    south = max(south, -90.0)
    north = min(north, 90.0)
    cos = math.cos(math.radians(latitude))
    if touches_pole or cos < .001:
        return [[-180.0, south, 180.0, north]]
    lon_delta = radius_meters / (111320 * cos)
    west = longitude - lon_delta
    east = longitude + lon_delta
    if east > 180:
        return [[west, south, 180.0, north], [-180.0, south, east - 360, north]]
    if west < -180:
        return [[west + 360, south, 180.0, north], [-180.0, south, east, north]]
    return [[west, south, east, north]]


def _position(value: Any) -> bool:
    return (
        isinstance(value, (list, tuple)) and len(value) == 2
        and all(isinstance(c, (int, float)) and not isinstance(c, bool) and math.isfinite(c) for c in value)
        and -180 <= value[0] <= 180 and -90 <= value[1] <= 90
    )


def _polygon_rings(aoi: Any) -> list[list[list[float]]]:
    if not isinstance(aoi, dict):
        raise SatelliteError("INVALID_QUERY", "AOI must be a GeoJSON Polygon or MultiPolygon")
    kind = aoi.get("type")
    coordinates = aoi.get("coordinates")
    if kind == "Polygon":
        rings = coordinates
    elif kind == "MultiPolygon":
        if not isinstance(coordinates, list) or not all(isinstance(p, list) for p in coordinates):
            raise SatelliteError("INVALID_QUERY", "AOI geometry has no rings")
        rings = [ring for polygon in coordinates for ring in polygon]
    else:
        raise SatelliteError("INVALID_QUERY", "AOI must be a GeoJSON Polygon or MultiPolygon")
    if not isinstance(rings, list) or not rings:
        raise SatelliteError("INVALID_QUERY", "AOI geometry has no rings")
    for ring in rings:
        if not isinstance(ring, list) or len(ring) < 4 or not all(_position(p) for p in ring):
            raise SatelliteError(
                "INVALID_QUERY", "AOI ring must hold at least 4 ordered [lon,lat] positions"
            )
    return rings


def _crosses_antimeridian(rings: list[list[list[float]]]) -> bool:
    for ring in rings:
        for index, point in enumerate(ring):
            following = ring[(index + 1) % len(ring)]
            if abs(following[0] - point[0]) > 180:
                return True
    return False


def polygon_boxes(aoi: Any) -> list[list[float]]:
    """Convert a GeoJSON polygon AOI into one or two STAC-safe bounding boxes."""
    rings = _polygon_rings(aoi)
    lats = [p[1] for ring in rings for p in ring]
    south, north = min(lats), max(lats)
    if not _crosses_antimeridian(rings):
        lons = [p[0] for ring in rings for p in ring]
        return [[min(lons), south, max(lons), north]]
    east_of_line, west_of_line = 180.0, -180.0
    for ring in rings:
        for lon, _ in ring:
            if 0 < lon < east_of_line:
                east_of_line = lon
            if lon <= 0 and lon > west_of_line:
                west_of_line = lon
    boxes: list[list[float]] = []
    if east_of_line < 180:
        boxes.append([east_of_line, south, 180.0, north])
    if west_of_line > -180:
        boxes.append([-180.0, south, west_of_line, north])
    if not boxes:
        raise SatelliteError("INVALID_QUERY", "AOI geometry is degenerate")
    return sorted(boxes, key=lambda box: box[0])


def resolve_areas(query: SearchQuery) -> tuple[list[list[float]], dict[str, Any] | None]:
    """Resolve a query into STAC-safe bounding boxes plus an optional intersects geometry."""
    if query.aoi is not None:
        boxes = polygon_boxes(query.aoi)
        return boxes, (query.aoi if len(boxes) == 1 else None)
    if query.latitude is None or query.longitude is None or query.radius_meters is None:
        raise SatelliteError("INVALID_QUERY", "Provide latitude/longitude/radius_meters or a GeoJSON aoi")
    return radius_boxes(query.latitude, query.longitude, query.radius_meters), None


def _box_area(box: list[float]) -> float:
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def _overlap_area(a: list[float], b: list[float]) -> float:
    width = min(a[2], b[2]) - max(a[0], b[0])
    height = min(a[3], b[3]) - max(a[1], b[1])
    return max(0.0, width) * max(0.0, height)


def coverage_percent(scene_bbox: Any, boxes: list[list[float]]) -> float | None:
    """bbox-overlap percentage of a scene within the requested area boxes (0-100)."""
    if (not isinstance(scene_bbox, list) or len(scene_bbox) != 4
            or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                       for v in scene_bbox)):
        return None
    total = sum(_box_area(box) for box in boxes)
    if total <= 0:
        return None
    covered = sum(_overlap_area(scene_bbox, box) for box in boxes)
    return max(0.0, min(100.0, covered / total * 100))


def bounds_around(latitude: float, longitude: float, radius_meters: float) -> list[float]:
    """Backwards-compatible single bounding box; returns the first STAC-safe box."""
    return radius_boxes(latitude, longitude, radius_meters)[0]


def _dictionary(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _port_or_default(parts: Any) -> tuple[str, str | None, int]:
    """(scheme, hostname, effective-port) so an explicit default port equals an omitted one."""
    default = 443 if parts.scheme == "https" else 80
    return (parts.scheme, parts.hostname, parts.port or default)


def _normalized_scene(raw: Any, provider_id: str, boxes: list[list[float]] | None = None) -> Scene:
    obj = _dictionary(raw)
    props = _dictionary(obj.get("properties"))
    identifier = obj.get("id")
    timestamp = props.get("datetime") or props.get("start_datetime")
    if not isinstance(identifier, str) or not isinstance(timestamp, str):
        raise SatelliteError("INVALID_RESPONSE", "Missing scene id or timestamp", provider_id)
    try:
        when = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        if when.tzinfo is None:
            raise ValueError("Missing timezone")
        acquired_at = when.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except ValueError:
        raise SatelliteError("INVALID_RESPONSE", "Invalid acquisition datetime", provider_id) from None
    assets: list[SceneAsset] = []
    for key, asset in _dictionary(obj.get("assets")).items():
        asset = _dictionary(asset)
        href = asset.get("href")
        if not isinstance(href, str) or not href:
            continue
        roles = tuple(r for r in asset.get("roles", []) if isinstance(r, str)) if isinstance(asset.get("roles"), list) else ()
        assets.append(SceneAsset(str(key), href, asset.get("type") if isinstance(asset.get("type"), str) else None, roles))
    asset_preview = next((a.href for a in assets if "thumbnail" in a.roles), None)
    if asset_preview is None:
        asset_preview = next((a.href for a in assets if a.key in ("thumbnail", "preview", "rendered_preview")), None)
    raw_links = obj.get("links")
    thumbnail_link = next((l.get("href") for l in raw_links if isinstance(l, dict) and l.get("rel") == "thumbnail"), None) if isinstance(raw_links, list) else None

    def _is_http_url(value: object) -> bool:
        return isinstance(value, str) and value.startswith(("http://", "https://"))

    # Prefer an http(s) preview: an asset thumbnail, else the item's `thumbnail` link
    # (Earth Search serves this for Landsat, whose asset hrefs are s3:// URIs).
    preview = next((v for v in (asset_preview, thumbnail_link) if _is_http_url(v)), None)
    if preview is None and isinstance(asset_preview, str):
        preview = asset_preview
    cloud = props.get("eo:cloud_cover")
    cloud_value = float(cloud) if isinstance(cloud, (int, float)) and not isinstance(cloud, bool) and math.isfinite(cloud) and 0 <= cloud <= 100 else None
    gsd = props.get("gsd")
    gsd_meters = float(gsd) if isinstance(gsd, (int, float)) and not isinstance(gsd, bool) and math.isfinite(gsd) and gsd > 0 else None
    links = obj.get("links")
    source_link = next((l.get("href") for l in links if isinstance(l, dict) and l.get("rel") == "self"), None) if isinstance(links, list) else None
    bbox = obj.get("bbox")
    return Scene(
        provider_id=provider_id,
        id=identifier,
        collection=str(obj.get("collection") or ""),
        acquired_at=acquired_at,
        mission=props.get("platform") if isinstance(props.get("platform"), str) else None,
        geometry=obj.get("geometry") if isinstance(obj.get("geometry"), dict) else None,
        bbox=bbox if isinstance(bbox, list) and all(isinstance(v, (float, int)) for v in bbox) else None,
        cloud_cover_percent=cloud_value,
        preview_url=preview,
        access="unknown",
        assets=tuple(assets),
        source_url=source_link if isinstance(source_link, str) else None,
        raw=obj,
        gsd_meters=gsd_meters,
        coverage_percent=coverage_percent(bbox, boxes) if boxes else None,
    )


Transport = Callable[[str, str, dict[str, Any] | None], dict[str, Any]]


def _http_json(url: str, method: str, body: dict[str, Any] | None) -> dict[str, Any]:
    encoded = json.dumps(body).encode("utf-8") if method == "POST" else None
    headers = {"Accept": "application/geo+json, application/json"}
    if encoded is not None:
        headers["Content-Type"] = "application/json"
    req = Request(url, data=encoded, headers=headers, method=method)
    try:
        with urlopen(req, timeout=20) as response:
            if _port_or_default(urlsplit(response.geturl())) != _port_or_default(urlsplit(url)):
                raise SatelliteError("UNSAFE_NEXT_LINK", "Refusing a cross-origin or downgraded redirect")
            content = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        retry_after = exc.headers.get("Retry-After") if exc.headers else None
        detail = "HTTP " + str(exc.code) + ((" retry-after=" + retry_after) if retry_after else "")
        raise SatelliteError("HTTP_ERROR", "STAC API returned " + detail) from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise SatelliteError("NETWORK", "STAC request failed: " + str(exc)) from exc
    if len(content) > MAX_RESPONSE_BYTES:
        raise SatelliteError("INVALID_RESPONSE", "Provider response exceeds size limit")
    try:
        parsed = json.loads(content)
    except (ValueError, UnicodeDecodeError, RecursionError) as exc:
        raise SatelliteError("INVALID_RESPONSE", "Invalid JSON response") from exc
    if not isinstance(parsed, dict):
        raise SatelliteError("INVALID_RESPONSE", "STAC response must be an object")
    return parsed


class StacProvider:
    def __init__(
        self, *, id: str, base_url: str, collections: tuple[str, ...],
        transport: Transport | None = None, retries: int = 0, retry_base_delay_ms: int = 500,
    ):
        self.id = id
        self.base_url = base_url.rstrip("/")
        self.collections = collections
        self._transport = transport or _http_json
        if type(retries) is not int or not 0 <= retries <= 10:
            raise SatelliteError("INVALID_PROVIDER", "retries must be an integer between 0 and 10")
        if type(retry_base_delay_ms) is not int or not 0 <= retry_base_delay_ms <= 10000:
            raise SatelliteError("INVALID_PROVIDER", "retry_base_delay_ms must be between 0 and 10000")
        self.retries = retries
        self.retry_base_delay_ms = retry_base_delay_ms
        url = urlsplit(self.base_url)
        if url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1")):
            raise SatelliteError("INVALID_PROVIDER", "Provider must use HTTPS except localhost")

    def _retrying_transport(self, href: str, method: str, body: Any) -> Any:
        """Retry transient HTTP 429/503 responses, honouring Retry-After when present."""
        for attempt in range(self.retries + 1):
            try:
                return self._transport(href, method, body if method == "POST" else None)
            except SatelliteError as exc:
                message = str(exc)
                transient = exc.code == "HTTP_ERROR" and ("HTTP 429" in message or "HTTP 503" in message)
                if not transient or attempt >= self.retries:
                    raise
                match = re.search(r"retry-after=(\d+)", message)
                requested = int(match.group(1)) * 1000 if match else self.retry_base_delay_ms * (2 ** attempt)
                time.sleep(min(max(0, requested), 60000) / 1000)
        raise SatelliteError("HTTP_ERROR", "STAC request failed after retries", self.id)

    def search(self, query: SearchQuery) -> Iterator[SearchPage]:
        collections = query.collections if query.collections is not None else self.collections
        if not collections:
            raise SatelliteError("INVALID_QUERY", "Provide at least one collection")
        boxes, polygon = resolve_areas(query)
        seen: set[str] = set()
        page_number = 0
        truncated_earlier = False
        # A polygon already constrains the query, so one request suffices.
        used_boxes = boxes[:1] if polygon is not None else boxes
        for box_index, box in enumerate(used_boxes):
            last_box = box_index == len(used_boxes) - 1
            body: dict[str, Any] = {
                "datetime": query.start + "T00:00:00Z/" + query.end + "T23:59:59Z",
                "collections": list(collections),
                "limit": query.limit,
            }
            # STAC allows exactly one spatial filter: bbox OR intersects.
            if polygon is not None:
                body["intersects"] = polygon
            else:
                body["bbox"] = list(box)
            href = self.base_url + "/search"
            method = "POST"
            visited: set[str] = set()
            box_pages = 0
            last_had_next = False
            while box_pages < query.max_pages:
                cursor = json.dumps([href, method, body], sort_keys=True)
                if cursor in visited:
                    raise SatelliteError("PAGINATION_LOOP", "Repeating next link", self.id)
                visited.add(cursor)
                try:
                    result = self._retrying_transport(href, method, body)
                except SatelliteError as exc:
                    if exc.provider_id is None:
                        exc.provider_id = self.id
                    raise
                except Exception as exc:
                    raise SatelliteError("NETWORK", "Request failed: " + str(exc), self.id) from exc
                if not isinstance(result, dict) or not isinstance(result.get("features"), list):
                    raise SatelliteError("INVALID_RESPONSE", "STAC response lacks features", self.id)
                links = result.get("links", [])
                if not isinstance(links, list):
                    links = []
                next_link = next((link for link in links if isinstance(link, dict) and link.get("rel") == "next"), None)
                context = _dictionary(result.get("context"))
                matched = context.get("matched", result.get("numberMatched"))
                items: list[Scene] = []
                skipped = 0
                for item in result["features"]:
                    try:
                        scene = _normalized_scene(item, self.id, boxes)
                    except SatelliteError:
                        skipped += 1
                        continue
                    if scene.id in seen:
                        continue
                    seen.add(scene.id)
                    items.append(scene)
                box_pages += 1
                page_number += 1
                last_had_next = next_link is not None
                yield SearchPage(
                    self.id,
                    tuple(items),
                    page_number,
                    next_link is not None or (last_box and truncated_earlier),
                    matched if isinstance(matched, int) and not isinstance(matched, bool) else None,
                    skipped,
                )
                if next_link is None:
                    break
                if not isinstance(next_link.get("href"), str):
                    raise SatelliteError("INVALID_RESPONSE", "STAC next link has no href", self.id)
                next_url = urljoin(href, next_link["href"])
                requested = urlsplit(next_url)
                allowed = urlsplit(self.base_url)
                if _port_or_default(requested) != _port_or_default(allowed):
                    raise SatelliteError("UNSAFE_NEXT_LINK", "Refusing cross-origin next link", self.id)
                method = str(next_link.get("method", "GET")).upper()
                if method not in ("GET", "POST"):
                    raise SatelliteError("INVALID_RESPONSE", "Unsupported next link method", self.id)
                if method == "POST":
                    next_body = _dictionary(next_link.get("body"))
                    # STAC pagination: merge defaults to false, so the next body replaces the query.
                    body = {**body, **next_body} if next_link.get("merge") is True else next_body
                href = next_url
            if box_pages >= query.max_pages and last_had_next:
                truncated_earlier = True


ASF_ENDPOINT = "https://api.daac.asf.alaska.edu/services/search/param"


def normalize_asf_feature(raw: Any, provider_id: str = "asf-vertex") -> Scene:
    """Map one ASF Search API GeoJSON feature to a normalized scene."""
    obj = _dictionary(raw)
    props = _dictionary(obj.get("properties"))
    identifier = props.get("granuleName") or props.get("sceneName") or obj.get("id")
    date = props.get("startTime") or props.get("stopTime")
    if not isinstance(identifier, str) or not isinstance(date, str):
        raise SatelliteError("INVALID_RESPONSE", "ASF feature lacks a granule name or start time", provider_id)
    try:
        when = datetime.fromisoformat(date.replace("Z", "+00:00"))
        if when.tzinfo is None:
            raise ValueError("Missing timezone")
        acquired = when.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except ValueError:
        raise SatelliteError("INVALID_RESPONSE", "Invalid ASF start time", provider_id) from None
    browse = [b for b in props.get("browse", []) if isinstance(b, str)] if isinstance(props.get("browse"), list) else []
    download = props.get("downloadUrl") if isinstance(props.get("downloadUrl"), str) else None
    assets: list[SceneAsset] = []
    if download:
        assets.append(SceneAsset("data", download, None, ("data",)))
    for index, href in enumerate(browse):
        assets.append(SceneAsset("browse_" + str(index), href, None, ("thumbnail",)))
    return Scene(
        provider_id=provider_id,
        id=identifier,
        collection=props.get("processingLevel") if isinstance(props.get("processingLevel"), str) else "asf",
        acquired_at=acquired,
        mission=props.get("platform") if isinstance(props.get("platform"), str) else None,
        geometry=obj.get("geometry") if isinstance(obj.get("geometry"), dict) else None,
        bbox=None,
        cloud_cover_percent=None,
        preview_url=browse[0] if browse else None,
        access="unknown",
        assets=tuple(assets),
        source_url=download,
        raw=obj,
    )


def _asf_features(data: Any) -> list[Any]:
    if isinstance(data, dict):
        if isinstance(data.get("features"), list):
            return list(data["features"])
        collected: list[Any] = []
        for value in data.values():
            if isinstance(value, (list, dict)):
                collected.extend(_asf_features(value))
        return collected
    if isinstance(data, list):
        collected = []
        for value in data:
            collected.extend(_asf_features(value))
        return collected
    return []


class AsfSearch:
    """Alaska Satellite Facility (ASF) Search API adapter (keyword query, GeoJSON output).

    SAR metadata search is anonymous; downloading products needs Earthdata authentication.
    """

    id = "asf-vertex"

    def __init__(self, platforms: tuple[str, ...] = ("SENTINEL-1",),
                 transport: Transport | None = None):
        if not platforms or any(not re.fullmatch(r"[A-Za-z0-9-]+", p) for p in platforms):
            raise SatelliteError("INVALID_PROVIDER", "ASF platform must be alphanumeric", self.id)
        self.platforms = platforms
        self._transport = transport or _http_json

    def search(self, query: SearchQuery) -> Iterator[SearchPage]:
        boxes, _ = resolve_areas(query)
        seen: set[str] = set()
        page = 0
        for box in boxes:
            params = urlencode({
                "platform": ",".join(self.platforms),
                "start": query.start,
                "end": query.end,
                "bbox": ",".join(f"{value:.6f}" for value in box),
                "maxResults": query.limit,
                "output": "geojson",
            })
            url = ASF_ENDPOINT + "?" + params
            try:
                result = self._transport(url, "GET", None)
            except SatelliteError as exc:
                if exc.provider_id is None:
                    exc.provider_id = self.id
                raise
            except Exception as exc:
                raise SatelliteError("NETWORK", "ASF request failed: " + str(exc), self.id) from exc
            if not isinstance(result, (dict, list)):
                raise SatelliteError("INVALID_RESPONSE", "ASF response must be JSON", self.id)
            items: list[Scene] = []
            features = _asf_features(result)
            if len(features) > 10000:
                raise SatelliteError("INVALID_RESPONSE", "Provider page exceeds the 10000-feature limit", self.id)
            for feature in features:
                scene = normalize_asf_feature(feature, self.id)
                if scene.id in seen:
                    continue
                seen.add(scene.id)
                items.append(scene)
            page += 1
            yield SearchPage(self.id, tuple(items), page, False, len(items))


JAXA_CSW_ENDPOINT = "https://gportal.jaxa.jp/csw/csw"


def normalize_jaxa_feature(raw: Any, provider_id: str = "jaxa-gportal") -> Scene:
    """Map one JAXA G-Portal CSW granule (GeoJSON output) to a normalized scene."""
    obj = _dictionary(raw)
    props = _dictionary(obj.get("properties"))
    gpp = _dictionary(props.get("gpp"))
    identifier = props.get("identifier")
    # beginPosition is the real observation start, distinct from processingDate.
    date = props.get("beginPosition") or props.get("endPosition")
    if not isinstance(identifier, str) or not isinstance(date, str):
        raise SatelliteError("INVALID_RESPONSE", "JAXA feature lacks an identifier or begin position", provider_id)
    try:
        when = datetime.fromisoformat(date.replace("Z", "+00:00"))
        if when.tzinfo is None:
            raise ValueError("Missing timezone")
        acquired = when.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except ValueError:
        raise SatelliteError("INVALID_RESPONSE", "Invalid JAXA begin position", provider_id) from None
    browse = ([b for b in props.get("browse", []) if isinstance(b, dict) and isinstance(b.get("fileName"), str)]
              if isinstance(props.get("browse"), list) else [])
    product = _dictionary(props.get("product"))
    download = product.get("fileName") if isinstance(product.get("fileName"), str) else None
    assets: list[SceneAsset] = []
    if download:
        media_type = product.get("DataFormatType") if isinstance(product.get("DataFormatType"), str) else None
        assets.append(SceneAsset("data", download, media_type, ("data",)))
    for index, entry in enumerate(browse):
        assets.append(SceneAsset("browse_" + str(index), entry["fileName"], None, ("thumbnail",)))
    cloud_text = gpp.get("cloudCoverPercentage") if isinstance(gpp.get("cloudCoverPercentage"), str) else None
    try:
        cloud = float(cloud_text) if cloud_text is not None else None
    except ValueError:
        cloud = None
    return Scene(
        provider_id=provider_id,
        id=identifier,
        collection=props.get("platformShortName") if isinstance(props.get("platformShortName"), str) else "jaxa",
        acquired_at=acquired,
        mission=props.get("platformShortName") if isinstance(props.get("platformShortName"), str) else None,
        geometry=obj.get("geometry") if isinstance(obj.get("geometry"), dict) else None,
        bbox=None,
        cloud_cover_percent=cloud,
        preview_url=browse[0]["fileName"] if browse else None,
        access="unknown",
        assets=tuple(assets),
        source_url=download,
        raw=obj,
    )


class JaxaGPortal:
    """JAXA G-Portal granule adapter (CSW 3.0.0 GET returning GeoJSON).

    Metadata search is anonymous; only GET is supported (POST is WAF-blocked).
    """

    id = "jaxa-gportal"

    def __init__(self, dataset_id: str, resolution: str | None = None, count: int = 100,
                 transport: Transport | None = None):
        if not re.fullmatch(r"\d+", dataset_id):
            raise SatelliteError("INVALID_PROVIDER", "A numeric JAXA datasetId is required", self.id)
        if type(count) is not int or not 1 <= count <= 3000:
            raise SatelliteError("INVALID_PROVIDER", "count must be an integer between 1 and 3000", self.id)
        self.dataset_id = dataset_id
        self.resolution = resolution
        self.count = count
        self._transport = transport or _http_json

    def search(self, query: SearchQuery) -> Iterator[SearchPage]:
        boxes, _ = resolve_areas(query)
        seen: set[str] = set()
        page = 0
        for box in boxes:
            params: dict[str, Any] = {
                "service": "CSW", "version": "3.0.0", "request": "GetRecords",
                "outputFormat": "application/json", "datasetId": self.dataset_id,
                "startTime": query.start + "T00:00:00Z", "endTime": query.end + "T23:59:59Z",
                "bbox": ",".join(f"{value:.6f}" for value in box),
                "count": self.count, "startIndex": 1,
            }
            if self.resolution:
                params["resolution"] = self.resolution
            url = JAXA_CSW_ENDPOINT + "?" + urlencode(params)
            try:
                result = self._transport(url, "GET", None)
            except SatelliteError as exc:
                if exc.provider_id is None:
                    exc.provider_id = self.id
                raise
            except Exception as exc:
                raise SatelliteError("NETWORK", "JAXA request failed: " + str(exc), self.id) from exc
            if not isinstance(result, dict):
                raise SatelliteError("INVALID_RESPONSE", "JAXA response must be a GeoJSON object", self.id)
            features = result.get("features")
            if not isinstance(features, list):
                raise SatelliteError("INVALID_RESPONSE", "JAXA response lacks a features array", self.id)
            if len(features) > 10000:
                raise SatelliteError("INVALID_RESPONSE", "Provider page exceeds the 10000-feature limit", self.id)
            items: list[Scene] = []
            for feature in features:
                scene = normalize_jaxa_feature(feature, self.id)
                if scene.id in seen:
                    continue
                seen.add(scene.id)
                items.append(scene)
            page += 1
            matched = _dictionary(result.get("properties")).get("numberOfRecordsMatched")
            yield SearchPage(self.id, tuple(items), page, False,
                             matched if isinstance(matched, int) and not isinstance(matched, bool) else None)


class EarthSearch(StacProvider):
    def __init__(self, transport: Transport | None = None, **kwargs: Any):
        super().__init__(
            id="earth-search",
            base_url="https://earth-search.aws.element84.com/v1",
            collections=("sentinel-2-l2a", "landsat-c2-l2"),
            transport=transport,
            **kwargs,
        )


class PlanetaryComputer(StacProvider):
    def __init__(self, transport: Transport | None = None, **kwargs: Any):
        super().__init__(
            id="planetary-computer",
            base_url="https://planetarycomputer.microsoft.com/api/stac/v1",
            collections=("sentinel-2-l2a", "landsat-c2-l2", "sentinel-1-rtc", "naip"),
            transport=transport,
            **kwargs,
        )


class CopernicusDataSpace(StacProvider):
    def __init__(self, transport: Transport | None = None, **kwargs: Any):
        super().__init__(
            id="copernicus",
            base_url="https://stac.dataspace.copernicus.eu/v1",
            collections=("sentinel-2-l2a", "sentinel-1-grd"),
            transport=transport,
            **kwargs,
        )


class UsgsLandsatLook(StacProvider):
    """USGS LandsatLook STAC server. Server-side only: its CORS policy blocks other origins."""

    def __init__(self, transport: Transport | None = None, **kwargs: Any):
        super().__init__(
            id="usgs-landsatlook",
            base_url="https://landsatlook.usgs.gov/stac-server",
            collections=("landsat-c2l2-sr", "landsat-c2l2-st", "landsat-c2l1"),
            transport=transport,
            **kwargs,
        )


class CmrStac(StacProvider):
    """NASA CMR-STAC, provider-scoped (e.g. "ASF", "USGS_LTA", "JAXA")."""

    def __init__(self, provider_id: str, collections: tuple[str, ...],
                 transport: Transport | None = None, **kwargs: Any):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", provider_id):
            raise SatelliteError("INVALID_PROVIDER", "CMR provider id must be alphanumeric")
        super().__init__(
            id="nasa-cmr:" + provider_id,
            base_url="https://cmr.earthdata.nasa.gov/stac/" + provider_id,
            collections=collections,
            transport=transport,
            **kwargs,
        )


class SatelliteCatalog:
    def __init__(self, providers: list[SearchProvider], acquisition_providers=None):
        if not providers or len({p.id for p in providers}) != len(providers):
            raise SatelliteError("INVALID_PROVIDER", "Provide unique implemented providers")
        self.providers = providers
        self.acquisition_providers = acquisition_providers or []

    def list_sources(self) -> list[dict[str, Any]]:
        return list_sources()

    def search(self, query: SearchQuery, provider_ids: list[str] | None = None) -> Iterator[SearchPage]:
        if provider_ids and any(i not in {p.id for p in self.providers} for i in provider_ids):
            raise SatelliteError("UNSUPPORTED_PROVIDER", "Requested provider not configured")
        for provider in self.providers:
            if provider_ids is None or provider.id in provider_ids:
                yield from provider.search(query)

    def availability(self, query: SearchQuery, provider_ids: list[str] | None = None):
        from .availability import AvailabilityAccumulator
        accumulator = AvailabilityAccumulator()
        try:
            for page in self.search(query, provider_ids):
                accumulator.add_page(page)
        except SatelliteError as exc:
            # Keep partial counts and attribute the failure rather than discarding the scan.
            accumulator.mark_error(exc.provider_id or "unknown")
        return accumulator.summary()

    def upcoming(self, query=None) -> list:
        if not self.acquisition_providers:
            raise SatelliteError("UNSUPPORTED", "Configure an acquisition provider such as ESASentinelPlans()")
        results = []
        for provider in self.acquisition_providers:
            results.extend(provider.upcoming(query))
        return sorted(results, key=lambda opportunity: opportunity.expected_at)

