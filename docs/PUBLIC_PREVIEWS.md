# Public previews

The explorer uses public previews advertised by scene catalogues. A preview is
separate from the full image: a product can require an account for downloads and
still offer an anonymous quicklook. Source imagery terms apply independently of
the SDK's MIT licence. Cards expose an advertised HTTPS licence link when present.

## Current explorer behavior

Only observations advertising a public native-resolution tile set are eligible for
the explorer's list, calendar and filter choices. This is permanent; there is no
**Native-resolution tiles only** checkbox, and reset or old `tiles=0` links cannot
show thumbnail-only, quicklook-only or raw-GeoTIFF-only records. Grouped catalogue
copies retain their provenance and prefer a copy advertising tiles. Eligibility
reflects catalogue metadata, not a guarantee that the tile service is healthy.

Eligible observations can also display advertised HTTPS JPEG/PNG/WebP/AVIF/GIF
previews. Declared GeoTIFF/JP2/HTML and authenticated assets are excluded from browser
image choices. A tile-service failure can fall back to the eligible scene's still
preview. **Has preview** remains available as a separate filter.

Preview metadata requests have a 15-second deadline and a 1 MiB streamed response
limit. Explicitly aligned image overlays have an 8 MiB streamed limit. Closing a
preview or changing the search cancels pending work. Failed links can be retried;
no purchase, asset activation or paid processing is triggered. The dated lookup
observations below describe the earlier broader preview implementation; they do
not make quicklook-only records eligible in the current explorer.

## Commercial previews and satellite filtering

Maxar catalogue scanning was removed from the explorer after full-year anonymous
preview checks on **2026-10-13**. The screenshot location (`-8.48823, 116.10846`,
5 km radius, full 2026) returned zero observations and no preview URLs in 56
metadata requests. The known Maui release (`20.88, -156.68`, 1 km radius, full 2023)
returned four observations and 12 GeoTIFF asset links in 112 metadata requests,
but no browser-image preview URLs. Both scans completed; no preview URL existed
to fetch. These results concern the selected public releases, not the full paid archive.

The explorer no longer queries Maxar, including from old `src=maxar-open-data`
links. Paid-provider map links are currently removed. The SDK's read-only Maxar
metadata adapter remains available separately; metadata discovery does not establish
preview availability.

**Satellite type → Exclude commercial satellites** still hides recognized commercial
missions and payment-required imagery returned by connected public catalogues.
**Commercial satellites only** selects those records. Filters update cards/counts and
the day matrix, persist in shared links, and reset normally. Empty commercial results
explain the public-catalogue scope and offer **Show all loaded observations**. The
counter compares filtered matches with all loaded observations at the location.

Reproduce the anonymous year checks after building the SDK:

```sh
npm run build -w @powerpuff-kitty/satellites-images
node tools/smoke/commercial-previews.mjs --out /tmp/commercial-previews.json
```

The [recorded report](../tools/smoke/results/commercial-previews-2026-10-13.json)
records exact windows, coordinates, completeness, requests, assets and elapsed times.

## SDK metadata-only Maxar discovery

The SDKs expose `maxarOpenData()` (TypeScript), `MaxarOpenData` (Python) and
`maxar_open_data()` / `MaxarProvider` (Rust). Query collections select event release IDs;
`maxar-open-data` selects all releases. TypeScript/Python can omit collections; Rust
callers should set `query.collections = vec!["maxar-open-data".into()]`.
Each returned page reads at most 100 metadata documents and contains at most the
requested item limit. Searches additionally cap documents at 2000 by default (configurable
up to 10000), obey the normal page limit, and advertise `hasNext` while work remains.
Links cannot leave the root origin/directory; redirects are rejected. Relative asset
URLs become absolute; `raw` retains the native metadata. Native space-separated UTC
timestamps normalize to RFC 3339. `tile:clouds_percent` stays raw, because it describes
an ARD tile rather than scene-wide cloud cover. Only metadata is fetched by the SDKs.

Live observation **2026-10-13**: the root, Maui release, acquisition collection and
item endpoints returned anonymous HTTP 200 responses with `Access-Control-Allow-Origin:
*`. A 1 km-radius search at `20.88, -156.68`, August 2023, returned four WorldView-2/3
ARD tiles in 112 metadata requests, approximately 22 seconds in this local run. The
sample advertised GeoTIFF assets and no browser-image preview; the SDK records
such observations for metadata discovery. The explorer integration was subsequently removed.
This covers selected public releases, not the full commercial archive. Reference:
[Maxar Open Data registry](https://registry.opendata.aws/maxar-open-data/).

## Image placement and provenance

Provider tile sets use their advertised map transform. A still image is placed
only with explicit WGS84 image bounds and a north-up affine transform. Otherwise,
it appears in a separate preview panel alongside the map footprint. The footprint
does not establish a cropped/rotated thumbnail's alignment. Missing images and tile
errors have visible fallback states. Cloud metadata remains scene-wide; a preview
does not estimate cloud obstruction over the user's area.

The explorer groups known public STAC copies by collection and product identity,
including a shared Sentinel-2 product URI. It preserves catalogue records and lists
their provenance; date/footprint similarity alone cannot collapse acquisitions.
This does not unify different processing products or seller offers.

## Commercial provider links

The explorer currently has no **Paid imagery maps** section or clipboard export for
commercial searches. Commercial APIs are not connected to the browser build.

## Evidence and verification

Observed **2026-10-13**, anonymously: Copernicus STAC supplied a Sentinel-2 JPEG
thumbnail link; OData supplied one exact `.SAFE` product and its `QUICKLOOK` asset.
The OData metadata response advertised `Access-Control-Allow-Origin: *`; a ranged
asset GET returned HTTP 206, `application/octet-stream`, and the same CORS header.
HEAD returned 405. This sample is not a guarantee for all products. Planetary
Computer supplied `tilejson` and `rendered_preview` assets for the corresponding
Sentinel-2 product. Earth Search exposed its `s2:product_uri` despite a different
tile acquisition timestamp, supporting a product-identity match.

Official references: [Copernicus OData](https://documentation.dataspace.copernicus.eu/APIs/OData.html),
[Earth Search](https://github.com/Element84/earth-search),
[Planetary Computer STAC](https://planetarycomputer.microsoft.com/docs/quickstarts/reading-stac/),
[SkyFi](https://app.skyfi.com/), [UP42](https://console.up42.com/).
The supplied *Free satellite-image previews* research guided this implementation;
its broader provider list does not imply implemented connectors.

Run `npm run check` and `npm run test:e2e -w @satellites-images/explorer` for offline
verification, including exact-product discovery, missing/account-gated previews,
unapproved hosts, response budgets, cancellation, keyboard interaction and paid-map
navigation. Live screenshot refresh remains opt-in:

```sh
LIVE=1 npm run test:e2e -w @satellites-images/explorer -- --grep "capture the live explorer"
```
