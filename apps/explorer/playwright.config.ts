import { defineConfig } from "@playwright/test";

// Browser E2E for the explorer. All catalogue, map-style and ESA responses are
// intercepted per test, so no live provider is ever called and no API key is used.
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4319",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx vite preview --host 127.0.0.1 --port 4319 --strictPort",
    url: "http://127.0.0.1:4319",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
