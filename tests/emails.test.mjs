/**
 * Several addresses per person.
 *
 * The failure that matters is silent: a calendar invite sent to someone's work
 * address, when only their personal one was stored, does not error — it just
 * does not match, and "missed" looks identical to "no meetings found".
 */
import { loadMain } from "./helpers/load-main.mjs";
import * as cal from "../js/calendar.js";
import { eq, ok, group, done } from "./helpers/assert.mjs";

const { normalizeContact } = await loadMain();

group("Every address is kept, and one is primary");
{
  const c = normalizeContact({ name: "Marcus", emails: [
    { label: "work", address: "marcus@stripe.com" },
    { label: "personal", address: "marcus@gmail.com" }
  ]});
  eq("both are stored", c.emails.map((e) => e.address),
     ["marcus@stripe.com", "marcus@gmail.com"]);
  // Everything that reads a single string keeps working against this.
  eq("the first is the primary", c.email, "marcus@stripe.com");
  eq("labels survive", c.emails.map((e) => e.label), ["work", "personal"]);
  ok("each gets an id", c.emails.every((e) => e.id));
}

group("A contact saved before this still works");
{
  const legacy = normalizeContact({ name: "Old", email: "old@example.com" });
  eq("the single column becomes the list", legacy.emails.map((e) => e.address),
     ["old@example.com"]);
  eq("labelled personal by default", legacy.emails[0].label, "personal");
  eq("and stays the primary", legacy.email, "old@example.com");
}

group("Nonsense in, nothing out");
{
  eq("no addresses at all", normalizeContact({ name: "X" }).emails, []);
  eq("and no primary", normalizeContact({ name: "X" }).email, "");
  eq("blank entries are dropped",
     normalizeContact({ emails: [{ address: "  " }, { address: "a@b.com" }] })
       .emails.map((e) => e.address), ["a@b.com"]);
  eq("an unknown label falls back",
     normalizeContact({ emails: [{ label: "spaceship", address: "a@b.com" }] })
       .emails[0].label, "personal");
  eq("a non-array is not trusted",
     normalizeContact({ emails: "a@b.com", email: "" }).emails, []);
}

group("The same address twice is stored once");
{
  const c = normalizeContact({ email: "a@b.com", emails: [
    { label: "work", address: "A@B.com" },
    { label: "personal", address: "a@b.com" }
  ]});
  eq("case-insensitively", c.emails.length, 1);
}

group("Calendar matching uses every address");
{
  const marcus = normalizeContact({ id: "c1", name: "Marcus", emails: [
    { label: "personal", address: "marcus@gmail.com" },
    { label: "work", address: "marcus@stripe.com" }
  ]});

  eq("all of them are searched", cal.contactAddresses(marcus).sort(),
     ["marcus@gmail.com", "marcus@stripe.com"]);

  const invite = (to) => ({
    id: "e1", summary: "Sync", status: "confirmed",
    start: { dateTime: "2026-08-05T10:00:00Z" }, end: { dateTime: "2026-08-05T11:00:00Z" },
    attendees: [{ email: "me@x.com", self: true }, { email: to, responseStatus: "accepted" }]
  });

  eq("an invite to the primary matches",
     cal.attendeesInNetwork(invite("marcus@gmail.com"), [marcus]).map((c) => c.id), ["c1"]);
  // The whole point: this used to silently miss.
  eq("an invite to the work address matches too",
     cal.attendeesInNetwork(invite("marcus@stripe.com"), [marcus]).map((c) => c.id), ["c1"]);
  eq("case does not matter",
     cal.attendeesInNetwork(invite("Marcus@Stripe.com"), [marcus]).map((c) => c.id), ["c1"]);
  eq("a stranger still does not match",
     cal.attendeesInNetwork(invite("nobody@x.com"), [marcus]), []);

  const both = cal.attendeesInNetwork({
    ...invite("marcus@gmail.com"),
    attendees: [
      { email: "me@x.com", self: true },
      { email: "marcus@gmail.com", responseStatus: "accepted" },
      { email: "marcus@stripe.com", responseStatus: "accepted" }
    ]
  }, [marcus]);
  eq("one person on twice is counted once", both.length, 1);
}

group("A contact with no address can never match");
{
  const nobody = normalizeContact({ id: "c9", name: "No Email" });
  eq("nothing to search", cal.contactAddresses(nobody), []);
}

done();
