# @powerpuff-kitty/satellites-images

Native TypeScript satellite observation discovery SDK. Version 0.1 implements STAC search against Earth Search and Microsoft Planetary Computer.

This package is **not yet published**. Run `npm install` and `npm run build` in the repository root, or install the local workspace package.

```ts
import { SatelliteCatalog, earthSearch } from "@powerpuff-kitty/satellites-images";
const catalog = new SatelliteCatalog([earthSearch()]);
for await (const page of catalog.search({
  latitude: -8.5833, longitude: 116.1167, radiusMeters: 5000,
  from: "2025-01-01", to: "2025-02-01", maxPages: 2,
})) console.log(page.items);
```

Return values preserve provider ids, collection ids, acquisition timestamps, original STAC item data and source URLs. All image asset access defaults to `unknown` until a provider-specific entitlement check exists.

Custom providers can use `new StacProvider({ id, baseUrl, collections, fetchImpl })` and return pages via `search()`.

`catalog.upcoming()` currently throws `SatelliteError` with code `UNSUPPORTED`; predicted/planned acquisitions are a separate future implementation.
