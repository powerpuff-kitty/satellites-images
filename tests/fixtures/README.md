# ESA acquisition plan regression fixture

The `esa-s2-sample.kml` file retains one unmodified **Placemark** from an actual ESA Sentinel-2A acquisition plan covering 28 November–14 December 2024. Only the enclosing document was reduced for repeatable testing; the datatake timestamps, nominal style, metadata and polygon coordinates are preserved.

Source (original ESA plan mirrored by David Oesch):
https://github.com/davidoesch/Sentinel-2-Acquisition-Plan-Harvesting/blob/main/S2A_acquisition_plan.kml

ESA Copernicus is the source of the satellite planning data. This small test fixture is for format regression only, not a live plan, commercial imagery entitlement or orbit prediction.

`inpe-cbers-item.json` contains selected STAC item fields recorded anonymously on
2026-10-16 from [INPE's fused CBERS-4A collection](https://data.inpe.br/bdc/stac/v1/collections/CB4A-WPM-PCA-FUSED-1/items?limit=1).
It retains the `tci`/`thumbnail` asset keys and absent platform/GSD/cloud values for
cross-language regression checks. No image bytes are stored. Collection licence:
CC BY 4.0; source credit: INPE / Brazil Data Cube.
