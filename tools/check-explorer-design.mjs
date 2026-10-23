import { readFile } from "node:fs/promises";
import { styleViolations } from "@powerpuff-kitty/tcsn-design-system/compliance";

const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");
const manifest = JSON.parse(await read("apps/explorer/package.json"));
if (manifest.dependencies["@powerpuff-kitty/tcsn-design-system"] !== "0.19.0")
  throw new Error("Explorer must pin the verified shared design system 0.19.0");
if (manifest.dependencies["@fortawesome/fontawesome-free"])
  throw new Error(
    "Explorer icons must come from the shared Font Awesome collection",
  );
for (const path of [
  "apps/explorer/src/style.css",
  "apps/explorer/src/shared-ui.css",
]) {
  const violations = styleViolations(await read(path));
  if (violations.length) throw new Error(path + ": " + violations.join("; "));
}
for (const path of ["apps/explorer/index.html", "apps/explorer/src/main.ts"]) {
  if (/icons\.svg|fontawesome-free\/css|fa-solid/.test(await read(path)))
    throw new Error(path + " contains a legacy icon source");
}
const sharedUi = await read("apps/explorer/src/shared-ui.ts");
if (
  !sharedUi.includes("enhanceTabs(main)") ||
  !sharedUi.includes("dataset.tcsnTabs")
)
  throw new Error("Explorer tabs must use the shared tab enhancer and marker");
if (
  /\.tablist\s*\{[^}]*border\s*:\s*0/.test(
    await read("apps/explorer/src/shared-ui.css"),
  )
)
  throw new Error("Explorer must retain the shared tab frame");
console.log(
  "Explorer shared theme, control recipes and Font Awesome sources passed.",
);

if (!sharedUi.includes("enhanceMapLibre(main)"))
  throw new Error(
    "Map controls and chrome must use the shared renderer adapter",
  );
