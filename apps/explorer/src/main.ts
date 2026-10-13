// maplibre-gl 6 dropped the default export: the ESM build is named-exports only, so a
// namespace import is the documented form (the types still advertise a default, which is
// why this only fails at bundle time).
import * as maplibregl from "maplibre-gl";
// maplibre-gl 6 also derives its worker URL at runtime, and bundlers do not follow that
// reference: the built app requested a path that did not exist, so vite served the SPA HTML
// and the worker never started (no tiles, no sources). Import the worker as a build asset.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { FeatureCollection, Geometry } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import "@fortawesome/fontawesome-free/css/all.min.css";
import "./style.css";
import { SatelliteCatalog, earthSearch, planetaryComputer, copernicusDataSpace, asfSearch,
  cmrStac, jaxaGPortal, esaSentinelPlans, listSources, AvailabilityAccumulator,
  type AvailabilitySummary,
  type Scene, type SceneAsset, type AcquisitionOpportunity, type SearchProvider } from "@powerpuff-kitty/satellites-images";
import { shiftMonth, monthDates } from "./calendar.js";

const element = <T extends Element>(id: string): T => {
  const item = document.getElementById(id);
  if (!item) throw new Error("Missing UI element " + id);
  return item as unknown as T;
};
const lat = element<HTMLInputElement>("latitude");
const lon = element<HTMLInputElement>("longitude");
const radius = element<HTMLSelectElement>("radius");
const from = element<HTMLInputElement>("date-from");
const to = element<HTMLInputElement>("date-to");
const status = element<HTMLElement>("status");
const results = element<HTMLOListElement>("results");
const counter = element<HTMLElement>("counter");
const form = element<HTMLFormElement>("search-form");
const calendarStatus = element<HTMLElement>("calendar-status");
const mapLabel = element<HTMLElement>("map-label");
const mapContainer = element<HTMLElement>("map-container");
const matrixHead = element<HTMLElement>("matrix-head");
const drawAreaButton = element<HTMLButtonElement>("draw-area");
const clearAreaButton = element<HTMLButtonElement>("clear-area");
const sourceList = element<HTMLElement>("source-list");
const coverage = element<HTMLElement>("coverage");
const allDaysButton = element<HTMLButtonElement>("show-all-days");
const showMoreButton = element<HTMLButtonElement>("show-more-scenes");
const loadNextPagesButton = element<HTMLButtonElement>("load-next-pages");
const missionFilter = element<HTMLSelectElement>("mission-filter");
const collectionFilter = element<HTMLSelectElement>("collection-filter");
const providerFilter = element<HTMLSelectElement>("provider-filter");
const orbitFilter = element<HTMLSelectElement>("orbit-filter");
const tilesOnly = element<HTMLInputElement>("tiles-only");
const cloudMin = element<HTMLSelectElement>("cloud-min");
const cloudMax = element<HTMLSelectElement>("cloud-max");
const hourMin = element<HTMLSelectElement>("hour-min");
const hourMax = element<HTMLSelectElement>("hour-max");
const resolutionFilter = element<HTMLSelectElement>("resolution-filter");
const hasPreview = element<HTMLInputElement>("has-preview");
const includeUnknown = element<HTMLInputElement>("include-unknown");
const clearFilters = element<HTMLButtonElement>("clear-filters");
const matrixPanel = element<HTMLElement>("map-matrix");
const matrixLinks = element<HTMLElement>("matrix-links");
const matrixSvg = element<SVGSVGElement>("matrix-svg");
const matrixQuick = element<HTMLElement>("matrix-quick");
const matrixMoreToggle = element<HTMLButtonElement>("matrix-more");
const matrixMoreLabel = element<HTMLElement>("matrix-more-label");
const matrixMoreMenu = element<HTMLElement>("matrix-more-menu");
const matrixPrevYear = element<HTMLButtonElement>("matrix-prev-year");
const matrixNextYear = element<HTMLButtonElement>("matrix-next-year");
const mapPreview = element<HTMLElement>("map-preview");
const previewCaption = element<HTMLElement>("preview-caption");
const previewPrev = element<HTMLButtonElement>("preview-prev");
const previewNext = element<HTMLButtonElement>("preview-next");
const previewClose = element<HTMLButtonElement>("preview-close");

const plansResults = element<HTMLOListElement>("plans-results");
const tabHistorical = element<HTMLButtonElement>("tab-historical");
const tabUpcoming = element<HTMLButtonElement>("tab-upcoming");
const panelHistorical = element<HTMLElement>("panel-historical");
const panelUpcoming = element<HTMLElement>("panel-upcoming");
const upcomingMission = element<HTMLSelectElement>("upcoming-mission");
const upcomingStatus = element<HTMLElement>("upcoming-status");
const obsTitle = element<HTMLElement>("obs-title");

// In Vite development, /esa-proxy is served by a restricted HTTPS reverse proxy.
// For deployed static applications set VITE_ESA_PROXY_URL to the optional Cloudflare Worker.
// No arbitrary destination URLs or API credentials are ever accepted by the proxy.
const esaProxy = import.meta.env.VITE_ESA_PROXY_URL ??
  (import.meta.env.DEV ? "/esa-proxy" : "");

// Base map style. Defaults to OpenFreeMap's keyless, open-source "Liberty" vector
// style (OpenStreetMap data). Override with VITE_MAP_STYLE_URL for another open
// provider (e.g. VersaTiles) or a self-hosted PMTiles/MapTiler style.
const mapStyle = import.meta.env.VITE_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/liberty";

const ESA_FETCH_TIMEOUT_MS = 20000;

function esaFetch(url: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  const original = new URL(String(url));
  if (original.origin !== "https://sentinels.copernicus.eu") {
    throw new Error("ESA adapter attempted to fetch an unexpected origin");
  }
  const proxied = esaProxy ?
    esaProxy.replace(/\/$/,"") + original.pathname : original.toString();
  // A missing or blocked proxy should fail as a bounded timeout, not a hung request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ESA_FETCH_TIMEOUT_MS);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  return fetch(proxied, { ...options, signal }).finally(() => clearTimeout(timer));
}


const plannedProvider=esaSentinelPlans({fetchImpl:esaFetch});

maplibregl.setWorkerUrl(maplibreWorkerUrl);

const map = new maplibregl.Map({
  container: "map",
  style: mapStyle,
  center: [116.1167, -8.5833],
  zoom: 8,
  // The basemap attribution is added by hand below: MapLibre renders the compact
  // attribution expanded on wide maps, and the day matrix owns the bottom band, so the
  // required attribution would be covered there.
  attributionControl: false,
});
map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");
const marker = new maplibregl.Marker({color:"#e0a84b"})
  .setLngLat([116.1167, -8.5833]).addTo(map);

function hideMapLabel():void { mapLabel.hidden=true; }
function updateLocation(latitude: number, longitude: number, fly = false): void {
  lat.value = latitude.toFixed(5);
  lon.value = longitude.toFixed(5);
  marker.setLngLat([longitude, latitude]);
  if (fly) map.flyTo({center:[longitude,latitude], zoom:Math.max(map.getZoom(), 8)});
}
// --- Drawn area (polygon AOI) -------------------------------------------------
let aoiRing:[number,number][]|null=null;
let drawingArea=false;
let draftRing:[number,number][]=[];
function aoiCentroid(ring:[number,number][]):[number,number] {
  const sum=ring.reduce((acc,[lng,lat])=>[acc[0]+lng,acc[1]+lat],[0,0]);
  return [sum[0]/ring.length,sum[1]/ring.length];
}
function renderAoi():void {
  const ring=drawingArea?draftRing:(aoiRing??[]);
  const features:FeatureCollection["features"]=[];
  if(ring.length>=3){
    const closed:[number,number][]=[...ring,ring[0]];
    features.push({type:"Feature",properties:{},geometry:{type:"Polygon",coordinates:[closed]}});
  }else if(ring.length>=2){
    features.push({type:"Feature",properties:{},geometry:{type:"LineString",coordinates:ring}});
  }
  const data:FeatureCollection={type:"FeatureCollection",features};
  const apply=()=>{
    const source=map.getSource("drawn-area") as maplibregl.GeoJSONSource|undefined;
    if(source){source.setData(data);return;}
    map.addSource("drawn-area",{type:"geojson",data});
    map.addLayer({id:"drawn-area-fill",type:"fill",source:"drawn-area",
      paint:{"fill-color":"#e2ae54","fill-opacity":0.16}});
    map.addLayer({id:"drawn-area-line",type:"line",source:"drawn-area",
      paint:{"line-color":"#e2ae54","line-width":2}});
  };
  if(map.isStyleLoaded())apply();else map.once("load",apply);
}
function setAreaMode(active:boolean):void {
  drawingArea=active;
  draftRing=[];
  drawAreaButton.textContent=active?"Finish area":"Draw area";
  clearAreaButton.hidden=!active&&!aoiRing;
  renderAoi();
}
drawAreaButton.addEventListener("click",()=>{
  if(!drawingArea){ aoiRing=null; setAreaMode(true); status.textContent="Click the map to add corners, then press Finish area (3 or more points)."; return; }
  if(draftRing.length>=3){ aoiRing=[...draftRing]; setAreaMode(false); void runSearch(); }
  else { setAreaMode(false); status.textContent="An area needs at least three corners; keeping point + radius."; }
});
clearAreaButton.addEventListener("click",()=>{
  aoiRing=null; setAreaMode(false);
  void runSearch();
});

let searchTimer=0;
function scheduleSearch():void{ window.clearTimeout(searchTimer); searchTimer=window.setTimeout(()=>void runSearch(), 350); }
let activeTab:"historical"|"upcoming"="historical";
function scheduleForTab():void{ if(activeTab==="upcoming") scheduleUpcoming(); else scheduleSearch(); }
map.on("click", (e) => {
  if(drawingArea){ draftRing.push([e.lngLat.lng,e.lngLat.lat]); renderAoi(); return; }
  // Choosing a different location replaces any drawn area.
  if(aoiRing){ aoiRing=null; setAreaMode(false); }
  updateLocation(e.lngLat.lat, e.lngLat.lng); hideMapLabel(); scheduleForTab();
});
for (const el of [lat,lon]) el.addEventListener("change", () => {
  if (Number.isFinite(lat.valueAsNumber) && Number.isFinite(lon.valueAsNumber)) {
    if(aoiRing){ aoiRing=null; setAreaMode(false); }
    updateLocation(lat.valueAsNumber, lon.valueAsNumber, true);
    hideMapLabel();
    scheduleForTab();
  }
});
for (const el of [radius]) el.addEventListener("change", scheduleForTab);
for (const el of [from,to]) el.addEventListener("change", () => {
  if(clampSearchRange()) status.textContent="Search range clamped to "+MIN_SEARCH_DATE+" \u2026 "+maxSearchDate()+".";
  scheduleSearch();
});

function icon(cls:string):HTMLElement {
  const node=document.createElement("i");
  node.className="fa-solid "+cls;
  node.setAttribute("aria-hidden","true");
  return node;
}
function line(label: string, value: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "meta-line";
  const title = document.createElement("span");
  title.textContent = label;
  const content = document.createElement("span");
  content.textContent = value;
  wrapper.append(title, content);
  return wrapper;
}
function makeScene(scene: Scene): HTMLLIElement {
  const item = document.createElement("li");
  item.dataset.sceneId = scene.id;
  const heading = document.createElement("div");
  heading.className = "scene-heading";
  const name = document.createElement("strong");
  name.textContent = scene.mission ?? scene.collection;
  const time = document.createElement("time");
  time.textContent = new Date(scene.acquiredAt).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"medium",timeZone:"UTC"})+" UTC";
  time.dateTime = scene.acquiredAt;
  heading.append(name,time);
  item.append(heading);
  item.append(line("Scene",scene.id));
  item.append(line("Collection",scene.collection));
  item.append(line("Cloud coverage",scene.cloudCoverPercent===null?"Unknown":scene.cloudCoverPercent.toFixed(1)+"% (scene-wide)"));
  if (scene.gsdMeters !== null) item.append(line("Resolution", scene.gsdMeters + " m/pixel"));
  if (scene.coveragePercent !== null) item.append(line("Covers your area", scene.coveragePercent.toFixed(0) + "%"));
  const accessLabel = scene.access === "open" ? "Open (declared)"
    : scene.access === "authentication-required" ? "Account required"
    : scene.access === "payment-required" ? "Payment or entitlement required"
    : "Not verified";
  item.append(line("Image access", accessLabel));
  const previewHref = previewUrlFor(scene);
  if (previewHref) {
    try {
      const url = new URL(previewHref);
      if (url.protocol === "https:") {
        const image = document.createElement("img");
        image.src = url.toString();
        image.alt = "Provider preview of satellite scene " + scene.id;
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        image.tabIndex = 0;
        image.setAttribute("role", "button");
        image.title = "Show this image on the map";
        image.addEventListener("error", () => image.remove());
        const open = () => openScenePreview(scene);
        image.addEventListener("click", open);
        image.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
        });
        item.append(image);
      }
    } catch { /* Invalid preview: no link */ }
  }
  if (scene.sourceUrl) {
    try {
      const source = new URL(scene.sourceUrl);
      if (source.protocol === "https:") {
        const link = document.createElement("a");
        link.href = source.toString();
        link.rel = "noopener noreferrer";
        link.target = "_blank";
        link.textContent = "View source metadata";
        link.append(icon("fa-arrow-up-right-from-square"));
        item.append(link);
      }
    } catch { /* Invalid source link */ }
  }
  return item;
}

// --- Scene image overlaid on the map (pan/zoom like the map) ------------------
let previewScenes:Scene[]=[];
let previewIndex=0;
// Object URL backing an image overlay (revoked when the preview changes or closes).
let previewObjectUrl:string|null=null;
// Ceiling on a preview fetched for the map overlay.
const MAX_OVERLAY_BYTES=8*1024*1024;
type PreviewCorner=[number,number];
const DISPLAYABLE_IMAGE=/^image\/(jpeg|png|webp|avif)$/i;
const RASTER_EXTENSION=/\.(jpe?g|png|webp|avif)(\?|#|$)/i;
const PREVIEW_PRIORITY=["rendered_preview","overview","visual","preview","thumbnail"];
function isDisplayable(asset:SceneAsset):boolean {
  // Only http(s) assets can be shown in an <img>/raster layer (Landsat's hrefs are s3://).
  if(!/^https?:\/\//i.test(asset.href))return false;
  return (asset.type!==null&&DISPLAYABLE_IMAGE.test(asset.type))||RASTER_EXTENSION.test(asset.href);
}
/** The best displayable still image the provider exposes for a scene. */
function previewUrlFor(scene:Scene):string|null {
  const candidates=scene.assets.filter(isDisplayable);
  if(!candidates.length)return scene.previewUrl;
  const rank=(asset:SceneAsset)=>{
    const keys=[asset.key,...asset.roles].map((value)=>value.toLowerCase());
    const found=PREVIEW_PRIORITY.findIndex((name)=>keys.includes(name));
    return found<0?PREVIEW_PRIORITY.length:found;
  };
  return [...candidates].sort((a,b)=>rank(a)-rank(b))[0].href;
}
// A cross-origin WebGL overlay needs CORS and, to stay sharp, a tile set rendered at the
// imagery's native ground sample distance. Some sources cannot supply that: Earth Search
// serves Landsat browse as s3:// plus a non-CORS redirect. Planetary Computer exposes
// CORS-enabled tiles for both Landsat (same item id) and Sentinel-2 (different ids, so it
// is resolved by MGRS tile and acquisition day).
const PLANETARY_COMPUTER_RENDER:Record<string,string>={
  "landsat-c2-l2":"assets=red&assets=green&assets=blue&color_formula=gamma%20RGB%202.7,%20saturation%201.5,%20sigmoidal%20RGB%2015%200.55",
  "sentinel-2-l2a":"assets=visual&asset_bidx=visual%7C1,2,3&nodata=0",
};
function tileAssetFor(scene:Scene):string|null {
  return scene.assets.find((asset)=>asset.roles.includes("tiles")&&/^https?:\/\//i.test(asset.href))?.href??null;
}
function rawProperties(scene:Scene):Record<string,unknown> {
  const properties=(scene.raw as Record<string,unknown>)["properties"];
  return properties&&typeof properties==="object"?properties as Record<string,unknown>:{};
}
function mgrsTile(scene:Scene):string|null {
  const properties=rawProperties(scene);
  const grid=properties["grid:code"];
  if(typeof grid==="string"&&grid.startsWith("MGRS-"))return grid.slice(5);
  const tile=properties["s2:mgrs_tile"];
  return typeof tile==="string"?tile:null;
}
const pcIdCache=new Map<string,string|null>();
/** The matching Planetary Computer item id (Landsat ids match; Sentinel-2 is looked up). */
async function resolvePlanetaryComputerId(scene:Scene):Promise<string|null> {
  if(scene.collection==="landsat-c2-l2")return scene.id;
  const key=scene.collection+"/"+scene.id;
  const cached=pcIdCache.get(key);
  if(cached!==undefined)return cached;
  const tile=mgrsTile(scene), day=scene.acquiredAt.slice(0,10);
  let resolved:string|null=null;
  if(tile){
    try {
      const response=await fetch("https://planetarycomputer.microsoft.com/api/stac/v1/search",{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({collections:[scene.collection],
          filter:{op:"=",args:[{property:"s2:mgrs_tile"},tile]},
          datetime:day+"T00:00:00Z/"+day+"T23:59:59Z",limit:5}),
      });
      if(response.ok){
        const payload=await response.json() as {features?:unknown[]};
        const wanted=Date.parse(scene.acquiredAt);
        const best=(Array.isArray(payload.features)?payload.features:[])
          .map((feature)=>feature as {id?:unknown;properties?:Record<string,unknown>})
          .filter((feature)=>typeof feature.id==="string")
          .map((feature)=>({id:feature.id as string,at:Date.parse(String(feature.properties?.datetime??""))}))
          .filter((candidate)=>Number.isFinite(candidate.at))
          .sort((a,b)=>Math.abs(a.at-wanted)-Math.abs(b.at-wanted))[0];
        if(best)resolved=best.id;
      }
    } catch { resolved=null; }
  }
  pcIdCache.set(key,resolved);
  return resolved;
}
function planetaryComputerUrl(kind:"tilejson.json"|"preview.png",collection:string,id:string):string {
  return "https://planetarycomputer.microsoft.com/api/data/v1/item/"+kind+
    "?collection="+encodeURIComponent(collection)+"&item="+encodeURIComponent(id)+
    "&"+PLANETARY_COMPUTER_RENDER[collection]+"&format=png";
}
interface PreviewOverlay { tiles:string|null; image:string|null }
/** Fetch an image we cannot hand to MapLibre directly.
 *
 * Provider previews such as Earth Search's Sentinel-2 `preview.jpg` on S3 are loaded by the
 * result cards as a plain `<img>`, which caches an opaque (no-CORS) response for that URL. A
 * later CORS fetch of the same URL — MapLibre's image source included — then fails from that
 * cache with a misleading "No 'Access-Control-Allow-Origin' header" error, even though the file
 * itself returns `Access-Control-Allow-Origin: *`. Fetching the bytes here with
 * `cache: "reload"` bypasses the opaque entry, and handing MapLibre an object URL sidesteps its
 * own request, so a freshly published scene can still be drawn on the map. */
async function fetchOverlayImage(url:string, signal?:AbortSignal):Promise<string|null> {
  try {
    // `cache: "reload"` matters: the result cards load the same URL as a plain <img>, which
    // caches an opaque response, and a later CORS fetch of that URL then fails from the cache
    // ("Failed to fetch") until it is bypassed.
    const response=await fetch(url,{mode:"cors",cache:"reload",signal});
    if(!response.ok)return null;
    const blob=await response.blob();
    if(!blob.type.startsWith("image/")||blob.size>MAX_OVERLAY_BYTES)return null;
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}
async function resolveOverlay(scene:Scene):Promise<PreviewOverlay> {
  const own=tileAssetFor(scene);
  if(own)return {tiles:own,image:null};
  if(PLANETARY_COMPUTER_RENDER[scene.collection]){
    const id=await resolvePlanetaryComputerId(scene);
    if(id)return {tiles:planetaryComputerUrl("tilejson.json",scene.collection,id),
      image:planetaryComputerUrl("preview.png",scene.collection,id)};
  }
  const direct=previewUrlFor(scene);
  if(direct){
    const objectUrl=await fetchOverlayImage(direct);
    if(objectUrl)return {tiles:null,image:objectUrl};
  }
  return {tiles:null,image:null};
}
/** Whether a scene has anything we can put on the map (checked synchronously). */
function canOverlay(scene:Scene):boolean {
  return Boolean(previewUrlFor(scene)??tileAssetFor(scene)??PLANETARY_COMPUTER_RENDER[scene.collection]);
}
function previewCoordinates(scene:Scene):[PreviewCorner,PreviewCorner,PreviewCorner,PreviewCorner] {
  const box=Array.isArray(scene.bbox)&&scene.bbox.length===4?scene.bbox as number[]:null;
  if(box&&box.every((value)=>Number.isFinite(value))){
    const [west,south,east,north]=box;
    return [[west,north],[east,north],[east,south],[west,south]];
  }
  // No footprint: anchor a square over the current search location, sized by radius.
  const lng=Number(lon.value), centerLat=Number(lat.value);
  const d=Math.max(0.005, Number(radius.value)/111320);
  return [[lng-d,centerLat+d],[lng+d,centerLat+d],[lng+d,centerLat-d],[lng-d,centerLat-d]];
}
function removePreviewLayer():void {
  if(map.isStyleLoaded()){
    if(map.getLayer("scene-preview-layer"))map.removeLayer("scene-preview-layer");
    if(map.getSource("scene-preview"))map.removeSource("scene-preview");
  }
  releasePreviewObjectUrl();
}
/** Frees the object URL backing an image overlay (see `fetchOverlayImage`). */
function releasePreviewObjectUrl():void {
  if(previewObjectUrl){ URL.revokeObjectURL(previewObjectUrl); previewObjectUrl=null; }
}
/** Highlights the card whose image is currently on the map. */
function markActiveCard(id:string|null):void {
  for(const item of results.querySelectorAll<HTMLElement>("li[data-scene-id]"))
    item.classList.toggle("active", item.dataset.sceneId===id);
}
let previewToken=0;
async function showMapPreview(index:number):Promise<void> {
  const scene=previewScenes[index];
  if(!scene){ closeMapPreview(); return; }
  const token=++previewToken;
  previewIndex=index;
  const overlay=await resolveOverlay(scene);
  if(token!==previewToken)return;  // superseded by a newer selection
  if(!overlay.tiles&&!overlay.image){
    closeMapPreview();
    status.textContent="This scene's image cannot be drawn on the map (its preview is not "+
      "CORS-enabled). Open the card image instead.";
    return;
  }
  const coordinates=previewCoordinates(scene);
  const apply=()=>{
    removePreviewLayer();
    // A provider tile set renders the true-colour image at native resolution; otherwise
    // overlay the best still preview, georeferenced to the scene footprint. The map
    // zoom is left untouched so the view does not jump when an image is opened.
    if(overlay.tiles)map.addSource("scene-preview",{type:"raster",url:overlay.tiles,tileSize:256});
    else {
      if(overlay.image?.startsWith("blob:"))previewObjectUrl=overlay.image;
      map.addSource("scene-preview",{type:"image",url:overlay.image as string,coordinates});
    }
    // Exposed for tests: which kind of overlay is on the map ("tiles" or "image").
    mapContainer.dataset.previewSource=overlay.tiles?"tiles":"image";
    map.addLayer({id:"scene-preview-layer",type:"raster",source:"scene-preview",
      paint:{"raster-opacity":0.96}});
  };
  if(map.isStyleLoaded())apply();else map.once("load",apply);
  highlightScene(scene);   // the footprint is shown with the image, not by a card button
  markActiveCard(scene.id);
  previewCaption.textContent=(scene.mission ?? scene.collection)+" · "+
    new Date(scene.acquiredAt).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short",timeZone:"UTC"})+" UTC";
  mapPreview.hidden=false;
  storeSearchLink();   // keep the permalink pointing at the image on the map
}
function closeMapPreview():void {
  previewToken++;
  if(mapPreview.hidden)return;
  mapPreview.hidden=true;
  delete mapContainer.dataset.previewSource;
  removePreviewLayer();
  highlightScene(undefined);
  markActiveCard(null);
  storeSearchLink();
}
function stepPreview(delta:number):void {
  if(!previewScenes.length)return;
  void showMapPreview((previewIndex+delta+previewScenes.length)%previewScenes.length);
}
function openScenePreview(scene:Scene):void {
  const withPreviews=visibleScenes().filter(canOverlay);
  const index=withPreviews.indexOf(scene);
  if(index<0)return;
  previewScenes=withPreviews;
  void showMapPreview(index);
}
previewPrev.addEventListener("click",()=>stepPreview(-1));
previewNext.addEventListener("click",()=>stepPreview(1));
previewClose.addEventListener("click",closeMapPreview);
document.addEventListener("keydown",(event)=>{ if(event.key==="Escape"&&!mapPreview.hidden)closeMapPreview(); });

// --- Day classification (cloud classes + palette used by the day matrix) ------
type CloudClass = "clear" | "partial" | "cloudy" | "unknown";
const CLOUD_FILL: Record<CloudClass, string> = { clear:"#4fbf7a", partial:"#e0ae54", cloudy:"#9aa0a2", unknown:"#5b665b" };
function cloudClassOf(percent: number | null): CloudClass {
  if (percent === null) return "unknown";
  if (percent < 10) return "clear";
  if (percent < 60) return "partial";
  return "cloudy";
}
const SPLIT_PALETTE = ["#e0ae54","#6fb3d2","#b98ad6","#4fbf7a","#d98a6a","#9aa0a2","#c0d76a","#7f8cff","#e58fb0","#7ad1c0"];
function selectTimelineDay(day:string):void {
  // Clicking the active day again clears the selection.
  selectedDay = selectedDay === day ? null : day;
  displayedLimit = 40;
  redrawAvailability();
  renderLoadedScenes();
  storeSearchLink();
}
// --- Year-at-a-glance day matrix (GitHub-style, 8x8 px cells) ------------------
type MatrixMetric = "total" | "cloud" | "mission" | "provider" | "resolution" | "sensor" | "hour" | "orbit";
const EXTRA_METRICS:{metric:MatrixMetric;label:string}[]=[
  {metric:"resolution",label:"Resolution"},
  {metric:"sensor",label:"Sensor"},
  {metric:"hour",label:"Time of day"},
  {metric:"orbit",label:"Orbit"},
];
let matrixMetric:MatrixMetric = "total";
let matrixItems:Scene[] = [];
const MATRIX_EMPTY = "#2f3830";   // a day inside the window with no observations
/** The bucket a scene falls into for a given metric. */
function matrixKeyOf(scene:Scene, metric:MatrixMetric):string {
  switch(metric){
    case "mission": return scene.mission || "unknown";
    case "provider": return scene.providerId;
    case "sensor": return isRadarScene(scene) ? "radar" : "optical";
    case "resolution": {
      const gsd=scene.gsdMeters;
      if(gsd===null)return "unknown";
      if(gsd<=1)return "\u22641 m";
      if(gsd<=10)return "\u226410 m";
      if(gsd<=30)return "\u226430 m";
      return ">30 m";
    }
    case "hour": {
      const block=Math.floor(new Date(scene.acquiredAt).getUTCHours()/6)*6;
      return String(block).padStart(2,"0")+"\u2013"+String(block+6).padStart(2,"0");
    }
    case "orbit": {
      const state=rawProperties(scene)["sat:orbit_state"];
      return typeof state==="string" ? state.toLowerCase() : "unknown";
    }
    default: return "unknown";
  }
}
function matrixColourOf(list:Scene[], metric:MatrixMetric, max:number, order:string[], keyOf:(scene:Scene)=>string):string {
  if(metric==="total"){
    const alpha=0.22+0.78*Math.min(1,list.length/max);
    return `rgba(79,191,122,${alpha.toFixed(2)})`;
  }
  if(metric==="cloud"){
    const classes=list.map((scene)=>cloudClassOf(scene.cloudCoverPercent));
    if(classes.includes("clear"))return CLOUD_FILL.clear;
    if(classes.includes("partial"))return CLOUD_FILL.partial;
    if(classes.includes("cloudy"))return CLOUD_FILL.cloudy;
    return CLOUD_FILL.unknown;
  }
  const counts=new Map<string,number>();
  for(const scene of list){
    const key=keyOf(scene);
    counts.set(key,(counts.get(key)??0)+1);
  }
  const top=[...counts.entries()].sort((a,b)=>b[1]-a[1])[0][0];
  const index=Math.max(0,order.indexOf(top));
  return SPLIT_PALETTE[index%SPLIT_PALETTE.length];
}
let matrixDays:string[]=[];
let matrixHasData=new Set<string>();
function focusMatrixCell(day:string):void {
  matrixSvg.querySelector<SVGElement>('.matrix-cell[data-day="'+day+'"]')?.focus();
}
/** Moves focus to the next selectable cell (+7 = a week, +1 = a day). */
function moveMatrixFocus(from:string, delta:number):void {
  const fromIndex=matrixDays.indexOf(from);
  if(fromIndex<0)return;
  for(let i=fromIndex+delta;i>=0&&i<matrixDays.length;i+=delta){
    if(matrixHasData.has(matrixDays[i])){ focusMatrixCell(matrixDays[i]); return; }
  }
}
function matrixCellKeydown(event:KeyboardEvent, day:string):void {
  const delta=event.key==="ArrowRight"?7:event.key==="ArrowLeft"?-7
    :event.key==="ArrowDown"?1:event.key==="ArrowUp"?-1:0;
  if(delta!==0){ event.preventDefault(); moveMatrixFocus(day,delta); return; }
  if(event.key==="Enter"||event.key===" "){
    event.preventDefault();
    selectTimelineDay(day);
    focusMatrixCell(day);   // the grid is rebuilt, so restore focus
  }
}
const MATRIX_MAX_DAYS=731;   // ~2 years: beyond this the grid is not renderable
const MATRIX_MIN_CELL=6;     // cells shrink to this before the grid is allowed to scroll
let matrixTruncated=false;
function renderMatrix():void {
  const NS="http://www.w3.org/2000/svg";
  matrixSvg.replaceChildren();
  const scenes=matrixItems, metric=matrixMetric;
  let windowStart=from.value;
  const windowEnd=to.value;
  const spanDays=Math.round((Date.parse(windowEnd+"T00:00:00Z")-Date.parse(windowStart+"T00:00:00Z"))/86400000)+1;
  matrixTruncated=spanDays>MATRIX_MAX_DAYS;
  if(matrixTruncated)
    windowStart=new Date(Date.parse(windowEnd+"T00:00:00Z")-(MATRIX_MAX_DAYS-1)*86400000).toISOString().slice(0,10);
  const windowFrom=Date.parse(windowStart+"T00:00:00Z");
  const windowTo=Date.parse(windowEnd+"T00:00:00Z");
  // Always draw the window's grid, even when nothing was returned, so the year never
  // disappears; only a missing/invalid date range hides the matrix.
  if(!Number.isFinite(windowFrom)||!Number.isFinite(windowTo)||windowTo<windowFrom){
    matrixPanel.hidden=true; return;
  }
  matrixPanel.hidden=false;
  const dayMs=86400000;
  const first=windowFrom, last=windowTo;
  const startDow=(new Date(first).getUTCDay()+6)%7;
  const start=first-startDow*dayMs;
  const endDow=(new Date(last).getUTCDay()+6)%7;
  const end=last+(6-endDow)*dayMs;
  const nDays=Math.max(1,Math.round((end-start)/dayMs)+1);
  const weeks=Math.ceil(nDays/7);
  // The whole loaded range must be visible: a clipped December reads as a broken calendar.
  // Cells shrink from 12 px down to 6 px to fit the map pane, and only scroll below that.
  // 98 px = the panel's 76 px max-width gutter (which also holds the year stepper) plus
  // 20 px padding and 2 px borders.
  const paneWidth=matrixPanel.parentElement?.clientWidth ?? 0;
  const cell=Math.max(MATRIX_MIN_CELL,Math.min(12,Math.floor(Math.max(140,paneWidth-98)/weeks)-1));
  const step=cell+1;
  const width=weeks*step, height=7*step;
  matrixSvg.setAttribute("viewBox",`0 0 ${width} ${height}`);
  matrixSvg.setAttribute("width",String(width));
  matrixSvg.setAttribute("height",String(height));
  const perDay=new Map<string,Scene[]>();
  for(const scene of scenes){
    const day=scene.acquiredAt.slice(0,10);
    const list=perDay.get(day);
    if(list)list.push(scene); else perDay.set(day,[scene]);
  }
  let max=1;
  for(const list of perDay.values())max=Math.max(max,list.length);
  const keyOf=(scene:Scene)=>matrixKeyOf(scene,metric);
  const order:string[]=[];
  if(metric!=="total"&&metric!=="cloud"){
    const totals=new Map<string,number>();
    for(const scene of scenes){
      const key=keyOf(scene);
      totals.set(key,(totals.get(key)??0)+1);
    }
    order.push(...[...totals.keys()].sort((a,b)=>totals.get(b)!-totals.get(a)!));
  }
  matrixDays=[]; matrixHasData=new Set<string>();
  for(let d=0;d<nDays;d++){
    const time=start+d*dayMs;
    const day=new Date(time).toISOString().slice(0,10);
    const inWindow=time>=first&&time<=last;
    const list=inWindow?perDay.get(day):undefined;
    if(inWindow)matrixDays.push(day);
    if(list)matrixHasData.add(day);
    const rect=document.createElementNS(NS,"rect");
    rect.setAttribute("class","matrix-cell");
    rect.setAttribute("data-day",day);
    rect.setAttribute("x",String(Math.floor(d/7)*step));
    rect.setAttribute("y",String((d%7)*step));
    rect.setAttribute("width",String(cell));
    rect.setAttribute("height",String(cell));
    rect.setAttribute("rx","1");
    const tip=document.createElementNS(NS,"title");
    const classes=["matrix-cell"];
    if(list)classes.push("has-scenes");
    if(day===selectedDay)classes.push("selected");
    rect.setAttribute("class",classes.join(" "));
    if(list){
      rect.setAttribute("fill",matrixColourOf(list,metric,max,order,keyOf));
      tip.textContent=day+" - "+list.length+" observation"+(list.length===1?"":"s");
      // Days with observations are selectable by mouse and keyboard.
      rect.setAttribute("tabindex","0");
      rect.setAttribute("role","button");
      rect.setAttribute("aria-label",day+", "+list.length+" observation"+(list.length===1?"":"s"));
      rect.addEventListener("click",()=>selectTimelineDay(day));
      rect.addEventListener("keydown",(event)=>matrixCellKeydown(event,day));
    }else{
      // In-window days with no observations get a placeholder; padding days outside the
      // window are left with no fill so they read as background, not as dark blocks.
      rect.setAttribute("fill",inWindow?MATRIX_EMPTY:"transparent");
      tip.textContent=day+(inWindow?" - no observations":" - outside the loaded range");
    }
    rect.append(tip);
    matrixSvg.append(rect);
  }
  matrixSvg.setAttribute("aria-label","Observations per day across the loaded year");
  // Month legend under the grid: each label starts at the week column its month begins in.
  const monthRow=14;
  matrixSvg.setAttribute("viewBox",`0 0 ${width} ${height+monthRow}`);
  matrixSvg.setAttribute("height",String(height+monthRow));
  for(let month=windowStart.slice(0,7);month<=windowEnd.slice(0,7);month=shiftMonth(month,1)){
    const monthStart=Math.max(Date.parse(month+"-01T00:00:00Z"),first);
    const column=Math.floor(Math.round((monthStart-start)/dayMs)/7);
    const label=document.createElementNS(NS,"text");
    label.setAttribute("class","matrix-month");
    label.setAttribute("x",String(column*step+1));
    label.setAttribute("y",String(height+11));
    label.setAttribute("text-anchor","start");
    label.textContent=new Date(month+"-01T00:00:00Z")
      .toLocaleDateString(undefined,{month:"short",timeZone:"UTC"}).toUpperCase();
    matrixSvg.append(label);
  }
}
function setMatrixMetric(metric:MatrixMetric):void {
  matrixMetric=metric;
  for(const link of matrixLinks.querySelectorAll<HTMLButtonElement>(".matrix-link"))
    link.setAttribute("aria-pressed",String(link.dataset.metric===metric));
  for(const item of matrixMoreMenu.querySelectorAll<HTMLButtonElement>(".matrix-menu-item"))
    item.setAttribute("aria-checked",String(item.dataset.metric===metric));
  const extra=EXTRA_METRICS.find((entry)=>entry.metric===metric);
  matrixMoreToggle.setAttribute("aria-pressed",String(Boolean(extra)));
  matrixMoreLabel.textContent=extra?extra.label:"More";
  matrixMoreMenu.hidden=true;
  matrixMoreToggle.setAttribute("aria-expanded","false");
  renderMatrix();
}
for(const link of matrixLinks.querySelectorAll<HTMLButtonElement>(".matrix-link"))
  link.addEventListener("click",()=>setMatrixMetric((link.dataset.metric as MatrixMetric) ?? "total"));
for(const item of matrixMoreMenu.querySelectorAll<HTMLButtonElement>(".matrix-menu-item"))
  item.addEventListener("click",()=>setMatrixMetric((item.dataset.metric as MatrixMetric) ?? "total"));
matrixMoreToggle.addEventListener("click",(event)=>{
  event.stopPropagation();
  const opening=matrixMoreMenu.hidden;
  matrixMoreMenu.hidden=!opening;
  matrixMoreToggle.setAttribute("aria-expanded",String(opening));
});
document.addEventListener("click",()=>{
  matrixMoreMenu.hidden=true;
  matrixMoreToggle.setAttribute("aria-expanded","false");
});
// The grid is sized to the map pane, so a resize (or a pane-width change) must re-fit it.
let matrixRefitTimer:number|undefined;
window.addEventListener("resize",()=>{
  window.clearTimeout(matrixRefitTimer);
  matrixRefitTimer=window.setTimeout(()=>{ if(!matrixPanel.hidden)renderMatrix(); },120);
});
// Year stepper: shift the whole loaded window a year back or forward and re-search.
function shiftWindowYear(delta:number):void {
  const shift=(value:string):string=>{
    const date=new Date(value+"T00:00:00Z");
    if(!Number.isFinite(date.getTime()))return value;
    date.setUTCFullYear(date.getUTCFullYear()+delta);
    return date.toISOString().slice(0,10);
  };
  from.value=shift(from.value);
  to.value=shift(to.value);
  void runSearch();
}
matrixPrevYear.addEventListener("click",()=>shiftWindowYear(-1));
matrixNextYear.addEventListener("click",()=>shiftWindowYear(1));

interface HistoryScan {
  controller:AbortController;
  accumulator:AvailabilityAccumulator;
  iterator:AsyncGenerator<import("@powerpuff-kitty/satellites-images").SearchPage>;
  fetching:boolean;
  ended:boolean;
  signature:string;
}
const CHUNK_MONTHS=12;
let scanAccumulator:AvailabilityAccumulator|null=null;
let activeScan:HistoryScan|null=null;
let initialPermalinkDay:string|null=null;
let loadedScenes:Scene[]=[];
let currentSummary:AvailabilitySummary|null=null;
let selectedDay:string|null=null;
let initialPermalinkScene:string|null=null;
let pendingMissionFilter="";
let pendingCollectionFilter="";
let displayedLimit=40;
let searchErrored=false;

const MIN_SEARCH_DATE="1970-01-01";
function maxSearchDate():string {
  return new Date(Date.now()+365*86400000).toISOString().slice(0,10);
}
/** Keeps the range inside data that can exist, so the grid stays renderable. */
function clampSearchRange():boolean {
  const low=MIN_SEARCH_DATE, high=maxSearchDate();
  let changed=false;
  if(from.value<low){ from.value=low; changed=true; }
  if(to.value<low){ to.value=low; changed=true; }
  if(from.value>high){ from.value=high; changed=true; }
  if(to.value>high){ to.value=high; changed=true; }
  if(from.value>to.value){ const swap=from.value; from.value=to.value; to.value=swap; changed=true; }
  return changed;
}
function validDate(input:string):boolean {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(input))return false;
  const time=Date.parse(input+"T00:00:00Z");
  return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===input;
}
function restoreSearchLink():void {
  const params=new URLSearchParams(window.location.search);
  const latitude=Number(params.get("lat"));
  const longitude=Number(params.get("lon"));
  if(params.has("lat")&&params.has("lon")&&Number.isFinite(latitude)&&Number.isFinite(longitude)
    &&latitude>=-90&&latitude<=90&&longitude>=-180&&longitude<=180) {
    lat.value=String(latitude); lon.value=String(longitude);
    mapLabel.hidden=true;
  }
  const wantedRadius=params.get("radius");
  if(wantedRadius&&[...radius.options].some(o=>o.value===wantedRadius))radius.value=wantedRadius;
  if(validDate(params.get("from")??"")&&validDate(params.get("to")??"")) {
    from.value=params.get("from")!;
    to.value=params.get("to")!;
  } else {
    const year=new Date().toISOString().slice(0,4);
    from.value=year+"-01-01";
    to.value=year+"-12-31";
  }
  clampSearchRange();
  for(const input of [from,to]) input.max=maxSearchDate();
  const restoredDay=params.get("day");
  if(restoredDay&&validDate(restoredDay)&&restoredDay>=from.value&&restoredDay<=to.value) {
    initialPermalinkDay=restoredDay;
    selectedDay=restoredDay;
  }
  const cloudMinParam=params.get("cloudmin");
  if(cloudMinParam!==null)cloudMin.value=cloudMinParam;
  const cloudMaxParam=params.get("cloudmax");
  if(cloudMaxParam!==null)cloudMax.value=cloudMaxParam;
  const hourMinParam=params.get("hmin");
  if(hourMinParam!==null)hourMin.value=hourMinParam;
  const hourMaxParam=params.get("hmax");
  if(hourMaxParam!==null)hourMax.value=hourMaxParam;
  const maxGsd=params.get("maxgsd");
  if(maxGsd!==null)resolutionFilter.value=maxGsd;
  hasPreview.checked=params.get("preview")==="1";
  const unknownParam=params.get("unknown");
  if(unknownParam!==null)includeUnknown.checked=unknownParam!=="0";
  const metricParam=params.get("metric") as MatrixMetric|null;
  if(metricParam)setMatrixMetric(metricParam);
  const center:[number,number]=[Number(lon.value),Number(lat.value)];
  marker.setLngLat(center);
  const restoredZoom=Number(params.get("zoom"));
  if(Number.isFinite(restoredZoom)&&restoredZoom>0&&restoredZoom<=20)
    map.jumpTo({center,zoom:restoredZoom});
  else
    map.jumpTo({center});
  // Filters with fixed options restore directly; mission/collection options only exist once
  // data has loaded, so those are held until then.
  const wantedMission=params.get("mission");
  if(wantedMission)pendingMissionFilter=wantedMission;
  const wantedCollection=params.get("collection");
  if(wantedCollection)pendingCollectionFilter=wantedCollection;
  const wantedCatalogue=params.get("catalogue");
  if(wantedCatalogue)providerFilter.value=wantedCatalogue;
  const wantedOrbit=params.get("orbit");
  if(wantedOrbit)orbitFilter.value=wantedOrbit;
  tilesOnly.checked=params.get("tiles")==="1";
  const sensor=params.get("sensor");
  if(sensor==="optical"||sensor==="radar"||sensor==="all")sensorFilter=sensor;
  const wantedAoi=params.get("aoi");
  if(wantedAoi){
    const ring=wantedAoi.split(" ").map((pair)=>pair.split(",").map(Number))
      .filter((pair)=>pair.length===2&&pair.every(Number.isFinite))
      .map((pair)=>[pair[0],pair[1]] as [number,number]);
    if(ring.length>=3){ aoiRing=ring; setAreaMode(false); }
  }
  const wantedExtras=params.get("src");
  if(wantedExtras)
    for(const id of wantedExtras.split(","))
      if(EXTRA_SOURCES.some((source)=>source.id===id))enabledExtraSources.add(id);
  renderSources();
  const wantedScene=params.get("scene");
  if(wantedScene)initialPermalinkScene=wantedScene;
  const wantedTab=params.get("tab");
  // The form already carries a location and a range, so search on start instead of waiting
  // for a click; a permalink merely overrides those inputs.
  queueMicrotask(async ()=>{
    await runSearch();
    if(wantedTab==="upcoming")setTab("upcoming");
    if(initialPermalinkScene){
      const scene=loadedScenes.find((candidate)=>candidate.id===initialPermalinkScene);
      initialPermalinkScene=null;
      if(scene)openScenePreview(scene);
    }
  });
}
const MANAGED_PARAMS=["lat","lon","radius","from","to","day","zoom","tab","metric","sensor",
  "mission","collection","catalogue","orbit","tiles","cloudmin","cloudmax","hmin","hmax","maxgsd",
  "preview","unknown","src","aoi","scene"];
function storeSearchLink():void {
  const url=new URL(window.location.href);
  for(const name of MANAGED_PARAMS)url.searchParams.delete(name);
  url.searchParams.set("lat",lat.value);
  url.searchParams.set("lon",lon.value);
  url.searchParams.set("radius",radius.value);
  url.searchParams.set("from",from.value);
  url.searchParams.set("to",to.value);
  if(selectedDay)url.searchParams.set("day",selectedDay);
  if(!mapPreview.hidden){
    const shown=previewScenes[previewIndex];
    if(shown)url.searchParams.set("scene",shown.id);
  }
  url.searchParams.set("tab",activeTab);
  url.searchParams.set("metric",matrixMetric);
  url.searchParams.set("sensor",sensorFilter);
  if(missionFilter.value)url.searchParams.set("mission",missionFilter.value);
  if(collectionFilter.value)url.searchParams.set("collection",collectionFilter.value);
  if(providerFilter.value)url.searchParams.set("catalogue",providerFilter.value);
  if(orbitFilter.value)url.searchParams.set("orbit",orbitFilter.value);
  if(tilesOnly.checked)url.searchParams.set("tiles","1");
  if(cloudMin.value!=="")url.searchParams.set("cloudmin",cloudMin.value);
  if(cloudMax.value!=="")url.searchParams.set("cloudmax",cloudMax.value);
  if(hourMin.value!=="0")url.searchParams.set("hmin",hourMin.value);
  if(hourMax.value!=="23")url.searchParams.set("hmax",hourMax.value);
  if(resolutionFilter.value)url.searchParams.set("maxgsd",resolutionFilter.value);
  url.searchParams.set("preview",hasPreview.checked?"1":"0");
  url.searchParams.set("unknown",includeUnknown.checked?"1":"0");
  if(enabledExtraSources.size)url.searchParams.set("src",[...enabledExtraSources].sort().join(","));
  if(aoiRing)url.searchParams.set("aoi",aoiRing.map(([lng,lat])=>lng.toFixed(5)+","+lat.toFixed(5)).join(" "));
  url.searchParams.set("zoom",map.getZoom().toFixed(2));
  window.history.replaceState(null,"",url);
}
function highlightScene(scene:Scene|undefined):void {
  // Exposed for tests and debugging: which scene's footprint is currently drawn.
  mapContainer.dataset.footprint=scene?scene.id:"";
  const featureCollection:FeatureCollection = {
    type:"FeatureCollection",
    features:scene && (scene.geometry?.type==="Polygon" || scene.geometry?.type==="MultiPolygon")
      ? [{type:"Feature",properties:{id:scene.id,acquired:scene.acquiredAt},
          geometry:scene.geometry as unknown as Geometry}]
      : [],
  };
  const apply=()=>{
    const source=map.getSource("observed-footprint") as maplibregl.GeoJSONSource|undefined;
    if(source){source.setData(featureCollection);return;}
    map.addSource("observed-footprint",{type:"geojson",data:featureCollection});
    map.addLayer({id:"observed-footprint-line",type:"line",source:"observed-footprint",
      paint:{"line-color":"#8dd7c1","line-width":2.5}});
  };
  if(map.isStyleLoaded())apply();else map.once("load",apply);
}
// The catalogues carry the same scenes under different ids and disagree slightly on the
// timestamp (seconds apart for Landsat, ~25 minutes apart for the same Sentinel-2 tile) and
// on the footprint (a 0.01 deg rounding difference). Merge on collection + platform + UTC day
// + a 0.5 deg-snapped footprint, which collapses those copies while keeping genuinely
// different tiles of one overpass (their footprints differ by ~1 deg) apart.
function sceneKey(scene:Scene):string {
  const snap=(value:number)=>String(Math.round(value*2)/2);
  const box=Array.isArray(scene.bbox)&&scene.bbox.length===4
    ?scene.bbox.map(snap).join(",")
    :"";
  return [scene.collection,(scene.mission??"").toLowerCase(),scene.acquiredAt.slice(0,10),box].join("|");
}
function dedupeScenes(scenes:Scene[]):Scene[] {
  const seen=new Set<string>();
  return scenes.filter((scene)=>{
    const key=sceneKey(scene);
    if(seen.has(key))return false;
    seen.add(key);
    return true;
  });
}
// Radar (SAR) scenes come from Sentinel-1/PALSAR/NISAR-style collections; the rest is optical.
const RADAR_COLLECTION=/(sentinel-1|palsar|nisar|\bgrd\b|\brtc\b)/i;
function isRadarScene(scene:Scene):boolean {
  return RADAR_COLLECTION.test(scene.collection);
}
let sensorFilter:"all"|"optical"|"radar"="all";
// A bbox query also matches items whose bounding box overlaps the radius while their real
// (often rotated) footprint does not, so only scenes covering the searched point are shown.
function pointInRing(x:number,y:number,ring:number[][]):boolean {
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const [xi,yi]=ring[i], [xj,yj]=ring[j];
    if((yi>y)!==(yj>y)&&x<((xj-xi)*(y-yi))/(yj-yi)+xi)inside=!inside;
  }
  return inside;
}
function sceneCoversPoint(scene:Scene, lng:number, latitude:number):boolean {
  const geometry=scene.geometry as {type?:string;coordinates?:unknown}|null;
  if(geometry?.type==="Polygon"){
    const rings=geometry.coordinates as number[][][];
    return Boolean(rings.length)&&pointInRing(lng,latitude,rings[0]);
  }
  if(geometry?.type==="MultiPolygon"){
    const polygons=geometry.coordinates as number[][][][];
    return polygons.some((rings)=>Boolean(rings.length)&&pointInRing(lng,latitude,rings[0]));
  }
  const box=scene.bbox;
  return Boolean(box&&box.length===4&&box[0]<=lng&&lng<=box[2]&&box[1]<=latitude&&latitude<=box[3]);
}
function passesFilters(scene:Scene):boolean {
  if(sensorFilter==="radar"&&!isRadarScene(scene))return false;
  if(sensorFilter==="optical"&&isRadarScene(scene))return false;
  // Point searches require the scene to cover the chosen location. A drawn area is already
  // restricted to intersecting footprints by the query, and the area's centroid need not sit
  // inside every one of them.
  if(!aoiRing){
    const pointLng=Number(lon.value), pointLat=Number(lat.value);
    if(Number.isFinite(pointLng)&&Number.isFinite(pointLat)&&!sceneCoversPoint(scene,pointLng,pointLat))return false;
  }
  if (missionFilter.value && (scene.mission || "unknown") !== missionFilter.value) return false;
  if (collectionFilter.value && scene.collection !== collectionFilter.value) return false;
  if (providerFilter.value && scene.providerId !== providerFilter.value) return false;
  if (orbitFilter.value) {
    const state=rawProperties(scene)["sat:orbit_state"];
    const orbit=typeof state==="string"?state.toLowerCase():"unknown";
    if(orbit !== orbitFilter.value) return false;
  }
  if (tilesOnly.checked && !tileAssetFor(scene) && !PLANETARY_COMPUTER_RENDER[scene.collection]) return false;
  if (!includeUnknown.checked && scene.cloudCoverPercent === null) return false;
  if (cloudMin.value !== "" && scene.cloudCoverPercent !== null && scene.cloudCoverPercent < Number(cloudMin.value)) return false;
  if (cloudMax.value !== "" && scene.cloudCoverPercent !== null && scene.cloudCoverPercent > Number(cloudMax.value)) return false;
  const hour = new Date(scene.acquiredAt).getUTCHours();
  if (hour < Number(hourMin.value) || hour > Number(hourMax.value)) return false;
  if (resolutionFilter.value && (scene.gsdMeters === null || scene.gsdMeters > Number(resolutionFilter.value))) return false;
  if (hasPreview.checked && !scene.previewUrl) return false;
  return true;
}
function hasActiveFilters():boolean {
  return Boolean(sensorFilter!=="all" || tilesOnly.checked || providerFilter.value || orbitFilter.value ||
    missionFilter.value || collectionFilter.value || cloudMin.value || cloudMax.value ||
    resolutionFilter.value || hasPreview.checked || !includeUnknown.checked ||
    Number(hourMin.value) > 0 || Number(hourMax.value) < 23);
}
function updateFilterChoices():void {
  const wasMission=missionFilter.value||pendingMissionFilter;
  const missions=[...new Set(loadedScenes.map(scene=>scene.mission || "unknown"))].sort();
  if(wasMission&&!missions.includes(wasMission))missions.push(wasMission);
  pendingMissionFilter="";
  const missionFragment=document.createDocumentFragment();
  const allMission=document.createElement("option");
  allMission.value=""; allMission.textContent="All satellites"; missionFragment.append(allMission);
  for(const mission of missions) {
    const option=document.createElement("option"); option.value=mission; option.textContent=mission; missionFragment.append(option);
  }
  missionFilter.replaceChildren(missionFragment);
  missionFilter.value=missions.includes(wasMission)?wasMission:"";
  const wasCollection=collectionFilter.value||pendingCollectionFilter;
  const collections=[...new Set(loadedScenes.map(scene=>scene.collection).filter(Boolean))].sort();
  if(wasCollection&&!collections.includes(wasCollection))collections.push(wasCollection);
  pendingCollectionFilter="";
  const collectionFragment=document.createDocumentFragment();
  const allCollection=document.createElement("option");
  allCollection.value=""; allCollection.textContent="All collections"; collectionFragment.append(allCollection);
  for(const collection of collections) {
    const option=document.createElement("option"); option.value=collection; option.textContent=collection; collectionFragment.append(option);
  }
  collectionFilter.replaceChildren(collectionFragment);
  collectionFilter.value=collections.includes(wasCollection)?wasCollection:"";
  const wasProvider=providerFilter.value;
  const providers=[...new Set(loadedScenes.map(scene=>scene.providerId).filter(Boolean))].sort();
  const providerFragment=document.createDocumentFragment();
  const allProviders=document.createElement("option");
  allProviders.value=""; allProviders.textContent="All catalogues"; providerFragment.append(allProviders);
  for(const provider of providers) {
    const option=document.createElement("option"); option.value=provider; option.textContent=provider;
    providerFragment.append(option);
  }
  providerFilter.replaceChildren(providerFragment);
  providerFilter.value=providers.includes(wasProvider)?wasProvider:"";
}
function summaryFromScenes(scenes:Scene[]):AvailabilitySummary {
  const days=new Map<string,{count:number;missions:Record<string,number>;collections:Record<string,number>}>();
  const months=new Map<string,{count:number;days:Set<string>;missions:Record<string,number>}>();
  for(const scene of scenes){
    const date=scene.acquiredAt.slice(0,10); const month=date.slice(0,7);
    const mission=scene.mission||"unknown"; const collection=scene.collection||"unknown";
    const day=days.get(date)??{count:0,missions:{},collections:{}};
    day.count++; day.missions[mission]=(day.missions[mission]??0)+1; day.collections[collection]=(day.collections[collection]??0)+1; days.set(date,day);
    const monthly=months.get(month)??{count:0,days:new Set<string>(),missions:{}};
    monthly.count++; monthly.days.add(date); monthly.missions[mission]=(monthly.missions[mission]??0)+1; months.set(month,monthly);
  }
  return {
    days:[...days.entries()].sort(([a],[b])=>a.localeCompare(b))
      .map(([date,d])=>({date,count:d.count,missions:d.missions,collections:d.collections})),
    months:[...months.entries()].sort(([a],[b])=>a.localeCompare(b))
      .map(([month,m])=>({month,count:m.count,daysWithObservations:m.days.size,missions:m.missions})),
    providers:[], pagesScanned:currentSummary?.pagesScanned??0, rawItems:0,
    uniqueItems:scenes.length, complete:currentSummary?.complete??true,
    truncatedProviders:currentSummary?.truncatedProviders??[], erroredProviders:currentSummary?.erroredProviders??[],
  };
}
/** The scenes the app is currently showing: filters + optional selected day. */
function visibleScenes():Scene[] {
  return loadedScenes.filter(scene=>
    passesFilters(scene) && (!selectedDay || scene.acquiredAt.slice(0,10)===selectedDay));
}
function renderLoadedScenes():void {
  const visible=visibleScenes();
  const selected=visible.slice(0,displayedLimit);
  const fragment=document.createDocumentFragment();
  for(const scene of selected)fragment.append(makeScene(scene));
  results.replaceChildren(fragment);
  const counted=loadedScenes.filter(passesFilters).length;
  const filtering=hasActiveFilters();
  counter.textContent=String(visible.length)+(filtering?" / "+counted:"");
  showMoreButton.hidden=visible.length<=displayedLimit;
  matrixItems=loadedScenes.filter(passesFilters);
  renderMatrix();
}
/** Coverage rollup from the availability summary (days/months/provider split). */
function renderCoverage():void {
  const summary=currentSummary;
  if(!summary){ coverage.textContent=""; return; }
  const shown=loadedScenes.filter(passesFilters).length;
  const days=summary.days.length, months=summary.months.length;
  const catalogues=summary.providers.map((provider)=>
    provider.id+(provider.uniqueItems?" "+provider.uniqueItems:"")+(provider.hasMore?"+":""));
  const failed=summary.erroredProviders;
  coverage.textContent=[
    shown+" observation"+(shown===1?"":"s")+" shown",
    days+" day"+(days===1?"":"s")+" with data",
    months+" month"+(months===1?"":"s"),
    matrixTruncated?"grid shows the last 2 years":
    catalogues.join(" \u00b7 "),
    failed.length?failed.join(", ")+" failed":"",
  ].filter((part)=>part.length>0).join(" \u00b7 ");
}
function redrawAvailability():void {
  const full=currentSummary;
  if(!full) return;
  allDaysButton.hidden=selectedDay===null;
  const statusParts:string[]=[];
  const pointLng=Number(lon.value), pointLat=Number(lat.value);
  if(!aoiRing&&Number.isFinite(pointLng)&&Number.isFinite(pointLat)){
    const hidden=loadedScenes.filter((scene)=>!sceneCoversPoint(scene,pointLng,pointLat)).length;
    if(hidden)statusParts.push(hidden+" scene"+(hidden===1?"":"s")+
      " hidden: the footprint does not cover this location.");
  }
  if(!full.complete)statusParts.push("Additional pages may exist. Counts are partial.");
  if(searchErrored)statusParts.push("Provider search failed; shown results are incomplete.");
  calendarStatus.textContent=statusParts.join(" ");
  renderCoverage();
}
function monthChunks(fromMonth:string,toMonth:string,size:number):{from:string;to:string}[] {
  const chunks:{from:string;to:string}[]=[];
  let month=fromMonth, guard=0;
  while(month<=toMonth&&guard++<600){
    const end=shiftMonth(month,size-1);
    const last=end>toMonth?toMonth:end;
    chunks.push({from:month+"-01",to:monthDates(last).to});
    month=shiftMonth(month,size);
  }
  return chunks;
}
function loadQuarter(month:string,direction:number):void {
  const chunk=direction<0
    ?{from:shiftMonth(month,-(CHUNK_MONTHS-1))+"-01",to:monthDates(month).to}
    :{from:month+"-01",to:monthDates(shiftMonth(month,CHUNK_MONTHS-1)).to};
  void runSearch({append:true,chunks:[chunk],extend:{from:chunk.from.slice(0,7),to:chunk.to.slice(0,7)}});
}

// Filter select options (populated once) + reset.
function fillSelect(select:HTMLSelectElement, values:[string,string][]):void{
  const fragment=document.createDocumentFragment();
  for(const [value,label] of values){ const option=document.createElement("option"); option.value=value; option.textContent=label; fragment.append(option); }
  select.replaceChildren(fragment);
}
fillSelect(cloudMin,[["","Any"],["0","0%"],["10","10%"],["20","20%"],["30","30%"],["40","40%"],["60","60%"],["80","80%"],["100","100%"]]);
fillSelect(cloudMax,[["","Any"],["10","10%"],["20","20%"],["30","30%"],["40","40%"],["60","60%"],["80","80%"],["100","100%"]]);
const hourOptions:[string,string][]=[]; for(let h=0;h<24;h++) hourOptions.push([String(h),String(h).padStart(2,"0")]);
fillSelect(hourMin,hourOptions); fillSelect(hourMax,[...hourOptions]);
hourMin.value="0"; hourMax.value="23";
function applySensorFilter(choice:string):void {
  sensorFilter=choice==="radar"||choice==="optical"?choice:"all";
  for(const button of matrixQuick.querySelectorAll<HTMLButtonElement>(".matrix-chip[data-sensor]"))
    button.setAttribute("aria-pressed",String(button.dataset.sensor===sensorFilter));
  displayedLimit=40;
  redrawAvailability();
  renderLoadedScenes();
}
for(const button of matrixQuick.querySelectorAll<HTMLButtonElement>(".matrix-chip[data-sensor]"))
  button.addEventListener("click",()=>applySensorFilter(button.dataset.sensor ?? "all"));
clearFilters.addEventListener("click",()=>{
  sensorFilter="all";
  for(const button of matrixQuick.querySelectorAll<HTMLButtonElement>(".matrix-chip[data-sensor]"))
    button.setAttribute("aria-pressed",String(button.dataset.sensor==="all"));
  missionFilter.value=""; collectionFilter.value=""; providerFilter.value=""; orbitFilter.value="";
  tilesOnly.checked=false; cloudMin.value=""; cloudMax.value="";
  hourMin.value="0"; hourMax.value="23"; resolutionFilter.value=""; hasPreview.checked=false; includeUnknown.checked=true;
  displayedLimit=40; redrawAvailability(); renderLoadedScenes();
});
allDaysButton.addEventListener("click",()=>{
  selectedDay=null;
  redrawAvailability();
  renderLoadedScenes();
  storeSearchLink();
});
showMoreButton.addEventListener("click",()=>{
  displayedLimit+=40;
  renderLoadedScenes();
});
missionFilter.addEventListener("change",()=>{
  displayedLimit=40;
  redrawAvailability();
  renderLoadedScenes();
});
for(const control of [missionFilter,collectionFilter,providerFilter,orbitFilter,tilesOnly,cloudMin,cloudMax,hourMin,hourMax,resolutionFilter,hasPreview,includeUnknown]) control.addEventListener("change",()=>{
  displayedLimit=40;
  redrawAvailability();
  renderLoadedScenes();
});

function currentSearchSignature():string {
  return JSON.stringify([
    lat.value,lon.value,radius.value,from.value,to.value,[...enabledExtraSources].sort().join(","),
  ]);
}
async function scanNextBatch(session:HistoryScan):Promise<void> {
  if(session.fetching||session.ended||session!==activeScan)return;
  if(session.signature!==currentSearchSignature()){
    status.textContent="Location, source or date filters changed. Search again before loading more pages.";
    return;
  }
  session.fetching=true;
  loadNextPagesButton.disabled=true;
  loadNextPagesButton.hidden=true;
  try {
    const batchSize=5;
    let examined=0;
    while(examined<batchSize && session===activeScan && !session.controller.signal.aborted) {
      const next=await session.iterator.next();
      if(session!==activeScan||session.controller.signal.aborted)return;
      if(next.done){session.ended=true;break;}
      const page=next.value;
      const added=session.accumulator.addPage(page);
      loadedScenes.push(...added);
      loadedScenes=dedupeScenes(loadedScenes);
      loadedScenes.sort((a,b)=>b.acquiredAt.localeCompare(a.acquiredAt)||a.id.localeCompare(b.id));
      updateFilterChoices();
      currentSummary=session.accumulator.summary();
      redrawAvailability();
      renderLoadedScenes();
      examined++;
      status.textContent="Scanned "+currentSummary.pagesScanned+" catalogue page(s); "+
        currentSummary.uniqueItems+" unique published observations loaded…";
    }
    if(session!==activeScan||session.controller.signal.aborted)return;
    const summary=session.accumulator.summary();
    currentSummary=summary;
    if(summary.pagesScanned>=50)session.ended=true;
    redrawAvailability();
    loadNextPagesButton.hidden=session.ended;
    if(summary.uniqueItems===0 && summary.complete) {
      status.textContent="No scenes returned by this catalogue for the selected time window.";
    }else if(summary.complete){
      status.textContent="";
    }else if(session.ended){
      status.textContent=summary.uniqueItems+" unique scenes loaded. "+
        "Search reached its 50-page safety limit; narrow the period for more coverage.";
    }else{
      status.textContent=summary.uniqueItems+" scenes loaded from "+
        summary.pagesScanned+" pages. Further pages are available.";
    }
  }catch(error){
    if(session!==activeScan||session.controller.signal.aborted)return;
    searchErrored=true;
    session.ended=true;
    currentSummary=session.accumulator.summary();
    redrawAvailability();
    status.textContent="Catalogue search failed: "+
      (error instanceof Error?error.message:String(error))+
      ". Previously loaded scenes may be incomplete.";
    loadNextPagesButton.hidden=true;
  }finally{
    session.fetching=false;
    if(session===activeScan){
      loadNextPagesButton.disabled=false;
    }
  }
}
loadNextPagesButton.addEventListener("click",()=>{
  if(activeScan)void scanNextBatch(activeScan);
});

// A search loads its whole window up front — every chunk and page, within the
// page safety cap — instead of stopping after a single five-page batch.
async function loadWholeWindow(session:HistoryScan):Promise<void> {
  await scanNextBatch(session);
  let previous=currentSummary?.pagesScanned ?? 0;
  for(let step=0; step<80 && activeScan===session && !session.ended; step++){
    await scanNextBatch(session);
    const pages=currentSummary?.pagesScanned ?? 0;
    if(pages===previous)return;
    previous=pages;
  }
}

form.addEventListener("submit",(event)=>{
  event.preventDefault();
  void runSearch();
});
async function runSearch(opts:{append?:boolean;chunks?:{from:string;to:string}[];extend?:{from:string;to:string}} = {}):Promise<void>{
  const append=opts.append===true;
  const chunks=opts.chunks??monthChunks(from.value.slice(0,7),to.value.slice(0,7),CHUNK_MONTHS);
  if(chunks.length===0)return;
  if(opts.extend){
    if(opts.extend.from<from.value.slice(0,7))from.value=opts.extend.from+"-01";
    if(opts.extend.to>to.value.slice(0,7))to.value=monthDates(opts.extend.to).to;
  }
  activeScan?.controller.abort();
  const controller=new AbortController();
  if(!append){
    hideMapLabel();
    scanAccumulator=new AvailabilityAccumulator();
    currentSummary=null;
    loadedScenes=[];
    searchErrored=false;
    selectedDay=initialPermalinkDay && initialPermalinkDay>=from.value &&
      initialPermalinkDay<=to.value ? initialPermalinkDay : null;
    initialPermalinkDay=null;
    displayedLimit=40;
    results.replaceChildren();
    missionFilter.value="";
    updateFilterChoices();
    matrixItems=[];
    renderMatrix();
    counter.textContent="—";
    loadNextPagesButton.hidden=true;
    status.textContent="Searching public satellite catalogues…";
    calendarStatus.textContent="Loading UTC acquisition dates…";
    currentPlanSearch++;
    plansResults.replaceChildren();
    displaySwaths([]);
    closeMapPreview();
  }
  const accumulator=scanAccumulator??(scanAccumulator=new AvailabilityAccumulator());
  // Both public catalogues are queried together; duplicates are merged on display.
  // Extra catalogues are opt-in from the Data sources panel.
  const providers:SearchProvider[]=[planetaryComputer(),earthSearch()];
  for(const source of EXTRA_SOURCES)
    if(enabledExtraSources.has(source.id))providers.push(source.create());
  const catalog=new SatelliteCatalog(providers);
  const closedAoi=aoiRing?[...aoiRing,aoiRing[0]]:null;
  const base=closedAoi
    ? {aoi:{type:"Polygon" as const,coordinates:[closedAoi]},maxPages:50,limit:75,signal:controller.signal}
    : {latitude:Number(lat.value),longitude:Number(lon.value),radiusMeters:Number(radius.value),
       maxPages:50,limit:75,signal:controller.signal};
  if(closedAoi){
    const [centerLng,centerLat]=aoiCentroid(aoiRing as [number,number][]);
    updateLocation(centerLat,centerLng,true);
    hideMapLabel();
  }else{
    updateLocation(base.latitude!,base.longitude!,true);
  }
  const iterator=(async function*(){
    for(const chunk of chunks){
      if(controller.signal.aborted)return;
      yield* catalog.search({...base, from:chunk.from, to:chunk.to});
    }
  })();
  const session:HistoryScan = {
    controller,accumulator,iterator,fetching:false,
    ended:false,signature:currentSearchSignature(),
  };
  activeScan=session;
  storeSearchLink();
  await loadWholeWindow(session);
}


// --- Data sources (registry) --------------------------------------------------
type ExtraSource={id:string;label:string;create:()=>SearchProvider};
const EXTRA_SOURCES:ExtraSource[]=[
  {id:"copernicus",label:"Copernicus Data Space",create:()=>copernicusDataSpace()},
  {id:"asf-vertex",label:"ASF Vertex (radar)",create:()=>asfSearch()},
  // Provider-scoped NASA CMR-STAC and a numeric JAXA G-Portal dataset (ALOS/PALSAR) — the
  // same ids the repo's live smoke test uses, so both are operator-verifiable.
  {id:"nasa-cmr",label:"NASA CMR-STAC (ASF)",create:()=>cmrStac("ASF",["sentinel-1-rtc"])},
  {id:"jaxa-gportal",label:"JAXA G-Portal (ALOS)",create:()=>jaxaGPortal({datasetId:"10002002"})},
  // OpenAerialMap is deliberately absent: its API returns
  // `Access-Control-Allow-Origin: https://map.openaerialmap.org`, so a browser build cannot call
  // it directly (the SDKs and the live smoke use it from Node/Python/Rust instead).
];
const enabledExtraSources=new Set<string>();
function renderSources():void {
  const fragment=document.createDocumentFragment();
  for(const source of listSources()){
    const item=document.createElement("div");
    item.className="source";
    const heading=document.createElement("div");
    heading.className="source-heading";
    const name=document.createElement("strong");
    name.textContent=source.name;
    const type=document.createElement("span");
    type.className="muted";
    type.textContent=source.type;
    heading.append(name,type);
    item.append(heading);
    item.append(line("Search",source.searchAccess));
    item.append(line("Imagery",source.imageryAccess));
    const implemented=[source.implemented.typescript?"TS":null,
      source.implemented.python?"Python":null,source.implemented.rust?"Rust":null]
      .filter(Boolean).join(" / ");
    item.append(line("SDK",implemented||"planned"));
    const extra=EXTRA_SOURCES.find((candidate)=>candidate.id===source.id);
    if(extra){
      const label=document.createElement("label");
      label.className="check-label";
      const input=document.createElement("input");
      input.type="checkbox";
      input.setAttribute("data-source",source.id);
      input.checked=enabledExtraSources.has(source.id);
      input.addEventListener("change",()=>{
        if(input.checked)enabledExtraSources.add(source.id);
        else enabledExtraSources.delete(source.id);
        void runSearch();
      });
      label.append(input,document.createTextNode(" query this catalogue"));
      item.append(label);
    }
    if(source.docs){
      const link=document.createElement("a");
      link.href=source.docs;
      link.target="_blank";
      link.rel="noopener noreferrer";
      link.textContent="Documentation";
      item.append(link);
    }
    fragment.append(item);
  }
  sourceList.replaceChildren(fragment);
}
renderSources();
function syncFilterUI():void {
  for(const button of matrixQuick.querySelectorAll<HTMLButtonElement>(".matrix-chip[data-sensor]"))
    button.setAttribute("aria-pressed",String(button.dataset.sensor===sensorFilter));
}
syncFilterUI();

function makePlanned(item: AcquisitionOpportunity): HTMLLIElement {
  const li = document.createElement("li");
  const heading = document.createElement("div");
  heading.className = "scene-heading";
  const name = document.createElement("strong");
  name.textContent = item.mission + " / planned";
  const time = document.createElement("time");
  time.dateTime = item.expectedAt;
  time.textContent = new Date(item.expectedAt).toLocaleString(undefined,{
    dateStyle:"medium",timeStyle:"medium",timeZone:"UTC"
  })+" UTC";
  heading.append(name,time);
  li.append(heading);
  if (item.id) li.append(line("Scene",item.id));
  if (item.mode) li.append(line("Acquisition mode",item.mode));
  if (typeof item.orbitRelative === "number")
    li.append(line("Relative orbit",String(item.orbitRelative)));
  if (item.status) li.append(line("Status", item.status));
  if (item.endAt) {
    const from=item.expectedAt.slice(11,16), until=item.endAt.slice(11,16);
    li.append(line("Datatake window", from + "\u2013" + until + " UTC"));
  }
  li.append(line("Image availability","Not yet acquired"));
  try {
    const source = new URL(item.sourceUrl);
    if (source.protocol === "https:") {
      const link = document.createElement("a");
      link.href = source.toString();
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Official ESA plan";
      link.append(icon("fa-arrow-up-right-from-square"));
      li.append(link);
    }
  } catch { /* invalid source URL: omit link */ }
  return li;
}
function displaySwaths(items:AcquisitionOpportunity[]):void {
  const features = items.flatMap((item) => {
    if (!item.footprint) return [];
    return [{type:"Feature" as const, properties:{mission:item.mission,time:item.expectedAt},
      geometry:item.footprint as unknown as Geometry}];
  });
  const data:FeatureCollection = {type:"FeatureCollection",features};
  const render=() => {
    const existing = map.getSource("planned-swaths") as maplibregl.GeoJSONSource | undefined;
    if (existing) existing.setData(data);
    else {
      map.addSource("planned-swaths",{type:"geojson",data});
      map.addLayer({id:"planned-swaths-outline",type:"line",source:"planned-swaths",
        paint:{"line-color":"#e2ae54","line-width":2,"line-opacity":0.85,
          "line-dasharray":[3,2]}});
    }
  };
  if (map.isStyleLoaded()) render();
  else map.once("load",render);
}

let currentPlanSearch = 0;
type PlannedScene = Scene & { mode?:string|null; orbitRelative?:number|null; endAt?:string|null; status?:string };
function plannedAsScenes(items:AcquisitionOpportunity[]):PlannedScene[] {
  return items.map((item) => ({
    providerId:item.providerId, id:item.id ?? (item.mission + item.expectedAt), collection:"esa-sentinel-plans",
    acquiredAt:item.expectedAt, mission:item.mission, geometry:null, bbox:null, cloudCoverPercent:null,
    gsdMeters:null, coveragePercent:null, previewUrl:null, access:"unknown", assets:[], sourceUrl:item.sourceUrl, raw:{},
    mode:item.mode ?? null, orbitRelative:item.orbitRelative ?? null, endAt:item.endAt ?? null, status:item.status,
  }));
}
/** Upcoming uses the same horizon as the loaded range: now until its end (max a year). */
function upcomingHorizonDays():number {
  const end=Date.parse(to.value+"T00:00:00Z");
  if(!Number.isFinite(end))return 14;
  return Math.max(1,Math.min(366,Math.round((end-Date.now())/86400000)));
}
/** How stale the ESA plan body is: a plan file is a rolling window, not a live feed. */
function refreshAgeLabel(fetchedAt:string|null):string {
  if(!fetchedAt)return "no plan file was read";
  const minutes=Math.max(0,Math.round((Date.now()-Date.parse(fetchedAt))/60000));
  return minutes<1?"plan fetched just now":"plan fetched "+minutes+" min ago";
}
/** The coverage window of the plan documents that were read (file names, not publication). */
function planWindowLabel(plans:{startsAt:string;endsAt:string;fromCache?:boolean}[]):string {
  const starts=plans.map((plan)=>plan.startsAt).filter(Boolean).sort();
  const ends=plans.map((plan)=>plan.endsAt).filter(Boolean).sort();
  if(!starts.length||!ends.length)return "";
  const format=(value:string)=>new Date(value).toLocaleDateString(undefined,{dateStyle:"medium",timeZone:"UTC"});
  // Cache health: every plan served from the in-memory cache means the ETag matched.
  const cached=plans.every((plan)=>plan.fromCache);
  return "plan window "+format(starts[0])+" – "+format(ends[ends.length-1])+
    (cached?" (revalidated, served from cache)":"");
}
async function runUpcoming():Promise<void>{
  const token=++currentPlanSearch;
  plansResults.replaceChildren();
  upcomingStatus.textContent="Checking the latest ESA acquisition plans…";
  try {
    const diagnostics=await plannedProvider.upcomingWithDiagnostics({
      latitude:Number(lat.value),longitude:Number(lon.value),
      radiusMeters:Number(radius.value),days:upcomingHorizonDays()});
    if(token!==currentPlanSearch)return;
    const planned=diagnostics.opportunities;
    const mission=upcomingMission.value;
    const filtered=mission?planned.filter(p=>p.mission.startsWith(mission)):planned;
    displaySwaths(filtered);
    matrixItems=plannedAsScenes(filtered);
    renderMatrix();
    const list=document.createDocumentFragment();
    for(const item of filtered) list.append(makePlanned(item));
    if(!filtered.length){
      const empty=document.createElement("li");
      empty.className="empty";
      empty.textContent="No planned datatakes for this area in the next "+
        upcomingHorizonDays()+" days. Try a larger radius." +
        (diagnostics.status==="no-current-plan"?" No current ESA plan was published for that window.":"");
      list.append(empty);
    }
    plansResults.append(list);
    counter.textContent=String(filtered.length);
    // Coverage diagnostics: why there is nothing, which plan window was read, how fresh it is.
    const parts:string[]=[];
    if(filtered.length) {
      parts.push(filtered.length+" officially planned datatake(s) intersect this area within the next "+
        upcomingHorizonDays()+" days. No image is guaranteed.");
    }else if(diagnostics.status==="no-current-plan") {
      parts.push("No current ESA plan covers the next "+upcomingHorizonDays()+" days.");
    }else {
      parts.push("ESA plans were read for this window but none intersect this area.");
    }
    const window=planWindowLabel(diagnostics.plans);
    if(window)parts.push(window);
    parts.push(refreshAgeLabel(diagnostics.fetchedAt));
    upcomingStatus.textContent=parts.join(" · ");
  } catch(error) {
    if(token===currentPlanSearch){
      const failed=document.createElement("li");
      failed.className="empty";
      failed.textContent="Could not load the ESA acquisition plan for this location.";
      plansResults.replaceChildren(failed);
      matrixItems=[];
      renderMatrix();   // never leave the previous tab's data on the grid
      const timedOut=error instanceof Error && /abort/i.test(error.message);
      upcomingStatus.textContent=
        (timedOut?"ESA plan lookup timed out after "+(ESA_FETCH_TIMEOUT_MS/1000)+" s. "
          :"ESA plan lookup failed. "+(error instanceof Error?error.message:String(error)))+
        (esaProxy?"":" Browser CORS may require the optional ESA proxy.");
    }
  }
}
function setTab(tab:"historical"|"upcoming"):void{
  activeTab=tab;
  tabHistorical.setAttribute("aria-selected",String(tab==="historical"));
  tabUpcoming.setAttribute("aria-selected",String(tab==="upcoming"));
  panelHistorical.hidden = tab!=="historical";
  panelUpcoming.hidden = tab!=="upcoming";
  results.hidden = tab!=="historical";
  plansResults.hidden = tab!=="upcoming";
  if(tab!=="historical") showMoreButton.hidden=true;
  obsTitle.textContent = tab==="upcoming" ? "Upcoming planned acquisitions" : "Published observations";
  // The window (and therefore the grid's size) is the same on both tabs; only the data
  // behind it changes. The metric links and quick filters describe published scenes, so
  // they are hidden on the upcoming tab.
  matrixHead.hidden = tab==="upcoming";
  matrixItems=tab==="upcoming"?[]:loadedScenes.filter(passesFilters);
  renderMatrix();
  if(tab==="upcoming")void runUpcoming();
}
tabHistorical.addEventListener("click",()=>setTab("historical"));
tabUpcoming.addEventListener("click",()=>setTab("upcoming"));
let upcomingTimer=0;
function scheduleUpcoming():void{ window.clearTimeout(upcomingTimer); upcomingTimer=window.setTimeout(()=>void runUpcoming(),350); }
for(const el of [upcomingMission]) el.addEventListener("change",scheduleUpcoming);

// Bootstrap last: MapLibre fires moveend during map construction and restoreSearchLink
// reads declarations that appear later in the module, so both run after everything exists.
map.on("moveend",()=>storeSearchLink());
restoreSearchLink();
