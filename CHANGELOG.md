# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each language package is versioned in lockstep. The npm, PyPI and crates.io
releases share the same version number as the repository tag (`vMAJOR.MINOR.PATCH`).

## [Unreleased]

### Added
- OpenAerialMap adapter (crowdsourced aerial imagery, drone/aircraft) in TypeScript, Python and
  Rust: anonymous `/meta` search with a bbox and a server-side acquisition window
  (`acquisition_from`/`acquisition_to`), `page`/`limit` paging driven by the provider's
  `meta.found`, and each record's `tilejson` exposed as a `tiles` asset so the explorer can
  render it. Records publish no preview thumbnail and the provider's `gsd` is in degrees at
  scales that disagree between records, so `gsdMeters` stays `null` and the raw value is kept.
  Covered by the live smoke test. Not offered in the browser explorer: the API's CORS policy allows only its own origin, so browser use would need a proxy.
- GeoJSON `Polygon`/`MultiPolygon` area-of-interest search with antimeridian-safe
  bounding boxes and coverage scoring across TypeScript, Python and Rust.
- ESA acquisition-plan coverage/freshness diagnostics (`upcomingWithDiagnostics` /
  `upcoming_with_diagnostics`) and HTTP `ETag`/`Last-Modified` conditional requests.
- Copernicus Data Space, USGS LandsatLook and NASA CMR-STAC STAC adapters, and
  Planetary Computer parity, in all three SDKs.
- ASF SAR Search API adapter (keyword query, GeoJSON output) in all three SDKs.
- JAXA G-Portal granule adapter (CSW 3.0.0 GET, GeoJSON) in all three SDKs.
- Opt-in retry/backoff for transient HTTP 429/503 (honouring `Retry-After`) in the
  STAC providers of all three SDKs, with recorded contract tests for 403, 429 and
  expired-signed-URL / metadata-only responses (assets are recorded, never fetched,
  and per-asset `access` stays `unknown`).
- `Scene.access` now reports the access class a provider **declares** for that
  collection (registry-derived, with verified per-collection refinements such as
  "Sentinel-2 L2A is a public bucket", "Landsat C2 L2 is requester-pays",
  "Copernicus/ASF/JAXA downloads need an account") instead of always `unknown`.
  Per-asset `SceneAsset.access` deliberately stays `unknown`: a signed href can be
  anonymous or credential-bound, so no entitlement is inferred from a link.
- Explorer: the Upcoming status line now reports the ESA plan **coverage window** and how
  fresh the plan file is (via `upcomingWithDiagnostics`), and distinguishes "no current
  plan published" from "plans were read but none intersect this area".
- Explorer: the card's **Image access** row now distinguishes *open*, *account required*
  and *payment/entitlement required* instead of showing "not verified" for every scene.
- Explorer: ESA plan requests fail with a bounded 20 s timeout and name the optional proxy
  (the deployed build has none) instead of hanging; the plan-window line also reports when
  a plan was revalidated from the in-memory cache.
- Historical availability summaries (UTC day/month counts with provenance and
  truncation status) in all three SDKs.
- Explorer: availability calendar, month navigation, per-mission filter, shareable
  GPS/date permalinks, resumable five-page scans with a 50-page cap, and published
  scene footprint overlays.
- Playwright browser E2E suite with fully offline fixtures, wired into CI.

### Changed
- Explorer: an auto-selected date whose day holds **no observations** no longer hides the loaded
  results — the pixel is dropped and the year's observations stay listed. Picking an empty day by
  clicking it still shows the deliberate "no observations" state.
- Explorer: removed the `No scenes returned by this catalogue for the selected time window.`
  status line; an empty window now leaves the status area to the other messages.
- README: the feature-matrix table is replaced by a short coverage note. The registry
  (`sources/registry.json`) and `docs/SOURCES.md` remain the source of truth for what each
  catalogue exposes and why the rest are not implemented.
- Explorer: the two date inputs are replaced by a **single date control**. Picking a date loads
  that date's whole calendar year and selects its pixel on the matrix, so the grid always shows a
  year and the chosen day is the active one. The permalink carries `date` (older links with
  `from`/`to` are still read), and the year stepper moves the picked date by a year.
- Explorer: **every day in the loaded window is hoverable and selectable**, including days with no
  observations (previously only days with data were); keyboard arrows step a day at a time,
  selecting an empty day says so in the panel, and a scene restored from a permalink selects its
  own day so the day filter cannot hide the image the link names.
- `SearchQuery` accepts an optional GeoJSON `aoi` in all three SDKs (breaking for
  positional construction in Python/Rust struct literals).
- Rust: `EarthSearch` is now the generic `StacProvider` alias; construct providers
  with `StacProvider::earth_search()` / `copernicus_data_space()` / `usgs_landsat_look()`
  / `cmr_stac()` / `planetary_computer()`. `normalize_stac_item` now takes a bounds argument.
- Antimeridian-crossing searches are split into two bounding boxes instead of being
  rejected; the page budget now applies per box, so a split query can return up to
  two times `maxPages` pages.
- The README screenshot was regenerated from the live catalogues after the explorer changes (and the capture now picks a scene the tile service has already ingested, so the map overlay in the image is real rather than an empty frame).
- Explorer: upgraded to `maplibre-gl` 6. Its ESM build has no default export, so the
  import is now a namespace import, and it loads its worker from a URL it computes at
  runtime — which bundlers do not follow, so the built app requested a path that did not
  exist (the server answered with the SPA HTML) and the worker silently never started.
  The worker is now imported as a build asset and handed to `setWorkerUrl()`; an E2E test
  asserts it is served as JavaScript rather than as the HTML fallback.

### Fixed
- Explorer: a scene with no usable tile set could leave the map **showing a preview caption with
  no image** and a console error. The cause is a cache interaction, not the provider: the result
  cards load the provider preview as a plain `<img>`, caching an opaque (no-CORS) response for
  that URL, so a later CORS fetch of the same URL — MapLibre's own image request included — fails
  from that cache with a misleading "No 'Access-Control-Allow-Origin' header" error, even though
  the file returns `Access-Control-Allow-Origin: *`. The app now fetches the bytes itself with
  `cache: "reload"` and hands MapLibre an object URL; when the bytes cannot be fetched at all,
  the preview no longer opens and the status line says why. Object URLs are revoked when the
  preview changes or closes. This is the common case for a scene published in the last day or
  two, before Planetary Computer has ingested it.
- Explorer: the day matrix **covered the basemap attribution**. MapLibre renders the compact
  attribution expanded on wide maps, and the centred panel spans that corner, so the required
  `OpenFreeMap` / `OpenStreetMap` credits were hidden and unclickable. The attribution control
  is now placed at the top-right below the zoom control, and an E2E test asserts it does not
  intersect the matrix and stays inside the map pane.
- Explorer: the full-year **day matrix overflowed the map pane** at ordinary widths (fixed
  12 px cells made 53 weeks ~689 px inside a ~630 px pane), so the last weeks — including
  the December label — were clipped behind a horizontal scrollbar. Cells now shrink from
  12 px to a 6 px floor to fit the loaded range, the pane is re-fitted on resize, and the
  year stepper's 38 px is reserved so it no longer overlaps the neighbouring column.
- Browser builds could not call the default `fetch` (called as an instance method,
  causing `Illegal invocation`); the transport is now bound correctly.
- Explorer now reports partial results after a mid-scan source failure instead of
  overwriting the error with a normal status line, and a stale search can no longer
  clobber a newer search's status.
- Invalid AOI geometry raises a typed error in every SDK (previously a raw `TypeError`
  in TypeScript, and a malformed `MultiPolygon` was silently accepted in Rust).
- NASA CMR provider ids are validated consistently across SDKs.
- A `304 Not Modified` received without a cached body is now an explicit error rather
  than an empty result (Python).
- Declared Rust MSRV raised to 1.82 to match the `Option::is_none_or` API in use.

### Security
- Provider requests now refuse cross-origin HTTP redirects (TypeScript `redirect:"error"`,
  Python final-URL check, Rust no-redirect policy) so the same-origin pagination guard
  cannot be bypassed; the Rust ESA document allowlist now pins the port.
- TypeScript caps STAC page `features` (10 000) and validates the KML 2.2 namespace before
  parsing; the explorer validates planned-acquisition links before rendering them.
- Bumped the declared `fast-xml-parser` range to `^5.11.2`, switched CI installs to
  `npm ci`, and stopped packaging the crate with `--allow-dirty`.
- Bounded retries: `retries`/`retryBaseDelayMs` are validated, `Retry-After` is capped
  at 60 s, and TypeScript backoff is abortable (new `ABORTED` error code).
- Added response size ceilings and per-adapter feature caps (STAC/ASF/JAXA) in all three
  SDKs; malformed JSON now raises a typed error (Rust was mapping it to `Network`).
- Cross-box truncation is now reported correctly for split antimeridian/pole searches.
- Strengthened the TypeScript ESA KML check to require the KML 2.2 namespace on the root
  element; Python redirect checks are now scheme-aware; Rust ESA diagnostics are ordered
  deterministically; CMR providers are namespaced (`nasa-cmr:<provider>`) so multiple
  scopes can coexist; JAXA `count` is validated; `Invalid baseUrl` is a typed error.
- Pinned all GitHub Actions to commit SHAs, added Dependabot, and moved the npm publish
  workflow to OIDC trusted publishing (no long-lived token).
- Malformed provider items are now skipped (with a `skipped` count on `SearchPage`)
  instead of failing their whole page, in all three SDKs.
- The aggregator accepts any `SearchProvider` (TypeScript interface / Python Protocol),
  so ASF and JAXA adapters can be registered alongside STAC providers; Rust remains
  per-provider (documented).
- JSON contracts corrected and extended: `scene.schema.json` now matches emitted fields,
  `searchpage.schema.json`/`availability.schema.json` added, the Rust asset field
  serializes as `type`, and the TypeScript suite validates output against the schemas.
- ASF/JAXA providers honour the caller's `signal` (TypeScript); provider redirects are
  documented as fail-closed; the dev Vite proxy mirrors the production allowlist.
- Rust gains a cross-provider `SatelliteCatalog` (`Stac`/`Asf`/`Jaxa`) with `search`,
  `search_pages` and resilient `availability`; documented that Python/Rust still
  serialize snake_case (see `specs/README.md`).
- Added an opt-in live smoke script (`tools/smoke/live.mjs`) — verified reachable
  against Earth Search, Copernicus, USGS LandsatLook, CMR-STAC, ASF, JAXA G-Portal and
  ESA plans (no redirect failures).
- camelCase JSON contract now available in every SDK: Rust serializes its structs in
  camelCase (`serde(rename_all = "camelCase")`) and Python exposes `to_json`/`to_camel`.
- Explorer: published observations moved to a scrollable right-hand panel with a sticky
  header; added an observation **timeline** (per-day bars stacked by cloud cover), a
  **full-screen image preview** on click, image error handling, and removed the eyebrow;
  scene `gsdMeters` is exposed by the SDK.
- Explorer: added **search-window steppers** (◀ earlier / later ▶) to move the whole
  query window one period back/forward in time (one bounded, cancellable query per step).
- Explorer: added client-side **filters** for collection, cloud-cover range, hour range,
  resolution and has-preview (plus an include-unknown-cloud toggle and reset), applied to
  results, timeline and calendar counts without new queries.
- Explorer: the timelines are now **all shown stacked** on one shared date axis — daily
  bars by **cloud cover**, **mission** and **provider**, plus a **time-of-day** heatmap —
  replacing the earlier View/Split selectors.
- Explorer: clicking a timeline bar now **selects** the clicked day (it no longer
  deselects), zooms the map to that day's footprints, and the redundant "pagination
  exhausted" status line was removed.
- Explorer: UI glyphs replaced with bundled **Font Awesome** icons, and the left-column
  top spacing reduced.
- Explorer: **month-at-a-time** model — removed the range preset and the window
  steppers; navigation is per month via the month controls above the calendar (one
  bounded query per month), and the default range is a single month.
- Explorer: removed the **Find observations** button — the search now runs
  automatically when the location is chosen on the map or any query field changes.
- Explorer: the left column now has **Historical** and **Upcoming** tabs with distinct
  controls; the right panel switches with the tab, and Upcoming adds **by-mission** and
  **time-of-day** charts for planned datatakes.
- Explorer: Upcoming charts extended with a **published-so-far vs planned overlay**,
  **by acquisition mode**, **by relative orbit**, and a per-mission **datatake-window
  (Gantt)** strip. Optional plan fields bucket to *unknown* instead of being dropped.
- Explorer: removed the footnote caveat paragraph (source link kept) and moved the
  timeline date labels **below** the axis line.
- Explorer: timeline bars are a fixed **4 px wide** inside a **horizontally scrollable**
  pane; dropped the calendar "N published items… / Empty cells…" status line.
- Explorer: the search window is now the **full calendar year**, fetched in a **single
  request**; the month arrows move within the loaded year and fetch the next year when you
  step past its edge (results append instead of resetting).
- Explorer: clicking a scene **preview overlays the image on the map** (georeferenced via
  its footprint) so it pans/zooms with the map; **‹ / ›** arrows step through the loaded
  images. Replaces the full-screen lightbox.
- Explorer: the stacked **timelines are replaced** by a GitHub-style **day matrix** at the
  bottom of the map — one **12×12 px** cell per day across the loaded year (including future
  days), each with a hover tooltip, with small links to switch the metric (observations /
  cloud / mission / provider).
- Explorer: a search now loads every provider page **up front** (in five-page batches, up to
  the page safety cap) instead of stopping after one batch.
- Explorer: day-matrix **empty days render a placeholder** cell (dimmer outside the loaded
  window) so the grid has no gaps, and the metric links sit on **one horizontal row**.
- Explorer: day-matrix cells are **12×12 px**; the form now defaults to the **full current
  calendar year** (Jan 1 – Dec 31) and the calendar opens on the current month.
- Explorer: the day-matrix container now **fits the grid** (shrink-to-fit, capped to the map
  width), is **centred** in the map, and its metric links are **left-aligned**.
- Explorer: clicking a day-matrix cell selects the day **without changing the map zoom**;
  the zoom is stored in the URL (`zoom`) and restored from it, and the URL updates on every
  map move.
- Explorer: opening a scene image **no longer moves the camera**, and previews now use the
  best the source publishes — a provider **rendered tile set** (Planetary Computer
  `tilejson`, full resolution) when present, otherwise the largest **displayable** preview
  asset instead of the thumbnail.
- Explorer: the day matrix gained a vertical **‹ / › year stepper** to its left (outside the
  panel) that shifts the whole window one year; icon-only buttons **centre their glyph** and
  are **square** (no pill corners).
- Explorer: the day matrix no longer disappears when a year returns no observations — it
  always draws the window's grid (placeholder cells), and switches to the new year's grid
  immediately when the window moves.
- Explorer: the **Catalog** input is gone — Earth Search and Planetary Computer are queried
  **together** and the same scene from both is merged on display into one row.
- Explorer: removed the **Browse month** control and the UTC **day calendar** (day selection
  now happens on the day matrix, which marks the selected cell); the matrix gained a **month
  legend** under the grid, each label starting at the week column its month begins in, and padding days outside the window no longer paint a dark block.
- Explorer: the source-code link sits at the **bottom** of the left panel and its divider is
  removed.
- Explorer: the active day-matrix cell is **outlined**, and clicking it again **deselects**
  (back to every loaded scene).
- Explorer: scenes whose footprint does not contain the searched point are **always hidden**
  (a bbox query also returns radar/SAR tiles that merely intersect the radius), so the map
  overlay always covers the location. The matrix header pairs the metric links with
  right-aligned **quick filters** (**All / Image / Radar**) and a **··· More** menu holding
  extra metrics (**Resolution, Sensor, Time of day, Orbit**).
- Explorer: scene cards now show the **STAC scene id** and the acquisition time **to the
  second**, so two genuinely different scenes that overlap one location (e.g. Landsat
  adjacent rows acquired seconds apart) are distinguishable instead of looking like a
  duplicate.
- Explorer: cross-catalogue duplicates now merge properly — the key is collection + platform +
  UTC day + a 0.5°-snapped footprint, because the two catalogues disagree on the timestamp
  (seconds for Landsat, ~25 minutes for the same Sentinel-2 tile) and on the footprint by a
  rounding-sized amount. Different tiles of one overpass stay separate (verified live:
  47 items → 27, every merged group exactly two, no over-merge).
- Explorer: roomier result cards (`20px × 12px` padding) inside a tighter right-hand panel
  (10px horizontal, 16px bottom), with a slimmer sticky header.
- Explorer: the matrix **⋯ More** control now lines up vertically with the metric links (its
  wrapper no longer adds line-box height); E2E asserts all five share one centre.
- Explorer: selecting a **day cell no longer draws a scene footprint** — the outline appears
  only with the image on the map and clears when the overlay closes.
- Explorer: the location now **loads on start** (the form already holds one) instead of
  waiting for a click or a permalink, and the image on the map is stored in the permalink as
  **`scene=<id>`** so a refresh restores the overlay, its footprint and the highlighted card.
- Explorer: the scene card's **Show scene footprint** button is gone — the footprint is drawn
  on the map together with the image and cleared when the overlay closes. The preview **‹ / ›**
  arrows now step only through the **filtered/visible** observations, not every loaded scene.
- Explorer: the date range is **clamped** to data that can exist (`1970-01-01` … today + 1 year)
  and the grid renders at most ~2 years of it, so an extreme selection like 1900→2100 can no
  longer build ~147k SVG nodes.
- Explorer: three more filters — **Catalogue** (which provider returned the scene), **Orbit**
  (ascending/descending from `sat:orbit_state`) and **Native-resolution tiles only**.
- Explorer: the Upcoming tab's **Days ahead** select is gone — the plan query now uses the same
  horizon as the loaded range (now → the range end, up to a year), and the SDKs allow an
  upcoming window of up to 366 days (previously capped at 31, which a widened day bound did
  not actually honour — fixed with a regression test).
- Explorer: on the **Upcoming** tab the scene-oriented controls (metric links, ··· menu, quick
  filters) are hidden, and empty results now explain themselves — an empty state in the plans
  list, and a note when scenes were dropped because their footprint does not cover the
  location.
- Explorer: a **coverage rollup** (from the availability summary) reports observations shown,
  days with data, months, and a per-catalogue split, marking catalogues that still have more
  pages.
- SDKs (TS/Python/Rust): **fix polygon AOI search** — the STAC request sent `bbox` *and*
  `intersects` together, which the public APIs reject with HTTP 400, so every drawn-area
  search returned nothing. It now sends `intersects` alone (and one request rather than one
  per split box).
- Explorer: clicking a different location (or typing coordinates) while an area is drawn
  **clears the area** and searches that point, and the point-coverage rule is skipped for
  area searches (the query already restricts results to the polygon).
- Tools: the live smoke test now covers **Planetary Computer** (including NAIP and Sentinel-1
  RTC at a US location); the explorer has an opt-in live Playwright check (`LIVE=1`) that
  runs a real search and a drawn-area search.
- Explorer: **draw an area on the map** — "Draw area", click three or more corners, "Finish
  area" searches that polygon through the SDK's `aoi` path (the SDK handles box splitting and
  the antimeridian); "Use a point + radius" clears it. The polygon is rendered on the map and
  round-trips through the `aoi` permalink parameter.
- Explorer: the **full view state is now in the URL** — `tab`, `metric`, `sensor`, the active
  filters (`mission`, `collection`, `cloudmin`/`cloudmax`, `hmin`/`hmax`, `maxgsd`, `preview`,
  `unknown`) and `src` (extra catalogues) round-trip through the permalink.
- Explorer: scene cards show **resolution** and **AOI coverage**; planned datatakes show
  **status** and their **datatake window**. The "select any location" prompt hides once a
  location is chosen.
- Explorer: new **Data sources** panel built from the registry (`listSources()`) — every
  catalogue with its search/imagery access terms, SDK support and docs, plus opt-in extra
  catalogues (**Copernicus Data Space**, **ASF Vertex** radar, **NASA CMR-STAC (ASF)**,
  **JAXA G-Portal** ALOS — the latter two using the ids the repo's live smoke test verifies)
  queried alongside the defaults.
- Explorer: the day matrix always spans the loaded range so **its size never changes**; the
  data behind it follows the active tab (published on Historical, planned on Upcoming), and
  it is cleared on a failed plan lookup so it never shows the other tab's data.
- Explorer: day-matrix cells are **keyboard operable** — focus a day, arrow keys step between
  days with observations, Enter/Space selects — restoring the access the removed calendar had.
- SDKs: the Planetary Computer provider now also queries **`sentinel-1-rtc`** (radar) and
  **`naip`** (0.6 m aerial, US) alongside Sentinel-2 and Landsat, so radar and house-scale
  imagery can be searched and rendered (Planetary Computer exposes CORS tile sets for both).
  In Rust the collections live on the query, so callers opt in per search.
- SDKs (TS/Python/Rust): **Landsat previews now resolve** — `previewUrl` prefers an http(s)
  preview asset and falls back to the STAC item's **`thumbnail` link**, which Earth Search
  serves for Landsat (whose asset hrefs are `s3://` requester-pays). The explorer likewise
  ignores non-http(s) assets, so Landsat-9 images appear.
- Explorer: **Landsat now renders on the map** — Earth Search's Landsat browse cannot be
  loaded by a cross-origin WebGL overlay (`s3://` plus a non-CORS S3 redirect), so the map
  overlay uses the CORS-enabled **Planetary Computer** render of the same item id, and
  prefers its **tile set** (native resolution) over the whole-scene PNG.

- Explorer: removed the dead calendar code left over from the day-matrix replacement
  (`renderDayCalendar`, `renderMonthStrip`, `asMonthLabel`, the weekday/day-cell/month-pill
  CSS and the unused import) and refreshed the architecture/roadmap notes that still
  described the removed calendar.

## [0.2.0] - 2026-10-12

### Added
- Official ESA Sentinel-1C/1D and Sentinel-2A/2B/2C acquisition-plan adapters in
  TypeScript, Python and Rust (KML swath parsing, nominal-only S2 filter, UTC times).
- Bounded per-provider index/KML caching (15 min / 60 min; max 12 URLs).
- Browser explorer: upcoming planned acquisitions with swath overlays, restricted
  Vite proxy and an optional Cloudflare Worker proxy.
- Manual GitHub Pages deployment workflow for the explorer.

### Changed
- Version aligned to 0.2.0 across npm, PyPI and Cargo workspaces.

## [0.1.0] - 2026-10-11

### Added
- Initial cross-language STAC discovery SDK (TypeScript, Python, Rust).
- Earth Search and Microsoft Planetary Computer adapters.
- Bounded pagination, coordinate validation and scene normalization.
- Versioned provider registry, JSON contracts, deterministic fixtures and CI.
