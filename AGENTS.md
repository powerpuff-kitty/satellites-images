# Agent instructions

Project-specific guidance for automated agents (and humans) working in this repository.
Keep it short and factual; update it when the commands or boundaries change.

## What this repository is

Cross-language satellite catalogue discovery SDKs (TypeScript, Python, Rust) plus a MapLibre
explorer web app. Everything is read-only against public catalogues: no imagery is
downloaded, and nothing is uploaded.

## Commands that must pass

```bash
npm run check                     # registry generation + SDK build + explorer typecheck + TS tests
npm run test                      # TypeScript SDK tests (node:test)
npm run test:e2e -w @satellites-images/explorer   # mocked Playwright E2E (offline)
npm run bench                     # optional micro-benchmarks

PYTHONPATH=packages/python/src python3 -m unittest discover -s packages/python/tests
cargo test --manifest-path crates/satellites-images/Cargo.toml
cargo clippy --manifest-path crates/satellites-images/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path crates/satellites-images/Cargo.toml --check
npm run check:packages             # local archives + isolated install/conformance checks; never publishes
```

Minimum SDK runtimes: Node 20.19, Python 3.10 and Rust 1.88. The explorer toolchain
uses Node 22 in CI. See `CONTRIBUTING.md` for minimum-runtime checks.
CI tests Node 20.19/22/24, Python 3.10/3.12/3.14, and Rust 1.88/stable.

### Refresh the README screenshot

The README screenshot is generated from the live catalogues, not fixtures:

```bash
LIVE=1 npm run test:e2e -w @satellites-images/explorer -- --grep "capture the live explorer"
```

It writes `docs/assets/explorer.jpg` directly. The capture uses live catalogue metadata
and vector-map context while blocking image/raster downloads and leaving previews closed.
Re-run it when the explorer UI changes so the image represents current behaviour.

Opt-in live checks (network; never part of CI):

```bash
node tools/smoke/live.mjs                                          # provider reachability
LIVE=1 npm run test:e2e -w @satellites-images/explorer -- --grep "live search"
```

## Generated paths — do not hand-edit

- `sources/registry.json` is the **source of truth** for catalogues. It is copied into
  `packages/typescript/src/sources.json`, `packages/python/src/satellites_images/sources.json`
  and `crates/satellites-images/src/sources.json` by `npm run generate:registry`.
  Edit the registry, regenerate, and check the tree stays clean.
- `package-lock.json` and `crates/satellites-images/Cargo.lock` are committed; regenerate
  rather than editing.

## Boundaries

- Never publish to npm, PyPI or crates.io, and never tag a release, without explicit owner
  approval.
- Do not change repository settings, branch protection or workflows without explicit approval.
- Keep the mocked E2E suite offline: every request in `apps/explorer/tests/e2e` is
  intercepted. Live behaviour belongs in the opt-in checks above.
- Public catalogues are third-party services. Do not add credentials, and do not present
  planned acquisitions as existing imagery.

## Evidence expectations

- `tests/fixtures/conformance/stac.json` is shared contract evidence, not generated SDK output.
- State what was actually run and its result; a skipped or mocked check is not a pass.
- Cite exact files and reproducible commands. Distinguish measured facts from inference.
- Provider behaviour (CORS, preview assets, collection coverage) is verified against the
  live APIs, not assumed — record the observation date when quoting metadata.
