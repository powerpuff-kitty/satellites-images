# Shared SDK contracts

`stac.json` is the canonical, synthetic cross-language fixture. The expected
requests, normalized pages and availability summaries are hand-specified
contracts, not outputs regenerated from one SDK.

Seven catalogue cases cover collection-scoped identity, UTC normalization,
assets/access, raw and geometry metadata, malformed-item skipping, preview
fallback, POST replacement/merge, GET pagination, page caps and antimeridian
truncation. Four accumulator cases cover dictionary keys, provider provenance,
pending/failed providers and empty summaries. Six static Maxar cases cover extent
pruning, release selection, native timestamps, relative asset URLs, malformed items,
unsafe links, empty catalogues, and page/document budgets.

The three native suites and the isolated package consumers use the same file
through `tools/conformance`. TypeScript also validates the expected wire values
against the JSON Schemas with date formats enabled. JSON object key order is
irrelevant; array order and all field values are checked. Integral numbers such
as `10` and `10.0` are equivalent JSON values.

Run the required SDK commands in `AGENTS.md`, or `npm run check:packages` to test
the packaged SDKs. Keep the canonical fixture in this directory. Rust's
workspace integration test reads it directly and is excluded from `.crate`
archives; the package checker copies the common harness into its clean consumer
and verifies the unpacked crate there.

All dates and endpoints here are fixtures. They are not live observations or
provider coverage claims, and assets are never fetched.
