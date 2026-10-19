import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("invalid ecosystem fails before creating candidate artifacts", () => {
  const directory = mkdtempSync(join(tmpdir(), "satellites-checker-argument-"));
  const output = join(directory, "output");
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./check-packages.mjs", import.meta.url)),
      "--only", "invalid", "--out", output], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown ecosystem/);
    assert.equal(existsSync(output), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("version mismatch blocks builds, records failure and cleans the consumer environment", () => {
  const root = mkdtempSync(join(tmpdir(), "satellites-checker-version-"));
  const childTemporary = join(root, "temporary");
  const save = (file, value) => writeFileSync(join(root, file), value);
  try {
    for (const path of ["tools/release", "tests/fixtures/conformance", "packages/typescript", "packages/python", "crates/satellites-images", "temporary"]) {
      mkdirSync(join(root, path), { recursive: true });
    }
    copyFileSync(new URL("./check-packages.mjs", import.meta.url), join(root, "tools/release/check-packages.mjs"));
    save("package.json", JSON.stringify({ type: "module", version: "0.3.0" }));
    save("packages/typescript/package.json", JSON.stringify({ version: "0.4.0" }));
    save("packages/python/pyproject.toml", '[project]\nversion = "0.3.0"\n');
    save("crates/satellites-images/Cargo.toml", '[package]\nversion = "0.3.0"\n');
    save("tests/fixtures/conformance/stac.json", JSON.stringify({ version: 1, stacCases: [], availabilityCases: [] }));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Conformance Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"], { cwd: root });
    const result = spawnSync(process.execPath, ["tools/release/check-packages.mjs", "--only", "typescript"], {
      cwd: root, encoding: "utf8", env: { ...process.env, TMPDIR: childTemporary, TEMP: childTemporary, TMP: childTemporary },
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /npm run build|npm pack|npm install/);
    const candidates = join(root, "dist/release-candidate");
    const directories = readdirSync(candidates);
    assert.equal(directories.length, 1);
    const report = JSON.parse(readFileSync(join(candidates, directories[0], "manifest.json"), "utf8"));
    assert.equal(report.status, "failed");
    assert.equal(report.dirtyWorkingTree, false);
    assert.deepEqual(report.checks, []);
    assert.deepEqual(report.artifacts, []);
    assert.match(report.error, /0\.4\.0/);
    assert.deepEqual(readdirSync(childTemporary), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
