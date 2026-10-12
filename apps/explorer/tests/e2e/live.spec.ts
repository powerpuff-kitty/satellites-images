import { test, expect } from "@playwright/test";

// Opt-in live check: makes REAL requests to the public catalogues (nothing is intercepted).
// It is skipped unless LIVE=1, so `npm run test:e2e` stays fully mocked and offline-safe.
//
//   LIVE=1 npm run test:e2e -w @satellites-images/explorer -- --grep "live search"
test.skip(!process.env.LIVE, "opt-in: run with LIVE=1");

test("live search returns scenes, a coverage rollup and no page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto("/");
  await page.locator("#latitude").fill("-8.5833");
  await page.locator("#longitude").fill("116.1167");
  // One month keeps the live load small; the app fetches the whole window by default.
  await page.locator("#date-from").fill("2025-05-01");
  await page.locator("#date-to").fill("2025-05-31");
  await page.locator("#date-to").dispatchEvent("change");

  await expect.poll(async () => page.locator("#results li").count(), { timeout: 90_000 })
    .toBeGreaterThan(0);
  // Wait for the scan to settle: both default catalogues should report before we read the
  // rollup (the first page can land well before the second catalogue responds).
  await expect(page.locator("#coverage")).toContainText(/earth-search/, { timeout: 90_000 });

  const coverage = await page.locator("#coverage").textContent();
  const status = await page.locator("#status").textContent();
  console.log("   coverage:", coverage);
  console.log("   status:  ", status);
  console.log("   cards:   ", await page.locator("#results li").count());

  expect(coverage).toMatch(/observations? shown/);

  // Draw an area over the same view and search it: results must still appear.
  await page.locator("#draw-area").click();
  const map = (await page.locator("#map").boundingBox())!;
  const cx = map.x + map.width / 2, cy = map.y + map.height / 2;
  await page.mouse.click(cx - 60, cy - 60);
  await page.mouse.click(cx + 60, cy - 60);
  await page.mouse.click(cx + 60, cy + 60);
  await page.mouse.click(cx - 60, cy + 60);
  await page.locator("#draw-area").click();
  await expect.poll(async () => page.locator("#results li").count(), { timeout: 90_000 })
    .toBeGreaterThan(0);
  console.log("   area:", await page.locator("#coverage").textContent());

  expect(errors).toEqual([]);
});
