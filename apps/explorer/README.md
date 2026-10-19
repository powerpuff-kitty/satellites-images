# Satellite imagery explorer

Minimal, static MapLibre demonstration of the TypeScript SDK.

```sh
npm install
npm run generate:registry
npm run build -w @powerpuff-kitty/satellites-images
npm run dev -w @satellites-images/explorer
```

Click the map or type decimal GPS coordinates; choose radius, dates and one supported STAC provider; then browse actual historical scene metadata and available previews. The **upcoming planned acquisitions** section queries ESA's latest Sentinel-1/2 KML plans and outlines matching swaths, without claiming image publication. All results are real remote catalogue responses, not mock satellite images. A search scans bounded catalogue pages (five at a time, up to a 50-page limit) and does not claim an exhaustive historical archive. Available public tile sets and explicitly aligned images can be drawn on the map; scientific comparison and automatic satellite scheduling remain roadmap items.

Uses **OpenFreeMap**'s keyless, open-source "Liberty" vector style by default (OpenStreetMap data); set `VITE_MAP_STYLE_URL` to use VersaTiles, a self-hosted Protomaps/PMTiles style, or another provider. No API key is bundled.

MapLibre is the map renderer; OpenFreeMap supplies the default basemap tiles.
The optional OpenFreeMap name is omitted from the map attribution, as permitted
by its [attribution guidance](https://openfreemap.org/#attribution). Required
OpenMapTiles/OpenStreetMap credits remain in a plain footer below the map, with no
floating attribution badge. Custom-provider credits use the same footer.

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

1. The app **loads the location on start** — the form already holds one, so no click is
   needed. Then choose a different point on the map or enter latitude/longitude — or press
   **Draw area**, click three
   or more corners and **Finish area** to search that polygon instead.
2. Choose a date range; the search runs automatically (the explorer fetches on any input change and when you pick a location on the map — there is no search button).
3. Read the **day matrix** under the map (a cell per day); click a cell to filter to that day.
4. Filter to a satellite platform or day to display its observation cards; open a card's public preview; georeferenced tiles appear on the map, while unaligned quicklooks appear beside the footprint.
5. Use the **‹ / › year stepper** beside the matrix to move the window a year at a time. Searches load their whole window up front, so the
   **Load next 5 catalogue pages** button only appears if a scan was cut short.
6. Copy the browser URL to share the state: `lat`/`lon` (search point), `radius`,
   `from`/`to` (period), `day` (selected day), `zoom` (map zoom), `tab`, `metric`, `sensor`,
   the active filters (`satellites` for public/commercial satellite inclusion, `mission`, `collection`, `cloudmin`/`cloudmax`, `hmin`/`hmax`,
   `maxgsd`, `preview`, `unknown`), `src` (extra catalogues), `aoi` (a drawn area) and `scene`
   (the image currently on the map, so a refresh restores it) — the URL updates on every map
   move and when an image is opened or closed.

The explorer loads **one year at a time** (the current calendar year by default), queried from
**Earth Search and Planetary Computer together** — one request per catalogue for the whole
window; proven copies are grouped by collection/product identity, including Sentinel-2's
shared product URI, with catalogue provenance retained. Dates and approximate footprints
alone do not collapse acquisitions. Different tiles of one overpass stay separate. Earth Search covers
Sentinel-2 L2A and Landsat C2 L2; Planetary Computer adds **Sentinel-1 RTC** radar (~10 m,
grayscale backscatter, no cloud cover) and **NAIP** aerial imagery (**0.6 m**, US). A search loads every provider page (in five-page
batches, up to a 50-page safety cap) so the day matrix covers the full year without manual
paging. If the cap is reached, the UI says **partial**, and zero-count dates are not proof
that no imagery exists. Changing the location/dates starts a new search.

The calendar is a catalogue discovery view with public previews; it is not a scientific comparison engine. A separately hosted source may be temporarily unavailable even if previous searches succeeded.

Under **Data sources**, opt into **INPE CBERS-4A (Brazil)** to search the fused visual
collection. Platform, resolution and cloud fields absent from its items stay unknown.
The **Additional satellites** switches beside the date also enable INPE or ASF,
stay synchronized with Data sources and persist in shared URLs. The satellite
dropdown filters loaded observations, so an enabled mission only appears when
the catalogue returns matching records for the location and year.
The **ASF** option includes **Sentinel-1, NISAR and ALOS-2**; NISAR/ALOS-2 records are
classified as radar even when their processing-level names omit the mission. Full ASF
result caps remain partial. The [source review](../../docs/FREE_SOURCES_REVIEW.md)
records live checks and explains which additional providers need adapters or layer support.

## Filters and the day matrix

Client-side filters over the **loaded** results (instant, no new queries): **satellite**,
**collection**, **cloud-cover range** (≥ / ≤), **hour range** (UTC from/to), **resolution**
(≤10/20/30 m, when the provider exposes `gsd`), **has preview**, an **include
unknown-cloud scenes** toggle, and a **Reset** button. Filters drive the result cards, the
day matrix and the calendar counts; the counter shows `filtered / total`.

The **day matrix** at the bottom of the map always spans the loaded range, so **its size never
changes**, while the data behind it follows the active tab — published scenes on
**Historical**, planned datatakes on **Upcoming** — and it never shows the other tab's data.
Upcoming asks for the same horizon as the loaded range (now → the range end, capped at a year;
ESA publishes only a rolling horizon of roughly a month).
The metric links and quick filters describe published scenes, so they are hidden on Upcoming.
If a search returns nothing, the panel says why: an explicit empty state for the plans list,
and a note when scenes were hidden because their footprint does not cover the location. It is a GitHub-style grid of **12×12 px** cells — one
per day across the loaded year (columns = weeks, rows = weekdays). Days with no observations
still render a **placeholder** cell (dimmer for padding days outside the loaded window), so
the grid has no gaps. A **‹ / ›** stepper to the left of the panel (arrows stacked) loads the
previous/next **year**, and a **month legend** sits under the grid. Small links on one
horizontal row above it choose the metric (**··· More** adds Resolution, Sensor, Time of day
and Orbit), and **right-aligned quick filters** (**All / Image / Radar**) narrow the view to
optical or SAR scenes. Scenes whose footprint does **not** contain the searched point are
always hidden, so the map overlay always covers your location: **Observations** (shade by daily count), **Cloud** (best cloud class of
the day: green &lt;10%, amber &lt;60%, grey ≥60%, dark = unknown), **Mission** or
**Provider** (colour by the day's dominant value). Click a cell to select that day (this filters the cards; it does not draw a footprint —
the outline is shown only with an image on the map). The grid
**scrolls horizontally** when a year is wider than the map. Cloud cover is scene-wide
metadata, not per-AOI.

The "select any location" prompt disappears once a location is chosen, and scene cards show
**resolution** and **AOI coverage**, while planned datatakes show their **status** and
**datatake window**.

Filters cover satellite, collection, catalogue (which provider returned it), cloud range,
hour range, resolution, orbit direction, native-resolution tiles, has-preview and
unknown-cloud, and commercial-satellite inclusion; the date range is clamped to `1970-01-01` … today + 1 year.

Scene cards show the **STAC scene id** and the acquisition time **to the second** — two
genuinely different scenes can overlap one location (Landsat adjacent rows are acquired
seconds apart), and those details are what tell them apart.

A **coverage** line under the filters summarises the loaded result set from the availability
summary: observations shown, days with data, months, and a per-catalogue split (a trailing `+`
marks a catalogue that still advertises more pages).

The end-to-end suite is fully mocked: a context route intercepts all external requests,
and missing fixtures fail the test without reaching the network. Live checks use the
standard Playwright fixtures and require `LIVE=1`. For a real check run
`LIVE=1 npm run test:e2e -w @satellites-images/explorer -- --grep "live search"` (it performs
a live point search and a live drawn-area search and prints the coverage rollup), and
`node tools/smoke/live.mjs` for provider-level reachability.

The **Satellite type** filter can exclude recognized commercial satellites or show
only those returned by the connected public catalogues. It persists in shared links
and closes an excluded observation's preview. Full paid-archive search requires a
provider account. Maxar scanning was removed after full-year checks found no browser
preview URLs, including in a known release. See [evidence](../../docs/PUBLIC_PREVIEWS.md).

A **Data sources** panel at the bottom of the left column lists every catalogue the SDK
knows — from the registry (`listSources()`): what it searches, how imagery is accessed, which
SDKs implement it, and a docs link. Extra catalogues (**Copernicus Data Space**, **ASF Vertex** radar, **NASA CMR-STAC (ASF)**,
**JAXA G-Portal** ALOS) are opt-in there and are queried in addition to Earth Search and
Planetary Computer. A failed catalogue retains its earlier results, reports incomplete
coverage, and lets the other configured catalogues finish.

## Layout

Published observations live in an independent, scrollable **right-hand panel** (the left
controls and the map stay accessible). Its header is **sticky** and holds the result
counter and status; the loaded observations are summarised by the **day matrix** at the
bottom of the map (see above). **View public preview** opens advertised imagery, with
**‹ / ›** navigation and **Esc** to close. Opening a preview leaves the camera unchanged.
Provider tile sets appear on the map. Still images require explicit WGS84 image bounds
and a north-up transform to be placed there; unaligned quicklooks appear in a separate
panel beside the footprint. Image or tile failures have visible recovery states.

Copernicus can discover an exact Sentinel-2 product's public OData quicklook on demand
when its STAC preview is absent or fails. Earth Search can use advertised Planetary
Computer render assets from a verified product match. GeoTIFF/JP2 assets are not image
URLs, and another acquisition is not substituted just because it has a similar time.

**Paid imagery maps** links open SkyFi or UP42 in a new tab. Copy the current location,
dates and drawn area for their search using **Copy location and dates**. Accounts and
purchases remain with the provider. See [public preview routes, safeguards and live
observations](../../docs/PUBLIC_PREVIEWS.md).

The explorer loads **one calendar year at a time**, following catalogue pages in five-page
batches up to its 50-page safety limit. Pick a date or use the year arrows above the
matrix to load another year. Cloud cover is scene-wide metadata, not per-AOI.

The production build separates MapLibre from application code for independent caching
and uses seven local SVG icons instead of an icon font. The MapLibre worker remains an
explicit asset. The icons are from Font Awesome Free by Fonticons, Inc., under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); attribution is shipped in
`public/THIRD_PARTY_NOTICES.txt` and `public/icons.svg`.
