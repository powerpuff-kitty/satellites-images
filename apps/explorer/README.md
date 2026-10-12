# Satellite imagery explorer

Minimal, static MapLibre demonstration of the TypeScript SDK.

```sh
npm install
npm run generate:registry
npm run build -w @powerpuff-kitty/satellites-images
npm run dev -w @satellites-images/explorer
```

Click the map or type decimal GPS coordinates; choose radius, dates and one supported STAC provider; then browse actual historical scene metadata and available previews. All results are real remote catalogue responses, not mock satellite images. A search is limited to 2 pages × 30 items by default and does not claim an exhaustive historical archive. Actual raster images are **not** drawn on the map in this first release; comparison, future plans and automatic satellite scheduling remain roadmap items.

Uses MapLibre's public demonstration tile style, which is not a production map-tile SLA. If a catalogue denies browser CORS, use a permissioned backend/proxy rather than putting API secrets into web code.
