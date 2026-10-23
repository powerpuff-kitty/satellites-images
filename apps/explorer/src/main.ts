// maplibre-gl 6 dropped the default export: the ESM build is named-exports only, so a
// namespace import is the documented form (the types still advertise a default, which is
// why this only fails at bundle time).
import * as maplibregl from "maplibre-gl";
// maplibre-gl 6 also derives its worker URL at runtime, and bundlers do not follow that
// reference: the built app requested a path that did not exist, so vite served the SPA HTML
// and the worker never started (no tiles, no sources). Import the worker as a build asset.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { FeatureCollection, Geometry } from "geojson";
import { enhanceDateTime } from "@powerpuff-kitty/tcsn-design-system";
import "./style.css";
import "@powerpuff-kitty/tcsn-design-system/styles.css";
import "./shared-ui.css";
import { initializeSharedUi, sharedIcon, sharedDescriptionList, sharedEmptyState, setTaskBusy, setTaskTone } from "./shared-ui.js";
import { SatelliteCatalog, earthSearch, planetaryComputer, copernicusDataSpace, asfSearch,
  cmrStac, jaxaGPortal, inpeCbers, esaSentinelPlans, listSources, AvailabilityAccumulator,
  type AvailabilitySummary,
  type Scene, type AcquisitionOpportunity, type SearchProvider } from "@powerpuff-kitty/satellites-images";
import { shiftMonth, monthDates } from "./calendar.js";
import { previewUrlFor, tileAssetFor, hasPublicPreview, canViewPreview,
  discoverPublicPreview, forgetPublicPreview, fetchOverlayImage, type PublicPreview } from "./public-previews.js";

const disposeSharedUi = initializeSharedUi();
if (import.meta.hot) import.meta.hot.dispose(disposeSharedUi);

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
// The visible control: picking a date loads that date's whole year and selects its day.
const dateField = element<HTMLInputElement>("date");
const dateControl = enhanceDateTime(dateField);
if (import.meta.hot) import.meta.hot.dispose(() => dateControl.destroy());
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
const allDaysButton = element<HTMLButtonElement>("show-all-days");
const showMoreButton = element<HTMLButtonElement>("show-more-scenes");
const loadNextPagesButton = element<HTMLButtonElement>("load-next-pages");
const missionFilter = element<HTMLSelectElement>("mission-filter");
const collectionFilter = element<HTMLSelectElement>("collection-filter");
const providerFilter = element<HTMLSelectElement>("provider-filter");
const orbitFilter = element<HTMLSelectElement>("orbit-filter");
const cloudMin = element<HTMLSelectElement>("cloud-min");
const cloudMax = element<HTMLSelectElement>("cloud-max");
const hourMin = element<HTMLSelectElement>("hour-min");
const hourMax = element<HTMLSelectElement>("hour-max");
const resolutionFilter = element<HTMLSelectElement>("resolution-filter");
const hasPreview = element<HTMLInputElement>("has-preview");
const satelliteTypeFilter = element<HTMLSelectElement>("satellite-type-filter");
const includeUnknown = element<HTMLInputElement>("include-unknown");
const clearFilters = element<HTMLButtonElement>("clear-filters");
const matrixPanel = element<HTMLElement>("map-matrix");
const matrixLinks = element<HTMLElement>("matrix-links");
const matrixSvg = element<SVGSVGElement>("matrix-svg");
const matrixQuick = element<HTMLElement>("matrix-quick");
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
  center: [116.1167, -8.5833],
  zoom: 8,
  // Source credits are available in the sidebar Map credits disclosure.
  attributionControl: false,
});
map.setStyle(mapStyle, {
  transformStyle: (_previous, next) => ({
    ...next,
    sources: Object.fromEntries(Object.entries(next.sources).map(([id, source]) => {
      // OpenFreeMap explicitly permits omitting its own name. Keep the required
      // OpenMapTiles/OpenStreetMap credits, and leave other providers untouched.
      if (source.type === "vector" && source.url?.startsWith("https://tiles.openfreemap.org/")) {
        return [id, { ...source, attribution:
          '<a href="https://www.openmaptiles.org/" target="_blank">© OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>' }];
      }
      return [id, source];
    })),
  }),
});
map.addControl(new maplibregl.NavigationControl(), "top-right");
const attribution = new maplibregl.AttributionControl({ compact: false });
element<HTMLElement>("map-credits").append(attribution.onAdd(map));
map.once("remove",()=>attribution.onRemove());
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
// One date drives the search window: its whole calendar year is loaded, and that day is selected.
/** True while the selection came from the date control and has not been checked against data. */
let autoSelectionPending=false;
function applyWindowFromDate():void {
  const picked = validDate(dateField.value) ? dateField.value : new Date().toISOString().slice(0,10);
  dateField.value = picked;
  dateControl.sync();
  const year = picked.slice(0,4);
  from.value = year + "-01-01";
  to.value = year + "-12-31";
  const high = maxSearchDate();
  if(to.value > high)to.value = high;
  selectedDay = picked <= to.value ? picked : null;
  autoSelectionPending = selectedDay !== null;
}
dateField.addEventListener("change", () => {
  applyWindowFromDate();
  scheduleSearch();
});

function externalLinkIcon(): SVGSVGElement {
  return sharedIcon("arrow-up-right-from-square");
}
function line(term: string, value: string): {term: string; value: string} {
  return { term, value };
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
  const metadataItems: {term: string; value: string}[] = [];
  metadataItems.push(line("Scene",scene.id));
  metadataItems.push(line("Collection",scene.collection));
  metadataItems.push(line("Catalogues",sceneCatalogues(scene).join(", ")));
  metadataItems.push(line("Satellite operator",isCommercialScene(scene)?"Commercial":"Public or unspecified"));
  metadataItems.push(line("Cloud coverage",scene.cloudCoverPercent===null?"Unknown":scene.cloudCoverPercent.toFixed(1)+"% (scene-wide)"));
  if (scene.gsdMeters !== null) metadataItems.push(line("Resolution", scene.gsdMeters + " m/pixel"));
  if (scene.coveragePercent !== null) metadataItems.push(line("Covers your area", scene.coveragePercent.toFixed(0) + "%"));
  const accessLabel = scene.access === "open" ? "Open (declared)"
    : scene.access === "authentication-required" ? "Account required"
    : scene.access === "payment-required" ? "Payment or entitlement required"
    : "Not verified";
  metadataItems.push(line("Full image access", accessLabel));
  item.append(sharedDescriptionList(metadataItems));
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
        const previewButton = document.createElement("button");
        previewButton.type = "button";
        previewButton.className = "tcsn-button preview-thumbnail";
        previewButton.dataset.appearance = "media";
        previewButton.setAttribute("aria-label", "Open preview of satellite scene " + scene.id);
        image.addEventListener("error", () => {
          previewButton.remove();
          item.dataset.previewFailed = "true";
          const note = item.querySelector(".preview-status");
          if (note) note.textContent = "Preview unavailable. Try the public preview lookup or open the catalogue.";
        });
        const open = () => openScenePreview(scene);
        previewButton.addEventListener("click", open);
        previewButton.append(image);
        item.append(previewButton);
      }
    } catch { /* Invalid preview: no link */ }
  }
  if (canViewPreview(scene)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button public-preview-button";
    button.textContent = "View public preview";
    button.addEventListener("click", () => openScenePreview(scene, item.dataset.previewFailed === "true"));
    item.append(button);
  }
  const previewStatus = document.createElement("p");
  previewStatus.className = "status preview-status";
  previewStatus.textContent = previewHref || tileAssetFor(scene) ? "Public preview · access checked when opened"
    : canViewPreview(scene) ? "Public preview lookup available" : "No public preview advertised";
  item.append(previewStatus);
  const sourceLinks=Array.isArray(scene.raw.links)?[...scene.raw.links]:[];
  for(const entry of sourceLinks){
    if(!entry || typeof entry !== "object")continue;
    const terms=entry as Record<string,unknown>;
    if(terms.rel!=="license" || typeof terms.href!=="string")continue;
    try {
      const url=new URL(terms.href);
      if(url.protocol!=="https:" || url.username || url.password)continue;
      const link=document.createElement("a");
      link.href=url.href; link.target="_blank"; link.rel="noopener noreferrer";
      link.className="preview-terms"; link.textContent="Source imagery terms";
      item.append(link); break;
    }catch { /* Missing or malformed terms are not a licence grant. */ }
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
        link.append(externalLinkIcon());
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
const previewStill = element<HTMLElement>("preview-still");
const previewStillImage = element<HTMLImageElement>("preview-still-image");
const previewStillStatus = element<HTMLElement>("preview-still-status");
let previewController: AbortController | null = null;
let previewReturnFocus: HTMLElement | null = null;
let activePublicPreview: {scene:Scene; preview:PublicPreview; token:number; retried:boolean} | null = null;
function canOverlay(scene: Scene): boolean { return canViewPreview(scene); }
function rawProperties(scene:Scene):Record<string,unknown> {
  const properties=scene.raw.properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? properties as Record<string,unknown> : {};
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
map.on("error", event=>{
  const sourceId=(event as maplibregl.ErrorEvent & {sourceId?:string}).sourceId;
  const active=activePublicPreview;
  if(sourceId!=="scene-preview" || !active || active.token!==previewToken)return;
  activePublicPreview=null;
  forgetPublicPreview(active.scene);
  removePreviewLayer();
  const image=active.preview.image ?? previewUrlFor(active.scene);
  if(image)showStillPreview(active.scene,{...active.preview,image,tiles:null},active.token,active.retried);
  else {
    delete mapContainer.dataset.previewSource;
    previewStill.hidden=false;
    previewStillStatus.textContent="Public map tiles are unavailable. Open the source catalogue or try again.";
  }
});
async function showMapPreview(index:number, skipDirect=false):Promise<void> {
  const scene=previewScenes[index];
  if(!scene){ closeMapPreview(); return; }
  previewController?.abort();
  const controller = new AbortController();
  previewController = controller;
  const timer = setTimeout(() => controller.abort(), 15000);
  const token=++previewToken;
  previewIndex=index;
  activePublicPreview=null;
  removePreviewLayer();
  previewStill.hidden=true;
  previewStillImage.removeAttribute("src");
  delete mapContainer.dataset.previewSource;
  mapPreview.hidden=false;
  previewCaption.textContent="Loading public preview…";
  markActiveCard(scene.id);
  try {
    const preview=await discoverPublicPreview(scene,controller.signal,skipDirect);
    if(token!==previewToken)return;
    if(!preview.tiles&&!preview.image)throw new Error("No public preview is available for this scene. Open the source catalogue or try again.");
    let objectUrl: string | null = null;
    if(!preview.tiles && preview.image && preview.coordinates) {
      try { objectUrl=await fetchOverlayImage(preview.image,controller.signal); }
      catch (error) { if(controller.signal.aborted)throw error; }
    }
    if(token!==previewToken){ if(objectUrl)URL.revokeObjectURL(objectUrl); return; }
    const apply=()=>{
      if(token!==previewToken){ if(objectUrl)URL.revokeObjectURL(objectUrl); return; }
      if(preview.tiles)map.addSource("scene-preview",{type:"raster",url:preview.tiles,tileSize:256});
      else if(objectUrl && preview.coordinates) {
        previewObjectUrl=objectUrl;
        map.addSource("scene-preview",{type:"image",url:objectUrl,coordinates:preview.coordinates});
      }
      if(preview.tiles || objectUrl){
        activePublicPreview={scene,preview,token,retried:skipDirect};
        mapContainer.dataset.previewSource=preview.tiles?"tiles":"image";
        map.addLayer({id:"scene-preview-layer",type:"raster",source:"scene-preview",paint:{"raster-opacity":0.96}});
      }else showStillPreview(scene,preview,token,skipDirect);
    };
    // A GeoJSON update can make isStyleLoaded false after the one-time load event.
    // idle fires once that update settles, so preview selection cannot get stranded.
    if(map.isStyleLoaded())apply();else map.once("idle",apply);
    highlightScene(scene);
    previewCaption.textContent=(scene.mission ?? scene.collection)+" · "+
      new Date(scene.acquiredAt).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short",timeZone:"UTC"})+
      " UTC · "+preview.origin;
    status.textContent="";
    storeSearchLink();
  }catch(error){
    if(token!==previewToken)return;
    const timedOut=controller.signal.aborted;
    closeMapPreview();
    status.textContent=timedOut ? "Public preview lookup timed out. Try again or open the source catalogue."
      : error instanceof Error ? error.message : "Public preview unavailable. Try again or open the source catalogue.";
  }finally { clearTimeout(timer); }
}
function showStillPreview(scene:Scene, preview:PublicPreview, token:number, retried:boolean):void {
  mapContainer.dataset.previewSource="unplaced-image";
  previewStill.hidden=false;
  previewStillStatus.textContent="Loading preview… Map alignment is unknown; the outline shows the scene footprint.";
  previewStillImage.alt="Public preview of "+scene.id+" (shown separately from the map)";
  previewStillImage.onload=()=>{
    if(token!==previewToken)return;
    previewStillStatus.textContent=(preview.coordinates ? "The image overlay is unavailable. Preview shown separately from the map."
      : "Map alignment is unknown. The outline shows the scene footprint, not the image alignment.")+" Cloud cover is scene-wide.";
  };
  previewStillImage.onerror=()=>{
    if(token!==previewToken)return;
    forgetPublicPreview(scene);
    previewStillImage.removeAttribute("src");
    if(!retried && scene.providerId==="copernicus") { void showMapPreview(previewIndex,true); return; }
    previewStillStatus.textContent="Public preview unavailable. It may be missing, require an account, or have expired. Open the source catalogue or try again.";
  };
  previewStillImage.src=preview.image!;
}
function closeMapPreview():void {
  previewToken++;
  previewController?.abort();
  previewController=null;
  activePublicPreview=null;
  previewStillImage.onload=null;
  previewStillImage.onerror=null;
  previewStillImage.removeAttribute("src");
  previewStill.hidden=true;
  const wasOpen=!mapPreview.hidden;
  mapPreview.hidden=true;
  delete mapContainer.dataset.previewSource;
  removePreviewLayer();
  highlightScene(undefined);
  markActiveCard(null);
  if(wasOpen){ storeSearchLink(); if(previewReturnFocus?.isConnected)previewReturnFocus.focus({preventScroll:true}); }
}
function stepPreview(delta:number):void {
  if(!previewScenes.length)return;
  void showMapPreview((previewIndex+delta+previewScenes.length)%previewScenes.length);
}
function openScenePreview(scene:Scene, skipDirect=false):void {
  const withPreviews=visibleScenes().filter(canOverlay);
  const index=withPreviews.indexOf(scene);
  if(index<0)return;
  previewReturnFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;
  previewScenes=withPreviews;
  void showMapPreview(index,skipDirect);
  previewClose.focus({preventScroll:true});
}
previewPrev.addEventListener("click",()=>stepPreview(-1));
previewNext.addEventListener("click",()=>stepPreview(1));
previewClose.addEventListener("click",closeMapPreview);
element<HTMLButtonElement>("preview-retry").addEventListener("click",()=>{
  const scene=previewScenes[previewIndex];
  if(scene)forgetPublicPreview(scene);
  void showMapPreview(previewIndex);
});
document.addEventListener("keydown",(event)=>{ if(!event.defaultPrevented&&event.key==="Escape"&&!mapPreview.hidden)closeMapPreview(); });
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
// --- Year-at-a-glance day matrix (responsive, up to 14 px cells) --------------
type MatrixMetric = "total" | "cloud" | "mission" | "provider" | "resolution";
let matrixMetric:MatrixMetric = "total";
let matrixItems:Scene[] = [];
/** The bucket a scene falls into for a given metric. */
function matrixKeyOf(scene:Scene, metric:MatrixMetric):string {
  switch(metric){
    case "mission": return scene.mission || "unknown";
    case "provider": return scene.providerId;
    case "resolution": {
      const gsd=scene.gsdMeters;
      if(gsd===null)return "unknown";
      if(gsd<=1)return "\u22641 m";
      if(gsd<=10)return "\u226410 m";
      if(gsd<=30)return "\u226430 m";
      return ">30 m";
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
  // Every in-window day is focusable, so navigation steps by day rather than skipping empties.
  const fromIndex=matrixDays.indexOf(from);
  if(fromIndex<0)return;
  const target=matrixDays[fromIndex+delta];
  if(target)focusMatrixCell(target);
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
const MATRIX_MAX_CELL=14;    // larger day cells when the pane allows the whole year to fit
const MATRIX_EDGE_INSET=4;   // room for edge-cell selection strokes and forced-colour focus rings
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
  // Cells shrink from 14 px down to 6 px to fit the map pane, and only scroll below that.
  // Reserve the panel's 76 px gutter (which also holds the year stepper), 16 px shared
  // padding and the SVG's own inset: strokes can extend beyond a cell's fill bounds.
  const paneWidth=matrixPanel.parentElement?.clientWidth ?? 0;
  const cell=Math.max(MATRIX_MIN_CELL,Math.min(MATRIX_MAX_CELL,Math.floor(Math.max(140,paneWidth-92-MATRIX_EDGE_INSET*2)/weeks)-1));
  const step=cell+1;
  const width=weeks*step+MATRIX_EDGE_INSET*2, height=7*step+MATRIX_EDGE_INSET*2;
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
    rect.setAttribute("x",String(MATRIX_EDGE_INSET+Math.floor(d/7)*step));
    rect.setAttribute("y",String(MATRIX_EDGE_INSET+(d%7)*step));
    rect.setAttribute("width",String(cell));
    rect.setAttribute("height",String(cell));
    rect.setAttribute("rx","0");
    const tip=document.createElementNS(NS,"title");
    const classes=["matrix-cell"];
    if(!inWindow)classes.push("outside-window");
    if(list)classes.push("has-scenes");
    if(day===selectedDay)classes.push("selected");
    rect.setAttribute("class",classes.join(" "));
    const observationLabel=list
      ? list.length+" observation"+(list.length===1?"":"s")
      : "no observations";
    if(list){
      rect.setAttribute("fill",matrixColourOf(list,metric,max,order,keyOf));
    }else{
      rect.setAttribute("fill","transparent");
    }
    // Every day inside the loaded window is hoverable and selectable, including days with no
    // observations; padding days outside the window carry a tooltip but are not selectable.
    tip.textContent=day+" - "+(inWindow?observationLabel:"outside the loaded range");
    if(inWindow){
      rect.setAttribute("tabindex","0");
      rect.setAttribute("role","button");
      rect.setAttribute("aria-label",day+", "+observationLabel);
      rect.addEventListener("click",()=>selectTimelineDay(day));
      rect.addEventListener("keydown",(event)=>matrixCellKeydown(event,day));
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
    label.setAttribute("x",String(MATRIX_EDGE_INSET+column*step+1));
    label.setAttribute("y",String(height+11));
    label.setAttribute("text-anchor","start");
    label.textContent=new Date(month+"-01T00:00:00Z")
      .toLocaleDateString(undefined,{month:"short",timeZone:"UTC"}).toUpperCase();
    matrixSvg.append(label);
  }
}
function setMatrixMetric(metric:MatrixMetric):void {
  const inputs=[...matrixLinks.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  const selected=inputs.find(input=>input.value===metric);
  if(!selected)return;
  matrixMetric=metric;
  for(const input of inputs)input.checked=input===selected;
  renderMatrix();
}
for(const input of matrixLinks.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
  input.addEventListener("change",()=>{
    if(input.checked){setMatrixMetric(input.value as MatrixMetric);storeSearchLink();}
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
  const low=MIN_SEARCH_DATE, high=maxSearchDate();
  const shifted=shift(validDate(dateField.value) ? dateField.value : new Date().toISOString().slice(0,10));
  dateField.value = shifted<low ? low : shifted>high ? high : shifted;
  applyWindowFromDate();
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
  // A single date selects the year; older links carry a from/to range instead.
  const wantedDate = params.get("date");
  if(wantedDate && validDate(wantedDate)) dateField.value = wantedDate;
  else if(validDate(params.get("from")??"")) dateField.value = params.get("from")!;
  else dateField.value = new Date().toISOString().slice(0,10);
  dateField.min=MIN_SEARCH_DATE;
  dateField.max=maxSearchDate();
  applyWindowFromDate();
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
  const satelliteType=params.get("satellites");
  satelliteTypeFilter.value=satelliteType==="public"||satelliteType==="commercial"?satelliteType:"";
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
  const sensor=params.get("sensor");
  if(sensor==="optical"||sensor==="radar"||sensor==="all")sensorFilter=sensor;
  syncFilterUI();
  const wantedAoi=params.get("aoi");
  if(wantedAoi){
    const ring=wantedAoi.split(" ").map((pair)=>pair.split(",").map(Number))
      .filter((pair)=>pair.length===2&&pair.every(Number.isFinite))
      .map((pair)=>[pair[0],pair[1]] as [number,number]);
    if(ring.length>=3){ aoiRing=ring; setAreaMode(false); }
  }
  const wantedExtras=params.get("src");
  if(wantedExtras!==null){
    enabledExtraSources.clear();
    for(const id of wantedExtras.split(","))
      if(EXTRA_SOURCES.some((source)=>source.id===id))enabledExtraSources.add(id);
  }
  syncSourceToggles();
  const wantedScene=params.get("scene");
  if(wantedScene)initialPermalinkScene=wantedScene;
  const wantedTab=params.get("tab");
  // The form already carries a location and a range, so search on start instead of waiting
  // for a click; a permalink merely overrides those inputs.
  queueMicrotask(async ()=>{
    await runSearch();
    if(wantedTab==="upcoming")setTab("upcoming");
    if(initialPermalinkScene){
      const scene=loadedScenes.find((candidate)=>tileAssetFor(candidate)&&candidate.id===initialPermalinkScene);
      initialPermalinkScene=null;
      if(scene){
        // The link names an image, so make sure its day is the selected one first: otherwise the
        // day filter can hide the scene and the preview would not open at all.
        const day=scene.acquiredAt.slice(0,10);
        if(selectedDay!==day&&day>=from.value&&day<=to.value){
          selectedDay=day;
          redrawAvailability();
          renderLoadedScenes();
        }
        openScenePreview(scene);
      }
    }
  });
}
const MANAGED_PARAMS=["lat","lon","radius","date","day","zoom","tab","metric","sensor",
  "mission","collection","catalogue","orbit","tiles","cloudmin","cloudmax","hmin","hmax","maxgsd",
  "preview","unknown","satellites","src","aoi","scene","from","to"];
function storeSearchLink():void {
  const url=new URL(window.location.href);
  for(const name of MANAGED_PARAMS)url.searchParams.delete(name);
  url.searchParams.set("lat",lat.value);
  url.searchParams.set("lon",lon.value);
  url.searchParams.set("radius",radius.value);
  // The date carries its year, so from/to are not written; they are still read for older links.
  url.searchParams.set("date",dateField.value);
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
  if(cloudMin.value!=="")url.searchParams.set("cloudmin",cloudMin.value);
  if(cloudMax.value!=="")url.searchParams.set("cloudmax",cloudMax.value);
  if(hourMin.value!=="0")url.searchParams.set("hmin",hourMin.value);
  if(hourMax.value!=="23")url.searchParams.set("hmax",hourMax.value);
  if(resolutionFilter.value)url.searchParams.set("maxgsd",resolutionFilter.value);
  url.searchParams.set("preview",hasPreview.checked?"1":"0");
  if(satelliteTypeFilter.value)url.searchParams.set("satellites",satelliteTypeFilter.value);
  url.searchParams.set("unknown",includeUnknown.checked?"1":"0");
  url.searchParams.set("src",[...enabledExtraSources].sort().join(","));
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
  if(map.isStyleLoaded())apply();else map.once("idle",apply);
}
// Product identity groups proven copies. A similar date/footprint is not identity evidence.
const sceneProvenance=new WeakMap<Scene,Scene[]>();
function sceneKey(scene:Scene):string {
  const properties=rawProperties(scene);
  const product=properties["s2:product_uri"];
  const identity=typeof product==="string" ? product.replace(/\.SAFE$/, "")
    : /^S2[ABC]_MSIL[12][AC]_/.test(scene.id) ? scene.id.replace(/\.SAFE$/, "") : scene.id;
  const namespace=["earth-search","planetary-computer","copernicus"].includes(scene.providerId)
    ? "public-stac" : scene.providerId;
  return JSON.stringify([namespace,scene.collection,identity]);
}
function dedupeScenes(scenes:Scene[]):Scene[] {
  const groups=new Map<string,Scene[]>();
  for(const scene of scenes){
    const key=sceneKey(scene), group=groups.get(key)??[];
    for(const original of sceneProvenance.get(scene)??[scene])
      if(!group.some(item=>item.providerId===original.providerId && item.id===original.id && item.collection===original.collection))group.push(original);
    groups.set(key,group);
  }
  return [...groups.values()].map(group=>{
    // A native-tile copy keeps the observation eligible while retaining every catalogue record.
    const scene=group.find(item=>tileAssetFor(item))??group[0];
    sceneProvenance.set(scene,group);
    return scene;
  });
}
function sceneCatalogues(scene:Scene):string[] {
  return [...new Set((sceneProvenance.get(scene)??[scene]).map(item=>item.providerId))];
}
// Radar (SAR) scenes come from Sentinel-1/PALSAR/NISAR-style collections; the rest is optical.
const RADAR_COLLECTION=/(sentinel-1|palsar|nisar|\bgrd\b|\brtc\b)/i;
function isRadarScene(scene:Scene):boolean {
  return RADAR_COLLECTION.test(scene.collection) || /^(sentinel-1|nisar|alos-2)/i.test(scene.mission??"");
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
const COMMERCIAL_MISSIONS=/^(?:wv0?[1-4]|worldview(?:-?legion|[- ]?[1-4])?|geoeye[- ]?1|ge0?1|quickbird|qb0?2|skysat.*|planetscope|pleiades.*|pl[eé]iades.*|spot[- ]?[1-7]|umbra.*|capella.*)$/i;
const sourceOperatorTypes=new Map(listSources().map(source=>[source.id,source.operatorType]));
function isCommercialScene(scene:Scene):boolean {
  if(sourceOperatorTypes.get(scene.providerId.split(":")[0])==="commercial")return true;
  if(COMMERCIAL_MISSIONS.test(scene.mission??""))return true;
  return scene.access==="payment-required";
}
function sceneMatchesLocation(scene:Scene):boolean {
  // A drawn AOI is already constrained by the catalogue query; point views require coverage.
  if(aoiRing)return true;
  const pointLng=Number(lon.value),pointLat=Number(lat.value);
  return !Number.isFinite(pointLng) || !Number.isFinite(pointLat) || sceneCoversPoint(scene,pointLng,pointLat);
}
function passesFilters(scene:Scene):boolean {
  if(!tileAssetFor(scene))return false;
  const commercial=isCommercialScene(scene);
  if(satelliteTypeFilter.value==="public" && commercial)return false;
  if(satelliteTypeFilter.value==="commercial" && !commercial)return false;
  if(sensorFilter==="radar"&&!isRadarScene(scene))return false;
  if(sensorFilter==="optical"&&isRadarScene(scene))return false;
  if(!sceneMatchesLocation(scene))return false;
  if (missionFilter.value && (scene.mission || "unknown") !== missionFilter.value) return false;
  if (collectionFilter.value && scene.collection !== collectionFilter.value) return false;
  if (providerFilter.value && !sceneCatalogues(scene).includes(providerFilter.value)) return false;
  if (orbitFilter.value) {
    const state=rawProperties(scene)["sat:orbit_state"];
    const orbit=typeof state==="string"?state.toLowerCase():"unknown";
    if(orbit !== orbitFilter.value) return false;
  }
  if (!includeUnknown.checked && scene.cloudCoverPercent === null) return false;
  if (cloudMin.value !== "" && scene.cloudCoverPercent !== null && scene.cloudCoverPercent < Number(cloudMin.value)) return false;
  if (cloudMax.value !== "" && scene.cloudCoverPercent !== null && scene.cloudCoverPercent > Number(cloudMax.value)) return false;
  const hour = new Date(scene.acquiredAt).getUTCHours();
  if (hour < Number(hourMin.value) || hour > Number(hourMax.value)) return false;
  if (resolutionFilter.value && (scene.gsdMeters === null || scene.gsdMeters > Number(resolutionFilter.value))) return false;
  if (hasPreview.checked && !hasPublicPreview(scene)) return false;
  return true;
}
function hasActiveFilters():boolean {
  return Boolean(satelliteTypeFilter.value || sensorFilter!=="all" || providerFilter.value || orbitFilter.value ||
    missionFilter.value || collectionFilter.value || cloudMin.value || cloudMax.value ||
    resolutionFilter.value || hasPreview.checked || !includeUnknown.checked ||
    Number(hourMin.value) > 0 || Number(hourMax.value) < 23);
}
function updateFilterChoices():void {
  const eligible=loadedScenes.filter(scene=>tileAssetFor(scene));
  const wasMission=missionFilter.value||pendingMissionFilter;
  const missions=[...new Set(eligible.map(scene=>scene.mission || "unknown"))].sort();
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
  const collections=[...new Set(eligible.map(scene=>scene.collection).filter(Boolean))].sort();
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
  const providers=[...new Set(eligible.flatMap(sceneCatalogues).filter(Boolean))].sort();
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
  if(!selected.length){
    // Selecting a pixel with no observations is a valid state: say so rather than showing
    // an empty panel.
    let description: string;
    const canRecover = satelliteTypeFilter.value === "commercial" && !loadedScenes.some(passesFilters) && loadedScenes.some(sceneMatchesLocation);
    if (satelliteTypeFilter.value === "commercial" && !loadedScenes.some(passesFilters)) {
      description = "No commercial-satellite observations match these filters in the connected public catalogues. Full paid-archive search requires a provider account.";
    } else description = selectedDay
      ? "No observations on " + selectedDay + " for this location. Pick another day on the matrix."
      : "No observations match the current filters. Only observations with native-resolution tiles are shown.";
    const empty = sharedEmptyState(description, canRecover
      ? [{label: "Show all loaded observations", action: "show-all-observations"}] : []);
    empty.querySelector('[data-tcsn-action="show-all-observations"]')?.addEventListener("click", () => {
      selectedDay = null;
      clearFilters.click();
    });
    fragment.append(empty);
  }
  results.replaceChildren(fragment);
  const counted=loadedScenes.filter(scene=>tileAssetFor(scene)&&sceneMatchesLocation(scene)).length;
  const filtering=hasActiveFilters();
  counter.textContent=String(visible.length)+(filtering?" / "+counted:"");
  showMoreButton.hidden=visible.length<=displayedLimit;
  matrixItems=loadedScenes.filter(passesFilters);
  renderMatrix();
}
function redrawAvailability():void {
  const full=currentSummary;
  if(!full) return;
  allDaysButton.hidden=selectedDay===null;
  const statusParts:string[]=[];
  const pointLng=Number(lon.value), pointLat=Number(lat.value);
  if(!aoiRing&&Number.isFinite(pointLng)&&Number.isFinite(pointLat)){
    const hidden=loadedScenes.filter((scene)=>tileAssetFor(scene)&&!sceneCoversPoint(scene,pointLng,pointLat)).length;
    if(hidden)statusParts.push(hidden+" scene"+(hidden===1?"":"s")+
      " hidden: the footprint does not cover this location.");
  }
  if(!full.complete)statusParts.push("Additional pages may exist. Counts are partial.");
  if(searchErrored)statusParts.push("Provider search failed; shown results are incomplete.");
  calendarStatus.textContent=statusParts.join(" ");
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
  syncFilterUI();
  displayedLimit=40;
  redrawAvailability();
  renderLoadedScenes();
  storeSearchLink();
}
for(const input of matrixQuick.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
  input.addEventListener("change",()=>{if(input.checked)applySensorFilter(input.value);});
clearFilters.addEventListener("click",()=>{
  sensorFilter="all";
  syncFilterUI();
  missionFilter.value=""; collectionFilter.value=""; providerFilter.value=""; orbitFilter.value="";
  cloudMin.value=""; cloudMax.value="";
  satelliteTypeFilter.value="";
  hourMin.value="0"; hourMax.value="23"; resolutionFilter.value=""; hasPreview.checked=false; includeUnknown.checked=true;
  displayedLimit=40; redrawAvailability(); renderLoadedScenes(); storeSearchLink();
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
for(const control of [missionFilter,collectionFilter,providerFilter,orbitFilter,cloudMin,cloudMax,hourMin,hourMax,resolutionFilter,hasPreview,includeUnknown,satelliteTypeFilter]) control.addEventListener("change",()=>{
  displayedLimit=40;
  redrawAvailability();
  renderLoadedScenes();
  const active=previewScenes[previewIndex];
  if(!mapPreview.hidden && active && !visibleScenes().includes(active))closeMapPreview();
  storeSearchLink();
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
  setTaskTone("info");
  setTaskBusy(true);
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
    // Once the pagination is done, an auto-selected day that turned out to hold no observations
    // must not hide the year: fall back to the whole loaded window. A day picked by clicking a
    // pixel is left alone, so the "no observations" state is still reachable on purpose.
    if(autoSelectionPending && summary.complete){
      autoSelectionPending=false;
      if(selectedDay && !loadedScenes.some((scene)=>tileAssetFor(scene)&&scene.acquiredAt.slice(0,10)===selectedDay)){
        selectedDay=null;
        displayedLimit=40;
        redrawAvailability();
        renderLoadedScenes();
        storeSearchLink();
      }
    }
    redrawAvailability();
    loadNextPagesButton.hidden=session.ended;
    if(summary.erroredProviders.length > 0){
      setTaskTone("error");
      status.textContent="Catalogue search failed for "+summary.erroredProviders.join(", ")+
        ". Available results are incomplete.";
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
    session.accumulator.markError(error instanceof Error && "providerId" in error
      ? String(error.providerId ?? "unknown") : "unknown");
    currentSummary=session.accumulator.summary();
    redrawAvailability();
    setTaskTone("error");
    status.textContent="Catalogue search failed: "+
      (error instanceof Error?error.message:String(error))+
      ". Previously loaded scenes may be incomplete.";
    loadNextPagesButton.hidden=true;
  }finally{
    session.fetching=false;
    if(session===activeScan){
      loadNextPagesButton.disabled=false;
      setTaskBusy(false);
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
  closeMapPreview();
  activeScan?.controller.abort();
  const controller=new AbortController();
  if(!append){
    hideMapLabel();
    scanAccumulator=new AvailabilityAccumulator();
    currentSummary=null;
    loadedScenes=[];
    searchErrored=false;
    // A permalink `day` wins; otherwise the current selection carries over and is only dropped
    // when it falls outside the new window. The date's own pixel is set when the date changes.
    if(initialPermalinkDay && initialPermalinkDay>=from.value && initialPermalinkDay<=to.value) {
      selectedDay=initialPermalinkDay;
    }else if(selectedDay && (selectedDay<from.value || selectedDay>to.value)) {
      selectedDay=null;
    }
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
    setTaskBusy(false, "upcoming-status");
    plansResults.replaceChildren();
    displaySwaths([]);
    closeMapPreview();
  }
  const accumulator=scanAccumulator??(scanAccumulator=new AvailabilityAccumulator());
  // Both public catalogues are queried together; duplicates are merged on display.
  // Additional satellites and shared URLs opt into extra catalogues.
  const providers:SearchProvider[]=[planetaryComputer(),earthSearch()];
  for(const source of EXTRA_SOURCES)
    if(enabledExtraSources.has(source.id))providers.push(source.create());
  const catalog=new SatelliteCatalog(providers);
  for (const provider of providers) accumulator.expectProvider(provider.id);
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
    const failed = new Set<string>();
    for(const chunk of chunks){
      if(controller.signal.aborted)return;
      for (const provider of providers) {
        if (failed.has(provider.id)) continue;
        try {
          yield* catalog.search({...base, from:chunk.from, to:chunk.to}, [provider.id]);
        } catch (error) {
          if (controller.signal.aborted) return;
          accumulator.markError(provider.id);
          failed.add(provider.id);
          searchErrored = true;
          currentSummary = accumulator.summary();
          redrawAvailability();
        }
      }
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
  {id:"asf-vertex",label:"ASF Vertex (Sentinel-1, NISAR, ALOS-2)",
    create:()=>asfSearch({platforms:["SENTINEL-1","NISAR","ALOS-2"]})},
  {id:"inpe-cbers",label:"INPE CBERS-4A (Brazil)",create:()=>inpeCbers()},
  // Provider-scoped NASA CMR-STAC and a numeric JAXA G-Portal dataset (GCOM-C) — the
  // same ids the repo's live smoke test uses, so both are operator-verifiable.
  {id:"nasa-cmr",label:"NASA CMR-STAC (ASF)",create:()=>cmrStac("ASF",["sentinel-1-rtc"])},
  {id:"jaxa-gportal",label:"JAXA G-Portal (GCOM-C)",create:()=>jaxaGPortal({datasetId:"10002002"})},
  // OpenAerialMap is deliberately absent: its API returns
  // `Access-Control-Allow-Origin: https://map.openaerialmap.org`, so a browser build cannot call
  // it directly (the SDKs and the live smoke use it from Node/Python/Rust instead).
];
const enabledExtraSources=new Set<string>();
function setExtraSource(id:string,enabled:boolean):void {
  if(enabled)enabledExtraSources.add(id);
  else enabledExtraSources.delete(id);
  syncSourceToggles();
  void runSearch();
}
function syncSourceToggles():void {
  for(const input of document.querySelectorAll<HTMLInputElement>("[data-source-toggle]"))
    input.checked=enabledExtraSources.has(input.dataset.sourceToggle!);
}
for(const input of document.querySelectorAll<HTMLInputElement>("[data-source-toggle]"))
  input.addEventListener("change",()=>setExtraSource(input.dataset.sourceToggle!,input.checked));
syncSourceToggles();
function syncFilterUI():void {
  for(const input of matrixQuick.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
    input.checked=input.value===sensorFilter;
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
  const metadataItems: {term: string; value: string}[] = [];
  if (item.id) metadataItems.push(line("Scene",item.id));
  if (item.mode) metadataItems.push(line("Acquisition mode",item.mode));
  if (typeof item.orbitRelative === "number")
    metadataItems.push(line("Relative orbit",String(item.orbitRelative)));
  if (item.status) metadataItems.push(line("Status", item.status));
  if (item.endAt) {
    const from=item.expectedAt.slice(11,16), until=item.endAt.slice(11,16);
    metadataItems.push(line("Datatake window", from + "\u2013" + until + " UTC"));
  }
  metadataItems.push(line("Image availability","Not yet acquired"));
  li.append(sharedDescriptionList(metadataItems));
  try {
    const source = new URL(item.sourceUrl);
    if (source.protocol === "https:") {
      const link = document.createElement("a");
      link.href = source.toString();
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Official ESA plan";
      link.append(externalLinkIcon());
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
  setTaskTone("info", "upcoming-status");
  setTaskBusy(true, "upcoming-status");
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
      const empty = sharedEmptyState("No planned datatakes for this area in the next " +
        upcomingHorizonDays() + " days. Try a larger radius." +
        (diagnostics.status === "no-current-plan" ? " No current ESA plan was published for that window." : ""));
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
      const failed = sharedEmptyState("Could not load the ESA acquisition plan for this location.");
      plansResults.replaceChildren(failed);
      matrixItems=[];
      renderMatrix();   // never leave the previous tab's data on the grid
      setTaskTone("error", "upcoming-status");
      const timedOut=error instanceof Error && /abort/i.test(error.message);
      upcomingStatus.textContent=
        (timedOut?"ESA plan lookup timed out after "+(ESA_FETCH_TIMEOUT_MS/1000)+" s. "
          :"ESA plan lookup failed. "+(error instanceof Error?error.message:String(error)))+
        (esaProxy?"":" Browser CORS may require the optional ESA proxy.");
    }
  } finally {
    if (token === currentPlanSearch) setTaskBusy(false, "upcoming-status");
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
  // behind it changes. The metric and observation-type toggles describe published scenes, so
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
