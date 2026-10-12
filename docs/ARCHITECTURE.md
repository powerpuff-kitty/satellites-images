# Architecture and guarantees

## Design

Three native language packages implement a small common scene-discovery contract and official ESA Sentinel-1/-2 KML acquisition plan parsing. No satellite orbit prediction or raster processing is shipped yet. All packages are usable independently and search directly against an external public STAC API.

- TypeScript: browser/Node/Worker fetch transport and ESM library. Earth Search and Planetary Computer providers.
- Python: standard-library urllib transport; Earth Search first.
- Rust: serde + reqwest async transport; Earth Search first.
- Shared: a versioned registry, normalized response schemas and a recorded synthetic STAC fixture.

The *registry* is the canonical source of provider metadata. Run `npm run generate:registry` to copy it into package-local resources. The generator is deterministic and CI checks the outputs are committed.

## Semantics

- A scene is a **published** STAC item. `acquiredAt` is sourced from `properties.datetime` (or fallback start datetime), never from indexing time.
- Assets are references. The presence of `href` never guarantees download permission.
- Future `planned` / `predicted` acquisition opportunities have separate contracts. V0.2 returns actual ESA `planned` KML swaths where supported, never fabricated orbital `predicted` passes. Configure the ESA plan adapter explicitly and use its independent upcoming query.
- The same physical observation can appear through multiple providers. Do not de-duplicate by approximate timestamps; preserve provider-native item identity.
- Cloud cover is scene metadata, not guaranteed AOI cloud coverage.
- Search is bounded and returns provider pages. A provider outage raises a typed failure rather than an empty success.
- AOI radius is approximated as a geographic bbox for the first release. Antimeridian-crossing and pole-containing searches are rejected rather than silently truncated. Full polygon support is planned.
- STAC `next` links may specify HTTP GET or POST and JSON bodies; follow only same-origin HTTPS links for production endpoints to avoid SSRF and credential exfiltration.

## Not included

Pixel downloads/reprojection, NDVI analysis, paywall purchases, predicted orbital passes, account management and an always-on tile backend are future work. A production use should add request throttling, durable caching and a provider-specific backoff policy.

## Package compatibility

Cross-language APIs follow their host-language conventions rather than trying to marshal Python/Rust through JavaScript. Shared JSON examples and schemas define the on-wire semantics. Tests are deterministic and never bill a commercial API.

## Official future plans (V0.2)

- Sentinel-1C/-1D and Sentinel-2A/-2B/-2C acquisition indices are sourced from ESA's current public plan pages, using official KML links.
- One current (most recently starting) relevant plan is selected per satellite to prevent duplicates across superseded plans; this is a current-plan query, not a complete archive.
- Parses `ObservationTimeStart`, `ObservationTimeStop`, swath polygon and optional relative orbit. ESA timestamps lacking a timezone are interpreted as UTC.
- Only Sentinel-2 `NOMINAL` style datatakes are included; calibration/VIC/non-user acquisitions are excluded. It does not guarantee actual image products or optical cloud-free observations.
- An upcoming query is anchored to the actual current UTC time and limited to 31 days; older dates aren't mislabeled future.
- Per-datatake footprints are matched to a bounded rectangle around user GPS coordinates with polygon/edge intersection, not simply the centroid of a swath.
- Each item includes the original plan URL and `status=planned`; no `status=published` image is generated from planning data.
- KML/HTML responses have size ceilings, timeouts and allowlisted ESA hosts; provider outages raise errors.
- ESA pages may not allow browser CORS. Run the SDK from Node/Python/Rust or use the optional narrowly scoped Cloudflare Worker. The browser explorer uses a Vite development proxy locally, with configurable Cloudflare proxy for production.

Reference: https://sentinels.copernicus.eu/copernicus-operations/mission-planning

### ESA request caching

The ESA plan adapters now keep a bounded in-memory cache per provider instance: index pages for 15 minutes and official KML files for 60 minutes (at most 12 URLs). Cached content preserves official source URLs; cache hits do not imply that an old plan remains valid. Every query filters observations against the current UTC time and each file's own coverage window. All SDKs expose a `clearCache` / `clear_cache` method. Cache misses and provider errors remain explicit; for always-on public services, use a shared cache and source-health monitoring as additional layers.

## Historical observation availability (V0.3)

- All three SDKs now provide a `summarizeAvailability` / `summarize_availability` or Rust `summarize_availability` utility and convenience historical `availability()` method. The TypeScript `AvailabilityAccumulator` also supports incremental pages.
- Days use the observation's **UTC acquisition date**; months aggregate actual scene counts and `daysWithObservations` / `days_with_observations`.
- Counts are of unique STAC item identities within each provider, collection and native item ID. Items returned by multiple providers are **not** silently fused into a single observation; cross-provider physical deduplication requires stronger identity evidence.
- `complete=true` means all next links provided by the queried catalogue(s) were exhausted within the search. It does *not* guarantee that any catalogue indexes every satellite scene in the world.
- If the maximum page count is reached and another `next` link exists, `complete=false` and `truncatedProviders` identifies the affected provider. A missing day in partial results must not be presented as certain non-availability.
- STAC Item Search pagination `merge` defaults to `false`: the explicit `body` in a next link replaces the previous POST body unless `merge=true`. We test both forms. See https://docs.ogc.org/cs/25-005/25-005.html
- The browser explorer scans an initial batch of 5 pages (75 scenes/page) and retains the async iterator for additional 5-page batches up to the SDK's 50-page hard limit, rather than requerying already scanned pages.
- The calendar supports month navigation (which issues a narrowed month search), selection of UTC observation dates and filtering by the STAC `platform` field where present. Results/footprints and counts update together.
- URL links restore validated coordinates, radius, provider, dates and optionally the selected day. Only actual returned scene metadata is shown; scene previews are loaded from provider-provided URLs.
- Browser searches are cancelable between user interactions, and an abandoned search cannot overwrite the currently selected location's results.
- The scene assets retain `access=unknown` until source-specific permission/entitlement verification is implemented.

**Bounds:** A public provider may throttle or omit results; long intervals can contain far more scenes than 50 pages. The UI must say when searches are partial and recommend narrower time windows. No image raster values, prices or orbital predictions are generated by the calendar.
