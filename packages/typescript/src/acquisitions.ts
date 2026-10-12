import { XMLParser } from "fast-xml-parser";
import { boundsAround, SatelliteError, type BoundingBox, type AcquisitionOpportunity } from "./index.js";

const ESA_ORIGIN = "https://sentinels.copernicus.eu";
const INDEXES = [
  ESA_ORIGIN + "/copernicus/sentinel-1/acquisition-plans",
  ESA_ORIGIN + "/copernicus/sentinel-2/acquisition-plans",
] as const;
const DEFAULT_MISSIONS = ["S1C", "S1D", "S2A", "S2B", "S2C"];
const MAX_INDEX_CHARS = 2_000_000;
const DEFAULT_MAX_KML_BYTES = 20_000_000;

export interface AcquisitionQuery {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  from?: string; // UTC YYYY-MM-DD; clamped to now for an upcoming query
  to?: string;   // UTC YYYY-MM-DD, inclusive
  days?: number; // Defaults to 14 if to is not supplied
  missions?: string[];
}
export interface ESAPlan {
  mission: string;
  url: string;
  startsAt: string;
  endsAt: string;
}
export interface ESAPlansOptions {
  fetchImpl?: typeof fetch;
  clock?: () => Date;
  missions?: string[];
  maxKmlBytes?: number;
}
/** One selected plan contributing to an upcoming query. */
export interface ESAPlanDiagnostic {
  mission: string;
  sourceUrl: string;
  /** File-name coverage window start (not a verified publication time). */
  startsAt: string;
  endsAt: string;
  /** True when the plan document was served from the in-memory cache. */
  fromCache: boolean;
}
export interface ESAUpcomingResult {
  opportunities: AcquisitionOpportunity[];
  /** UTC time a plan body was last downloaded, or null when no plan document was read. */
  fetchedAt: string | null;
  plans: ESAPlanDiagnostic[];
  /**
   * `ok` when at least one datatake matched, `no-current-plan` when no plan was
   * selected for the window, `no-overlap` when plans were read but nothing matched.
   */
  status: "ok" | "no-current-plan" | "no-overlap";
}
type AnyNode = Record<string, unknown>;
const asObject = (value: unknown): AnyNode | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as AnyNode : null;
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : value === undefined ? [] : [value];
const asString = (value: unknown): string => value === undefined || value === null ? "" : String(value).trim();
const utc = (value: string): string | null => {
  if (!value) return null;
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : value + "Z";
  const date = new Date(normalized);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
};
function fromSlug(value: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})t(\d{2})(\d{2})(\d{2})$/i.exec(value);
  if (!match) return null;
  return utc(match.slice(1).join("").replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6"));
}
function day(value: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new SatelliteError("INVALID_QUERY", label + " must be YYYY-MM-DD");
  const parsed = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0,10) !== value)
    throw new SatelliteError("INVALID_QUERY", label + " must be an actual calendar date");
  return parsed;
}
function queryWindow(query: AcquisitionQuery, clock: () => Date): {start:number;end:number;bounds:BoundingBox} {
  const bounds = boundsAround(query.latitude,query.longitude,query.radiusMeters);
  const now = clock().valueOf();
  if (!Number.isFinite(now)) throw new SatelliteError("INVALID_QUERY","Invalid current clock");
  const days = query.days ?? 14;
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new SatelliteError("INVALID_QUERY","days must be 1..30");
  const start = Math.max(now, query.from ? day(query.from,"from") : now);
  const end = query.to ? day(query.to,"to")+86_400_000-1 : now + days*86_400_000;
  if (end < start || end-start > 31*86_400_000)
    throw new SatelliteError("INVALID_QUERY","Invalid upcoming window (maximum 31 days)");
  if (query.missions && (!query.missions.length || query.missions.some(m=>!DEFAULT_MISSIONS.includes(m))))
    throw new SatelliteError("INVALID_QUERY","Unsupported mission filter");
  return {start,end,bounds};
}

/** Extract official KML URLs from ESA's link index. Never trust external URLs from the page. */
export function parseESAPlanIndex(html: string): ESAPlan[] {
  if (html.length > MAX_INDEX_CHARS) throw new SatelliteError("INVALID_RESPONSE","ESA index exceeded size limit");
  const found = new Map<string,ESAPlan>();
  const hrefs = html.matchAll(/href\s*=\s*(["'])(.*?)\1/gi);
  for (const [, , rawHref] of hrefs) {
    let url: URL;
    try { url = new URL(rawHref.replace(/&amp;/gi,"&"), ESA_ORIGIN); } catch { continue; }
    if (url.origin !== ESA_ORIGIN || !url.pathname.startsWith("/documents/")) continue;
    const match = url.pathname.match(/(s([12])[a-d]_mp_(?:acq__kml|user)_(\d{8}t\d{6})_(\d{8}t\d{6}))/i);
    if (!match) continue;
    const mission = match[1].slice(0,3).toUpperCase();
    if (!DEFAULT_MISSIONS.includes(mission)) continue;
    const start = fromSlug(match[3]);
    const end = fromSlug(match[4]);
    if (!start || !end || start > end) continue;
    const key = mission + ":" + match[1].toLowerCase();
    found.set(key,{ mission, url:url.toString(), startsAt:start,endsAt:end });
  }
  return [...found.values()].sort((a,b) =>
    a.mission.localeCompare(b.mission) ||
    b.startsAt.localeCompare(a.startsAt) ||
    b.endsAt.localeCompare(a.endsAt)
  );
}

type Point = [number,number];
function edgesIntersect(a:Point,b:Point,c:Point,d:Point):boolean {
  const cross = (u:Point,v:Point,w:Point) => (v[0]-u[0])*(w[1]-u[1])-(v[1]-u[1])*(w[0]-u[0]);
  const on = (u:Point,v:Point,w:Point) => Math.min(u[0],v[0])-1e-9<=w[0] &&
    w[0]<=Math.max(u[0],v[0])+1e-9 && Math.min(u[1],v[1])-1e-9<=w[1] &&
    w[1]<=Math.max(u[1],v[1])+1e-9;
  const ab = cross(a,b,c), ab2=cross(a,b,d), cd=cross(c,d,a), cd2=cross(c,d,b);
  if ((ab>0 && ab2<0 || ab<0 && ab2>0) && (cd>0 && cd2<0 || cd<0 && cd2>0)) return true;
  return (Math.abs(ab)<1e-9&&on(a,b,c)) || (Math.abs(ab2)<1e-9&&on(a,b,d)) ||
    (Math.abs(cd)<1e-9&&on(c,d,a)) || (Math.abs(cd2)<1e-9&&on(c,d,b));
}
function pointInRing(p:Point,ring:Point[]):boolean {
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const a=ring[i],b=ring[j];
    if (((a[1]>p[1]) !== (b[1]>p[1])) &&
      p[0] < ((b[0]-a[0])*(p[1]-a[1]))/(b[1]-a[1])+a[0]) inside=!inside;
  }
  return inside;
}
function ringHitsBox(ring:Point[], bbox:BoundingBox):boolean {
  const [west,south,east,north]=bbox;
  const corners:Point[]=[[west,south],[west,north],[east,north],[east,south]];
  const inside=(p:Point)=>p[0]>=west && p[0]<=east && p[1]>=south && p[1]<=north;
  if(ring.some(inside) || corners.some(p=>pointInRing(p,ring))) return true;
  for(let i=0;i<ring.length;i++) {
    const a=ring[i],b=ring[(i+1)%ring.length];
    for(let j=0;j<4;j++) if(edgesIntersect(a,b,corners[j],corners[(j+1)%4])) return true;
  }
  return false;
}
function coordinates(raw: string): Point[] {
  const ring:Point[]=raw.split(/\s+/).filter(Boolean).map(chunk=>{
    const pieces=chunk.split(",");
    return [Number(pieces[0]),Number(pieces[1])];
  });
  if(ring.length<3 || ring.length>50_000 || ring.some(p=>!p.every(Number.isFinite) ||
    p[0]<-180 || p[0]>180 || p[1]<-90 || p[1]>90)) return [];
  if(ring.length>3 && ring[0][0]===ring[ring.length-1][0] &&
    ring[0][1]===ring[ring.length-1][1]) return ring;
  return [...ring,ring[0]];
}
function allPlacemarks(root:unknown):AnyNode[] {
  const results:AnyNode[]=[];
  const visit=(node:unknown):void=>{
    const obj=asObject(node);
    if(!obj) {if(Array.isArray(node)) for(const v of node) visit(v);return;}
    for(const [key,value] of Object.entries(obj)) {
      if(key==="Placemark") for(const item of asArray(value)) {
        const pm=asObject(item); if(pm) results.push(pm);
      }
      else if(!key.startsWith("@_") && key!=="ExtendedData") visit(value);
    }
  };
  visit(root);
  return results;
}
function polygonsInPlacemark(pm:AnyNode):Point[][] {
  const found:Point[][]=[];
  const visit=(node:unknown):void=>{
    const obj=asObject(node);
    if(!obj){if(Array.isArray(node)) for(const v of node) visit(v);return;}
    if(asObject(obj.Polygon)) {
      const polygon=asObject(obj.Polygon)!;
      const outer=asObject(polygon.outerBoundaryIs);
      const ring=asObject(outer?.LinearRing);
      const pts=coordinates(asString(ring?.coordinates));
      if(pts.length) found.push(pts);
    }
    for(const [key,value] of Object.entries(obj)) if(key!=="Polygon" && key!=="ExtendedData") visit(value);
  };
  visit(pm);
  return found;
}
function metadata(pm:AnyNode):Record<string,string> {
  const result:Record<string,string>={};
  const extended=asObject(pm.ExtendedData);
  for(const item of asArray(extended?.Data)) {
    const entry=asObject(item);
    if(entry && typeof entry["@_name"]==="string") result[String(entry["@_name"])]=asString(entry.value);
  }
  for(const schema of asArray(extended?.SchemaData)) {
    const obj=asObject(schema);
    for(const item of asArray(obj?.SimpleData)) {
      const entry=asObject(item);
      if(entry && typeof entry["@_name"]==="string") result[String(entry["@_name"])]=asString(entry["#text"]);
    }
  }
  return result;
}

/** Parse ESA's real KML placemark format (ExtendedData, TimeSpan and polygon swaths). */
export function parseESAPlanKml(kml:string, plan:ESAPlan, bbox:BoundingBox,
  fromMs:number, toMs:number):AcquisitionOpportunity[] {
  if(kml.length>DEFAULT_MAX_KML_BYTES || /<!DOCTYPE/i.test(kml))
    throw new SatelliteError("INVALID_RESPONSE","KML exceeds size limit or contains a DOCTYPE");
  if(!/<\s*kml\b[^>]*xmlns\s*=\s*["'][^"']*opengis\.net\/kml\/2\.2/i.test(kml))
    throw new SatelliteError("INVALID_RESPONSE","ESA KML lacks the KML 2.2 namespace on its root element");
  let root:unknown;
  try {
    root=new XMLParser({ignoreAttributes:false,parseTagValue:false,
      parseAttributeValue:false,removeNSPrefix:true,processEntities:false}).parse(kml);
  } catch(error) {
    throw new SatelliteError("INVALID_RESPONSE","Invalid ESA KML: "+String(error));
  }
  const doc=asObject(root);
  if(!doc?.kml) throw new SatelliteError("INVALID_RESPONSE","ESA KML missing root");
  const results:AcquisitionOpportunity[]=[];
  const seen=new Set<string>();
  let placemarks:AnyNode[];
  try { placemarks=allPlacemarks(doc.kml); }
  catch(error) { throw new SatelliteError("INVALID_RESPONSE","Malformed ESA KML structure: "+String(error)); }
  for(const pm of placemarks) {
    const style=asString(pm.styleUrl);
    if(plan.mission.startsWith("S2") && !/NOMINAL/i.test(style)) continue;
    const extra=metadata(pm);
    const timespan=asObject(pm.TimeSpan);
    const time=utc(extra.ObservationTimeStart || asString(timespan?.begin));
    if(!time) continue;
    const ms=Date.parse(time);
    if(ms<fromMs || ms>toMs) continue;
    let rings:Point[][];
    try { rings=polygonsInPlacemark(pm); }
    catch { continue; }
    if(!rings.length || !rings.some(ring=>ringHitsBox(ring,bbox))) continue;
    const name=asString(extra.ID||extra.DatatakeId||pm.name)||time;
    const id=plan.mission+":"+name+":"+time;
    if(seen.has(id)) continue;
    seen.add(id);
    const mode=asString(extra.Mode);
    const stop=utc(extra.ObservationTimeStop || asString(timespan?.end));
    const rawOrbit=Number(extra.OrbitRelative);
    results.push({
      id, providerId:"esa-sentinel-plans", mission:plan.mission, expectedAt:time,
      endAt:stop, mode:mode||null,
      orbitRelative:Number.isInteger(rawOrbit)&&rawOrbit>=0?rawOrbit:null,
      status:"planned",sourceUrl:plan.url,
      footprint:rings.length===1?
        {type:"Polygon",coordinates:[rings[0]]} :
        {type:"MultiPolygon",coordinates:rings.map(ring=>[ring])},
    });
  }
  return results;
}

export class ESAPlansProvider {
  readonly id="esa-sentinel-plans";
  private readonly transport:typeof fetch;
  private readonly clock:()=>Date;
  private readonly missions:string[];
  private readonly maxKmlBytes:number;
  private readonly cache=new Map<string,{until:number;text:string;etag?:string;lastModified?:string}>();
  private readonly lastFetched=new Map<string,number>();
  constructor(options:ESAPlansOptions={}) {
    this.transport=options.fetchImpl??((input,init)=>fetch(input,init));
    this.clock=options.clock??(()=>new Date());
    this.missions=options.missions??DEFAULT_MISSIONS;
    if(!this.missions.length||this.missions.some(m=>!DEFAULT_MISSIONS.includes(m)))
      throw new SatelliteError("INVALID_PROVIDER","Unsupported ESA mission list",this.id);
    this.maxKmlBytes=options.maxKmlBytes??DEFAULT_MAX_KML_BYTES;
    if(!Number.isInteger(this.maxKmlBytes)||this.maxKmlBytes<1000||this.maxKmlBytes>50_000_000)
      throw new SatelliteError("INVALID_PROVIDER","Invalid KML size limit",this.id);
  }
  private async load(url:string,maxBytes:number):Promise<{text:string;fromCache:boolean}> {
    const parsed=new URL(url);
    if(parsed.origin!==ESA_ORIGIN || !(INDEXES.includes(url as typeof INDEXES[number]) ||
        parsed.pathname.startsWith("/documents/")))
      throw new SatelliteError("INVALID_PROVIDER","Unexpected ESA URL",this.id);
    const now=this.clock().getTime();
    const cached=this.cache.get(url);
    if(cached && cached.until>now && cached.text.length<=maxBytes) return {text:cached.text,fromCache:true};
    if(cached) this.cache.delete(url);
    // RFC 9110 conditional requests: only send validators ESA actually supplied.
    const headers:Record<string,string>={"Accept":"text/html, application/xml, application/vnd.google-earth.kml+xml"};
    if(cached?.etag) headers["If-None-Match"]=cached.etag;
    if(cached?.lastModified) headers["If-Modified-Since"]=cached.lastModified;
    let response:Response;
    try { response=await this.transport(url,{redirect:"error",signal:AbortSignal.timeout(25000),headers}); }
    catch(e){throw new SatelliteError("NETWORK","Failed to request ESA plans: "+String(e),this.id);}
    if(response.status===304 && cached) {
      // Not modified: keep the body, refresh the TTL and reuse validators.
      this.cache.set(url,{...cached,until:now+this.ttl(url)});
      return {text:cached.text,fromCache:true};
    }
    if(!response.ok) throw new SatelliteError("HTTP_ERROR","ESA returned HTTP "+response.status,this.id);
    const length=Number(response.headers.get("content-length"));
    if(length>maxBytes) throw new SatelliteError("INVALID_RESPONSE","ESA document exceeds size limit",this.id);
    const value=await response.text();
    if(value.length>maxBytes) throw new SatelliteError("INVALID_RESPONSE","ESA document exceeds size limit",this.id);
    if(this.cache.size>=12) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(url,{until:now+this.ttl(url),text:value,
      etag:response.headers.get("etag")??undefined,
      lastModified:response.headers.get("last-modified")??undefined});
    this.lastFetched.set(url,now);
    return {text:value,fromCache:false};
  }
  private ttl(url:string):number { return INDEXES.includes(url as typeof INDEXES[number])?15*60_000:60*60_000; }
  clearCache():void { this.cache.clear(); this.lastFetched.clear(); }
  async upcomingWithDiagnostics(query:AcquisitionQuery):Promise<ESAUpcomingResult> {
    const {start,end,bounds}=queryWindow(query,this.clock);
    const missions=new Set(query.missions??this.missions);
    const pages=new Set([...missions].map(m=>m.startsWith("S1")?INDEXES[0]:INDEXES[1]));
    const plans:ESAPlan[]=[];
    for(const pageUrl of pages) plans.push(...parseESAPlanIndex((await this.load(pageUrl,MAX_INDEX_CHARS)).text));
    const selected=new Map<string,ESAPlan>();
    for(const plan of plans) {
      if(!missions.has(plan.mission) || Date.parse(plan.endsAt)<start || Date.parse(plan.startsAt)>end) continue;
      const current=selected.get(plan.mission);
      if(!current || plan.startsAt>current.startsAt ||
        (plan.startsAt===current.startsAt&&plan.endsAt>current.endsAt)) selected.set(plan.mission,plan);
    }
    const all:AcquisitionOpportunity[]=[];
    const diagnostics:ESAPlanDiagnostic[]=[];
    let fetchedAt:string|null=null;
    for(const plan of selected.values()) {
      const loaded=await this.load(plan.url,this.maxKmlBytes);
      const fetched=this.lastFetched.get(plan.url);
      if(fetched!==undefined && (fetchedAt===null || fetched>Date.parse(fetchedAt))) fetchedAt=new Date(fetched).toISOString();
      diagnostics.push({mission:plan.mission,sourceUrl:plan.url,startsAt:plan.startsAt,endsAt:plan.endsAt,fromCache:loaded.fromCache});
      all.push(...parseESAPlanKml(loaded.text,plan,bounds,start,end));
    }
    all.sort((a,b)=>a.expectedAt.localeCompare(b.expectedAt)||a.mission.localeCompare(b.mission));
    const status:ESAUpcomingResult["status"]=all.length?"ok":(selected.size?"no-overlap":"no-current-plan");
    return {opportunities:all,fetchedAt,plans:diagnostics,status};
  }
  async upcoming(query:AcquisitionQuery):Promise<AcquisitionOpportunity[]> {
    return (await this.upcomingWithDiagnostics(query)).opportunities;
  }
}
export function esaSentinelPlans(options:ESAPlansOptions={}):ESAPlansProvider {
  return new ESAPlansProvider(options);
}
