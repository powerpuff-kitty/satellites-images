# @powerpuff-kitty/satellites-images

Native TypeScript satellite observation discovery SDK. Version 0.3 adds a historical UTC availability calendar, polygon AOI with antimeridian-safe search, ESA Sentinel-1/2 planned-acquisition KML with conditional caching and diagnostics, and STAC adapters for Earth Search, Planetary Computer, Copernicus Data Space, USGS LandsatLook and NASA CMR-STAC plus bespoke ASF and JAXA G-Portal adapters, with an opt-in retry/backoff policy.

This package is **not yet published**. Run `npm install` and `npm run build` in the repository root, or install the local workspace package.

Requires Node 20.19 or newer, or a browser with Fetch, AbortSignal.any and AbortSignal.timeout.

```ts
import { SatelliteCatalog, earthSearch, esaSentinelPlans } from "@powerpuff-kitty/satellites-images";
const catalog = new SatelliteCatalog([earthSearch()], [esaSentinelPlans()]);
for await (const page of catalog.search({
  latitude: -8.5833, longitude: 116.1167, radiusMeters: 5000,
  from: "2025-01-01", to: "2025-02-01", maxPages: 2,
})) console.log(page.items);
```

Return values preserve provider ids, collection ids, acquisition timestamps, original STAC item data and source URLs. All image asset access defaults to `unknown` until a provider-specific entitlement check exists.

Custom providers can use `new StacProvider({ id, baseUrl, collections, fetchImpl })` and return pages via `search()`.

`inpeCbers()` searches INPE's Brazil-focused `CB4A-WPM-PCA-FUSED-1` visual collection.
`asfSearch({ platforms: ["SENTINEL-1", "NISAR", "ALOS-2"] })` opts into additional radar
missions. See [live checks and metadata limitations](../../docs/FREE_SOURCES_REVIEW.md).

`upcoming()` uses official ESA KML plans when `esaSentinelPlans()` is configured. Without an acquisition provider it throws `UNSUPPORTED`. Predicted orbital passes and guarantees about published future images are not supported.

## Date-availability summaries

```ts
import { SatelliteCatalog, earthSearch } from "@powerpuff-kitty/satellites-images";

const sdk = new SatelliteCatalog([earthSearch()]);
const summary = await sdk.availability({
  latitude: -8.5833, longitude: 116.1167, radiusMeters: 5000,
  from: "2025-01-01", to: "2025-01-31", maxPages: 10
});
console.log(summary.days, summary.months);
console.log(summary.complete, summary.truncatedProviders);
```

`AvailabilityAccumulator.addPage(page)` enables streaming summaries without rerequesting any page. Use `expectProvider(id)` before scanning multiple providers and `markError(id)` on a failed scan. Date grouping uses actual UTC acquisition timestamps. `complete` requires all expected providers to finish without errors or truncation; it does not imply that every satellite image in existence was discovered. `catalog.availability()` records provider failures, retains partial counts and continues with the remaining providers.

## Maxar public releases

`maxarOpenData()` searches anonymous, selected public event releases through bounded
static STAC traversal. Use the usual location/AOI and date query; `collections` can
select event release IDs or `maxar-open-data` for all releases. Default document budget
is 2000 (`maxDocuments`), at most 100 documents per page. Pending work sets `hasNext`.
Relative asset URLs are resolved; assets are not fetched. Many items expose only
GeoTIFFs. Raw metadata and tile cloud percentages remain native. The imagery licence
is separate from this library's MIT licence; see [details](../../docs/PUBLIC_PREVIEWS.md).
