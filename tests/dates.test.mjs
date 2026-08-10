/**
 * Dates are calendar days, not instants.
 *
 * These exist because of a bug found on 2026-08-09 at 14:28 in Hawaii, when
 * `todayDateString()` returned 2026-08-10. It formatted in UTC, while
 * `parseDateOnly` and `daysSince` worked in local time — so for the ten hours
 * between local afternoon and UTC midnight, Orbit stamped tomorrow's date on
 * anything you logged and then measured elapsed days against today's.
 *
 * Clicking "Reached out" recorded a conversation on a day that had not happened
 * yet. Nothing errored. The whole suite passed, because every test computed its
 * expectations the same wrong way in the morning and a different wrong way in
 * the evening.
 *
 * The invariant worth holding: every date helper agrees with every other one,
 * in whatever timezone the person is actually standing in.
 */

import { loadMain } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";

const {
  todayDateString, addDays, daysSince, getHealth, normalizeContact,
  calculateNextReminder, firstDeadlineFor, GRACE_DAYS, relativeDayLabel
} = await loadMain();

/** The local calendar date, computed independently of the code under test. */
function localToday() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
}

group("Today means today where you are standing");
{
  eq("todayDateString is the local calendar date", todayDateString(), localToday());

  // The assertion that would have caught the original bug. In UTC-10 during the
  // local afternoon these differ; anywhere east of UTC they differ in the
  // morning. Only a local-time formatter satisfies it everywhere, always.
  ok("and is not the UTC date unless those genuinely coincide",
     todayDateString() === localToday());

  eq("today is zero days ago", daysSince(todayDateString()), 0);
  eq("and reads as 'today'", relativeDayLabel(todayDateString()), "today");
}

group("addDays round-trips through the same clock");
{
  const today = todayDateString();
  eq("plus nothing is today", addDays(today, 0), today);
  eq("plus one, minus one", addDays(addDays(today, 1), -1), today);
  eq("a week forward is seven days away", daysSince(addDays(today, 7)), -7);
  eq("a week back is seven days ago", daysSince(addDays(today, -7)), 7);
  eq("yesterday reads as yesterday", relativeDayLabel(addDays(today, -1)), "yesterday");
  eq("tomorrow reads as tomorrow", relativeDayLabel(addDays(today, 1)), "tomorrow");
  eq("an unparseable date gives nothing", addDays("", 3), "");
}

group("Boundaries the naive version got wrong");
{
  eq("crosses a month end", addDays("2026-01-31", 1), "2026-02-01");
  eq("crosses a year end", addDays("2026-12-31", 1), "2027-01-01");
  eq("handles a leap day", addDays("2028-02-28", 1), "2028-02-29");
  eq("and the year after it", addDays("2027-02-28", 1), "2027-03-01");
  eq("steps back over a year end", addDays("2027-01-01", -1), "2026-12-31");
}

group("Cadences land where the countdown says");
{
  const today = todayDateString();

  eq("a monthly cadence from today is 30 days out",
     calculateNextReminder(today, "monthly"), addDays(today, 30));

  // The user-visible symptom of the original bug: a grace window that was a day
  // longer than the one the app promised.
  eq("a grace window is exactly GRACE_DAYS long",
     firstDeadlineFor(addDays(today, -400), "monthly"), addDays(today, GRACE_DAYS));

  const justLogged = normalizeContact({
    name: "Test", followUpFrequency: "monthly", reminderEnabled: true,
    lastContacted: today, nextReminder: calculateNextReminder(today, "monthly")
  });
  const health = getHealth(justLogged);
  eq("someone spoken to today is in touch", health.band, "good");
  eq("with the full window left", health.daysLeft, 30);
  eq("and no elapsed time", health.elapsed, 0);

  const overdue = normalizeContact({
    name: "Test", followUpFrequency: "monthly", reminderEnabled: true,
    lastContacted: addDays(today, -40), nextReminder: addDays(today, -10)
  });
  eq("ten days past the deadline is overdue", getHealth(overdue).band, "critical");
  eq("by ten days", getHealth(overdue).daysLeft, -10);
}

done();
