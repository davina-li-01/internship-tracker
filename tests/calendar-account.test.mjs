/**
 * ORB-39 — the calendar connection follows the account, not the browser.
 *
 * Everything about the Google connection lived in localStorage, so it was a
 * property of the DEVICE: open Orbit somewhere new and it claimed you had never
 * connected, while "synced 2 hours ago" quietly meant *on this device* — the
 * worse kind of wrong, because it looks right.
 *
 * The interesting cases are all about which side wins, and the sharpest one is
 * resurrection: a device with stale localStorage must not push a connection
 * back up after you disconnected somewhere else. That is the same shape as the
 * bug that made a deleted email address reappear, so it gets pinned here.
 */
import { eq, ok, group, done } from "./helpers/assert.mjs";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};
globalThis.window = {};
globalThis.document = { querySelector: () => null, createElement: () => ({}), head: { appendChild() {} } };

const cal = await import("../js/calendar.js");

const reset = () => store.clear();
const HOUR = 3600_000;
const NOW = 1786400000000;

group("A device with no connection has nothing to share");
reset();
eq("no snapshot", cal.connectionSnapshot(), null);

group("What a connected device carries");
reset();
cal.rememberConnection();
localStorage.setItem("orbit_calendar_account", "davina@gmail.com");
cal.setSelectedCalendarId("work@group.calendar.google.com");
cal.markSynced(NOW);
cal.recordRun({ found: 4, logged: 3 }, NOW);

const snap = cal.connectionSnapshot();
eq("connected", snap.connected, true);
eq("the account, which is what skips Google's chooser next time", snap.account, "davina@gmail.com");
eq("which calendar it reads", snap.calendarId, "work@group.calendar.google.com");
eq("and when it last synced", snap.lastSyncAt, NOW);
eq("plus what that run did", snap.lastResult.logged, 3);

group("Re-auth state is deliberately NOT shared");
// The access token is memory-only and never stored, so every page load asks
// Google again. One browser failing that says nothing about another — sharing
// the flag would make a working device announce a problem it does not have.
cal.markNeedsReauth();
ok("it is set here", cal.getConnectionState() === cal.NEEDS_REAUTH);
eq("but absent from the snapshot", "needsReauth" in cal.connectionSnapshot(), false);

group("A new device adopts the connection");
reset();
eq("it starts disconnected", cal.getConnectionState(), cal.DISCONNECTED);
const learned = cal.adoptConnection({
  connected: true, account: "davina@gmail.com", calendarId: "primary",
  lastSyncAt: NOW, lastResult: { at: NOW, found: 2, logged: 1 }
});
eq("adopting reports that this browser learned something", learned, true);
eq("it is connected now", cal.getConnectionState(), cal.CONNECTED);
eq("and knows the account", cal.getConnectedAccount(), "davina@gmail.com");
eq("and which calendar", cal.getSelectedCalendarId(), "primary");
eq("and does not think it needs re-authorising", cal.getConnectionState(), cal.CONNECTED);

group("Adopting twice is not news the second time");
eq("already knew", cal.adoptConnection({ connected: true, account: "davina@gmail.com" }), false);

group("A stale record cannot push a fresh device backwards");
// Otherwise a device that synced ten minutes ago is told by a week-old record
// that it is overdue, and syncs again for nothing.
reset();
cal.rememberConnection();
cal.markSynced(NOW);
cal.adoptConnection({ connected: true, account: "a@b.c", lastSyncAt: NOW - 168 * HOUR });
eq("the newer local sync time survives", cal.lastSyncedAt(), NOW);

group("A newer record does move a stale device forward");
reset();
cal.rememberConnection();
cal.markSynced(NOW - 168 * HOUR);
cal.adoptConnection({ connected: true, account: "a@b.c", lastSyncAt: NOW });
eq("it takes the newer time", cal.lastSyncedAt(), NOW);

group("Nothing is adopted from an empty or disconnected record");
reset();
for (const record of [null, undefined, {}, { connected: false, account: "a@b.c" }]) {
  cal.adoptConnection(record);
  eq(JSON.stringify(record) + " leaves it disconnected",
    cal.getConnectionState(), cal.DISCONNECTED);
}

group("Disconnect leaves nothing behind to resurrect");
reset();
cal.rememberConnection();
localStorage.setItem("orbit_calendar_account", "davina@gmail.com");
cal.markSynced(NOW);
cal.disconnectCalendar();
eq("no snapshot to push up", cal.connectionSnapshot(), null);
eq("the account is gone", cal.getConnectedAccount(), "");
eq("and the state says so", cal.getConnectionState(), cal.DISCONNECTED);

group("`connected: false` is a record, not an absence");
// This is the whole reason disconnect stores false rather than deleting the
// key. Collapsing "nobody ever connected" into "somebody disconnected" would
// let a device with stale localStorage helpfully undo the disconnect.
const disconnectedRecord = { connected: false };
ok("a disconnected record is distinguishable from no record at all",
  disconnectedRecord !== null && disconnectedRecord.connected === false);
reset();
cal.adoptConnection(disconnectedRecord);
eq("and adopting it connects nothing", cal.getConnectionState(), cal.DISCONNECTED);

group("The nav rule still reads from the same one key");
reset();
eq("unconnected counts toward the nav entry point", cal.countNotConnected(), 1);
cal.adoptConnection({ connected: true, account: "a@b.c" });
eq("adopted counts as connected, so the entry point goes", cal.countNotConnected(), 0);
ok("and the pre-paint key agrees",
  localStorage.getItem("orbit_calendar_connected") === "1");

done();
