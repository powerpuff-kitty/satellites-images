import { test as base, expect } from "@playwright/test";

const thumbnail = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNg+M8AQhAKABvyA/1tVLjHAAAAAElFTkSuQmCC", "base64");

/** Each external request must have a fixture; unmatched requests fail without reaching the network. */
export const test = base.extend({
  context: async ({ context }, use) => {
    const unexpected: string[] = [];
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin === "http://127.0.0.1:4319") return route.continue();
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
