# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each language package is versioned in lockstep. The npm, PyPI and crates.io
releases share the same version number as the repository tag (`vMAJOR.MINOR.PATCH`).

## [Unreleased]

### Added
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
  and `access` stays `unknown`).
- Historical availability summaries (UTC day/month counts with provenance and
  truncation status) in all three SDKs.
- Explorer: availability calendar, month navigation, per-mission filter, shareable
  GPS/date permalinks, resumable five-page scans with a 50-page cap, and published
  scene footprint overlays.
- Playwright browser E2E suite with fully offline fixtures, wired into CI.

### Changed
- `SearchQuery` accepts an optional GeoJSON `aoi` in all three SDKs (breaking for
  positional construction in Python/Rust struct literals).
- Rust: `EarthSearch` is now the generic `StacProvider` alias; construct providers
  with `StacProvider::earth_search()` / `copernicus_data_space()` / `usgs_landsat_look()`
  / `cmr_stac()` / `planetary_computer()`. `normalize_stac_item` now takes a bounds argument.
- Antimeridian-crossing searches are split into two bounding boxes instead of being
  rejected; the page budget now applies per box, so a split query can return up to
  two times `maxPages` pages.

### Fixed
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
- Explorer: new **Data sources** panel built from the registry (`listSources()`) — every
  catalogue with its search/imagery access terms, SDK support and docs, plus opt-in extra
  catalogues (**Copernicus Data Space**, **ASF Vertex** radar) queried alongside the defaults.
- Explorer: the day matrix **follows the active tab** — the historical range on Historical,
  the forecast window on Upcoming — and is cleared on a failed plan lookup, so it never shows
  the other tab's data.
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
