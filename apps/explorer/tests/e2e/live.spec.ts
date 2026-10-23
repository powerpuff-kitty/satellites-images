import { test, expect } from "@playwright/test";

// Opt-in live check: makes REAL requests to the public catalogues (nothing is intercepted).
// It is skipped unless LIVE=1, so `npm run test:e2e` stays fully mocked and offline-safe.
//
//   LIVE=1 npm run test:e2e -w @satellites-images/explorer -- --grep "live search"
test.skip(!process.env.LIVE, "opt-in: run with LIVE=1");

test("live search returns scenes and no page errors", async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  // A permalink performs one search through the same date control the user sees.
  await page.goto("/?lat=-8.5833&lon=116.1167&radius=5000&date=2025-05-10");
  await expect(page.locator("#date")).toHaveValue("2025-05-10");
  const allDays = page.locator("#show-all-days");
  await expect(allDays).toBeVisible({ timeout: 90_000 });
  await allDays.click();

  await expect.poll(async () => page.locator("#results li").count(), { timeout: 90_000 })
    .toBeGreaterThan(0);
  // Wait for the scan to settle before reading results.
  await expect(page.locator("#results")).toContainText(/earth-search/, { timeout: 90_000 });
  await expect(page.locator("#status")).toHaveText("", { timeout: 90_000 });

  const status = await page.locator("#status").textContent();
  console.log("   status:  ", status);
  console.log("   cards:   ", await page.locator("#results li").count());


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
  await expect(page.locator("#status")).toHaveText("", { timeout: 90_000 });
  console.log("   area:", await page.locator("#counter").textContent());

  expect(errors).toEqual([]);
});
