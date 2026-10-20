// Build local candidates and test their public APIs from clean consumers. Never publishes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
let only = "all", destination = join(root, "dist/release-candidate");
for (let index = 0; index < argv.length; index++) {
  if (argv[index] === "--only" && argv[index + 1]) only = argv[++index];
  else if (argv[index] === "--out" && argv[index + 1]) destination = resolve(argv[++index]);
  else throw new Error("Usage: npm run check:packages -- [--only typescript|python|rust|all] [--out DIRECTORY]");
}
assert.ok(["all", "typescript", "python", "rust"].includes(only), "Unknown ecosystem: " + only);
const selected = only === "all" ? ["typescript", "python", "rust"] : [only];
const fixtureBytes = readFileSync(join(root, "tests/fixtures/conformance/stac.json"));
const fixture = JSON.parse(fixtureBytes);
const conformanceCases = fixture.stacCases.length + fixture.availabilityCases.length + (fixture.maxarCases?.length ?? 0);
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const python = process.env.PYTHON || "python3";
const cargo = process.env.CARGO || "cargo";
const environment = { ...process.env };
delete environment.PYTHONPATH;
delete environment.NODE_PATH;

function run(command, args, cwd = root) {
  console.log("\n> " + [command, ...args].join(" "));
  try {
    return execFileSync(command, args, { cwd, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    if (error.stdout) process.stderr.write(error.stdout);
    throw error;
  }
}
function save(file, content) { writeFileSync(file, content); }
function copy(source, target) { copyFileSync(join(root, source), target); }
function virtualPython(directory) { return join(directory, process.platform === "win32" ? "Scripts/python.exe" : "bin/python"); }
function sourceVersion(file, section) {
  const source = readFileSync(join(root, file), "utf8");
  const block = source.split("[" + section + "]")[1]?.split(/\n\[/)[0];
  return /^version\s*=\s*"([^"]+)"/m.exec(block || "")?.[1];
}
const baseCommit = run("git", ["rev-parse", "HEAD"]).trim();
const dirtyWorkingTree = Boolean(run("git", ["status", "--porcelain"]).trim());
mkdirSync(destination, { recursive: true });
const artifacts = mkdtempSync(join(destination, "run-"));
const temporary = mkdtempSync(join(tmpdir(), "satellites-package-check-"));
const report = {
  version, createdAt: new Date().toISOString(),
  baseCommit, dirtyWorkingTree,
  scope: "Local artifact acceptance only; no publication, tag, or hosted CI execution",
  fixtureVersion: fixture.version, checks: [], artifacts: [], status: "running",
  fixtureSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
};

async function typescript() {
  run(npm, ["run", "build", "-w", "@powerpuff-kitty/satellites-images"]);
  const metadata = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", artifacts,
    "-w", "@powerpuff-kitty/satellites-images"]));
  // npm 12 keys workspace results by package name; earlier versions return an array.
  const packed = Array.isArray(metadata) ? metadata : Object.values(metadata);
  assert.equal(packed.length, 1);
  assert.equal(packed[0].version, version);
  const consumer = join(temporary, "node-consumer");
  mkdirSync(consumer);
  save(join(consumer, "package.json"), JSON.stringify({ name: "satellites-candidate-check", private: true, type: "module" }));
  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(artifacts, packed[0].filename)], consumer);
  copy("tools/conformance/typescript.mjs", join(consumer, "conformance.mjs"));
  save(join(consumer, "fixture.json"), JSON.stringify(fixture));
  save(join(consumer, "verify.mjs"), `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as sdk from "@powerpuff-kitty/satellites-images";
import { checkConformance } from "./conformance.mjs";
const metadata = JSON.parse(readFileSync("node_modules/@powerpuff-kitty/satellites-images/package.json", "utf8"));
assert.equal(metadata.version, ${JSON.stringify(version)});
assert.ok(import.meta.resolve("@powerpuff-kitty/satellites-images").startsWith(new URL("./node_modules/", import.meta.url).href));
assert.ok(sdk.listSources().some(source => source.id === "earth-search"));
const count = await checkConformance(sdk, JSON.parse(readFileSync("fixture.json", "utf8")));
console.log("PASS: " + count + " installed npm package conformance cases");
`);
  console.log(run(process.execPath, ["verify.mjs"], consumer).trim());
  save(join(consumer, "consumer.ts"), `
import { StacProvider, AvailabilityAccumulator, type SearchQuery, type Scene } from "@powerpuff-kitty/satellites-images";
const query: SearchQuery = { latitude: 0, longitude: 0, radiusMeters: 1000, from: "2025-01-01", to: "2025-01-31" };
const provider = new StacProvider({ id: "test", baseUrl: "https://example.test", collections: ["a"] });
const accumulator = new AvailabilityAccumulator();
for await (const page of provider.search(query)) { const scenes: Scene[] = accumulator.addPage(page); void scenes; }
`);
  save(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext",
    moduleResolution: "NodeNext", strict: true, noEmit: true, lib: ["ES2022", "DOM"] }, files: ["consumer.ts"] }));
  run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"], consumer);
  report.checks.push({ ecosystem: "typescript", runtime: process.version, result: "passed", conformanceCases,
    gates: ["pack", "isolated install", "public exports", "bundled registry", "shared contracts", "consumer typecheck"] });
}

async function pythonPackage() {
  const buildEnv = join(temporary, "python-build");
  run(python, ["-m", "venv", buildEnv]);
  const buildPython = virtualPython(buildEnv);
  run(buildPython, ["-m", "pip", "install", "build"]);
  run(buildPython, ["-m", "build", "--sdist", "--wheel", "--outdir", artifacts, join(root, "packages/python")]);
  const candidates = readdirSync(artifacts).filter(file => file.endsWith(".whl") || file.endsWith(".tar.gz"));
  assert.equal(candidates.length, 2, "Expected a wheel and source distribution");
  for (const [index, candidate] of candidates.entries()) {
    const consumer = join(temporary, "python-consumer-" + index);
    run(python, ["-m", "venv", consumer]);
    const executable = virtualPython(consumer);
    run(executable, ["-m", "pip", "install", "--no-deps", join(artifacts, candidate)]);
    const verifier = join(consumer, "verify.py");
    copy("tools/conformance/python.py", verifier);
    const fixturePath = join(consumer, "fixture.json");
    save(fixturePath, JSON.stringify(fixture));
    console.log(run(executable, ["-I", verifier, fixturePath], consumer).trim());
    const identity = JSON.parse(run(executable, ["-I", "-c", `
import importlib.metadata,json,sys
from importlib.resources import files
from pathlib import Path
import satellites_images as sdk
assert Path(sdk.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())
assert importlib.metadata.version("satellites-images") == ${JSON.stringify(version)}
assert files("satellites_images").joinpath("py.typed").is_file()
assert any(source["id"]=="earth-search" for source in sdk.list_sources())
print(json.dumps({"runtime":sys.version.split()[0],"version":importlib.metadata.version("satellites-images")}))
`], consumer));
    report.checks.push({ ecosystem: "python", artifact: candidate, runtime: identity.runtime, result: "passed",
      conformanceCases, gates: ["build", "isolated install", "public exports", "bundled registry/py.typed", "shared contracts"] });
  }
}

async function rust() {
  const target = join(root, "crates/satellites-images/target");
  const manifest = join(root, "crates/satellites-images/Cargo.toml");
  run(cargo, ["package", "--locked", "--allow-dirty", "--manifest-path", manifest, "--target-dir", target]);
  const archive = "satellites-images-" + version + ".crate";
  copyFileSync(join(target, "package", archive), join(artifacts, archive));
  const consumer = join(temporary, "rust-consumer");
  mkdirSync(consumer);
  const unpacked = join(consumer, "unpacked");
  mkdirSync(unpacked);
  run("tar", ["-xzf", join(artifacts, archive), "-C", unpacked]);
  const sdkPath = join(unpacked, "satellites-images-" + version);
  assert.ok(existsSync(join(sdkPath, "src/sources.json")), "Crate registry resource");
  assert.ok(existsSync(join(sdkPath, "LICENSE")), "Crate license");
  mkdirSync(join(consumer, "src"));
  copy("tools/conformance/rust.rs", join(consumer, "src/conformance.rs"));
  save(join(consumer, "fixture.json"), JSON.stringify(fixture));
  save(join(consumer, "Cargo.toml"), `[package]
name = "satellites-candidate-check"
version = "0.0.0"
edition = "2021"
[dependencies]
satellites-images = { path = ${JSON.stringify(sdkPath)} }
serde_json = "1"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
`);
  save(join(consumer, "src/main.rs"), `mod conformance;
#[tokio::main]
async fn main() {
    let sources = satellites_images::list_sources().unwrap();
    assert!(sources["sources"].as_array().unwrap().iter().any(|source| source["id"] == "earth-search"));
    let fixture = serde_json::from_str(include_str!("../fixture.json")).unwrap();
    let count = conformance::check_conformance(&fixture).await;
    println!("PASS: {count} installed crate conformance cases");
}
`);
  // Preserve packaged dependency versions while adding the separate consumer root.
  // Dependency installation can use the network; catalogue contract checks run offline.
  copyFileSync(join(sdkPath, "Cargo.lock"), join(consumer, "Cargo.lock"));
  run(cargo, ["fetch"], consumer);
  console.log(run(cargo, ["run", "--offline", "--locked", "--target-dir", join(target, "candidate-consumer")], consumer).trim());
  const metadata = JSON.parse(run(cargo, ["metadata", "--no-deps", "--format-version", "1", "--offline"], sdkPath));
  assert.equal(metadata.packages[0].version, version);
  report.checks.push({ ecosystem: "rust", runtime: run(cargo, ["--version"]).trim(), result: "passed", conformanceCases,
    gates: ["package verification", "archive extraction", "separate offline consumer", "public exports", "bundled registry", "shared contracts"] });
}

try {
  assert.equal(JSON.parse(readFileSync(join(root, "packages/typescript/package.json"), "utf8")).version, version);
  assert.equal(sourceVersion("packages/python/pyproject.toml", "project"), version);
  assert.equal(sourceVersion("crates/satellites-images/Cargo.toml", "package"), version);
  for (const ecosystem of selected) await ({ typescript, python: pythonPackage, rust })[ecosystem]();
  for (const filename of readdirSync(artifacts)) {
    const bytes = readFileSync(join(artifacts, filename));
    report.artifacts.push({ filename, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  report.status = "passed";
  console.log("\nPASS: local package acceptance. Artifacts and checksums: " + artifacts);
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.stack || error);
} finally {
  save(join(artifacts, "manifest.json"), JSON.stringify(report, null, 2) + "\n");
  rmSync(temporary, { recursive: true, force: true });
}
