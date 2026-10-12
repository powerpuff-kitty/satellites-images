# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each language package is versioned in lockstep. The npm, PyPI and crates.io
releases share the same version number as the repository tag (`vMAJOR.MINOR.PATCH`).

## [Unreleased]

### Added
- GeoJSON `Polygon`/`MultiPolygon` area-of-interest search with antimeridian-safe
  bounding boxes and coverage scoring across TypeScript, Python and Rust.
- ESA acquisition-plan coverage/freshness diagnostics (`upcomingWithDiagnostics` /
  `upcoming_with_diagnostics`) and HTTP `ETag`/`Last-Modified` conditional requests.
- Copernicus Data Space, USGS LandsatLook and NASA CMR-STAC STAC adapters, and
  Planetary Computer parity, in all three SDKs.
- ASF SAR Search API adapter (keyword query, GeoJSON output) in all three SDKs.
- Historical availability summaries (UTC day/month counts with provenance and
  truncation status) in all three SDKs.
- Explorer: availability calendar, month navigation, per-mission filter, shareable
  GPS/date permalinks, resumable five-page scans with a 50-page cap, and published
  scene footprint overlays.
- Playwright browser E2E suite with fully offline fixtures, wired into CI.

### Changed
- `SearchQuery` accepts an optional GeoJSON `aoi` in all three SDKs (breaking for
  positional construction in Python/Rust struct literals).
- Rust: `EarthSearch` is now the generic `StacProvider` alias; construct providers
  with `StacProvider::earth_search()` / `copernicus_data_space()` / `usgs_landsat_look()`
  / `cmr_stac()` / `planetary_computer()`. `normalize_stac_item` now takes a bounds argument.
- Antimeridian-crossing searches are split into two bounding boxes instead of being
  rejected; the page budget now applies per box, so a split query can return up to
  two times `maxPages` pages.

### Fixed
- Browser builds could not call the default `fetch` (called as an instance method,
  causing `Illegal invocation`); the transport is now bound correctly.
- Explorer now reports partial results after a mid-scan source failure instead of
  overwriting the error with a normal status line, and a stale search can no longer
  clobber a newer search's status.
- Invalid AOI geometry raises a typed error in every SDK (previously a raw `TypeError`
  in TypeScript, and a malformed `MultiPolygon` was silently accepted in Rust).
- NASA CMR provider ids are validated consistently across SDKs.
- A `304 Not Modified` received without a cached body is now an explicit error rather
  than an empty result (Python).
- Declared Rust MSRV raised to 1.82 to match the `Option::is_none_or` API in use.

## [0.2.0] - 2026-10-12

### Added
- Official ESA Sentinel-1C/1D and Sentinel-2A/2B/2C acquisition-plan adapters in
  TypeScript, Python and Rust (KML swath parsing, nominal-only S2 filter, UTC times).
- Bounded per-provider index/KML caching (15 min / 60 min; max 12 URLs).
- Browser explorer: upcoming planned acquisitions with swath overlays, restricted
  Vite proxy and an optional Cloudflare Worker proxy.
- Manual GitHub Pages deployment workflow for the explorer.

### Changed
- Version aligned to 0.2.0 across npm, PyPI and Cargo workspaces.

## [0.1.0] - 2026-10-11

### Added
- Initial cross-language STAC discovery SDK (TypeScript, Python, Rust).
- Earth Search and Microsoft Planetary Computer adapters.
- Bounded pagination, coordinate validation and scene normalization.
- Versioned provider registry, JSON contracts, deterministic fixtures and CI.
