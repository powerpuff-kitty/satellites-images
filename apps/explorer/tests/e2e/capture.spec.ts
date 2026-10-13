import { test, expect } from "@playwright/test";

// Opt-in capture harness for the README screenshot (writes docs/assets/explorer.png;
// convert to .jpg when the PNG is heavy).
// It uses the LIVE public catalogues, so the image reflects real behaviour, not fixtures.
//
//   LIVE=1 npm run test:e2e -w @satellites-images/explorer -- --grep "capture the live explorer"
test.skip(!process.env.LIVE, "opt-in: run with LIVE=1");

test("capture the live explorer", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 940 });
  await page.goto("/");
  // The view used in the README: a Landsat scene over Sumbawa with a full-year window.
  await page.locator("#latitude").fill("-8.5833");
  await page.locator("#longitude").fill("116.1170");
  await page.locator("#date-from").fill("2026-01-01");
  await page.locator("#date-to").fill("2026-12-31");
  await page.locator("#date-to").dispatchEvent("change");
  await expect.poll(async () => page.locator("#results li").count(), { timeout: 120_000 })
    .toBeGreaterThan(0);
  await expect(page.locator("#coverage")).toContainText(/planetary-computer|earth-search/, { timeout: 120_000 });
  await page.waitForTimeout(3000);
  // Put the newest image on the map so the screenshot shows the overlay, footprint and card.
  await page.locator("#results img").first().click();
  await expect(page.locator("#map-preview")).toBeVisible();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: "../../docs/assets/explorer.png" });
  console.log("saved docs/assets/explorer.png |", await page.locator("#coverage").textContent());
});
