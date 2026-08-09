/**
 * Runs every *.test.mjs in this directory and reports one tally.
 *
 * Each suite is a separate process on purpose. They share a loader that caches
 * the module and a mutable fake database, so running them in one process would
 * let one suite's leftover state decide another's result.
 *
 * Usage:  npm test
 *         npm test -- calendar        (only suites whose name contains "calendar")
 */

import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || "";

const suites = readdirSync(HERE)
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!suites.length) {
  console.error(filter ? `No suites match "${filter}".` : "No suites found.");
  process.exit(1);
}

const run = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(HERE, file)], { encoding: "utf8" });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.on("close", (code) => resolve({ file, code, out }));
});

const results = [];
for (const file of suites) results.push(await run(file));

let passed = 0;
let failed = 0;
const broken = [];

for (const r of results) {
  const tally = r.out.match(/(\d+) passed, (\d+) failed/);
  if (!tally) {
    broken.push(r);
    console.log(`✗ ${r.file.padEnd(28)} did not report a tally`);
    continue;
  }
  passed += Number(tally[1]);
  failed += Number(tally[2]);
  const mark = r.code === 0 ? "✓" : "✗";
  console.log(`${mark} ${r.file.padEnd(28)} ${tally[1]} passed, ${tally[2]} failed`);
  if (r.code !== 0) broken.push(r);
}

// Only the failures get their full output — a passing run should be one screen.
for (const r of broken) {
  console.log("\n" + "─".repeat(64));
  console.log(r.file);
  console.log("─".repeat(64));
  console.log(r.out.split("\n").filter((l) => !l.startsWith("  ok    ")).join("\n"));
}

console.log("\n" + "─".repeat(64));
console.log(`${suites.length} suites · ${passed} passed · ${failed} failed`);
console.log("Edge Function tests run separately: npm run test:functions");

process.exit(broken.length ? 1 : 0);
