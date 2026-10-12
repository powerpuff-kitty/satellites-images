import maplibregl from "maplibre-gl";
import type { FeatureCollection, Geometry } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { SatelliteCatalog, earthSearch, planetaryComputer, esaSentinelPlans, availabilitySummary,
  type Scene, type SearchPage, type AcquisitionOpportunity } from "@powerpuff-kitty/satellites-images";

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

const monthLabel = element<HTMLElement>("month-label");
const monthPrev = element<HTMLButtonElement>("month-prev");
const monthNext = element<HTMLButtonElement>("month-next");
const calendar = element<HTMLElement>("calendar");
const calendarStatus = element<HTMLElement>("calendar-status");
const missionFilter = element<HTMLSelectElement>("mission-filter");
const selectedDay = element<HTMLInputElement>("selected-day");
const scanMore = element<HTMLButtonElement>("scan-more");
const scanStatus = element<HTMLElement>("scan-status");
const copyLink = element<HTMLButtonElement>("copy-link");

const plansButton = element<HTMLButtonElement>("plans-button");
const plansStatus = element<HTMLElement>("plans-status");
const plansResults = element<HTMLOListElement>("plans-results");

const PAGE_STEP = 5;
const PAGE_CAP = 50;
const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

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
  if (fly && !reduceMotion) map.flyTo({center:[longitude,latitude], zoom:Math.max(map.getZoom(), 8)});
}
map.on("click", (e) => {
  state.latitude = e.lngLat.lat;
  state.longitude = e.lngLat.lng;
  updateLocation(state.latitude, state.longitude);
  syncUrl();
});
for (const el of [lat,lon]) el.addEventListener("change", () => {
  if (Number.isFinite(lat.valueAsNumber) && Number.isFinite(lon.valueAsNumber)) {
    state.latitude = lat.valueAsNumber;
    state.longitude = lon.valueAsNumber;
    updateLocation(state.latitude, state.longitude, true);
    syncUrl();
  }
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
  if (scene.previewUrl) {
    try {
      const url = new URL(scene.previewUrl);
      if (url.protocol === "https:") {
        const image = document.createElement("img");
        image.src = url.toString();
        image.alt = "Provider preview of satellite scene " + scene.id;
        image.loading = "lazy";
        image.addEventListener("error", () => image.remove());
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

interface State {
  latitude: number; longitude: number; radiusMeters: number;
  provider: string; from: string; to: string;
  day: string | null; mission: string;
}
const state: State = {
  latitude: -8.5833, longitude: 116.1167, radiusMeters: 5000,
  provider: "earth-search", from: "2025-01-01", to: "2025-03-31",
  day: null, mission: "all",
};

let pages: SearchPage[] = [];
let iterator: AsyncIterator<SearchPage> | null = null;
let searchToken = 0;
let reachedEnd = false;
let scanning = false;
let scanError: string | null = null;

function catalog(): SatelliteCatalog {
  const selected = state.provider === "planetary-computer" ? planetaryComputer() : earthSearch();
  return new SatelliteCatalog([selected]);
}
function flatten(): Scene[] {
  const seen = new Set<string>();
  const output: Scene[] = [];
  for (const page of pages) for (const scene of page.items) {
    const key = page.providerId + ":" + scene.id;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(scene);
  }
  return output;
}
function visibleScenes(all: Scene[]): Scene[] {
  return all.filter((scene) =>
    (state.day === null || scene.acquiredAt.slice(0,10) === state.day) &&
    (state.mission === "all" || scene.mission === state.mission));
}

function updateMissions(all: Scene[]): void {
  const missions = [...new Set(all.map((s) => s.mission).filter((m): m is string => Boolean(m)))].sort();
  const current = state.mission;
  missionFilter.replaceChildren();
  const any = document.createElement("option");
  any.value = "all";
  any.textContent = "All missions";
  missionFilter.append(any);
  for (const mission of missions) {
    const option = document.createElement("option");
    option.value = mission;
    option.textContent = mission;
    missionFilter.append(option);
  }
  missionFilter.value = missions.includes(current) ? current : "all";
  if (missionFilter.value !== current) state.mission = missionFilter.value;
}

function renderCalendar(): void {
  const summary = availabilitySummary(pages);
  const month = state.from.slice(0,7);
  const [year, monthIndex] = month.split("-").map(Number);
  monthLabel.textContent = new Date(Date.UTC(year, monthIndex - 1, 1))
    .toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  const counts = new Map(summary.days.map((day) => [day.date, day.count]));
  const daysInMonth = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, monthIndex - 1, 1)).getUTCDay();
  calendar.replaceChildren();
  for (const label of ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]) {
    const head = document.createElement("div");
    head.className = "calendar-head";
    head.setAttribute("role", "columnheader");
    head.textContent = label;
    calendar.append(head);
  }
  for (let i = 0; i < firstWeekday; i++) {
    const blank = document.createElement("div");
    blank.className = "calendar-blank";
    calendar.append(blank);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const date = month + "-" + String(day).padStart(2, "0");
    const count = counts.get(date) ?? 0;
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "calendar-day" + (count > 0 ? " has-data" : "");
    cell.dataset.date = date;
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("aria-pressed", String(state.day === date));
    cell.setAttribute("aria-label", date + ": " + count + " scene" + (count === 1 ? "" : "s"));
    cell.textContent = String(day);
    if (count > 0) {
      const badge = document.createElement("span");
      badge.className = "calendar-count";
      badge.textContent = String(count);
      cell.append(badge);
    }
    cell.addEventListener("click", () => selectDay(date));
    calendar.append(cell);
  }
  calendarStatus.textContent = summary.complete
    ? summary.totalScenes + " scene(s) across " + summary.days.length + " day(s) from fully paginated sources."
    : summary.totalScenes + " scene(s) in the loaded pages — search still truncated for " + summary.truncatedProviders.join(", ") + ".";
}

function selectDay(date: string): void {
  state.day = state.day === date ? null : date;
  selectedDay.value = state.day ?? "";
  for (const cell of calendar.querySelectorAll<HTMLButtonElement>(".calendar-day")) {
    cell.setAttribute("aria-pressed", String(cell.dataset.date === state.day));
  }
  renderResults();
  syncUrl();
}

function renderResults(): void {
  const all = flatten();
  const shown = visibleScenes(all);
  results.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const scene of shown) fragment.append(makeScene(scene));
  results.append(fragment);
  counter.textContent = shown.length + (shown.length === all.length ? "" : " / " + all.length);
  if (scanError) {
    status.textContent = scanError;
  } else if (shown.length === 0 && all.length > 0) {
    status.textContent = "No loaded scenes match the selected day" + (state.mission === "all" ? "." : " and mission.");
  } else {
    status.textContent = all.length + " published scene(s) loaded" + (state.day ? " (day " + state.day + ")" : "") + ".";
  }
  updateFootprint(shown);
}

function updateFootprint(scenes: Scene[]): void {
  const features = scenes.flatMap((scene) => scene.geometry
    ? [{ type: "Feature" as const, properties: { id: scene.id }, geometry: scene.geometry as unknown as Geometry }]
    : []);
  const data: FeatureCollection = { type: "FeatureCollection", features };
  const render = () => {
    const existing = map.getSource("scene-footprints") as maplibregl.GeoJSONSource | undefined;
    if (existing) existing.setData(data);
    else {
      map.addSource("scene-footprints", { type: "geojson", data });
      map.addLayer({ id: "scene-footprints-fill", type: "fill", source: "scene-footprints",
        paint: { "fill-color": "#6fb3d2", "fill-opacity": 0.12 } });
      map.addLayer({ id: "scene-footprints-line", type: "line", source: "scene-footprints",
        paint: { "line-color": "#7cc4e6", "line-width": 1.5, "line-opacity": 0.8 } });
    }
  };
  if (map.isStyleLoaded()) render();
  else map.once("load", render);
}

function updateScanControls(): void {
  const atCap = pages.length >= PAGE_CAP;
  scanMore.disabled = scanning || reachedEnd || atCap || iterator === null;
  scanStatus.textContent = reachedEnd
    ? "End of results reached (" + pages.length + " page(s))."
    : atCap
      ? "Page cap of " + PAGE_CAP + " reached."
      : pages.length + " page(s) loaded — scan 5 more to extend the search.";
}

async function scanMorePages(count: number, token: number): Promise<void> {
  if (!iterator) return;
  const active = iterator;
  scanning = true;
  updateScanControls();
  try {
    for (let i = 0; i < count && pages.length < PAGE_CAP; i++) {
      const next = await active.next();
      if (token !== searchToken) return;
      if (next.done) { reachedEnd = true; break; }
      pages.push(next.value);
    }
  } catch (error) {
    if (token === searchToken) {
      scanError = "Catalogue error after " + pages.length + " page(s): " +
        (error instanceof Error ? error.message : String(error)) + ". Showing partial results.";
    }
  } finally {
    // A stale scan must not touch the newer search's status or scan controls.
    if (token === searchToken) {
      scanning = false;
      renderAll();
    }
  }
}

function renderAll(): void {
  const all = flatten();
  updateMissions(all);
  renderCalendar();
  renderResults();
  updateScanControls();
  syncUrl();
}

async function startSearch(): Promise<void> {
  const token = ++searchToken;
  pages = [];
  reachedEnd = false;
  iterator = null;
  scanError = null;
  button.disabled = true;
  scanMore.disabled = true;
  status.textContent = "Searching public satellite catalogues…";
  try {
    iterator = catalog().search({
      latitude: state.latitude, longitude: state.longitude, radiusMeters: state.radiusMeters,
      from: state.from, to: state.to, maxPages: PAGE_CAP, limit: 30,
    })[Symbol.asyncIterator]();
    await scanMorePages(PAGE_STEP, token);
  } finally {
    if (token === searchToken) button.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  state.latitude = Number(lat.value);
  state.longitude = Number(lon.value);
  state.radiusMeters = Number(radius.value);
  state.provider = provider.value;
  state.from = from.value;
  state.to = to.value;
  state.day = null;
  state.mission = "all";
  selectedDay.value = "";
  updateLocation(state.latitude, state.longitude, true);
  void startSearch();
});

scanMore.addEventListener("click", () => { void scanMorePages(PAGE_STEP, searchToken); });

missionFilter.addEventListener("change", () => {
  state.mission = missionFilter.value;
  renderResults();
  syncUrl();
});

function shiftMonth(delta: number): void {
  const [year, month] = state.from.slice(0,7).split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + delta, 1));
  const first = target.toISOString().slice(0,10);
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).toISOString().slice(0,10);
  state.from = first;
  state.to = last;
  state.day = null;
  selectedDay.value = "";
  from.value = first;
  to.value = last;
  void startSearch();
}
monthPrev.addEventListener("click", () => shiftMonth(-1));
monthNext.addEventListener("click", () => shiftMonth(1));

copyLink.addEventListener("click", async () => {
  syncUrl();
  try {
    await navigator.clipboard.writeText(location.href);
    status.textContent = "Shareable link copied to the clipboard.";
  } catch {
    status.textContent = "Copy this URL: " + location.href;
  }
});

function syncUrl(): void {
  const params = new URLSearchParams();
  params.set("lat", state.latitude.toFixed(5));
  params.set("lon", state.longitude.toFixed(5));
  params.set("r", String(state.radiusMeters));
  params.set("provider", state.provider);
  params.set("from", state.from);
  params.set("to", state.to);
  if (state.day) params.set("day", state.day);
  if (state.mission !== "all") params.set("mission", state.mission);
  history.replaceState(null, "", location.pathname + "?" + params.toString());
}
function readUrl(): boolean {
  const params = new URLSearchParams(location.search);
  if (!params.has("lat") || !params.has("lon")) return false;
  const latitude = Number(params.get("lat"));
  const longitude = Number(params.get("lon"));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  state.latitude = latitude;
  state.longitude = longitude;
  const radiusValue = Number(params.get("r"));
  if ([1000,5000,10000,25000].includes(radiusValue)) { state.radiusMeters = radiusValue; radius.value = String(radiusValue); }
  if (params.get("provider") === "planetary-computer") { state.provider = "planetary-computer"; provider.value = "planetary-computer"; }
  if (params.has("from")) { state.from = params.get("from")!; from.value = state.from; }
  if (params.has("to")) { state.to = params.get("to")!; to.value = state.to; }
  state.day = params.get("day");
  state.mission = params.get("mission") ?? "all";
  return true;
}

// --- Planned ESA acquisitions -------------------------------------------------
function makePlanned(item: AcquisitionOpportunity): HTMLLIElement {
  const li = document.createElement("li");
  const heading = document.createElement("div");
  heading.className = "scene-heading";
  const name = document.createElement("strong");
  name.textContent = item.mission + " / planned";
  const time = document.createElement("time");
  time.dateTime = item.expectedAt;
  time.textContent = new Date(item.expectedAt).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"});
  heading.append(name,time);
  li.append(heading);
  if (item.mode) li.append(line("Acquisition mode",item.mode));
  if (typeof item.orbitRelative === "number") li.append(line("Relative orbit",String(item.orbitRelative)));
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

// --- Boot ---------------------------------------------------------------------
if (readUrl()) {
  updateLocation(state.latitude, state.longitude);
  selectedDay.value = state.day ?? "";
  void startSearch();
} else {
  updateScanControls();
}
