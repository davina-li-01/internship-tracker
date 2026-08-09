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
| Aug 8 | ORB-16 | Scheduled email reminders | Integrations | Med | High | Not started |
| Aug 8 | ORB-15 | Google Calendar integration | Integrations | **High** | High | Not started |
| Aug 12 | ORB-17 | AI talking points | Core | Med | Low | Not started |
| Aug 12 | ORB-18 | Audio transcription | Core | **High** | Med | Not started |
| Aug 17 | ORB-24 | Idle-pause resilience | Integrations | Med | Med | Not started |
| Aug 19 | ORB-21 | Two-factor authentication | Integrations | Med | Med | Not started |
| Aug 19 | ORB-23 | Network health over time | Integrations | Med | Med | Not started |
| Sep 7 | ORB-22 | Key people tier | Core | Low | Low | Not started |
| Sep 7 | ORB-19 | Thank-you draft from conversation | Core | Low | Low | Not started |

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

**Done and committed:** ORB-13, ORB-14 and ORB-20, plus a pre-existing dark-mode
button fix. Every Aug 8 Core Functionality item is now closed.

**Not yet pushed.** Nothing is live on either deployment until you `git push`.

**Next up, per the Confluence dates.** What remains from Aug 8 is both Integrations
work, and it is a step up in kind, not just size:

- **ORB-15 · Google Calendar** and **ORB-16 · scheduled email** — both High effort
  and both need the same thing the app has never had: something running when the
  browser tab is closed. A Supabase Edge Function plus a cron schedule, and for
  ORB-16 an email provider. Build that foundation once and sequence them together.
  ORB-15 is also blocked on having real contacts with emails saved.

**Then Aug 12:** ORB-17 AI talking points (self-contained, no external auth — the
easier of the two) and ORB-18 audio transcription, which still needs a spec.

**Worth doing before more features:** actually use the new one-click flow for a few
days. ORB-13's open question was answered "they just want the row gone" — the build
takes that at its word and captures no notes. Real use is what tells you whether
that holds.

**Unscoped and will need a spec before it can start:** ORB-18 audio transcription
(Aug 12, High priority). The open engineering questions are listed under its
heading below.

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

### ORB-15 — Google Calendar auto-logging ★ highest leverage
Orbit only works if you remember to log touchpoints — exactly the habit that fails.
Auto-logging fixes the core weakness.

**Shape:** Google Cloud project → OAuth consent screen → `calendar.events.readonly` →
Google Identity Services with PKCE in the browser → poll recent events → match
attendee emails against `contacts.email` → create a conversation and roll the
cadence forward.

**Costs:** only works for contacts whose email you saved; Google requires app
verification before non-test users can grant the scope; needs a token-refresh story.
**Blocked on** having real contacts with emails saved.

### ORB-16 — Scheduled email reminders
The in-app nudge only fires when you open Orbit, and "Open in email" hands the draft
to your mail client. Neither is a reminder that arrives on its own.

A real one needs something awake when you are not: a **Supabase Edge Function** on a
cron schedule querying overdue contacts, plus an email provider (Resend has a free
tier). Same class of infrastructure as ORB-15 — **sequence them together**.

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
