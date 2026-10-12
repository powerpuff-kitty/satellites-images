# Satellite imagery explorer

Static MapLibre demonstration of the TypeScript SDK.

```sh
npm install
npm run generate:registry
npm run build -w @powerpuff-kitty/satellites-images
npm run dev -w @satellites-images/explorer
```

Click the map or type decimal GPS coordinates; choose radius, dates and one supported
STAC provider. The explorer then:

- builds an **availability calendar** from the actual UTC acquisition timestamps of the
  scenes found in the loaded pages, with a month picker, per-day counts and a mission filter;
- **resumable pagination**: an initial five-page scan, a "Scan 5 more pages" control and a
  50-page safety cap. Stale in-flight searches cannot overwrite a newer location, and a
  mid-scan provider failure keeps the partial results and reports the error explicitly;
- shows the selected observation footprint on the map, visually distinct from the amber
  dashed future ESA planned swaths;
- writes a **shareable GPS/radius/provider/date/day permalink** and restores it (including a
  preselected day) on load.

The **upcoming planned acquisitions** section queries ESA's latest Sentinel-1/2 KML plans
and outlines matching swaths, without claiming image publication. All published results are
real remote catalogue responses; a search covers only the loaded pages and does not claim an
exhaustive historical archive. Actual raster images are **not** drawn on the map.

## Browser E2E tests

```sh
npm run test:e2e -w @satellites-images/explorer
```

Playwright drives the built app with **every** catalogue, map-style and ESA response
intercepted by deterministic fixtures — no live provider is called and no credentials are used.
The suite covers coordinate entry, month navigation, day cells and filtering, resumable scans,
mid-scan source failures, permalink restore, external image failure, keyboard access and a
responsive viewport.

## Upcoming ESA plans and CORS

When running with `npm run dev -w @satellites-images/explorer`, Vite proxies official ESA KML/HTML through `/esa-proxy`, so local development can load planned acquisitions with no ESA credentials.

For a static production build, configure `VITE_ESA_PROXY_URL` to a deployment of `apps/plans-proxy` (a narrowly restricted public-source Cloudflare Worker); do not deploy a generic URL proxy. If no proxy is configured, the app attempts ESA direct requests but browser CORS may block them.

Uses MapLibre's public demonstration tile style, which is not a production map-tile SLA. The Worker is intentionally **not deployed by this repository**. Check ESA's site availability and terms before public deployment. This app does not guarantee future acquisitions or published images.
