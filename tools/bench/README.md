# Benchmarks

Representative, network-free micro-benchmarks for the CPU-bound hot paths of the
SDK (geometry, availability aggregation, feature normalization). They exist to
catch performance regressions before a release, not to benchmark provider I/O.

```sh
npm run build -w @powerpuff-kitty/satellites-images
node tools/bench/typescript.mjs
PYTHONPATH=packages/python/src python3 tools/bench/python.py
cargo run --release --example bench --manifest-path crates/satellites-images/Cargo.toml
```

Each script warms up, then measures throughput (operations/second) with
`performance.now()` / `time.perf_counter()` / `Instant`. Methodology: synthetic
inputs only, no network, no billing; results are machine-dependent and reported
as orders of magnitude, not as guarantees.

Rust consumes inputs and results through `std::hint::black_box` so the optimizer
cannot discard benchmark work. Run three times on an otherwise idle machine and
compare medians rather than a single short geometry sample.

[Recorded audit comparison, 2026-10-13](results/2026-10-13.json) includes raw trials,
runtime versions, before/after throughput and explorer build sizes. The fixed SDKs
validate dates more strictly than the baseline. This is a CPU comparison; it does
not measure provider latency, browser responsiveness or memory use.

To capture three sequential current-tree trials with raw output and medians:

```sh
npm run check
node tools/bench/audit.mjs --out /tmp/sdk-benchmark.json
```

Run this after other CPU-heavy work and browsers finish. The runner records actual
runtime versions; the 2026-10-13 Node 24 baseline is not directly comparable with a
Node 25 run. [The 2026-10-16 audit](../../docs/audits/2026-10-16.md) includes current
microbenchmarks, diagnostic profiles, bundle sizes, tests and independent live-source
latency checks. For network measurements use the opt-in
`node tools/smoke/source-benchmark.mjs --out /tmp/source-benchmark.json`.
