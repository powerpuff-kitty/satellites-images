// Repeated, network-free SDK benchmark capture. Run after npm run check, when idle:
// node tools/bench/audit.mjs [--out tools/bench/results/DATE-audit.json]
// No production code or dependencies are changed; Rust may build its release example.
import { spawnSync } from "node:child_process";
import { cpus, arch, platform, release, totalmem } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const outIndex=process.argv.indexOf("--out");
const out=resolve(root,outIndex<0?`tools/bench/results/${new Date().toISOString().slice(0,10)}-audit.json`:process.argv[outIndex+1]);
const python=process.env.PYTHON ?? "python3";
function run(command,args,env={}) {
  const result=spawnSync(command,args,{cwd:root,env:{...process.env,...env},encoding:"utf8",maxBuffer:16*1024*1024});
  if(result.error || result.status!==0) throw new Error(`${command} ${args.join(" ")}: ${result.error ?? result.stderr}`);
  return result.stdout;
}
const workloads=[
  {language:"typescript",command:process.execPath,args:["tools/bench/typescript.mjs"]},
  {language:"python",command:python,args:["tools/bench/python.py"],env:{PYTHONPATH:"packages/python/src"}},
  {language:"rust",command:"cargo",args:["run","--release","--example","bench","--manifest-path","crates/satellites-images/Cargo.toml"]},
];
// Compilation is outside all measured trial invocations.
run("cargo",["build","--release","--example","bench","--manifest-path","crates/satellites-images/Cargo.toml"]);
const trials=[];
for(let trial=1;trial<=3;trial++) {
  for(const workload of workloads) {
    const stdout=run(workload.command,workload.args,workload.env);
    const measurements=[...stdout.matchAll(/^(.+?)\s+(\d+) ops\s+([\d.]+) ms\s+(\d+) ops\/s$/gm)].map(m=>({
      operation:m[1].trim(),iterations:Number(m[2]),elapsedMs:Number(m[3]),operationsPerSecond:Number(m[4]),
    }));
    if(measurements.length!==6) throw new Error(`Expected six measurements for ${workload.language}`);
    trials.push({trial,language:workload.language,command:[workload.command,...workload.args],stdout,measurements});
    console.log(`Recorded ${workload.language} trial ${trial}/3`);
  }
}
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const summary=[];
for(const workload of workloads) {
  for(const measurement of trials.find(t=>t.language===workload.language).measurements) {
    const samples=trials.filter(t=>t.language===workload.language).map(t=>t.measurements.find(m=>m.operation===measurement.operation));
    const rates=samples.map(s=>s.operationsPerSecond),times=samples.map(s=>s.elapsedMs/s.iterations);
    summary.push({language:workload.language,operation:measurement.operation,iterations:measurement.iterations,
      medianOperationsPerSecond:median(rates),minOperationsPerSecond:Math.min(...rates),maxOperationsPerSecond:Math.max(...rates),
      medianMsPerOperation:median(times),trials:samples});
  }
}
const report={date:new Date().toISOString(),scope:"Current dirty working tree; CPU-only synthetic microbenchmarks, not a release or service guarantee",
  commit:run("git",["rev-parse","HEAD"]).trim(),dirtyWorkingTree:Boolean(run("git",["status","--porcelain"]).trim()),
  environment:{cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryBytes:totalmem(),architecture:arch(),platform:platform(),kernel:release(),
    node:process.version,nodePath:process.execPath,python:run(python,["--version"]).trim(),rust:run("rustc",["--version"]).trim()},
  methodology:{trials:3,warmup:"Each existing benchmark warms 10% of iterations",aggregationWorkload:"50 pages × 100 unique scenes, 200 summaries per trial",
    timing:"Existing scripts round elapsed milliseconds to 0.1 ms and throughput to integer ops/s",releaseBuild:true,
    target:"No project SLO is defined; measurements establish a baseline, not a pass/fail performance gate",
    caveats:["Single local machine, sequential trials; background activity and thermal/JIT variance remain possible",
      "Language implementations and allocation patterns differ; throughput is not a universal language ranking",
      "Historical 2026-10-13 results used Node24.19.0, while current Node runtime is recorded above; ratios would confound runtime/code changes",
      "No provider network, browser interaction latency, RSS or production workload measured"]},summary,trials};
// Ensure a malformed historical artifact cannot silently become a comparison baseline.
const historical=JSON.parse(readFileSync(resolve(root,"tools/bench/results/2026-10-13.json"),"utf8"));
report.historicalReference={path:"tools/bench/results/2026-10-13.json",date:historical.date,environment:historical.environment,comparisonPerformed:false};
mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2)+"\n");
console.log(`Wrote ${out}`);
