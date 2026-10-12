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
- JAXA G-Portal granule adapter (CSW 3.0.0 GET, GeoJSON) in all three SDKs.
- Opt-in retry/backoff for transient HTTP 429/503 (honouring `Retry-After`) in the
  STAC providers of all three SDKs, with recorded contract tests for 403, 429 and
  expired-signed-URL / metadata-only responses (assets are recorded, never fetched,
  and `access` stays `unknown`).
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

### Security
- Provider requests now refuse cross-origin HTTP redirects (TypeScript `redirect:"error"`,
  Python final-URL check, Rust no-redirect policy) so the same-origin pagination guard
  cannot be bypassed; the Rust ESA document allowlist now pins the port.
- TypeScript caps STAC page `features` (10 000) and validates the KML 2.2 namespace before
  parsing; the explorer validates planned-acquisition links before rendering them.
- Bumped the declared `fast-xml-parser` range to `^5.11.2`, switched CI installs to
  `npm ci`, and stopped packaging the crate with `--allow-dirty`.
- Bounded retries: `retries`/`retryBaseDelayMs` are validated, `Retry-After` is capped
  at 60 s, and TypeScript backoff is abortable (new `ABORTED` error code).
- Added response size ceilings and per-adapter feature caps (STAC/ASF/JAXA) in all three
  SDKs; malformed JSON now raises a typed error (Rust was mapping it to `Network`).
- Cross-box truncation is now reported correctly for split antimeridian/pole searches.
- Strengthened the TypeScript ESA KML check to require the KML 2.2 namespace on the root
  element; Python redirect checks are now scheme-aware; Rust ESA diagnostics are ordered
  deterministically; CMR providers are namespaced (`nasa-cmr:<provider>`) so multiple
  scopes can coexist; JAXA `count` is validated; `Invalid baseUrl` is a typed error.
- Pinned all GitHub Actions to commit SHAs, added Dependabot, and moved the npm publish
  workflow to OIDC trusted publishing (no long-lived token).
- Malformed provider items are now skipped (with a `skipped` count on `SearchPage`)
  instead of failing their whole page, in all three SDKs.
- The aggregator accepts any `SearchProvider` (TypeScript interface / Python Protocol),
  so ASF and JAXA adapters can be registered alongside STAC providers; Rust remains
  per-provider (documented).
- JSON contracts corrected and extended: `scene.schema.json` now matches emitted fields,
  `searchpage.schema.json`/`availability.schema.json` added, the Rust asset field
  serializes as `type`, and the TypeScript suite validates output against the schemas.
- ASF/JAXA providers honour the caller's `signal` (TypeScript); provider redirects are
  documented as fail-closed; the dev Vite proxy mirrors the production allowlist.
- Rust gains a cross-provider `SatelliteCatalog` (`Stac`/`Asf`/`Jaxa`) with `search`,
  `search_pages` and resilient `availability`; documented that Python/Rust still
  serialize snake_case (see `specs/README.md`).
- Added an opt-in live smoke script (`tools/smoke/live.mjs`) — verified reachable
  against Earth Search, Copernicus, USGS LandsatLook, CMR-STAC, ASF, JAXA G-Portal and
  ESA plans (no redirect failures).
- camelCase JSON contract now available in every SDK: Rust serializes its structs in
  camelCase (`serde(rename_all = "camelCase")`) and Python exposes `to_json`/`to_camel`.
- Explorer: published observations moved to a scrollable right-hand panel with a sticky
  header; added an observation **timeline** (per-day bars stacked by cloud cover), a
  **full-screen image preview** on click, image error handling, and removed the eyebrow;
  scene `gsdMeters` is exposed by the SDK.
- Explorer: added **search-window steppers** (◀ earlier / later ▶) to move the whole
  query window one period back/forward in time (one bounded, cancellable query per step).

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
