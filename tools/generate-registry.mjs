import { readFile, mkdir, writeFile } from "node:fs/promises";

const registry = JSON.parse(await readFile(new URL("../sources/registry.json", import.meta.url), "utf8"));
if (registry.schemaVersion !== "1.0.0" || !Array.isArray(registry.sources)) {
  throw new Error("Invalid registry schema");
}
const ids = new Set();
for (const source of registry.sources) {
  if (!source.id || ids.has(source.id) || !source.docs?.startsWith("https://")) {
    throw new Error("Invalid or duplicate source: " + source.id);
  }
  ids.add(source.id);
  if (source.operatorType !== undefined && !["commercial", "public", "mixed"].includes(source.operatorType)) {
    throw new Error("Invalid satellite operator type: " + source.id);
  }
}
const paths = [
  new URL("../packages/python/src/satellites_images/sources.json", import.meta.url),
  new URL("../crates/satellites-images/src/sources.json", import.meta.url),
  new URL("../packages/typescript/src/sources.json", import.meta.url),
];
const data = JSON.stringify(registry, null, 2) + "\n";
for (const dest of paths) {
  await mkdir(new URL(".", dest), { recursive: true });
  await writeFile(dest, data, "utf8");
}
console.log("Generated registry snapshots for 3 SDKs");
