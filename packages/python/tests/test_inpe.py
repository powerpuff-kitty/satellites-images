import json
from pathlib import Path
import unittest

from satellites_images import InpeCbers, SearchQuery


class InpeTests(unittest.TestCase):
    def test_recorded_item_preserves_unknowns_and_real_asset_keys(self):
        item = json.loads((Path(__file__).resolve().parents[3] / "tests/fixtures/inpe-cbers-item.json").read_text())

        def transport(url, method, body):
            self.assertEqual(url, "https://data.inpe.br/bdc/stac/v1/search")
            self.assertEqual(body["collections"], ["CB4A-WPM-PCA-FUSED-1"])
            return {"type": "FeatureCollection", "features": [item], "links": []}

        pages = list(InpeCbers(transport=transport).search(SearchQuery(
            latitude=-7.15, longitude=-38.1, radius_meters=25000,
            start="2026-10-13", end="2026-10-13", max_pages=1)))
        scene = pages[0].items[0]
        self.assertEqual(scene.provider_id, "inpe-cbers")
        self.assertEqual(scene.preview_url, item["assets"]["thumbnail"]["href"])
        self.assertTrue(any(a.key == "tci" for a in scene.assets))
        self.assertEqual(scene.access, "open")
        self.assertTrue(all(a.access == "unknown" for a in scene.assets))
        self.assertIsNone(scene.mission)
        self.assertIsNone(scene.gsd_meters)
        self.assertIsNone(scene.cloud_cover_percent)
        self.assertEqual(scene.raw, item)
