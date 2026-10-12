import unittest
from satellites_images import (
    AvailabilityAccumulator, SatelliteCatalog, EarthSearch,
    Scene, SearchPage, summarize_availability, SearchQuery,
)

def make_scene(identifier, date, collection="sentinel-2-l2a", mission="sentinel-2a"):
    return Scene(
        provider_id="earth-search", id=identifier, collection=collection,
        acquired_at=date, mission=mission, geometry=None, bbox=None,
        cloud_cover_percent=None, preview_url=None, access="unknown",
        assets=(), source_url=None, raw={}
    )

class AvailabilityTests(unittest.TestCase):
    def test_month_day_counts_and_duplicates(self):
        acc = AvailabilityAccumulator()
        a = make_scene("a", "2025-01-31T23:55:00.000Z")
        b = make_scene("b", "2025-02-01T00:05:00.000Z")
        acc.add_page(SearchPage("earth-search", (a,b), 1, True, 3))
        self.assertFalse(acc.summary().complete)
        acc.add_page(SearchPage("earth-search", (a,), 2, False, 3))
        s = acc.summary()
        self.assertTrue(s.complete)
        self.assertEqual(s.raw_items, 3)
        self.assertEqual(s.unique_items, 2)
        self.assertEqual([m.month for m in s.months], ["2025-01", "2025-02"])
        self.assertEqual(s.providers[0].matched, 3)

    def test_provider_provenance_is_not_lost(self):
        item = make_scene("a", "2025-01-01T00:00:00.000Z")
        s = summarize_availability([
            SearchPage("earth-search", (item,), 1, True, None),
            SearchPage("planetary-computer", (item,), 1, False, None),
        ])
        self.assertEqual(s.unique_items, 2)
        self.assertEqual(s.truncated_providers, ("earth-search",))

    def test_empty_scan_never_claims_completeness(self):
        self.assertFalse(summarize_availability([]).complete)

    def test_catalog_availability_uses_scanned_pages(self):
        def mock(_url, _method, _body):
            return {"type":"FeatureCollection", "features":[{
                "id":"s1","collection":"sentinel-2-l2a",
                "properties":{"datetime":"2025-01-01T00:00:00Z","platform":"sentinel-2a"},
                "assets":{}
            }], "links":[]}
        result = SatelliteCatalog([EarthSearch(transport=mock)]).availability(
            SearchQuery(latitude=0,longitude=0,radius_meters=1000,
                        start="2025-01-01",end="2025-01-31")
        )
        self.assertTrue(result.complete)
        self.assertEqual(result.days[0].count,1)

if __name__=="__main__":
    unittest.main()
