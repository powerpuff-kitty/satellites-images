import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as sdk from "../dist/index.js";
import { checkConformance } from "../../../tools/conformance/typescript.mjs";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

test("shared cross-language scene, pagination and availability contracts", async () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/conformance/stac.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const schema = name => JSON.parse(readFileSync(new URL("../../../specs/" + name, import.meta.url), "utf8"));
  ajv.addSchema(schema("scene.schema.json"));
  const page = ajv.compile(schema("searchpage.schema.json"));
  const availability = ajv.compile(schema("availability.schema.json"));
  for (const scenario of fixture.stacCases) {
    for (const value of scenario.expectedPages) assert.ok(page(value), scenario.name + ": " + JSON.stringify(page.errors));
    assert.ok(availability(scenario.expectedSummary), scenario.name + ": " + JSON.stringify(availability.errors));
  }
  for (const scenario of fixture.maxarCases ?? []) {
    for (const value of scenario.expectedPages) assert.ok(page(value), scenario.name + ": " + JSON.stringify(page.errors));
  }
  for (const scenario of fixture.availabilityCases) {
    assert.ok(availability(scenario.expectedSummary), scenario.name + ": " + JSON.stringify(availability.errors));
  }
  await checkConformance(sdk, fixture);
});
