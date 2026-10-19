"""ESA Sentinel-1/2 planned acquisition footprints, separate from published scenes.

Parse official KML ExtendedData and polygon swaths with the standard library.
No orbit prediction, commercial tasking or inferred product availability.
"""
from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime, date, timedelta, timezone
from html.parser import HTMLParser
from typing import Callable, Any
from urllib.parse import urljoin, urlsplit
from urllib.request import Request
from urllib.error import URLError, HTTPError

from .catalog import SatelliteError, bounds_around, _http_opener, _acquisition_time

ORIGIN = "https://sentinels.copernicus.eu"
INDEXES = {
    "S1": ORIGIN + "/copernicus/sentinel-1/acquisition-plans",
    "S2": ORIGIN + "/copernicus/sentinel-2/acquisition-plans",
}
KNOWN = ("S1C", "S1D", "S2A", "S2B", "S2C")
SLUG = re.compile(
    r"(s[12][a-d]_mp_(?:acq__kml|user)_(\d{8}t\d{6})_(\d{8}t\d{6}))",
    re.IGNORECASE,
)
NS = "{http://www.opengis.net/kml/2.2}"
MAX_INDEX_CHARS = 2_000_000


@dataclass(frozen=True)
class AcquisitionQuery:
    latitude: float
    longitude: float
    radius_meters: float
    start: str | None = None
    end: str | None = None
    days: int = 14
    missions: tuple[str, ...] | None = None


@dataclass(frozen=True)
class ESAPlan:
    mission: str
    url: str
    starts_at: str
    ends_at: str


@dataclass(frozen=True)
class AcquisitionOpportunity:
    id: str
    provider_id: str
    mission: str
    expected_at: str
    end_at: str | None
    status: str
    source_url: str
    footprint: dict[str, Any]
    mode: str | None = None
    orbit_relative: int | None = None


@dataclass(frozen=True)
class ESAPlanDiagnostic:
    """One selected plan contributing to an upcoming query."""

    mission: str
    source_url: str
    starts_at: str
    ends_at: str
    from_cache: bool


@dataclass(frozen=True)
class ESAUpcomingResult:
    opportunities: list[AcquisitionOpportunity]
    #: UTC time the query last downloaded a plan body, or None when none was read.
    fetched_at: str | None
    plans: list[ESAPlanDiagnostic]
    #: "ok" | "no-current-plan" | "no-overlap".
    status: str


class _Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.urls: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "a":
            url = dict(attrs).get("href")
            if url:
                self.urls.append(url)


def _file_timestamp(value: str) -> str:
    try:
        return datetime.strptime(value.lower(), "%Y%m%dt%H%M%S").replace(
            tzinfo=timezone.utc
        ).isoformat(timespec="seconds").replace("+00:00", "Z")
    except ValueError:
        return ""


def parse_esa_plan_index(html: str) -> list[ESAPlan]:
    """Return official ESA plan KML links, newest first per mission."""
    if len(html) > MAX_INDEX_CHARS:
        raise SatelliteError("INVALID_RESPONSE", "ESA index too large")
    parser = _Links()
    parser.feed(html)
    plans: dict[str, ESAPlan] = {}
    for raw_url in parser.urls:
        url = urljoin(ORIGIN, raw_url)
        parts = urlsplit(url)
        if parts.scheme != "https" or parts.netloc != "sentinels.copernicus.eu" or not parts.path.startswith("/documents/"):
            continue
        slug = SLUG.search(parts.path)
        if not slug:
            continue
        mission = slug.group(1)[:3].upper()
        if mission not in KNOWN:
            continue
        starts = _file_timestamp(slug.group(2))
        ends = _file_timestamp(slug.group(3))
        if not starts or not ends or ends < starts:
            continue
        key = mission + ":" + slug.group(1).lower()
        plans[key] = ESAPlan(mission, url, starts, ends)
    return sorted(plans.values(), key=lambda p: (p.mission, -_parse_time(p.starts_at).timestamp(), -_parse_time(p.ends_at).timestamp()))


def _parse_time(text: str) -> datetime:
    value = text.strip()
    if not re.search(r"(Z|[+-]\d\d:\d\d)$", value, re.I):
        value += "Z"
    parsed = _acquisition_time(value)
    if parsed.tzinfo is None:
        raise ValueError("Missing timezone")
    return parsed.astimezone(timezone.utc)


def _date_start(text: str, name: str) -> datetime:
    try:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text) or date.fromisoformat(text).isoformat() != text:
            raise ValueError(text)
        return datetime.combine(date.fromisoformat(text), datetime.min.time(), timezone.utc)
    except (ValueError, TypeError):
        raise SatelliteError("INVALID_QUERY", name + " must be YYYY-MM-DD") from None


def _window(query: AcquisitionQuery, clock: Callable[[], datetime]) -> tuple[datetime, datetime, list[float]]:
    bounds = bounds_around(query.latitude, query.longitude, query.radius_meters)
    if type(query.days) is not int or not 1 <= query.days <= 366:
        raise SatelliteError("INVALID_QUERY", "days must be between 1 and 366")
    now = clock().astimezone(timezone.utc)
    start = max(now, _date_start(query.start, "start") if query.start is not None else now)
    stop = (_date_start(query.end, "end") + timedelta(days=1, microseconds=-1)
            if query.end is not None else now + timedelta(days=query.days))
    if stop < start or stop - start > timedelta(days=367):
        raise SatelliteError("INVALID_QUERY", "Invalid upcoming window (maximum 367 days)")
    if query.missions is not None and (not query.missions or any(m not in KNOWN for m in query.missions)):
        raise SatelliteError("INVALID_QUERY", "Unknown mission filter")
    return start, stop, bounds


def _read_coords(value: str | None) -> list[list[float]]:
    if not value:
        return []
    ring = []
    try:
        for chunk in value.split():
            lon, lat, *_ = chunk.split(",")
            p = [float(lon), float(lat)]
            if not all(math.isfinite(c) for c in p) or abs(p[0]) > 180 or abs(p[1]) > 90:
                return []
            ring.append(p)
    except ValueError:
        return []
    if len(ring) < 3 or len(ring) > 50000:
        return []
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring


def _point_inside(point: list[float], ring: list[list[float]]) -> bool:
    inside = False
    for a, b in zip(ring[:-1], ring[1:]):
        if (a[1] > point[1]) != (b[1] > point[1]):
            x = a[0] + (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1])
            if point[0] < x:
                inside = not inside
    return inside


def _segment_intersect(a, b, c, d) -> bool:
    def cross(u, v, w):
        return (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0])
    def on(u, v, w):
        return (min(u[0], v[0]) - 1e-9 <= w[0] <= max(u[0], v[0]) + 1e-9 and
                min(u[1], v[1]) - 1e-9 <= w[1] <= max(u[1], v[1]) + 1e-9)
    ab, ab2, cd, cd2 = cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)
    if ((ab > 0 > ab2 or ab < 0 < ab2) and (cd > 0 > cd2 or cd < 0 < cd2)):
        return True
    return (abs(ab) < 1e-9 and on(a, b, c) or abs(ab2) < 1e-9 and on(a, b, d)
            or abs(cd) < 1e-9 and on(c, d, a) or abs(cd2) < 1e-9 and on(c, d, b))


def _intersects(ring: list[list[float]], bbox: list[float]) -> bool:
    w, s, e, n = bbox
    rect = [[w, s], [w, n], [e, n], [e, s]]
    if any(w <= x <= e and s <= y <= n for x, y in ring):
        return True
    if any(_point_inside(corner, ring) for corner in rect):
        return True
    return any(_segment_intersect(a, b, rect[i], rect[(i+1) % 4])
               for a, b in zip(ring[:-1], ring[1:]) for i in range(4))


def parse_esa_plan_kml(kml: str, plan: ESAPlan, bbox: list[float], start: datetime,
                       stop: datetime) -> list[AcquisitionOpportunity]:
    if len(kml) > 20_000_000 or re.search(r"<!DOCTYPE", kml, re.I):
        raise SatelliteError("INVALID_RESPONSE", "ESA KML too large or contains DOCTYPE")
    try:
        root = ET.fromstring(kml)
    except ET.ParseError as exc:
        raise SatelliteError("INVALID_RESPONSE", "Malformed ESA KML: " + str(exc)) from exc
    if root.tag != NS + "kml":
        raise SatelliteError("INVALID_RESPONSE", "Invalid ESA KML root namespace")
    results = []
    seen: set[str] = set()
    for pm in root.iter(NS + "Placemark"):
        if plan.mission.startswith("S2") and "NOMINAL" not in (pm.findtext(NS + "styleUrl") or "").upper():
            continue
        data = {node.get("name", ""): node.findtext(NS + "value")
                for node in pm.findall(".//" + NS + "Data")}
        begin = pm.findtext(".//" + NS + "TimeSpan/" + NS + "begin")
        end = pm.findtext(".//" + NS + "TimeSpan/" + NS + "end")
        try:
            at = _parse_time(data.get("ObservationTimeStart") or begin or "")
        except ValueError:
            continue
        if not start <= at <= stop:
            continue
        polygons = []
        for polygon in pm.findall(".//" + NS + "Polygon"):
            raw = polygon.findtext(NS + "outerBoundaryIs/" + NS + "LinearRing/" + NS + "coordinates")
            ring = _read_coords(raw)
            if ring:
                polygons.append(ring)
        if not polygons or not any(_intersects(ring, bbox) for ring in polygons):
            continue
        ident = data.get("ID") or data.get("DatatakeId") or pm.findtext(NS + "name") or at.isoformat()
        expected_at = at.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        item_id = plan.mission + ":" + ident + ":" + expected_at
        if item_id in seen:
            continue
        seen.add(item_id)
        try:
            finished = _parse_time(data.get("ObservationTimeStop") or end or "")
            end_at = finished.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        except ValueError:
            end_at = None
        try:
            orbit = int(data.get("OrbitRelative", ""))
            if orbit < 0:
                orbit = None
        except (ValueError, TypeError):
            orbit = None
        footprint = ({"type": "Polygon", "coordinates": [polygons[0]]}
                     if len(polygons) == 1 else
                     {"type": "MultiPolygon", "coordinates": [[ring] for ring in polygons]})
        results.append(AcquisitionOpportunity(
            item_id, "esa-sentinel-plans", plan.mission, expected_at, end_at,
            "planned", plan.url, footprint, data.get("Mode") or None, orbit
        ))
    return results


def _http_text(url: str, max_bytes: int, etag: str | None = None,
               last_modified: str | None = None) -> tuple[str, str | None, str | None, bool]:
    headers = {
        "User-Agent": "satellites-images/0.3 (public satellite acquisition plan reader)",
        "Accept": "text/html, application/xml, application/vnd.google-earth.kml+xml",
    }
    # RFC 9110 conditional request: only send validators ESA actually supplied.
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified
    req = Request(url, headers=headers)
    try:
        with _http_opener.open(req, timeout=25) as result:
            if int(result.headers.get("Content-Length", "0") or "0") > max_bytes:
                raise SatelliteError("INVALID_RESPONSE", "ESA document too large")
            body = result.read(max_bytes + 1)
            return (body.decode("utf-8", errors="replace"),
                    result.headers.get("ETag"), result.headers.get("Last-Modified"), False)
    except HTTPError as exc:
        exc.close()
        if exc.code == 304:
            return "", None, None, True
        raise SatelliteError("HTTP_ERROR", "ESA returned HTTP " + str(exc.code)) from exc
    except (URLError, OSError, TimeoutError) as exc:
        raise SatelliteError("NETWORK", "ESA request failed: " + str(exc)) from exc


class ESASentinelPlans:
    id = "esa-sentinel-plans"

    def __init__(self, transport: Callable[[str], str] | None = None,
                 clock: Callable[[], datetime] | None = None,
                 missions: tuple[str, ...] = KNOWN,
                 max_kml_bytes: int = 20_000_000):
        if not missions or any(m not in KNOWN for m in missions):
            raise SatelliteError("INVALID_PROVIDER", "Unknown mission list")
        if max_kml_bytes < 1000 or max_kml_bytes > 50_000_000:
            raise SatelliteError("INVALID_PROVIDER", "Invalid KML size limit")
        self._transport = transport
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self.missions = missions
        self.max_kml_bytes = max_kml_bytes
        self._cache: dict[str, tuple[float, str, str | None, str | None]] = {}
        self._last_fetched: dict[str, float] = {}

    def _load(self, url: str, maximum: int) -> tuple[str, bool]:
        parts = urlsplit(url)
        if parts.scheme != "https" or parts.netloc != "sentinels.copernicus.eu" or (
            url not in INDEXES.values() and not parts.path.startswith("/documents/")
        ):
            raise SatelliteError("INVALID_PROVIDER", "Unexpected ESA URL")
        now = self._clock().timestamp()
        cached = self._cache.get(url)
        if cached and cached[0] > now and len(cached[1]) <= maximum:
            return cached[1], True
        if cached:
            del self._cache[url]
        etag = cached[2] if cached else None
        last_modified = cached[3] if cached else None
        if self._transport is not None:
            value = self._transport(url)
            not_modified = False
            new_etag = new_last_modified = None
        else:
            value, new_etag, new_last_modified, not_modified = _http_text(
                url, maximum, etag, last_modified
            )
        if not_modified:
            if cached is None:
                raise SatelliteError("HTTP_ERROR", "ESA returned HTTP 304 without a cached plan")
            ttl = 900 if url in INDEXES.values() else 3600
            self._cache[url] = (now + ttl, cached[1], cached[2], cached[3])
            return cached[1], True
        if len(value) > maximum:
            raise SatelliteError("INVALID_RESPONSE", "ESA document too large")
        if len(self._cache) >= 12:
            self._cache.pop(next(iter(self._cache)))
        ttl = 900 if url in INDEXES.values() else 3600
        self._cache[url] = (now + ttl, value, new_etag, new_last_modified)
        self._last_fetched[url] = now
        return value, False

    def clear_cache(self) -> None:
        self._cache.clear()
        self._last_fetched.clear()

    def upcoming_with_diagnostics(self, query: AcquisitionQuery) -> ESAUpcomingResult:
        start, end, bounds = _window(query, self._clock)
        missions = set(query.missions or self.missions)
        page_urls = {INDEXES[mission[:2]] for mission in missions}
        plans = [plan for url in sorted(page_urls)
                 for plan in parse_esa_plan_index(self._load(url, MAX_INDEX_CHARS)[0])]
        selected: dict[str, ESAPlan] = {}
        for plan in plans:
            if plan.mission not in missions or _parse_time(plan.ends_at) < start or _parse_time(plan.starts_at) > end:
                continue
            current = selected.get(plan.mission)
            if current is None or (plan.starts_at, plan.ends_at) > (current.starts_at, current.ends_at):
                selected[plan.mission] = plan
        results: list[AcquisitionOpportunity] = []
        diagnostics: list[ESAPlanDiagnostic] = []
        fetched_at: str | None = None
        for plan in selected.values():
            text, from_cache = self._load(plan.url, self.max_kml_bytes)
            fetched = self._last_fetched.get(plan.url)
            if fetched is not None:
                stamp = datetime.fromtimestamp(fetched, tz=timezone.utc)
                if fetched_at is None or stamp > datetime.fromisoformat(fetched_at.replace("Z", "+00:00")):
                    fetched_at = stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")
            diagnostics.append(ESAPlanDiagnostic(plan.mission, plan.url, plan.starts_at,
                                                 plan.ends_at, from_cache))
            results.extend(parse_esa_plan_kml(text, plan, bounds, start, end))
        results.sort(key=lambda o: (o.expected_at, o.mission, o.id))
        status = "ok" if results else ("no-overlap" if selected else "no-current-plan")
        return ESAUpcomingResult(results, fetched_at, diagnostics, status)

    def upcoming(self, query: AcquisitionQuery) -> list[AcquisitionOpportunity]:
        return self.upcoming_with_diagnostics(query).opportunities
