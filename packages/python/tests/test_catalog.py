import unittest

from satellites_images import (
    AsfSearch, CmrStac, CopernicusDataSpace, EarthSearch, JaxaGPortal, PlanetaryComputer, SatelliteCatalog, SatelliteError,
    SearchQuery, UsgsLandsatLook, to_json,
    bounds_around, coverage_percent, declared_imagery_access, list_sources,
    polygon_boxes, radius_boxes, resolve_areas,
)
import json

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

    def test_registry_includes_paid_and_free_sources(self):
        sources = list_sources()
        self.assertGreaterEqual(len(sources), 12)
        self.assertTrue(next(s for s in sources if s["id"] == "earth-search")["implemented"]["python"])
        self.assertFalse(next(s for s in sources if s["id"] == "skyfi")["implemented"]["python"])

    def test_stac_reuse_adapters(self):
        self.assertEqual(CopernicusDataSpace().id, "copernicus")
        self.assertEqual(UsgsLandsatLook().id, "usgs-landsatlook")
        self.assertEqual(CmrStac("ASF", ("sentinel-1-rtc",)).id, "nasa-cmr:ASF")
        with self.assertRaises(SatelliteError):
            CmrStac("bad id", ("x",))

        def mock(url, method, body):
            return {**SAMPLE, "features": [{**SAMPLE["features"][0], "id": "S2C_x"}], "links": []}
        pages = list(SatelliteCatalog([CopernicusDataSpace(transport=mock)]).search(self.query))
        self.assertEqual(pages[0].items[0].provider_id, "copernicus")

    def test_asf_search_adapter(self):
        requests = []

        def mock(url, method, body):
            requests.append(url)
            return {"type": "FeatureCollection", "features": [{
                "type": "Feature", "geometry": {"type": "Point", "coordinates": [116.1, -8.6]},
                "properties": {"granuleName": "S1A_EW_GRDM_1SDH_example",
                               "startTime": "2025-01-10T02:00:00Z", "stopTime": "2025-01-10T02:00:30Z",
                               "platform": "Sentinel-1", "processingLevel": "GRD_HD",
                               "browse": ["https://example.test/asf-browse.png"],
                               "downloadUrl": "https://datapool.asf.alaska.edu/GRD_HD/example.zip"},
            }]}
        pages = list(SatelliteCatalog([AsfSearch(transport=mock)]).search(self.query))
        self.assertTrue(requests[0].startswith("https://api.daac.asf.alaska.edu/services/search/param?"))
        self.assertIn("output=geojson", requests[0])
        self.assertEqual(pages[0].items[0].provider_id, "asf-vertex")
        self.assertEqual(pages[0].items[0].mission, "Sentinel-1")
        self.assertEqual(pages[0].items[0].acquired_at, "2025-01-10T02:00:00.000Z")
        self.assertEqual(pages[0].items[0].preview_url, "https://example.test/asf-browse.png")
        self.assertEqual(pages[0].items[0].access, "authentication-required",
                         "ASF downloads need Earthdata login")

    def test_declared_imagery_access(self):
        # Registry-derived defaults.
        self.assertEqual(declared_imagery_access("usgs-landsatlook"), "open")
        self.assertEqual(declared_imagery_access("copernicus"), "authentication-required")
        self.assertEqual(declared_imagery_access("asf-vertex"), "authentication-required")
        self.assertEqual(declared_imagery_access("jaxa-gportal"), "authentication-required")
        # Coarse registry values stay unknown instead of being guessed.
        self.assertEqual(declared_imagery_access("earth-search"), "unknown")
        self.assertEqual(declared_imagery_access("earth-search", "unknown-collection"), "unknown")
        self.assertEqual(declared_imagery_access("not-a-source"), "unknown")
        # Collection and sub-provider refinements.
        self.assertEqual(declared_imagery_access("earth-search", "sentinel-2-l2a"), "open")
        self.assertEqual(declared_imagery_access("earth-search", "landsat-c2-l2"), "authentication-required")
        self.assertEqual(declared_imagery_access("planetary-computer", "naip"), "open")
        self.assertEqual(declared_imagery_access("nasa-cmr:ASF"), "authentication-required")
        self.assertEqual(declared_imagery_access("nasa-cmr:LPCLOUD"), "unknown")

    def test_jaxa_granule_adapter(self):
        requests = []
        fixture = {"type": "FeatureCollection",
                   "properties": {"numberOfRecordsMatched": 267, "numberOfRecordsReturned": 1},
                   "features": [{"type": "Feature",
                     "geometry": {"type": "Polygon", "coordinates": [[[140.88, 46.45], [141.0, 46.5], [140.9, 46.6], [140.88, 46.45]]]},
                     "properties": {"identifier": "GC1SG1_202107070007J00424_L2SG_SSTNQ_3000",
                                    "beginPosition": "2021-07-07T00:07:08.58Z", "endPosition": "2021-07-07T00:09:48.22Z",
                                    "processingDate": "2022-03-02T16:33:32.00Z", "platformShortName": "GCOM-C",
                                    "product": {"fileName": "https://gportal.jaxa.jp/download/standard/x.h5", "DataFormatType": "HDF5"},
                                    "browse": [{"type": "QUICKLOOK", "fileName": "https://gportal.jaxa.jp/gpr/img/x.jpg"}],
                                    "gpp": {"datasetId": "10002002", "Resolution": "250m", "cloudCoverPercentage": "6"}}}]}

        def mock(url, method, body):
            requests.append(url)
            return fixture
        query = SearchQuery(latitude=-8.5833, longitude=116.1167, radius_meters=5000,
                            start="2021-07-07", end="2021-07-07")
        pages = list(JaxaGPortal("10002002", transport=mock).search(query))
        self.assertTrue(requests[0].startswith("https://gportal.jaxa.jp/csw/csw?"))
        self.assertIn("outputFormat=", requests[0])
        self.assertEqual(pages[0].items[0].provider_id, "jaxa-gportal")
        self.assertEqual(pages[0].items[0].acquired_at, "2021-07-07T00:07:08.580Z")
        self.assertEqual(pages[0].items[0].mission, "GCOM-C")
        self.assertEqual(pages[0].items[0].cloud_cover_percent, 6.0)
        self.assertEqual(pages[0].items[0].preview_url, "https://gportal.jaxa.jp/gpr/img/x.jpg")
        with self.assertRaises(SatelliteError):
            JaxaGPortal("GCOM-C_SGLI_L2_SST_250m")

    def test_retry_honours_retry_after(self):
        calls = []

        def transport(url, method, body):
            calls.append(url)
            if len(calls) == 1:
                raise SatelliteError("HTTP_ERROR", "STAC API returned HTTP 429 retry-after=0")
            return {**SAMPLE, "links": []}
        provider = EarthSearch(transport=transport, retries=2, retry_base_delay_ms=1)
        pages = list(provider.search(self.query))
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(pages), 1)

    def test_persistent_429_fails_explicitly(self):
        calls = []

        def transport(url, method, body):
            calls.append(url)
            raise SatelliteError("HTTP_ERROR", "STAC API returned HTTP 429 retry-after=0")
        provider = EarthSearch(transport=transport, retries=2, retry_base_delay_ms=1)
        with self.assertRaises(SatelliteError) as context:
            list(provider.search(self.query))
        self.assertEqual(context.exception.code, "HTTP_ERROR")
        self.assertEqual(len(calls), 3)

    def test_403_and_signed_assets_never_fetched(self):
        def forbidden(url, method, body):
            raise SatelliteError("HTTP_ERROR", "STAC API returned HTTP 403")
        with self.assertRaises(SatelliteError) as context:
            list(EarthSearch(transport=forbidden).search(self.query))
        self.assertEqual(context.exception.code, "HTTP_ERROR")

        signed = {**SAMPLE, "links": [], "features": [{**SAMPLE["features"][0],
            "assets": {"data": {"href": "https://example.test/data.tif?token=expired&Signature=abc",
                                "roles": ["data"], "type": "image/tiff"}}}]}
        seen = []

        def transport(url, method, body):
            seen.append(url)
            return signed
        pages = list(EarthSearch(transport=transport).search(self.query))
        scene = pages[0].items[0]
        self.assertEqual(scene.access, "open", "the declared class for this provider and collection")
        self.assertEqual(scene.assets[0].access, "unknown", "per-asset entitlement is never assumed")
        self.assertIn("token=expired", scene.assets[0].href)
        self.assertEqual(len(seen), 1, "signed asset bytes are never fetched")

    def test_camel_case_serialization(self):
        def mock(url, method, body):
            return SAMPLE
        pages = list(EarthSearch(transport=mock).search(self.query))
        payload = json.loads(to_json(pages[0].items[0]))
        for key in ("providerId", "acquiredAt", "cloudCoverPercent", "previewUrl", "sourceUrl"):
            self.assertIn(key, payload)
        self.assertIsInstance(payload["raw"], dict)

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
        self.assertEqual(pages[0].items[0].access, "open")
        self.assertEqual(pages[0].items[0].preview_url, "https://example.test/thumb.jpg")
        self.assertEqual(seen[1][2]["token"], "page2")
        self.assertIn("bbox", seen[1][2])

    def test_planetary_computer_queries_radar_and_aerial_collections(self):
        seen = []
        def mock(url, method, body):
            seen.append(dict(body or {}))
            return {"type": "FeatureCollection", "features": [], "links": []}
        list(SatelliteCatalog([PlanetaryComputer(transport=mock)]).search(self.query))
        self.assertEqual(
            seen[0]["collections"],
            ["sentinel-2-l2a", "landsat-c2-l2", "sentinel-1-rtc", "naip"],
        )

    def test_polygon_aoi_sends_intersects_not_bbox(self):
        import dataclasses
        seen = []
        def mock(url, method, body):
            seen.append(dict(body or {}))
            return {"type": "FeatureCollection", "features": [], "links": []}
        aoi = {"type": "Polygon", "coordinates": [[[116, -9], [117, -9], [117, -8], [116, -8], [116, -9]]]}
        query = dataclasses.replace(self.query, aoi=aoi)
        list(EarthSearch(transport=mock).search(query))
        self.assertEqual(len(seen), 1)          # one request, not one per split box
        self.assertIn("intersects", seen[0])
        self.assertNotIn("bbox", seen[0])

    def test_thumbnail_link_fallback_for_non_http_assets(self):
        item = {
            "type": "Feature", "id": "LC09_1", "collection": "landsat-c2-l2", "bbox": [1, 2, 3, 4],
            "properties": {"datetime": "2025-01-10T02:12:00Z", "platform": "landsat-9"},
            "assets": {"thumbnail": {"href": "s3://usgs-landsat/collection02/LC09_1_thumb_small.jpeg",
                                     "type": "image/jpeg", "roles": ["thumbnail"]}},
            "links": [
                {"rel": "self", "href": "https://earth-search.aws.element84.com/v1/collections/landsat-c2-l2/items/LC09_1"},
                {"rel": "thumbnail", "href": "https://earth-search.aws.element84.com/v1/collections/landsat-c2-l2/items/LC09_1/thumbnail"},
            ],
        }
        def mock(url, method, body):
            return {"type": "FeatureCollection", "features": [item], "links": []}
        catalog = SatelliteCatalog([EarthSearch(transport=mock)])
        pages = list(catalog.search(self.query))
        self.assertEqual(
            pages[0].items[0].preview_url,
            "https://earth-search.aws.element84.com/v1/collections/landsat-c2-l2/items/LC09_1/thumbnail",
        )

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
