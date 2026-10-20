"""Shared contracts for both source imports and an installed wheel."""
import json
import sys
from urllib.parse import urlsplit


def _equal(actual, expected, label):
    if actual != expected:
        raise AssertionError(label + "\nactual: " + json.dumps(actual, sort_keys=True)
                             + "\nexpected: " + json.dumps(expected, sort_keys=True))


def _page(sdk, value):
    scenes = []
    for value_scene in value["items"]:
        scenes.append(sdk.Scene(
            provider_id=value_scene["providerId"], id=value_scene["id"], collection=value_scene["collection"],
            acquired_at=value_scene["acquiredAt"], mission=value_scene["mission"], geometry=value_scene["geometry"],
            bbox=value_scene["bbox"], cloud_cover_percent=value_scene["cloudCoverPercent"],
            gsd_meters=value_scene["gsdMeters"], coverage_percent=value_scene["coveragePercent"],
            preview_url=value_scene["previewUrl"], access=value_scene["access"], source_url=value_scene["sourceUrl"],
            assets=tuple(sdk.SceneAsset(asset["key"], asset["href"], asset["type"], tuple(asset["roles"]), asset["access"])
                         for asset in value_scene["assets"]), raw=value_scene["raw"],
        ))
    return sdk.SearchPage(value["providerId"], tuple(scenes), value["pageNumber"], value["hasNext"],
                          value["matched"], value["skipped"])


def check_conformance(sdk, fixture):
    if fixture["version"] != 1:
        raise AssertionError("Unsupported conformance fixture version")
    if not fixture["stacCases"] or not fixture["availabilityCases"]:
        raise AssertionError("Conformance cases cannot be empty")
    for scenario in fixture["stacCases"]:
        requests = []

        def transport(href, method, body):
            parsed = urlsplit(href)
            requests.append({"method": method, "path": parsed.path + ("?" + parsed.query if parsed.query else ""), "body": body})
            if len(requests) > len(scenario["responses"]):
                raise AssertionError(scenario["name"] + ": unexpected request")
            return scenario["responses"][len(requests) - 1]

        q = scenario["query"]
        query = sdk.SearchQuery(aoi=q["aoi"], start=q["from"], end=q["to"],
                                collections=tuple(q["collections"]), limit=q["limit"], max_pages=q["maxPages"])
        provider = sdk.StacProvider(id=fixture["providerId"], base_url="https://conformance.test",
                                    collections=query.collections, transport=transport)
        pages = list(provider.search(query))
        _equal(requests, scenario["expectedRequests"], scenario["name"] + ": requests")
        _equal(json.loads(sdk.to_json(pages)), scenario["expectedPages"], scenario["name"] + ": pages")
        _equal(json.loads(sdk.to_json(sdk.summarize_availability(pages))), scenario["expectedSummary"], scenario["name"] + ": summary")
    for scenario in fixture.get("maxarCases", []):
        requests = []
        def transport(href, method, body):
            parsed = urlsplit(href)
            requests.append({"method":method,"path":parsed.path,"body":body})
            assert len(requests) <= len(scenario["responses"]), scenario["name"] + ": unexpected metadata request"
            return scenario["responses"][len(requests)-1]
        q = scenario["query"]
        query = sdk.SearchQuery(aoi=q["aoi"],start=q["from"],end=q["to"],collections=tuple(q["collections"]),limit=q["limit"],max_pages=q["maxPages"])
        provider = sdk.MaxarOpenData(transport, catalog_url="https://conformance.test/events/catalog.json",
                                    max_documents=scenario["options"].get("maxDocuments",2000))
        pages = []
        try:
            pages.extend(provider.search(query))
            assert "expectedError" not in scenario, scenario["name"] + ": expected failure"
        except sdk.SatelliteError as error:
            _equal(error.code,scenario.get("expectedError"),scenario["name"] + ": error")
        _equal(requests,scenario["expectedRequests"],scenario["name"] + ": requests")
        _equal(json.loads(sdk.to_json(pages)),scenario["expectedPages"],scenario["name"] + ": pages")
        _equal(sdk.summarize_availability(pages).complete, bool(pages) and not pages[-1].has_next, scenario["name"] + ": completeness")
    for scenario in fixture["availabilityCases"]:
        accumulator = sdk.AvailabilityAccumulator()
        for provider_id in scenario["expectedProviders"]:
            accumulator.expect_provider(provider_id)
        for page in scenario["pages"]:
            accumulator.add_page(_page(sdk, page))
        for provider_id in scenario["erroredProviders"]:
            accumulator.mark_error(provider_id)
        _equal(json.loads(sdk.to_json(accumulator.summary())), scenario["expectedSummary"], scenario["name"] + ": summary")
    return len(fixture["stacCases"]) + len(fixture["availabilityCases"]) + len(fixture.get("maxarCases", []))


if __name__ == "__main__":
    import satellites_images
    with open(sys.argv[1], encoding="utf-8") as stream:
        count = check_conformance(satellites_images, json.load(stream))
    print(f"PASS: {count} installed Python package conformance cases")
