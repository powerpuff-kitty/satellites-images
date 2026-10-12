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

/** Fulfil a cross-origin request with CORS, handling the browser's preflight. */
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

test.beforeEach(async ({ page }) => {
  await page.route("https://demotiles.maplibre.org/**", (route) => respond(route, { json: MAP_STYLE }));
});

test("coordinate search builds a calendar and filters by day", async ({ page }) => {
  await page.route("**/search", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const month = String(body.datetime ?? "2025-01-01").slice(0, 7);
    const index = body.token ? Number(body.token) : 0;
    const features = index === 0 ? [stacScene("s10", month + "-10T02:00:00Z")]
      : index === 1 ? [stacScene("s11", month + "-11T02:00:00Z")] : [];
    const links = index < 1 ? [nextLink(String(index + 1))] : [];
    await respond(route, { json: collection(features, links, features.length) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Find observations/ }).click();
  await expect(page.locator("#results li")).toHaveCount(2);
  await expect(page.locator("#counter")).toHaveText("2");
  const day10 = page.locator('.calendar-day[data-date$="-10"]');
  await expect(day10).toHaveClass(/has-data/);
  await day10.click();
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#selected-day")).toHaveValue(/-10$/);
  await expect(page.locator("#calendar-status")).toContainText(/scene/);
});

test("month navigation re-queries and rebuilds the calendar", async ({ page }) => {
  const months: string[] = [];
  await page.route("**/search", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const month = String(body.datetime ?? "2025-01-01").slice(0, 7);
    months.push(month);
    await respond(route, { json: collection([stacScene("m", month + "-05T02:00:00Z")], [], 1) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Find observations/ }).click();
  await expect(page.locator("#results li")).toHaveCount(1);
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(page.locator("#month-label")).toHaveText(/February 2025/);
  await expect.poll(() => months.at(-1)).toBe("2025-02");
  await expect(page.locator('.calendar-day[data-date="2025-02-05"]')).toHaveClass(/has-data/);
});

test("scan-next-five extends pagination without restarting", async ({ page }) => {
  let requests = 0;
  await page.route("**/search", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const index = body.token ? Number(body.token) : 0;
    requests += 1;
    await respond(route, { json: collection([stacScene("p" + index, "2025-01-05T02:00:00Z")], [nextLink(String(index + 1))], 100) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Find observations/ }).click();
  await expect.poll(() => requests).toBe(5);
  await expect(page.locator("#scan-status")).toContainText(/5 page\(s\) loaded/);
  await page.getByRole("button", { name: /Scan 5 more pages/ }).click();
  await expect.poll(() => requests).toBe(10);
  await expect(page.locator("#scan-status")).toContainText(/10 page\(s\) loaded/);
});

test("a mid-scan source failure preserves partial results with explicit wording", async ({ page }) => {
  let requests = 0;
  await page.route("**/search", async (route) => {
    requests += 1;
    if (requests === 1) {
      return respond(route, { json: collection([stacScene("ok", "2025-01-07T02:00:00Z")], [nextLink("1")], 5) });
    }
    return respond(route, { status: 429, body: "rate limited", contentType: "text/plain" });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Find observations/ }).click();
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#status")).toContainText(/partial results/i);
});

test("deep link restores location and day and replays the query", async ({ page }) => {
  await page.route("**/search", (route) =>
    respond(route, { json: collection([stacScene("d", "2025-01-10T02:00:00Z")], [], 1) }));
  await page.goto("/?lat=1.35210&lon=103.81980&r=5000&provider=earth-search&from=2025-01-01&to=2025-01-31&day=2025-01-10");
  await expect(page.locator("#latitude")).toHaveValue("1.35210");
  await expect(page.locator("#selected-day")).toHaveValue("2025-01-10");
  await expect(page.locator("#results li")).toHaveCount(1);
});

test("failed preview images are removed", async ({ page }) => {
  await page.route("https://example.test/**", (route) => route.fulfill({ status: 404, body: "" }));
  await page.route("**/search", (route) =>
    respond(route, { json: collection([stacScene("img", "2025-01-09T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await page.getByRole("button", { name: /Find observations/ }).click();
  await expect(page.locator("#results li")).toHaveCount(1);
  await expect(page.locator("#results img")).toHaveCount(0);
});

test("calendar days are keyboard operable", async ({ page }) => {
  await page.route("**/search", (route) =>
    respond(route, { json: collection([stacScene("k", "2025-01-12T02:00:00Z")], [], 1) }));
  await page.goto("/");
  await page.getByRole("button", { name: /Find observations/ }).click();
  const cell = page.locator('.calendar-day[data-date="2025-01-12"]');
  await cell.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#selected-day")).toHaveValue("2025-01-12");
});

test("responsive viewport keeps the search form usable", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 820 });
  await page.route("**/search", (route) => respond(route, { json: collection([], [], 0) }));
  await page.goto("/");
  await expect(page.locator("#search-form")).toBeVisible();
  await expect(page.getByRole("button", { name: /Find observations/ })).toBeVisible();
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
  await page.getByRole("button", { name: /Find upcoming observations/ }).click();
  await expect(page.locator("#plans-results li")).toHaveCount(1);
  await expect(page.locator("#plans-results li")).toContainText(/planned/);
  await expect(page.locator("#plans-status")).toContainText(/planned datatake/);
});
