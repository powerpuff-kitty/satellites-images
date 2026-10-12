# satellites-images (Python)

Lightweight synchronous Python imagery discovery using public STAC APIs. No native raster or PySTAC dependency required for the initial Earth Search adapter.

**Not published on PyPI.** Install this checkout with `python -m pip install -e packages/python` at repo root.

```py
from satellites_images import SatelliteCatalog, EarthSearch, SearchQuery
catalog = SatelliteCatalog([EarthSearch()])
q = SearchQuery(latitude=-8.5833, longitude=116.1167, radius_meters=5000,
                start="2025-01-01", end="2025-02-01", max_pages=2)
for page in catalog.search(q):
    for scene in page.items:
        print(scene.id, scene.acquired_at, scene.preview_url)
```

The client raises `SatelliteError` on network errors and malformed catalogue results, instead of silently presenting an empty availability list. Asset rights are unknown until separately verified. Future acquisition plans are not implemented.
