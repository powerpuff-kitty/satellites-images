import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { esaSentinelPlans, parseESAPlanIndex, parseESAPlanKml, boundsAround,
  SatelliteCatalog, earthSearch } from "../dist/index.js";

const origin="https://sentinels.copernicus.eu/documents/d/sentinel/";
const s2=origin+"s2b_mp_acq__kml_20261008t120000_20261026t150000";
const oldS2=origin+"s2b_mp_acq__kml_20260924t120000_20261012t150000";
const s1=origin+"s1c_mp_user_20261012t173841_20261103t194800";
const index='<html><a href="'+oldS2+'">old</a><a href="'+s2+'">new</a>'+
  '<a href="'+s1+'">S1</a><a href="https://evil.test/documents/d/sentinel/s2a_mp_acq__kml_20261012t120000_20261028t120000">external</a></html>';
const matching="116.0,-8.7,0 116.3,-8.7,0 116.3,-8.4,0 116.0,-8.4,0 116.0,-8.7,0";
const outside="1,1,0 2,1,0 2,2,0 1,2,0 1,1,0";
const placemark=(name,style,coords,date="2026-10-15T02:12:00.000") =>
  '<Placemark><name>'+name+'</name><styleUrl>'+style+'</styleUrl><ExtendedData>'+
  '<Data name="ObservationTimeStart"><value>'+date+'</value></Data>'+
  '<Data name="ObservationTimeStop"><value>2026-10-15T02:14:00.000</value></Data>'+
  '<Data name="OrbitRelative"><value>47</value></Data>'+
  '<Data name="Mode"><value>NOBS</value></Data></ExtendedData>'+
  '<Polygon><outerBoundaryIs><LinearRing><coordinates>'+coords+'</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>';
const kml='<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'+
  placemark('123-1','S2B_NOBS_NOMINAL',matching)+
  placemark('calibration','S2B_VIC',matching)+
  placemark('far-away','S2B_NOBS_NOMINAL',outside)+
  '</Document></kml>';
const s1kml='<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'+
  placemark('127-4','S1C_IW',matching)+'</Document></kml>';

test("extract official latest plan metadata without trusting external hrefs",()=>{
  const plans=parseESAPlanIndex(index);
  assert.equal(plans.length,3);
  assert.ok(plans.some(p=>p.mission==="S2B"&&p.url===s2));
  assert.ok(plans.some(p=>p.mission==="S1C"));
  assert.ok(!plans.some(p=>p.mission==="S2A"));
});
test("parse real-shaped ExtendedData and ignore calibration/out-of-bounds strips",()=>{
  const plan=parseESAPlanIndex(index).find(p=>p.url===s2);
  const results=parseESAPlanKml(kml,plan,boundsAround(-8.5833,116.1167,5000),
    Date.parse("2026-10-12"),Date.parse("2026-10-20"));
  assert.equal(results.length,1);
  assert.equal(results[0].mission,"S2B");
  assert.equal(results[0].status,"planned");
  assert.equal(results[0].expectedAt,"2026-10-15T02:12:00.000Z");
  assert.equal(results[0].orbitRelative,47);
  assert.equal(results[0].footprint.type,"Polygon");
});
test("the upcoming window accepts up to a year and rejects beyond it",async()=>{
  // Regression: the day bound was widened while the window comparison still used 31 days,
  // so app queries (which use the loaded year) failed with INVALID_QUERY.
  const mock=async(url)=>{
    if(url.endsWith("/acquisition-plans")) return new Response(index,{status:200});
    if(url===s2) return new Response(kml,{status:200});
    if(url===s1) return new Response(s1kml,{status:200});
    return new Response("",{status:404});
  };
  const provider=esaSentinelPlans({fetchImpl:mock, clock:()=>new Date("2026-10-12T16:00:00Z"),
    missions:["S1C","S2B"]});
  const day=86_400_000;
  await assert.doesNotReject(()=>provider.upcoming({latitude:-8.5833,longitude:116.1167,
    radiusMeters:5000,days:180}));
  await assert.rejects(()=>provider.upcoming({latitude:-8.5833,longitude:116.1167,
    radiusMeters:5000,days:367}),e=>e.code==="INVALID_QUERY");
  await assert.rejects(()=>provider.upcoming({latitude:-8.5833,longitude:116.1167,
    radiusMeters:5000,from:"2026-10-12",to:new Date("2026-10-12T16:00:00Z").getTime()+400*day
      ? "2027-11-15" : "2027-11-15"}),e=>e.code==="INVALID_QUERY");
});

test("future adapter selects newest plan per satellite with bounded queries",async()=>{
  const calls=[];
  const mock=async(url)=>{
    calls.push(url);
    if(url.endsWith("/acquisition-plans")) return new Response(index,{status:200});
    if(url===s2) return new Response(kml,{status:200});
    if(url===s1) return new Response(s1kml,{status:200});
    throw Error("Unexpected requested plan: "+url);
  };
  const catalog=new SatelliteCatalog([earthSearch()], [
    esaSentinelPlans({fetchImpl:mock, clock:()=>new Date("2026-10-12T16:00:00Z"),
      missions:["S1C","S2B"]}),
  ]);
  const results=await catalog.upcoming({latitude:-8.5833,longitude:116.1167,
    radiusMeters:5000,days:10});
  assert.equal(results.length,2);
  assert.deepEqual(results.map(r=>r.mission),["S1C","S2B"]);
  assert.ok(!calls.includes(oldS2));
  assert.equal(calls.length,4); // 2 index pages, 2 KML files
  const cached=await catalog.upcoming({latitude:-8.5833,longitude:116.1167,
    radiusMeters:5000,days:10});
  assert.equal(cached.length,2);
  assert.equal(calls.length,4,"Second search should use bounded in-memory plan cache");

});
test("reject malicious XML and invalid window without relying on network",()=>{
  const plan=parseESAPlanIndex(index).find(p=>p.url===s2);
  assert.throws(()=>parseESAPlanKml('<!DOCTYPE kml><kml></kml>',plan,
    boundsAround(-8.5,116,1000),0,Date.now()),e=>e.code==="INVALID_RESPONSE");
});
test("transport failures are explicit, not an empty upcoming result",async()=>{
  const mock=async()=>new Response("bad",{status:503});
  await assert.rejects(()=>esaSentinelPlans({fetchImpl:mock}).upcoming({
    latitude:0,longitude:0,radiusMeters:1000,days:2}),e=>e.code==="HTTP_ERROR");
});

test("real ESA S2A 2024 KML datatake can be parsed with its original metadata",()=>{
  const fixture=readFileSync(new URL("../../../tests/fixtures/esa-s2-sample.kml",import.meta.url),"utf8");
  const plan={mission:"S2A",url:"https://sentinels.copernicus.eu/copernicus/sentinel-2/acquisition-plans",
    startsAt:"2024-11-28T00:00:00Z",endsAt:"2024-12-14T00:00:00Z"};
  const result=parseESAPlanKml(fixture,plan,boundsAround(40.97507,-27.63923,1000),
    Date.parse("2024-11-28"),Date.parse("2024-12-01"));
  assert.equal(result.length,1);
  assert.equal(result[0].expectedAt,"2024-11-28T12:50:30.621Z");
  assert.equal(result[0].orbitRelative,95);
  assert.equal(result[0].mode,"NOBS");
});

test("HTTP conditional 304 refreshes plan cache without re-downloading bodies",async()=>{
  let now=new Date("2026-10-12T16:00:00Z");
  const fetched=new Set();
  const mock=async(url,init={})=>{
    const conditional=(init.headers||{})["If-None-Match"];
    if(fetched.has(url)&&conditional) return new Response(null,{status:304});
    fetched.add(url);
    if(url.endsWith("/acquisition-plans")) return new Response(index,{status:200,headers:{"etag":'"i"'}});
    if(url===s2) return new Response(kml,{status:200,headers:{"etag":'"k"'}});
    if(url===s1) return new Response(s1kml,{status:200,headers:{"etag":'"k1"'}});
    throw Error("Unexpected "+url);
  };
  const provider=esaSentinelPlans({fetchImpl:mock,clock:()=>now,missions:["S1C","S2B"]});
  const q={latitude:-8.5833,longitude:116.1167,radiusMeters:5000,days:10};
  const first=await provider.upcomingWithDiagnostics(q);
  assert.equal(first.status,"ok");
  assert.equal(first.opportunities.length,2);
  assert.ok(first.fetchedAt);
  assert.ok(first.plans.every(p=>p.fromCache===false));
  now=new Date("2026-10-12T17:30:00Z"); // beyond the 15/60 minute plan TTLs
  const second=await provider.upcomingWithDiagnostics(q);
  assert.equal(second.status,"ok");
  assert.equal(second.opportunities.length,2);
  assert.ok(second.plans.every(p=>p.fromCache===true),"revalidated 304 responses reuse the cached plan");
});

test("diagnostics distinguish no-current-plan from no-overlap",async()=>{
  const outsideKml='<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'+
    placemark('far','S2B_NOBS_NOMINAL',outside)+'</Document></kml>';
  const emptyMock=async()=>new Response("<html></html>",{status:200});
  const empty=await esaSentinelPlans({fetchImpl:emptyMock,clock:()=>new Date("2026-10-12T16:00:00Z"),
    missions:["S2B"]}).upcomingWithDiagnostics({latitude:0,longitude:0,radiusMeters:1000,days:5});
  assert.equal(empty.status,"no-current-plan");
  assert.equal(empty.plans.length,0);
  assert.equal(empty.fetchedAt,null);
  const outsideMock=async(url)=>{
    if(url.endsWith("/acquisition-plans")) return new Response(index,{status:200});
    if(url===s2) return new Response(outsideKml,{status:200});
    throw Error("Unexpected "+url);
  };
  const outsideResult=await esaSentinelPlans({fetchImpl:outsideMock,
    clock:()=>new Date("2026-10-12T16:00:00Z"),missions:["S2B"]})
    .upcomingWithDiagnostics({latitude:-8.5833,longitude:116.1167,radiusMeters:5000,days:10});
  assert.equal(outsideResult.status,"no-overlap");
  assert.equal(outsideResult.plans.length,1);
  assert.equal(outsideResult.plans[0].mission,"S2B");
});
