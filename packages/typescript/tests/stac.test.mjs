import { test } from "node:test";
import assert from "node:assert/strict";
import { SatelliteCatalog, StacProvider, boundsAround, earthSearch, listSources, SatelliteError } from "../dist/index.js";

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
  assert.throws(()=>boundsAround(0,180,5000),e=>e.code==="UNSUPPORTED_AREA");
  assert.throws(()=>boundsAround(Number.NaN,0,5000),e=>e.code==="INVALID_QUERY");
});
test("registry reports implemented and planned sources accurately",() => {
  const items=listSources();
  assert.ok(items.length>=12);
  assert.equal(items.find(x=>x.id==="earth-search")?.implemented.typescript,true);
  assert.equal(items.find(x=>x.id==="skyfi")?.implemented.typescript,false);
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

test("POST next link defaults to body replacement unless merge is explicitly true",async()=>{
  const seen=[];
  const mock=async(_href,init)=>{
    seen.push(JSON.parse(init.body));
    const next=seen.length===1
      ? [{rel:"next",href:"https://earth-search.aws.element84.com/v1/search",
           method:"POST",body:{cursor:"opaque-token"}}]
      : [];
    return new Response(JSON.stringify({type:"FeatureCollection",features:[],links:next}),{status:200});
  };
  const pages=[];
  for await (const p of earthSearch(mock).search(search)) pages.push(p);
  assert.equal(pages.length,2);
  assert.deepEqual(seen[1],{cursor:"opaque-token"});
});
