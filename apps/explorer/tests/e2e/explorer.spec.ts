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
const nextLink = (token: string) => ({
  rel: "next", href: "https://earth-search.aws.element84.com/v1/search", method: "POST", body: { token },
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
    const links = index < 1 ? [nextLink(String(index + 1))] : [];
    await respond(route, { json: collection(features, links, features.length) });
  });
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#results li")).toHaveCount(2);
  await expect(page.locator("#counter")).toHaveText("2");
  await expect(page.locator(".day-cell.has-scenes")).toHaveCount(2);
});

test("month navigation issues a narrowed month search", async ({ page }) => {
  const months: string[] = [];
  await page.route("**/search", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    months.push(String(body.datetime ?? "").slice(0, 7));
    await respond(route, { json: collection([], [], 0) });
  });
  await page.goto("/");
  await setRange(page, "2025-01-01", "2025-03-31");
  await expect.poll(() => months.at(-1)).toBe("2025-01");
  await page.getByRole("button", { name: /Search next month/ }).click();
  await expect.poll(() => months.at(-1)).toBe("2025-04");
});

test("the form defaults to the full calendar year", async ({ page }) => {
  await page.goto("/");
  const year = new Date().toISOString().slice(0, 4);
  await expect(page.locator("#date-from")).toHaveValue(year + "-01-01");
  await expect(page.locator("#date-to")).toHaveValue(year + "-12-31");
});

test("a year is fetched in a single request", async ({ page }) => {
  const starts: string[] = [];
  await page.route("**/search", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    starts.push(String(body.datetime ?? "").slice(0, 7));
    await respond(route, { json: collection([], [], 0) });
  });
  await page.goto("/");
  await setRange(page, "2025-01-01", "2025-12-31");
  await expect.poll(() => starts.length).toBe(1);
  expect(starts).toEqual(["2025-01"]);
});

test("selecting a calendar day filters the result cards", async ({ page }) => {
  await page.route("**/search", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const index = body.token ? Number(body.token) : 0;
    const features = index === 0 ? [stacScene("s10", "2025-03-10T02:00:00Z")]
      : index === 1 ? [stacScene("s11", "2025-03-11T02:00:00Z")] : [];
    const links = index < 1 ? [nextLink(String(index + 1))] : [];
    await respond(route, { json: collection(features, links, features.length) });
  });
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#results li")).toHaveCount(2);
  await page.locator(".day-cell.has-scenes").first().click();
  await expect(page.locator(".day-cell.selected")).toHaveCount(1);
  await expect(page.locator("#results li")).toHaveCount(1);
});

test("a search loads every page of its window up front", async ({ page }) => {
  let requests = 0;
  await page.route("**/search", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const index = body.token ? Number(body.token) : 0;
    requests += 1;
    const links = index < 11 ? [nextLink(String(index + 1))] : [];
    await respond(route, { json: collection([stacScene("p" + index, "2025-03-05T02:00:00Z")], links, 12) });
  });
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect.poll(() => requests).toBe(12);
  await expect(page.locator("#results li")).toHaveCount(12);
  await expect(page.locator("#load-next-pages")).toBeHidden();
});

test("a mid-scan catalogue failure is reported and keeps partial results", async ({ page }) => {
  let requests = 0;
  await page.route("**/search", async (route) => {
    requests += 1;
    if (requests === 1) {
      return respond(route, { json: collection([stacScene("ok", "2025-03-07T02:00:00Z")], [nextLink("1")], 5) });
    }
    return respond(route, { status: 429, body: "rate limited", contentType: "text/plain" });
  });
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#status")).toContainText(/failed/i);
});

test("deep link restores the location, range and selected day and replays the search", async ({ page }) => {
  await page.route("**/search", (route) =>
    respond(route, { json: collection([stacScene("d", "2025-03-10T02:00:00Z")], [], 1) }));
  await page.goto("/?lat=1.35210&lon=103.81980&radius=5000&provider=earth-search&from=2025-03-01&to=2025-03-31&day=2025-03-10");
  await expect(page.locator("#latitude")).toHaveValue("1.35210");
  await expect(page.locator(".day-cell.selected")).toHaveCount(1);
  await expect(page.locator("#results li")).toHaveCount(1);
});

test("calendar days are keyboard operable", async ({ page }) => {
  await page.route("**/search", (route) =>
    respond(route, { json: collection([stacScene("k", "2025-03-12T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
  const cell = page.locator(".day-cell.has-scenes").first();
  await cell.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".day-cell.selected")).toHaveCount(1);
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

test("clicking a preview overlays the image on the map with prev/next navigation", async ({ page }) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  await page.route("https://example.test/**", (route) => route.fulfill({ contentType: "image/png", body: png }));
  await page.route("**/search", (route) => respond(route, { json: collection([
    stacScene("img-a", "2025-03-09T02:00:00Z"), stacScene("img-b", "2025-03-12T02:00:00Z")], [], 2) }));
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator("#results img")).toHaveCount(2);
  await page.locator("#results img").first().click();
  await expect(page.locator("#map-preview")).toBeVisible();
  const firstCaption = (await page.locator("#preview-caption").textContent()) ?? "";
  expect(firstCaption.length).toBeGreaterThan(0);
  await page.locator("#preview-next").click();
  await expect(page.locator("#preview-caption")).not.toHaveText(firstCaption);
  await page.locator("#preview-prev").click();
  await expect(page.locator("#preview-caption")).toHaveText(firstCaption);
  await page.keyboard.press("Escape");
  await expect(page.locator("#map-preview")).toBeHidden();
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

test("clicking a matrix cell selects that day (does not deselect)", async ({ page }) => {
  await page.route("**/search", (route) => respond(route, { json: collection(
    [stacScene("b1", "2025-03-10T02:00:00Z"), stacScene("b2", "2025-03-12T02:00:00Z")], [], 2) }));
  await page.goto("/");
  await setRange(page, "2025-03-01", "2025-03-31");
  await expect(page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]')).toBeVisible();
  await page.locator('#matrix-svg .matrix-cell[data-day="2025-03-10"]').click();
  await expect(page.locator(".day-cell.selected")).toHaveCount(1);
  await expect(page.locator(".day-cell.selected")).toHaveAttribute("aria-label", /2025-03-10/);
  await page.locator('#matrix-svg .matrix-cell[data-day="2025-03-12"]').click();
  await expect(page.locator(".day-cell.selected")).toHaveCount(1);
  await expect(page.locator(".day-cell.selected")).toHaveAttribute("aria-label", /2025-03-12/);
});
