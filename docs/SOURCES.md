# Provider registry and imagery rights

`sources/registry.json` describes a curated selection of public and commercial discovery services; it is **not** a claim that all are integrated.

## Access vocabulary

- `searchAccess`: how to query metadata, e.g. anonymous, free account key, organization account, or entitlement.
- `imageryAccess`: whether source **image bytes** are open, paid, authenticated or a mixture. An open index does not mean an open raster.
- `implemented`: which language packages have a tested adapter. The registry has entries for future work as well.
- `scheduled`: official ESA Sentinel-1/2 planned acquisitions are implemented; *orbit predictions* and other provider schedules remain unimplemented. Neither represents a published image.

Earth Search can expose links to AWS-hosted data whose access or transfer cost depends on the method used. Planetary Computer returns catalogue metadata publicly but raster access may require signed URLs. We never label every asset as free just because it has a link.

## Included sources

See the machine-readable [source registry](../sources/registry.json) for source homepages, docs and availability. Important initial endpoints:

- [Earth Search v1](https://earth-search.aws.element84.com/v1): public STAC search for `sentinel-2-l2a` and `landsat-c2-l2`.
- [Microsoft Planetary Computer](https://planetarycomputer.microsoft.com/api/stac/v1): public STAC search; asset signing separate.
- [Copernicus Data Space Ecosystem STAC](https://stac.dataspace.copernicus.eu/v1): anonymous STAC search; downloads require registration. Adapter in all three SDKs (scenes are reported as `authentication-required`; per-asset access stays `unknown`).
- [USGS LandsatLook STAC](https://landsatlook.usgs.gov/stac-server): anonymous STAC search. Adapter in all three SDKs; its CORS policy blocks arbitrary browser origins, so browser use needs the optional proxy.
- [NASA CMR-STAC](https://cmr.earthdata.nasa.gov/stac): provider-scoped STAC search (e.g. `ASF`, `USGS_LTA`). Adapter in all three SDKs.
- [Alaska Satellite Facility Search API](https://api.daac.asf.alaska.edu/services/search/param): keyword SAR metadata search returning GeoJSON. Adapter in all three SDKs; product downloads require Earthdata authentication.
- [JAXA G-Portal](https://gportal.jaxa.jp/): granule adapter in all three SDKs via anonymous CSW 3.0.0 **GET** on `gportal.jaxa.jp/csw/csw` with `outputFormat=application/json` and a **numeric** `datasetId` (short names are rejected). Per-granule `beginPosition` is a real acquisition time, distinct from `processingDate`. POST is WAF-blocked; the `bbox` axis order and live smoke are operator-verifiable. (The dataset-level OpenSearch on `gpwos1.jaxa.jp` exposes catalogue records only, not granules.)
- [OpenAerialMap](https://api.openaerialmap.org/meta): anonymous metadata search over crowdsourced aerial imagery (drone/aircraft). `bbox` plus a server-side `acquisition_from`/`acquisition_to` window, paged with `limit`/`page`; `meta.found` is the provider's total for the filter. Adapter in all three SDKs. Records carry a `tilejson` asset (renderable on the map) but no preview thumbnail; the provider's `gsd` is reported in degrees at inconsistent scales, so `gsdMeters` stays `null` and the raw value is kept in `raw`. Per-image licences vary (the API itself is CC-BY 4.0).
- [ESA mission planning](https://sentinels.copernicus.eu/copernicus-operations/mission-planning): official Sentinel-1/Sentinel-2 KML acquisition plan adapter in all three SDKs. Sentinel-2 nominal strips only. Direct browser requests may require an origin-restricted proxy.

## Operational and licensing notes

1. Check **current** terms, attribution and commercial-use rights with each data operator.
2. A public thumbnail or product listing is not an image license.
3. Do not redistribute proprietary previews in published sample fixtures.
4. Provider listings may be incomplete, delayed or subject to quotas; pagination is bounded and explicit.
5. `Scene.access` reports the class the provider **declares** for a collection, derived from this registry plus verified refinements (`declaredImageryAccess`). It is not a licence and not a per-asset check: per-asset `access` stays `unknown`, because an individual href can be expired, signed or gone. A coarse registry value (`mixed`, `signed-or-authenticated`, `per-dataset`) maps to `unknown` rather than being guessed.
