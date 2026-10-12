import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  build: { outDir: "dist" },
  server: {
    proxy: {
      "/esa-proxy": {
        target: "https://sentinels.copernicus.eu",
        changeOrigin: true,
        secure: true,
        rewrite: (path: string) => path.replace(/^\/esa-proxy/, ""),
      },
    },
  },
});
