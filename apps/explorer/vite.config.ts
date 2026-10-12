import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  build: { outDir: "dist" },
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
          const allowed = path.startsWith("/documents/") ||
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
