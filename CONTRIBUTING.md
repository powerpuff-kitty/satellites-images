# Contributing

Bug reports, verified provider documentation and small integrations are welcome. Open an issue describing the dataset and documented access method before adding a provider.

- Do not commit credentials, commercial raster data or assets with unclear redistribution rights.
- New providers require: capability registry update, documented auth/access rules, deterministic fixtures, bounded pagination and negative-path tests.
- Keep runtime dependencies small; avoid map UI and scientific raster logic in the SDK.
- Run `npm run check`, `python -m unittest discover -s packages/python/tests` and `cargo test --manifest-path crates/satellites-images/Cargo.toml`.
- Provider metadata and availability are not promises of entitlement or pricing.
