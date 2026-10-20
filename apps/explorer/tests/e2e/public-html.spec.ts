import { test, expect } from "./offline.js";

// Response HTML must be useful and share the authored controls before enhancement.
test.use({ javaScriptEnabled: false });

for (const width of [390, 1440]) {
  test(`public HTML and initial controls without JavaScript at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/?lat=1&lon=2&radius=5000");
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://satellite.tcsn.io/");
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", "https://satellite.tcsn.io/");
    const schema = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent() ?? "null");
    expect(schema).toMatchObject({ "@type": "WebApplication", url: "https://satellite.tcsn.io/" });
    await expect(page.locator("#app-header .tcsn-brand")).toHaveText("satellite images.");
    await expect(page.locator("#app-header .tcsn-support-button svg")).toHaveCount(1);
    await expect(page.locator("#sidebar-copyright")).toHaveText(`© ${new Date().getFullYear()} TCSN`);
    await expect(page.locator("footer.tcsn-footer")).toHaveCount(0); // Documented GIS layout.
    await expect(page.getByRole("heading", { level: 1 })).toBeInViewport();
    await expect(page.locator("#map-container")).toBeHidden();
    await page.getByText("About the data and methods", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Published observations and acquisition plans" })).toBeVisible();
    await expect(page.locator(".explorer-about")).toContainText("not images that already exist");
    const geometry = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const pair = [body.backgroundColor, body.color];
      const controls = [...document.querySelectorAll<HTMLInputElement>("input:not([type=hidden]),select,button")]
        .filter(element => element.checkVisibility())
        .map(element => {
          const style = getComputedStyle(element);
          return { id: element.id, type: element.type, classes: element.className, colour: style.color, background: style.backgroundColor, font: style.fontFamily, height: element.getBoundingClientRect().height };
        });
      return { pair, controls, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.pair).toEqual(["rgb(16, 42, 67)", "rgb(237, 244, 247)"]);
    for (const control of geometry.controls) {
      expect(control.font, control.id).toContain("Geist");
      if (["checkbox", "radio", "range"].includes(control.type)) continue;
      expect(control.classes, control.id).toMatch(/tcsn-(input|button|support-button|file)/);
      expect(geometry.pair, control.id).toContain(control.colour);
      expect(geometry.pair, control.id).toContain(control.background);
      expect(control.height, control.id).toBeGreaterThanOrEqual(32);
    }
  });
}
