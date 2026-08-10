/**
 * Local calendar-date helpers for tests.
 *
 * Suites used to roll their own with `toISOString().slice(0, 10)`, which
 * formats in UTC. That is exactly the bug it let through: the app's date
 * helpers work in local time, so west of UTC the tests and the code disagreed
 * for ten hours a day — and agreed for the other fourteen, which is why it
 * survived so long.
 *
 * A test must not reimplement the thing it is checking with a different clock.
 */

/** A Date to YYYY-MM-DD, in the local timezone. */
export function toDateString(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

export function today() {
  return toDateString(new Date());
}

export function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return toDateString(d);
}

export function daysAhead(n) {
  return daysAgo(-n);
}
