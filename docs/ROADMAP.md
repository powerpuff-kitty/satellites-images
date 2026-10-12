# Roadmap

## Delivered foundation (0.1–0.2.x)

- [x] Registry covering open and commercial imagery sources with explicit access and adapter status
- [x] JSON contracts for scenes and future acquisition opportunities
- [x] Native Earth Search STAC searches in TypeScript, Python and Rust
- [x] TypeScript configurable Planetary Computer STAC adapter
- [x] Bounded search pagination, coordinate validation and image metadata normalization
- [x] Deterministic fixtures/tests, license, README and CI
- [x] Basic coordinate explorer with historical scene list (not a raster comparison viewer)
- [x] Official ESA Sentinel-1C/1D/2A/2B/2C current acquisition plan adapters in TypeScript, Python and Rust
- [x] KML swath/AOI intersection, UTC times, nominal-only S2 filter, strict provider and size checks (V0.2)
- [x] Polygon AOI, antimeridian-safe search splitting and approximate coverage scoring in all three SDKs
- [x] ESA plan conditional requests (ETag/Last-Modified) and coverage/freshness diagnostics in all three SDKs
- [x] Copernicus Data Space, USGS LandsatLook and NASA CMR-STAC adapters in all three SDKs
- [x] ASF SAR Search API adapter (keyword query, GeoJSON) in all three SDKs
- [x] Historical availability calendar: day/month summaries with provenance and truncation status in all three SDKs, plus explorer calendar, month navigation, mission filter, permalinks and resumable scans
- [x] Browser E2E tests (Playwright) with fully offline fixtures in CI

## Next (not delivered)

- [ ] Duplicate observation grouping across providers without losing provenance
- [ ] Copernicus STAC authenticated download handling and recorded 403/429 contract tests
- [ ] Public releases (npm, PyPI, crates.io) with ownership checks and trusted publishing (workflows staged; not yet run)

## Later

- [ ] JAXA G-Portal (CSW/OpenSearch) and commercial SkyFi/UP42/Planet/Vantor integrations
- [ ] Orbit prediction independent of officially scheduled acquisitions
- [ ] Exact (non-bbox) geometric coverage scoring and imagery asset-access verification
- [ ] Connection to standalone satellite-diff-map raster comparison and exports
