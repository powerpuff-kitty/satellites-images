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
- [x] KML swath/AOI intersection, UTC times, nominal-only S2 filter, strict provider and size checks

## Next (not delivered)

- [ ] Polygon AOI, antimeridian-safe search and improved geodesy
- [ ] Duplicate observation grouping across providers without losing provenance
- [ ] Copernicus STAC authenticated/unauthenticated adapter with tested download handling
- [ ] Calendar heatmap with historical availability by month
- [ ] Optional browser-safe proxy for API keys and provider CORS limits
- [ ] Public releases (npm, PyPI, crates.io) with ownership checks and trusted publishing

## Later

- [ ] USGS, NASA CMR, JAXA, ASF, commercial SkyFi/UP42/Planet/Vantor integrations
- [ ] Orbit prediction independent of officially scheduled acquisitions
- [ ] Scene resolution/coverage scoring and imagery asset-access verification
- [ ] Connection to standalone satellite-diff-map raster comparison and exports
