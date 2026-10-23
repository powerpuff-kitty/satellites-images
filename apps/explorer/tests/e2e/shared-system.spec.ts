import { test, expect } from "./offline.js";
import { auditDesignSystem } from "@powerpuff-kitty/tcsn-design-system/compliance";

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
    assets: {
      tilejson: {
        href: "https://example.test/native-tilejson.json",
        roles: ["tiles"],
        type: "application/json",
      },
    },
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
    await expect(page.locator(".panel #sidebar-copyright")).toHaveText(
      `© ${new Date().getFullYear()} TCSN`,
    );
    await expect(page.locator("#app-header nav a")).toHaveText([
      "Contact",
      "Buy me a hot chocolate",
    ]);
    await expect(
      page.getByRole("link", { name: "Contact", exact: true }),
    ).toHaveAttribute("href", "https://tcsn.io/contact");
    await expect(page.getByRole("link", { name: "Source code" })).toHaveCount(
      0,
    );
    await expect(
      page.locator("footer,#sources,#paid-maps,#tiles-only,#coverage"),
    ).toHaveCount(0);
    const support = page.locator("#app-header .tcsn-support-button");
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
      page.locator(".maplibregl-ctrl-zoom-in .tcsn-icon"),
    ).toHaveCount(1);
    await expect(
      page.locator("main use[href*='icons.svg'],main .fa-solid"),
    ).toHaveCount(0);
    for (const button of await page
      .locator(".maplibregl-ctrl button:visible,.matrix-year-button:visible")
      .all()) {
      await expect(button).toHaveAttribute("data-size", "sm");
      await expect(button).toHaveAttribute("data-appearance", "icon");
      const box = (await button.boundingBox())!;
      expect(box.width).toBe(32);
      expect(box.height).toBe(32);
    }
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
    // The owner-requested sidebar copyright replaces the design system's full footer.
    // Check the retained header geometry directly; auditShell requires a full footer.
    const headerGeometry = await page.evaluate(() => {
      const nav = document
        .querySelector("#app-header nav")!
        .getBoundingClientRect();
      const bar = document.querySelector("#app-header .tcsn-shell__bar")!;
      const box = bar.getBoundingClientRect();
      return {
        navRight: nav.right,
        contentRight:
          box.right - parseFloat(getComputedStyle(bar).paddingRight),
      };
    });
    expect(
      Math.abs(headerGeometry.navRight - headerGeometry.contentRight),
    ).toBeLessThan(1);
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
      colours: ["rgb(16, 42, 67)", "rgb(237, 244, 247)"],
      maxWidth: "2400px",
    });
    const button = page.locator("#draw-area");
    await button.scrollIntoViewIfNeeded();
    const before = await button.boundingBox();
    await button.hover();
    const after = await button.boundingBox();
    expect(after).toEqual(before);
    const latitude = page.locator("#latitude");
    await page.keyboard.press("Tab");
    await latitude.focus();
    const focus = await latitude.evaluate((input) => {
      const style = getComputedStyle(input);
      return {
        outline: style.outlineStyle,
        border: style.borderTopWidth,
        shadow: style.boxShadow,
        weight: style.fontWeight,
        label: getComputedStyle(
          input.closest("label")!.querySelector(".tcsn-field__label")!,
        ).textDecorationLine,
        visible: input.matches(":focus-visible"),
      };
    });
    expect(focus).toEqual({
      outline: "none",
      border: "0px",
      shadow: "none",
      weight: "400",
      label: "underline",
      visible: true,
    });
    await page.emulateMedia({ forcedColors: "active" });
    const systemFocus = await latitude.evaluate((input) => ({
      outline: getComputedStyle(input).outlineStyle,
      width: getComputedStyle(input).outlineWidth,
    }));
    expect(systemFocus).toEqual({ outline: "solid", width: "2px" });
    await page.emulateMedia({ forcedColors: "none" });
    expect(errors).toEqual([]);
  });
}

for (const width of [390, 1920]) {
  test(`calendar shares one compact surface with grid-aligned arrows at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1080 });
    await page.goto("/?date=2025-03-10");
    await expect(
      page.locator("#matrix-svg .matrix-cell").first(),
    ).toBeVisible();
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector("#map-matrix")!;
      const head = document.querySelector("#matrix-head")!;
      const grid = document.querySelector(".matrix-scroll")!;
      const arrow = document.querySelector("#matrix-prev-year")!;
      const main = document.querySelector("main")!;
      const cells = [...document.querySelectorAll("#matrix-svg .matrix-cell")];
      return {
        headInside: panel.contains(head),
        gridInside: panel.contains(grid),
        panelFill: getComputedStyle(panel).backgroundColor,
        headFill: getComputedStyle(head).backgroundColor,
        gridFill: getComputedStyle(grid).backgroundColor,
        gap:
          grid.getBoundingClientRect().top -
          head.getBoundingClientRect().bottom,
        arrowTop: arrow.getBoundingClientRect().top,
        gridTop: Math.min(
          ...cells.map((cell) => cell.getBoundingClientRect().top),
        ),
        arrowRight: arrow.getBoundingClientRect().right,
        panelLeft: panel.getBoundingClientRect().left,
        pagePadding: getComputedStyle(main).paddingBottom,
        pageMargin: getComputedStyle(main).marginBottom,
        mapBottom: document
          .querySelector("#map-container")!
          .getBoundingClientRect().bottom,
        viewportBottom: innerHeight,
      };
    });
    expect(geometry.headInside && geometry.gridInside).toBe(true);
    expect(geometry.panelFill).toBe("rgb(237, 244, 247)");
    expect(geometry.headFill).toBe("rgba(0, 0, 0, 0)");
    expect(geometry.gridFill).toBe("rgba(0, 0, 0, 0)");
    expect(geometry.gap).toBeGreaterThanOrEqual(0);
    expect(geometry.gap).toBeLessThanOrEqual(4);
    expect(Math.abs(geometry.arrowTop - geometry.gridTop)).toBeLessThan(1);
    expect(geometry.arrowRight).toBeLessThanOrEqual(geometry.panelLeft);
    expect(geometry.pagePadding).toBe("0px");
    expect(geometry.pageMargin).toBe("0px");
    if (width > 1200)
      expect(
        Math.abs(geometry.mapBottom - geometry.viewportBottom),
      ).toBeLessThan(1);
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
  const tabs = page.getByRole("tablist", { name: "Observation type" });
  await expect(tabs).toHaveCSS("border-top-width", "1px");
  await expect(tabs).toHaveCSS("border-bottom-width", "1px");
  await expect(tabs.locator(".tcsn-segments__indicator")).toHaveCount(1);
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

for (const width of [390, 1440]) {
  test(`shared date picker opens from its icon and preserves typed dates at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/?date=2025-03-10");
    const editor = page.getByRole("textbox", { name: "Date", exact: true });
    await expect(editor).toHaveValue("2025-03-10");
    const trigger = page.locator(".tcsn-date__toggle");
    await trigger.click();
    const calendar = page.locator(".tcsn-date__panel[role=dialog]");
    await expect(calendar).toBeVisible();
    const box = await calendar.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(calendar).toBeHidden();
    await expect(trigger).toBeFocused();
    await editor.fill("2025-03-11");
    await editor.press("Tab");
    await expect(page.locator("#date")).toHaveValue("2025-03-11");
    await expect(page.locator("#date-from")).toHaveValue("2025-01-01");
    await page.locator("#matrix-next-year").click();
    await expect(editor).toHaveValue("2026-03-11");
  });
}
