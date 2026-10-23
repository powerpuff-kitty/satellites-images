import { test as base, expect } from "@playwright/test";

const thumbnail = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNg+M8AQhAKABvyA/1tVLjHAAAAAElFTkSuQmCC", "base64");

/** Each external request must have a fixture; unmatched requests fail without reaching the network. */
export const test = base.extend({
  context: async ({ context }, use) => {
    const unexpected: string[] = [];
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin === `http://127.0.0.1:${process.env.EXPLORER_TEST_PORT ?? 4319}`) return route.continue();
      // The common native-tile fixture advertises a temporarily unavailable service;
      // preview tests can still exercise their image fallback without network access.
      if (url.href === "https://example.test/native-tilejson.json") {
        return route.fulfill({ status: 503, body: "Fixture tile service unavailable" });
      }
      // Common card thumbnails need fixtures even in tests that never open an overlay.
      if (url.hostname === "example.test" && /\/thumb-[^/]+\.jpg$/.test(url.pathname)) {
        return route.fulfill({ contentType: "image/png", body: thumbnail });
      }
      unexpected.push(route.request().method() + " " + url);
      await route.abort();
    });
    await use(context);
    expect(unexpected, "Every external request must be mocked").toEqual([]);
  },
});
export { expect };
