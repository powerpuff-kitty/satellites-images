import { test, expect } from "@playwright/test";

// Temporary capture harness: takes a screenshot of the LIVE explorer for the README.
// Run with LIVE=1; not part of the committed suite's default run.
test.skip(!process.env.LIVE, "opt-in: run with LIVE=1");

test("capture the live explorer", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 940 });
  await page.goto("/");
  await page.locator("#latitude").fill("-8.5833");
  await page.locator("#longitude").fill("116.1167");
  await page.locator("#date-from").fill("2025-05-01");
  await page.locator("#date-to").fill("2025-05-31");
  await page.locator("#date-to").dispatchEvent("change");
  await expect.poll(async () => page.locator("#results li").count(), { timeout: 90_000 })
    .toBeGreaterThan(0);
  await expect(page.locator("#coverage")).toContainText(/earth-search/, { timeout: 90_000 });
  // Put an image on the map so the screenshot shows the overlay, footprint and highlight.
  await page.locator("#results img").first().click();
  await expect(page.locator("#map-preview")).toBeVisible();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: "../../docs/assets/explorer.png" });
  console.log("saved docs/assets/explorer.png |", await page.locator("#coverage").textContent());
});
