import { performance } from "node:perf_hooks";
import { polygonBoxes, coveragePercent, normalizeJaxaFeature, normalizeAsfFeature, summarizeAvailability }
  from "../../packages/typescript/dist/index.js";

function bench(name, iterations, fn) {
  for (let i = 0; i < Math.max(1, iterations / 10); i++) fn(i);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn(i);
  const ms = performance.now() - start;
  console.log(`${name.padEnd(34)} ${String(iterations).padStart(8)} ops  ${ms.toFixed(1).padStart(9)} ms  ${(iterations / (ms / 1000)).toFixed(0).padStart(11)} ops/s`);
}

const polygon = { type:"Polygon", coordinates:[[[116.0,-8.7],[116.3,-8.7],[116.3,-8.4],[116.0,-8.4],[116.0,-8.7]]] };
const antimeridian = { type:"Polygon", coordinates:[[[179.9,-1],[-179.9,-1],[-179.9,1],[179.9,1],[179.9,-1]]] };
const boxes = polygonBoxes(polygon);

bench("polygonBoxes", 100000, () => polygonBoxes(polygon));
bench("polygonBoxes(antimeridian)", 100000, () => polygonBoxes(antimeridian));
bench("coveragePercent", 100000, () => coveragePercent([116.1,-8.6,116.2,-8.5], boxes));

function scene(id, date) {
  return { providerId:"earth-search", id, collection:"sentinel-2-l2a", acquiredAt:date, mission:"sentinel-2a",
    geometry:null, bbox:null, cloudCoverPercent:null, coveragePercent:null, previewUrl:null,
    access:"unknown", assets:[], sourceUrl:null, raw:{} };
}
const pages = [];
for (let p = 0; p < 50; p++) {
  const items = [];
  for (let i = 0; i < 100; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    items.push(scene(`p${p}-${i}`, `2025-03-${day}T02:00:00.000Z`));
  }
  pages.push({ providerId:"earth-search", pageNumber:p + 1, hasNext:p < 49, matched:null, items });
}
bench("summarizeAvailability 50x100", 200, () => summarizeAvailability(pages));

const jaxaFeature = { type:"Feature", geometry:{ type:"Polygon", coordinates:[[[140.88,46.45],[141.0,46.5],[140.9,46.6],[140.88,46.45]]] },
  properties:{ identifier:"GC1SG1_x", beginPosition:"2021-07-07T00:07:08.58Z", platformShortName:"GCOM-C",
    product:{ fileName:"https://gportal.jaxa.jp/x.h5" }, browse:[{ fileName:"https://gportal.jaxa.jp/x.jpg" }],
    gpp:{ cloudCoverPercentage:"6" } } };
const asfFeature = { type:"Feature", geometry:{ type:"Point", coordinates:[116.1,-8.6] },
  properties:{ granuleName:"S1A_x", startTime:"2025-01-10T02:00:00Z", platform:"Sentinel-1",
    browse:["https://example.test/b.png"], downloadUrl:"https://x/y.zip" } };
bench("normalizeJaxaFeature", 100000, () => normalizeJaxaFeature(jaxaFeature));
bench("normalizeAsfFeature", 100000, () => normalizeAsfFeature(asfFeature));
