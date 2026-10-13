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
  // The view used in the README: a scene over Sumbawa with the default full-year window.
  await page.locator("#latitude").fill("-8.5833");
  await page.locator("#longitude").fill("116.1170");
  await page.locator("#date-from").fill("2026-01-01");
  await page.locator("#date-to").fill("2026-12-31");
  await page.locator("#date-to").dispatchEvent("change");
  await expect.poll(async () => page.locator("#results li").count(), { timeout: 25_000 })
    .toBeGreaterThan(0);
  await expect(page.locator("#coverage")).toContainText(/planetary-computer|earth-search/, { timeout: 25_000 });
  await page.waitForTimeout(2000);
  // Put an image on the map so the screenshot shows the overlay, footprint and card. Prefer an
  // optical scene the tile service has already ingested: the overlay uses Planetary Computer's
  // tile set, which lags the live catalogues by a day or two, so the newest scene can have no
  // displayable raster. An optical tile also fits inside the view, leaving map context visible.
  const cutoff = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const index = await page.locator("#results li").evaluateAll((nodes, args) => {
    const [limit, collection] = args as [string, string];
    return nodes.findIndex((node) => {
      const acquired = (node.querySelector("time") as HTMLTimeElement | null)?.dateTime ?? "";
      return acquired !== "" && acquired.slice(0, 10) <= limit && (node.textContent ?? "").includes(collection);
    });
  }, [cutoff, "sentinel-2-l2a"] as [string, string]);
  expect(index).toBeGreaterThanOrEqual(0);
  await page.locator("#results img").nth(index).click();
  await expect(page.locator("#map-preview")).toBeVisible();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: "../../docs/assets/explorer.png" });
  console.log("saved docs/assets/explorer.png |", await page.locator("#coverage").textContent(),
    "| overlay index", index, "for cutoff", cutoff);
});
