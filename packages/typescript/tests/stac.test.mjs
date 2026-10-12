import { test } from "node:test";
import assert from "node:assert/strict";
import { SatelliteCatalog, StacProvider, boundsAround, radiusBoxes, polygonBoxes, resolveAreas, coveragePercent, availabilitySummary, earthSearch, copernicusDataSpace, usgsLandsatLook, cmrStac, listSources, SatelliteError } from "../dist/index.js";

const sample = {
  type: "FeatureCollection",
  features: [{
    type:"Feature", id:"S2_example", collection:"sentinel-2-l2a",
    geometry:{type:"Polygon",coordinates:[[[116,-9],[117,-9],[117,-8],[116,-8],[116,-9]]]},
    bbox:[116,-9,117,-8],
    properties:{datetime:"2025-01-10T02:12:00Z",platform:"sentinel-2a","eo:cloud_cover":12.5},
    assets:{thumbnail:{href:"https://example.com/thumb.jpg",roles:["thumbnail"],type:"image/jpeg"},visual:{href:"s3://example/file.tif",roles:["data"],type:"image/tiff"}},
    links:[{rel:"self",href:"https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/S2_example"}],
  }],
  context:{matched:2},
  links:[{rel:"next",href:"https://earth-search.aws.element84.com/v1/search",method:"POST",merge:true,body:{token:"page2"}}],
};
const search = { latitude:-8.5833,longitude:116.1167,radiusMeters:5000,from:"2025-01-01",to:"2025-01-31",maxPages:2 };

test("bbox validation and antimeridian failure",() => {
  const bbox=boundsAround(-8.5833,116.1167,5000);
  assert.equal(bbox.length,4);
  assert.ok(bbox[0]<116.1167 && bbox[2]>116.1167);
  assert.throws(()=>boundsAround(Number.NaN,0,5000),e=>e.code==="INVALID_QUERY");
});
test("antimeridian and pole areas are split instead of rejected",() => {
  const split=radiusBoxes(0,180,5000);
  assert.equal(split.length,2);
  assert.ok(split[0][2]<=180 && split[1][0]>=-180);
  // A radius over the pole uses the full longitude range.
  const polar=radiusBoxes(89.999,10,50000);
  assert.equal(polar.length,1);
  assert.deepEqual([polar[0][0],polar[0][2],polar[0][3]],[-180,180,90]);
  const resolved=resolveAreas({latitude:0,longitude:179.9,radiusMeters:25000,from:"2025-01-01",to:"2025-01-02"});
  assert.equal(resolved.boxes.length,2);
});
test("polygon AOI resolves to a precise STAC bbox and coverage score",() => {
  const aoi={type:"Polygon",coordinates:[[[116.0,-8.7],[116.3,-8.7],[116.3,-8.4],[116.0,-8.4],[116.0,-8.7]]]};
  const boxes=polygonBoxes(aoi);
  assert.deepEqual(boxes,[[116.0,-8.7,116.3,-8.4]]);
  const resolved=resolveAreas({aoi,from:"2025-01-01",to:"2025-01-02"});
  assert.deepEqual(resolved.polygon,aoi,"single-box polygon is sent as STAC intersects");
  assert.equal(coveragePercent([116.0,-8.7,116.3,-8.4],boxes),100);
  assert.ok(Math.abs(coveragePercent([116.1,-8.6,116.2,-8.5],boxes)-11.1111)<0.01);
  assert.equal(coveragePercent(null,boxes),null);
});
test("antimeridian polygon splits into two boxes without intersects",() => {
  const aoi={type:"Polygon",coordinates:[[[179.9,-1],[-179.9,-1],[-179.9,1],[179.9,1],[179.9,-1]]]};
  const boxes=polygonBoxes(aoi);
  assert.equal(boxes.length,2);
  const resolved=resolveAreas({aoi,from:"2025-01-01",to:"2025-01-02"});
  assert.equal(resolved.polygon,null,"splitting polygons cannot be sent as a single intersects geometry");
});
test("invalid AOI geometry is rejected with a typed error",() => {
  assert.throws(()=>polygonBoxes({type:"Point",coordinates:[0,0]}),e=>e.code==="INVALID_QUERY");
  assert.throws(()=>polygonBoxes({coordinates:[[[[0,0],[1,0],[1,1],[0,0]]]]}),e=>e.code==="INVALID_QUERY");
  assert.throws(()=>polygonBoxes({type:"MultiPolygon",coordinates:"not-an-array"}),e=>e.code==="INVALID_QUERY");
});
test("antimeridian split queries both boxes within a per-box page budget",async()=>{
  const aoi={type:"Polygon",coordinates:[[[179.9,-1],[-179.9,-1],[-179.9,1],[179.9,1],[179.9,-1]]]};
  const requested=[];
  const mock=async(href,init)=>{
    requested.push(JSON.parse(init.body).bbox);
    return new Response(JSON.stringify({type:"FeatureCollection",features:[],links:[],context:{matched:0}}),{status:200});
  };
  const provider=new StacProvider({id:"earth-search",baseUrl:"https://earth-search.aws.element84.com/v1",collections:["sentinel-2-l2a"],fetchImpl:mock});
  const pages=[];
  for await(const page of provider.search({aoi,maxPages:1,from:"2025-01-01",to:"2025-01-02"})) pages.push(page);
  assert.equal(requested.length,2,"both antimeridian boxes are queried");
  assert.equal(pages.length,2,"a split query returns a page per box");
  assert.ok(requested[0][2]<=180 && requested[1][0]>=-180);
});
test("registry reports implemented and planned sources accurately",() => {
  const items=listSources();
  assert.ok(items.length>=12);
  assert.equal(items.find(x=>x.id==="earth-search")?.implemented.typescript,true);
  assert.equal(items.find(x=>x.id==="skyfi")?.implemented.typescript,false);
});
test("STAC-reuse adapters target verified endpoints and normalize provider items",async()=>{
  assert.equal(copernicusDataSpace().id,"copernicus");
  assert.equal(usgsLandsatLook().id,"usgs-landsatlook");
  assert.equal(cmrStac("ASF",["sentinel-1-rtc"]).id,"nasa-cmr");
  assert.throws(()=>cmrStac("bad id",["x"]),e=>e.code==="INVALID_PROVIDER");
  const mock=async()=>new Response(JSON.stringify({...sample,features:[{...sample.features[0],
    id:"S2C_MSIL2A_example",collection:"sentinel-2-l2a",
    properties:{...sample.features[0].properties,platform:"sentinel-2c"}}],links:[]}),{status:200});
  const pages=[];
  for await(const page of new SatelliteCatalog([copernicusDataSpace(mock)]).search(
    {latitude:-8.5,longitude:116.1,radiusMeters:5000,from:"2025-01-01",to:"2025-01-31"})) pages.push(page);
  assert.equal(pages[0].items[0].providerId,"copernicus");
  assert.equal(pages[0].items[0].mission,"sentinel-2c");
});
test("STAC pagination, normalization, and precise acquisition times",async()=>{
  const calls=[];
  const mock=async (href, init) => {
    const body=JSON.parse(init.body);
    calls.push({href,body});
    const payload=calls.length===1?sample:{...sample,features:[{...sample.features[0],id:"second",properties:{...sample.features[0].properties,datetime:"2025-01-13T12:00:00Z"}}],links:[]};
    return new Response(JSON.stringify(payload),{status:200,headers:{"content-type":"application/json"}});
  };
  const provider=earthSearch(mock);
  const catalog=new SatelliteCatalog([provider]);
  const pages=[];
  for await(const p of catalog.search(search)) pages.push(p);
  assert.equal(pages.length,2);
  assert.equal(pages[0].items[0].acquiredAt,"2025-01-10T02:12:00.000Z");
  assert.equal(pages[0].items[0].access,"unknown");
  assert.equal(pages[0].items[0].previewUrl,"https://example.com/thumb.jpg");
  assert.equal(pages[0].matched,2);
  assert.equal(pages[1].hasNext,false);
  assert.equal(calls[1].body.token,"page2");
  assert.ok(Array.isArray(calls[1].body.bbox));
});
test("rejects cross-origin pagination before requesting the next page",async()=>{
  const mock=async()=>new Response(JSON.stringify({...sample,links:[{rel:"next",href:"https://untrusted.invalid/search"}]}),{status:200});
  const provider=new StacProvider({id:"earth-search",baseUrl:"https://earth-search.aws.element84.com/v1",collections:["sentinel-2-l2a"],fetchImpl:mock});
  let count=0;
  await assert.rejects(async()=>{
    for await (const _ of provider.search(search)) count++;
  },e=>e instanceof SatelliteError && e.code==="UNSAFE_NEXT_LINK");
  assert.equal(count,1);
});
test("bounds page count, rejects bad dates, fails explicitly for future acquisitions",async()=>{
  const mock=async()=>new Response(JSON.stringify(sample),{status:200});
  const catalog=new SatelliteCatalog([earthSearch(mock)]);
  const pages=[];
  for await(const p of catalog.search({...search,maxPages:1})) pages.push(p);
  assert.equal(pages.length,1);
  await assert.rejects(()=>catalog.upcoming(),e=>e.code==="UNSUPPORTED");
  await assert.rejects(async()=>{for await(const _ of catalog.search({...search,to:"2025-02-31"})){}},e=>e.code==="INVALID_QUERY");
});
test("provider failures are not misreported as empty scenes",async()=>{
  const mock=async()=>new Response("unavailable",{status:429});
  const catalog=new SatelliteCatalog([earthSearch(mock)]);
  await assert.rejects(async()=>{for await(const _ of catalog.search(search)){}},e=>e.code==="HTTP_ERROR");
});
test("STAC POST next body replaces the query when merge is absent",async()=>{
  const nextLink={rel:"next",href:"https://earth-search.aws.element84.com/v1/search",method:"POST",body:{token:"t2"}};
  const calls=[];
  const mock=async(href,init)=>{
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify(calls.length===1?{...sample,links:[nextLink]}:{...sample,features:[],links:[]}),{status:200});
  };
  for await(const _ of earthSearch(mock).search(search)){ /* drain */ }
  assert.deepEqual(calls[1],{token:"t2"},"merge defaults to false so the next body replaces the bbox");
});
test("availability summary aggregates days, provenance and truncation",()=>{
  const scene=(id,date,mission)=>({providerId:"earth-search",id,collection:"sentinel-2-l2a",acquiredAt:date,
    mission,geometry:null,bbox:null,cloudCoverPercent:null,coveragePercent:null,previewUrl:null,access:"unknown",assets:[],sourceUrl:null,raw:{}});
  const page1={providerId:"earth-search",pageNumber:1,hasNext:true,matched:null,items:[
    scene("a","2025-01-10T02:00:00.000Z","sentinel-2a"),scene("b","2025-01-10T03:00:00.000Z","sentinel-2b")]};
  const page2={providerId:"earth-search",pageNumber:2,hasNext:false,matched:null,items:[
    scene("a","2025-01-10T02:00:00.000Z","sentinel-2a"),scene("c","2025-02-02T02:00:00.000Z",null)]};
  const summary=availabilitySummary([page1,page2]);
  assert.equal(summary.totalScenes,3,"duplicate provider-native id is de-duplicated");
  assert.equal(summary.complete,false,"a truncated page marks the summary incomplete");
  assert.deepEqual(summary.truncatedProviders,["earth-search"]);
  assert.deepEqual(summary.days.map(d=>d.date),["2025-01-10","2025-02-02"]);
  assert.equal(summary.days[0].count,2);
  assert.deepEqual(summary.days[0].missions,["sentinel-2a","sentinel-2b"]);
  assert.deepEqual(summary.months,[{month:"2025-01",count:2},{month:"2025-02",count:1}]);
});
test("availability summary keeps cross-provider provenance for the same native id",()=>{
  const scene=(pid,id,date)=>({providerId:pid,id,collection:"sentinel-2-l2a",acquiredAt:date,
    mission:null,geometry:null,bbox:null,cloudCoverPercent:null,coveragePercent:null,previewUrl:null,access:"unknown",assets:[],sourceUrl:null,raw:{}});
  const p1={providerId:"earth-search",pageNumber:1,hasNext:false,matched:null,items:[scene("earth-search","shared","2025-01-10T02:00:00.000Z")]};
  const p2={providerId:"copernicus",pageNumber:1,hasNext:false,matched:null,items:[scene("copernicus","shared","2025-01-10T03:00:00.000Z")]};
  const summary=availabilitySummary([p1,p2]);
  assert.equal(summary.totalScenes,2,"the same native id from two providers is counted once per provider");
  assert.deepEqual(Object.keys(summary.providers).sort(),["copernicus","earth-search"]);
  assert.deepEqual(summary.days[0].providers,["copernicus","earth-search"]);
});
