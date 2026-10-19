import { test, expect } from "./offline.js";
import {
  auditDesignSystem,
  auditShell,
} from "@powerpuff-kitty/tcsn-design-system/compliance";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
};
const style = {
  version: 8,
  sources: {
    base: {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      attribution: "Synthetic map attribution",
    },
  },
  layers: [
    {
      id: "base",
      type: "background",
      paint: { "background-color": "#102A43" },
    },
    { id: "data", type: "fill", source: "base", paint: { "fill-opacity": 0 } },
  ],
};
const scenes = {
  type: "FeatureCollection",
  features: [0, 1, 2].map((index) => ({
    type: "Feature",
    id: "shared-synthetic-" + index,
    collection: "sentinel-2-l2a",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [116, -8.7],
          [116.3, -8.7],
          [116.3, -8.4],
          [116, -8.4],
          [116, -8.7],
        ],
      ],
    },
    bbox: [116, -8.7, 116.3, -8.4],
    properties: {
      datetime: "2025-03-10T02:00:00Z",
      platform: "sentinel-2a",
      "eo:cloud_cover": 12.5,
    },
    assets: {},
    links: [],
  })),
  links: [],
};
test.beforeEach(async ({ page }) => {
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.fulfill({ headers: cors, json: style }),
  );
  await page.route("**/search", (route) =>
    route.fulfill({ headers: cors, json: scenes }),
  );
  await page.route("**/acquisition-plans", (route) =>
    route.fulfill({
      headers: cors,
      contentType: "text/html",
      body: "<html></html>",
    }),
  );
});

for (const width of [320, 390, 768, 1280, 1440]) {
  test(`shared satellite shell, controls and local Font Awesome at ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/?date=2025-03-10");
    await expect(page.locator("#app-header .tcsn-brand")).toHaveText(
      "satellite images.",
    );
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator("#status")).toHaveText("");
    await expect(page.locator("#map-credits")).toContainText(
      "Synthetic map attribution",
    );
    await expect(
      page.locator("#app-footer .tcsn-footer__copyright"),
    ).toHaveText(`© ${new Date().getFullYear()} TCSN`);
    await expect(page.locator("#app-footer nav a")).toHaveText(["Contact"]);
    const support = page.locator("#app-footer .tcsn-support-button");
    await expect(support).toHaveAttribute(
      "href",
      "https://buy.stripe.com/3cI00dccs37i3Ftad73oA00",
    );
    await expect(support.locator(".tcsn-icon")).toHaveCount(1);
    await expect(
      page.locator(".firefly-settings,.tcsn-firefly-plane"),
    ).toHaveCount(0);
    await expect(page.locator("main select:visible")).toHaveCount(0);
    await expect(page.locator("#results .tcsn-description-list")).toHaveCount(
      3,
    );
    await expect(
      page.locator("#results .tcsn-description-list").first(),
    ).toContainText("12.5% (scene-wide)");
    await expect(page.locator(".tcsn-scroll-region")).toHaveCount(3);
    await expect(
      page.locator("#sources.tcsn-panel > .tcsn-panel__body"),
    ).toHaveCount(1);
    await expect(
      page.locator(".maplibregl-ctrl-zoom-in .tcsn-icon"),
    ).toHaveCount(1);
    await expect(
      page.locator("main use[href*='icons.svg'],main .fa-solid"),
    ).toHaveCount(0);
    await page.locator(".maplibregl-ctrl-zoom-in").focus();
    expect(
      await page
        .locator(".maplibregl-ctrl-zoom-in")
        .evaluate((element) => getComputedStyle(element).boxShadow),
    ).toBe("none");
    expect(
      await page
        .locator(".maplibregl-ctrl-zoom-in .maplibregl-ctrl-icon")
        .evaluate((element) => getComputedStyle(element).backgroundImage),
    ).toBe("none");
    expect(await page.evaluate(auditShell)).toMatchObject({ status: "passed" });
    expect(await page.evaluate(auditDesignSystem)).toMatchObject({
      status: "passed",
    });
    const geometry = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      colours: [
        getComputedStyle(document.body).backgroundColor,
        getComputedStyle(document.body).color,
      ],
      maxWidth: getComputedStyle(document.querySelector("main")!).maxWidth,
    }));
    expect(geometry).toEqual({
      overflow: false,
      colours: ["rgb(237, 244, 247)", "rgb(16, 42, 67)"],
      maxWidth: "2400px",
    });
    if (width <= 760) {
      const finalCard = await page
        .locator("#results > li")
        .last()
        .boundingBox();
      const footerBox = await page.locator("#app-footer").boundingBox();
      expect(finalCard).not.toBeNull();
      expect(footerBox!.y).toBeGreaterThanOrEqual(
        finalCard!.y + finalCard!.height,
      );
    }
    const button = page.locator("#draw-area");
    await button.scrollIntoViewIfNeeded();
    const before = await button.boundingBox();
    await button.hover();
    const after = await button.boundingBox();
    expect(after).toEqual(before);
    expect(errors).toEqual([]);
  });
}

test("visible dropdown keyboard updates the underlying query and resets", async ({
  page,
}) => {
  await page.goto("/?date=2025-03-10");
  const radius = page.locator("#radius").locator("..").getByRole("combobox");
  await radius.focus();
  await radius.press("ArrowDown");
  await radius.press("End");
  await radius.press("Enter");
  await expect(page.locator("#radius")).toHaveValue("25000");
  await expect(radius).toHaveText(/25 km/);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("radius"))
    .toBe("25000");
  await radius.click();
  await expect(radius).toHaveAttribute("aria-expanded", "true");
  await radius.press("Escape");
  await expect(radius).toHaveAttribute("aria-expanded", "false");
  await expect(radius).toBeFocused();
});

test("tab keyboard activation runs the actual upcoming catalogue state", async ({
  page,
}) => {
  await page.goto("/?date=2025-03-10");
  await page.locator("#tab-historical").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#tab-upcoming")).toBeFocused();
  await expect(page.locator("#tab-upcoming")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#obs-title")).toHaveText(
    "Upcoming planned acquisitions",
  );
  await expect(page.locator("#panel-upcoming")).toBeVisible();
});

test("unknown scan totals use mounted task status and indeterminate progress", async ({
  page,
}) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/search", async (route) => {
    if (route.request().method() !== "OPTIONS") await waiting;
    return route.fulfill({
      headers: cors,
      json: { type: "FeatureCollection", features: [], links: [] },
    });
  });
  await page.goto("/?date=2025-03-10");
  const status = await page.locator("#status").elementHandle();
  const progress = page.locator("#status-progress");
  await expect(page.locator("#status-task")).toHaveAttribute(
    "data-busy",
    "true",
  );
  await expect(progress).toBeVisible();
  expect(await progress.getAttribute("value")).toBeNull();
  await expect(
    page.locator("#status-task [data-tcsn-action=cancel]"),
  ).toHaveCount(0);
  release();
  await expect(progress).toBeHidden();
  await expect(page.locator("#status-task")).toHaveAttribute(
    "data-busy",
    "false",
  );
  expect(await status!.evaluate((node) => node.isConnected)).toBe(true);
  await expect(page.locator("#results .tcsn-empty-state")).toContainText(
    "No observations",
  );
  await expect(
    page.locator(
      "#results .tcsn-empty-state [role=status],#results .tcsn-empty-state [role=alert]",
    ),
  ).toHaveCount(0);
});
