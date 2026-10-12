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

## Tabs

The left column has two tabs: **Historical** (published STAC scenes — location, month,
calendar and filters) and **Upcoming** (planned ESA Sentinel-1/2 acquisitions — location,
days-ahead and mission). Location and radius are shared. The **right panel switches with
the tab**: Historical shows the published-scene cards and the stacked timelines;
Upcoming shows the planned-datatake cards plus its own charts — a **published-so-far vs
planned** overlay, per-day counts **by mission** and **by acquisition mode** and **by
relative orbit**, a **datatake-window** strip (Gantt, per mission), and a **time-of-day**
heatmap. Charts that key on optional plan fields (`mode`, `orbitRelative`, `endAt`) bucket
missing values as *unknown* rather than dropping rows. Searching is automatic (no button) — it runs on location select or any query change.

## Upcoming ESA plans and CORS

When running with `npm run dev -w @satellites-images/explorer`, Vite proxies official ESA KML/HTML through `/esa-proxy`, so local development can load planned acquisitions with no ESA credentials.

For a static production build, configure `VITE_ESA_PROXY_URL` to a deployment of `apps/plans-proxy` (a narrowly restricted public-source Cloudflare Worker); do not deploy a generic URL proxy. If no proxy is configured, the app attempts ESA direct requests but browser CORS may block them.

The Worker is intentionally **not deployed by this repository**. Check ESA's site availability and terms before public deployment. This app does not guarantee future acquisitions or published images.

## Historical availability calendar (V0.3)

1. Choose a point on the map or enter latitude/longitude.
2. Choose a STAC catalogue and date range; the search runs automatically (the explorer fetches on any input change and when you pick a location on the map — there is no search button).
3. Browse the UTC month/date calendar (numbers show unique scenes **in the loaded results**).
4. Filter to a satellite platform, click a day to display its observation cards, and optionally display a scene footprint on the map.
5. Use the previous/next month arrows to move the calendar; stepping past the loaded year
   fetches the next three-month chunk. Searches load their whole window up front, so the
   **Load next 5 catalogue pages** button only appears if a scan was cut short.
6. Copy the browser URL to share the selected coordinates, provider, period and selected calendar day.

The explorer loads **one year at a time** (the last twelve months by default), fetched as
**four three-month chunks**. A search loads its **whole window up front** — every provider
page, in five-page batches, up to a 50-page safety cap — so the day matrix covers the full
year without manual paging. If the cap is reached, the UI says **partial**, and zero-count
dates are not proof that no imagery exists. Changing the location/dates starts a new search.

The calendar is a catalogue discovery view, not an imagery renderer or scientific comparison engine. A separately hosted source may be temporarily unavailable even if previous searches succeeded.

## Filters and the day matrix

Client-side filters over the **loaded** results (instant, no new queries): **satellite**,
**collection**, **cloud-cover range** (≥ / ≤), **hour range** (UTC from/to), **resolution**
(≤10/20/30 m, when the provider exposes `gsd`), **has preview**, an **include
unknown-cloud scenes** toggle, and a **Reset** button. Filters drive the result cards, the
day matrix and the calendar counts; the counter shows `filtered / total`.

The **day matrix** at the bottom of the map is a GitHub-style grid of **8×8 px** cells — one
per day across the loaded year (columns = weeks, rows = weekdays). Days with no observations
still render a **placeholder** cell (dimmer for padding days outside the loaded window), so
the grid has no gaps. Small links on one horizontal row above it choose the metric: **Observations** (shade by daily count), **Cloud** (best cloud class of
the day: green &lt;10%, amber &lt;60%, grey ≥60%, dark = unknown), **Mission** or
**Provider** (colour by the day's dominant value). Click a cell to select that day. The grid
**scrolls horizontally** when a year is wider than the map. Cloud cover is scene-wide
metadata, not per-AOI.

## Layout

Published observations live in an independent, scrollable **right-hand panel** (the left
controls and the map stay accessible). Its header is **sticky** and holds the result
counter and status; the loaded observations are summarised by the **day matrix** at the
bottom of the map (see above). Clicking a scene **preview image overlays it on the map**
so you can pan/zoom with the map; the **‹ / ›** arrows step through the loaded images and
**Esc** closes the overlay. The explorer loads **one year at a time** (twelve months) in
**three-month chunks**: use the **month navigation above the calendar** (← / → and the month
field) to move the visible month; stepping past the edge of what's loaded fetches the next
three-month chunk and appends it. Cloud cover is scene-wide metadata, not per-AOI.
