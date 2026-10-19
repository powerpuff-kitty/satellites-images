# Local release-candidate acceptance

```sh
npm ci
npm run check
PYTHONPATH=packages/python/src python3 -m unittest discover -s packages/python/tests
cargo test --locked --manifest-path crates/satellites-images/Cargo.toml
npm run check:packages
```

The checker creates npm, Python wheel/source, and Rust crate archives in a new
`dist/release-candidate/run-*` directory. It verifies lockstep versions, installs
each archive into a fresh consumer, and runs the same 17 conformance cases used
by the source tests. It also checks npm public exports and consumer TypeScript
types, Python bundled resources and `py.typed`, and the crate's bundled registry.
The Rust consumer depends on the unpacked archive, never the workspace source.

Dependency installation may use public package registries. Catalogue requests
in the conformance checks are synthetic: TypeScript/Python inject responses and
Rust uses a loopback HTTP server. No live provider or imagery is requested.

Each run writes `manifest.json` with the base commit, dirty-worktree flag,
fixture digest, checked runtimes, gate results, artifact sizes and SHA-256 sums.
A failed check returns a nonzero exit code and records a failed report. Clean
consumer directories are removed after the run; candidate artifacts remain for
review. A dirty tree is permitted, and is recorded rather than represented as a
committed release.

Run an individual ecosystem with `--only typescript`, `--only python`, or
`--only rust`. `--out DIRECTORY` selects the parent artifact directory. `PYTHON`
and `CARGO` select executables; `RUSTUP_TOOLCHAIN=1.88.0` selects the minimum Rust
toolchain. The checker requires Node and Git and, for the selected ecosystem, Python
with venv support or Cargo/Rust and `tar`.

CI runs package acceptance for every supported runtime in its matrix and uploads
the archives and reports. Workflow changes can be checked with `actionlint`.
Hosted CI success remains separate from local acceptance.

This command does not publish, tag, bump versions or modify release workflows.
Passing acceptance prepares reviewable artifacts; owner approval and a reviewed
commit remain prerequisites for any publication.
