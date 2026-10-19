import { test } from "node:test";
import assert from "node:assert/strict";
import { AvailabilityAccumulator, SatelliteCatalog, SatelliteError, StacProvider,
  asfSearch, jaxaGPortal, openAerialMap, normalizeAsfFeature, normalizeJaxaFeature,
  normalizeOamRecord, summarizeAvailability } from "../dist/index.js";
import { readTextBounded } from "../dist/transport.js";

const query = { latitude: 0, longitude: 0, radiusMeters: 5000,
  from: "2025-01-01", to: "2025-01-31", limit: 2, maxPages: 1 };
const item = (id, collection = "a", datetime = "2025-01-10T02:00:00Z") =>
  ({ id, collection, properties: { datetime }, assets: {}, links: [] });
const collect = async (provider, q = query) => {
  const pages = [];
  for await (const page of provider.search(q)) pages.push(page);
  return pages;
};
const stac = features => new StacProvider({ id: "test", baseUrl: "https://example.test",
  collections: ["a", "b"], fetchImpl: async () => Response.json({ features, links: [] }) });
const oamRecord = id => ({ _id: id, acquisition_start: "2025-01-10T02:00:00Z" });

test("STAC identity includes collection and removes repeats within a page", async () => {
  const pages = await collect(stac([item("same", "a"), item("same", "b"), item("same", "a")]));
  assert.deepEqual(pages[0].items.map(scene => [scene.collection, scene.id]), [["a", "same"], ["b", "same"]]);
  assert.equal(summarizeAvailability(pages).uniqueItems, 2);
});

test("availability retains healthy providers after a failure and never claims completeness", async () => {
  const good = id => ({ id, async *search() {
    yield { providerId: id, pageNumber: 1, hasNext: false, matched: 0, items: [] };
  } });
  const broken = { id: "broken", async *search() { throw new SatelliteError("HTTP_ERROR", "Unavailable", "broken"); } };
  const catalog = new SatelliteCatalog([good("first"), broken, good("last")]);
  const summary = await catalog.availability(query);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.erroredProviders, ["broken"]);
  assert.deepEqual(summary.providers.map(provider => provider.id), ["broken", "first", "last"]);
  assert.equal(summary.pagesScanned, 2);
  await assert.rejects(catalog.availability(query, ["missing"]), { code: "UNSUPPORTED_PROVIDER" });
  await assert.rejects(catalog.availability({ ...query, maxPages: 0 }), { code: "INVALID_QUERY" });
});

test("pending providers and invalid pages cannot corrupt availability", async () => {
  const accumulator = new AvailabilityAccumulator();
  accumulator.expectProvider("pending");
  const scene = (await collect(stac([item("one")])))[0].items[0];
  const page = { providerId: "test", pageNumber: 1, hasNext: false, matched: 1, items: [scene] };
  assert.throws(() => accumulator.addPage({ ...page, items: [{ ...scene, acquiredAt: "2025-02-30T02:00:00Z" }] }));
  assert.equal(accumulator.summary().pagesScanned, 0);
  accumulator.addPage(page);
  assert.equal(accumulator.summary().complete, false);
  accumulator.addPage({ ...page, providerId: "pending", items: [], matched: 0 });
  assert.equal(accumulator.summary().complete, true);
  accumulator.markError("failed");
  assert.equal(accumulator.summary().complete, false);
});

test("all scene adapters reject timezone-free and impossible acquisition timestamps", async () => {
  for (const date of ["2025-01-10T02:00:00", "2025-02-30T02:00:00Z", "2025-01-10T24:00:00Z"]) {
    const pages = await collect(stac([item("bad", "a", date)]));
    assert.equal(pages[0].skipped, 1);
    assert.equal(pages[0].items.length, 0);
    assert.throws(() => normalizeAsfFeature({ properties: { granuleName: "bad", startTime: date } }), { code: "INVALID_RESPONSE" });
    assert.throws(() => normalizeJaxaFeature({ properties: { identifier: "bad", beginPosition: date } }), { code: "INVALID_RESPONSE" });
    assert.throws(() => normalizeOamRecord({ _id: "bad", acquisition_start: date }), { code: "INVALID_RESPONSE" });
  }
  const page = (await collect(stac([item("offset", "a", "2025-01-10T00:30:00+02:00")])))[0];
  assert.equal(page.items[0].acquiredAt, "2025-01-09T22:30:00.000Z");
  assert.equal(summarizeAvailability([page]).days[0].date, "2025-01-09");
});

test("unusual mission and collection names stay ordinary count keys", async () => {
  const page = (await collect(stac([item("one", "__proto__")])))[0];
  page.items[0].mission = "constructor";
  const day = summarizeAvailability([page]).days[0];
  assert.equal(day.missions.constructor, 1);
  assert.equal(day.collections.__proto__, 1);
});

test("ASF and JAXA capped responses stay partial and deduplicate within their pages", async () => {
  const feature = { properties: { granuleName: "one", startTime: "2025-01-10T02:00:00Z" } };
  const pages = await collect(asfSearch({ fetchImpl: async () => Response.json({ features: [feature, feature] }) }));
  assert.equal(pages[0].items.length, 1);
  assert.equal(pages[0].matched, null);
  assert.equal(summarizeAvailability(pages).complete, false);
  const jaxa = await collect(jaxaGPortal({ datasetId: "10002002", count: 1, fetchImpl: async () => Response.json({
    features: [{ properties: { identifier: "one", beginPosition: "2025-01-10T02:00:00Z" } }],
    properties: { numberOfRecordsMatched: 2 },
  }) }));
  assert.equal(summarizeAvailability(jaxa).complete, false);
});

test("OpenAerialMap applies a page budget per box and preserves earlier truncation", async () => {
  let requests = 0;
  const provider = openAerialMap({ limit: 1, fetchImpl: async () => {
    requests++;
    return Response.json(requests === 1 ? { results: [oamRecord("one")], meta: { found: 3 } }
      : { results: [], meta: { found: 0 } });
  } });
  const pages = await collect(provider, { ...query, longitude: 180, limit: 1 });
  assert.equal(requests, 2);
  assert.equal(pages.length, 2);
  assert.equal(pages[1].hasNext, true);
  assert.equal(summarizeAvailability(pages).complete, false);
  const invalid = openAerialMap({ fetchImpl: async () => Response.json({ error: "invalid upstream shape" }) });
  await assert.rejects(collect(invalid), { code: "INVALID_RESPONSE" });
  await assert.rejects(collect(provider, { ...query, maxPages: 0 }), { code: "INVALID_QUERY" });
});

test("OpenAerialMap searches both sides when the first box has no more pages", async () => {
  const urls = [];
  const provider = openAerialMap({ fetchImpl: async url => {
    urls.push(String(url));
    return Response.json({ results: [oamRecord(String(urls.length))], meta: { found: 1 } });
  } });
  const pages = await collect(provider, { ...query, longitude: 180 });
  assert.equal(urls.length, 2);
  assert.equal(summarizeAvailability(pages).uniqueItems, 2);
  assert.equal(summarizeAvailability(pages).complete, true);
});

test("response limits cancel chunked bodies before buffering the entire document", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(600)); controller.enqueue(new Uint8Array(600)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readTextBounded(response, 1000, "esa-sentinel-plans"), { code: "INVALID_RESPONSE" });
  assert.equal(cancelled, true);
});
