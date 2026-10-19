import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inpeCbers } from "../dist/index.js";

// Anonymous INPE item recorded 2026-10-16; no image bytes are stored or requested.
const item = JSON.parse(await readFile(new URL("../../../tests/fixtures/inpe-cbers-item.json",import.meta.url)));
test("INPE selects its fused collection and preserves absent item metadata",async()=>{
  const provider=inpeCbers(async(url,init)=>{
    assert.equal(url,"https://data.inpe.br/bdc/stac/v1/search");
    assert.deepEqual(JSON.parse(init.body).collections,["CB4A-WPM-PCA-FUSED-1"]);
    return Response.json({type:"FeatureCollection",features:[item],links:[]});
  });
  const pages=[];
  for await(const page of provider.search({latitude:-7.15,longitude:-38.1,radiusMeters:25000,
    from:"2026-10-13",to:"2026-10-13",maxPages:1})) pages.push(page);
  const scene=pages[0].items[0];
  assert.equal(scene.providerId,"inpe-cbers");
  assert.equal(scene.acquiredAt,"2026-10-13T00:00:00.000Z");
  assert.equal(scene.previewUrl,item.assets.thumbnail.href);
  assert.ok(scene.assets.some(a=>a.key==="tci" && a.href.endsWith(".tif")));
  assert.equal(scene.access,"open");
  assert.ok(scene.assets.every(a=>a.access==="unknown"));
  assert.equal(scene.mission,null);
  assert.equal(scene.gsdMeters,null);
  assert.equal(scene.cloudCoverPercent,null);
  assert.deepEqual(scene.raw,item);
});
