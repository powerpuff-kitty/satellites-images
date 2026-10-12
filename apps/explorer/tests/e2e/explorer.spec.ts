import { test, expect, type Page, type Route } from "@playwright/test";

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
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#111512" } }],
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

async function setRange(page: Page, from: string, to: string) {
  await page.fill("#date-from", from);
  await page.fill("#date-to", to);
}

test.beforeEach(async ({ page }) => {
  await page.route("https://tiles.openfreemap.org/**", (route) => respond(route, { json: MAP_STYLE }));
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
  await setRange(page, "2025-03-01", "2025-03-31");
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
  await setRange(page, "2025-03-01", "2025-03-31");
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
  // ...and clearing it falls back to the point + radius query.
  await page.locator("#clear-area").click();
  await expect.poll(() => bodies.some((body) => JSON.stringify(body).includes("bbox"))).toBe(true);
});

test("the matrix keeps its size when switching tabs", async ({ page }) => {
  await page.route("**/acquisition-plans", (route) => respond(route, { contentType: "text/html", body: "<html></html>" }));
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("s1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setRange(page, "2025-01-01", "2025-12-31");
  await expect(page.locator("#map-matrix")).toBeVisible();
  const width = await page.locator("#matrix-svg").getAttribute("width");
  const height = await page.locator("#matrix-svg").getAttribute("height");
  await page.locator("#tab-upcoming").click();
  await expect(page.locator("#matrix-svg .matrix-cell.has-scenes")).toHaveCount(0);
  expect(await page.locator("#matrix-svg").getAttribute("width")).toBe(width);
  expect(await page.locator("#matrix-svg").getAttribute("height")).toBe(height);
});

test("the map prompt disappears once a location is chosen", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("l1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await expect(page.locator("#map-label")).toBeVisible();
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#map-label")).toBeHidden();
});

test("the form defaults to the full calendar year", async ({ page }) => {
  await page.goto("/");
  const year = new Date().toISOString().slice(0, 4);
  await expect(page.locator("#date-from")).toHaveValue(year + "-01-01");
  await expect(page.locator("#date-to")).toHaveValue(year + "-12-31");
});

test("a year is fetched in a single request per catalogue", async ({ page }) => {
  const starts: string[] = [];
  await page.route("**/search", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    starts.push(String(body.datetime ?? "").slice(0, 7));
    await respond(route, { json: collection([], [], 0) });
  });
  await page.goto("/");
  await setRange(page, "2025-01-01", "2025-12-31");
  await expect.poll(() => starts.length).toBe(2);
  expect(new Set(starts)).toEqual(new Set(["2025-01"]));
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
  await setRange(page, "2025-03-01", "2025-03-31");
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
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect.poll(() => requests).toBe(24); // both catalogues page through the window
  await expect(page.locator("#results li")).toHaveCount(12); // merged on display
  await expect(page.locator("#load-next-pages")).toBeHidden();
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
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#status")).toContainText(/failed/i);
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
  await expect(page.locator("#date-from")).toBeVisible();
});

test("left tabs switch between historical and upcoming views", async ({ page }) => {
  await page.route("**/acquisition-plans", (route) => respond(route, { contentType: "text/html", body: "<html></html>" }));
  await page.route("**/search", (route) => respond(route, { json: collection([stacScene("h1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
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
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#results li")).toHaveCount(1);
  await page.locator("#tab-upcoming").click();
  await expect(page.locator("#plans-results li")).toHaveCount(1);
  await expect(page.locator("#map-matrix")).toBeVisible();
  await expect(page.locator("#matrix-svg .matrix-cell").first()).toBeVisible();
});

test("the day matrix plots one 12x12 px cell per day across the loaded year", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, {
    json: collection([stacScene("t1", "2025-03-10T02:00:00Z"), stacScene("t2", "2025-03-10T14:00:00Z"), stacScene("t3", "2025-03-11T02:00:00Z")], [], 3) }));
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#results li")).toHaveCount(3);
  await expect(page.locator("#map-matrix")).toBeVisible();
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]')).toHaveCount(1);
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-11"]')).toHaveCount(1);
  const sizes = await page.locator("#matrix-svg .matrix-cell")
    .evaluateAll((cells) => cells.map((c) => c.getAttribute("width") + "x" + c.getAttribute("height")));
  expect(sizes.length).toBeGreaterThanOrEqual(31); // ≥ one cell per day of the loaded month
  expect([...new Set(sizes)]).toEqual(["12x12"]);
  // A day with no observations still renders a placeholder cell, not a gap.
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-05"]')).toHaveAttribute("fill", "#2f3830");
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]')).not.toHaveAttribute("fill", "#2f3830");
  // Every cell — with or without observations — carries a hover tooltip.
  const allCells = await page.locator("#matrix-svg .matrix-cell").count();
  const titledCells = await page.locator("#matrix-svg .matrix-cell:has(title)").count();
  expect(titledCells).toBe(allCells);
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-05"] title')).toHaveText(/no observations/);
  // Padding days outside the window have no fill, and a month legend sits under the grid.
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-02-25"]')).toHaveAttribute("fill", "transparent");
  await expect(page.locator("#matrix-svg .matrix-month").first()).toHaveText("MAR");
  await expect(page.locator("#matrix-svg .matrix-month")).toHaveCount(1); // only March is in this window
});

test("the matrix data links switch the metric it shows", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, {
    json: collection([stacScene("m1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
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

test("matrix cells are 12x12 px and the matrix scrolls horizontally", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, {
    json: collection([stacScene("t1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setRange(page, "2025-01-01", "2025-12-31");
  await expect(page.locator("#map-matrix")).toBeVisible();
  await expect(page.locator(".matrix-scroll")).toHaveCount(1);
  const sizes = await page.locator("#matrix-svg .matrix-cell")
    .evaluateAll((cells) => cells.map((c) => c.getAttribute("width") + "x" + c.getAttribute("height")));
  expect(sizes.length).toBeGreaterThan(300);
  expect([...new Set(sizes)]).toEqual(["12x12"]);
});

test("the matrix year arrows load the previous/next year", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, {
    json: collection([stacScene("y1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setRange(page, "2025-01-01", "2025-12-31");
  await expect(page.locator("#map-matrix")).toBeVisible();
  await expect(page.locator("#date-from")).toHaveValue("2025-01-01");
  await page.locator("#matrix-next-year").click();
  await expect(page.locator("#date-from")).toHaveValue("2026-01-01");
  await expect(page.locator("#date-to")).toHaveValue("2026-12-31");
  await page.locator("#matrix-prev-year").click();
  await expect(page.locator("#date-from")).toHaveValue("2025-01-01");
  await expect(page.locator("#date-to")).toHaveValue("2025-12-31");
});

test("the matrix stays visible for a year with no observations", async ({ page }) => {
  await page.route("**/search", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const features = String(body.datetime ?? "").startsWith("2025") ? [stacScene("y1", "2025-03-10T02:00:00Z")] : [];
    await respond(route, { json: collection(features, [], features.length) });
  });
  await page.goto("/");
  await setRange(page, "2025-01-01", "2025-12-31");
  await expect(page.locator("#map-matrix")).toBeVisible();
  await page.locator("#matrix-next-year").click();
  await expect(page.locator("#date-from")).toHaveValue("2026-01-01");
  await expect(page.locator("#results li")).toHaveCount(0);
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
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#map-matrix")).toBeVisible();
  for (const id of ["#matrix-prev-year", "#matrix-next-year"]) {
    const box = (await page.locator(id).boundingBox())!;
    const glyph = (await page.locator(id + " .fa-solid").boundingBox())!;
    expect(Math.abs((glyph.x + glyph.width / 2) - (box.x + box.width / 2))).toBeLessThan(1.5);
    expect(Math.abs((glyph.y + glyph.height / 2) - (box.y + box.height / 2))).toBeLessThan(1.5);
    expect(Math.round(box.width)).toBe(Math.round(box.height)); // square
  }
  // Square corners, not pills.
  expect(await page.locator("#matrix-next-year").evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("0px");
  expect(await page.locator("#preview-next").evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("0px");
});

test("clicking a preview overlays the image on the map with prev/next navigation", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  await page.route("https://example.test/**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.route("**/search", (route) => respond(route, { json: collection([
    stacScene("img-a", "2025-03-09T02:00:00Z"), stacScene("img-b", "2025-03-12T02:00:00Z")], [], 2) }));
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#results img")).toHaveCount(2);
  const zoomBefore = Number(new URL(page.url()).searchParams.get("zoom"));
  await page.locator("#results img").first().click();
  await expect(page.locator("#map-preview")).toBeVisible();
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

test("the card and map preview prefer a higher-resolution provider asset", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  await page.route("https://example.test/**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  const scene = stacScene("hq", "2025-03-10T02:00:00Z");
  // A rendered preview (overview role) should win over the small thumbnail.
  scene.assets.rendered_preview = { href: "https://example.test/rendered-hq.png", roles: ["overview"], type: "image/png" };
  await page.route("**/search", (route) => respond(route, { json: collection([scene], [], 1) }));
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#results img")).toHaveCount(1);
  await expect(page.locator("#results img")).toHaveAttribute("src", /rendered-hq\.png/);
});

test("a Landsat-style scene uses the item thumbnail link for its image", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  await page.route("https://example.test/**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  const renderUrls: string[] = [];
  await page.route("https://planetarycomputer.microsoft.com/**", (route) => {
    const url = route.request().url();
    renderUrls.push(url);
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
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#results img")).toHaveCount(1);
  await expect(page.locator("#results img")).toHaveAttribute("src", /LC09_1\/thumbnail/);
  // The map overlay uses the CORS-enabled Planetary Computer render of the same item id.
  await page.locator("#results img").click();
  await expect(page.locator("#map-preview")).toBeVisible();
  // The overlay asks Planetary Computer for the native-resolution tile set, not the PNG.
  await expect.poll(() => renderUrls.some((u) => u.includes("tilejson"))).toBe(true);
});

test("an Earth Search Sentinel-2 scene resolves a native-resolution tile set", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
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
      { id: "S2C_MSIL2A_20250310T020000_R047_T50MRV_20250310T020000", properties: { datetime: "2025-03-10T02:00:00Z" } }] } });
  });
  await page.route("https://planetarycomputer.microsoft.com/api/data/v1/**", (route) => {
    const url = route.request().url();
    requested.push(url);
    return url.includes("tilejson")
      ? respond(route, { json: { tiles: ["https://planetarycomputer.microsoft.com/api/data/v1/item/tiles/x/{z}/{x}/{y}@1x?item=a"], minzoom: 0, maxzoom: 22, tileSize: 256 } })
      : route.fulfill({ contentType: "image/png", body: png });
  });
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
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
  await setRange(page, "2025-03-01", "2025-03-31");
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
  await setRange(page, "2025-03-01", "2025-03-31");
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

test("the More dropdown picks an extra metric", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("m1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#results li")).toHaveCount(1);
  await page.locator("#matrix-more").click();
  await expect(page.locator("#matrix-more-menu")).toBeVisible();
  await page.locator('.matrix-menu-item[data-metric="resolution"]').click();
  await expect(page.locator("#matrix-more-menu")).toBeHidden();
  await expect(page.locator("#matrix-more")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#matrix-more-label")).toHaveText("Resolution");
  await expect(page.locator('.matrix-menu-item[data-metric="resolution"]')).toHaveAttribute("aria-checked", "true");
});

test("the Image/Radar quick filter narrows the view and sits right", async ({ page }) => {
  const optical = stacScene("opt", "2025-03-10T02:00:00Z");
  const radarBase = stacScene("rad", "2025-03-11T02:00:00Z");
  const radar = { ...radarBase, collection: "sentinel-1-rtc",
    properties: { ...radarBase.properties, platform: "sentinel-1c" } };
  await page.route("**/search", (route) => respond(route, { json: collection([optical, radar], [], 2) }));
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
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
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
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
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#collection-filter option", { hasText: "sentinel-1-rtc" })).toHaveCount(1);
  await page.locator("#results img").click();
  await expect(page.locator("#map-preview")).toBeVisible();
  // Radar has no cloud cover, so the cloud metric reports "no cloud metadata" for that day.
  await page.locator('.matrix-link[data-metric="cloud"]').click();
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]')).toHaveAttribute("fill", "#5b665b");
});

test("a provider tile set is used when the scene exposes one", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
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
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#results img")).toHaveCount(1);
  await page.locator("#results img").first().click();
  await expect(page.locator("#map-preview")).toBeVisible();
  await expect.poll(() => tilejsonRequests).toBeGreaterThan(0);
});

test("cloud-cover and hour filters narrow the loaded results", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("f1", "2025-03-10T02:00:00Z"), stacScene("f2", "2025-03-11T02:00:00Z")], [], 2) }));
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#results li")).toHaveCount(2);
  await page.selectOption("#cloud-max", "10"); // scenes are 12.5% cloud
  await expect(page.locator("#results li")).toHaveCount(0);
  await page.selectOption("#cloud-max", "30");
  await expect(page.locator("#results li")).toHaveCount(2);
  await page.selectOption("#hour-min", "12"); // scenes are ~02:00 UTC
  await expect(page.locator("#results li")).toHaveCount(0);
  await page.selectOption("#hour-min", "0");
  await page.selectOption("#hour-max", "6");
  await expect(page.locator("#results li")).toHaveCount(2);
});

test("collection filter, reset, and timeline views", async ({ page }) => {
  const sentinel = stacScene("c1", "2025-03-10T02:00:00Z");
  const landsatBase = stacScene("c2", "2025-03-11T02:00:00Z");
  const landsat = { ...landsatBase, collection: "landsat-c2-l2",
    properties: { ...landsatBase.properties, platform: "landsat-9" } };
  await page.route("**/search", (route) => respond(route, { json: collection([sentinel, landsat], [], 2) }));
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#results li")).toHaveCount(2);
  await page.selectOption("#collection-filter", "landsat-c2-l2");
  await expect(page.locator("#results li")).toHaveCount(1);
  await page.locator("#clear-filters").click();
  await expect(page.locator("#results li")).toHaveCount(2);
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]')).toHaveCount(1);
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-11"]')).toHaveCount(1);
});

test("matrix day cells are keyboard operable", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, { json: collection([
    stacScene("k1", "2025-03-10T02:00:00Z"), stacScene("k2", "2025-03-12T02:00:00Z")], [], 2) }));
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
  await page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#matrix-svg .matrix-cell.selected")).toHaveAttribute("data-day", "2025-03-10");
  // Arrow keys step to the next selectable day; Enter selects it.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("#matrix-svg .matrix-cell.selected")).toHaveAttribute("data-day", "2025-03-12");
  await expect(page.locator("#results li")).toHaveCount(1);
});

test("clicking a matrix cell selects that day without changing the zoom", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, {
    json: collection([stacScene("z1", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
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
  await setRange(page, "2025-03-01", "2025-03-31");
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
