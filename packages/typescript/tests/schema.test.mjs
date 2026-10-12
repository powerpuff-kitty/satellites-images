import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { StacProvider, summarizeAvailability } from "../dist/index.js";

const load = (name) => JSON.parse(readFileSync(new URL("../../../specs/" + name, import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(load("scene.schema.json"));
ajv.addSchema(load("acquisition.schema.json"));
const validateScene = ajv.getSchema("https://github.com/powerpuff-kitty/satellites-images/blob/main/specs/scene.schema.json");
const validatePage = ajv.compile(load("searchpage.schema.json"));
const validateAvailability = ajv.compile(load("availability.schema.json"));

const sample = {
  type: "FeatureCollection",
  features: [{
    type: "Feature", id: "S2_page", collection: "sentinel-2-l2a",
    geometry: { type: "Polygon", coordinates: [[[116, -9], [117, -9], [117, -8], [116, -8], [116, -9]]] },
    bbox: [116, -9, 117, -8],
    properties: { datetime: "2025-01-10T02:12:00Z", platform: "sentinel-2a", "eo:cloud_cover": 12.5 },
    assets: { thumbnail: { href: "https://example.test/t.jpg", roles: ["thumbnail"], type: "image/jpeg" } },
    links: [{ rel: "self", href: "https://earth-search.aws.element84.com/v1/items/S2_page" }],
  }],
  links: [],
  context: { matched: 1 },
};

test("normalized scene, page, and availability satisfy the JSON schemas", async () => {
  const mock = async () => new Response(JSON.stringify(sample), { status: 200 });
  const provider = new StacProvider({
    id: "earth-search", baseUrl: "https://earth-search.aws.element84.com/v1",
    collections: ["sentinel-2-l2a"], fetchImpl: mock,
  });
  const pages = [];
  for await (const page of provider.search({ latitude: -8.5833, longitude: 116.1167, radiusMeters: 5000, from: "2025-01-01", to: "2025-01-31" })) pages.push(page);
  assert.ok(validateScene(pages[0].items[0]), JSON.stringify(validateScene.errors));
  assert.ok(validatePage(pages[0]), JSON.stringify(validatePage.errors));
  const summary = summarizeAvailability(pages);
  assert.ok(validateAvailability(summary), JSON.stringify(validateAvailability.errors));
});
