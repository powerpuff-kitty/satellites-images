import maplibregl from "maplibre-gl";
import type { FeatureCollection, Geometry } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { SatelliteCatalog, earthSearch, planetaryComputer, esaSentinelPlans,
  AvailabilityAccumulator, type AvailabilitySummary,
  type Scene, type AcquisitionOpportunity } from "@powerpuff-kitty/satellites-images";
import { renderDayCalendar, renderMonthStrip, shiftMonth, monthDates, asMonthLabel } from "./calendar.js";

const element = <T extends HTMLElement>(id: string): T => {
  const item = document.getElementById(id);
  if (!item) throw new Error("Missing UI element " + id);
  return item as T;
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
const button = element<HTMLButtonElement>("search-button");
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
const timeline = element<HTMLElement>("timeline");
const lightbox = element<HTMLElement>("lightbox");
const lightboxImage = element<HTMLImageElement>("lightbox-image");
const lightboxClose = element<HTMLButtonElement>("lightbox-close");
const windowBack = element<HTMLButtonElement>("window-back");
const windowForward = element<HTMLButtonElement>("window-forward");
const windowLabel = element<HTMLElement>("window-label");

const plansButton = element<HTMLButtonElement>("plans-button");
const plansStatus = element<HTMLElement>("plans-status");
const plansResults = element<HTMLOListElement>("plans-results");

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
map.on("click", (e) => updateLocation(e.lngLat.lat, e.lngLat.lng));
for (const el of [lat,lon]) el.addEventListener("change", () => {
  if (Number.isFinite(lat.valueAsNumber) && Number.isFinite(lon.valueAsNumber))
    updateLocation(lat.valueAsNumber, lon.valueAsNumber, true);
});

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
    inspect.textContent = "Show scene footprint ↗";
    inspect.addEventListener("click",()=>highlightScene(scene));
    item.append(inspect);
  }
  if (scene.previewUrl) {
    try {
      const url = new URL(scene.previewUrl);
      if (url.protocol === "https:") {
        const image = document.createElement("img");
        image.src = url.toString();
        image.alt = "Provider preview of satellite scene " + scene.id;
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        image.addEventListener("error", () => image.remove());
        image.addEventListener("click", () => openLightbox(url.toString(), image.alt));
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
        link.textContent = "View source metadata ↗";
        item.append(link);
      }
    } catch { /* Invalid source link */ }
  }
  return item;
}

// --- Full-screen preview ------------------------------------------------------
function openLightbox(src: string, alt: string): void {
  lightboxImage.src = src;
  lightboxImage.alt = alt;
  lightbox.hidden = false;
}
function closeLightbox(): void {
  lightbox.hidden = true;
  lightboxImage.removeAttribute("src");
}
lightboxClose.addEventListener("click", closeLightbox);
lightbox.addEventListener("click", (event) => { if (event.target === lightbox) closeLightbox(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !lightbox.hidden) closeLightbox(); });

// --- Timeline: observations per day, stacked by cloud cover (readable at a glance) ---
type CloudClass = "clear" | "partial" | "cloudy" | "unknown";
const CLOUD_FILL: Record<CloudClass, string> = { clear:"#4fbf7a", partial:"#e0ae54", cloudy:"#9aa0a2", unknown:"#5b665b" };
function cloudClassOf(percent: number | null): CloudClass {
  if (percent === null) return "unknown";
  if (percent < 10) return "clear";
  if (percent < 60) return "partial";
  return "cloudy";
}
function renderTimeline(): void {
  const scenes = loadedScenes.filter(filterByMission);
  timeline.replaceChildren();
  if (!scenes.length) {
    const empty = document.createElement("figcaption");
    empty.textContent = "No loaded observations to plot yet.";
    timeline.append(empty);
    return;
  }
  const NS = "http://www.w3.org/2000/svg";
  const width = Math.max(240, timeline.clientWidth || 320);
  const height = 104;
  const padL = 28, padR = 8, padT = 8, padB = 18;
  const W = width - padL - padR, H = height - padT - padB;
  const dayMs = 86400000;
  const buckets = new Map<string, { counts: Record<CloudClass, number>; count: number }>();
  for (const scene of scenes) {
    const day = scene.acquiredAt.slice(0, 10);
    const bucket = buckets.get(day) ?? { counts: { clear:0, partial:0, cloudy:0, unknown:0 }, count: 0 };
    bucket.counts[cloudClassOf(scene.cloudCoverPercent)] += 1;
    bucket.count += 1;
    buckets.set(day, bucket);
  }
  const days = [...buckets.keys()].sort();
  const first = Date.parse(days[0] + "T00:00:00Z");
  const last = Date.parse(days[days.length - 1] + "T00:00:00Z");
  const nDays = Math.max(1, Math.round((last - first) / dayMs) + 1);
  const colW = W / nDays;
  const maxCount = Math.max(...[...buckets.values()].map((b) => b.count));
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`); // 1:1 — no distortion
  svg.setAttribute("role", "img");
  for (const value of [0, maxCount]) {
    const y = padT + (1 - value / maxCount) * H;
    const grid = document.createElementNS(NS, "line");
    grid.setAttribute("x1", String(padL)); grid.setAttribute("x2", String(padL + W));
    grid.setAttribute("y1", String(y)); grid.setAttribute("y2", String(y));
    grid.setAttribute("class", value === 0 ? "axis" : "grid");
    svg.append(grid);
    if (value > 0) {
      const tick = document.createElementNS(NS, "text");
      tick.setAttribute("x", "2"); tick.setAttribute("y", String(y + 3)); tick.setAttribute("class", "tick");
      tick.textContent = String(value);
      svg.append(tick);
    }
  }
  for (const day of days) {
    const bucket = buckets.get(day)!;
    const index = Math.round((Date.parse(day + "T00:00:00Z") - first) / dayMs);
    const x = padL + index * colW;
    const group = document.createElementNS(NS, "g");
    group.setAttribute("class", "bar-group");
    group.setAttribute("data-day", day);
    let baseline = padT + H;
    for (const cls of ["unknown", "cloudy", "partial", "clear"] as CloudClass[]) {
      const n = bucket.counts[cls];
      if (!n) continue;
      const h = (n / maxCount) * H;
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", (x + colW * 0.15).toFixed(1));
      rect.setAttribute("width", Math.max(1, colW * 0.7).toFixed(1));
      rect.setAttribute("y", (baseline - h).toFixed(1));
      rect.setAttribute("height", h.toFixed(1));
      rect.setAttribute("fill", CLOUD_FILL[cls]);
      group.append(rect);
      baseline -= h;
    }
    const title = document.createElementNS(NS, "title");
    title.textContent = `${day} · ${bucket.count} obs · clear ${bucket.counts.clear}, partial ${bucket.counts.partial}, cloudy ${bucket.counts.cloudy}, n/a ${bucket.counts.unknown}`;
    group.append(title);
    group.addEventListener("click", () => {
      selectedDay = selectedDay === day ? null : day;
      displayedLimit = 40;
      redrawAvailability();
      renderLoadedScenes();
      storeSearchLink();
    });
    svg.append(group);
  }
  // Sparse date labels: first, last and up to three in between.
  const labelIndices = new Set<number>([0, nDays - 1]);
  for (let k = 1; k <= 3; k++) labelIndices.add(Math.round((nDays - 1) * k / 4));
  for (const index of [...labelIndices].sort((a, b) => a - b)) {
    const date = new Date(first + index * dayMs);
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", (padL + index * colW + colW / 2).toFixed(1));
    label.setAttribute("y", String(height - 5));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "tick");
    label.textContent = date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
    svg.append(label);
  }
  timeline.append(svg);
}

interface HistoryScan {
  controller:AbortController;
  accumulator:AvailabilityAccumulator;
  iterator:AsyncGenerator<import("@powerpuff-kitty/satellites-images").SearchPage>;
  fetching:boolean;
  ended:boolean;
  signature:string;
}
let activeScan:HistoryScan|null=null;
let initialPermalinkDay:string|null=null;
let loadedScenes:Scene[]=[];
let currentSummary:AvailabilitySummary|null=null;
let selectedDay:string|null=null;
let displayedLimit=40;
let searchErrored=false;
let activeMonth:string = to.value.slice(0,7);

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
  }
  const wantedRadius=params.get("radius");
  if(wantedRadius&&[...radius.options].some(o=>o.value===wantedRadius))radius.value=wantedRadius;
  const wantedProvider=params.get("provider");
  if(wantedProvider&&[...provider.options].some(o=>o.value===wantedProvider))provider.value=wantedProvider;
  if(validDate(params.get("from")??"")&&validDate(params.get("to")??"")) {
    from.value=params.get("from")!;
    to.value=params.get("to")!;
  } else {
    const today=new Date().toISOString().slice(0,10);
    const nowMonth=today.slice(0,7);
    from.value=shiftMonth(nowMonth,-1)+"-01";
    to.value=today;
  }
  activeMonth=to.value.slice(0,7);
  calendarMonth.value=activeMonth;
  const restoredDay=params.get("day");
  if(restoredDay&&validDate(restoredDay)&&restoredDay>=from.value&&restoredDay<=to.value) {
    initialPermalinkDay=restoredDay;
    selectedDay=restoredDay;
    activeMonth=restoredDay.slice(0,7);
    calendarMonth.value=activeMonth;
  }
  marker.setLngLat([Number(lon.value),Number(lat.value)]);
  map.jumpTo({center:[Number(lon.value),Number(lat.value)]});
  // A query permalink should reproduce its search, not just fill dormant inputs.
  if(validDate(params.get("from")??"") && validDate(params.get("to")??""))
    queueMicrotask(()=>form.requestSubmit());
}
function storeSearchLink():void {
  const url=new URL(window.location.href);
  for(const name of ["lat","lon","radius","from","to","provider","day"])url.searchParams.delete(name);
  url.searchParams.set("lat",lat.value);
  url.searchParams.set("lon",lon.value);
  url.searchParams.set("radius",radius.value);
  url.searchParams.set("provider",provider.value);
  url.searchParams.set("from",from.value);
  url.searchParams.set("to",to.value);
  if(selectedDay)url.searchParams.set("day",selectedDay);
  window.history.replaceState(null,"",url);
}
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
function filterByMission(scene:Scene):boolean {
  return !missionFilter.value || (scene.mission || "unknown")===missionFilter.value;
}
function updateMissionChoices():void {
  const wasSelected=missionFilter.value;
  const values=[...new Set(loadedScenes.map(scene=>scene.mission || "unknown"))].sort();
  const fragment=document.createDocumentFragment();
  const all=document.createElement("option");
  all.value="";
  all.textContent="All satellites";
  fragment.append(all);
  for(const mission of values) {
    const option=document.createElement("option");
    option.value=mission;
    option.textContent=mission;
    fragment.append(option);
  }
  missionFilter.replaceChildren(fragment);
  missionFilter.value=values.includes(wasSelected)?wasSelected:"";
}
function filteredCalendar(summary:AvailabilitySummary):AvailabilitySummary {
  const mission=missionFilter.value;
  if(!mission) return summary;
  const days=summary.days
    .map(d=>({...d,count:d.missions[mission]??0}))
    .filter(d=>d.count>0);
  const months=summary.months
    .map(m=>({
      ...m,count:m.missions[mission]??0,
      daysWithObservations:days.filter(d=>d.date.startsWith(m.month+"-")).length,
    })).filter(m=>m.count>0);
  return {...summary,days,months,uniqueItems:days.reduce((acc,d)=>acc+d.count,0)};
}
function renderLoadedScenes():void {
  const visible=loadedScenes.filter(scene=>
    filterByMission(scene) && (!selectedDay || scene.acquiredAt.slice(0,10)===selectedDay));
  const selected=visible.slice(0,displayedLimit);
  const fragment=document.createDocumentFragment();
  for(const scene of selected)fragment.append(makeScene(scene));
  results.replaceChildren(fragment);
  const counted=loadedScenes.filter(filterByMission).length;
  counter.textContent=String(visible.length)+((selectedDay || missionFilter.value)?" / "+counted:"");
  showMoreButton.hidden=visible.length<=displayedLimit;
  if(selectedDay)highlightScene(visible[0]);
  else highlightScene(undefined);
  renderTimeline();
}
function redrawAvailability():void {
  const full=currentSummary;
  if(!full) return;
  const summary=filteredCalendar(full);
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
  const statusParts=[
    summary.uniqueItems+" "+(missionFilter.value?"filtered ":"")+"published items from "+full.pagesScanned+" catalogue page(s)",
  ];
  if(!summary.complete)statusParts.push("Additional pages may exist. Counts are partial.");
  if(searchErrored)statusParts.push("Provider search failed; shown results are incomplete.");
  statusParts.push("Empty cells mean no observation in loaded results, not proof of missing imagery.");
  calendarStatus.textContent=statusParts.join(" ");
}
function searchMonth(month:string):void {
  const dates=monthDates(month);
  calendarMonth.value=month;
  activeMonth=month;
  selectedDay=null;
  from.value=dates.from;
  to.value=dates.to;
  form.requestSubmit();
}
prevMonth.addEventListener("click",()=>searchMonth(shiftMonth(calendarMonth.value,-1)));
nextMonth.addEventListener("click",()=>searchMonth(shiftMonth(calendarMonth.value,1)));
calendarMonth.addEventListener("change",()=>{
  if(calendarMonth.value)searchMonth(calendarMonth.value);
});

// --- Search-window steppers: move the whole from/to window one span earlier/later ---
const DAY_MS=86400000;
function dateMs(value:string):number{const [y,m,d]=value.split("-").map(Number);return Date.UTC(y,m-1,d);}
function isoDate(ms:number):string{return new Date(ms).toISOString().slice(0,10);}
function updateWindowLabel():void{
  windowLabel.textContent=from.value&&to.value?from.value+" → "+to.value:"—";
  windowForward.disabled=dateMs(to.value)>=dateMs(new Date().toISOString().slice(0,10));
}
function shiftWindow(direction:number):void{
  const span=Math.max(1,Math.round((dateMs(to.value)-dateMs(from.value))/DAY_MS)+1);
  if(direction<0){
    const newTo=dateMs(from.value)-DAY_MS;
    from.value=isoDate(newTo-(span-1)*DAY_MS);
    to.value=isoDate(newTo);
  }else{
    const newFrom=dateMs(to.value)+DAY_MS;
    from.value=isoDate(newFrom);
    to.value=isoDate(newFrom+(span-1)*DAY_MS);
  }
  calendarMonth.value=to.value.slice(0,7);
  form.requestSubmit();
}
windowBack.addEventListener("click",()=>shiftWindow(-1));
windowForward.addEventListener("click",()=>shiftWindow(1));
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
  button.disabled=true;
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
      updateMissionChoices();
      currentSummary=session.accumulator.summary();
      redrawAvailability();
      renderLoadedScenes();
      examined++;
      status.textContent="Scanned "+currentSummary.pagesScanned+" catalogue page(s); "+
        currentSummary.uniqueItems+" unique published observations loaded…";
      if(!page.hasNext){session.ended=true;break;}
    }
    if(session!==activeScan||session.controller.signal.aborted)return;
    const summary=session.accumulator.summary();
    currentSummary=summary;
    if(summary.pagesScanned>=50)session.ended=true;
    redrawAvailability();
    loadNextPagesButton.hidden=session.ended || summary.complete;
    if(summary.uniqueItems===0 && summary.complete) {
      status.textContent="No scenes returned by this catalogue for the selected time window.";
    }else if(summary.complete){
      status.textContent=summary.uniqueItems+" unique scenes returned; "+
        "catalogue pagination exhausted for this query.";
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
      button.disabled=false;
      loadNextPagesButton.disabled=false;
    }
  }
}
loadNextPagesButton.addEventListener("click",()=>{
  if(activeScan)void scanNextBatch(activeScan);
});

form.addEventListener("submit",async(event)=>{
  event.preventDefault();
  activeScan?.controller.abort();
  const controller=new AbortController();
  const accumulator=new AvailabilityAccumulator();
  currentSummary=null;
  loadedScenes=[];
  searchErrored=false;
  selectedDay=initialPermalinkDay && initialPermalinkDay>=from.value &&
    initialPermalinkDay<=to.value ? initialPermalinkDay : null;
  initialPermalinkDay=null;
  displayedLimit=40;
  activeMonth=selectedDay?.slice(0,7)??to.value.slice(0,7);
  calendarMonth.value=activeMonth;
  results.replaceChildren();
  missionFilter.value="";
  updateMissionChoices();
  calendarGrid.replaceChildren();
  monthStrip.replaceChildren();
  counter.textContent="—";
  loadNextPagesButton.hidden=true;
  status.textContent="Searching public satellite catalogues…";
  calendarStatus.textContent="Loading UTC acquisition dates…";
  currentPlanSearch++;
  plansButton.disabled=false;
  plansResults.replaceChildren();
  plansStatus.textContent="Check future acquisitions for this location.";
  displaySwaths([]);
  const selected=provider.value==="planetary-computer"?planetaryComputer():earthSearch();
  const catalog=new SatelliteCatalog([selected]);
  const query={
    latitude:Number(lat.value),longitude:Number(lon.value),radiusMeters:Number(radius.value),
    from:from.value,to:to.value,maxPages:50,limit:75,signal:controller.signal,
  };
  updateLocation(query.latitude,query.longitude,true);
  const session:HistoryScan = {
    controller,accumulator,iterator:catalog.search(query),fetching:false,
    ended:false,signature:currentSearchSignature(),
  };
  activeScan=session;
  storeSearchLink();
  updateWindowLabel();
  await scanNextBatch(session);
});
restoreSearchLink();
updateWindowLabel();

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
      link.textContent = "Official ESA plan ↗";
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
plansButton.addEventListener("click",async()=>{
  const token=++currentPlanSearch;
  plansResults.replaceChildren();
  plansStatus.textContent="Checking the latest ESA acquisition plans…";
  plansButton.disabled=true;
  try {
    const catalog = new SatelliteCatalog([earthSearch()],[
      plannedProvider,
    ]);
    const query={latitude:Number(lat.value),longitude:Number(lon.value),
      radiusMeters:Number(radius.value),days:14};
    const planned=await catalog.upcoming(query);
    if(token!==currentPlanSearch)return;
    displaySwaths(planned);
    const list=document.createDocumentFragment();
    for(const item of planned) list.append(makePlanned(item));
    plansResults.append(list);
    plansStatus.textContent=planned.length
      ? planned.length+" officially planned datatake(s) intersect this search area. No image is guaranteed."
      : "No matching planned datatakes in the latest ESA plans for this location and time window.";
  } catch(error) {
    if(token===currentPlanSearch) plansStatus.textContent=
      "ESA plan lookup failed. "+
      (error instanceof Error?error.message:String(error))+
      (esaProxy?"":" Browser CORS may require the optional ESA proxy.");
  } finally {
    if(token===currentPlanSearch) plansButton.disabled=false;
  }
});
