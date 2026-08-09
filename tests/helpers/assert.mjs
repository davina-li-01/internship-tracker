/**
 * The smallest assertion helper that still reads well in output.
 *
 * Deliberately not a framework. The suites here are plain scripts run by
 * tests/run.mjs, which keeps the repo free of a build step — the same reason
 * the app itself has none.
 */

let passed = 0;
let failed = 0;

export function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  record(ok, label, got, want);
  return ok;
}

export function ok(label, condition) {
  return eq(label, Boolean(condition), true);
}

export function group(title) {
  console.log("\n" + title);
}

function record(isOk, label, got, want) {
  if (isOk) {
    passed++;
    console.log("  ok    " + label);
    return;
  }
  failed++;
  console.log("  FAIL  " + label);
  if (want !== undefined) {
    console.log("          got  " + JSON.stringify(got));
    console.log("          want " + JSON.stringify(want));
  }
}

/** Prints the tally and exits non-zero if anything failed. */
export function done() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
