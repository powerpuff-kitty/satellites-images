import unittest

from satellites_images import (
    EarthSearch, SatelliteCatalog, SatelliteError, SearchQuery,
    bounds_around, list_sources,
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
        with self.assertRaises(SatelliteError):
            bounds_around(0, 180, 5000)
        with self.assertRaises(SatelliteError):
            SearchQuery(0, 0, 5000, "2025-02-31", "2025-03-01")

    def test_registry_includes_paid_and_free_sources(self):
        sources = list_sources()
        self.assertGreaterEqual(len(sources), 12)
        self.assertTrue(next(s for s in sources if s["id"] == "earth-search")["implemented"]["python"])
        self.assertFalse(next(s for s in sources if s["id"] == "skyfi")["implemented"]["python"])

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

    def test_next_post_without_merge_replaces_body(self):
        calls = []
        def mock(url, method, body):
            calls.append(dict(body or {}))
            if len(calls) == 1:
                return {**SAMPLE, "links": [{
                    "rel": "next",
                    "href": "https://earth-search.aws.element84.com/v1/search",
                    "method": "POST",
                    "body": {"cursor": "opaque-token"},
                }]}
            return {**SAMPLE, "features": [], "links": []}
        pages = list(EarthSearch(transport=mock).search(self.query))
        self.assertEqual(len(pages), 2)
        self.assertEqual(calls[1], {"cursor": "opaque-token"})

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
