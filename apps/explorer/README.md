# Satellite imagery explorer

Minimal, static MapLibre demonstration of the TypeScript SDK.

```sh
npm install
npm run generate:registry
npm run build -w @powerpuff-kitty/satellites-images
npm run dev -w @satellites-images/explorer
```

Click the map or type decimal GPS coordinates; choose radius, dates and one supported STAC provider; then browse actual historical scene metadata and available previews. The **upcoming planned acquisitions** section queries ESA's latest Sentinel-1/2 KML plans and outlines matching swaths, without claiming image publication. All results are real remote catalogue responses, not mock satellite images. A search scans bounded catalogue pages (five at a time, up to a 50-page limit) and does not claim an exhaustive historical archive. Actual raster images are **not** drawn on the map; comparison and automatic satellite scheduling remain roadmap items.

Uses **OpenFreeMap**'s keyless, open-source "Liberty" vector style by default (OpenStreetMap data); set `VITE_MAP_STYLE_URL` to use VersaTiles, a self-hosted Protomaps/PMTiles style, or another provider. No API key is bundled.

## Upcoming ESA plans and CORS

When running with `npm run dev -w @satellites-images/explorer`, Vite proxies official ESA KML/HTML through `/esa-proxy`, so local development can load planned acquisitions with no ESA credentials.

For a static production build, configure `VITE_ESA_PROXY_URL` to a deployment of `apps/plans-proxy` (a narrowly restricted public-source Cloudflare Worker); do not deploy a generic URL proxy. If no proxy is configured, the app attempts ESA direct requests but browser CORS may block them.

The Worker is intentionally **not deployed by this repository**. Check ESA's site availability and terms before public deployment. This app does not guarantee future acquisitions or published images.

## Historical availability calendar (V0.3)

1. Choose a point on the map or enter latitude/longitude.
2. Choose a STAC catalogue and date range, then **Find observations**.
3. Browse the UTC month/date calendar (numbers show unique scenes **in the loaded results**).
4. Filter to a satellite platform, click a day to display its observation cards, and optionally display a scene footprint on the map.
5. Choose the previous/next month to search that month, or press **Load next 5 catalogue pages** to continue the original search without restarting it.
6. Copy the browser URL to share the selected coordinates, provider, period and selected calendar day.

An initial search scans up to five pages of 75 items each, and can continue in further five-page batches until all provider pages are exhausted or a 50-page maximum is reached. If more pages are still advertised, the UI says **partial**, and zero-count dates are not proof that no imagery exists. Changing the location/dates requires a new search.

The calendar is a catalogue discovery view, not an imagery renderer or scientific comparison engine. A separately hosted source may be temporarily unavailable even if previous searches succeeded.
