# ESA acquisition plans proxy

Optional Cloudflare Worker for the browser explorer. **Not automatically deployed.**

Allowed URLs are ESA's two public Sentinel-1/2 acquisition-plan index pages and ESA-hosted named KML documents matching strict filename patterns. Any other host/path/method is rejected. No provider credentials are forwarded.

Deploy (requires Cloudflare account, Wrangler and explicit operator approval):

```sh
npx wrangler deploy --config apps/plans-proxy/wrangler.json
```

For Vite/static app configuration, use the Worker URL as `VITE_ESA_PROXY_URL`, then rebuild `apps/explorer`.

The proxy streams public ESA responses, applies caching and sets CORS for browsers. It is not an imagery raster server. Production operators must monitor availability, terms and abuse.
