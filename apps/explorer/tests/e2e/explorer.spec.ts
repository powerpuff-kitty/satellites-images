import { test, expect } from "./offline.js";
import type { Page, Route } from "@playwright/test";

// Every response is intercepted: no live catalogue, map-tile or ESA request is made,
// and no credentials or fixture dates are presented as live data.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
};
const MAP_STYLE = {
  version: 8,
  name: "test",
  // A source attribution so the required-attribution control renders and can be measured.
  sources: { base: { type: "geojson", data: { type: "FeatureCollection", features: [] }, attribution: "Test basemap" } },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#111512" } },
    // An (invisible) layer so MapLibre counts the source's attribution.
    { id: "base-fill", type: "fill", source: "base", paint: { "fill-opacity": 0 } },
  ],
};

async function respond(route: Route, options: { status?: number; json?: unknown; body?: string; contentType?: string }) {
  if (route.request().method() === "OPTIONS") {
    return route.fulfill({ status: 204, headers: CORS });
  }
  const headers = { ...CORS, "content-type": options.contentType ?? "application/json" };
  return route.fulfill({
    status: options.status ?? 200,
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body ?? "",
  });
}

function stacScene(id: string, datetime: string, platform = "sentinel-2a") {
  return {
    type: "Feature",
    id,
    collection: "sentinel-2-l2a",
    geometry: { type: "Polygon", coordinates: [[[116.0, -8.7], [116.3, -8.7], [116.3, -8.4], [116.0, -8.4], [116.0, -8.7]]] },
    bbox: [116.0, -8.7, 116.3, -8.4],
    properties: { datetime, platform, "eo:cloud_cover": 12.5 },
    assets: { thumbnail: { href: "https://example.test/thumb-" + id + ".jpg", roles: ["thumbnail"], type: "image/jpeg" } },
    links: [{ rel: "self", href: "https://example.test/items/" + id }],
  };
}
const nextLink = (token: string, href = "https://earth-search.aws.element84.com/v1/search") => ({
  rel: "next", href, method: "POST", body: { token },
});
const collection = (features: unknown[], links: unknown[], matched: number) =>
  ({ type: "FeatureCollection", features, links, context: { matched } });

/**
 * Turns an auto-selected pixel off, so a test sees the whole loaded year. Nothing to do when the
 * picked day had no observations: that selection is dropped automatically.
 */
async function clearDay(page: Page) {
  // The final provider can remove an empty auto-selected day; wait for the scan to settle.
  await expect(page.locator("#status")).not.toContainText(/^(Searching|Scanned)/);
  const selected = page.locator("#matrix-svg .matrix-cell.selected");
  if (await selected.count() === 0) return;
  await selected.click();
  await expect(selected).toHaveCount(0);
}
/** Loads the year containing `date`; its day is auto-selected unless `keepDay` is set. */
async function setDate(page: Page, date: string, keepDay = false) {
  // Via the permalink so exactly one search runs: filling the control schedules a second,
  // debounced search whose render can land after an assertion.
  await page.goto(`/?lat=-8.58330&lon=116.11670&radius=5000&date=${date}`);
  // The counter leaves its placeholder once results render; a scan that fails may never render,
  // so accept the reported failure as the settled state too.
  await expect.poll(async () => {
    const counter = (await page.locator("#counter").textContent()) ?? "";
    const status = (await page.locator("#status").textContent()) ?? "";
    return counter !== "—" || /failed/i.test(status);
  }).toBe(true);
  if (!keepDay) await clearDay(page);
}

async function chooseOption(page: Page, selector: string, value: string) {
  const native = page.locator(selector);
  const label = await native.evaluate((element, target) => {
    const option = [...(element as HTMLSelectElement).options].find(option => option.value === target);
    if (!option) throw new Error("Missing option " + target);
    return option.label;
  }, value);
  const dropdown = native.locator("..");
  await dropdown.getByRole("combobox").click();
  await dropdown.getByRole("option", { name: label, exact: true }).click();
  await expect(native).toHaveValue(value);
}

test.beforeEach(async ({ page }) => {
  await page.route("https://tiles.openfreemap.org/**", (route) => respond(route, { json: MAP_STYLE }));
});

test("the built app serves the maplibre worker as javascript", async ({ page }) => {
  // maplibre-gl 6 loads its worker from a URL it computes at runtime. If the bundler does
  // not emit that file the preview server answers with the SPA HTML, the worker never
  // starts, and every source silently stops loading tiles.
  const workerResponses: { status: number; type: string }[] = [];
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("response", (response) => {
    if (/maplibre-gl-worker/.test(response.url())) {
      workerResponses.push({ status: response.status(), type: response.headers()["content-type"] ?? "" });
    }
  });
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("w1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await expect(page.locator("#map-matrix")).toBeVisible();
  await expect.poll(() => workerResponses.length).toBeGreaterThan(0);
  for (const response of workerResponses) {
    expect(response.status).toBe(200);
    expect(response.type).not.toContain("text/html");
  }
  expect(errors.filter((text) => /Worker failed to load/i.test(text))).toEqual([]);
});

test("map credits are disclosed in the sidebar and leave the map clear", async ({ page }) => {
  await page.route("**/search", route => respond(route, { json: collection(
    [stacScene("a1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await expect(page.locator("#map-matrix")).toBeVisible();
  await expect(page.locator("#map-container .maplibregl-ctrl-attrib")).toHaveCount(0);
  await expect(page.locator("#map-credits")).toBeHidden();
  await page.getByText("Map credits", { exact: true }).click();
  await expect(page.locator(".panel #map-credits")).toBeVisible();
  await expect(page.locator("#map-credits")).toContainText("Test basemap");
  const boxes = await page.evaluate(() => ({
    credits: document.querySelector("#map-credits")!.getBoundingClientRect().toJSON(),
    panel: document.querySelector(".panel")!.getBoundingClientRect().toJSON(),
  }));
  expect(boxes.credits.left).toBeGreaterThanOrEqual(boxes.panel.left);
  expect(boxes.credits.right).toBeLessThanOrEqual(boxes.panel.right);
});

test("a scene with no tile set still draws its preview via a fetched image", async ({ page }) => {
  // Earth Search Sentinel-2 previews can be read as a plain CORS fetch but fail MapLibre's own
  // image request, so the app fetches the bytes and hands over an object URL. Without that the
  // map showed a caption with no raster.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNg+M8AQhAKABvyA/1tVLjHAAAAAElFTkSuQmCC", "base64");
  const previewRequests: string[] = [];
  await page.route("https://example.test/**", (route) => {
    previewRequests.push(route.request().url());
    return route.fulfill({ contentType: "image/png", body: png });
  });
  // The tile service has not ingested this item, so no tile set can be resolved.
  await page.route("https://planetarycomputer.microsoft.com/**", (route) => respond(route, { json: { type: "FeatureCollection", features: [], links: [] } }));
  const aligned = stacScene("no-tiles", "2025-03-10T02:00:00Z");
  Object.assign(aligned.assets.thumbnail, { "proj:code": "EPSG:4326", "proj:bbox": aligned.bbox,
    "proj:transform": [0.1, 0, 116, 0, -0.1, -8.4] });
  await page.route("**/search", (route) => respond(route, { json: collection([aligned], [], 1) }));
  await page.goto("/?lat=-8.58330&lon=116.11670&radius=5000&from=2025-03-01&to=2025-03-31");
  await clearDay(page);
  await expect(page.locator("#results img")).toHaveCount(1);
  await page.locator("#results img").first().click();
  await expect(page.locator("#map-preview")).toBeVisible();
  await expect(page.locator("#map-container")).toHaveAttribute("data-preview-source", "image");
  expect(previewRequests.length).toBeGreaterThan(0); // the page fetched the bytes itself
  // An open dropdown consumes Escape before the page-level preview shortcut.
  const radiusDropdown = page.locator("#radius").locator("..").getByRole("combobox");
  await radiusDropdown.click();
  await radiusDropdown.press("Escape");
  await expect(radiusDropdown).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#map-preview")).toBeVisible();
  // A second Escape still closes the preview and revokes its overlay.
  await page.keyboard.press("Escape");
  await expect(page.locator("#map-preview")).toBeHidden();
  await expect(page.locator("#map-container")).not.toHaveAttribute("data-preview-source", "image");
});

test("a blocked still preview reports unavailable without an empty raster overlay", async ({ page }) => {
  await page.route("https://example.test/**", route => route.fulfill({ status: 403, body: "forbidden" }));
  await page.route("https://planetarycomputer.microsoft.com/**", (route) => respond(route, { json: { type: "FeatureCollection", features: [], links: [] } }));
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("blocked", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/?lat=-8.58330&lon=116.11670&radius=5000&from=2025-03-01&to=2025-03-31");
  await clearDay(page);
  await expect(page.locator("#results img")).toHaveCount(0);
  await expect(page.locator(".preview-status")).toContainText("Preview unavailable");
  await page.getByRole("button", {name:"View public preview",exact:true}).click();
  await expect(page.locator("#map-preview")).toBeVisible();
  await expect(page.locator("#map-container")).toHaveAttribute("data-preview-source", "unplaced-image");
  await expect(page.locator("#preview-still-status")).toContainText("Public preview unavailable");
});

test("coordinate search builds a calendar and result cards", async ({ page }) => {
  await page.route("**/search", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const index = body.token ? Number(body.token) : 0;
    const features = index === 0 ? [stacScene("s10", "2025-03-10T02:00:00Z")]
      : index === 1 ? [stacScene("s11", "2025-03-11T02:00:00Z")] : [];
    const links = index < 1 ? [nextLink(String(index + 1), route.request().url())] : [];
    await respond(route, { json: collection(features, links, features.length) });
  });
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(2);
  await expect(page.locator("#counter")).toHaveText("2");
  // The availability rollup summarises what was loaded, per catalogue.
  await expect(page.locator("#coverage")).toContainText(/2 observations shown/);
  await expect(page.locator("#coverage")).toContainText(/2 days with data/);
  await expect(page.locator("#coverage")).toContainText(/earth-search/);
  await expect(page.locator("#matrix-svg .matrix-cell.has-scenes")).toHaveCount(2);
});

test("a drawn area is searched as a polygon and can be cleared", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/search", (route) => {
    bodies.push(JSON.parse(route.request().postData() ?? "{}"));
    return respond(route, { json: collection([stacScene("a1", "2025-03-10T02:00:00Z")], [], 1) });
  });
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(1);
  // Draw three corners on the map, then finish.
  await page.locator("#draw-area").click();
  const box = (await page.locator("#map").boundingBox())!;
  await page.mouse.click(box.x + 60, box.y + 60);
  await page.mouse.click(box.x + 140, box.y + 60);
  await page.mouse.click(box.x + 140, box.y + 140);
  await page.locator("#draw-area").click();
  await expect.poll(() => bodies.some((body) => JSON.stringify(body).includes("intersects"))).toBe(true);
  await expect(page.locator("#clear-area")).toBeVisible();
  // Clicking another location replaces the drawn area with that point.
  await page.mouse.click(box.x + 220, box.y + 220);
  await expect(page.locator("#clear-area")).toBeHidden();
  await expect.poll(() => JSON.stringify(bodies.at(-1) ?? {}).includes("bbox")).toBe(true);
  // ...and the explicit control does the same.
  await page.locator("#draw-area").click();
  await page.mouse.click(box.x + 60, box.y + 60);
  await page.mouse.click(box.x + 140, box.y + 60);
  await page.mouse.click(box.x + 140, box.y + 140);
  await page.locator("#draw-area").click();
  await expect(page.locator("#clear-area")).toBeVisible();
  await page.locator("#clear-area").click();
  await expect.poll(() => JSON.stringify(bodies.at(-1) ?? {}).includes("bbox")).toBe(true);
});

test("the matrix keeps its size when switching tabs", async ({ page }) => {
  await page.route("**/acquisition-plans", (route) => respond(route, { contentType: "text/html", body: "<html></html>" }));
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("s1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#map-matrix")).toBeVisible();
  const width = await page.locator("#matrix-svg").getAttribute("width");
  const height = await page.locator("#matrix-svg").getAttribute("height");
  await page.locator("#tab-upcoming").click();
  await expect(page.locator("#matrix-svg .matrix-cell.has-scenes")).toHaveCount(0);
  expect(await page.locator("#matrix-svg").getAttribute("width")).toBe(width);
  expect(await page.locator("#matrix-svg").getAttribute("height")).toBe(height);
});

test("the map prompt is gone once the default location loads", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("l1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  // The form already holds a location, so the app loads it without a click.
  await expect(page.locator("#map-label")).toBeHidden();
  await expect(page.locator("#results li")).toHaveCount(1);
  await page.locator("#latitude").fill("-8.5");
  await expect(page.locator("#map-label")).toBeHidden();
});

test("the date control is bounded and its year is what the grid renders", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("c1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  // Nothing optical predates Landsat-1, and nothing is published more than a year ahead.
  await expect(page.locator("#date")).toHaveAttribute("min", "1970-01-01");
  await expect(page.locator("#date")).toHaveAttribute("max", new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10));
  await page.fill("#date", "2025-03-10");
  await page.dispatchEvent("#date", "change");
  // Picking a date loads its whole calendar year and selects that day's pixel.
  await expect(page.locator("#date-from")).toHaveValue("2025-01-01");
  await expect(page.locator("#date-to")).toHaveValue("2025-12-31");
  await expect(page.locator("#matrix-svg .matrix-cell.selected")).toHaveAttribute("data-day", "2025-03-10");
  // Whole weeks of one year, never a multi-year range.
  expect(await page.locator("#matrix-svg .matrix-cell").count()).toBeGreaterThan(300);
  expect(await page.locator("#matrix-svg .matrix-cell").count()).toBeLessThan(400);
});

test("catalogue, orbit and native-tile filters narrow the results", async ({ page }) => {
  const a = stacScene("a1", "2025-03-10T02:00:00Z");
  (a.properties as Record<string, unknown>)["sat:orbit_state"] = "ascending";
  a.assets.tiles = { href: "https://example.test/tilejson.json", roles: ["tiles"], type: "application/json" };
  // A collection with no Planetary Computer render mapping, so the tile filter can exclude it.
  const b = { ...stacScene("b1", "2025-03-11T02:00:00Z"), collection: "landsat-c2-l1" };
  (b.properties as Record<string, unknown>)["sat:orbit_state"] = "descending";
  await page.route("**/search", (route) => respond(route, { json: collection([a, b], [], 2) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(2);
  // The merged result keeps one copy per scene, so the catalogue filter lists that source.
  expect(await page.locator("#provider-filter option").count()).toBeGreaterThan(1);
  // Orbit comes from the catalogue metadata.
  await chooseOption(page, "#orbit-filter", "descending");
  await expect(page.locator("#results li")).toHaveCount(1);
  await chooseOption(page, "#orbit-filter", "");
  // Only the scene with a native-resolution tile set survives.
  await page.locator("#tiles-only").check();
  await expect(page.locator("#results li")).toHaveCount(1);
  await page.locator("#tiles-only").uncheck();
  await expect(page.locator("#results li")).toHaveCount(2);
});

test("the form defaults to today, loads its year and selects that pixel", async ({ page }) => {
  const today = new Date().toISOString().slice(0, 10);
  await page.route("**/search", route => respond(route, { json: collection(
    [stacScene("today", today + "T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await expect(page.locator("#date")).toHaveValue(today);
  await expect(page.locator("#date-from")).toHaveValue(today.slice(0, 4) + "-01-01");
  await expect(page.locator("#date-to")).toHaveValue(today.slice(0, 4) + "-12-31");
  await expect(page.locator("#matrix-svg .matrix-cell.selected")).toHaveAttribute("data-day", today);
});

test("a year is fetched in a single request per catalogue", async ({ page }) => {
  const starts: string[] = [];
  await page.route("**/search", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    starts.push(String(body.datetime ?? "").slice(0, 7));
    await respond(route, { json: collection([], [], 0) });
  });
  await page.goto("/");
  await setDate(page, "2025-03-10");
  // The start-up load uses the default (current-year) window, so filter to this range.
  await expect.poll(() => starts.filter((start) => start === "2025-01").length).toBe(2);
});

test("selecting a matrix day filters the result cards", async ({ page }) => {
  await page.route("**/search", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const index = body.token ? Number(body.token) : 0;
    const features = index === 0 ? [stacScene("s10", "2025-03-10T02:00:00Z")]
      : index === 1 ? [stacScene("s11", "2025-03-11T02:00:00Z")] : [];
    const links = index < 1 ? [nextLink(String(index + 1), route.request().url())] : [];
    await respond(route, { json: collection(features, links, features.length) });
  });
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(2);
  await page.locator("#matrix-svg .matrix-cell.has-scenes").first().click();
  await expect(page.locator("#matrix-svg .matrix-cell.selected")).toHaveCount(1);
  await expect(page.locator("#results li")).toHaveCount(1);
});

test("a search loads every page of its window up front", async ({ page }) => {
  let requests = 0;
  await page.route("**/search", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const index = body.token ? Number(body.token) : 0;
    requests += 1;
    const links = index < 11 ? [nextLink(String(index + 1), route.request().url())] : [];
    const day = String((index % 28) + 1).padStart(2, "0");
    await respond(route, { json: collection([stacScene("p" + index, "2025-03-" + day + "T02:00:00Z")], links, 12) });
  });
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(12); // merged on display
  await expect(page.locator("#load-next-pages")).toBeHidden();
  expect(requests).toBeGreaterThanOrEqual(12); // paged through, not one five-page batch
});

test("a mid-scan catalogue failure is reported and keeps partial results", async ({ page }) => {
  let requests = 0;
  await page.route("**/search", async (route) => {
    requests += 1;
    if (requests === 1) {
      return respond(route, { json: collection([stacScene("ok", "2025-03-07T02:00:00Z")], [nextLink("1", route.request().url())], 5) });
    }
    return respond(route, { status: 429, body: "rate limited", contentType: "text/plain" });
  });
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#status")).toContainText(/failed/i);
});

test("a failed catalogue does not prevent the other catalogue from loading", async ({ page }) => {
  await page.route("https://planetarycomputer.microsoft.com/api/stac/v1/search", route =>
    respond(route, { status: 503, body: "unavailable", contentType: "text/plain" }));
  await page.route("https://earth-search.aws.element84.com/v1/search", route =>
    respond(route, { json: collection([stacScene("healthy", "2025-03-10T02:00:00Z")], [], 1) }));
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#status")).toContainText(/failed.*planetary-computer/i);
  await expect(page.locator("#calendar-status")).toContainText(/incomplete/i);
  await expect(page.locator("#coverage")).toContainText("earth-search");
});

test("deep link restores the location, range and selected day and replays the search", async ({ page }) => {
  const scene = stacScene("d", "2025-03-10T02:00:00Z");
  scene.geometry = { type: "Polygon", coordinates: [[[103.7, 1.2], [104.0, 1.2], [104.0, 1.5], [103.7, 1.5], [103.7, 1.2]]] };
  scene.bbox = [103.7, 1.2, 104.0, 1.5];
  await page.route("**/search", (route) =>
    respond(route, { json: collection([scene], [], 1) }));
  await page.goto("/?lat=1.35210&lon=103.81980&radius=5000&provider=earth-search&from=2025-03-01&to=2025-03-31&day=2025-03-10&zoom=14");
  await expect(page.locator("#latitude")).toHaveValue("1.35210");
  await expect(page.locator("#matrix-svg .matrix-cell.selected")).toHaveCount(1);
  await expect(page.locator("#results li")).toHaveCount(1);
  // The zoom parameter is restored and kept current in the URL.
  await expect.poll(() => Number(new URL(page.url()).searchParams.get("zoom"))).toBeGreaterThan(13);
});

test("responsive viewport keeps the search form usable", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 820 });
  await page.route("**/search", (route) => respond(route, { json: collection([], [], 0) }));
  await page.goto("/");
  await expect(page.locator("#search-form")).toBeVisible();
  await expect(page.locator("#date")).toBeVisible();
});

test("left tabs switch between historical and upcoming views", async ({ page }) => {
  await page.route("**/acquisition-plans", (route) => respond(route, { contentType: "text/html", body: "<html></html>" }));
  await page.route("**/search", (route) => respond(route, { json: collection([stacScene("h1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#map-matrix")).toBeVisible();
  await page.locator("#tab-upcoming").click();
  await expect(page.locator("#plans-results")).toBeVisible();
  await expect(page.locator("#results")).toBeHidden();
  // The grid drops the historical data, and the scene-oriented controls are hidden.
  await expect(page.locator("#matrix-svg .matrix-cell.has-scenes")).toHaveCount(0);
  await expect(page.locator("#matrix-head")).toBeHidden();
  await expect(page.locator("#obs-title")).toHaveText(/Upcoming planned acquisitions/);
  await page.locator("#tab-historical").click();
  await expect(page.locator("#results")).toBeVisible();
});

test("planned ESA acquisitions are shown separately from published scenes", async ({ page }) => {
  await page.route("**/search", route => respond(route, { json: collection([], [], 0) }));
  const now = Date.now();
  const stamp = (d: Date) => new Date(d).toISOString().replace(/[-:]/g, "").slice(0, 15);
  const observation = new Date(now + 2 * 86400000).toISOString().slice(0, 19);
  const slug = "s2b_mp_acq__kml_" + stamp(new Date(now - 86400000)) + "_" + stamp(new Date(now + 20 * 86400000));
  const planUrl = "https://sentinels.copernicus.eu/documents/d/sentinel/" + slug;
  const indexHtml = '<a href="' + planUrl + '">plan</a>';
  const kml = '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>id</name>' +
    '<styleUrl>S2B_NOBS_NOMINAL</styleUrl><ExtendedData>' +
    '<Data name="ObservationTimeStart"><value>' + observation + '</value></Data>' +
    '<Data name="OrbitRelative"><value>47</value></Data>' +
    '<Data name="Mode"><value>NOBS</value></Data></ExtendedData>' +
    '<Polygon><outerBoundaryIs><LinearRing><coordinates>' +
    '116.0,-8.7,0 116.3,-8.7,0 116.3,-8.4,0 116.0,-8.4,0 116.0,-8.7,0</coordinates></LinearRing>' +
    '</outerBoundaryIs></Polygon></Placemark></Document></kml>';
  await page.route("**/acquisition-plans",
    (route) => respond(route, { contentType: "text/html", body: indexHtml }));
  await page.route("**/documents/**",
    (route) => respond(route, { contentType: "application/vnd.google-earth.kml+xml", body: kml }));
  await page.goto("/");
  await page.locator("#tab-upcoming").click();
  await expect(page.locator("#plans-results li")).toHaveCount(1);
  await expect(page.locator("#plans-results li")).toContainText(/planned/);
  await expect(page.locator("#upcoming-status")).toContainText(/planned datatake/);
  // Coverage diagnostics: which plan window was read and how fresh that plan file is.
  await expect(page.locator("#upcoming-status")).toContainText(/plan window/);
  await expect(page.locator("#upcoming-status")).toContainText(/plan fetched/);
  await expect(page.locator("#map-matrix")).toBeVisible();
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="' + observation.slice(0, 10) + '"]')).toHaveCount(1);
});

test("upcoming view overlays published-so-far against planned", async ({ page }) => {
  const now = Date.now();
  const stamp = (d: Date) => new Date(d).toISOString().replace(/[-:]/g, "").slice(0, 15);
  const observation = new Date(now + 2 * 86400000).toISOString().slice(0, 19);
  const slug = "s2b_mp_acq__kml_" + stamp(new Date(now - 86400000)) + "_" + stamp(new Date(now + 20 * 86400000));
  const planUrl = "https://sentinels.copernicus.eu/documents/d/sentinel/" + slug;
  const indexHtml = '<a href="' + planUrl + '">plan</a>';
  const kml = '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>id</name>' +
    '<styleUrl>S2B_NOBS_NOMINAL</styleUrl><ExtendedData>' +
    '<Data name="ObservationTimeStart"><value>' + observation + '</value></Data>' +
    '</ExtendedData><Polygon><outerBoundaryIs><LinearRing><coordinates>' +
    '116.0,-8.7,0 116.3,-8.7,0 116.3,-8.4,0 116.0,-8.4,0 116.0,-8.7,0</coordinates></LinearRing>' +
    '</outerBoundaryIs></Polygon></Placemark></Document></kml>';
  await page.route("**/acquisition-plans", (route) => respond(route, { contentType: "text/html", body: indexHtml }));
  await page.route("**/documents/**", (route) => respond(route, { contentType: "application/vnd.google-earth.kml+xml", body: kml }));
  await page.route("**/search", (route) => respond(route, { json: collection([stacScene("h1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(1);
  await page.locator("#tab-upcoming").click();
  await expect(page.locator("#plans-results li")).toHaveCount(1);
  await expect(page.locator("#map-matrix")).toBeVisible();
  await expect(page.locator("#matrix-svg .matrix-cell").first()).toBeVisible();
});

test("a blocked ESA plan request explains the optional proxy", async ({ page }) => {
  // A CORS-blocked or missing proxy surfaces as a network failure: say so, and point at the
  // optional proxy rather than leaving an empty panel (the deployed build has no proxy).
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("c1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.route("**/acquisition-plans", (route) => route.abort());
  await page.goto("/");
  await page.locator("#tab-upcoming").click();
  await expect(page.locator("#upcoming-status")).toContainText(/ESA plan lookup failed/);
  await expect(page.locator("#upcoming-status")).toContainText(/optional ESA proxy/);
  await expect(page.locator("#plans-results li.empty")).toHaveCount(1);
});

test("the full-year grid fits the map pane instead of clipping December", async ({ page }) => {
  // Regression: fixed 12 px cells made a 53-week year ~689 px wide inside a ~630 px pane,
  // so the last weeks sat behind a horizontal scrollbar.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("f1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#map-matrix")).toBeVisible();
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-12-31"]')).toHaveCount(1);
  const fit = await page.evaluate(() => {
    const pane = document.querySelector("#map-container")!;
    const svg = document.querySelector("#matrix-svg")!;
    const stepper = document.querySelector("#matrix-prev-year")!;
    const paneBox = pane.getBoundingClientRect();
    const paneWidth = paneBox.width;
    const svgWidth = svg.getBoundingClientRect().width;
    const scroll = document.querySelector(".matrix-scroll")!;
    const lastCell = document.querySelector('#matrix-svg .matrix-cell[data-day="2025-12-31"]')!;
    return {
      paneWidth,
      paneLeft: paneBox.left,
      svgWidth,
      stepperLeft: stepper.getBoundingClientRect().left,
      cellRight: lastCell.getBoundingClientRect().right,
      viewRight: scroll.getBoundingClientRect().right,
      scrollWidth: scroll.scrollWidth,
      clientWidth: scroll.clientWidth,
      monthCount: document.querySelectorAll("#matrix-svg .matrix-month").length,
    };
  });
  expect(fit.monthCount).toBe(12);
  expect(fit.svgWidth).toBeLessThanOrEqual(fit.paneWidth - 76);
  // The December cell is visible in the grid's own viewport, and no horizontal scrolling is
  // needed to reach it (that was the original clipping bug).
  expect(fit.cellRight).toBeLessThanOrEqual(fit.viewRight + 0.5);
  expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth + 1);
  // The year stepper stays inside the pane instead of overlapping the left column.
  expect(fit.stepperLeft).toBeGreaterThanOrEqual(fit.paneLeft);
});

test("the day matrix plots one square cell per day across the loaded range", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, {
    json: collection([stacScene("t1", "2025-03-10T02:00:00Z"), stacScene("t2", "2025-03-10T14:00:00Z", "sentinel-2b"), stacScene("t3", "2025-03-11T02:00:00Z")], [], 3) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(3);
  await expect(page.locator("#map-matrix")).toBeVisible();
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]')).toHaveCount(1);
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-11"]')).toHaveCount(1);
  const sizes = await page.locator("#matrix-svg .matrix-cell")
    .evaluateAll((cells) => cells.map((c) => c.getAttribute("width") + "x" + c.getAttribute("height")));
  expect(sizes.length).toBeGreaterThanOrEqual(365); // ≥ one cell per day of the loaded year
  // Uniform square cells, 12 px when the range fits and smaller (≥ 6 px) when it must.
  expect([...new Set(sizes)].length).toBe(1);
  const side = Number(sizes[0].split("x")[0]);
  expect(Number(sizes[0].split("x")[1])).toBe(side);
  expect(side).toBeGreaterThanOrEqual(6);
  expect(side).toBeLessThanOrEqual(12);
  // A day with no observations still renders a placeholder cell, not a gap.
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-05"]')).toHaveAttribute("fill", "#2f3830");
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]')).not.toHaveAttribute("fill", "#2f3830");
  // Every cell — with or without observations — carries a hover tooltip.
  const allCells = await page.locator("#matrix-svg .matrix-cell").count();
  const titledCells = await page.locator("#matrix-svg .matrix-cell:has(title)").count();
  expect(titledCells).toBe(allCells);
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-05"] title')).toHaveText(/no observations/);
  // Padding days outside the year have no fill, and twelve month labels sit under the grid.
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2024-12-30"]')).toHaveAttribute("fill", "transparent");
  await expect(page.locator("#matrix-svg .matrix-month").first()).toHaveText("JAN");
  await expect(page.locator("#matrix-svg .matrix-month")).toHaveCount(12);
});

test("the metric links and shared dropdown align on a wide toolbar", async ({ page }) => {
  await page.setViewportSize({width: 1920, height: 1000});
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("m1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#matrix-head")).toBeVisible();
  const centres = await page.locator("#matrix-links .matrix-link, #matrix-links .tcsn-dropdown__trigger")
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2)));
  expect(centres.length).toBe(5);
  expect(new Set(centres).size).toBe(1);
});

test("the matrix data links switch the metric it shows", async ({ page }) => {
  await page.setViewportSize({width: 1920, height: 1000});
  await page.route("**/search", (route) => respond(route, {
    json: collection([stacScene("m1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#map-matrix")).toBeVisible();
  await expect(page.locator('.matrix-link[data-metric="total"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('.matrix-link[data-metric="mission"]').click();
  await expect(page.locator('.matrix-link[data-metric="mission"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.matrix-link[data-metric="total"]')).toHaveAttribute("aria-pressed", "false");
  // The data links sit on one horizontal row, aligned to the container's left edge.
  const tops = await page.locator(".matrix-links .matrix-link")
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  const linkLefts = await page.locator(".matrix-links .matrix-link")
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
  const matrixBox = (await page.locator("#map-matrix").boundingBox())!;
  const mapBox = (await page.locator(".map-container").boundingBox())!;
  expect(Math.min(...linkLefts) - matrixBox.x).toBeLessThan(20);
  expect(matrixBox.width).toBeLessThanOrEqual(mapBox.width - 20);
  // The container is horizontally centred within the map.
  const mapCentre = mapBox.x + mapBox.width / 2;
  const matrixCentre = matrixBox.x + matrixBox.width / 2;
  expect(Math.abs(mapCentre - matrixCentre)).toBeLessThan(4);
});

test("matrix cells are 12 px when they fit and shrink to fit narrower panes", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, {
    json: collection([stacScene("t1", "2025-03-10T02:00:00Z")], [], 1) }));
  const sizesFor = async () => {
    return page.locator("#matrix-svg .matrix-cell")
      .evaluateAll((cells) => cells.map((c) => c.getAttribute("width") + "x" + c.getAttribute("height")));
  };
  const fitsPane = async () => page.evaluate(() => {
    const pane = document.querySelector("#map-container")!.getBoundingClientRect();
    const svg = document.querySelector("#matrix-svg")!.getBoundingClientRect();
    return svg.width <= pane.width - 76 + 0.5;
  });

  // The shared frame reserves its gutters; this viewport leaves room for 12px cells.
  await page.setViewportSize({ width: 1920, height: 940 });
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#map-matrix")).toBeVisible();
  await expect(page.locator(".matrix-scroll")).toHaveCount(1);
  const wide = await sizesFor();
  expect(wide.length).toBeGreaterThan(300);
  expect([...new Set(wide)]).toEqual(["12x12"]); // a full year still gets full-size cells when there is room
  expect(await fitsPane()).toBe(true);

  // A narrower pane shrinks the cells (never below 6 px) instead of clipping the year.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(fitsPane).toBe(true);
  const narrow = await sizesFor();
  expect([...new Set(narrow)].length).toBe(1);
  const side = Number(narrow[0].split("x")[0]);
  expect(side).toBeLessThan(12);
  expect(side).toBeGreaterThanOrEqual(6);
  // Resizing back restores the full-size grid.
  await page.setViewportSize({ width: 1920, height: 940 });
  await expect.poll(async () => [...new Set(await sizesFor())]).toEqual(["12x12"]);
});

test("the matrix year arrows load the previous/next year", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, {
    json: collection([stacScene("y1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#map-matrix")).toBeVisible();
  await expect(page.locator("#date")).toHaveValue("2025-03-10");
  await page.locator("#matrix-next-year").click();
  await expect(page.locator("#date")).toHaveValue("2026-03-10");
  await expect(page.locator("#date-from")).toHaveValue("2026-01-01");
  await page.locator("#matrix-prev-year").click();
  await expect(page.locator("#date")).toHaveValue("2025-03-10");
  await expect(page.locator("#date-to")).toHaveValue("2025-12-31");
});

test("the matrix stays visible for a year with no observations", async ({ page }) => {
  await page.route("**/search", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const features = String(body.datetime ?? "").startsWith("2025") ? [stacScene("y1", "2025-03-10T02:00:00Z")] : [];
    await respond(route, { json: collection(features, [], features.length) });
  });
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#map-matrix")).toBeVisible();
  await page.locator("#matrix-next-year").click();
  await expect(page.locator("#date")).toHaveValue("2026-03-10");
  await expect(page.locator("#results li.empty")).toContainText(/No observations/);
  // The 2026 grid is still drawn, entirely as placeholder cells.
  await expect(page.locator("#map-matrix")).toBeVisible();
  const cells = await page.locator("#matrix-svg .matrix-cell").count();
  expect(cells).toBeGreaterThan(360);
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2026-06-15"]')).toHaveAttribute("fill", "#2f3830");
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]')).toHaveCount(0);
});

test("icon-only buttons centre their glyph", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("i1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#map-matrix")).toBeVisible();
  for (const id of ["#matrix-prev-year", "#matrix-next-year"]) {
    const box = (await page.locator(id).boundingBox())!;
    const glyph = (await page.locator(id + " .icon").boundingBox())!;
    expect(Math.abs((glyph.x + glyph.width / 2) - (box.x + box.width / 2))).toBeLessThan(1.5);
    expect(Math.abs((glyph.y + glyph.height / 2) - (box.y + box.height / 2))).toBeLessThan(1.5);
    expect(box.width).toBe(32);
    expect(box.height).toBe(32);
    await expect(page.locator(id)).toHaveAttribute("data-size", "sm");
    await expect(page.locator(id)).toHaveAttribute("data-appearance", "icon");
  }
  // Square corners, not pills.
  expect(await page.locator("#matrix-next-year").evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("0px");
  expect(await page.locator("#preview-next").evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("0px");
});

test("clicking a preview overlays the image on the map with prev/next navigation", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNg+M8AQhAKABvyA/1tVLjHAAAAAElFTkSuQmCC", "base64");
  await page.route("https://example.test/**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.route("**/search", (route) => respond(route, { json: collection([
    stacScene("img-a", "2025-03-09T02:00:00Z"), stacScene("img-b", "2025-03-12T02:00:00Z")], [], 2) }));
  // The range comes from the permalink so exactly one search runs: filling two date
  // inputs schedules two debounced searches and the second can land after the click.
  await page.goto("/?lat=-8.58330&lon=116.11670&radius=5000&from=2025-03-01&to=2025-03-31");
  await clearDay(page);
  await expect(page.locator("#results img")).toHaveCount(2);
  await page.waitForLoadState("networkidle");
  const zoomBefore = Number(new URL(page.url()).searchParams.get("zoom"));
  await page.locator("#results img").first().click();
  await expect(page.locator("#map-preview")).toBeVisible();
  for (const id of ["#preview-prev", "#preview-next", "#preview-close"]) {
    const button = page.locator(id);
    await expect(button).toHaveAttribute("data-size", "sm");
    await expect(button).toHaveAttribute("data-appearance", "icon");
    const box = (await button.boundingBox())!;
    expect(box.width).toBe(32);
    expect(box.height).toBe(32);
  }
  const firstCaption = (await page.locator("#preview-caption").textContent()) ?? "";
  expect(firstCaption.length).toBeGreaterThan(0);
  await page.locator("#preview-next").click();
  await expect(page.locator("#preview-caption")).not.toHaveText(firstCaption);
  await page.locator("#preview-prev").click();
  await expect(page.locator("#preview-caption")).toHaveText(firstCaption);
  // Opening (and stepping through) images must not move the camera.
  await page.waitForTimeout(250);
  expect(Number(new URL(page.url()).searchParams.get("zoom"))).toBe(zoomBefore);
  await page.keyboard.press("Escape");
  await expect(page.locator("#map-preview")).toBeHidden();
});

test("cross-catalogue copies of one tile merge; different acquisitions stay", async ({ page }) => {
  // The same tile from both catalogues: different ids, timestamps ~25 min apart, and a
  // footprint that differs by a rounding-sized amount.
  const earthSearch = stacScene("es-copy", "2025-03-10T02:40:00Z");
  const planetary = { ...stacScene("pc-copy", "2025-03-10T02:16:00Z"), bbox: [116.0, -8.7, 116.3, -8.41] };
  const product = "S2A_MSIL2A_20250310T021600_N0513_R003_T50LMR_20250310T055857.SAFE";
  Object.assign(earthSearch.properties, { "s2:product_uri": product });
  Object.assign(planetary.properties, { "s2:product_uri": product });
  const otherDay = stacScene("other-day", "2025-03-11T02:16:00Z");
  await page.route("**/search", (route) => respond(route, { json: collection(
    [earthSearch, planetary, otherDay], [], 3) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  // Product identity groups the copies while retaining both catalogues.
  await expect(page.locator("#results li")).toHaveCount(2);
  await expect(page.locator("#results li").filter({hasText:"es-copy"})).toContainText("planetary-computer");
  await chooseOption(page, "#provider-filter", "planetary-computer");
  await expect(page.locator("#results li")).toHaveCount(2);
});

test("the image on the map is restored from the permalink", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNg+M8AQhAKABvyA/1tVLjHAAAAAElFTkSuQmCC", "base64");
  await page.route("https://example.test/**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.route("**/search", (route) => respond(route, { json: collection([
    stacScene("s1", "2025-03-10T02:00:00Z"), stacScene("s2", "2025-03-11T02:00:00Z")], [], 2) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await page.locator("#results img").first().click();
  await expect(page.locator("#map-preview")).toBeVisible();
  const scene = new URL(page.url()).searchParams.get("scene");
  expect(scene).toBeTruthy();
  // Reloading the same URL puts the same image back on the map.
  await page.goto(page.url());
  await expect(page.locator("#map-preview")).toBeVisible();
  await expect(page.locator("#map-container")).toHaveAttribute("data-footprint", scene!);
});

test("the previewed image's card is highlighted with a left border", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNg+M8AQhAKABvyA/1tVLjHAAAAAElFTkSuQmCC", "base64");
  await page.route("https://example.test/**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.route("**/search", (route) => respond(route, { json: collection([
    stacScene("h1", "2025-03-10T02:00:00Z"), stacScene("h2", "2025-03-11T02:00:00Z")], [], 2) }));
  // One search from the permalink, settled before interacting (see the test above).
  await page.goto("/?lat=-8.58330&lon=116.11670&radius=5000&from=2025-03-01&to=2025-03-31");
  await clearDay(page);
  await expect(page.locator("#results li")).toHaveCount(2);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("#results li.active")).toHaveCount(0);
  await page.locator("#results img").first().click();
  await expect(page.locator("#results li.active")).toHaveCount(1);
  const first = (await page.locator("#results li.active").getAttribute("data-scene-id")) ?? "";
  expect(first.length).toBeGreaterThan(0);
  // Stepping follows the selection to the other card.
  await page.locator("#preview-next").click();
  await expect(page.locator("#results li.active")).not.toHaveAttribute("data-scene-id", first);
  await page.keyboard.press("Escape");
  await expect(page.locator("#results li.active")).toHaveCount(0);
});

test("a day cell draws no footprint; opening the image does", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNg+M8AQhAKABvyA/1tVLjHAAAAAElFTkSuQmCC", "base64");
  await page.route("https://example.test/**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("f1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  // Selecting a day filters the list but must not draw a footprint.
  await page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]').click();
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#map-container")).not.toHaveAttribute("data-footprint", /.+/);
  // Opening the image draws it, and closing clears it.
  await page.locator("#results img").click();
  await expect(page.locator("#map-container")).toHaveAttribute("data-footprint", "f1");
  await page.keyboard.press("Escape");
  await expect(page.locator("#map-container")).not.toHaveAttribute("data-footprint", /.+/);
});

test("the arrows step only through the filtered observations", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNg+M8AQhAKABvyA/1tVLjHAAAAAElFTkSuQmCC", "base64");
  await page.route("https://example.test/**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.route("**/search", (route) => respond(route, { json: collection([
    stacScene("a1", "2025-03-10T02:00:00Z"), stacScene("b1", "2025-03-11T02:00:00Z")], [], 2) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(2);
  // The per-card footprint button is gone...
  await expect(page.locator(".scene-inspect")).toHaveCount(0);
  // ...and with one day selected the arrows stay inside the filtered set.
  await page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]').click();
  await expect(page.locator("#results li")).toHaveCount(1);
  await page.locator("#results img").click();
  await expect(page.locator("#map-preview")).toBeVisible();
  const caption = (await page.locator("#preview-caption").textContent()) ?? "";
  await page.locator("#preview-next").click();
  await expect(page.locator("#preview-caption")).toHaveText(caption);
});

test("the card and map preview prefer a higher-resolution provider asset", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNg+M8AQhAKABvyA/1tVLjHAAAAAElFTkSuQmCC", "base64");
  await page.route("https://example.test/**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  const scene = stacScene("hq", "2025-03-10T02:00:00Z");
  // A rendered preview (overview role) should win over the small thumbnail.
  scene.assets.rendered_preview = { href: "https://example.test/rendered-hq.png", roles: ["overview"], type: "image/png" };
  await page.route("**/search", (route) => respond(route, { json: collection([scene], [], 1) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results img")).toHaveCount(1);
  await expect(page.locator("#results img")).toHaveAttribute("src", /rendered-hq\.png/);
});

test("a Landsat-style scene uses the item thumbnail link for its image", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNg+M8AQhAKABvyA/1tVLjHAAAAAElFTkSuQmCC", "base64");
  await page.route("https://example.test/**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  const renderUrls: string[] = [];
  await page.route("https://planetarycomputer.microsoft.com/**", (route) => {
    const url = route.request().url();
    renderUrls.push(url);
    if (url.includes("/collections/landsat-c2-l2/items/")) return respond(route, { json: {
      ...item, assets: { tilejson: { href: "https://planetarycomputer.microsoft.com/api/data/v1/item/tilejson.json?item=LC09_1", roles: ["tiles"], type: "application/json" } }
    } });
    return url.includes("tilejson")
      ? respond(route, { json: { tiles: ["https://planetarycomputer.microsoft.com/api/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?item=LC09_1"], minzoom: 0, maxzoom: 22, tileSize: 256 } })
      : route.fulfill({ contentType: "image/png", body: png });
  });
  const item = {
    type: "Feature", id: "LC09_1", collection: "landsat-c2-l2",
    geometry: { type: "Polygon", coordinates: [[[116.0, -8.7], [116.3, -8.7], [116.3, -8.4], [116.0, -8.4], [116.0, -8.7]]] },
    bbox: [116.0, -8.7, 116.3, -8.4],
    properties: { datetime: "2025-03-10T02:00:00Z", platform: "landsat-9", "eo:cloud_cover": 5 },
    assets: { thumbnail: { href: "s3://usgs-landsat/collection02/LC09_1_thumb_small.jpeg", type: "image/jpeg", roles: ["thumbnail"] } },
    links: [
      { rel: "self", href: "https://example.test/items/LC09_1" },
      { rel: "thumbnail", href: "https://example.test/items/LC09_1/thumbnail" },
    ],
  };
  await page.route("**/search", (route) => respond(route, { json: collection([item], [], 1) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(1);
  // The card identifies the scene and shows seconds, so neighbouring scenes differ.
  await expect(page.locator("#results li")).toContainText("LC09_1");
  await expect(page.locator("#results li")).toContainText(/\d{1,2}:\d{2}:\d{2}/);
  await expect(page.locator("#results img")).toHaveCount(1);
  await expect(page.locator("#results img")).toHaveAttribute("src", /LC09_1\/thumbnail/);
  // The map overlay uses the CORS-enabled Planetary Computer render of the same item id.
  await page.locator("#results img").click();
  await expect(page.locator("#map-preview")).toBeVisible();
  // The overlay asks Planetary Computer for the native-resolution tile set, not the PNG.
  await expect.poll(() => renderUrls.some((u) => u.includes("tilejson"))).toBe(true);
});

test("an Earth Search Sentinel-2 scene resolves a native-resolution tile set", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNg+M8AQhAKABvyA/1tVLjHAAAAAElFTkSuQmCC", "base64");
  const requested: string[] = [];
  await page.route("https://example.test/**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  const scene = stacScene("s2a", "2025-03-10T02:00:00Z");
  (scene.properties as Record<string, unknown>)["grid:code"] = "MGRS-50MRV";
  // Register the STAC search first: later routes win, so the Planetary Computer routes
  // below take precedence for their own URLs (**/search would otherwise match them).
  await page.route("**/search", (route) => respond(route, { json: collection([scene], [], 1) }));
  await page.route("https://planetarycomputer.microsoft.com/api/stac/v1/search", (route) => {
    requested.push("search");
    return respond(route, { json: { features: [
      { id: "S2C_MSIL2A_20250310T020000_R047_T50MRV_20250310T020000", collection: "sentinel-2-l2a",
        properties: { datetime: "2025-03-10T02:00:00Z", "s2:mgrs_tile": "50MRV" },
        assets: { tilejson: { href: "https://planetarycomputer.microsoft.com/api/data/v1/item/tilejson.json?item=S2C_MSIL2A_20250310T020000_R047_T50MRV_20250310T020000", roles: ["tiles"], type: "application/json" } } }] } });
  });
  await page.route("https://planetarycomputer.microsoft.com/api/data/v1/**", (route) => {
    const url = route.request().url();
    requested.push(url);
    return url.includes("tilejson")
      ? respond(route, { json: { tiles: ["https://planetarycomputer.microsoft.com/api/data/v1/item/tiles/x/{z}/{x}/{y}@1x?item=a"], minzoom: 0, maxzoom: 22, tileSize: 256 } })
      : route.fulfill({ contentType: "image/png", body: png });
  });
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results img")).toHaveCount(1);
  await page.locator("#results img").click();
  await expect(page.locator("#map-preview")).toBeVisible();
  // The Sentinel-2 item id is resolved on Planetary Computer, then its tile set is used.
  await expect.poll(() => requested.some((u) => u.includes("item=S2C_MSIL2A"))).toBe(true);
  await expect.poll(() => requested.some((u) => u.includes("tilejson"))).toBe(true);
});

test("scenes whose footprint misses the searched point are never shown", async ({ page }) => {
  const covering = stacScene("covering", "2025-03-10T02:00:00Z");
  const missing = stacScene("missing", "2025-03-11T02:00:00Z");
  missing.geometry = { type: "Polygon", coordinates: [[[10.0, -9.0], [10.3, -9.0], [10.3, -8.7], [10.0, -8.7], [10.0, -9.0]]] };
  missing.bbox = [10.0, -9.0, 10.3, -8.7];
  await page.route("**/search", (route) => respond(route, { json: collection([covering, missing], [], 2) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  // The default point is inside only the first scene's footprint (bbox vs polygon gap),
  // so the second is dropped and the matrix/overlay always cover the location.
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#matrix-svg .matrix-cell.has-scenes")).toHaveCount(1);
});

test("the Data sources panel lists the registry and enables extra catalogues", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/search", (route) => {
    requests.push(route.request().url());
    return respond(route, { json: collection([stacScene("s1", "2025-03-10T02:00:00Z")], [], 1) });
  });
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(1);
  // The panel lists registry sources with their access terms.
  await page.locator("#sources summary").click();
  await expect(page.locator("#source-list")).toContainText(/Earth Search/);
  await expect(page.locator("#source-list")).toContainText(/Planetary Computer/);
  await expect(page.locator("#source-list")).toContainText(/Copernicus Data Space/);
  await expect(page.locator("#source-list")).toContainText(/JAXA G-Portal/);
  await expect(page.locator('#source-list input[data-source="jaxa-gportal"]')).toHaveCount(1);
  // Extra catalogues are opt-in: ticking one queries that catalogue too.
  await page.locator('#source-list input[data-source="copernicus"]').check();
  await expect.poll(() => requests.some((url) => url.includes("dataspace.copernicus.eu"))).toBe(true);
  await page.locator('#source-list input[data-source="nasa-cmr"]').check();
  await expect.poll(() => requests.some((url) => url.includes("cmr.earthdata.nasa.gov"))).toBe(true);
});

test("INPE opt-in searches its collection and displays observations", async ({ page }) => {
  const requested: string[][] = [];
  await page.route("**/search", async route => {
    if (!route.request().url().includes("data.inpe.br")) return respond(route,{json:collection([],[],0)});
    const body = route.request().postDataJSON();
    requested.push(body.collections);
    const base = stacScene("cbers", "2025-03-10T00:00:00Z");
    const scene = {...base,collection:"CB4A-WPM-PCA-FUSED-1",
      properties:{datetime:"2025-03-10T00:00:00Z"}};
    return respond(route,{json:collection([scene],[],1)});
  });
  await page.goto("/?date=2025-03-10");
  const quickSource=page.locator('[data-source-toggle="inpe-cbers"]');
  await expect(quickSource).toBeVisible();
  expect(requested).toHaveLength(0);
  await quickSource.check();
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#results")).toContainText("CB4A-WPM-PCA-FUSED-1");
  expect(requested).toContainEqual(["CB4A-WPM-PCA-FUSED-1"]);
  await expect(page.locator('#source-list input[data-source="inpe-cbers"]')).toBeChecked();
  await page.reload();
  await expect(quickSource).toBeChecked();
  await expect(page.locator("#results")).toContainText("CB4A-WPM-PCA-FUSED-1");
  await page.locator("#sources summary").click();
  await page.locator('#source-list input[data-source="inpe-cbers"]').uncheck();
  await expect(quickSource).not.toBeChecked();
});

test("ASF opt-in includes NISAR and ALOS-2 and classifies NISAR as radar", async ({ page }) => {
  await page.route("**/search",route=>respond(route,{json:collection([],[],0)}));
  let platforms: string[] = [];
  await page.route("https://api.daac.asf.alaska.edu/**",route=>{
    platforms = new URL(route.request().url()).searchParams.get("platform")!.split(",");
    return respond(route,{json:collection([{type:"Feature",
      geometry:stacScene("shape","2025-03-10T00:00:00Z").geometry,
      properties:{sceneName:"nisar",platform:"NISAR",processingLevel:"RSLC",startTime:"2025-03-10T02:00:00Z"},
    }],[],1)});
  });
  await page.goto("/?date=2025-03-10&src=asf-vertex");
  await expect(page.locator('[data-source-toggle="asf-vertex"]')).toBeChecked();
  await expect(page.locator("#results")).toContainText("NISAR");
  expect(platforms).toEqual(["SENTINEL-1","NISAR","ALOS-2"]);
  await page.locator('.matrix-chip[data-sensor="radar"]').click();
  await expect(page.locator("#results")).toContainText("NISAR");
});

test("the More dropdown picks an extra metric", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("m1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(1);
  const dropdown = page.locator("#matrix-more").locator("..");
  const cell = page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]');
  const previousFill = await cell.getAttribute("fill");
  await chooseOption(page, "#matrix-more", "resolution");
  await expect(dropdown.getByRole("combobox")).toHaveText(/Resolution/);
  await expect(dropdown.getByRole("combobox")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('.matrix-link[aria-pressed="true"]')).toHaveCount(0);
  await expect(cell).not.toHaveAttribute("fill", previousFill!);
});

test("the Image/Radar quick filter narrows the view and sits right", async ({ page }) => {
  const optical = stacScene("opt", "2025-03-10T02:00:00Z");
  const radarBase = stacScene("rad", "2025-03-11T02:00:00Z");
  const radar = { ...radarBase, collection: "sentinel-1-rtc",
    properties: { ...radarBase.properties, platform: "sentinel-1c" } };
  await page.route("**/search", (route) => respond(route, { json: collection([optical, radar], [], 2) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(2);
  // The quick filters are right-aligned against the metric links.
  const links = (await page.locator("#matrix-links").boundingBox())!;
  const quick = (await page.locator("#matrix-quick").boundingBox())!;
  expect(quick.x).toBeGreaterThan(links.x + 50);
  await page.locator('.matrix-chip[data-sensor="radar"]').click();
  await expect(page.locator('.matrix-chip[data-sensor="radar"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#results li")).toContainText(/sentinel-1-rtc/);
  await page.locator('.matrix-chip[data-sensor="optical"]').click();
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#results li")).toContainText(/sentinel-2-l2a/);
  await page.locator('.matrix-chip[data-sensor="all"]').click();
  await expect(page.locator("#results li")).toHaveCount(2);
});

test("a radar scene renders its tile set and is listed in the collection filter", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNg+M8AQhAKABvyA/1tVLjHAAAAAElFTkSuQmCC", "base64");
  await page.route("https://example.test/**", (route) => {
    const url = route.request().url();
    return url.includes("tilejson")
      ? respond(route, { json: { tiles: ["https://example.test/t/{z}/{x}/{y}.png"], minzoom: 0, maxzoom: 20, tileSize: 256 } })
      : route.fulfill({ contentType: "image/png", body: png });
  });
  const scene = {
    type: "Feature", id: "S1A_IW_rtc", collection: "sentinel-1-rtc",
    geometry: { type: "Polygon", coordinates: [[[116.0, -8.7], [116.3, -8.7], [116.3, -8.4], [116.0, -8.4], [116.0, -8.7]]] },
    bbox: [116.0, -8.7, 116.3, -8.4],
    properties: { datetime: "2025-03-10T02:00:00Z", platform: "sentinel-1c" },
    assets: {
      tilejson: { href: "https://example.test/s1/tilejson.json", roles: ["tiles"], type: "application/json" },
      thumbnail: { href: "https://example.test/s1-thumb.png", roles: ["thumbnail"], type: "image/png" },
    },
  };
  await page.route("**/search", (route) => respond(route, { json: collection([scene], [], 1) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#collection-filter option", { hasText: "sentinel-1-rtc" })).toHaveCount(1);
  await page.locator("#results img").click();
  await expect(page.locator("#map-preview")).toBeVisible();
  // Radar has no cloud cover, so the cloud metric reports "no cloud metadata" for that day.
  await page.locator('.matrix-link[data-metric="cloud"]').click();
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]')).toHaveAttribute("fill", "#5b665b");
});

test("a provider tile set is used when the scene exposes one", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNg+M8AQhAKABvyA/1tVLjHAAAAAElFTkSuQmCC", "base64");
  let tilejsonRequests = 0;
  await page.route("https://example.test/**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.route("https://example.test/tilejson.json**", (route) => {
    tilejsonRequests += 1;
    return respond(route, { json: { tiles: ["https://example.test/tiles/{z}/{x}/{y}.png"], tileSize: 256, minzoom: 0, maxzoom: 14 } });
  });
  const scene = stacScene("tiled", "2025-03-10T02:00:00Z");
  scene.assets.tilejson = { href: "https://example.test/tilejson.json?item=tiled", roles: ["tiles"], type: "application/json" };
  await page.route("**/search", (route) => respond(route, { json: collection([scene], [], 1) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results img")).toHaveCount(1);
  await page.locator("#results img").first().click();
  await expect(page.locator("#map-preview")).toBeVisible();
  await expect.poll(() => tilejsonRequests).toBeGreaterThan(0);
});

test("cloud-cover and hour filters narrow the loaded results", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("f1", "2025-03-10T02:00:00Z"), stacScene("f2", "2025-03-11T02:00:00Z")], [], 2) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(2);
  await chooseOption(page, "#cloud-max", "10"); // scenes are 12.5% cloud
  // Nothing matches: the panel says so rather than going blank.
  await expect(page.locator("#results li.empty")).toContainText(/No observations match/);
  await chooseOption(page, "#cloud-max", "30");
  await expect(page.locator("#results li")).toHaveCount(2);
  await chooseOption(page, "#hour-min", "12"); // scenes are ~02:00 UTC
  await expect(page.locator("#results li.empty")).toContainText(/No observations match/);
  await chooseOption(page, "#hour-min", "0");
  await chooseOption(page, "#hour-max", "6");
  await expect(page.locator("#results li")).toHaveCount(2);
});

test("collection filter, reset, and timeline views", async ({ page }) => {
  const sentinel = stacScene("c1", "2025-03-10T02:00:00Z");
  const landsatBase = stacScene("c2", "2025-03-11T02:00:00Z");
  const landsat = { ...landsatBase, collection: "landsat-c2-l2",
    properties: { ...landsatBase.properties, platform: "landsat-9" } };
  await page.route("**/search", (route) => respond(route, { json: collection([sentinel, landsat], [], 2) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(2);
  await chooseOption(page, "#collection-filter", "landsat-c2-l2");
  await expect(page.locator("#results li")).toHaveCount(1);
  await page.locator("#clear-filters").click();
  await expect(page.locator("#results li")).toHaveCount(2);
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]')).toHaveCount(1);
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-11"]')).toHaveCount(1);
});

test("an auto-selected date with no observations falls back to the whole year", async ({ page }) => {
  // Picking a date that happens to be empty must not hide the loaded observations: the pixel is
  // dropped and the year's scenes stay listed.
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("j1", "2025-06-01T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await page.fill("#date", "2025-03-10");
  await page.dispatchEvent("#date", "change");
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#matrix-svg .matrix-cell.selected")).toHaveCount(0);
  await expect(page.locator("#matrix-svg .matrix-cell.has-scenes")).toHaveCount(1);
  await expect(page.locator("#results li")).toContainText("j1");
});

test("a day cell with no observations is still selectable and explains itself", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, { json: collection([
    stacScene("n1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  const empty = page.locator('#matrix-svg .matrix-cell[data-day="2025-03-05"]');
  await expect(empty).toHaveAttribute("role", "button");
  await expect(empty).toHaveAttribute("tabindex", "0");
  await expect(empty.locator("title")).toHaveText(/no observations/);
  await empty.click();
  await expect(page.locator("#matrix-svg .matrix-cell.selected")).toHaveAttribute("data-day", "2025-03-05");
  // Selecting an empty day says so rather than showing a blank panel.
  await expect(page.locator("#results li.empty")).toContainText(/No observations on 2025-03-05/);
  // The selection clears again from the matrix control.
  await page.locator("#show-all-days").click();
  await expect(page.locator("#results li")).toHaveCount(1);
});

test("matrix day cells are keyboard operable", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, { json: collection([
    stacScene("k1", "2025-03-10T02:00:00Z"), stacScene("k2", "2025-03-12T02:00:00Z")], [], 2) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#matrix-svg .matrix-cell.selected")).toHaveAttribute("data-day", "2025-03-10");
  // Every in-window day is focusable, so arrows step a day at a time (empty days included).
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#matrix-svg .matrix-cell:focus")).toHaveAttribute("data-day", "2025-03-11");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("#matrix-svg .matrix-cell.selected")).toHaveAttribute("data-day", "2025-03-12");
  await expect(page.locator("#results li")).toHaveCount(1);
});

test("clicking a matrix cell selects that day without changing the zoom", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, {
    json: collection([stacScene("z1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator("#map-matrix")).toBeVisible();
  const before = Number(new URL(page.url()).searchParams.get("zoom"));
  await page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]').click();
  await expect(page.locator("#matrix-svg .matrix-cell.selected")).toHaveCount(1);
  await page.waitForTimeout(300);
  expect(Number(new URL(page.url()).searchParams.get("zoom"))).toBe(before);
});

test("clicking a matrix cell toggles the selected day", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("b1", "2025-03-10T02:00:00Z"), stacScene("b2", "2025-03-12T02:00:00Z")], [], 2) }));
  await page.goto("/");
  await setDate(page, "2025-03-10");
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]')).toBeVisible();
  await page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]').click();
  await expect(page.locator("#matrix-svg .matrix-cell.selected")).toHaveCount(1);
  await expect(page.locator("#matrix-svg .matrix-cell.selected")).toHaveAttribute("data-day", "2025-03-10");
  await page.locator('#matrix-svg .matrix-cell[data-day="2025-03-12"]').click();
  await expect(page.locator("#matrix-svg .matrix-cell.selected")).toHaveCount(1);
  await expect(page.locator("#matrix-svg .matrix-cell.selected")).toHaveAttribute("data-day", "2025-03-12");
  // The active cell is outlined, and clicking it again deselects.
  const stroke = await page.locator("#matrix-svg .matrix-cell.selected").evaluate((el) => getComputedStyle(el).stroke);
  expect(stroke).not.toBe("none");
  await page.locator('#matrix-svg .matrix-cell[data-day="2025-03-12"]').click();
  await expect(page.locator("#matrix-svg .matrix-cell.selected")).toHaveCount(0);
  await expect(page.locator("#results li")).toHaveCount(2);
});

test("an unaligned public preview stays separate from the map and supports keyboard close", async ({ page }) => {
  await page.route("**/search", route => respond(route, { json: collection([stacScene("unaligned", "2025-03-10T02:00:00Z")], [], 1) }));
  await setDate(page, "2025-03-10");
  const image = page.locator("#results img");
  const previewButton = image.locator("..");
  await expect(previewButton).toHaveAttribute("data-appearance", "media");
  await previewButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#map-container")).toHaveAttribute("data-preview-source", "unplaced-image");
  await expect(page.locator("#preview-still")).toBeVisible();
  await expect(page.locator("#preview-still-status")).toContainText("Map alignment is unknown");
  await expect(page.locator("#map-container")).toHaveAttribute("data-footprint", "unaligned");
  await page.keyboard.press("Escape");
  await expect(page.locator("#preview-still")).toBeHidden();
  await expect(previewButton).toBeFocused();
});

test("has-preview includes advertised tiles and excludes a GeoTIFF disguised as a JPEG", async ({ page }) => {
  const bad = stacScene("geotiff", "2025-03-10T02:00:00Z");
  bad.assets.thumbnail.type = "image/tiff; application=geotiff";
  const tiled = stacScene("tiles-only", "2025-03-11T02:00:00Z");
  (tiled as { assets: unknown }).assets = { tilejson: { href: "https://example.test/tilejson.json", roles: ["tiles"], type: "application/json" } };
  await page.route("**/search", route => respond(route, { json: collection([bad, tiled], [], 2) }));
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results img")).toHaveCount(0);
  await page.locator("#has-preview").check();
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#results li")).toContainText("tiles-only");
});

const ODATA_PRODUCT = "S2B_MSIL2A_20250310T020000_N0513_R003_T50LMR_20250310T055857";
const ODATA_ASSET = "https://catalogue.dataspace.copernicus.eu/odata/v1/Assets(3b55eb2e-c778-4171-8b23-3862e9b70a47)/$value";
async function copernicusWithoutPreview(page: Page) {
  const scene = stacScene(ODATA_PRODUCT, "2025-03-10T02:00:00Z");
  (scene as { assets: unknown }).assets = {};
  await page.route("**/search", route => respond(route, { json: collection(
    route.request().url().includes("dataspace.copernicus.eu") ? [scene] : [], [], 1) }));
  await page.goto("/?lat=-8.58330&lon=116.11670&radius=5000&from=2025-03-01&to=2025-03-31&src=copernicus");
  await expect(page.locator("#results li")).toHaveCount(1);
}
function odataProduct(assets: unknown[], name = ODATA_PRODUCT + ".SAFE") {
  return { value: [{ Name: name, Id: "0c65ef71-e70d-4ecd-98c7-bc813f41f48d", Assets: assets }] };
}

test("Copernicus discovers an exact product quicklook on demand and reuses it", async ({ page }) => {
  const requests: URL[] = [];
  await page.route("**/odata/v1/Products?**", route => {
    requests.push(new URL(route.request().url()));
    return respond(route, { json: odataProduct([{ Type: "QUICKLOOK", DownloadLink: ODATA_ASSET }]) });
  });
  await page.route(ODATA_ASSET, route => route.fulfill({ contentType: "application/octet-stream",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNg+M8AQhAKABvyA/1tVLjHAAAAAElFTkSuQmCC", "base64") }));
  await copernicusWithoutPreview(page);
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "View public preview", exact: true }).click();
  await expect(page.locator("#preview-caption")).toContainText("Copernicus OData");
  await expect.poll(() => page.locator("#preview-still-image").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(requests).toHaveLength(1);
  expect(requests[0].searchParams.get("$filter")).toBe("Name eq '" + ODATA_PRODUCT + ".SAFE'");
  expect(requests[0].searchParams.get("$expand")).toBe("Assets");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "View public preview", exact: true }).click();
  await expect(page.locator("#preview-caption")).toContainText("Copernicus OData");
  expect(requests).toHaveLength(1);
});

for (const scenario of ["missing", "wrong product", "unapproved host", "account required", "oversized"] as const) {
  test("Copernicus preview lookup handles " + scenario, async ({ page }) => {
    await page.route("**/odata/v1/Products?**", route => {
      if (scenario === "account required") return respond(route, { status: 403 });
      if (scenario === "oversized") return route.fulfill({ headers: { ...CORS, "content-length": "1048577" }, body: "{}" });
      const assets = [{ Type: "QUICKLOOK", DownloadLink: scenario === "unapproved host" ? "https://unapproved.test/preview.jpg" : ODATA_ASSET }];
      return respond(route, { json: scenario === "missing" ? { value: [] } : odataProduct(assets,
        scenario === "wrong product" ? "OTHER_PRODUCT.SAFE" : ODATA_PRODUCT + ".SAFE") });
    });
    await copernicusWithoutPreview(page);
    await page.getByRole("button", { name: "View public preview", exact: true }).click();
    await expect(page.locator("#map-preview")).toBeHidden();
    await expect(page.locator("#status")).toContainText(scenario === "account required" ? "requires an account"
      : scenario === "oversized" ? "too large" : "No public preview");
    await page.locator("#paid-maps summary").click();
    await expect(page.getByRole("link", { name: "Open SkyFi map" })).toBeVisible();
  });
}

test("closing a pending preview cancels it without reopening a stale view", async ({ page }) => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let requested = false;
  await page.route("**/odata/v1/Products?**", async route => {
    requested = true;
    await gate;
    await respond(route, { json: odataProduct([]) }).catch(() => {});
  });
  await copernicusWithoutPreview(page);
  await page.getByRole("button", { name: "View public preview", exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await expect(page.locator("#preview-caption")).toHaveText("Loading public preview…");
  await page.keyboard.press("Escape");
  finish();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("#map-preview")).toBeHidden();
  await expect(page.locator("#status")).not.toContainText("No public preview");
});

test("a nearby Planetary Computer acquisition cannot replace the selected scene", async ({ page }) => {
  const scene = stacScene("selected-original", "2025-03-10T02:00:00Z");
  Object.assign(scene.properties, { "s2:mgrs_tile": "50LMR" });
  await page.route("**/search", route => respond(route, { json: collection([scene], [], 1) }));
  await page.route("https://planetarycomputer.microsoft.com/api/stac/v1/search", route => {
    const nearby = stacScene("different-acquisition", "2025-03-10T02:05:00Z");
    Object.assign(nearby.properties, { "s2:mgrs_tile": "50LMR" });
    (nearby as { assets: unknown }).assets = { tilejson: { href: "https://never-request.test/tilejson.json", roles: ["tiles"] } };
    return respond(route, { json: collection([nearby], [], 1) });
  });
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(2);
  await page.locator('[data-scene-id="selected-original"] img').click();
  await expect(page.locator("#preview-still-image")).toHaveAttribute("src", /thumb-selected-original/);
  await expect(page.locator("#map-container")).toHaveAttribute("data-preview-source", "unplaced-image");
});

test("paid map links open only on request and copied search context contains the selected area and dates", async ({ page, context }) => {
  await page.route("**/search", route => respond(route, { json: collection([], [], 0) }));
  const visited: string[] = [];
  await context.route("https://app.skyfi.com/**", route => {
    visited.push(route.request().url());
    expect(route.request().headers()["referer"]).toBeUndefined();
    return route.fulfill({ contentType: "text/html", body: "<h1>Provider map fixture</h1>" });
  });
  await page.addInitScript(() => Object.defineProperty(navigator.clipboard, "writeText", { value: async (text: string) => {
    (window as unknown as { copiedSearch: string }).copiedSearch = text;
  } }));
  await page.goto("/?lat=-8.5833&lon=116.1167&radius=5000&from=2025-03-01&to=2025-03-31");
  await page.locator("#paid-maps summary").click();
  const link = page.getByRole("link", { name: "Open SkyFi map" });
  await expect(link).toHaveAttribute("href", "https://app.skyfi.com/");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.getByRole("link", { name: "Open UP42 map" })).toHaveAttribute("href", "https://console.up42.com/");
  expect(visited).toHaveLength(0);
  await page.getByRole("button", { name: "Copy location and dates" }).click();
  const copied = await page.evaluate(() => (window as unknown as { copiedSearch: string }).copiedSearch);
  expect(copied).toContain("Latitude: -8.58330, longitude: 116.11670, radius: 5000 m");
  expect(copied).toContain("Dates: 2025-01-01 to 2025-12-31 (UTC)");
  const popupPromise = page.waitForEvent("popup");
  await link.click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(popup.url()).toBe("https://app.skyfi.com/");
  expect(visited).toEqual(["https://app.skyfi.com/"]);
  await popup.close();
});

test("a public tile-service failure falls back to the scene's unaligned still preview", async ({ page }) => {
  const scene = stacScene("tile-failure", "2025-03-10T02:00:00Z");
  (scene.assets as Record<string, unknown>).tilejson = { href: "https://example.test/unavailable-tilejson.json", type: "application/json", roles: ["tiles"] };
  await page.route("**/search", route => respond(route, { json: collection([scene], [], 1) }));
  await page.route("https://example.test/unavailable-tilejson.json", route => respond(route, { status: 503 }));
  await setDate(page, "2025-03-10");
  await page.getByRole("button", { name: "View public preview", exact: true }).click();
  await expect(page.locator("#map-container")).toHaveAttribute("data-preview-source", "unplaced-image");
  await expect(page.locator("#preview-still-image")).toHaveAttribute("src", /thumb-tile-failure/);
  await expect(page.locator("#preview-still-status")).toContainText("Map alignment is unknown");
  await expect(page.getByRole("button", { name: "Retry public preview", exact: true })).toBeVisible();
});

test("a thumbnail with declared authentication is not offered as a public image", async ({ page }) => {
  const scene = stacScene("private-thumbnail", "2025-03-10T02:00:00Z");
  Object.assign(scene.assets.thumbnail, { "auth:refs": ["oidc"] });
  await page.route("**/search", route => respond(route, { json: collection([scene], [], 1) }));
  await setDate(page, "2025-03-10");
  await expect(page.locator("#results img")).toHaveCount(0);
  await page.locator("#has-preview").check();
  await expect(page.locator("#results li.empty")).toContainText("No observations match");
});

test("paid imagery and known commercial satellites from another catalogue can be excluded", async ({page})=>{
  const commercial=stacScene("worldview-from-other-source","2025-03-10T02:00:00Z","WorldView-2");
  await page.route("**/search",route=>respond(route,{json:collection([commercial,stacScene("sentinel","2025-03-10T02:00:00Z")],[],2)}));
  await setDate(page,"2025-03-10");
  await expect(page.locator("#results li")).toHaveCount(2);
  await chooseOption(page, "#satellite-type-filter","public");
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#results li")).toContainText("sentinel");
});

test("commercial preview catalogue scans are removed even from old Maxar links", async ({page})=>{
  const requests:string[]=[];
  page.on("request",request=>{if(request.url().includes("maxar-opendata"))requests.push(request.url())});
  await page.route("**/search",route=>respond(route,{json:collection([stacScene("public-sentinel","2026-07-21T02:00:00Z")],[],1)}));
  await page.goto("/?lat=-8.48823&lon=116.10846&radius=5000&date=2026-10-13&day=2026-07-20&satellites=commercial&src=maxar-open-data");
  await expect(page.locator("#status")).toHaveText("");
  await expect(page.locator("#results li.empty")).toContainText("connected public catalogues");
  await expect(page.locator("#results li.empty")).toContainText("requires a provider account");
  await expect(page.locator("#counter")).toHaveText("0 / 1");
  await expect(page.locator('input[data-source="maxar-open-data"]')).toHaveCount(0);
  await page.getByRole("button",{name:"Show all loaded observations"}).click();
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#results li")).toContainText("public-sentinel");
  await expect(page.locator("#satellite-type-filter")).toHaveValue("");
  await expect(page).not.toHaveURL(/satellites=commercial/);
  await expect(page).not.toHaveURL(/day=2026-07-20/);
  await page.reload();
  await expect(page.locator("#results li")).toHaveCount(1);
  expect(requests).toEqual([]);
});

test("commercial-satellite filtering still updates the matrix, reloads and closes excluded previews", async ({page})=>{
  const commercial=stacScene("commercial","2025-03-10T02:00:00Z","WV03");
  await page.route("**/search",route=>respond(route,{json:collection([commercial,stacScene("public","2025-03-10T02:00:00Z")],[],2)}));
  await setDate(page,"2025-03-10");
  await page.locator('[data-scene-id="commercial"] img').click();
  await expect(page.locator("#map-preview")).toBeVisible();
  await chooseOption(page, "#satellite-type-filter","public");
  await expect(page.locator("#map-preview")).toBeHidden();
  await expect(page.locator("#counter")).toHaveText("1 / 2");
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"] title')).toHaveText(/1 observations?/);
  await page.reload();
  await expect(page.locator("#satellite-type-filter")).toHaveValue("public");
  await expect(page.locator("#results li")).toHaveCount(1);
  await chooseOption(page, "#satellite-type-filter","commercial");
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#results li")).toContainText("commercial");
  await page.locator("#clear-filters").click();
  await expect(page.locator("#results li")).toHaveCount(2);
  await expect(page).not.toHaveURL(/satellites=/);
});
