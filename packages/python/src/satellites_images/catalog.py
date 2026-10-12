"""Provider-agnostic discovery and an Earth Search STAC adapter."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import date, datetime, timezone
from importlib.resources import files
from typing import Any, Callable, Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen


class SatelliteError(Exception):
    """Explicit failure: never treat unavailable catalogues as empty results."""

    def __init__(self, code: str, message: str, provider_id: str | None = None):
        super().__init__(message)
        self.code = code
        self.provider_id = provider_id


@dataclass(frozen=True)
class SearchQuery:
    latitude: float
    longitude: float
    radius_meters: float
    start: str
    end: str
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


@dataclass(frozen=True)
class SearchPage:
    provider_id: str
    items: tuple[Scene, ...]
    page_number: int
    has_next: bool
    matched: int | None


def list_sources() -> list[dict[str, Any]]:
    """Return detached registry entries; this does not imply implemented adapters."""
    return json.loads(files("satellites_images").joinpath("sources.json").read_text(encoding="utf-8"))["sources"]


def bounds_around(latitude: float, longitude: float, radius_meters: float) -> list[float]:
    if not all(math.isfinite(x) for x in (latitude, longitude, radius_meters)) or not (
        -90 <= latitude <= 90 and -180 <= longitude <= 180 and 0 < radius_meters <= 100000
    ):
        raise SatelliteError("INVALID_QUERY", "Invalid coordinates or radius")
    lat_delta = radius_meters / 110574
    if latitude - lat_delta < -90 or latitude + lat_delta > 90:
        raise SatelliteError("UNSUPPORTED_AREA", "AOI crosses a pole")
    cos = math.cos(math.radians(latitude))
    if cos < .001:
        raise SatelliteError("UNSUPPORTED_AREA", "AOI too close to a pole")
    lon_delta = radius_meters / (111320 * cos)
    if longitude - lon_delta < -180 or longitude + lon_delta > 180:
        raise SatelliteError("UNSUPPORTED_AREA", "AOI crosses antimeridian")
    return [longitude - lon_delta, latitude - lat_delta, longitude + lon_delta, latitude + lat_delta]


def _dictionary(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _normalized_scene(raw: Any, provider_id: str) -> Scene:
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
    preview = next((a.href for a in assets if "thumbnail" in a.roles), None)
    if preview is None:
        preview = next((a.href for a in assets if a.key in ("thumbnail", "preview", "rendered_preview")), None)
    cloud = props.get("eo:cloud_cover")
    cloud_value = float(cloud) if isinstance(cloud, (int, float)) and not isinstance(cloud, bool) and math.isfinite(cloud) and 0 <= cloud <= 100 else None
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
            content = response.read()
    except HTTPError as exc:
        raise SatelliteError("HTTP_ERROR", "STAC API returned HTTP " + str(exc.code)) from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise SatelliteError("NETWORK", "STAC request failed: " + str(exc)) from exc
    try:
        parsed = json.loads(content)
    except (ValueError, UnicodeDecodeError) as exc:
        raise SatelliteError("INVALID_RESPONSE", "Invalid JSON response") from exc
    if not isinstance(parsed, dict):
        raise SatelliteError("INVALID_RESPONSE", "STAC response must be an object")
    return parsed


class StacProvider:
    def __init__(
        self, *, id: str, base_url: str, collections: tuple[str, ...],
        transport: Transport | None = None,
    ):
        self.id = id
        self.base_url = base_url.rstrip("/")
        self.collections = collections
        self._transport = transport or _http_json
        url = urlsplit(self.base_url)
        if url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1")):
            raise SatelliteError("INVALID_PROVIDER", "Provider must use HTTPS except localhost")

    def search(self, query: SearchQuery) -> Iterator[SearchPage]:
        collections = query.collections if query.collections is not None else self.collections
        if not collections:
            raise SatelliteError("INVALID_QUERY", "Provide at least one collection")
        body: dict[str, Any] = {
            "bbox": bounds_around(query.latitude, query.longitude, query.radius_meters),
            "datetime": query.start + "T00:00:00Z/" + query.end + "T23:59:59Z",
            "collections": list(collections),
            "limit": query.limit,
        }
        href = self.base_url + "/search"
        method = "POST"
        visited: set[str] = set()
        for index in range(query.max_pages):
            cursor = json.dumps([href, method, body], sort_keys=True)
            if cursor in visited:
                raise SatelliteError("PAGINATION_LOOP", "Repeating next link", self.id)
            visited.add(cursor)
            try:
                result = self._transport(href, method, body if method == "POST" else None)
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
            yield SearchPage(
                self.id,
                tuple(_normalized_scene(item, self.id) for item in result["features"]),
                index + 1,
                next_link is not None,
                matched if isinstance(matched, int) and not isinstance(matched, bool) else None,
            )
            if next_link is None:
                break
            if not isinstance(next_link.get("href"), str):
                raise SatelliteError("INVALID_RESPONSE", "STAC next link has no href", self.id)
            next_url = urljoin(href, next_link["href"])
            requested = urlsplit(next_url)
            allowed = urlsplit(self.base_url)
            if (requested.scheme, requested.netloc) != (allowed.scheme, allowed.netloc):
                raise SatelliteError("UNSAFE_NEXT_LINK", "Refusing cross-origin next link", self.id)
            method = str(next_link.get("method", "GET")).upper()
            if method not in ("GET", "POST"):
                raise SatelliteError("INVALID_RESPONSE", "Unsupported next link method", self.id)
            if method == "POST":
                next_body = _dictionary(next_link.get("body"))
                body = {**body, **next_body} if next_link.get("merge") is True else next_body
            href = next_url


class EarthSearch(StacProvider):
    def __init__(self, transport: Transport | None = None):
        super().__init__(
            id="earth-search",
            base_url="https://earth-search.aws.element84.com/v1",
            collections=("sentinel-2-l2a", "landsat-c2-l2"),
            transport=transport,
        )


class SatelliteCatalog:
    def __init__(self, providers: list[StacProvider], acquisition_providers=None):
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

    def upcoming(self, query=None) -> list:
        if not self.acquisition_providers:
            raise SatelliteError("UNSUPPORTED", "Configure an acquisition provider such as ESASentinelPlans()")
        results = []
        for provider in self.acquisition_providers:
            results.extend(provider.upcoming(query))
        return sorted(results, key=lambda opportunity: opportunity.expected_at)

