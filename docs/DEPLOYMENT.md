# Manually publish the map explorer

This repository includes a **manual** GitHub Pages workflow at `.github/workflows/publish-explorer.yml`. It does **not** deploy when code is pushed.

1. In GitHub repository Settings → Pages, select **GitHub Actions** as the build and deployment source.
2. In Actions, choose **Publish Explorer (manual)** → Run workflow.
3. Optionally provide `esa_proxy_url` pointing to the restricted Cloudflare Worker (see `apps/plans-proxy/README.md`). Leave blank to try direct ESA calls, which browsers may block due to CORS.
4. The workflow validates the TypeScript SDK, packages and frontend, then uploads only `apps/explorer/dist` to GitHub Pages.

Expected site after successful deployment: `https://powerpuff-kitty.github.io/satellites-images/`.

This URL is only an **expected** site location; the workflow has not been run and no live Pages site is asserted.

No private credentials belong in Vite environment variables. Browser-bundled variables are public. The optional ESA proxy only serves public ESA index and KML paths. It is not an arbitrary URL forwarder.

GitHub Pages permissions and environment setup are documented at https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages.
