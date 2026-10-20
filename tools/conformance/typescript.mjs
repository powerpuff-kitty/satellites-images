import assert from "node:assert/strict";

/** Run shared contracts against either workspace builds or an installed npm package. */
export async function checkConformance(sdk, fixture) {
  assert.equal(fixture.version, 1, "Unsupported conformance fixture version");
  assert.ok(fixture.stacCases.length > 0 && fixture.availabilityCases.length > 0, "Conformance cases cannot be empty");
  for (const scenario of fixture.stacCases) {
    const requests = [];
    const provider = new sdk.StacProvider({
      id: fixture.providerId, baseUrl: "https://conformance.test", collections: scenario.query.collections,
      fetchImpl: async (href, init) => {
        const url = new URL(href);
        requests.push({ method: init.method, path: url.pathname + url.search,
          body: init.body ? JSON.parse(init.body) : null });
        assert.ok(requests.length <= scenario.responses.length, scenario.name + ": unexpected request");
        return Response.json(scenario.responses[requests.length - 1]);
      },
    });
    const pages = [];
    for await (const page of provider.search(scenario.query)) pages.push(page);
    assert.deepEqual(requests, scenario.expectedRequests, scenario.name + ": requests");
    assert.deepEqual(pages, scenario.expectedPages, scenario.name + ": pages");
    assert.deepEqual(sdk.summarizeAvailability(pages), scenario.expectedSummary, scenario.name + ": summary");
  }
  for (const scenario of fixture.maxarCases ?? []) {
    const requests = [];
    const provider = sdk.maxarOpenData({ ...scenario.options, catalogUrl: "https://conformance.test/events/catalog.json",
      fetchImpl: async (href, init) => {
        const url = new URL(href);
        requests.push({method:init.method,path:url.pathname + url.search,body:null});
        assert.ok(requests.length <= scenario.responses.length, scenario.name + ": unexpected metadata request");
        return Response.json(scenario.responses[requests.length - 1]);
      }
    });
    const pages = [];
    try {
      for await (const page of provider.search(scenario.query)) pages.push(page);
      assert.equal(scenario.expectedError, undefined, scenario.name + ": expected failure");
    } catch (error) { assert.equal(error.code, scenario.expectedError, scenario.name + ": error"); }
    assert.deepEqual(requests,scenario.expectedRequests,scenario.name + ": requests");
    assert.deepEqual(pages,scenario.expectedPages,scenario.name + ": pages");
    assert.equal(sdk.summarizeAvailability(pages).complete,
      pages.length > 0 && !pages.at(-1).hasNext,scenario.name + ": completeness");
  }
  for (const scenario of fixture.availabilityCases) {
    const accumulator = new sdk.AvailabilityAccumulator();
    for (const id of scenario.expectedProviders) accumulator.expectProvider(id);
    for (const page of scenario.pages) accumulator.addPage(page);
    for (const id of scenario.erroredProviders) accumulator.markError(id);
    assert.deepEqual(accumulator.summary(), scenario.expectedSummary, scenario.name + ": summary");
  }
  return fixture.stacCases.length + fixture.availabilityCases.length + (fixture.maxarCases?.length ?? 0);
}
