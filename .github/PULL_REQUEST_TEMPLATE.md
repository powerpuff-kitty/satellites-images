<!--
Keep this short. It is a prompt for verification, not a form to fill in completely.
-->
## What this changes

<!-- One or two sentences: the behaviour or artefact that changes, and why. -->

## How it was verified

<!--
List the checks you actually ran and their result, for example:
- `npm run check` → registry/build/typecheck/TS tests pass
- `npm run test:e2e -w @satellites-images/explorer` → 42 passed
- `PYTHONPATH=packages/python/src python3 -m unittest discover -s packages/python/tests`
- `cargo test --manifest-path crates/satellites-images/Cargo.toml`
- live: `node tools/smoke/live.mjs` (date observed: …)
Say if a check was skipped and why; do not present an unchecked change as verified.
-->

## Risk and rollback

<!-- Blast radius: which SDKs/apps are affected, what could regress, and how to revert. -->

## Checklist

- [ ] Scope matches the linked issue or request; unrelated changes are split out.
- [ ] Generated files were produced by their generator (`npm run generate:registry`), not hand-edited.
- [ ] Provider-facing behaviour was validated against a real response (or the reason it could not be is stated).
- [ ] Documentation (README, CHANGELOG, docs/) updated for any accepted behaviour change.
- [ ] No credentials, tokens or private data added; no publish/release action taken without owner approval.
