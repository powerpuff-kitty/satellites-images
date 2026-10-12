import unittest

from satellites_images import (
    CmrStac, CopernicusDataSpace, EarthSearch, SatelliteCatalog, SatelliteError,
    SearchQuery, UsgsLandsatLook,
    availability_summary, bounds_around, coverage_percent, list_sources,
    polygon_boxes, radius_boxes, resolve_areas,
)

SAMPLE = {
    "type": "FeatureCollection",
    "context": {"matched": 2},
    "features": [{
        "type": "Feature", "id": "S2_example", "collection": "sentinel-2-l2a",
        "properties": {"datetime": "2025-01-10T02:12:00Z", "platform": "sentinel-2a", "eo:cloud_cover": 11.4},
        "assets": {"thumbnail": {"href": "https://example.test/thumb.jpg", "roles": ["thumbnail"]}},
        "links": [{"rel": "self", "href": "https://earth-search.aws.element84.com/v1/items/S2_example"}],
    }],
    "links": [
        {"rel": "next", "href": "https://earth-search.aws.element84.com/v1/search",
         "method": "POST", "merge": True, "body": {"token": "page2"}}
    ],
}


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.query = SearchQuery(latitude=-8.5833, longitude=116.1167, radius_meters=5000,
                                 start="2025-01-01", end="2025-01-31", max_pages=2)

    def test_validate_location_and_dates(self):
        self.assertEqual(len(bounds_around(-8.5833, 116.1167, 5000)), 4)
        # Antimeridian and pole areas are split/clamped instead of rejected.
        self.assertEqual(len(radius_boxes(0, 180, 5000)), 2)
        self.assertEqual(radius_boxes(89.999, 10, 50000)[0][0], -180)
        with self.assertRaises(SatelliteError):
            bounds_around(float("nan"), 0, 5000)
        with self.assertRaises(SatelliteError):
            SearchQuery(0, 0, 5000, "2025-02-31", "2025-03-01")

    def test_polygon_aoi_and_coverage(self):
        aoi = {"type": "Polygon", "coordinates": [[[116.0, -8.7], [116.3, -8.7],
                                                   [116.3, -8.4], [116.0, -8.4], [116.0, -8.7]]]}
        self.assertEqual(polygon_boxes(aoi), [[116.0, -8.7, 116.3, -8.4]])
        boxes, polygon = resolve_areas(SearchQuery(aoi=aoi, start="2025-01-01", end="2025-01-02"))
        self.assertEqual(polygon, aoi)
        self.assertEqual(coverage_percent([116.0, -8.7, 116.3, -8.4], boxes), 100.0)
        self.assertIsNone(coverage_percent(None, boxes))
        crossing = {"type": "Polygon", "coordinates": [[[179.9, -1], [-179.9, -1],
                                                        [-179.9, 1], [179.9, 1], [179.9, -1]]]}
        self.assertEqual(len(polygon_boxes(crossing)), 2)
        self.assertIsNone(resolve_areas(SearchQuery(aoi=crossing, start="2025-01-01",
                                                    end="2025-01-02"))[1])

    def test_invalid_aoi_is_rejected(self):
        with self.assertRaises(SatelliteError):
            polygon_boxes({"type": "Point", "coordinates": [0, 0]})
        with self.assertRaises(SatelliteError):
            polygon_boxes({"coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]})

    def test_antimeridian_split_uses_both_boxes(self):
        aoi = {"type": "Polygon", "coordinates": [[[179.9, -1], [-179.9, -1],
                                                   [-179.9, 1], [179.9, 1], [179.9, -1]]]}
        requested = []

        def mock(url, method, body):
            requested.append(body["bbox"])
            return {"type": "FeatureCollection", "features": [], "links": [],
                    "context": {"matched": 0}}
        pages = list(EarthSearch(transport=mock).search(
            SearchQuery(aoi=aoi, start="2025-01-01", end="2025-01-02", max_pages=1)))
        self.assertEqual(len(requested), 2)
        self.assertEqual(len(pages), 2)

    def test_post_next_body_replaces_when_merge_absent(self):
        calls = []
        next_link = {"rel": "next", "href": "https://earth-search.aws.element84.com/v1/search",
                     "method": "POST", "body": {"token": "t2"}}

        def mock(url, method, body):
            calls.append(body)
            if len(calls) == 1:
                return {**SAMPLE, "links": [next_link]}
            return {**SAMPLE, "features": [], "links": []}
        list(EarthSearch(transport=mock).search(self.query))
        self.assertEqual(calls[1], {"token": "t2"})

    def test_availability_summary(self):
        seen = []

        def mock(url, method, body):
            seen.append(1)
            if len(seen) == 1:
                return SAMPLE
            return {**SAMPLE, "features": [{**SAMPLE["features"][0], "id": "second"}], "links": []}
        pages = list(EarthSearch(transport=mock).search(self.query))
        summary = availability_summary(pages)
        self.assertEqual(summary.total_scenes, 2)
        self.assertFalse(summary.complete)
        self.assertIn("earth-search", summary.providers)
        self.assertEqual(summary.days[0].date, "2025-01-10")

    def test_registry_includes_paid_and_free_sources(self):
        sources = list_sources()
        self.assertGreaterEqual(len(sources), 12)
        self.assertTrue(next(s for s in sources if s["id"] == "earth-search")["implemented"]["python"])
        self.assertFalse(next(s for s in sources if s["id"] == "skyfi")["implemented"]["python"])

    def test_stac_reuse_adapters(self):
        self.assertEqual(CopernicusDataSpace().id, "copernicus")
        self.assertEqual(UsgsLandsatLook().id, "usgs-landsatlook")
        self.assertEqual(CmrStac("ASF", ("sentinel-1-rtc",)).id, "nasa-cmr")
        with self.assertRaises(SatelliteError):
            CmrStac("bad id", ("x",))

        def mock(url, method, body):
            return {**SAMPLE, "features": [{**SAMPLE["features"][0], "id": "S2C_x"}], "links": []}
        pages = list(SatelliteCatalog([CopernicusDataSpace(transport=mock)]).search(self.query))
        self.assertEqual(pages[0].items[0].provider_id, "copernicus")

    def test_pagination_and_metadata(self):
        seen = []
        def mock(url, method, body):
            seen.append((url, method, body))
            if len(seen) == 1:
                return SAMPLE
            return {**SAMPLE, "features": [{**SAMPLE["features"][0], "id": "second"}], "links": []}
        catalog = SatelliteCatalog([EarthSearch(transport=mock)])
        pages = list(catalog.search(self.query))
        self.assertEqual(len(pages), 2)
        self.assertEqual(pages[0].items[0].acquired_at, "2025-01-10T02:12:00.000Z")
        self.assertEqual(pages[0].items[0].access, "unknown")
        self.assertEqual(pages[0].items[0].preview_url, "https://example.test/thumb.jpg")
        self.assertEqual(seen[1][2]["token"], "page2")
        self.assertIn("bbox", seen[1][2])

    def test_prevents_external_next_link(self):
        def mock(url, method, body):
            return {**SAMPLE, "links": [{"rel": "next", "href": "https://evil.invalid/search"}]}
        iterator = SatelliteCatalog([EarthSearch(transport=mock)]).search(self.query)
        next(iterator)
        with self.assertRaises(SatelliteError) as context:
            next(iterator)
        self.assertEqual(context.exception.code, "UNSAFE_NEXT_LINK")

    def test_failure_not_empty_and_upcoming_explicit(self):
        def mock(url, method, body):
            raise SatelliteError("HTTP_ERROR", "429")
        with self.assertRaises(SatelliteError) as context:
            list(SatelliteCatalog([EarthSearch(transport=mock)]).search(self.query))
        self.assertEqual(context.exception.code, "HTTP_ERROR")
        with self.assertRaises(SatelliteError) as context:
            SatelliteCatalog([EarthSearch()]).upcoming()
        self.assertEqual(context.exception.code, "UNSUPPORTED")


if __name__ == "__main__":
    unittest.main()
