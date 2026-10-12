# Contracts

The JSON Schemas in this directory are the canonical, camelCase wire contract for the
TypeScript package's output: `scene.schema.json`, `searchpage.schema.json`,
`availability.schema.json`, and `acquisition.schema.json`.

The TypeScript test suite validates normalized output against these schemas
(`packages/typescript/tests/schema.test.mjs`), and Rust serializes its contract structs
in camelCase (`#[serde(rename_all = "camelCase")]`). The Python package stores native
snake_case dataclasses and exposes `to_camel`/`to_json` (`satellites_images.serialize`)
to emit the same camelCase contract. Provider-native metadata under `raw` is preserved
verbatim in every language.

`providerId` is the provider's `id` (e.g. `earth-search`, `copernicus`,
`nasa-cmr:ASF`, `asf-vertex`, `jaxa-gportal`).
