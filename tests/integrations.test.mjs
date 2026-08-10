/**
 * Integration connection state (ORB-34) and run reporting (ORB-35).
 *
 * "Connected or not" could not describe the state that happens most: connected
 * weeks ago, grant since expired, nothing works until you click again. Settings
 * reported that as a healthy calendar. These hold the four-state model, and the
 * distinction between what a sync FOUND and what it actually LOGGED — only the
 * second answers "did that button do anything".
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};
globalThis.window = {};
globalThis.document = { querySelector: () => null, createElement: () => ({}), head: { appendChild() {} } };

const cal = await import("../js/calendar.js");
import { eq, ok, group, done } from "./helpers/assert.mjs";

group("Four states, not two");
{
  store.clear();
  eq("nothing set up is disconnected", cal.getConnectionState(), cal.DISCONNECTED);

  cal.rememberConnection();
  eq("remembered is connected", cal.getConnectionState(), cal.CONNECTED);

  cal.markNeedsReauth();
  eq("an expired grant is its own state", cal.getConnectionState(), cal.NEEDS_REAUTH);
  ok("and is NOT reported as connected", cal.getConnectionState() !== cal.CONNECTED);
  ok("nor as disconnected — the fix is one click, not setup",
     cal.getConnectionState() !== cal.DISCONNECTED);

  cal.clearNeedsReauth();
  eq("a working sync clears it", cal.getConnectionState(), cal.CONNECTED);

  cal.forgetConnection();
  eq("disconnecting resets everything", cal.getConnectionState(), cal.DISCONNECTED);
}

group("Re-auth cannot outlive the connection");
{
  store.clear();
  cal.rememberConnection();
  cal.markNeedsReauth();
  cal.forgetConnection();
  eq("no stale warning after disconnecting", cal.getConnectionState(), cal.DISCONNECTED);
  cal.rememberConnection();
  eq("and reconnecting starts clean", cal.getConnectionState(), cal.CONNECTED);
}

group("What the last run did");
{
  store.clear();
  eq("nothing to report before the first run", cal.lastRun(), null);
  eq("and no timestamp", cal.lastSyncedAt(), null);

  cal.recordRun({ found: 4, logged: 2 }, 1_800_000_000_000);
  const run = cal.lastRun();
  eq("what it offered", run.found, 4);
  // The number that matters. Reporting `found` would flatter a run where the
  // user confirmed nothing.
  eq("and what was actually kept", run.logged, 2);
  eq("with a timestamp", run.at, 1_800_000_000_000);

  cal.recordRun({ found: 3, logged: 0 }, 1_800_000_100_000);
  eq("a run that logged nothing says zero", cal.lastRun().logged, 0);
  eq("not the three it found", cal.lastRun().found, 3);

  cal.markSynced(1_800_000_200_000);
  eq("the sync stamp is separate from the result", cal.lastSyncedAt(), 1_800_000_200_000);
}

group("Corrupt storage never breaks the screen");
{
  store.clear();
  store.set("orbit_calendar_last_result", "not json");
  eq("a bad result reads as none", cal.lastRun(), null);
  store.set("orbit_calendar_last_result", JSON.stringify({ nope: true }));
  eq("a result with no timestamp reads as none", cal.lastRun(), null);
}

group("Disconnecting clears the run history too");
{
  store.clear();
  cal.rememberConnection();
  cal.recordRun({ found: 2, logged: 2 });
  cal.markSynced(Date.now());
  cal.forgetConnection();
  eq("no run left", cal.lastRun(), null);
  eq("no timestamp left", cal.lastSyncedAt(), null);
}

done();
