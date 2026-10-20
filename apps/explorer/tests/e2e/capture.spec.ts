import { test, expect } from "@playwright/test";

// Opt-in live catalogue capture. Images/previews are blocked: this records actual
// catalogue metadata and vector-map context without downloading satellite imagery.
// LIVE=1 npm run test:e2e -w @satellites-images/explorer -- --grep "capture the live explorer"
test.skip(!process.env.LIVE, "opt-in: run with LIVE=1");

test("capture the live explorer", async ({ page }) => {
  test.setTimeout(90_000);
  let blockedImages = 0;
  await page.route("**/*", route => {
    const request = route.request();
    if (request.resourceType() === "image" || /\.(?:tiff?|jp2|png|jpe?g|webp|avif)(?:\?|$)/i.test(request.url())) {
      blockedImages++;
      return route.abort();
    }
    return route.continue();
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  const until = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  await page.goto(`/?lat=-8.58330&lon=116.11700&date=${until}`);
  await page.addStyleTag({ content: "#results .preview-thumbnail { display: none !important; }" });
  await expect(page.locator("#status")).toHaveText("", { timeout: 30_000 });
  const allDays = page.locator("#show-all-days");
  if (await allDays.isVisible()) await allDays.click();
  await expect.poll(async () => page.locator("#results li:not(.empty)").count(), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(page.locator("#coverage")).toContainText(/planetary-computer|earth-search/);
  await expect(page.locator("#map-preview")).toBeHidden();
  await page.evaluate(async () => {
    await document.fonts.ready;
    document.querySelector(".panel")!.scrollTop = 0;
    window.scrollTo(0, 0);
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  });
  await expect(page.locator("h1")).toBeInViewport();
  await page.screenshot({ path: "../../docs/assets/explorer.jpg", type: "jpeg", quality: 86, fullPage: true });
  console.log(JSON.stringify({ screenshot: "docs/assets/explorer.jpg", view: "Live catalogue metadata; imagery downloads blocked", blockedImageRequests: blockedImages, scenes: await page.locator("#results li:not(.empty)").count(), coverage: await page.locator("#coverage").textContent() }));
});
