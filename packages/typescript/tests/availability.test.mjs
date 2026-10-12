import { test } from "node:test";
import assert from "node:assert/strict";
import { AvailabilityAccumulator, summarizeAvailability, SatelliteCatalog, earthSearch } from "../dist/index.js";

const scene=(id,date,mission="sentinel-2a",collection="sentinel-2-l2a")=>({
  providerId:"earth-search",id,collection,acquiredAt:date,
  mission,access:"unknown",bbox:null,geometry:null,cloudCoverPercent:12.0,
  assets:[],sourceUrl:null,previewUrl:null,raw:{},
});
const page=(providerId,items,pageNumber=1,hasNext=false,matched=null)=>({
  providerId,items,pageNumber,hasNext,matched,
});

test("availability groups dates in UTC and deduplicates repeated STAC items",()=>{
  const accumulator=new AvailabilityAccumulator();
  const first=page("earth-search",[
    scene("1","2025-01-01T00:05:00.000Z"),
    scene("2","2025-01-31T23:55:00.000Z"),
  ],1,true,4);
  const second=page("earth-search",[
    scene("2","2025-01-31T23:55:00.000Z"),
    scene("3","2025-02-01T10:00:00.000Z","landsat-9","landsat-c2-l2"),
  ],2,false,4);
  assert.equal(accumulator.addPage(first).length,2);
  assert.equal(accumulator.summary().complete,false);
  assert.deepEqual(accumulator.summary().truncatedProviders,["earth-search"]);
  assert.equal(accumulator.addPage(second).length,1);
  const result=accumulator.summary();
  assert.equal(result.complete,true);
  assert.equal(result.uniqueItems,3);
  assert.equal(result.rawItems,4);
  assert.equal(result.pagesScanned,2);
  assert.equal(result.months[0].month,"2025-01");
  assert.equal(result.months[0].count,2);
  assert.equal(result.months[0].daysWithObservations,2);
  assert.deepEqual(result.days.map(d=>[d.date,d.count]),[
    ["2025-01-01",1],["2025-01-31",1],["2025-02-01",1],
  ]);
  assert.equal(result.providers[0].matched,4);
  assert.equal(result.months[1].missions["landsat-9"],1);
});

test("provider identities are never collapsed into hypothetical physical duplicates",()=>{
  const item=scene("same","2025-03-01T00:00:00Z");
  const result=summarizeAvailability([
    page("earth-search",[item]),page("planetary-computer",[{...item,providerId:"planetary-computer"}]),
  ]);
  assert.equal(result.uniqueItems,2);
  assert.equal(result.providers.length,2);
  assert.equal(result.days[0].count,2);
});

test("partial pages from one provider remain partial after another provider finishes",()=>{
  const result=summarizeAvailability([
    page("earth-search",[scene("first","2025-04-01T00:00:00Z")],1,true),
    page("planetary-computer",[],1,false),
  ]);
  assert.equal(result.complete,false);
  assert.deepEqual(result.truncatedProviders,["earth-search"]);
  assert.equal(result.providers[1].uniqueItems,0);
});

test("empty availability summary does not claim completeness",()=>{
  const result=summarizeAvailability([]);
  assert.equal(result.complete,false);
  assert.equal(result.uniqueItems,0);
});

test("catalog availability uses actual bounded provider result pages",async()=>{
  let requests=0;
  const mock=async()=>{
    requests++;
    return new Response(JSON.stringify({
      type:"FeatureCollection",
      features:[{
        type:"Feature",id:"observed-1",collection:"sentinel-2-l2a",
        properties:{datetime:"2026-10-01T01:30:00Z",platform:"sentinel-2c"},
        assets:{},
      }],links:[],
    }),{status:200});
  };
  const catalog=new SatelliteCatalog([earthSearch(mock)]);
  const result=await catalog.availability({
    latitude:0,longitude:0,radiusMeters:1000,from:"2026-10-01",to:"2026-10-31",
  });
  assert.equal(requests,1);
  assert.deepEqual(result.days.map(d=>d.date),["2026-10-01"]);
  assert.equal(result.complete,true);
});
