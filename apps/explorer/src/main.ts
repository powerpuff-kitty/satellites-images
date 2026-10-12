import maplibregl from "maplibre-gl";
import type { FeatureCollection, Geometry } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import "@fortawesome/fontawesome-free/css/all.min.css";
import "./style.css";
import { SatelliteCatalog, earthSearch, planetaryComputer, esaSentinelPlans,
  AvailabilityAccumulator, type AvailabilitySummary,
  type Scene, type SceneAsset, type AcquisitionOpportunity } from "@powerpuff-kitty/satellites-images";
import { renderDayCalendar, renderMonthStrip, shiftMonth, monthDates, asMonthLabel } from "./calendar.js";

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
const provider = element<HTMLSelectElement>("provider");
const status = element<HTMLElement>("status");
const results = element<HTMLOListElement>("results");
const counter = element<HTMLElement>("counter");
const form = element<HTMLFormElement>("search-form");
const calendarMonth = element<HTMLInputElement>("calendar-month");
const calendarGrid = element<HTMLElement>("day-calendar");
const monthStrip = element<HTMLElement>("month-strip");
const calendarStatus = element<HTMLElement>("calendar-status");
const prevMonth = element<HTMLButtonElement>("previous-month");
const nextMonth = element<HTMLButtonElement>("next-month");
const allDaysButton = element<HTMLButtonElement>("show-all-days");
const showMoreButton = element<HTMLButtonElement>("show-more-scenes");
const loadNextPagesButton = element<HTMLButtonElement>("load-next-pages");
const missionFilter = element<HTMLSelectElement>("mission-filter");
const collectionFilter = element<HTMLSelectElement>("collection-filter");
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
const daysAhead = element<HTMLSelectElement>("days-ahead");
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

function esaFetch(url: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  const original = new URL(String(url));
  if (original.origin !== "https://sentinels.copernicus.eu") {
    throw new Error("ESA adapter attempted to fetch an unexpected origin");
  }
  const proxied = esaProxy ?
    esaProxy.replace(/\/$/,"") + original.pathname : original.toString();
  return fetch(proxied, options);
}


const plannedProvider=esaSentinelPlans({fetchImpl:esaFetch});

const map = new maplibregl.Map({
  container: "map",
  style: mapStyle,
  center: [116.1167, -8.5833],
  zoom: 8,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl(), "top-right");
const marker = new maplibregl.Marker({color:"#e0a84b"})
  .setLngLat([116.1167, -8.5833]).addTo(map);

function updateLocation(latitude: number, longitude: number, fly = false): void {
  lat.value = latitude.toFixed(5);
  lon.value = longitude.toFixed(5);
  marker.setLngLat([longitude, latitude]);
  if (fly) map.flyTo({center:[longitude,latitude], zoom:Math.max(map.getZoom(), 8)});
}
let searchTimer=0;
function scheduleSearch():void{ window.clearTimeout(searchTimer); searchTimer=window.setTimeout(()=>void runSearch(), 350); }
let activeTab:"historical"|"upcoming"="historical";
function scheduleForTab():void{ if(activeTab==="upcoming") scheduleUpcoming(); else scheduleSearch(); }
map.on("click", (e) => { updateLocation(e.lngLat.lat, e.lngLat.lng); scheduleForTab(); });
for (const el of [lat,lon]) el.addEventListener("change", () => {
  if (Number.isFinite(lat.valueAsNumber) && Number.isFinite(lon.valueAsNumber)) {
    updateLocation(lat.valueAsNumber, lon.valueAsNumber, true);
    scheduleForTab();
  }
});
for (const el of [radius]) el.addEventListener("change", scheduleForTab);
for (const el of [provider,from,to]) el.addEventListener("change", scheduleSearch);

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
  const heading = document.createElement("div");
  heading.className = "scene-heading";
  const name = document.createElement("strong");
  name.textContent = scene.mission ?? scene.collection;
  const time = document.createElement("time");
  time.textContent = new Date(scene.acquiredAt).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short",timeZone:"UTC"})+" UTC";
  time.dateTime = scene.acquiredAt;
  heading.append(name,time);
  item.append(heading);
  item.append(line("Collection",scene.collection));
  item.append(line("Cloud coverage",scene.cloudCoverPercent===null?"Unknown":scene.cloudCoverPercent.toFixed(1)+"% (scene-wide)"));
  item.append(line("Image access",scene.access==="unknown"?"Not verified":scene.access));
  if (scene.geometry?.type==="Polygon" || scene.geometry?.type==="MultiPolygon") {
    const inspect = document.createElement("button");
    inspect.type = "button";
    inspect.className = "scene-inspect";
    inspect.textContent = "Show scene footprint";
    inspect.append(icon("fa-expand"));
    inspect.addEventListener("click",()=>highlightScene(scene));
    item.append(inspect);
  }
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
/** A provider-rendered tile set (e.g. Planetary Computer) at full resolution. */
function tileUrlFor(scene:Scene):string|null {
  return scene.assets.find((asset)=>asset.roles.includes("tiles")&&/^https?:\/\//i.test(asset.href))?.href??null;
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
  if(!map.isStyleLoaded())return;
  if(map.getLayer("scene-preview-layer"))map.removeLayer("scene-preview-layer");
  if(map.getSource("scene-preview"))map.removeSource("scene-preview");
}
function showMapPreview(index:number):void {
  const scene=previewScenes[index];
  const image=scene?previewUrlFor(scene):null;
  const tiles=scene?tileUrlFor(scene):null;
  if(!scene||(!image&&!tiles)){ closeMapPreview(); return; }
  previewIndex=index;
  const coordinates=previewCoordinates(scene);
  const apply=()=>{
    removePreviewLayer();
    // A provider tile set renders the true-colour image at full resolution; otherwise
    // overlay the best still preview, georeferenced to the scene footprint. The map
    // zoom is left untouched so the view does not jump when an image is opened.
    if(tiles)map.addSource("scene-preview",{type:"raster",url:tiles,tileSize:256});
    else map.addSource("scene-preview",{type:"image",url:image as string,coordinates});
    map.addLayer({id:"scene-preview-layer",type:"raster",source:"scene-preview",
      paint:{"raster-opacity":0.96}});
  };
  if(map.isStyleLoaded())apply();else map.once("load",apply);
  previewCaption.textContent=(scene.mission ?? scene.collection)+" · "+
    new Date(scene.acquiredAt).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short",timeZone:"UTC"})+" UTC";
  mapPreview.hidden=false;
}
function closeMapPreview():void {
  if(mapPreview.hidden)return;
  mapPreview.hidden=true;
  removePreviewLayer();
}
function stepPreview(delta:number):void {
  if(!previewScenes.length)return;
  showMapPreview((previewIndex+delta+previewScenes.length)%previewScenes.length);
}
function openScenePreview(scene:Scene):void {
  const withPreviews=loadedScenes.filter((candidate)=>Boolean(previewUrlFor(candidate)??tileUrlFor(candidate)));
  const index=withPreviews.indexOf(scene);
  if(index<0)return;
  previewScenes=withPreviews;
  showMapPreview(index);
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
  selectedDay = day;
  displayedLimit = 40;
  redrawAvailability();
  renderLoadedScenes();
  storeSearchLink();
}
// --- Year-at-a-glance day matrix (GitHub-style, 8x8 px cells) ------------------
type MatrixMetric = "total" | "cloud" | "mission" | "provider";
let matrixMetric:MatrixMetric = "total";
let matrixItems:Scene[] = [];
const MATRIX_EMPTY = "#2f3830";   // a day inside the window with no observations
const MATRIX_PAD = "#171c17";     // padding days outside the loaded window
function matrixColourOf(list:Scene[], metric:MatrixMetric, max:number, order:string[]):string {
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
    const key=metric==="mission"?(scene.mission||"unknown"):scene.providerId;
    counts.set(key,(counts.get(key)??0)+1);
  }
  const top=[...counts.entries()].sort((a,b)=>b[1]-a[1])[0][0];
  const index=Math.max(0,order.indexOf(top));
  return SPLIT_PALETTE[index%SPLIT_PALETTE.length];
}
function renderMatrix():void {
  const NS="http://www.w3.org/2000/svg";
  matrixSvg.replaceChildren();
  const scenes=matrixItems, metric=matrixMetric;
  const windowFrom=Date.parse(from.value+"T00:00:00Z");
  const windowTo=Date.parse(to.value+"T00:00:00Z");
  // Always draw the window's grid, even when nothing was returned, so the year never
  // disappears; only a missing/invalid date range hides the matrix.
  if(!Number.isFinite(windowFrom)||!Number.isFinite(windowTo)||windowTo<windowFrom){
    matrixPanel.hidden=true; return;
  }
  matrixPanel.hidden=false;
  const dayMs=86400000, cell=12, step=cell+1;
  const dates=scenes.map((scene)=>scene.acquiredAt.slice(0,10))
    .filter((date)=>/^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
  const dataFirst=dates.length?Date.parse(dates[0]+"T00:00:00Z"):NaN;
  const dataLast=dates.length?Date.parse(dates[dates.length-1]+"T00:00:00Z"):NaN;
  let first=windowFrom, last=windowTo;
  if(Number.isFinite(dataFirst))first=Math.min(first,dataFirst);
  if(Number.isFinite(dataLast))last=Math.max(last,dataLast);
  const startDow=(new Date(first).getUTCDay()+6)%7;
  const start=first-startDow*dayMs;
  const endDow=(new Date(last).getUTCDay()+6)%7;
  const end=last+(6-endDow)*dayMs;
  const nDays=Math.max(1,Math.round((end-start)/dayMs)+1);
  const weeks=Math.ceil(nDays/7);
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
  const order:string[]=[];
  if(metric==="mission"||metric==="provider"){
    const totals=new Map<string,number>();
    for(const scene of scenes){
      const key=metric==="mission"?(scene.mission||"unknown"):scene.providerId;
      totals.set(key,(totals.get(key)??0)+1);
    }
    order.push(...[...totals.keys()].sort((a,b)=>totals.get(b)!-totals.get(a)!));
  }
  for(let d=0;d<nDays;d++){
    const time=start+d*dayMs;
    const day=new Date(time).toISOString().slice(0,10);
    const inWindow=time>=first&&time<=last;
    const list=inWindow?perDay.get(day):undefined;
    const rect=document.createElementNS(NS,"rect");
    rect.setAttribute("class","matrix-cell");
    rect.setAttribute("data-day",day);
    rect.setAttribute("x",String(Math.floor(d/7)*step));
    rect.setAttribute("y",String((d%7)*step));
    rect.setAttribute("width",String(cell));
    rect.setAttribute("height",String(cell));
    rect.setAttribute("rx","1");
    const tip=document.createElementNS(NS,"title");
    if(list){
      rect.setAttribute("fill",matrixColourOf(list,metric,max,order));
      tip.textContent=day+" - "+list.length+" observation"+(list.length===1?"":"s");
      rect.addEventListener("click",()=>selectTimelineDay(day));
    }else{
      // Placeholder so every day of the year reads as a present, empty cell.
      rect.setAttribute("fill",inWindow?MATRIX_EMPTY:MATRIX_PAD);
      tip.textContent=day+(inWindow?" - no observations":" - outside the loaded range");
    }
    rect.append(tip);
    matrixSvg.append(rect);
  }
  matrixSvg.setAttribute("aria-label","Observations per day across the loaded year");
}
for(const link of matrixLinks.querySelectorAll<HTMLButtonElement>(".matrix-link")){
  link.addEventListener("click",()=>{
    matrixMetric=(link.dataset.metric as MatrixMetric) ?? "total";
    for(const other of matrixLinks.querySelectorAll<HTMLButtonElement>(".matrix-link"))
      other.setAttribute("aria-pressed",String(other===link));
    renderMatrix();
  });
}
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
  calendarMonth.value=windowMonth();
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
let displayedLimit=40;
let searchErrored=false;
let activeMonth:string = windowMonth();

function validDate(input:string):boolean {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(input))return false;
  const time=Date.parse(input+"T00:00:00Z");
  return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===input;
}
// The month the calendar should open on: the current month, or the window end if
// the loaded window does not include it.
function windowMonth():string {
  const low=from.value.slice(0,7), high=to.value.slice(0,7);
  const current=new Date().toISOString().slice(0,7);
  return current>=low&&current<=high?current:high;
}
function restoreSearchLink():void {
  const params=new URLSearchParams(window.location.search);
  const latitude=Number(params.get("lat"));
  const longitude=Number(params.get("lon"));
  if(params.has("lat")&&params.has("lon")&&Number.isFinite(latitude)&&Number.isFinite(longitude)
    &&latitude>=-90&&latitude<=90&&longitude>=-180&&longitude<=180) {
    lat.value=String(latitude); lon.value=String(longitude);
  }
  const wantedRadius=params.get("radius");
  if(wantedRadius&&[...radius.options].some(o=>o.value===wantedRadius))radius.value=wantedRadius;
  const wantedProvider=params.get("provider");
  if(wantedProvider&&[...provider.options].some(o=>o.value===wantedProvider))provider.value=wantedProvider;
  if(validDate(params.get("from")??"")&&validDate(params.get("to")??"")) {
    from.value=params.get("from")!;
    to.value=params.get("to")!;
  } else {
    const year=new Date().toISOString().slice(0,4);
    from.value=year+"-01-01";
    to.value=year+"-12-31";
  }
  activeMonth=windowMonth();
  calendarMonth.value=activeMonth;
  const restoredDay=params.get("day");
  if(restoredDay&&validDate(restoredDay)&&restoredDay>=from.value&&restoredDay<=to.value) {
    initialPermalinkDay=restoredDay;
    selectedDay=restoredDay;
    activeMonth=restoredDay.slice(0,7);
    calendarMonth.value=activeMonth;
  }
  const center:[number,number]=[Number(lon.value),Number(lat.value)];
  marker.setLngLat(center);
  const restoredZoom=Number(params.get("zoom"));
  if(Number.isFinite(restoredZoom)&&restoredZoom>0&&restoredZoom<=20)
    map.jumpTo({center,zoom:restoredZoom});
  else
    map.jumpTo({center});
  // A query permalink should reproduce its search, not just fill dormant inputs.
  if(validDate(params.get("from")??"") && validDate(params.get("to")??""))
    queueMicrotask(()=>void runSearch());
}
function storeSearchLink():void {
  const url=new URL(window.location.href);
  for(const name of ["lat","lon","radius","from","to","provider","day","zoom"])url.searchParams.delete(name);
  url.searchParams.set("lat",lat.value);
  url.searchParams.set("lon",lon.value);
  url.searchParams.set("radius",radius.value);
  url.searchParams.set("provider",provider.value);
  url.searchParams.set("from",from.value);
  url.searchParams.set("to",to.value);
  if(selectedDay)url.searchParams.set("day",selectedDay);
  url.searchParams.set("zoom",map.getZoom().toFixed(2));
  window.history.replaceState(null,"",url);
}
map.on("moveend",()=>storeSearchLink());
function highlightScene(scene:Scene|undefined):void {
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
function passesFilters(scene:Scene):boolean {
  if (missionFilter.value && (scene.mission || "unknown") !== missionFilter.value) return false;
  if (collectionFilter.value && scene.collection !== collectionFilter.value) return false;
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
  return Boolean(missionFilter.value || collectionFilter.value || cloudMin.value || cloudMax.value ||
    resolutionFilter.value || hasPreview.checked || !includeUnknown.checked ||
    Number(hourMin.value) > 0 || Number(hourMax.value) < 23);
}
function updateFilterChoices():void {
  const wasMission=missionFilter.value;
  const missions=[...new Set(loadedScenes.map(scene=>scene.mission || "unknown"))].sort();
  const missionFragment=document.createDocumentFragment();
  const allMission=document.createElement("option");
  allMission.value=""; allMission.textContent="All satellites"; missionFragment.append(allMission);
  for(const mission of missions) {
    const option=document.createElement("option"); option.value=mission; option.textContent=mission; missionFragment.append(option);
  }
  missionFilter.replaceChildren(missionFragment);
  missionFilter.value=missions.includes(wasMission)?wasMission:"";
  const wasCollection=collectionFilter.value;
  const collections=[...new Set(loadedScenes.map(scene=>scene.collection).filter(Boolean))].sort();
  const collectionFragment=document.createDocumentFragment();
  const allCollection=document.createElement("option");
  allCollection.value=""; allCollection.textContent="All collections"; collectionFragment.append(allCollection);
  for(const collection of collections) {
    const option=document.createElement("option"); option.value=collection; option.textContent=collection; collectionFragment.append(option);
  }
  collectionFilter.replaceChildren(collectionFragment);
  collectionFilter.value=collections.includes(wasCollection)?wasCollection:"";
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
function renderLoadedScenes():void {
  const visible=loadedScenes.filter(scene=>
    passesFilters(scene) && (!selectedDay || scene.acquiredAt.slice(0,10)===selectedDay));
  const selected=visible.slice(0,displayedLimit);
  const fragment=document.createDocumentFragment();
  for(const scene of selected)fragment.append(makeScene(scene));
  results.replaceChildren(fragment);
  const counted=loadedScenes.filter(passesFilters).length;
  const filtering=hasActiveFilters();
  counter.textContent=String(visible.length)+(filtering?" / "+counted:"");
  showMoreButton.hidden=visible.length<=displayedLimit;
  if(selectedDay)highlightScene(visible[0]);
  else highlightScene(undefined);
  matrixItems=loadedScenes.filter(passesFilters);
  renderMatrix();
}
function redrawAvailability():void {
  const full=currentSummary;
  if(!full) return;
  const summary=summaryFromScenes(loadedScenes.filter(passesFilters));
  renderMonthStrip(monthStrip,summary,from.value,to.value,activeMonth,(month)=>{
    activeMonth=month;calendarMonth.value=month;
    redrawAvailability();
  });
  renderDayCalendar(calendarGrid,summary,activeMonth,selectedDay,(day)=>{
    selectedDay=day;
    displayedLimit=40;
    redrawAvailability();
    renderLoadedScenes();
    storeSearchLink();
  });
  allDaysButton.hidden=selectedDay===null;
  const statusParts:string[]=[];
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
function gotoMonth(month:string,direction=0):void {
  calendarMonth.value=month;
  activeMonth=month;
  const lo=from.value.slice(0,7), hi=to.value.slice(0,7);
  if(month>=lo&&month<=hi){ redrawAvailability(); return; }
  loadQuarter(month,direction||(month<lo?-1:1));
}
prevMonth.addEventListener("click",()=>gotoMonth(shiftMonth(activeMonth,-1),-1));
nextMonth.addEventListener("click",()=>gotoMonth(shiftMonth(activeMonth,1),1));
calendarMonth.addEventListener("change",()=>{ if(calendarMonth.value)gotoMonth(calendarMonth.value); });

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
clearFilters.addEventListener("click",()=>{
  missionFilter.value=""; collectionFilter.value=""; cloudMin.value=""; cloudMax.value="";
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
for(const control of [missionFilter,collectionFilter,cloudMin,cloudMax,hourMin,hourMax,resolutionFilter,hasPreview,includeUnknown]) control.addEventListener("change",()=>{
  displayedLimit=40;
  redrawAvailability();
  renderLoadedScenes();
});

function currentSearchSignature():string {
  return JSON.stringify([
    lat.value,lon.value,radius.value,provider.value,from.value,to.value,
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
    scanAccumulator=new AvailabilityAccumulator();
    currentSummary=null;
    loadedScenes=[];
    searchErrored=false;
    selectedDay=initialPermalinkDay && initialPermalinkDay>=from.value &&
      initialPermalinkDay<=to.value ? initialPermalinkDay : null;
    initialPermalinkDay=null;
    displayedLimit=40;
    activeMonth=selectedDay?.slice(0,7)??windowMonth();
    calendarMonth.value=activeMonth;
    results.replaceChildren();
    missionFilter.value="";
    updateFilterChoices();
    calendarGrid.replaceChildren();
    monthStrip.replaceChildren();
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
  const selected=provider.value==="planetary-computer"?planetaryComputer():earthSearch();
  const catalog=new SatelliteCatalog([selected]);
  const base={
    latitude:Number(lat.value),longitude:Number(lon.value),radiusMeters:Number(radius.value),
    maxPages:50,limit:75,signal:controller.signal,
  };
  updateLocation(base.latitude,base.longitude,true);
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
restoreSearchLink();


function makePlanned(item: AcquisitionOpportunity): HTMLLIElement {
  const li = document.createElement("li");
  const heading = document.createElement("div");
  heading.className = "scene-heading";
  const name = document.createElement("strong");
  name.textContent = item.mission + " / planned";
  const time = document.createElement("time");
  time.dateTime = item.expectedAt;
  time.textContent = new Date(item.expectedAt).toLocaleString(undefined,{
    dateStyle:"medium",timeStyle:"short"
  });
  heading.append(name,time);
  li.append(heading);
  if (item.mode) li.append(line("Acquisition mode",item.mode));
  if (typeof item.orbitRelative === "number")
    li.append(line("Relative orbit",String(item.orbitRelative)));
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
async function runUpcoming():Promise<void>{
  const token=++currentPlanSearch;
  plansResults.replaceChildren();
  upcomingStatus.textContent="Checking the latest ESA acquisition plans…";
  try {
    const catalog = new SatelliteCatalog([earthSearch()],[plannedProvider]);
    const planned=await catalog.upcoming({latitude:Number(lat.value),longitude:Number(lon.value),
      radiusMeters:Number(radius.value),days:Number(daysAhead.value)});
    if(token!==currentPlanSearch)return;
    const mission=upcomingMission.value;
    const filtered=mission?planned.filter(p=>p.mission.startsWith(mission)):planned;
    displaySwaths(filtered);
    matrixItems=plannedAsScenes(filtered);
    renderMatrix();
    const list=document.createDocumentFragment();
    for(const item of filtered) list.append(makePlanned(item));
    plansResults.append(list);
    counter.textContent=String(filtered.length);
    upcomingStatus.textContent=filtered.length
      ? filtered.length+" officially planned datatake(s) intersect this area within "+daysAhead.value+" days. No image is guaranteed."
      : "No matching planned datatakes in the latest ESA plans for this location and window.";
  } catch(error) {
    if(token===currentPlanSearch) upcomingStatus.textContent=
      "ESA plan lookup failed. "+(error instanceof Error?error.message:String(error))+
      (esaProxy?"":" Browser CORS may require the optional ESA proxy.");
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
  if(tab==="upcoming") void runUpcoming();
  else { matrixItems=loadedScenes.filter(passesFilters); renderMatrix(); }
}
tabHistorical.addEventListener("click",()=>setTab("historical"));
tabUpcoming.addEventListener("click",()=>setTab("upcoming"));
let upcomingTimer=0;
function scheduleUpcoming():void{ window.clearTimeout(upcomingTimer); upcomingTimer=window.setTimeout(()=>void runUpcoming(),350); }
for(const el of [daysAhead,upcomingMission]) el.addEventListener("change",scheduleUpcoming);
