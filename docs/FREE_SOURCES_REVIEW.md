# Free-data source review — 16 October 2026

Reviewed all **25 distinct source/product entries** in the supplied
`free-satellite-data-and-imagery.md`. The reproducible run made **53 anonymous HTTP
probes**, recorded in [the JSON evidence](../tools/smoke/results/source-review-2026-10-16.json).
The original document remains unchanged.

## Result for the observations list

- **Added INPE CBERS-4A** to all three SDKs and the explorer's opt-in **Data sources**.
  Its live STAC API supports the existing geographic/date query contract.
- **Extended the explorer's existing ASF option** to request Sentinel-1, **NISAR and
  ALOS-2**. These use the existing SDK platform selector; SDK defaults stay unchanged.
  NISAR and ALOS-2 are classified as radar using their platform as well as collection.
- **Registered Wyvern, Capella and Umbra as unimplemented candidates.** Each exposes
  public static STAC scenes. Integration is feasible, but needs bounded traversal or
  an index, native-ID deduplication and honest completeness reporting. Pointing the
  ordinary STAC adapter at these roots would incorrectly request `/search`.
- The other entries are already partly covered, need account/product-specific work,
  or belong in weather, terrain or mosaic layers. They were not enabled as scenes.

## What each test established

All observations below are dated **2026-10-16**. HTTP 200 for a website establishes
reachability only. It does **not** establish a working granule query, account access,
coverage at an arbitrary point, or permission to redistribute imagery. The JSON
records the exact URLs, requests, response types, CORS headers and sampled metadata.

| Source in supplied list | Actual live result | Integration disposition |
| --- | --- | --- |
| CBERS-4A / INPE | Collection, item listing, geographic/date POST, next page and OPTIONS returned 200 with wildcard API CORS. Search returned 2 then 1 items, total matched 3. Indonesia control returned 0. PNG HEAD 200, without a CORS header. | **Added**, opt-in; Brazil-focused fused visual product. |
| SPOT World Heritage | Official CNES landing page 200. No scene-search API tested. | Candidate custom adapter; authenticate/access-test the actual catalogue, preserve original L1A geometry limitations. |
| Wyvern | Root → year → collection → dated scene all 200 with wildcard CORS; preview HEAD 200. Sample Dragonette-001 GSD 5.26 m, 2024-05-06. | **Registered candidate**; static traversal/index needed, selected scenes only. |
| SpaceNet 2 | Anonymous S3 listing 200 with TIFF object keys in the Las Vegas dataset prefix. No scene or spatial search tested. | Fixed benchmark dataset; needs an explicit per-tile metadata index and provenance before scene-list integration. |
| CORONA / USGS | Anonymous M2M dataset-search POST returned **403**, HTML. | **Not verified** for anonymous integration. This does not establish that EarthExplorer browsing or existing scans are unavailable. |
| Umbra | Root → year → month → day → scene all 200 with wildcard CORS. Sample dated 2025-06-22 with SAR geometry and CC-BY-4.0 property; no PNG/JPEG asset advertised in this sample. | **Registered candidate**; metadata discovery feasible, browser preview route still needed. Static root is not evidence of the entire bucket being indexed. |
| Capella | Root → product-type collection → scene all 200 with wildcard CORS; PNG thumbnail HEAD 200. Sample capella-13 SLC, 2026-09-09. | **Registered candidate**; traverse one hierarchy, deduplicate native products and handle programme licence separately from native collection metadata. |
| Sentinel-2 | Earth Search collection and sample item 200, wildcard CORS. | Already integrated. This test does not establish sub-10 m imagery or cloud-free coverage. |
| Sentinel-1 | Copernicus GRD collection and sample item 200, wildcard CORS. | Already integrated. The sampled product was IW GRD, **not** evidence of Stripmap GRD-FR coverage. |
| NISAR | ASF platform listing and spatial/date query each returned a feature, 200 with the requested origin allowed; PNG browse HEAD 200 with wildcard CORS. | **Enabled through ASF opt-in**. Preserve processing level and provisional status in native metadata. |
| Landsat | Earth Search collection and sample item 200, wildcard CORS. | Already integrated; data-asset access remains distribution-specific. |
| ALOS-2 ScanSAR | ASF platform listing and spatial/date query each returned a feature, 200 with the requested origin allowed. Sample dated 2025-05-12; no browse URL in that sample. | **Enabled through ASF opt-in**. Preview absence is valid; no full-image download was tested. |
| ALOS mosaics / forest maps | Official product page 200; no tile retrieval or account flow tested. | Annual composites/classifications need interval/layer semantics. |
| Himawari / P-Tree | Official FAQ 200; no registered SFTP/FTPS session tested. | Weather-layer integration; registered delivery, retention and product/date-specific terms need handling. |
| NASA Worldview / GIBS / Earthdata | GIBS WMTS capabilities 200, wildcard CORS, named layers/time dimensions present in the first 4 MiB; response intentionally truncated at the probe budget. | GIBS is a layer route. NASA CMR discovery infrastructure already exists, but individual MODIS/VIIRS collections were not tested here. |
| GOSAT-GW / AMSR3 | Official release page 200; no AMSR3 G-Portal granule query tested. | Requires verified numeric dataset IDs and product-specific adapter tests; passive microwave data is not an optical ground image. |
| EarthCARE | Official release page 200; no EarthCARE G-Portal granule query tested. | Requires dataset mapping and atmospheric-profile/product handling. Existing generic G-Portal support alone is insufficient evidence. |
| AW3D30 | Official download/product page 200; no tile retrieval tested. | Terrain/DSM layer, not a newly dated observation. |
| Copernicus DEM | Planetary Computer collection and sample tile item 200, wildcard CORS. | Terrain layer. Its sample STAC datetime (2021-04-22) must not be presented as an individual ground acquisition time. |
| Flanders / Digitaal Vlaanderen | WMS GetCapabilities 200, wildcard CORS and orthophoto layers present. | Useful aerial background; flight-date linkage and mosaic intervals needed. No GetMap or property-level coverage check performed. |
| Spain / PNOA | WMS GetCapabilities 200, wildcard CORS and mosaic layers present. | Useful aerial background; year/flight-date selection needed. No GetMap or property-level coverage check performed. |
| VENµS / THEIA | Product page 200; official page explicitly specifies CC BY-NC 4.0. No catalogue query tested. | Separate restricted source; do not label as unrestricted commercial imagery. |
| Vantor / Maxar Open Data | Public STAC root, release, collection and item 200 with wildcard CORS. Sample advertises GeoTIFFs, no PNG/JPEG. | SDK adapter already implemented; explorer remains disabled for the [previously recorded preview reasons](PUBLIC_PREVIEWS.md). CC BY-NC 4.0. |
| Planet / NICFI | Earth Engine catalogue page 200; no entitled Planet/Earth Engine request tested. | Programme terms/account access and composite handling required. No current entitlement or continuing availability established. |
| ALOS-4 / PALSAR-3 samples | Official samples page 200; no sample raster downloaded. | Fixed samples require a metadata index; this is not a searchable free ongoing archive. |

## Corrections and limits of the supplied research

**INPE asset names differ from the example.** The live item advertises `tci` (COG) and
`thumbnail` (PNG), rather than `rgb`. Its item-level properties omit `platform`, `gsd`
and a usable cloud percentage. The collection advertises CBERS-4A and 2 m fused-product
GSD, but the SDK leaves missing item fields unknown. Its midnight timestamps do not
establish the exact acquisition hour. API CORS works; the sampled thumbnail's HEAD
response lacked CORS, so it can be used as a separate image preview but is not proven
usable for canvas/map image fetches. No alignment is inferred from the footprint.
Source: [live INPE collection](https://data.inpe.br/bdc/stac/v1/collections/CB4A-WPM-PCA-FUSED-1).

**Static STAC is not an Item Search API.** Wyvern offers multiple views of the same
programme, and Capella has overlapping product/time/use-case hierarchies. A future
adapter should use one canonical traversal, resolve relative URLs, confine metadata
requests, preserve native product IDs, and report unfinished scans. Umbra's tested
scene lacked a browser-image asset; no preview should be fabricated.
Sources: [Wyvern catalogue](https://wyvern-odp.com/catalog.json),
[Capella access guide](https://support.capellaspace.com/how-do-i-access-capellas-open-data),
[Umbra AWS registry](https://registry.opendata.aws/umbra-open-data/).

**Licence labels need provenance.** Capella's sampled static collection says
`proprietary`, while its [official open-data policy](https://support.capellaspace.com/what-is-the-licensing-for-capellas-open-data)
and [AWS registry](https://registry.opendata.aws/capella_opendata/) specify CC BY 4.0.
Keep the explicit policy reference; do not rewrite the provider's native metadata.
THEIA's [VENµS page](https://www.theia-land.fr/en/blog/product/venus/) confirms non-commercial
terms. [Himawari's FAQ](https://www.eorc.jaxa.jp/ptree/faq.html) confirms the 2026-02-01
commercial-use cutoff, DAT-only HSD permission, excluded model products and registered
transfer route. These are not blanket permissions for every historical file.

**NISAR exists, but product maturity matters.** ASF's [availability guide](https://nisar-docs.asf.alaska.edu/availability-overview/)
confirms provisional products and the permanent July–August 2026 data gap. The live
adapter query near Lombok returned NISAR products, some with previews and one without;
the five-result cap was correctly marked partial. A product is not a promise of a
cloud-free optical photograph or a fully validated measurement.

## Reproduce

```sh
# Metadata/capabilities + preview HEAD only; no credentials or image-byte downloads.
node tools/smoke/source-review.mjs --out /tmp/source-review.json

# SDK live reachability, including INPE and the NISAR/ALOS-2 platform selector.
npm run build -w @powerpuff-kitty/satellites-images
node tools/smoke/live.mjs
```

The source-review script follows one representative static path per candidate,
not every scene or licence in those archives. Its expected CORONA 403 is recorded
as a denied probe, not converted into an empty successful search. Website-only
checks are explicitly identified above. No authenticated downloads, raster formats,
georeferencing, paid processing, account creation or arbitrary-location coverage
were tested.

The existing explorer G-Portal preset (`10002002`) returns **GCOM-C** metadata in
the live smoke, rather than ALOS; its internal label/comment were corrected. ALOS-2
is searched through the ASF option. No unverified G-Portal dataset IDs were added
for AMSR3 or EarthCARE.

Offline verification uses the shared [INPE metadata sample](../tests/fixtures/inpe-cbers-item.json)
in all three languages and mocked browser checks for INPE opt-in and ASF radar
classification. Run the commands in [AGENTS.md](../AGENTS.md) for SDK, browser and
local package validation. Live checks are opt-in and never part of mocked E2E.

Validation on 2026-10-16:

- `npm run check`: passed, including 53 SDK tests and 2 package-checker tests.
- `npm run test:e2e -w @satellites-images/explorer`: 70 passed; 2 opt-in live tests skipped.
- `PYTHONPATH=packages/python/src python3 -m unittest discover -s packages/python/tests`: 43 passed.
- `cargo test --manifest-path crates/satellites-images/Cargo.toml`: 37 passed, including integration tests.
- Rust Clippy with `--all-targets -- -D warnings` and `cargo fmt --check`: passed.
- `npm run check:packages`: passed for the npm tarball, Python wheel/sdist and Rust
  crate in isolated consumers (17 shared conformance cases per artifact); no publication.
- `node tools/smoke/live.mjs`: all 13 probes completed without errors; the CMR/ASF
  Sentinel-1 sample windows returned zero records, which is reachability evidence only.
- An additional live INPE SDK polygon query returned 2 then 1 items, matched 3,
  ending with `hasNext: false`; this exercised actual adapter pagination.
- `LIVE=1 npm run test:e2e -w @satellites-images/explorer -- --grep "capture the live explorer"`:
  passed; [README screenshot](assets/explorer.jpg) refreshed and visually inspected.
