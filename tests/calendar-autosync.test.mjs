/**
 * ORB-15 auto-sync throttling.
 *
 * Every page in Orbit is a full page load, so the difference between "checks in
 * the background" and "hammers Google on every navigation" is entirely these
 * few functions. The other failure they guard is the opposite one: going quiet
 * forever after a single expired token.
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear()
};
globalThis.window = { google: undefined };
globalThis.document = { querySelector: () => null, createElement: () => ({}), head: { appendChild() {} } };

const cal = await import("../js/calendar.js");

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok" : "FAIL"}  ${n}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const ok = (n, c) => eq(n, Boolean(c), true);
const HOUR = 3600_000;
const T0 = 1_800_000_000_000;

console.log("\nORB-15 — remembering the connection");
{
  store.clear();
  ok("nothing remembered to begin with", !cal.isRemembered());
  ok("so nothing auto-syncs", !cal.autoSyncDue(T0));

  cal.rememberConnection();
  ok("remembered after connecting", cal.isRemembered());
  ok("and the first sync is due immediately", cal.autoSyncDue(T0));

  cal.forgetConnection();
  ok("forgetting clears it", !cal.isRemembered());
  ok("and stops auto-sync", !cal.autoSyncDue(T0));
}

console.log("\nORB-15 — the sync throttle");
{
  store.clear();
  cal.rememberConnection();
  cal.markSynced(T0);

  ok("not due one minute later", !cal.autoSyncDue(T0 + 60_000));
  ok("not due an hour later", !cal.autoSyncDue(T0 + HOUR));
  ok("still not due just short of the window",
     !cal.autoSyncDue(T0 + cal.AUTO_SYNC_HOURS * HOUR - 1000));
  ok("due once the window passes", cal.autoSyncDue(T0 + cal.AUTO_SYNC_HOURS * HOUR));
  ok("and due the next day", cal.autoSyncDue(T0 + 24 * HOUR));
}

console.log("\nORB-15 — the reconnect nudge");
{
  store.clear();
  ok("a first nudge is allowed", cal.reconnectNudgeDue(T0));
  cal.markReconnectNudged(T0);
  ok("not again an hour later", !cal.reconnectNudgeDue(T0 + HOUR));
  ok("not again after twelve hours", !cal.reconnectNudgeDue(T0 + 12 * HOUR));
  ok("allowed again after a day", cal.reconnectNudgeDue(T0 + cal.RECONNECT_NUDGE_HOURS * HOUR));
}

console.log("\nORB-15 — silent sync never explodes");
{
  store.clear();
  eq("returns null when never connected", await cal.silentSync([], "2026-08-09"), null);

  cal.rememberConnection();
  // No window.google and no network: Google's callback never fires, so this
  // must fall back on the timeout rather than hanging the page-load path.
  const started = Date.now();
  eq("returns null rather than hanging when Google never answers",
     await cal.silentSync([], "2026-08-09"), null);
  const took = Date.now() - started;
  ok("and gives up inside the timeout, not never (" + took + "ms)",
     took >= cal.SILENT_TIMEOUT_MS - 500 && took < cal.SILENT_TIMEOUT_MS + 3000);
  ok("the connection is still remembered, so it can retry", cal.isRemembered());
}

console.log("\nORB-15 — disconnecting");
{
  store.clear();
  cal.rememberConnection();
  cal.markSynced(T0);
  cal.disconnectCalendar();
  ok("the flag is gone", !cal.isRemembered());
  ok("the sync stamp is gone too", !cal.autoSyncDue(T0 + 1000));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
