/**
 * The nav show-rule (ORB-34).
 *
 * One clause carries most of the weight: the entry point must NOT come back
 * when a token expires or a sync fails. It is a discovery affordance, and
 * resurfacing it on every expiry would turn it into a recurring error badge —
 * a broken connection announces itself on the dashboard card instead (ORB-35).
 * Only an explicit disconnect (ORB-36) brings it back.
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

const shows = () => cal.countNotConnected() > 0;

group("Shown only while something is unconnected");
{
  store.clear();
  ok("a brand-new user sees it", shows());

  cal.rememberConnection();
  ok("connecting removes it", !shows());
}

group("An expired token does NOT bring it back");
{
  store.clear();
  cal.rememberConnection();
  cal.markNeedsReauth();

  eq("the state is needs-reauth", cal.getConnectionState(), cal.NEEDS_REAUTH);
  // The clause that matters most in the whole ticket.
  ok("but the nav item stays hidden", !shows());
  eq("because needs-reauth is not counted as unconnected", cal.countNotConnected(), 0);
}

group("Only an explicit disconnect brings it back");
{
  store.clear();
  cal.rememberConnection();
  cal.markNeedsReauth();
  ok("still hidden while broken", !shows());

  cal.disconnectCalendar();
  ok("and back after disconnecting", shows());
  eq("state is disconnected", cal.getConnectionState(), cal.DISCONNECTED);
}

group("The rule counts integrations, it does not name one");
{
  store.clear();
  const all = cal.integrationStates();
  ok("there is a registry", all.length >= 1);
  ok("each entry carries an id, a name and a state",
     all.every((i) => i.id && i.name && i.state));
  // Written against the count so a second integration needs no rule change.
  eq("count matches the disconnected entries",
     cal.countNotConnected(),
     all.filter((i) => i.state === cal.DISCONNECTED).length);
}

group("Which calendar is read");
{
  store.clear();
  eq("defaults to the main one", cal.getSelectedCalendarId(), "primary");
  cal.setSelectedCalendarId("work@example.com");
  eq("and remembers a choice", cal.getSelectedCalendarId(), "work@example.com");
  cal.setSelectedCalendarId("");
  eq("an empty choice falls back", cal.getSelectedCalendarId(), "primary");

  cal.setSelectedCalendarId("work@example.com");
  cal.disconnectCalendar();
  eq("disconnecting forgets it", cal.getSelectedCalendarId(), "primary");
  eq("and forgets the account", cal.getConnectedAccount(), "");
}

done();
