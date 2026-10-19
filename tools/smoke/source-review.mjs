// Opt-in anonymous metadata checks for the supplied free-imagery source list.
// Never run by CI; never downloads raster assets or authenticates.
// node tools/smoke/source-review.mjs [--out path.json]
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const origin = "http://localhost:5173";
const sources = [
  ["inpe-cbers", "https://data.inpe.br/bdc/stac/v1/collections/CB4A-WPM-PCA-FUSED-1", "items"],
  ["spot-world-heritage", "https://regards.cnes.fr/html/swh/Home-swh3.html"],
  ["wyvern-open-data", "https://wyvern-odp.com/catalog.json", "static"],
  ["spacenet-2", "https://spacenet-dataset.s3.amazonaws.com/?list-type=2&prefix=AOIs/AOI_2_Vegas/&max-keys=2"],
  ["corona", "https://m2m.cr.usgs.gov/api/api/json/stable/dataset-search", "usgs"],
  ["umbra-open-data", "https://umbra-open-data-catalog.s3.us-west-2.amazonaws.com/stac/catalog.json", "static"],
  ["capella-open-data", "https://capella-open-data.s3.us-west-2.amazonaws.com/stac/catalog.json", "static"],
  ["sentinel-2", "https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a", "items"],
  ["sentinel-1", "https://stac.dataspace.copernicus.eu/v1/collections/sentinel-1-grd", "items"],
  ["nisar", "https://api.daac.asf.alaska.edu/services/search/param?platform=NISAR&output=geojson&maxResults=1", "asf"],
  ["landsat", "https://earth-search.aws.element84.com/v1/collections/landsat-c2-l2", "items"],
  ["alos-2-scansar", "https://api.daac.asf.alaska.edu/services/search/param?platform=ALOS-2&output=geojson&maxResults=1", "asf"],
  ["alos-mosaics", "https://www.eorc.jaxa.jp/ALOS/en/dataset/fnf_e.htm"],
  ["himawari", "https://www.eorc.jaxa.jp/ptree/faq.html"],
  ["nasa-gibs", "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml"],
  ["amsr3", "https://global.jaxa.jp/press/2026/06/20260630-1_e.html"],
  ["earthcare", "https://www.satnavi.jaxa.jp/en/news/2025/12/01/11694/index.html"],
  ["aw3d30", "https://www.eorc.jaxa.jp/ALOS/en/dataset/aw3d30/aw3d30_e.htm"],
  ["copernicus-dem", "https://planetarycomputer.microsoft.com/api/stac/v1/collections/cop-dem-glo-30", "items"],
  ["flanders-orthophotos", "https://geo.api.vlaanderen.be/omwrgbmrvl/wms?service=WMS&request=GetCapabilities"],
  ["pnoa", "https://www.ign.es/wms-inspire/pnoa-ma?service=WMS&request=GetCapabilities"],
  ["venus", "https://www.theia-land.fr/en/blog/product/venus/"],
  ["maxar-open-data", "https://maxar-opendata.s3.amazonaws.com/events/catalog.json", "static"],
  ["planet-nicfi", "https://developers.google.com/earth-engine/datasets/catalog/projects_planet-nicfi_assets_basemaps_asia"],
  ["alos-4-samples", "https://www.eorc.jaxa.jp/ALOS/en/alos-4/a4_data_e.htm"],
];

const records = [];
async function probe(source, purpose, url, options = {}) {
  const record = { source, purpose, url, method: options.method ?? "GET", checkedAt: new Date().toISOString() };
  if (options.body) record.requestBody = JSON.parse(options.body);
  records.push(record);
  const start = Date.now();
  try {
    const response = await fetch(url, {
      ...options, headers: { Accept: "application/json, application/xml, text/html", Origin: origin, ...options.headers },
      credentials: "omit", signal: AbortSignal.timeout(25000),
    });
    Object.assign(record, { status: response.status, finalUrl: response.url,
      contentType: response.headers.get("content-type"), cors: response.headers.get("access-control-allow-origin"),
      corsMethods:response.headers.get("access-control-allow-methods"), corsHeaders:response.headers.get("access-control-allow-headers") });
    const reader = response.body?.getReader();
    const chunks = []; let size = 0;
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4 * 1024 * 1024) { record.bodyTruncated = true; break; }
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
    }
    record.bytes = size;
    const body = Buffer.concat(chunks).toString("utf8");
    let data;
    try { data = JSON.parse(body); } catch { /* HTML/XML is evidence of a different interface. */ }
    if (data) {
      record.summary = { type: data.type, id: data.id, stacVersion: data.stac_version,
        license: data.license, extent: data.extent ? {spatial:{bbox:data.extent.spatial?.bbox?.slice(0,4)},temporal:data.extent.temporal} : undefined,
        spatialExtentCount:data.extent?.spatial?.bbox?.length, collectionSummaries:data.summaries,
        count: data.features?.length,
        matched: data.numberMatched ?? data.context?.matched, error: data.error ?? data.errors ?? data.errorMessage,
        linkCount:data.links?.length, links: data.links?.slice(0,12).map(({rel, href, method, body, merge}) => ({rel, href, method, body, merge})) };
      const item = data.features?.[0] ?? (data.type === "Feature" ? data : null);
      if (item) record.sample = { id:item.id, collection:item.collection, bbox:item.bbox, geometry:item.geometry,
        properties:item.properties, assets:item.assets, links:item.links };
    } else {
      record.summary = { title: body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1],
        excerpt: body.slice(0, 500),
        objectKeys: [...body.matchAll(/<Key>(.*?)<\/Key>/g)].slice(0, 5).map(m=>m[1]),
        layers: [...body.matchAll(/<(?:\w+:)?(?:Name|Identifier)>(.*?)<\//g)].slice(0,20).map(m=>m[1]) };
    }
    return data;
  } catch (error) { record.error = String(error); }
  finally { record.elapsedMs = Date.now()-start; console.log(`${source} ${purpose}: ${record.status ?? record.error}`); }
}

async function review([id, url, mode]) {
  const root = await probe(id, "entry", url, mode === "usgs" ? {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({datasetName:"declass"}),
  } : {});
  if (mode === "items" && root?.id) {
    const itemsUrl = root.links?.find(l=>l.rel === "items")?.href ?? url + "/items";
    const items = await probe(id, "sample-items", itemsUrl + (itemsUrl.includes("?") ? "&" : "?") + "limit=1");
    if (id === "inpe-cbers" && items?.features?.[0]) {
      const sample = items.features[0];
      const bbox = sample.bbox;
      const date = sample.properties.datetime?.slice(0,10);
      if (bbox && date) {
        const searchUrl = "https://data.inpe.br/bdc/stac/v1/search";
        const body = { collections:[root.id], bbox, datetime:`${date}T00:00:00Z/${date}T23:59:59Z`, limit:2 };
        const found = await probe(id, "spatial-temporal-search", searchUrl, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
        const next = found?.links?.find(l=>l.rel === "next");
        if (next?.body && next.href === searchUrl) await probe(id, "search-next-page", next.href, {
          method:next.method ?? "GET", headers:{"Content-Type":"application/json"},
          body:JSON.stringify(next.merge ? {...body,...next.body} : next.body),
        });
        await probe(id, "outside-coverage-search", searchUrl, {method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({...body,bbox:[116,-9,117,-8]})});
        await probe(id, "search-preflight", searchUrl, {method:"OPTIONS",headers:{"Access-Control-Request-Method":"POST","Access-Control-Request-Headers":"content-type"}});
        // HEAD checks availability/CORS without downloading preview bytes.
        const preview = sample.assets?.thumbnail?.href;
        if (preview?.startsWith("https://")) await probe(id, "preview-head", preview, {method:"HEAD"});
      }
    }
  }
  if (mode === "asf" && root?.features?.[0]) {
    const item=root.features[0], points=[];
    const collect=value=>{if(Array.isArray(value) && typeof value[0] === "number") points.push(value); else if(Array.isArray(value)) value.forEach(collect);};
    collect(item.geometry?.coordinates);
    if(points.length && item.properties?.startTime) {
      const query = new URL(url);
      query.searchParams.set("bbox",[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))].join(","));
      query.searchParams.set("start",item.properties.startTime.slice(0,10));
      query.searchParams.set("end",item.properties.startTime.slice(0,10)+"T23:59:59Z");
      await probe(id,"spatial-temporal-search",query.href);
    }
    if(item.properties?.browse?.[0]) await probe(id,"preview-head",item.properties.browse[0],{method:"HEAD"});
  }
  if (mode === "static" && root?.links) {
    let data = root, current = url;
    for (let depth = 0; depth < 7 && data?.type !== "Feature"; depth++) {
      const link = data.links?.find(l=>l.rel === "item") ?? data.links?.find(l=>l.rel === "child");
      if (!link) break;
      current = new URL(link.href, current).href;
      if (!current.startsWith("https://")) break;
      data = await probe(id, `static-depth-${depth+1}`, current);
    }
    const preview = Object.values(data?.assets ?? {}).find(a=>/image\/(png|jpeg|webp)/.test(a.type ?? ""));
    if (preview) await probe(id, "preview-head", new URL(preview.href,current).href, {method:"HEAD"});
  }
}
let index=0;
await Promise.all(Array.from({length:4}, async()=>{ while(index<sources.length) await review(sources[index++]); }));
const outIndex = process.argv.indexOf("--out");
const out = outIndex < 0 ? `tools/smoke/results/source-review-${new Date().toISOString().slice(0,10)}.json` : process.argv[outIndex+1];
await mkdir(dirname(out),{recursive:true});
await writeFile(out, JSON.stringify({ checkedAt:new Date().toISOString(), origin, scope:"Anonymous metadata and preview HEAD only; HTML reachability is not a search pass; no credentials or raster downloads.", sources:sources.map(([id,url,mode])=>({id,url,mode:mode??"entry-only"})), records },null,2)+"\n");
console.log(`Wrote ${records.length} probes for ${sources.length} sources to ${out}`);
