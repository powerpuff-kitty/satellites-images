// Independent opt-in live metadata audit. No credentials or image-byte requests.
// node tools/smoke/source-benchmark.mjs [--out REPORT.json]
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer } from "node:http";
import { cpus, release } from "node:os";
import { chromium } from "@playwright/test";
import { earthSearch, planetaryComputer, copernicusDataSpace, inpeCbers,
  usgsLandsatLook, cmrStac, asfSearch, jaxaGPortal, openAerialMap,
  maxarOpenData, esaSentinelPlans } from "../../packages/typescript/dist/index.js";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--out")) throw Error("Usage: source-benchmark.mjs [--out REPORT.json]");
const out = args[1] ?? `tools/smoke/results/source-benchmark-${new Date().toISOString().slice(0,10)}.json`;
const origin = "http://localhost:5173";
const base = { latitude:-8.5833, longitude:116.1167, radiusMeters:25000,
  from:"2025-05-01", to:"2025-05-31", limit:2, maxPages:1 };
const cases = [
  ["earth-search", f=>earthSearch(f), base, 3],
  ["planetary-computer", f=>planetaryComputer(f), base, 3],
  ["copernicus", f=>copernicusDataSpace(f), base, 3],
  ["inpe-cbers", f=>inpeCbers(f), { ...base, latitude:-7.15, longitude:-38.1,
    from:"2026-10-13", to:"2026-10-13", limit:1, maxPages:3 }, 3],
  ["asf-nisar", f=>asfSearch({platforms:["NISAR"],fetchImpl:f}), {
    ...base,from:"2026-09-01",to:"2026-10-15" }, 3],
  ["asf-alos2", f=>asfSearch({platforms:["ALOS-2"],fetchImpl:f}), {
    ...base,from:"2025-01-01",to:"2026-10-15" }, 1],
  ["asf-sentinel1", f=>asfSearch({fetchImpl:f}), {...base,to:"2025-05-02"}, 1],
  ["usgs-landsatlook", f=>usgsLandsatLook(f), {...base,collections:["landsat-c2l2-sr"]}, 1],
  ["nasa-cmr", f=>cmrStac("ASF",["sentinel-1-rtc"],f), base, 1],
  ["jaxa-gportal", f=>jaxaGPortal({datasetId:"10002002",fetchImpl:f}), {
    ...base,from:"2021-07-07",to:"2021-07-07" }, 1],
  ["open-aerial-map", f=>openAerialMap({limit:2,fetchImpl:f}), {
    ...base,latitude:50.871,longitude:5.847,radiusMeters:2000,
    from:"2021-04-01",to:"2021-06-30" }, 1],
  // This is a bounded traversal diagnostic, deliberately not an exhaustive scan.
  ["maxar-open-data", f=>maxarOpenData({maxDocuments:12,fetchImpl:f}), {
    ...base,latitude:20.88,longitude:-156.68,radiusMeters:1000,
    from:"2023-08-01",to:"2023-08-31" }, 1],
];
const report = { checkedAt:new Date().toISOString(), scope:"Anonymous metadata only; first sample has unprimed process/provider caches, later samples may reuse connections/service caches. No performance threshold or before/after claim.",
  environment:{node:process.version,platform:process.platform,arch:process.arch,osRelease:release(),cpu:cpus()[0]?.model},
  origin, sdk:[], plans:null, docs:[], browser:[], registry:[] };
for (const [id, make, query, repeats] of cases) {
  const entry = {id,query,repeats,samples:[]};
  for(let sample=0;sample<repeats;sample++) {
    const requests=[];
    const transport = async (url, init={}) => {
      const request = {url:String(url),method:init.method??"GET",body:init.body??null,headers:Object.fromEntries(new Headers(init.headers))};
      requests.push(request);
      const started=performance.now();
      try {
        const response=await fetch(url,{...init,credentials:"omit",headers:{...request.headers,Origin:origin}});
        Object.assign(request,{status:response.status,cors:response.headers.get("access-control-allow-origin"),headersMs:Math.round(performance.now()-started)});
        return response;
      } catch(error) { request.error=String(error); throw error; }
    };
    const started=performance.now(), result={sample:sample+1,requests,pages:[],observations:0,complete:false};
    try {
      for await(const page of make(transport).search(query)) {
        result.pages.push({pageNumber:page.pageNumber,items:page.items.length,hasNext:page.hasNext,matched:page.matched,skipped:page.skipped??0});
        result.observations+=page.items.length;
        result.complete=!page.hasNext;
        result.sceneSamples??=page.items.slice(0,2).map(s=>({id:s.id,collection:s.collection,acquiredAt:s.acquiredAt,
          mission:s.mission,gsdMeters:s.gsdMeters,access:s.access,previewUrl:s.previewUrl,
          rawProperties:s.raw?.properties,assetAccess:s.assets.map(a=>({key:a.key,access:a.access,type:a.type}))}));
      }
      result.status=result.observations ? "query-returned-scenes" : "valid-empty-query";
    } catch(error) { result.status="error";result.error=String(error);result.errorCode=error.code; }
    result.elapsedMs=Math.round(performance.now()-started);
    entry.samples.push(result);
    console.log(`${id} ${sample+1}/${repeats}: ${result.status}, ${result.observations} scenes, ${requests.length} requests, ${result.elapsedMs}ms, complete=${result.complete}`);
  }
  const times=entry.samples.filter(s=>s.status!=="error").map(s=>s.elapsedMs).sort((a,b)=>a-b);
  entry.summary={successfulSamples:times.length,minMs:times[0]??null,medianMs:times.length ? times[Math.floor(times.length/2)] : null,maxMs:times.at(-1)??null};
  report.sdk.push(entry);
}
{
  const requests=[],started=performance.now();
  const provider=esaSentinelPlans({fetchImpl:async(url,init)=>{requests.push(String(url));return fetch(url,{...init,credentials:"omit"});}});
  try { const result=await provider.upcomingWithDiagnostics({latitude:base.latitude,longitude:base.longitude,radiusMeters:base.radiusMeters,days:14});
    report.plans={status:result.status,opportunities:result.opportunities.length,plans:result.plans,fetchedAt:result.fetchedAt};
  } catch(error) {report.plans={status:"error",error:String(error)};}
  Object.assign(report.plans,{requests,elapsedMs:Math.round(performance.now()-started)});
  console.log(`esa-sentinel-plans: ${report.plans.status}, ${requests.length} requests`);
}
const registry=JSON.parse(await readFile(new URL("../../sources/registry.json",import.meta.url),"utf8"));
const docIds=["eumetsat","nasa-gibs","noaa-goes","planet","skyfi","up42","vantor"];
for(const source of registry.sources.filter(s=>docIds.includes(s.id))) {
  const record={id:source.id,url:source.docs,searchAccess:source.searchAccess,verification:"documentation-reachability-only",checkedAt:new Date().toISOString()};
  const started=performance.now();
  try { const response=await fetch(source.docs,{credentials:"omit",signal:AbortSignal.timeout(25000)});
    Object.assign(record,{status:response.status,finalUrl:response.url,contentType:response.headers.get("content-type")});
    const reader=response.body?.getReader();let bytes=0;
    if(reader){try {while(bytes<128*1024){const part=await reader.read();if(part.done)break;bytes+=part.value.length;}}finally{await reader.cancel();}}
    record.sampledMetadataBytes=bytes;
  }catch(error){record.error=String(error);}
  record.elapsedMs=Math.round(performance.now()-started);report.docs.push(record);
  console.log(`docs ${source.id}: ${record.status??record.error}`);
}
// A real Chromium fetch from an arbitrary localhost origin tests browser CORS.
// Metadata only; no map tiles, previews or raster assets are fetched.
const server=createServer((req,res)=>{res.setHeader("Content-Type","text/html");res.end("<!doctype html><title>Source metadata audit</title>");});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
let browser;
try {
  browser=await chromium.launch();const page=await browser.newPage();
  report.browserOrigin=`http://127.0.0.1:${server.address().port}`;await page.goto(report.browserOrigin);
  const ids=["earth-search","planetary-computer","copernicus","inpe-cbers","asf-nisar","asf-alos2","usgs-landsatlook","open-aerial-map"];
  const requests=ids.map(id=>({id,...report.sdk.find(s=>s.id===id).samples[0].requests[0]}));
  requests.push(...registry.sources.filter(s=>["wyvern-open-data","capella-open-data","umbra-open-data"].includes(s.id)).map(s=>({id:s.id,url:s.url,method:"GET",headers:{Accept:"application/json"}})));
  for(const request of requests) {
    const result=await page.evaluate(async request=>{
      const started=performance.now();
      try { const response=await fetch(request.url,{method:request.method,headers:request.headers,
        body:request.body??undefined,credentials:"omit",redirect:"error",signal:AbortSignal.timeout(25000)});
        const data=await response.json();return {status:response.status,type:data.type,features:data.features?.length,
          links:data.links?.length,elapsedMs:Math.round(performance.now()-started)};
      }catch(error){return {error:String(error),elapsedMs:Math.round(performance.now()-started)};}
    },request);
    report.browser.push({id:request.id,url:request.url,method:request.method,...result});
    console.log(`browser ${request.id}: ${result.status??result.error}`);
  }
}catch(error){report.browserError=String(error);}
finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
for(const source of registry.sources) {
  const sdk=report.sdk.find(s=>s.id===source.id || source.id==="asf-vertex"&&s.id==="asf-nisar");
  const docs=report.docs.find(s=>s.id===source.id);
  report.registry.push({id:source.id,searchAccess:source.searchAccess,implemented:source.implemented,
    verification:sdk ? sdk.samples[0].status : source.id==="esa-sentinel-plans" ? report.plans.status :
      ["capella-open-data","umbra-open-data","wyvern-open-data"].includes(source.id) ? "representative-static-path-in-source-audit-evidence" : docs?.verification??"not-tested",
    note:docs ? "No authenticated query attempted; documentation reachability does not verify catalogue search." : undefined});
}
await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+"\n");
console.log(`Wrote ${out}`);
