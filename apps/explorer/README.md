# Satellite imagery explorer

Minimal, static MapLibre demonstration of the TypeScript SDK.

```sh
npm install
npm run generate:registry
npm run build -w @powerpuff-kitty/satellites-images
npm run dev -w @satellites-images/explorer
```

Click the map or type decimal GPS coordinates; choose radius, dates and one supported STAC provider; then browse actual historical scene metadata and available previews. The **upcoming planned acquisitions** section queries ESA's latest Sentinel-1/2 KML plans and outlines matching swaths, without claiming image publication. All results are real remote catalogue responses, not mock satellite images. A search is limited to 2 pages × 30 items by default and does not claim an exhaustive historical archive. Actual raster images are **not** drawn on the map in this first release; comparison, future plans and automatic satellite scheduling remain roadmap items.

Uses MapLibre's public demonstration tile style, which is not a production map-tile SLA. If a catalogue denies browser CORS, use a permissioned backend/proxy rather than putting API secrets into web code.

## Upcoming ESA plans and CORS

When running with `npm run dev -w @satellites-images/explorer`, Vite proxies official ESA KML/HTML through `/esa-proxy`, so local development can load planned acquisitions with no ESA credentials.

For a static production build, configure `VITE_ESA_PROXY_URL` to a deployment of `apps/plans-proxy` (a narrowly restricted public-source Cloudflare Worker); do not deploy a generic URL proxy. If no proxy is configured, the app attempts ESA direct requests but browser CORS may block them.

The Worker is intentionally **not deployed by this repository**. Check ESA's site availability and terms before public deployment. This app does not guarantee future acquisitions or published images.
