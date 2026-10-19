import importlib.util
import json
from pathlib import Path
import unittest

import satellites_images

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("shared_conformance", ROOT / "tools/conformance/python.py")
conformance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(conformance)


class ConformanceTests(unittest.TestCase):
    def test_shared_contracts(self):
        fixture = json.loads((ROOT / "tests/fixtures/conformance/stac.json").read_text())
        conformance.check_conformance(satellites_images, fixture)
