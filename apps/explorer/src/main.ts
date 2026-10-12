import maplibregl from "maplibre-gl";
import type { FeatureCollection, Geometry } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import "@fortawesome/fontawesome-free/css/all.min.css";
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
const timeline = element<HTMLElement>("timeline");
const lightbox = element<HTMLElement>("lightbox");
const lightboxImage = element<HTMLImageElement>("lightbox-image");
const lightboxClose = element<HTMLButtonElement>("lightbox-close");

const plansResults = element<HTMLOListElement>("plans-results");
const tabHistorical = element<HTMLButtonElement>("tab-historical");
const tabUpcoming = element<HTMLButtonElement>("tab-upcoming");
const panelHistorical = element<HTMLElement>("panel-historical");
const panelUpcoming = element<HTMLElement>("panel-upcoming");
const daysAhead = element<HTMLSelectElement>("days-ahead");
const upcomingMission = element<HTMLSelectElement>("upcoming-mission");
const upcomingTimeline = element<HTMLElement>("upcoming-timeline");
const upcomingStatus = element<HTMLElement>("upcoming-status");
const viewHistorical = element<HTMLElement>("view-historical");
const viewUpcoming = element<HTMLElement>("view-upcoming");
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
        link.textContent = "View source metadata";
        link.append(icon("fa-arrow-up-right-from-square"));
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
const SPLIT_PALETTE = ["#e0ae54","#6fb3d2","#b98ad6","#4fbf7a","#d98a6a","#9aa0a2","#c0d76a","#7f8cff","#e58fb0","#7ad1c0"];
function fitToDay(day:string):void {
  const boxes = loadedScenes
    .filter((scene) => scene.acquiredAt.slice(0, 10) === day && Array.isArray(scene.bbox) && scene.bbox.length === 4)
    .map((scene) => scene.bbox as number[]);
  if (!boxes.length) return;
  let west = 180, south = 90, east = -180, north = -90;
  for (const [w, s, e, n] of boxes) { west = Math.min(west, w); south = Math.min(south, s); east = Math.max(east, e); north = Math.max(north, n); }
  try { map.fitBounds([[west, south], [east, north]], { padding: 60, maxZoom: 12 }); } catch { /* degenerate bounds */ }
}
function selectTimelineDay(day:string):void {
  selectedDay = day;
  displayedLimit = 40;
  redrawAvailability();
  renderLoadedScenes();
  fitToDay(day);
  storeSearchLink();
}
function drawDateAxis(svg:SVGElement, NS:string, first:number, nDays:number, dayMs:number, colW:number, padL:number, height:number, padB:number):void {
  const labelIndices = new Set<number>([0, nDays - 1]);
  for (let k = 1; k <= 3; k++) labelIndices.add(Math.round((nDays - 1) * k / 4));
  for (const index of [...labelIndices].sort((a, b) => a - b)) {
    const date = new Date(first + index * dayMs);
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", (padL + index * colW + colW / 2).toFixed(1));
    label.setAttribute("y", String(height - padB - 2));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "tick");
    label.textContent = date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
    svg.append(label);
  }
}
function renderTimeline(): void {
  const scenes = loadedScenes.filter(passesFilters);
  timeline.replaceChildren();
  if (!scenes.length) {
    const empty = document.createElement("figcaption");
    empty.textContent = "No loaded observations match the current filters.";
    timeline.append(empty);
    return;
  }
  renderTimelineBars(timeline, scenes, "cloud", "Cloud cover");
  renderTimelineBars(timeline, scenes, "mission", "Mission");
  renderTimelineBars(timeline, scenes, "provider", "Provider");
  renderTimelineHeat(timeline, scenes, "Time of day (UTC)");
}
function renderTimelineBars(container:HTMLElement, scenes:Scene[], mode:"cloud"|"mission"|"provider", title:string, opts:{keyOf?:(s:Scene)=>string; colourOf?:(k:string)=>string; interactive?:boolean} = {}): void {
  const NS = "http://www.w3.org/2000/svg";
  const width = Math.max(240, container.clientWidth || 320);
  const height = 72, padL = 28, padR = 8, padT = 6, padB = 4;
  const W = width - padL - padR, H = height - padT - padB, dayMs = 86400000;
  const byDay = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  for (const scene of scenes) {
    const day = scene.acquiredAt.slice(0, 10);
    const key = opts.keyOf ? opts.keyOf(scene) : mode === "mission" ? (scene.mission || "unknown") : mode === "provider" ? scene.providerId : cloudClassOf(scene.cloudCoverPercent);
    const m = byDay.get(day) ?? new Map<string, number>();
    m.set(key, (m.get(key) ?? 0) + 1);
    byDay.set(day, m);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const order = [...totals.keys()].sort((a, b) => (totals.get(b)! - totals.get(a)!));
  const days = [...byDay.keys()].sort();
  const first = Date.parse(days[0] + "T00:00:00Z");
  const last = Date.parse(days[days.length - 1] + "T00:00:00Z");
  const nDays = Math.max(1, Math.round((last - first) / dayMs) + 1);
  const colW = W / nDays;
  const maxCount = Math.max(...[...byDay.values()].map((m) => [...m.values()].reduce((a, b) => a + b, 0)));
  const colourOf = (key:string):string => opts.colourOf ? opts.colourOf(key) :
    mode === "cloud" ? (CLOUD_FILL[key as CloudClass] ?? "#9aa0a2") : SPLIT_PALETTE[order.indexOf(key) % SPLIT_PALETTE.length];
  const caption = document.createElement("div");
  caption.className = "timeline-caption";
  caption.textContent = title + " · " + order.slice(0, 5).join(", ") + (order.length > 5 ? "…" : "");
  container.append(caption);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", title + " by day");
  const axis = document.createElementNS(NS, "line");
  axis.setAttribute("x1", String(padL)); axis.setAttribute("x2", String(padL + W));
  axis.setAttribute("y1", String(padT + H)); axis.setAttribute("y2", String(padT + H)); axis.setAttribute("class", "axis");
  svg.append(axis);
  for (const day of days) {
    const m = byDay.get(day)!;
    const index = Math.round((Date.parse(day + "T00:00:00Z") - first) / dayMs);
    const x = padL + index * colW;
    const group = document.createElementNS(NS, "g");
    group.setAttribute("class", "bar-group"); group.setAttribute("data-day", day);
    let baseline = padT + H;
    for (const key of order) {
      const n = m.get(key) ?? 0;
      if (!n) continue;
      const h = (n / maxCount) * H;
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", (x + colW * 0.15).toFixed(1));
      rect.setAttribute("width", Math.max(1, colW * 0.7).toFixed(1));
      rect.setAttribute("y", (baseline - h).toFixed(1));
      rect.setAttribute("height", h.toFixed(1));
      rect.setAttribute("fill", colourOf(key));
      group.append(rect);
      baseline -= h;
    }
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const tip = document.createElementNS(NS, "title");
    tip.textContent = `${day} · ${total} obs · ` + [...m.entries()].map(([k, v]) => `${k} ${v}`).join(", ");
    group.append(tip);
    if (opts.interactive !== false) group.addEventListener("click", () => selectTimelineDay(day));
    svg.append(group);
  }
  drawDateAxis(svg, NS, first, nDays, dayMs, colW, padL, height, padB);
  container.append(svg);
}
function renderTimelineHeat(container:HTMLElement, scenes:Scene[], title:string): void {
  const NS = "http://www.w3.org/2000/svg";
  const width = Math.max(240, container.clientWidth || 320);
  const height = 72, padL = 28, padR = 8, padT = 6, padB = 4;
  const W = width - padL - padR, H = height - padT - padB, dayMs = 86400000, rows = 4;
  const cells = new Map<string, number>();
  const daySet = new Set<string>();
  for (const scene of scenes) {
    const day = scene.acquiredAt.slice(0, 10);
    const row = Math.min(rows - 1, Math.floor(new Date(scene.acquiredAt).getUTCHours() / 6));
    const key = day + "|" + row;
    cells.set(key, (cells.get(key) ?? 0) + 1);
    daySet.add(day);
  }
  const days = [...daySet].sort();
  const first = Date.parse(days[0] + "T00:00:00Z");
  const last = Date.parse(days[days.length - 1] + "T00:00:00Z");
  const nDays = Math.max(1, Math.round((last - first) / dayMs) + 1);
  const colW = W / nDays, rowH = H / rows;
  const maxCell = Math.max(...[...cells.values()]);
  const caption = document.createElement("div");
  caption.className = "timeline-caption";
  caption.textContent = title + " · 00–06 / 06–12 / 12–18 / 18–24 (bottom → top)";
  container.append(caption);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", title + " heatmap by day");
  for (const day of days) {
    const index = Math.round((Date.parse(day + "T00:00:00Z") - first) / dayMs);
    const x = padL + index * colW;
    for (let row = 0; row < rows; row++) {
      const n = cells.get(day + "|" + row) ?? 0;
      if (!n) continue;
      const y = padT + (rows - 1 - row) * rowH;
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("class", "heat-cell");
      rect.setAttribute("x", x.toFixed(1)); rect.setAttribute("y", y.toFixed(1));
      rect.setAttribute("width", Math.max(1, colW).toFixed(1)); rect.setAttribute("height", rowH.toFixed(1));
      rect.setAttribute("fill", `rgba(224,174,84,${(0.15 + 0.85 * (n / maxCell)).toFixed(2)})`);
      svg.append(rect);
    }
    const hit = document.createElementNS(NS, "rect");
    hit.setAttribute("class", "bar-group"); hit.setAttribute("data-day", day);
    hit.setAttribute("x", x.toFixed(1)); hit.setAttribute("y", String(padT));
    hit.setAttribute("width", Math.max(1, colW).toFixed(1)); hit.setAttribute("height", H.toFixed(1));
    hit.setAttribute("fill", "transparent");
    const tip = document.createElementNS(NS, "title"); tip.textContent = day; hit.append(tip);
    hit.addEventListener("click", () => selectTimelineDay(day));
    svg.append(hit);
  }
  const axis = document.createElementNS(NS, "line");
  axis.setAttribute("x1", String(padL)); axis.setAttribute("x2", String(padL + W));
  axis.setAttribute("y1", String(padT + H)); axis.setAttribute("y2", String(padT + H)); axis.setAttribute("class", "axis");
  svg.append(axis);
  drawDateAxis(svg, NS, first, nDays, dayMs, colW, padL, height, padB);
  container.append(svg);
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
    const previous=shiftMonth(today.slice(0,7),-1);
    from.value=previous+"-01";
    to.value=monthDates(previous).to;
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
    queueMicrotask(()=>void runSearch());
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
  renderTimeline();
}
function redrawAvailability():void {
  const full=currentSummary;
  if(!full) return;
  const summary=summaryFromScenes(loadedScenes.filter(passesFilters));
  const filtering=hasActiveFilters();
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
    summary.uniqueItems+" "+(filtering?"filtered ":"")+"published items from "+full.pagesScanned+" catalogue page(s)",
  ];
  if(!full.complete)statusParts.push("Additional pages may exist. Counts are partial.");
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
  void runSearch();
}
prevMonth.addEventListener("click",()=>searchMonth(shiftMonth(calendarMonth.value,-1)));
nextMonth.addEventListener("click",()=>searchMonth(shiftMonth(calendarMonth.value,1)));
calendarMonth.addEventListener("change",()=>{
  if(calendarMonth.value)searchMonth(calendarMonth.value);
});

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

form.addEventListener("submit",(event)=>{
  event.preventDefault();
  void runSearch();
});
async function runSearch():Promise<void>{
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
  updateFilterChoices();
  calendarGrid.replaceChildren();
  monthStrip.replaceChildren();
  counter.textContent="—";
  loadNextPagesButton.hidden=true;
  status.textContent="Searching public satellite catalogues…";
  calendarStatus.textContent="Loading UTC acquisition dates…";
  currentPlanSearch++;
  plansResults.replaceChildren();
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
  await scanNextBatch(session);
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
function renderDatatakeGantt(container:HTMLElement, items:AcquisitionOpportunity[], title:string):void {
  const NS="http://www.w3.org/2000/svg";
  const caption=document.createElement("div");
  caption.className="timeline-caption";
  if(!items.length){ caption.textContent=title+" · no planned datatakes"; container.append(caption); return; }
  const withEnd=items.filter(i=>i.endAt && Date.parse(i.endAt)>Date.parse(i.expectedAt)).length;
  caption.textContent=title+(withEnd<items.length?" · "+(items.length-withEnd)+" without an end time shown as a tick":"");
  container.append(caption);
  const width=Math.max(240, container.clientWidth || 320);
  const missions=[...new Set(items.map(i=>i.mission||"unknown"))].sort();
  const rowH=18, padL=28, padR=8, padT=6, padB=16;
  const height=padT+missions.length*rowH+padB, W=width-padL-padR;
  const startOf=(i:AcquisitionOpportunity)=>Date.parse(i.expectedAt);
  const endOf=(i:AcquisitionOpportunity)=>i.endAt?Math.max(Date.parse(i.endAt),startOf(i)):startOf(i)+1800000;
  const first=Math.min(...items.map(startOf)), last=Math.max(...items.map(endOf));
  const span=Math.max(1,last-first);
  const xOf=(t:number)=>padL+((t-first)/span)*W;
  const svg=document.createElementNS(NS,"svg");
  svg.setAttribute("viewBox",`0 0 ${width} ${height}`);
  svg.setAttribute("role","img");
  svg.setAttribute("aria-label",title);
  missions.forEach((mission,row)=>{
    const y=padT+row*rowH;
    for(const item of items){
      if((item.mission||"unknown")!==mission) continue;
      const x1=xOf(startOf(item)), x2=xOf(endOf(item));
      const rect=document.createElementNS(NS,"rect");
      rect.setAttribute("class","gantt-bar");
      rect.setAttribute("x",x1.toFixed(1));
      rect.setAttribute("y",(y+3).toFixed(1));
      rect.setAttribute("width",Math.max(2,x2-x1).toFixed(1));
      rect.setAttribute("height",(rowH-6).toFixed(1));
      rect.setAttribute("fill",SPLIT_PALETTE[missions.indexOf(mission)%SPLIT_PALETTE.length]);
      const tip=document.createElementNS(NS,"title");
      tip.textContent=mission+" · "+new Date(startOf(item)).toISOString().slice(0,16).replace("T"," ")+"Z"+(item.mode?" · "+item.mode:"")+(item.orbitRelative!=null?" · orbit "+item.orbitRelative:"");
      rect.append(tip);
      svg.append(rect);
    }
    const label=document.createElementNS(NS,"text");
    label.setAttribute("x",String(padL-4));
    label.setAttribute("y",(y+rowH/2+3).toFixed(1));
    label.setAttribute("text-anchor","end");
    label.setAttribute("class","tick");
    label.textContent=mission;
    svg.append(label);
  });
  const axis=document.createElementNS(NS,"line");
  axis.setAttribute("x1",String(padL)); axis.setAttribute("x2",String(padL+W));
  axis.setAttribute("y1",String(height-padB)); axis.setAttribute("y2",String(height-padB));
  axis.setAttribute("class","axis");
  svg.append(axis);
  for(let k=0;k<=3;k++){
    const t=first+(span*k)/3;
    const label=document.createElementNS(NS,"text");
    label.setAttribute("x",xOf(t).toFixed(1));
    label.setAttribute("y",String(height-3));
    label.setAttribute("text-anchor",k===0?"start":k===3?"end":"middle");
    label.setAttribute("class","tick");
    label.textContent=new Date(t).toLocaleString(undefined,{month:"short",day:"numeric",hour:"2-digit",timeZone:"UTC"});
    svg.append(label);
  }
  container.append(svg);
}
function renderPublishedVsPlanned(container:HTMLElement, published:Scene[], planned:PlannedScene[], title:string):void {
  if(!published.length || !planned.length) return;
  const combined:Scene[] = [
    ...published.map((s)=>({ ...s, __kind:"published" } as Scene)),
    ...planned.map((s)=>({ ...s, __kind:"planned" } as Scene)),
  ];
  renderTimelineBars(container, combined, "mission", title, {
    keyOf:(s)=>String((s as Scene & { __kind?:string }).__kind ?? "other"),
    colourOf:(k)=>k==="published" ? "#6fa8dc" : k==="planned" ? "#e2ae54" : "#9aa0a2",
    interactive:false,
  });
}
function renderUpcomingCharts(items:AcquisitionOpportunity[]):void {
  upcomingTimeline.replaceChildren();
  if(!items.length){ const empty=document.createElement("figcaption"); empty.textContent="No planned datatakes to plot."; upcomingTimeline.append(empty); return; }
  const scenes=plannedAsScenes(items);
  renderPublishedVsPlanned(upcomingTimeline, loadedScenes, scenes, "Published so far vs planned");
  renderTimelineBars(upcomingTimeline, scenes, "mission", "Mission");
  renderTimelineBars(upcomingTimeline, scenes, "mission", "Acquisition mode", { keyOf:(s)=>(s as PlannedScene).mode ?? "unknown" });
  renderTimelineBars(upcomingTimeline, scenes, "mission", "Relative orbit", { keyOf:(s)=>(s as PlannedScene).orbitRelative!=null ? "orbit "+(s as PlannedScene).orbitRelative : "unknown" });
  renderDatatakeGantt(upcomingTimeline, items, "Datatake windows (UTC)");
  renderTimelineHeat(upcomingTimeline, scenes, "Time of day (UTC)");
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
    renderUpcomingCharts(filtered);
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
  viewHistorical.hidden = tab!=="historical";
  viewUpcoming.hidden = tab!=="upcoming";
  results.hidden = tab!=="historical";
  plansResults.hidden = tab!=="upcoming";
  if(tab!=="historical") showMoreButton.hidden=true;
  obsTitle.textContent = tab==="upcoming" ? "Upcoming planned acquisitions" : "Published observations";
  if(tab==="upcoming") void runUpcoming();
  else counter.textContent = counter.textContent;
}
tabHistorical.addEventListener("click",()=>setTab("historical"));
tabUpcoming.addEventListener("click",()=>setTab("upcoming"));
let upcomingTimer=0;
function scheduleUpcoming():void{ window.clearTimeout(upcomingTimer); upcomingTimer=window.setTimeout(()=>void runUpcoming(),350); }
for(const el of [daysAhead,upcomingMission]) el.addEventListener("change",scheduleUpcoming);
