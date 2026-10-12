"""UTC observation availability summary for bounded, actual STAC search results.

A day with zero returned items is *not* proof the provider has no imagery.
Completeness means only that the searched provider pagination was exhausted.
"""
from __future__ import annotations
from dataclasses import dataclass
from collections import defaultdict
from typing import Iterable

from .catalog import Scene, SearchPage, SatelliteError


@dataclass(frozen=True)
class AvailabilityDay:
    date: str
    count: int
    missions: dict[str, int]
    collections: dict[str, int]


@dataclass(frozen=True)
class AvailabilityMonth:
    month: str
    count: int
    days_with_observations: int
    missions: dict[str, int]


@dataclass(frozen=True)
class ProviderAvailability:
    id: str
    pages_scanned: int
    raw_items: int
    unique_items: int
    matched: int | None
    has_more: bool


@dataclass(frozen=True)
class AvailabilitySummary:
    days: tuple[AvailabilityDay, ...]
    months: tuple[AvailabilityMonth, ...]
    providers: tuple[ProviderAvailability, ...]
    pages_scanned: int
    raw_items: int
    unique_items: int
    complete: bool
    truncated_providers: tuple[str, ...]
    errored_providers: tuple[str, ...]


class AvailabilityAccumulator:
    """Streaming counter that retains no raster data or extra copies of scenes."""
    def __init__(self):
        self._seen: set[tuple[str, str, str]] = set()
        self._days: dict[str, dict] = {}
        self._months: dict[str, dict] = {}
        self._providers: dict[str, dict] = {}
        self._errors: set[str] = set()
        self._page_count = 0
        self._raw = 0

    def mark_error(self, provider_id: str) -> None:
        """Record that a provider's scan failed part-way; partial counts are retained."""
        if provider_id:
            self._errors.add(provider_id)

    def add_page(self, page: SearchPage) -> list[Scene]:
        if not page.provider_id or page.page_number < 1:
            raise SatelliteError("INVALID_RESPONSE", "Invalid availability page identity")
        provider = self._providers.setdefault(page.provider_id, {
            "pages_scanned": 0, "raw_items": 0, "unique_items": 0,
            "matched": None, "has_more": False,
        })
        provider["pages_scanned"] += 1
        provider["raw_items"] += len(page.items)
        provider["has_more"] = page.has_next
        if type(page.matched) is int and page.matched >= 0:
            provider["matched"] = page.matched
        self._page_count += 1
        self._raw += len(page.items)
        novel = []
        for scene in page.items:
            key = (page.provider_id, scene.collection, scene.id)
            if key in self._seen:
                continue
            self._seen.add(key)
            novel.append(scene)
            provider["unique_items"] += 1
            date = scene.acquired_at[:10]
            if len(date) != 10 or date[4] != "-" or date[7] != "-":
                raise SatelliteError("INVALID_RESPONSE", "Invalid normalized UTC acquisition date")
            month = date[:7]
            mission = scene.mission or "unknown"
            collection = scene.collection or "unknown"
            day = self._days.setdefault(date, {
                "count": 0, "missions": defaultdict(int), "collections": defaultdict(int),
            })
            day["count"] += 1
            day["missions"][mission] += 1
            day["collections"][collection] += 1
            monthly = self._months.setdefault(month, {
                "count": 0, "missions": defaultdict(int), "days": set(),
            })
            monthly["count"] += 1
            monthly["days"].add(date)
            monthly["missions"][mission] += 1
        return novel

    def summary(self) -> AvailabilitySummary:
        providers = tuple(
            ProviderAvailability(id=key, **self._providers[key])
            for key in sorted(self._providers)
        )
        truncated = tuple(p.id for p in providers if p.has_more)
        days = tuple(
            AvailabilityDay(
                date=date, count=value["count"],
                missions=dict(sorted(value["missions"].items())),
                collections=dict(sorted(value["collections"].items())),
            )
            for date, value in sorted(self._days.items())
        )
        months = tuple(
            AvailabilityMonth(
                month=month, count=value["count"],
                days_with_observations=len(value["days"]),
                missions=dict(sorted(value["missions"].items())),
            )
            for month, value in sorted(self._months.items())
        )
        return AvailabilitySummary(
            days=days, months=months, providers=providers,
            pages_scanned=self._page_count, raw_items=self._raw,
            unique_items=len(self._seen),
            complete=bool(providers) and not truncated,
            truncated_providers=truncated,
            errored_providers=tuple(sorted(self._errors)),
        )


def summarize_availability(pages: Iterable[SearchPage]) -> AvailabilitySummary:
    accumulator = AvailabilityAccumulator()
    for page in pages:
        accumulator.add_page(page)
    return accumulator.summary()
