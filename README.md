# satellites-images

[![CI](https://github.com/powerpuff-kitty/satellites-images/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/powerpuff-kitty/satellites-images/actions/workflows/ci.yml)
[![Publish Explorer](https://github.com/powerpuff-kitty/satellites-images/actions/workflows/publish-explorer.yml/badge.svg?branch=main&event=workflow_dispatch)](https://github.com/powerpuff-kitty/satellites-images/actions/workflows/publish-explorer.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Live explorer](https://img.shields.io/badge/explorer-live-4fbf7a)](https://powerpuff-kitty.github.io/satellites-images/)

A cross-language, open-source satellite **catalogue discovery SDK**. Search existing imagery and inspect available assets, access conditions, and provider capabilities by location and date.

**Status:** pre-release V0.3. TypeScript, Python and Rust packages are source implementations; **none are published to npm, PyPI or crates.io yet**.

## Live explorer

**[powerpuff-kitty.github.io/satellites-images](https://powerpuff-kitty.github.io/satellites-images/)**

The MapLibre explorer, built from `main` and deployed to GitHub Pages. Deployment is a
**manually dispatched, reviewed** build (`npm run check` runs first), not every push.

![The explorer for a point off Sumbawa with a 2026 window: a left panel for location, month and filters; a MapLibre map with a Landsat scene placed on its footprint, a marker and a day matrix of 12x12 px cells labelled by month with metric links and All/Image/Radar quick filters; and a right panel of result cards listing scene id, collection, cloud cover, resolution and coverage](docs/assets/explorer.jpg)

That screenshot is captured from the live public catalogues (no fixtures) — see
"Refresh the README screenshot" in [AGENTS.md](AGENTS.md).

## What it does

- Search real historical satellite observations from public STAC catalogues.
- Normalize acquisition timestamps, footprints, preview links, band assets, and provider provenance.
- List a curated registry of open, account-gated and commercial providers, including providers **not yet implemented**.
- Explicitly distinguish `published` imagery from `planned` acquisitions and `predicted` passes. Official ESA Sentinel-1C/1D/2A/2B/2C planned swath queries are implemented. Orbital prediction is not.
- Search by centre/radius **or** a GeoJSON `Polygon`/`MultiPolygon`; antimeridian-crossing areas are split rather than rejected, and each scene reports an approximate `coveragePercent`.
- Bound searches by date, area, number of result pages and providers; preserve raw provider metadata.
- Summarize historical STAC search results into UTC month/day availability counts, with explicit complete/partial pagination signals.
- Browse historical observations by day and satellite in a map explorer, with resumable page loading and shareable GPS/date URLs.

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
const history = await catalog.availability({
  latitude:-8.5833,longitude:116.1167,radiusMeters:5000,
  from:"2025-01-01",to:"2025-01-31",maxPages:10
});
console.log(history.days, history.complete, history.truncatedProviders);
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
history = catalog.availability(SearchQuery(
    latitude=-8.5833, longitude=116.1167, radius_meters=5000,
    start="2025-01-01", end="2025-01-31", max_pages=10,
))
print(history.days, history.complete, history.truncated_providers)
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
let historical = provider.availability(&SearchQuery::new(
    -8.5833,116.1167,5000.0,"2025-01-01","2025-01-31"
)?).await?;
println!("{} observed dates, complete: {}", historical.days.len(), historical.complete);
# Ok(())
# }
```

## Planned vs published

Upcoming acquisition queries use current ESA KML plans, intersecting approximate swath polygons with the coordinate search area. They only include ESA-listed **planned** datatakes, not actual published products, guaranteed future images or cloud predictions. Only Sentinel-2 nominal observations are returned. Browser deployments may require a narrowly scoped proxy due to ESA's CORS policy.

## Sources and scope

Read [sources/registry.json](sources/registry.json) and [docs/SOURCES.md](docs/SOURCES.md). The registry distinguishes *documented service capability* from *implemented adapter*. Earth Search, Microsoft Planetary Computer, Copernicus Data Space, USGS LandsatLook and NASA CMR-STAC are supported by the shared STAC adapter in all three language packages; the ASF SAR (keyword) and JAXA G-Portal (CSW granule) APIs use bespoke adapters in all three. ESA official future plan discovery is supported by all three language packages, now with conditional caching and coverage/freshness diagnostics. All provider-specific authentication and image-usage terms remain the user's responsibility.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for data contracts, pagination, limitations and future plans.

## Explorer deployment

Deployed to GitHub Pages at <https://powerpuff-kitty.github.io/satellites-images/> by the
manual-only `publish-explorer.yml` workflow. It never auto-publishes on push: a human
dispatches it, the job runs `npm run check`, and only then is `apps/explorer/dist` uploaded.
See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the optional `VITE_ESA_PROXY_URL` input
(without it the Upcoming tab reports that ESA plans need the proxy, because the ESA index
sends no CORS headers).

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
