# Provider registry and imagery rights

`sources/registry.json` describes a curated selection of public and commercial discovery services; it is **not** a claim that all are integrated.

## Access vocabulary

- `searchAccess`: how to query metadata, e.g. anonymous, free account key, organization account, or entitlement.
- `imageryAccess`: whether source **image bytes** are open, paid, authenticated or a mixture. An open index does not mean an open raster.
- `implemented`: which language packages have a tested adapter. The registry has entries for future work as well.
- `scheduled`: separate planned/predicted acquisitions are **not** published images and are unimplemented at V0.1.

Earth Search can expose links to AWS-hosted data whose access or transfer cost depends on the method used. Planetary Computer returns catalogue metadata publicly but raster access may require signed URLs. We never label every asset as free just because it has a link.

## Included sources

See the machine-readable [source registry](../sources/registry.json) for source homepages, docs and availability. Important initial endpoints:

- [Earth Search v1](https://earth-search.aws.element84.com/v1): public STAC search for `sentinel-2-l2a` and `landsat-c2-l2`.
- [Microsoft Planetary Computer](https://planetarycomputer.microsoft.com/api/stac/v1): public STAC search; asset signing separate.
- [Copernicus STAC](https://documentation.dataspace.copernicus.eu/APIs/STAC.html): open catalogue with separate auth rules for downloads.
- [ESA mission planning](https://sentinels.copernicus.eu/copernicus-operations/mission-planning): independently published Sentinel-1/Sentinel-2 acquisition plans (planned integration).

## Operational and licensing notes

1. Check **current** terms, attribution and commercial-use rights with each data operator.
2. A public thumbnail or product listing is not an image license.
3. Do not redistribute proprietary previews in published sample fixtures.
4. Provider listings may be incomplete, delayed or subject to quotas; pagination is bounded and explicit.
5. Image access fields default to `unknown`, not `open`, unless a provider adapter can establish asset-level entitlements.
