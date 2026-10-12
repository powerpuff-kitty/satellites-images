# Contracts

The JSON Schemas in this directory are the canonical, camelCase wire contract for the
TypeScript package's output: `scene.schema.json`, `searchpage.schema.json`,
`availability.schema.json`, and `acquisition.schema.json`.

The TypeScript test suite validates normalized output against these schemas
(`packages/typescript/tests/schema.test.mjs`). The **Python** and **Rust** packages
serialize their native dataclasses/structs directly, which uses each host language's
snake_case convention (for example `acquired_at`, `cloud_cover_percent`,
`days_with_observations`). Field *semantics* are identical; only the on-wire casing
differs. A future release may add camelCase serializers for Python/Rust or a generated
cross-language conformance corpus (tracked in the roadmap).

`providerId` is the provider's `id` (e.g. `earth-search`, `copernicus`,
`nasa-cmr:ASF`, `asf-vertex`, `jaxa-gportal`).
