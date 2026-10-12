import unittest
from datetime import datetime, timezone

from satellites_images import (
    ESASentinelPlans, AcquisitionQuery, SatelliteCatalog, EarthSearch,
    SatelliteError, bounds_around, parse_esa_plan_index, parse_esa_plan_kml,
)

BASE = "https://sentinels.copernicus.eu/documents/d/sentinel/"
S2 = BASE + "s2b_mp_acq__kml_20261008t120000_20261026t150000"
OLD = BASE + "s2b_mp_acq__kml_20260924t120000_20261012t150000"
S1 = BASE + "s1c_mp_user_20261012t173841_20261103t194800"
INDEX = '<a href="' + OLD + '">old</a><a href="' + S2 + '">new</a><a href="' + S1 + '">s1</a>'
COORDS = "116.0,-8.7,0 116.3,-8.7,0 116.3,-8.4,0 116.0,-8.4,0 116.0,-8.7,0"
FAR = "1,1,0 2,1,0 2,2,0 1,2,0 1,1,0"

def placemark(name, style, coords=COORDS):
    return (
        "<Placemark><name>" + name + "</name><styleUrl>" + style +
        "</styleUrl><ExtendedData>"
        '<Data name="ObservationTimeStart"><value>2026-10-15T02:12:00.000</value></Data>'
        '<Data name="ObservationTimeStop"><value>2026-10-15T02:14:00.000</value></Data>'
        '<Data name="OrbitRelative"><value>47</value></Data>'
        '<Data name="Mode"><value>NOBS</value></Data></ExtendedData>'
        "<Polygon><outerBoundaryIs><LinearRing><coordinates>" + coords +
        "</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>"
    )
KML = ('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
       placemark("id1", "S2B_NOBS_NOMINAL") + placemark("bad", "S2B_VIC") +
       placemark("far", "S2B_NOBS_NOMINAL", FAR) + "</Document></kml>")
S1KML = ('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
         placemark("id2", "S1C_IW") + "</Document></kml>")

class ESAPlanTests(unittest.TestCase):
    def test_index_discovery(self):
        html = INDEX + '<a href="https://evil.test/documents/d/sentinel/s1c_mp_user_20261012t180000_20261105t180000">bad</a>'
        plans = parse_esa_plan_index(html)
        self.assertEqual(len(plans), 3)
        self.assertEqual(next(p for p in plans if p.url == S2).mission, "S2B")

    def test_nominal_filter_coordinates_and_utc(self):
        plan = next(p for p in parse_esa_plan_index(INDEX) if p.url == S2)
        got = parse_esa_plan_kml(
            KML, plan, bounds_around(-8.5833, 116.1167, 5000),
            datetime(2026, 10, 12, tzinfo=timezone.utc),
            datetime(2026, 10, 20, tzinfo=timezone.utc),
        )
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0].expected_at, "2026-10-15T02:12:00.000Z")
        self.assertEqual(got[0].footprint["type"], "Polygon")
        self.assertEqual(got[0].orbit_relative, 47)

    def test_full_provider_and_catalog_aggregation(self):
        seen = []
        def transport(url):
            seen.append(url)
            if url.endswith("/acquisition-plans"):
                return INDEX
            return {S2: KML, S1: S1KML}[url]
        esa = ESASentinelPlans(
            transport=transport,
            clock=lambda: datetime(2026, 10, 12, 16, tzinfo=timezone.utc),
            missions=("S1C", "S2B"),
        )
        catalog = SatelliteCatalog([EarthSearch()], acquisition_providers=[esa])
        results = catalog.upcoming(AcquisitionQuery(-8.5833, 116.1167, 5000, days=10))
        self.assertEqual([r.mission for r in results], ["S1C", "S2B"])
        self.assertNotIn(OLD, seen)
        self.assertEqual(len(seen), 4)


    def test_real_esa_kml_fixture(self):
        from pathlib import Path
        fixture = (Path(__file__).resolve().parents[3] / "tests/fixtures/esa-s2-sample.kml").read_text()
        plan = next(p for p in parse_esa_plan_index(
            '<a href="https://sentinels.copernicus.eu/documents/d/sentinel/s2a_mp_acq__kml_20241128t120000_20241214t150000">plan</a>'
        ) if p.mission == "S2A")
        start = datetime(2024, 11, 28, tzinfo=timezone.utc)
        end = datetime(2024, 12, 1, tzinfo=timezone.utc)
        results = parse_esa_plan_kml(fixture, plan, bounds_around(40.97507, -27.63923, 1000),
                                     start, end)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].expected_at, "2024-11-28T12:50:30.621Z")
        self.assertEqual(results[0].orbit_relative, 95)
        self.assertEqual(results[0].mode, "NOBS")

    def test_reject_doctype_and_bad_request(self):
        plan = next(p for p in parse_esa_plan_index(INDEX) if p.url == S2)
        with self.assertRaises(SatelliteError):
            parse_esa_plan_kml(
                "<!DOCTYPE kml><kml/>", plan, bounds_around(0, 0, 1000),
                datetime.now(timezone.utc), datetime.now(timezone.utc)
            )
        with self.assertRaises(SatelliteError):
            ESASentinelPlans().upcoming(AcquisitionQuery(0, 0, 1000, days=0))

if __name__ == "__main__":
    unittest.main()
