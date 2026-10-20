# Contributing

Bug reports, verified provider documentation and small integrations are welcome. Open an issue describing the dataset and documented access method before adding a provider.

- Do not commit credentials, commercial raster data or assets with unclear redistribution rights.
- New providers require: capability registry update, documented auth/access rules, deterministic fixtures, bounded pagination and negative-path tests.
- Keep runtime dependencies small; avoid map UI and scientific raster logic in the SDK.
- Run the checks listed in `AGENTS.md`, including the offline browser suite and Rust formatting/Clippy checks.
- Provider metadata and availability are not promises of entitlement or pricing.

Minimum supported SDK runtimes are Node 20.19, Python 3.10 and Rust 1.88. Verify
changes against them locally as well as the current toolchain:

```sh
node --version  # activate Node 20.19.0 with your version manager first
node --test packages/typescript/tests/*.test.mjs
PYTHONPATH=packages/python/src uv run --python 3.10 --no-project --no-config -- python -m unittest discover -s packages/python/tests
cargo +1.88.0 test --locked --manifest-path crates/satellites-images/Cargo.toml
```

Build the TypeScript SDK first. Confirm `node --version` reports the requested
runtime; do not assume an `npx` package invocation switched interpreters. The optional `uv` command provisions Python 3.10;
an existing Python 3.10 interpreter works with the same `PYTHONPATH` and unittest
arguments. Install Rust 1.88 with `rustup toolchain install 1.88.0 --profile minimal`.

SDK wire changes require shared cases in `tests/fixtures/conformance/stac.json`;
all language suites and installed consumers compare against that same fixture.
Run `npm run check:packages` before proposing publication. It produces local
candidate archives, tests fresh installs and writes checksums; it never publishes.
See `tools/release/README.md`. CI enforces runtime matrices, Rust formatting and
Clippy, offline browser fixtures, registry consistency and packaged consumers.
