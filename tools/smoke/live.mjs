// Opt-in live smoke test. NOT part of CI and NOT run by `npm run check`.
// Makes real network calls to public providers to confirm reachability, auth-free
// metadata search, and that fail-closed redirect handling does not break normal use.
//
//   node tools/smoke/live.mjs
//
// No credentials are used; results are whatever the public services return today.
import { SatelliteCatalog, earthSearch, copernicusDataSpace, usgsLandsatLook, cmrStac,
  asfSearch, jaxaGPortal, esaSentinelPlans } from "../../packages/typescript/dist/index.js";

const base = { latitude: -8.5833, longitude: 116.1167, radiusMeters: 25000, maxPages: 1, limit: 5 };
async function run(name, fn) {
  const started = Date.now();
  try { console.log(`OK   ${name.padEnd(18)} ${Date.now() - started}ms  ${await fn()}`); }
  catch (error) { console.log(`FAIL ${name.padEnd(18)} ${Date.now() - started}ms  ${error.code ?? ""} ${error.message ?? error}`); }
}
const count = async (provider, query) => {
  let total = 0;
  for await (const page of provider.search(query)) total += page.items.length;
  return `${total} items`;
};

await run("earth-search", () => count(earthSearch(), { ...base, from: "2025-05-01", to: "2025-05-31" }));
await run("copernicus", () => count(copernicusDataSpace(), { ...base, from: "2025-05-01", to: "2025-05-31" }));
await run("usgs-landsatlook", () => count(usgsLandsatLook(), { ...base, from: "2025-05-01", to: "2025-05-31", collections: ["landsat-c2l2-sr"] }));
await run("cmr-stac ASF", () => count(cmrStac("ASF", ["sentinel-1-rtc"]), { ...base, from: "2025-05-01", to: "2025-05-31" }));
await run("asf-search", () => count(asfSearch(), { ...base, from: "2025-05-01", to: "2025-05-02" }));
// JAXA: small AOI + day; verifies the CSW granule endpoint and the bbox request shape.
await run("jaxa-gportal", () => count(jaxaGPortal({ datasetId: "10002002" }), { ...base, from: "2021-07-07", to: "2021-07-07" }));
await run("esa-plans", async () => {
  const catalog = new SatelliteCatalog([earthSearch()], [esaSentinelPlans()]);
  const planned = await catalog.upcoming({ latitude: -8.5833, longitude: 116.1167, radiusMeters: 25000, days: 14 });
  return `${planned.length} planned datatakes`;
});
