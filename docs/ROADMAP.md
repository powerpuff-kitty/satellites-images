# Roadmap

## Delivered foundation (0.1–0.3.x)

- [x] Registry covering open and commercial imagery sources with explicit access and adapter status
- [x] JSON contracts for scenes and future acquisition opportunities
- [x] Native Earth Search STAC searches in TypeScript, Python and Rust
- [x] TypeScript configurable Planetary Computer STAC adapter
- [x] Bounded search pagination, coordinate validation and image metadata normalization
- [x] Deterministic fixtures/tests, license, README and CI
- [x] Basic coordinate explorer with historical scene list (not a raster comparison viewer)
- [x] Official ESA Sentinel-1C/1D/2A/2B/2C current acquisition plan adapters in TypeScript, Python and Rust
- [x] KML swath/AOI intersection, UTC times, nominal-only S2 filter, strict provider and size checks (V0.2)
- [x] Native UTC monthly/daily availability aggregates and explicit truncated/complete semantics in TS, Python, Rust
- [x] Polygon AOI, antimeridian-safe search splitting and approximate coverage scoring in all three SDKs
- [x] ESA plan conditional requests (ETag/Last-Modified) and coverage/freshness diagnostics in all three SDKs
- [x] Copernicus Data Space, USGS LandsatLook and NASA CMR-STAC adapters in all three SDKs
- [x] ASF SAR Search API adapter (keyword query, GeoJSON) in all three SDKs
- [x] JAXA G-Portal granule adapter (CSW 3.0.0 GET, GeoJSON) in all three SDKs
- [x] Day-matrix date selection with per-day and per-satellite filtering, scene footprint overlay and shareable links
- [x] Resumable bounded historical catalogue paging (5-page batches; 50-page safety limit), and cancellation of stale searches
- [x] Correct STAC POST next-link merge defaults across all three SDKs
- [x] Browser E2E tests (Playwright) with fully offline fixtures in CI

## Next (not delivered)

- [ ] Duplicate observation grouping across providers without losing provenance
- [ ] Copernicus STAC authenticated download handling
- [ ] Shared cross-language conformance fixtures for availability JSON serialization and unknown sources
- [ ] Provider-specific pagination and summary optimization for multi-year queries
- [ ] Optional browser-safe proxy for API keys and provider CORS limits
- [ ] Public releases (npm, PyPI, crates.io) with ownership checks and trusted publishing (workflows staged; not yet run)

## Later

- [ ] Commercial SkyFi/UP42/Planet/Vantor integrations — blocked on owner-supplied, entitled credentials; no secrets in browser builds. EUMETSAT Data Store needs a registered account. NASA GIBS (rendered tiles) and NOAA GOES (object listings) are imagery services rather than scene catalogues, so the scene-search adapter model does not apply to them.
- [ ] Orbit prediction independent of officially scheduled acquisitions
- [ ] Exact (non-bbox) geometric coverage scoring and imagery asset-access verification
- [ ] Connection to standalone satellite-diff-map raster comparison and exports
