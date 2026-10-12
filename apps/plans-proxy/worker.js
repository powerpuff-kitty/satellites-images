/**
 * ESA acquisition plan proxy only. Explicitly allowlisted public KML/index URLs.
 * No API keys, arbitrary forward URLs, private networks, or user-controlled hosts.
 */
const ESA="https://sentinels.copernicus.eu";
const INDEXES=new Set([
  "/copernicus/sentinel-1/acquisition-plans",
  "/copernicus/sentinel-2/acquisition-plans",
]);
const KML=/^\/documents\/d\/sentinel\/s(?:1[c-d]|2[a-c])_mp_(?:user|acq__kml)_\d{8}t\d{6}_\d{8}t\d{6}$/i;
const CORS={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Methods":"GET, OPTIONS",
  "Access-Control-Allow-Headers":"Accept",
  "Vary":"Origin",
};
const simple=(status,body)=>new Response(body,{status,headers:{
  ...CORS,"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store",
}});
export default {
  async fetch(request) {
    if(request.method==="OPTIONS") return new Response(null,{status:204,headers:CORS});
    if(request.method!=="GET") return simple(405,"Only GET is supported");
    const incoming=new URL(request.url);
    if(!INDEXES.has(incoming.pathname)&&!KML.test(incoming.pathname))
      return simple(404,"Only official ESA acquisition plan pages and KMLs can be requested");
    if(incoming.search) return simple(400,"Query parameters are not supported");
    try {
      const upstream=await fetch(ESA+incoming.pathname,{
        redirect:"manual",
        headers:{"Accept":"text/html, application/xml, application/vnd.google-earth.kml+xml"},
        cf:{cacheEverything:true,cacheTtl:1800},
      });
      if(upstream.status>=300&&upstream.status<400)
        return simple(502,"Unexpected ESA redirect");
      if(!upstream.ok) return simple(upstream.status,"ESA upstream returned "+upstream.status);
      const type=upstream.headers.get("content-type")||"application/xml";
      const headers=new Headers(CORS);
      headers.set("Content-Type",type);
      headers.set("Cache-Control","public,max-age=600");
      return new Response(upstream.body,{status:200,headers});
    } catch {
      return simple(502,"ESA acquisition plan service unavailable");
    }
  },
};
