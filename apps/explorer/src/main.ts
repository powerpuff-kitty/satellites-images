import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { SatelliteCatalog, earthSearch, planetaryComputer, type Scene } from "@powerpuff-kitty/satellites-images";

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

const map = new maplibregl.Map({
  container: "map",
  style: "https://demotiles.maplibre.org/style.json",
  center: [116.1167, -8.5833],
  zoom: 8,
  attributionControl: true,
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
form.addEventListener("submit",async(event)=>{
  event.preventDefault();
  currentSearch += 1;
  const token = currentSearch;
  results.replaceChildren();
  counter.textContent = "—";
  button.disabled = true;
  status.textContent = "Searching public satellite catalogues…";
  try {
    const selected = provider.value === "planetary-computer" ? planetaryComputer() : earthSearch();
    const catalog = new SatelliteCatalog([selected]);
    const query = {
      latitude: Number(lat.value), longitude: Number(lon.value), radiusMeters: Number(radius.value),
      from: from.value, to: to.value, maxPages: 2, limit: 30,
    };
    updateLocation(query.latitude,query.longitude,true);
    let count = 0;
    for await (const page of catalog.search(query)) {
      if(token!==currentSearch) break;
      const fragment = document.createDocumentFragment();
      for (const scene of page.items) fragment.append(makeScene(scene));
      results.append(fragment);
      count += page.items.length;
      counter.textContent = String(count);
      status.textContent = page.hasNext && page.pageNumber >= query.maxPages
        ? "Showing first "+count+" matching scenes (search limited to "+query.maxPages+" pages)."
        : count+" published scene"+(count===1?"":"s")+" found in loaded pages.";
    }
    if (count === 0 && token === currentSearch) status.textContent = "No scenes returned for that area and period. Try a wider time range.";
  } catch (error) {
    if (token === currentSearch) status.textContent = "Catalogue search failed: " + (error instanceof Error ? error.message : String(error));
  } finally {
    if(token === currentSearch) button.disabled = false;
  }
});
