# Benchmarks

Representative, network-free micro-benchmarks for the CPU-bound hot paths of the
SDK (geometry, availability aggregation, feature normalization). They exist to
catch performance regressions before a release, not to benchmark provider I/O.

```sh
node tools/bench/typescript.mjs
PYTHONPATH=packages/python/src python3 tools/bench/python.py
cargo run --release --example bench --manifest-path crates/satellites-images/Cargo.toml
```

Each script warms up, then measures throughput (operations/second) with
`performance.now()` / `time.perf_counter()` / `Instant`. Methodology: synthetic
inputs only, no network, no billing; results are machine-dependent and reported
as orders of magnitude, not as guarantees.
