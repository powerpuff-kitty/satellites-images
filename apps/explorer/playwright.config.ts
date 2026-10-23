import { defineConfig } from "@playwright/test";

const port = Number(process.env.EXPLORER_TEST_PORT ?? 4319);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid loopback test port");
const origin = `http://127.0.0.1:${port}`;
const dev = process.env.EXPLORER_DEV === "1";

// Browser E2E for the explorer. All catalogue, map-style and ESA responses are
// intercepted per test, so no live provider is ever called and no API key is used.
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node ../../node_modules/vite/bin/vite.js ${dev ? "" : "preview "}--host 127.0.0.1 --port ${port} --strictPort`,
    url: origin,
    reuseExistingServer: false,
    timeout: 60000,
  },
});
