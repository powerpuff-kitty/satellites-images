// Opt-in anonymous commercial preview check. No credentials, imagery orders or GeoTIFF downloads.
// node tools/smoke/commercial-previews.mjs [--out REPORT.json]
import { maxarOpenData } from "../../packages/typescript/dist/index.js";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--out")) {
  throw new Error("Usage: node tools/smoke/commercial-previews.mjs [--out REPORT.json]");
}
const cases = [
  {
    name: "Screenshot location, full 2026",
    latitude: -8.48823, longitude: 116.10846, radiusMeters: 5000,
    from: "2026-01-01", to: "2026-12-31",
  },
  {
    name: "Known Maui release, full 2023",
    latitude: 20.88, longitude: -156.68, radiusMeters: 1000,
    from: "2023-01-01", to: "2023-12-31",
  },
];
const report = {
  checkedAt: new Date().toISOString(),
  scope: "Anonymous Maxar public-release preview discovery; no credentials or GeoTIFF downloads",
  results: [],
};

for (const scenario of cases) {
  let requests = 0;
  const started = Date.now();
  const provider = maxarOpenData({
    fetchImpl: async (href, init) => { requests++; return fetch(href, init); },
  });
  const result = {
    ...scenario, metadataRequests: 0, pages: 0, observations: 0, complete: false,
    previewCandidates: [], previewFetches: [], rasterAssets: 0,
  };
  try {
    const seen = new Set();
    for await (const page of provider.search({ ...scenario, limit: 100, maxPages: 50 })) {
      result.pages++;
      result.observations += page.items.length;
      result.complete = !page.hasNext;
      for (const scene of page.items) {
        for (const asset of scene.assets) {
          if (asset.type?.includes("tiff")) result.rasterAssets++;
          const image = asset.type
            ? /^image\/(jpeg|png|webp|avif|gif)(;|$)/i.test(asset.type)
            : /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i.test(asset.href);
          if (/^https:\/\//i.test(asset.href) && image && !seen.has(asset.href)) {
            seen.add(asset.href);
            result.previewCandidates.push(asset.href);
          }
        }
      }
    }
    for (const href of result.previewCandidates) {
      try {
        const response = await fetch(href, {
          redirect: "error", credentials: "omit", signal: AbortSignal.timeout(15000),
          headers: { Range: "bytes=0-1023" },
        });
        const reader = response.body?.getReader();
        const sample = reader ? await reader.read() : null;
        await reader?.cancel();
        reader?.releaseLock();
        result.previewFetches.push({
          url: href, status: response.status, type: response.headers.get("content-type"),
          sampledBytes: sample?.value?.byteLength ?? 0,
        });
      } catch (error) {
        result.previewFetches.push({ url: href, error: String(error) });
      }
    }
  } catch (error) {
    result.error = String(error);
    process.exitCode = 1;
  }
  result.metadataRequests = requests;
  result.elapsedMs = Date.now() - started;
  report.results.push(result);
  console.log(JSON.stringify(result));
}
if (args.length) writeFileSync(args[1], JSON.stringify(report, null, 2) + "\n");
