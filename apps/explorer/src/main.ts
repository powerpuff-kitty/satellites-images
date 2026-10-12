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

const plansButton = element<HTMLButtonElement>("plans-button");
const plansStatus = element<HTMLElement>("plans-status");
const plansResults = element<HTMLOListElement>("plans-results");

// In Vite development, /esa-proxy is served by a restricted HTTPS reverse proxy.
// For deployed static applications set VITE_ESA_PROXY_URL to the optional Cloudflare Worker.
// No arbitrary destination URLs or API credentials are ever accepted by the proxy.
const esaProxy = import.meta.env.VITE_ESA_PROXY_URL ??
  (import.meta.env.DEV ? "/esa-proxy" : "");

function esaFetch(url: RequestInfo | URL, options?: RequestInit): Promise<Response> {
  const original = new URL(String(url));
  if (original.origin !== "https://sentinels.copernicus.eu") {
    throw new Error("ESA adapter attempted to fetch an unexpected origin");
  }
  const proxied = esaProxy ?
    esaProxy.replace(/\/$/,"") + original.pathname : original.toString();
  return fetch(proxied, options);
}


const map = new maplibregl.Map({
  container: "map",
  style: "https://demotiles.maplibre.org/style.json",
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
  time.textContent = new Date(scene.acquiredAt).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"});
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

let currentSearch = 0;
let currentController:AbortController|null=null;
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
    selectedDay=restoredDay;
    activeMonth=restoredDay.slice(0,7);
    calendarMonth.value=activeMonth;
  }
  marker.setLngLat([Number(lon.value),Number(lat.value)]);
  map.jumpTo({center:[Number(lon.value),Number(lat.value)]});
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
function renderLoadedScenes():void {
  const visible=selectedDay
    ? loadedScenes.filter(scene=>scene.acquiredAt.slice(0,10)===selectedDay)
    : loadedScenes;
  const selected=visible.slice(0,displayedLimit);
  const fragment=document.createDocumentFragment();
  for(const scene of selected)fragment.append(makeScene(scene));
  results.replaceChildren(fragment);
  counter.textContent=String(visible.length)+(selectedDay?" / "+loadedScenes.length:"");
  showMoreButton.hidden=visible.length<=displayedLimit;
  if(selectedDay)highlightScene(visible[0]);
  else highlightScene(undefined);
}
function redrawAvailability():void {
  const summary=currentSummary;
  if(!summary) return;
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
    summary.uniqueItems+" unique published items from "+summary.pagesScanned+" catalogue page(s)",
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

form.addEventListener("submit",async(event)=>{
  event.preventDefault();
  currentController?.abort();
  const controller=new AbortController();
  currentController=controller;
  const token=++currentSearch;
  const accumulator=new AvailabilityAccumulator();
  currentSummary=null;
  loadedScenes=[];
  searchErrored=false;
  selectedDay=null;
  displayedLimit=40;
  activeMonth=to.value.slice(0,7);
  calendarMonth.value=activeMonth;
  results.replaceChildren();
  calendarGrid.replaceChildren();
  monthStrip.replaceChildren();
  counter.textContent="—";
  button.disabled=true;
  status.textContent="Searching public satellite catalogues…";
  calendarStatus.textContent="Loading satellite acquisition dates…";
  // Planned footprints belong to a separate search; clear stale old-area results.
  currentPlanSearch++;
  plansButton.disabled=false;
  plansResults.replaceChildren();
  plansStatus.textContent="Check future acquisitions for this location.";
  displaySwaths([]);
  try {
    const selected=provider.value==="planetary-computer"?planetaryComputer():earthSearch();
    const catalog=new SatelliteCatalog([selected]);
    const query={
      latitude:Number(lat.value), longitude:Number(lon.value), radiusMeters:Number(radius.value),
      from:from.value, to:to.value,maxPages:10,limit:75,signal:controller.signal,
    };
    updateLocation(query.latitude,query.longitude,true);
    storeSearchLink();
    for await (const page of catalog.search(query)) {
      if(token!==currentSearch || controller.signal.aborted)break;
      const novel=accumulator.addPage(page);
      loadedScenes.push(...novel);
      loadedScenes.sort((a,b)=>b.acquiredAt.localeCompare(a.acquiredAt)||a.id.localeCompare(b.id));
      currentSummary=accumulator.summary();
      redrawAvailability();
      renderLoadedScenes();
      status.textContent="Scanned "+currentSummary.pagesScanned+" page(s), "+
        currentSummary.uniqueItems+" unique observations loaded…";
    }
    if(token!==currentSearch||controller.signal.aborted)return;
    const summary=accumulator.summary();
    currentSummary=summary;
    redrawAvailability();
    status.textContent=summary.uniqueItems===0
      ? "No matching scenes returned in this query window (not a claim about other archives)."
      : summary.complete
        ? summary.uniqueItems+" unique scenes returned; provider pagination exhausted for this search window."
        : summary.uniqueItems+" unique scenes loaded. More provider pages exist; narrow to a month for more coverage.";
  }catch(error){
    if(token!==currentSearch||controller.signal.aborted)return;
    searchErrored=true;
    currentSummary=accumulator.summary();
    redrawAvailability();
    status.textContent="Catalogue search failed: "+(error instanceof Error?error.message:String(error))+
      (loadedScenes.length?" Previously loaded scenes may be incomplete.":"");
  }finally{
    if(token===currentSearch)button.disabled=false;
  }
});
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
  const link = document.createElement("a");
  link.href = item.sourceUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Official ESA plan ↗";
  li.append(link);
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
      esaSentinelPlans({fetchImpl:esaFetch}),
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
