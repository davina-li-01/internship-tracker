# Orbit — engineering roadmap

Confluence is the source of truth for **what** and **when**
([Customer Experience EPIC](docs/PRD.md) · Roadmap Q3 2026).
This file is the source of truth for **how** — the engineering shape of each item,
the costs, and the parts that are not obvious from the ticket.

Aligned to Confluence 2026-08-08. Every ORB key below matches the epic.

---

## Q3 2026 · Aug 1 – Sep 30

| Start | Key | Item | Team | Pri | Effort | Status |
|---|---|---|---|---|---|---|
| Aug 8 | ORB-13 | "Marked as reached out" flow | Core | **High** | High | ✅ Done |
| Aug 8 | ORB-14 | "+" icon confirming logged conversation | Core | Med | Low | ✅ Done |
| Aug 8 | ORB-20 | PDF attached to conversation | Core | Low | Low | ✅ Done |
| Aug 8 | ORB-16 | Scheduled email reminders | Integrations | Med | High | ✅ Done — live |
| Aug 8 | ORB-15 | Google Calendar integration | Integrations | **High** | High | 🔶 Built — needs your Google client |
| Aug 12 | ORB-17 | AI talking points | Core | Med | Low | Next — spec agreed 2026-08-10 |
| — | ORB-18 | Audio transcription | Core | **High** | Med | ⏸ Deferred by Davina 2026-08-10 — she is writing the spec |
| Aug 12 | ORB-24 | Idle-pause resilience | Integrations | **High** | Med | ✅ Done 2026-08-10 — no setup |
| Aug 19 | ORB-21 | Two-factor authentication | Integrations | Med | Med | Not started |
| Aug 19 | ORB-23 | Network health over time | Integrations | Med | Med | Not started |
| Sep 7 | ORB-22 | Key people tier | Core | Low | Low | Not started |
| Sep 7 | ORB-19 | Thank-you draft from conversation | Core | Low | Low | Not started |
| — | ORB-26 | Edit a conversation's notes | Core | **High** | Low | ✅ Done |
| — | ORB-27 | Photos as attachments | Core | **Could have** | Low | ⚠️ Shipped ahead of priority |
| — | ORB-28 | "Coming up" on the dashboard | Core | Med | Med | ✅ Done |
| Aug 9 | ORB-34 | Integrations entry point in main nav | Integrations | Med | Med | ✅ Done |
| Aug 9 | ORB-36 | Integrations pane in Settings | Integrations | Med | Med | ✅ Done |
| Aug 9 | ORB-35 | Sync from the dashboard | Integrations | Med | Med | ✅ Done |
| Aug 9 | ORB-27 | Revisit email reminder logic | Integrations | Med | Med | 🔶 Built — needs SQL |
| — | ORB-37 | Match calendar events by name, not just email | Integrations | Med | High | 📋 Backlog — spec below, not started |
| Aug 10 | ORB-38 | Digest fires at 9am in the reader's timezone | Integrations | Med | Low | ✅ Done 2026-08-10 — needs SQL |
| Aug 10 | ORB-39 | Calendar connection follows the account, not the device | Integrations | Med | Med | ✅ Done 2026-08-10 — needs SQL |

Dates are current-constraint estimates and expected to move **up**, not back.

---

## What changed when Confluence landed

**ORB-13 is unblocked.** It sat here as an open design problem with four options and
no decision, waiting on a week of real use. The epic's open-questions table now
answers it: *"Usually they want the row gone. We can wait to see if they want notes."*
That eliminates the two expensive options — the conversation-logger version and the
swipe gesture — and picks **one-click done with undo**. It is the reason this moved
from "worth deciding later" to the top of the quarter.

**ORB-18 Audio transcription is new.** It was not in this file at all. High priority,
starting Aug 12 alongside AI talking points.

**The old "suggested order" was stale.** It recommended AI talking points as the first
feature and told you to use the app for a week first. The Confluence sequencing
supersedes it: ORB-13 and ORB-14 start today, talking points on Aug 12.

**Other answered questions, and what they mean for the build:**

| Question | Answer | Consequence |
|---|---|---|
| Fixed cadence the right model? | Good for now; adapt to observed behaviour later | Do not over-fit the cadence code — a seasonal/adaptive model is coming |
| Is 7 days the right grace window? | A guess; validate by interview | Keep `GRACE_DAYS` a single named constant. It already is |
| Suggest people to add? | Feels invasive; revisit with ORB-15 | Not a standalone feature — a Calendar sub-feature at most |
| Holds up at 500 contacts? | Edge case. Cap free tier ~50, paid above | No virtualisation work needed now |
| Is CSV export enough? | Yes for now | ORB-12 stays shipped as-is |

---

## ⏸ Where things stand — 2026-08-09

**Every Aug 8 item is closed except ORB-15**, which is in progress.

ORB-13, ORB-14 and ORB-20 shipped, plus a pre-existing dark-mode button bug found
on the way. **ORB-16 is live** — the cron job runs daily and a real digest has
been delivered end to end.

**Two bugs surfaced during ORB-16 setup that predate it:**
- `preferences` had RLS enabled with **zero policies**, so the whole table had been
  silently unsaveable — your name, contact email and phone were never persisting.
  This is invisible until a write 403s, because reads just return nothing.
  `supabase/check-rls.sql` now catches it in one query.
- Every primary `.btn` in dark mode was white-on-white.

Both were found by exercising the app rather than reading it, which is the pattern
worth keeping.

**Next, per the Confluence dates:** finish ORB-15, then Aug 12 brings ORB-17 AI
talking points (self-contained, no external auth — the easier of the two) and
ORB-18 audio transcription, which still needs a spec before it can start.

**Worth doing before more features:** actually use the one-click reach-out flow for
a few days. ORB-13's open question was answered "they just want the row gone" — the
build takes that at its word and captures no notes. Real use is what tells you
whether that holds.

---

## Engineering notes by item

### ORB-13 — "marked as reached out" flow · ✅ done 2026-08-08
**The problem.** To record that you reached out, you click **Reach out** — a
future-tense label — which opens a modal, where you click **I reached out**. Two
clicks and a modal for one gesture, and the label points the wrong way in time.

**Decided shape** (from the answered open question): the row's primary action marks
it done in **one click**, past-tense label, with an **undo toast**. No modal on the
happy path. The existing modal keeps its genuinely useful parts — draft message,
snooze, remove schedule — behind a secondary action.

Notes capture is deliberately *not* built. The answer says wait and see whether
people want it; the conversation logger already exists for when they do.

**Shipped as:** `markReachedOut()` in `js/main.js`. Rows on the Dashboard and My
Network show **✓ Reached out** (one click) beside a demoted **Draft** button. The
old modal survives as the draft/snooze/remove-schedule path and is retitled
"Draft a message to X", matching the profile button that already opened it. The
profile gained the same one-click action so the habit transfers. Marking done
from anywhere confirms with undo.

### ORB-14 — confirm a logged conversation landed · ✅ done 2026-08-08
**The data is correct; this is a display gap.** The conversation saves with its notes.
The problem is that no page which offers **+** ever shows it back:

| Page | Has **+** | Shows conversations? |
|---|---|---|
| Dashboard | yes | No — it lists people who *need attention*, and someone you just spoke to is healthy, so they are correctly absent |
| My Network | yes | No — rows show role, company and health, never notes |
| Networking Log | **no** | Yes — the only page that previews conversations |

Worse, the modal prints its confirmation and then destroys itself 1.1s later, so the
one piece of feedback that exists is thrown away with the DOM.

**Shape:** the confirmation outlives the modal and names the person, with a link to
where the conversation is actually visible.

**Acceptance criteria**
- After logging, the user sees confirmation that names the person
- There is a path from that confirmation to where the conversation is visible
- No page offers creating something it will never display

**Shipped as:** `showToast()` in `js/main.js` — a confirmation appended to
`document.body`, so it survives both the modal closing and the page re-rendering.
The quick-add modal now closes first and confirms outside itself, naming the person
and linking to **View in log**. The inline widget on the Networking Log keeps its
inline message, because that page already shows the conversation underneath.

*Shared the toast with ORB-13 — one component, two uses.*

**Found while building this:** every primary `.btn` in dark mode was white text on
a white background. `.btn` is `background: var(--text)` and dark mode sets
`--text: #FAFAF9`, the same value as its own `color`. Orange CTAs escaped only
because they are an explicit allow-list of form submits and ids. Fixed in
`css/style.css` with a `body.dark` override that leaves that allow-list and
`.btn-secondary` alone. Pre-existing, unrelated to these tickets — it just became
visible when a primary button landed in the dashboard rows.

### ORB-15 — Google Calendar sync ★ highest leverage · 🔶 built 2026-08-09
Orbit only works if you remember to log touchpoints — exactly the habit that fails.

**Browser-only, decided 2026-08-09.** Google Identity Services token flow, the
Calendar REST API called straight from the page. The access token lives in a
variable and is never persisted: no refresh token, nothing in localStorage,
nothing in the database. The client id is not a secret — Google issues these to
be shipped in browser code, which is what removes the server entirely.

The cost is that sync only happens while Orbit is open. That was taken over
storing refresh tokens and submitting for Google's verification review.

**It proposes, it does not auto-write.** The epic says "auto-log"; this shows a
pre-ticked list instead, so the common case is still one click. The reason is
that a calendar entry is an intention, not a record — and logging one rolls the
cadence forward, so a wrong match makes a drifting relationship look healthy.
That is the one failure this app cannot afford. Flip it to silent auto-logging
by calling `applyCalendarCandidates()` directly from the sync handler.

**Filtering before you ever see a candidate:** cancelled events, future events,
ones you declined, ones the contact declined, anything over `MAX_ATTENDEES` (12,
a broadcast rather than a conversation), and anything already logged.

**Dedupe** stores the calendar event id on the interaction (`sourceEventId`),
which needs no migration for the same reason ORB-20's `fileIds` did not —
interactions are jsonb. Synced entries compare by id, so a renamed meeting is
still recognised. Hand-typed entries have no id, so those fall back to date plus
title, which is what stops the first sync duplicating a history you wrote up
yourself.

**Known cost:** matching is by email, so contacts without one can never match.

**Blocked on you:** a Google Cloud project and OAuth client. See
`docs/CALENDAR-SETUP.md`. Client id is already wired into `js/calendar.js`.

### ORB-16 — Scheduled email reminders · ✅ live 2026-08-09
The in-app nudge only fires when you open Orbit. This is the first part of Orbit
that runs when the tab is closed.

**Correction to the epic:** it says ORB-16 shares infrastructure with ORB-15 and
they should be sequenced together. That was true of a server-side calendar sync;
it is not true of the browser-PKCE design that was chosen (2026-08-09). They share
nothing. ORB-16 is server-side and ORB-15 is entirely client-side.

**Shape:** `pg_cron` (daily, 13:00 UTC) → `pg_net` HTTP call → `send-reminders`
Edge Function → Resend. Logic lives in `reminders.ts` with no I/O so it can be
tested; `index.ts` is only the wiring.

**It never recomputes health.** `contacts.next_reminder` is the deadline the app
already stored, so the job's whole question is whether that date has passed. A
second implementation of the banding rules is how the email would start
disagreeing with the dashboard.

**Three independent brakes on spam**, because this is the one feature that reaches
you when you did not ask:
- one digest per user, never one email per person
- a 7-day per-contact cool-off — someone stays overdue until you reach out, so
  without it they would be in every digest forever
- a per-user daily/weekly cadence, tracked separately

`MAX_PER_DIGEST` caps a digest at 8 names, and the overflow is deliberately **not**
stamped — stamping someone never mentioned would silence them for a week.

Defaults to **off**. Email has to be opted into, never inherited.

**Deployed and verified end to end 2026-08-09** — cron job `orbit-send-reminders`
active on `0 13 * * *`, one real digest delivered to the inbox (not spam). Setup
steps are in `docs/REMINDERS-SETUP.md`.

**Two things went wrong that the docs now cover.** Edge Functions require a JWT by
default, so the first deploy was rejected by the gateway before the function ever
ran — `supabase/config.toml` now sets `verify_jwt = false`. And `preferences` had
RLS enabled with **zero policies**, which had made the whole table silently
unsaveable; `supabase/check-rls.sql` now catches that in one query.

### ORB-17 — AI talking points
`generateFollowUpSuggestions()` is a keyword heuristic that pattern-matches action
verbs in your notes. It works but reads mechanically. Self-contained, no external
auth. Must degrade to the current heuristic if the model call fails.

### ORB-18 — Audio transcription *(new from Confluence)*
Record a conversation and store the transcript automatically, so notes never have to
be retyped. High leverage: it removes the transcription step entirely and pulls more
of the networking workflow inside the app.

**Unscoped.** Open engineering questions before this can be estimated:
- Capture: `MediaRecorder` in-browser, or upload an existing file?
- Transcription: which model, and does audio go through an Edge Function (the API key
  cannot live in the browser)?
- Storage: audio in the existing bucket, or transcript text only?
- Consent: recording another person has legal requirements that vary by jurisdiction

### ORB-26 — Edit a conversation's notes · ✅ done 2026-08-09 *(new)*
**Conversations could never be edited. Anywhere.** One was sealed the moment it
saved, which barely showed while everything was typed by hand — but a
calendar-synced entry starts with nothing but the event title, so "Coffee with
Marcus" was all it would ever say. The health data updated and the substance
never arrived.

Every conversation now has **Edit notes** on the profile timeline, and the
calendar review modal offers a notes box per row, because reviewing the list is
the moment you still remember the meeting. Typed notes go under the meeting name
rather than replacing it.

### ORB-27 — Photos as attachments · ⚠️ Could have, already shipped
**Deprioritised 2026-08-09, after it was built.** The decision: typing notes is
the expected path, and photographing handwritten ones is a nice-to-have, not
something to design around.

The code is in and tested, so it has not been removed — reverting working,
covered code to match a priority label costs more than it saves. It is recorded
here as **Could have** so the roadmap tells the truth about intent, and so
nothing further is invested in it. If it should come out, the revert is
contained: `ATTACH_ACCEPT`, `isAllowedAttachment`, `isImageFile`, the
`.doc-preview-img` branch, and the `accept` in `files.html`.

Original rationale, kept for context: attachments were PDF-only everywhere, so
the most common way people take notes — writing them down and photographing them
— could not be filed at all.

Images are accepted wherever a PDF was, including **HEIC by extension**, since
that is what an iPhone shoots by default and browsers report no MIME type for
it. Photos preview as real `<img>` tiles; PDFs keep the `<object>` preview that
renders page one without a library. HEIC will not decode in any browser, so it
falls back to a placeholder rather than a broken image.

Spoken notes are still ORB-18.

### ORB-28 — "Coming up" on the dashboard · ✅ done 2026-08-09 *(new)*
The rest of the dashboard is about people you are neglecting. This is the other
half: the conversation you are **about to have**, paired with that person's open
"things to bring up next" — which would otherwise sit unread on a profile until
after the meeting.

Shows who, when, and how (Meet / Zoom / Teams / a street address), with a join
link where there is one. Google puts the medium in three different places
depending on how the invite was made, so all three are checked before falling
back to `location`.

Past and future come from **one** Calendar request rather than two.

**A real change to "nothing is stored":** upcoming meeting titles, times and
matched names are cached in localStorage so the dashboard renders instantly
instead of blocking on Google. The token is still never stored — that is the
part that matters — but this is no longer literally nothing. Disconnect clears
it, and anything already past is dropped on read so a stale cache cannot show a
meeting you already had.

### ORB-19 — Thank-you draft from a conversation
A thank-you written from what you just wrote, not the generic reconnect template.
Same model call as ORB-17 — one prompt path, two entry points.

### ORB-20 — PDF notes on a conversation · ✅ done 2026-08-09
**No schema migration was needed.** `storage_files` has a `contact_id` but nothing
tying a file to one *conversation*. Rather than add a column — which would have
meant running SQL in the Supabase dashboard — the link lives as `fileIds` on the
interaction, and interactions are a jsonb column on `contacts`. Free to add.

The profile page uploads before saving, since the contact id is already known, so
that path is a single write. The Networking Log has to save first when the person
is brand new — there is no id to attach to until then — so that path writes twice
and patches the link on. Either way **a storage failure costs the attachment, never
the conversation**, and says so.

Attachments render as chips inside the conversation in the profile timeline, with a
📎 count on the collapsed summary so nothing hides. Ids that no longer resolve are
skipped at render time, so deleting a PDF from the Files page leaves the
conversation intact rather than a broken link.

Also closed a small ORB-14-shaped gap found on the way: a conversation logged with
a PDF and no notes used to render nothing at all in the Networking Log.

### ORB-21 — Two-factor authentication
The Security tab explains the options but nothing is wired. **Authenticator app
(TOTP)** is the one to build — free on Supabase and works offline. SMS needs a paid
provider and is weaker (SIM-swap).

### ORB-22 — Key people tier
Needs `alter table contacts add column starred boolean`. Note `contactToRow()` in
`js/db.js` currently omits `starred` on purpose because the column does not exist.

### ORB-23 — Network health over time
Requires historical snapshots, which are not stored. Needs a schema decision before
anything else: a periodic snapshot table, or derive from `interactions` history.

### ORB-24 — Idle-pause resilience · ✅ done 2026-08-10
Free-tier Supabase pauses after ~7 days idle and the project loses its DNS record, so
the app dies with no useful error. Already cost a full debugging session once.

**The obvious fix cannot work.** A scheduled ping from pg_cron pauses when the
project does, so the thing meant to prevent the outage is the first casualty of it.
The ping has to come from outside the project.

**Shipped as** `.github/workflows/keep-warm.yml` — one anonymous, read-only REST
request a day, retried five times with a long timeout because a paused project
cold-starts slowly rather than failing. 401 and 403 count as success: RLS refusing
an anonymous read is Postgres answering, which is the whole proof required.

It also protects the digest. The reminder job is pg_cron, so a paused project stops
the emails too — the message that would bring you back to Orbit is exactly what
stops when you stay away.

**Nothing to set up.** The URL and publishable key are read out of `js/supabase.js`
at run time. An earlier version asked for a repository variable holding the same key,
which was ceremony: that file already ships both to every visitor's browser, so
copying the key into GitHub bought a setup step, a second place to forget when the
key rotates, and no security at all. Access is enforced by Row Level Security, not by
keeping a publishable key quiet.

The **service-role** key is the opposite case — it bypasses every RLS policy. It is
not in this repo and must never be.

Verified by extracting the step's script from the YAML and running it against the
live project: HTTP 200. The failure path was checked too — pointed at a file with no
key in it, it exits 1 with an error naming the file rather than silently pinging
nothing.

### ORB-38 — the digest arrives in your morning · ✅ done 2026-08-10
pg_cron is UTC-only, so one daily fire at 13:00 UTC was mid-morning in London and
half past two in the morning in Honolulu. A nudge that lands overnight is read the
next day with everything else, which defeats the point of a fixed rhythm.

**The cron runs hourly now** and `SEND_HOUR` (9) decides whose turn it is, compared
against `preferences.timezone`. Hourly is not the same as emailing hourly — 23 of
those runs find nobody at 9am and send nothing.

**A quieter bug came with it.** "Who is overdue" is a DATE comparison and the date
came from `now.toISOString()` — UTC. Sending at 9am local in a zone far enough east
means the UTC date has not rolled over, so a contact due today would not be found at
all. Exactly the fault that once made `todayDateString()` stamp tomorrow's date in
the browser, arriving by a different route. `zonedNow()` returns the date and the
hour from one formatter call so they cannot disagree.

The timezone is **detected, not asked for** — a picker is a long list of names to
answer a question the browser already knows, and the cost of being wrong is the hour
an email arrives. An unparseable zone falls back to UTC rather than skipping the
user: a bad string in one row should cost that person a well-timed email, not cost
everyone their email.

`tests/digest-timezone.test.mjs` imports the Edge Function's `.ts` directly — node
strips the types, so it tests the shipping file rather than a copy. Reverting the
date fix alone fails two of its assertions.

**Needs from you:** run `supabase/add-timezone.sql`, then redeploy the function.

### ORB-39 — the calendar connection follows the account · ✅ done 2026-08-10
Everything about the Google connection lived in `localStorage`, so it was a property
of the BROWSER: open Orbit somewhere new and it claimed you had never connected
Google, while "synced 2 hours ago" quietly meant *on this device* — the worse kind of
wrong, because it looks right.

`preferences.integrations` is the durable copy. **localStorage stays, and is not a
fallback — it is the synchronous one.** The pre-paint script on every page reads
`orbit_calendar_connected` to decide the Integrations nav item before first paint,
and an async read there would reintroduce exactly the flash that script was written
to remove.

**What is shared and what is not**

| | Where | Why |
|---|---|---|
| connected, account, calendar id, last sync, last result | account | Facts about the account. A sync writes contacts, so it is genuinely true everywhere that the data is fresh |
| needs-reauth, reconnect nudge | device | The token is memory-only and never stored, so every page load asks Google again. One browser failing that says nothing about another — sharing it would make a working device announce a problem it does not have |

**Disconnect stores `connected: false` rather than removing the key.** No record
means nobody ever connected; false means somebody deliberately disconnected.
Collapsing the two would let a device with stale localStorage push the connection
back up — the same resurrection shape as the deleted email address that reappeared.
`tests/calendar-account.test.mjs` pins it, along with the merge rule that stops a
week-old record telling a device that synced ten minutes ago to sync again.

Writes happen on deliberate acts only — connect, disconnect, change of calendar —
never on a timer, so the stored record always reflects a decision somebody made
rather than whichever tab loaded last.

**Needs from you:** run `supabase/add-integrations.sql`. Until then the connection
still works, just per-device: `savePreferences` reports the column as skipped and
the console says so, rather than the save failing.

### ORB-25 — Company logos · won't have
Needs an external logo API on every render — a runtime dependency for decoration.
Deliberately skipped.

---

## A timezone bug the tests found on their first day

`todayDateString()` formatted in **UTC** while `parseDateOnly` and `daysSince`
worked in **local time**. West of UTC that means every afternoon and evening the
app stamped tomorrow's date on anything you logged, then measured elapsed days
against today's. In Hawaii that is a ten-hour window, daily.

Clicking **✓ Reached out** at 2pm recorded a conversation on a day that had not
happened yet. A grace window came out a day longer than the one promised.
Nothing errored.

`addDays` and `calculateNextReminder` had the mirror-image version of the same
fault — both built a local midnight and then read it back through
`toISOString()`, which is a day early anywhere east of UTC.

It survived because the tests reimplemented the same conversion, so they agreed
with the code for fourteen hours a day and disagreed for ten. It surfaced the
first time the suite ran in the evening rather than the morning.

All date helpers now go through one local `toDateString()`, and
`tests/helpers/dates.mjs` exists so no suite reimplements the thing it is
checking with a different clock. `tests/dates.test.mjs` holds the invariant.

---

## Tests

`npm test` — 11 suites, 315 assertions, no build step. `npm run test:functions`
for the Edge Function (Deno). See `tests/README.md`.

They live in the repo as of 2026-08-09. Before that they only existed in a
scratch directory, which meant the only safety net this codebase had would have
vanished with it.

Moving them in exposed something worse: five suites imported from a **hand-made
copy** of `js/main.js`, and that copy predated the reach-out rework, the toast,
calendar sync and conversation attachments. 133 assertions had been passing
against code that had not run in days. Suites now read `js/main.js` from disk at
load time, so a passing suite is a suite that passed against what ships.

---

### ORB-27 — Revisit email reminder logic · 🔶 built 2026-08-10
**The first version was the wrong shape, not the wrong numbers.** It emailed
whenever someone crossed their deadline, then fought the consequences with a
per-contact cool-off and a per-user throttle. Event-driven delivery arrives
unpredictably, so it can never become a habit — only an interruption, and
interruption is what gets email muted.

**Now a fixed fortnight.** One email per period by construction, containing
whoever is drifting at that moment, most overdue first. The schedule *is* the
grouping, so the cool-off is gone entirely.

**It anchors itself.** Fourteen days is exactly two weeks, so the first digest
fixes the weekday for every one after it, without the function knowing anything
about the user's timezone.

**Chronic cases are demoted.** Someone still overdue after `CHRONIC_AFTER` (3)
consecutive digests stops being named and becomes one line: *"the cadence you
set for them may be wrong."* Repeating a name ignored three times is nagging,
and by then the problem has changed — it is not that you forgot, it is that you
said monthly and meant quarterly.

Streaks reset for anyone who lapsed and came back; they are a normal case
returning, not a chronic one. A quiet fortnight does not stamp the period, so it
cannot silently become a month. Legacy `daily`/`weekly` values still count as
opted in — a migration that stops someone's email without telling them is worse
than one that changes its rhythm.

**Blocked on you:** `supabase/add-digest-streak.sql`, then redeploy the function.

### ORB-34 — Integrations entry point in main nav · ✅ done 2026-08-10
**A discovery affordance, not a menu item.** The nav entry is a **top-level
item**, below Networking Log rather than inside its dropdown — nesting it there
put a first-run discovery link behind a collapsed group, which is the one place
someone who has not connected anything will not look. It appears *if and only
if* at least one integration is `not_connected`, re-evaluated on load and after
every state change.

**The clause that shapes everything: it never returns on token expiry or sync
failure.** `needs-reauth` is a working connection needing a nudge, not an
undiscovered feature — resurfacing the nav item on every expiry would turn
discovery into a recurring error badge. The only path back is an explicit
disconnect (ORB-36). A broken connection announces itself on the dashboard card
instead (ORB-35).

**The rule counts unconnected integrations rather than naming Google Calendar**,
so a second integration needs an entry in `integrationStates()` and no change to
the rule.

One card per integration; benefits copy in the card's expanded state; no
separate benefits page and no pop-ups. `connecting` is an inline button state,
not a full-screen loader. The nav item is `hidden` in markup and revealed by the
rule, so it never flashes on for a connected user before JS has evaluated.

### ORB-36 — Integrations pane in Settings · ✅ done 2026-08-10
**Always present, in every state**, independent of the ORB-34 rule — that is the
whole point of the split. Discovery goes away once you have connected;
management must not, because it has to be findable exactly when something has
broken.

Carries status, the connected account, last-synced, which calendar is being read
(changeable), re-authorise and disconnect. The connected account comes from
`calendarList` rather than a profile scope: a calendar's id *is* the address that
owns it, so showing it costs no extra permission.

**Disconnect asks whether to keep or remove auto-logged conversations, and
defaults to keep.** Those meetings happened — the record is real history, and
deleting it as a side effect of unlinking a calendar is not recoverable. Removal
is offered because someone who connected the wrong account wants the mess gone,
and it names the count before the choice is made. Removing also moves
`lastContacted` back, or health would keep counting from touchpoints that no
longer exist.

**Four states, because two could not describe reality.** The state that happens
most is: connected weeks ago, Google has since expired the grant, nothing works
until you click again. "Connected or not" reported that as healthy — which is
exactly how Settings came to claim a working calendar it could not read.
`getConnectionState()` returns disconnected / connecting / connected /
needs-reauth, and a failed silent sync raises the flag rather than forgetting
the connection, because the fix is one click and forgetting would hide that.

The benefits copy lives in a `<details>`. It is a pitch: worth reading once,
noise every time thereafter, and it used to sit between the user and the
controls.

The tab stays after connecting, so disconnect, re-authorise and sync status all
have a home.

### ORB-35 — Sync from the dashboard · ✅ done 2026-08-10
A button, a timestamp, and what the last run actually did.

**`found` and `logged` are different numbers**, and only the second answers "did
that button do anything". A run that surfaced four meetings and logged none did
nothing; reporting the four would flatter it. So the count comes from the review
modal after confirmation, not from the sync.

**Only renders in `connected` or `needs-reauth`** — hidden until a connection
exists, because a sync button for a calendar you never linked is noise.

**In `needs-reauth` this card is the only place the problem surfaces**, since the
nav entry point is gone by then and deliberately does not come back for an
expired token. So it carries the error and deep-links to Settings →
Integrations, where the fix actually lives.

---

## Found by using it — 2026-08-09/10

**The Google popup on every refresh.** `markSynced` was only stamped on success,
so a failing sync never backed off: `autoSyncDue` stayed true, every page load
retried, and every retry asked Google for a token. A backoff that only applies
when things are working is not a backoff. Now stamped on the attempt.

**"Connected" meant a token, not a calendar.** `connectCalendar` remembered the
connection immediately after the grant and before the first fetch, so Settings
read *Connected — checked automatically every few hours* while every read
returned 403. The fetch has to succeed first.

**401 and 403 were the same error.** Both produced "Google access expired.
Connect again", which sends you round the reconnect loop when the real cause is
usually that the Calendar API was never enabled for the project. Google explains
itself in the response body and it was being discarded.

**A conversation you already wrote up got offered again.** `alreadyLogged`
compares event ids, then falls back to date plus title — which cannot recognise
your own wording as the same meeting. The review modal now detects a same-day
entry, unticks it, quotes what is already there, and offers *skip* / *merge into
what I wrote* / *log separately*. Only the user knows which.

**Conversations could not be deleted.** So a wrong sync could not be undone
except by editing notes to nothing. Delete confirms rather than offering undo:
unlike a reach-out, notes cannot be reconstructed, and an eight-second toast is
a poor guardian of the only copy. Removing the newest conversation moves
`lastContacted` back to whatever is now newest, or the health bar keeps counting
from a touchpoint that no longer exists.

**One missing `</div>` wrecked the whole profile.** The view/edit split dropped
the tag that closed `.profile-identity`, so `.reachout-strip` became its child
instead of its sibling. `.profile-identity` is a flex **row**: the entire
reach-out panel lined up beside the name, the detail grid was squeezed into
~190px, and the labels overlapped each other. Every card below it ended up
nested inside the hero card as well.

Nothing caught it. It does not throw, the tests all passed, and the browser
silently repairs the markup into the broken-but-valid shape. What was missing
was any test that asked the parsed DOM *what contains what* —
`tests/profile-structure.test.mjs` now does, and removing that one tag again
fails eight assertions.

Second cause, same screenshot: `.profile-name` was already the sidebar's
account-name class. Unscoped, it also caught the contact's name on the profile
and applied `white-space: nowrap; overflow: hidden` at 0.8rem, shaving the
heading down to a sliver. Both rules are now scoped to their own container.

**Every conversation opened expanded.** The newest auto-opened and pushed the
rest down the page. All collapsed now, with the first line of the notes on the
closed row — for calendar-logged entries that is the meeting title, plus a 📅
marker.

---

## Several addresses per person — 2026-08-10

People have a work address, a personal one, one from school, one for a side
project, and a calendar invite arrives at whichever is relevant. Matching one
stored address missed every invite sent to any of the others — and a missed
match is indistinguishable from "no meetings found", so it would never have been
reported as a bug.

`contacts.emails` is jsonb, for the same reason conversations and follow-ups
are: no further migration as the shape grows. `contacts.email` is **not**
dropped — it stays as the primary, so everything reading a single string
(mailto, the capture form, search) keeps working, and `js/db.js` degrades to
single-address behaviour if the column is missing rather than failing every save
the way an unknown `starred` column once would have.

`supabase/add-contact-emails.sql` back-fills from the address already stored.

---

## A meeting is over when it ENDS — 2026-08-10

Two lists are built from the same calendar feed: what is ahead of you ("Coming
up") and what already happened (the conversations worth logging). They were
divided on the **date**, which is the wrong unit — a coffee at four in the
afternoon carries today's date from breakfast onwards. So all morning Orbit
asked how a conversation had gone that had not started yet, while the same
meeting sat on the dashboard under Coming up. One feed, two answers.

The boundary is now the clock:

| | Rule |
|---|---|
| Coming up | shown until the event's **end** time |
| Loggable | offered once the **end** time has passed |

Holding a meeting in Coming up until it ends rather than until it starts also
closes a gap where it belonged to neither list for the hour you were most likely
to be looking at it. In-progress rows read `now` instead of `today`.

`eventEndMs` handles the one thing that is easy to get wrong: Google's all-day
`end.date` is **exclusive**, so a one-day event on the 10th ends on the 11th —
that date at midnight is the moment it is over, not a day early.

**Which interruption, and when.** A meeting that ended within
`JUST_ENDED_HOURS` (24) opens the log dialog directly, headed *"How did it go
with —?"*, with the notes box already open. That is the minute you still
remember what was said, and a toast you can miss wastes it. Anything older gets
the dismissible toast it always had, because opening a modal over a month of
backlog is an ambush rather than a prompt. Nothing is dropped either way — the
dialog lists everything found, whichever entry triggered it.

`tests/calendar-timing.test.mjs` pins the partition directly: for a meeting
ahead, in progress, and finished, exactly one of the two lists claims it.

---

## ORB-37 — matching by name when there is no invite · 📋 backlog, not started

**The gap.** Every match today runs through `attendeesInNetwork`, which is
email-only, because an address is the one identifier both sides share. That
covers meetings created from an invite. It covers nothing else:

- an in-person coffee you put in your own calendar as *"Coffee — Assaf"*
- *"you don't need to send an invite, just come by"*
- a meeting someone booked from a personal address you have never seen
- a calendar entry with a location and a name and no attendees at all

These are exactly the touchpoints Orbit exists to catch, and they are currently
invisible to the sync — which reads as *"no meetings found"*, indistinguishable
from a sync that worked.

**Why it is not just a name lookup.** Email matching is safe because an address
is unique. A name is not, and the cost of a wrong match is not cosmetic: logging
a conversation rolls that person's cadence forward, so a false match makes a
relationship that is actually drifting look healthy. That is the specific
failure Orbit exists to prevent, so a name match can never be applied silently
the way an email match is.

**Shape it would take.**

1. **Extract candidate names** from `summary` and `location` — mostly first
   names, sometimes *"Coffee with Assaf K"*, sometimes *"Assaf / Davina"*.
2. **Score against the network**, not just equality: exact full name, full name
   with an initial, unique first name, first name shared by several contacts.
3. **Never auto-log.** A name match is always a question, never a candidate that
   arrives pre-ticked.
4. **Ask when the answer is genuinely ambiguous** — *"Coffee — Assaf. Is this
   Assaf Karmon, or Assaf Levine?"*, with **Neither** as a first-class answer,
   because most calendar entries mentioning a name have nothing to do with the
   network.
5. **Remember the answer per contact**, so *"Coffee — Assaf"* is asked once and
   afterwards matched directly. This is the part that makes it bearable; without
   it a recurring one-to-one asks the same question every fortnight.

**Depends on:**

- **A nickname/alias field on the contact** — this is where step 5's answers are
  stored, and it is the smallest piece that has to exist first. jsonb on
  `contacts`, same as `emails`, so no migration when the shape grows.
- **A confidence level on an interaction.** *"Matched by name, you confirmed"*
  is weaker evidence than *"they accepted the invite"*, and if health is ever
  going to be explainable (ORB-23) the record has to say which it was.
- **Deciding what a rejected match means.** *Neither* has to be sticky per
  event id, or the same entry is offered every sync forever.

**Deliberately deferred**, not forgotten: the email path had to be right first,
and `contacts.emails` (several addresses per person) removes a large share of
the misses on its own — a personal-address invite is now matched, and that was
a good part of what looked like it needed name matching.

---

## Housekeeping (not in Confluence)

- Orphan `internship_id` columns on `contacts` and `storage_files`, left from the
  dropped table. Drop statements are commented at the bottom of
  `supabase/drop-legacy-tables.sql`.
- The local folder is still `internship-tracker` while the repo is `orbit`. Cosmetic —
  renaming moves your editor and terminal paths.

---

## Shipped — M0

**Backend** — dead anon key replaced with the publishable key; `industry` column;
storage bucket policies; schema backed up to `supabase/schema.sql`; the "Allow all
(dev)" RLS policies replaced with owner-scoped ones (they had left every row readable
by anyone holding the public key); legacy `internships`, `logs`, `interactions` and
`follow_ups` tables dropped.

**App** — renamed to Orbit and scoped down from an internship tracker. Mission Control
with status tiles, a health ring and a breakdown bar. Relationship health with a
one-week grace window on new cadences. My Network (A–Z), Networking Log, Files with
document previews and in-app rename, connection profiles, two-pane Settings,
edit-profile modal, collapsible icon-rail sidebar, CSV export. Orbit favicon, tab
titles and link-preview cards.

**Fixes found by rendering rather than reading** — a status label that contradicted
the countdown beside it, a container with no CSS rule that stacked every card flush,
a 0% ring painting a stray dot, and a dead-CSS sweep that would have broken the
status colors.
