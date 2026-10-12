# satellites-images

A cross-language, open-source satellite **catalogue discovery SDK**. Search existing imagery and inspect available assets, access conditions, and provider capabilities by location and date.

**Status:** pre-release V0.2. TypeScript, Python and Rust packages are source implementations; **none are published to npm, PyPI or crates.io yet**.

## What it does

- Search real historical satellite observations from public STAC catalogues.
- Normalize acquisition timestamps, footprints, preview links, band assets, and provider provenance.
- List a curated registry of open, account-gated and commercial providers, including providers **not yet implemented**.
- Explicitly distinguish `published` imagery from `planned` acquisitions and `predicted` passes. Official ESA Sentinel-1C/1D/2A/2B/2C planned swath queries are implemented. Orbital prediction is not.
- Search by centre/radius **or** a GeoJSON `Polygon`/`MultiPolygon`; antimeridian-crossing areas are split rather than rejected, and each scene reports an approximate `coveragePercent`.
- Bound searches by date, area, number of result pages and providers; preserve raw provider metadata.

This package does **not** process pixels, guarantee coverage, promise free downloads, price commercial imagery, or list every image ever taken.

## Packages

| Ecosystem | Local package | Install for development |
| --- | --- | --- |
| npm | `packages/typescript` | `npm install && npm run check` |
| PyPI | `packages/python` | `python -m pip install -e packages/python` |
| Cargo | `crates/satellites-images` | `cargo test --manifest-path crates/satellites-images/Cargo.toml` |

Proposed (unreserved) distribution names: `@powerpuff-kitty/satellites-images`, `satellites-images` (PyPI), and `satellites-images` (crates.io). Do not use the package-install commands from a registry until published.

## Quick start

TypeScript:

```ts
import { SatelliteCatalog, earthSearch, esaSentinelPlans } from "@powerpuff-kitty/satellites-images";

const catalog = new SatelliteCatalog([earthSearch()], [esaSentinelPlans()]);
for await (const page of catalog.search({
  latitude: -8.5833, longitude: 116.1167, radiusMeters: 5000,
  from: "2025-01-01", to: "2025-02-01", maxPages: 2,
})) {
  console.log(page.providerId, page.items.map((item) => [item.id, item.acquiredAt]));
}
const planned = await catalog.upcoming({ latitude: -8.5833, longitude: 116.1167,
  radiusMeters: 5000, days: 14 });
console.log(planned);
```

Python:

```py
from satellites_images import SatelliteCatalog, EarthSearch, SearchQuery, ESASentinelPlans, AcquisitionQuery
catalog = SatelliteCatalog([EarthSearch()], acquisition_providers=[ESASentinelPlans()])
for page in catalog.search(SearchQuery(latitude=-8.5833, longitude=116.1167,
                                       radius_meters=5000, start="2025-01-01",
                                       end="2025-02-01", max_pages=2)):
    print(page.provider_id, len(page.items))
print(catalog.upcoming(AcquisitionQuery(-8.5833, 116.1167, 5000, days=14)))
```

Rust:

```rust
use satellites_images::{EarthSearch, SearchQuery, ESAPlansProvider, AcquisitionQuery};

# async fn run() -> Result<(), satellites_images::Error> {
let provider = EarthSearch::default();
let query = SearchQuery::new(-8.5833, 116.1167, 5000.0, "2025-01-01", "2025-02-01")?;
let scenes = provider.search(&query).await?;
println!("{} scenes", scenes.len());
let query = AcquisitionQuery::new(-8.5833, 116.1167, 5000.0, 14)?;
let planned = ESAPlansProvider::default().upcoming(&query).await?;
println!("{} planned datatakes", planned.len());
# Ok(())
# }
```

## Planned vs published

Upcoming acquisition queries use current ESA KML plans, intersecting approximate swath polygons with the coordinate search area. They only include ESA-listed **planned** datatakes, not actual published products, guaranteed future images or cloud predictions. Only Sentinel-2 nominal observations are returned. Browser deployments may require a narrowly scoped proxy due to ESA's CORS policy.

## Sources and scope

Read [sources/registry.json](sources/registry.json) and [docs/SOURCES.md](docs/SOURCES.md). The registry distinguishes *documented service capability* from *implemented adapter*. Earth Search, Microsoft Planetary Computer, Copernicus Data Space, USGS LandsatLook and NASA CMR-STAC are supported by the shared STAC adapter in all three language packages; the ASF SAR Search API uses a keyword adapter in all three. ESA official future plan discovery is supported by all three language packages, now with conditional caching and coverage/freshness diagnostics. All provider-specific authentication and image-usage terms remain the user's responsibility.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for data contracts, pagination, limitations and future plans.

## Explorer deployment

A manual-only GitHub Pages workflow is available. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). It does not auto-publish. The expected public URL is not considered live until the workflow is explicitly run and succeeds.

## Development and quality

```sh
npm install
npm run check
npm run test:e2e
python -m unittest discover -s packages/python/tests -v
cargo test --manifest-path crates/satellites-images/Cargo.toml
```

Tests use deterministic local fixtures and do **not** depend on external APIs. The browser
E2E suite (`npm run test:e2e`) intercepts all catalogue and map responses offline. Live API
smoke checks are opt-in; catalogue availability, data age and rate limits are not guaranteed.

This project is not affiliated with satellite operators. Library code is MIT-licensed; source imagery and metadata are subject to each provider's separate terms.
