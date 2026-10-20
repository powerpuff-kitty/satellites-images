import unittest
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from unittest.mock import patch

from satellites_images import (AvailabilityAccumulator, AsfSearch, JaxaGPortal, OpenAerialMap,
                              SatelliteCatalog, SatelliteError, SearchPage, SearchQuery, StacProvider,
                              list_sources, normalize_asf_feature, summarize_availability)
from satellites_images import catalog
from satellites_images.acquisitions import _http_text


def item(identifier, collection="a"):
    return {"id": identifier, "collection": collection,
            "properties": {"datetime": "2025-01-10T02:00:00Z"}, "assets": {}}


def oam_record(identifier):
    return {"_id": identifier, "acquisition_start": "2025-01-10T02:00:00Z"}


class RegressionTests(unittest.TestCase):
    def setUp(self):
        self.query = SearchQuery(latitude=0, longitude=0, radius_meters=5000,
                                 start="2025-01-01", end="2025-01-31", limit=2, max_pages=1)

    def test_stac_identity_includes_collection(self):
        provider = StacProvider(id="test", base_url="https://example.test", collections=("a", "b"),
                                transport=lambda *_: {"features": [item("same", "a"), item("same", "b"), item("same", "a")], "links": []})
        pages = list(provider.search(self.query))
        self.assertEqual([(s.collection, s.id) for s in pages[0].items], [("a", "same"), ("b", "same")])
        self.assertEqual(summarize_availability(pages).unique_items, 2)

    def test_failure_does_not_hide_later_providers_or_claim_completeness(self):
        class Provider:
            def __init__(self, identifier, broken=False):
                self.id, self.broken = identifier, broken

            def search(self, query):
                if self.broken:
                    raise SatelliteError("HTTP_ERROR", "Unavailable", self.id)
                yield SearchPage(self.id, (), 1, False, 0)

        client = SatelliteCatalog([Provider("first"), Provider("broken", True), Provider("last")])
        summary = client.availability(self.query)
        self.assertFalse(summary.complete)
        self.assertEqual(summary.errored_providers, ("broken",))
        self.assertEqual([p.id for p in summary.providers], ["broken", "first", "last"])
        self.assertEqual(summary.pages_scanned, 2)
        with self.assertRaises(SatelliteError):
            client.availability(self.query, ["missing"])

    def test_accumulator_pending_providers_and_invalid_page_are_transactional(self):
        accumulator = AvailabilityAccumulator()
        accumulator.expect_provider("pending")
        scene = catalog._normalized_scene(item("one"), "test")
        with self.assertRaises(SatelliteError):
            accumulator.add_page(SearchPage("test", (replace(scene, acquired_at="2025-02-30T02:00:00Z"),), 1, False, 1))
        self.assertEqual(accumulator.summary().pages_scanned, 0)
        accumulator.add_page(SearchPage("test", (scene,), 1, False, 1))
        self.assertFalse(accumulator.summary().complete)
        accumulator.add_page(SearchPage("pending", (), 1, False, 0))
        self.assertTrue(accumulator.summary().complete)
        accumulator.mark_error("failed")
        self.assertFalse(accumulator.summary().complete)

    def test_oam_page_budget_preserves_split_truncation(self):
        requests = []

        def transport(url, *_):
            requests.append(url)
            return ({"results": [oam_record("one")], "meta": {"found": 3}} if len(requests) == 1
                    else {"results": [], "meta": {"found": 0}})

        query = replace(self.query, longitude=180, limit=1)
        pages = list(OpenAerialMap(limit=1, transport=transport).search(query))
        self.assertEqual(len(requests), 2)
        self.assertTrue(pages[-1].has_next)
        self.assertFalse(summarize_availability(pages).complete)

    def test_oam_searches_both_completed_boxes(self):
        requests = []

        def transport(url, *_):
            requests.append(url)
            return {"results": [oam_record(str(len(requests)))], "meta": {"found": 1}}

        pages = list(OpenAerialMap(transport=transport).search(replace(self.query, longitude=180)))
        summary = summarize_availability(pages)
        self.assertEqual(len(requests), 2)
        self.assertEqual(summary.unique_items, 2)
        self.assertTrue(summary.complete)

    def test_capped_asf_and_jaxa_results_remain_partial(self):
        feature = {"properties": {"granuleName": "one", "startTime": "2025-01-10T02:00:00Z"}}
        pages = list(AsfSearch(transport=lambda *_: {"features": [feature, feature]}).search(self.query))
        self.assertEqual(len(pages[0].items), 1)
        self.assertIsNone(pages[0].matched)
        self.assertFalse(summarize_availability(pages).complete)
        jaxa = JaxaGPortal(dataset_id="10002002", count=1, transport=lambda *_: {
            "features": [{"properties": {"identifier": "one", "beginPosition": "2025-01-10T02:00:00Z"}}],
            "properties": {"numberOfRecordsMatched": 2}})
        self.assertFalse(summarize_availability(list(jaxa.search(self.query))).complete)

    def test_registry_is_read_once_and_public_results_stay_detached(self):
        catalog._source_registry.cache_clear()
        catalog._provider_access.cache_clear()
        feature = {"properties": {"granuleName": "one", "startTime": "2025-01-10T02:00:00Z"}}
        with patch.object(catalog, "files", wraps=catalog.files) as resource:
            for _ in range(10):
                normalize_asf_feature(feature)
            first = list_sources()
            identifier = first[0]["id"]
            first[0]["id"] = "mutated"
            first[0]["implemented"]["python"] = "mutated"
            second = list_sources()
            self.assertEqual(second[0]["id"], identifier)
            self.assertIsInstance(second[0]["implemented"]["python"], bool)
            self.assertEqual(resource.call_count, 1)


class RedirectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hits = []

        class Target(BaseHTTPRequestHandler):
            def do_GET(self):
                cls.hits.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")
            do_POST = do_GET
            def log_message(self, *_):
                pass

        cls.target = ThreadingHTTPServer(("127.0.0.1", 0), Target)

        class Source(Target):
            def do_GET(self):
                if self.path == "/destination":
                    return super().do_GET()
                status = int(self.path.split("/")[-1])
                destination = (cls.source.server_port if self.path.startswith("/same/") else cls.target.server_port)
                self.send_response(status)
                self.send_header("Location", f"http://127.0.0.1:{destination}/destination")
                self.end_headers()
            do_POST = do_GET

        cls.source = ThreadingHTTPServer(("127.0.0.1", 0), Source)
        cls.threads = []
        for server in (cls.source, cls.target):
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            cls.threads.append(thread)

    @classmethod
    def tearDownClass(cls):
        for server in (cls.source, cls.target):
            server.shutdown()
            server.server_close()
        for thread in cls.threads:
            thread.join()

    def test_redirects_are_refused_before_contacting_any_destination(self):
        for kind in ("same", "other"):
            for status in (301, 302, 303, 307, 308):
                url = f"http://127.0.0.1:{self.source.server_port}/{kind}/{status}"
                for request in (lambda: catalog._http_json(url, "POST", {}),
                                lambda: catalog._http_json(url, "GET", None),
                                lambda: _http_text(url, 1000)):
                    with self.subTest(kind=kind, status=status):
                        with self.assertRaises(SatelliteError) as error:
                            request()
                        self.assertEqual(error.exception.code, "HTTP_ERROR")
                        self.assertEqual(self.hits, [])
