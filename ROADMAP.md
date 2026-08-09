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
| Aug 12 | ORB-17 | AI talking points | Core | Med | Low | Not started |
| Aug 12 | ORB-18 | Audio transcription | Core | **High** | Med | Not started |
| Aug 17 | ORB-24 | Idle-pause resilience | Integrations | Med | Med | Not started |
| Aug 19 | ORB-21 | Two-factor authentication | Integrations | Med | Med | Not started |
| Aug 19 | ORB-23 | Network health over time | Integrations | Med | Med | Not started |
| Sep 7 | ORB-22 | Key people tier | Core | Low | Low | Not started |
| Sep 7 | ORB-19 | Thank-you draft from conversation | Core | Low | Low | Not started |
| — | ORB-26 | Edit a conversation's notes | Core | **High** | Low | ✅ Done |
| — | ORB-27 | Photos as attachments | Core | **Could have** | Low | ⚠️ Shipped ahead of priority |
| — | ORB-28 | "Coming up" on the dashboard | Core | Med | Med | ✅ Done |

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

### ORB-24 — Idle-pause resilience
Free-tier Supabase pauses after ~7 days idle and the project loses its DNS record, so
the app dies with no useful error. Already cost a full debugging session once. The red
banner in `js/db.js` explains it when it happens; the fragility remains. Options: a
scheduled ping, or accept it and rely on the banner.

### ORB-25 — Company logos · won't have
Needs an external logo API on every render — a runtime dependency for decoration.
Deliberately skipped.

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
