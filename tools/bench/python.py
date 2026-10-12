import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "packages", "python", "src"))

from satellites_images import (  # noqa: E402
    SearchPage, Scene, coverage_percent, normalize_jaxa_feature, normalize_asf_feature,
    polygon_boxes, summarize_availability,
)


def bench(name, iterations, fn):
    for i in range(max(1, iterations // 10)):
        fn(i)
    start = time.perf_counter()
    for i in range(iterations):
        fn(i)
    ms = (time.perf_counter() - start) * 1000
    print(f"{name:<34} {iterations:>8} ops  {ms:>9.1f} ms  {iterations / (ms / 1000):>11.0f} ops/s")


polygon = {"type": "Polygon", "coordinates": [[[116.0, -8.7], [116.3, -8.7], [116.3, -8.4], [116.0, -8.4], [116.0, -8.7]]]}
antimeridian = {"type": "Polygon", "coordinates": [[[179.9, -1], [-179.9, -1], [-179.9, 1], [179.9, 1], [179.9, -1]]]}
boxes = polygon_boxes(polygon)

bench("polygonBoxes", 100000, lambda i: polygon_boxes(polygon))
bench("polygonBoxes(antimeridian)", 100000, lambda i: polygon_boxes(antimeridian))
bench("coveragePercent", 100000, lambda i: coverage_percent([116.1, -8.6, 116.2, -8.5], boxes))


def scene(identifier, date):
    return Scene(provider_id="earth-search", id=identifier, collection="sentinel-2-l2a", acquired_at=date,
                 mission="sentinel-2a", geometry=None, bbox=None, cloud_cover_percent=None, preview_url=None,
                 access="unknown", assets=(), source_url=None, raw={})


pages = []
for p in range(50):
    items = tuple(scene(f"p{p}-{i}", f"2025-03-{(i % 28) + 1:02d}T02:00:00.000Z") for i in range(100))
    pages.append(SearchPage("earth-search", items, p + 1, p < 49, None))
bench("summarize_availability 50x100", 200, lambda i: summarize_availability(pages))

jaxa_feature = {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[140.88, 46.45], [141.0, 46.5], [140.9, 46.6], [140.88, 46.45]]]},
                "properties": {"identifier": "GC1SG1_x", "beginPosition": "2021-07-07T00:07:08.58Z", "platformShortName": "GCOM-C",
                               "product": {"fileName": "https://gportal.jaxa.jp/x.h5"}, "browse": [{"fileName": "https://gportal.jaxa.jp/x.jpg"}],
                               "gpp": {"cloudCoverPercentage": "6"}}}
asf_feature = {"type": "Feature", "geometry": {"type": "Point", "coordinates": [116.1, -8.6]},
               "properties": {"granuleName": "S1A_x", "startTime": "2025-01-10T02:00:00Z", "platform": "Sentinel-1",
                              "browse": ["https://example.test/b.png"], "downloadUrl": "https://x/y.zip"}}
bench("normalize_jaxa_feature", 100000, lambda i: normalize_jaxa_feature(jaxa_feature))
bench("normalize_asf_feature", 100000, lambda i: normalize_asf_feature(asf_feature))
