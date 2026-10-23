import { defineConfig } from "vite";
import { satellitePublicShell } from "./public-shell.js";
export default defineConfig({
  base: "./",
  plugins: [{ name: "shared-public-shell", transformIndexHtml: satellitePublicShell }],
  // This small CSS-first package is native ESM. Load it directly so dependency
  // upgrades cannot leave a running dev server serving an older export list.
  optimizeDeps: {
    exclude: ["@powerpuff-kitty/tcsn-design-system"],
  },
  build: {
    outDir: "dist",
    rolldownOptions: {
      output: {
        codeSplitting: { groups: [{ name: "maplibre", test: /node_modules\/maplibre-gl\// }] },
      },
    },
  },
  server: {
    proxy: {
      // Dev-only convenience proxy. Mirrors the production Cloudflare Worker's allowlist:
      // only official ESA acquisition-plan index pages and KML documents, no query strings.
      "/esa-proxy": {
        target: "https://sentinels.copernicus.eu",
        changeOrigin: true,
        secure: true,
        rewrite: (path: string) => path.replace(/^\/esa-proxy/, ""),
        bypass: (req, res) => {
          const url = req.url ?? "";
          const path = url.replace(/^\/esa-proxy/, "").split("?")[0];
          const allowed = /^\/documents\/d\/sentinel\/s(?:1[c-d]|2[a-c])_mp_(?:user|acq__kml)_\d{8}t\d{6}_\d{8}t\d{6}$/i.test(path) ||
            path === "/copernicus/sentinel-1/acquisition-plans" ||
            path === "/copernicus/sentinel-2/acquisition-plans";
          if (!allowed || url.includes("?")) {
            res.statusCode = 404;
            res.end("Only official ESA acquisition plan pages and KMLs can be requested");
            return false;
          }
          return undefined;
        },
      },
    },
  },
});
