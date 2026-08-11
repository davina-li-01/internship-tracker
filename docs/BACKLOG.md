# Orbit — Confluence reconciliation log

Confluence is the source of truth. This file is the staging copy and the record of
what was reconciled, so when the two disagree the **live page wins**.

Since 2026-08-10 the pages are written directly through the Atlassian MCP server
rather than pasted by hand, so this file no longer needs to be a transcript of
what to copy.

Pages: **Customer Experience EPIC**, **Backlog**, **Roadmap Q3 2026** — all in the
`PM` space.

---

## The Dependencies column

The fifth column is **Dependencies**, not Notes. It leads with what had to exist
first — other ORB tickets, new columns or tables, constraints another ticket
imposes on the design — and then carries a short account of what shipped and why.

That second half is deliberate (ruled 2026-08-11). A stricter version was written,
which cut every cell to bare prerequisites and moved the design detail into
`ROADMAP.md`; it was rejected because the Backlog has to stay readable to someone
with no access to this repo.

---

## ORB-37 — custom SMTP, shipped Aug 11

Auth email now leaves through Resend on an owned domain. `orbit-networking.com`,
bought at Namecheap for $11.28/yr, verified in Resend, and wired into
**Supabase → Authentication → SMTP Settings** as `smtp.resend.com:465`, username
`resend`, sender `noreply@orbit-networking.com`, sender name `Orbit`.

Three problems closed at once, which is why this was worth doing before anything
cosmetic: the sender is no longer `noreply@mail.app.supabase.io`, the *powered by
Supabase* footer is gone with the built-in service, and the built-in rate limit —
which drops overflow **silently**, so a signup looks identical to the localhost
bug from the user's side — no longer applies.

**Four DNS records at Namecheap**, verified live against the authoritative
nameserver rather than trusted from the UI:

| Type | Host | Purpose |
|---|---|---|
| TXT | `resend._domainkey` | DKIM — proves ownership; without it nothing verifies |
| MX | `send` | SES return path, priority 10 |
| TXT | `send` | SPF |
| TXT | `_dmarc` | `p=none`, optional but helps placement |

**Two things cost time and are worth writing down.** Namecheap hides MX behind
**MAIL SETTINGS → Custom MX** — it is not in the Type dropdown under HOST
RECORDS, so it reads as missing. And each row needs its own teal **✓** committed
before **SAVE ALL CHANGES** picks it up; the DKIM row was silently discarded the
first time, which surfaced as a domain stuck on Pending with no error anywhere.

A separate 535 `Authentication credentials invalid` in the Auth logs was the API
key, not the domain — different failure, different fix. Worth reading the log
line rather than guessing: 535 means the key, 550 means the domain.

**Not done:** `davina@orbit-networking.com` receives nothing. Sending and
receiving are separate, and no mailbox exists. Cloudflare Email Routing or a
mailbox provider covers it when wanted, and will not collide, because Resend's MX
sits on `send.` while inbound uses the root.

---

## ORB-52 — the four decisions, made Aug 11

| Question | Decision |
|---|---|
| How many tiers | **Four**, as researched: inner circle ~monthly, mentors and managers ~quarterly, professional network ~twice yearly, met once ~annually |
| Existing contacts | **Derive the tier from the interval already chosen.** Those were deliberate and carry intent a blanket default would throw away |
| "No schedule" | **Survives as a deliberate opt-out**, but is no longer where a new contact lands by default |
| ORB-22 | **Absorbed.** Inner circle is the star; a separate `starred` boolean would be a second answer to one question |

**The model.** `follow_up_frequency` stays and remains the effective interval, so
every existing health calculation keeps working untouched. Choosing a tier sets
the interval to that tier's default; changing the interval afterwards is the
override. Tier is what you pick, interval is what runs. That keeps the blast
radius to the picker rather than the whole health engine.

`012_relationship_tiers.sql` adds the column and back-fills it. Custom intervals
map to the nearest tier by day count, and a malformed suffix falls through to
professional network rather than erroring.

## ORB-57 — success metrics restated

Done on the EPIC. Two metrics replaced, two added.

- ~~"50%+ of the network has a cadence set"~~ → **30%+ sit in a tier the user
  changed from the default.** The old one is trivially 100% once everyone gets a
  default tier. The 30% is provisional and needs a baseline.
- ~~"Overdue count trends down"~~ → **"Inner-circle contacts past their cadence
  trends down while network size grows."** Still the headline; now scoped to
  where a missed cadence is genuinely a failure.
- **New:** 2+ reconnections a month with contacts untouched six months or more.
- **New:** over half of reach-outs carry a trigger rather than only a timer —
  the direct test of the central bet.

The "declared cadence proxies intent" assumption was rewritten to hold at the
centre of the network and weaken with distance, and a new assumption records
that memory may not be the binding constraint — held loosely, since the
underlying finding has a live replication dispute.

**Downstream catch:** the EPIC's Reference Links still pointed at
`supabase/schema.sql`, `fix-rls.sql` and `storage-policies.sql`, all moved or
removed by ORB-49 an hour earlier. Now point at `supabase/migrations/`,
`002_rls_policies.sql` and `supabase/scripts/`, plus a link to the research page.

---

## ORB-49 — numbered migrations and dead column cleanup

`supabase/` was thirteen hand-named SQL files in one flat folder, with the apply
order recorded nowhere. Now:

- **`supabase/migrations/001…011`** — the real sequence, every file idempotent,
  with a README explaining the two places where the order looks wrong and is not
  (001 creates columns 004 drops; 006 schedules daily and 009 re-schedules
  hourly). All moved with `git mv`, so history follows each file.
- **`supabase/scripts/`** — `check-rls.sql` and `catch-up.sql`, which diagnose
  rather than migrate and were never migrations.
- **`storage-policies.sql` deleted** — verified a strict subset of
  `002_rls_policies.sql`, which creates the same four policies and also clears
  the older `rs3hur_*` ones.

**The ticket was wrong about what survives, and so was this row.** The ticket
lists `manager_name`, `next_steps` and the orphan `internship_id` columns. The
first two were dropped by `004_settings_columns.sql` on Aug 10. This row then
claimed the two `internship_id` columns survived — but that was read off the
commented drops in `003_drop_legacy_tables.sql`, not off the database. Queried
on Aug 11: **neither exists.** `contacts.internship_id` is not declared in `001`
at all, so it may never have existed here.

`011` therefore did nothing when run, and is kept anyway: `001` still declares
`storage_files.internship_id`, so a project rebuilt from the migrations creates
the column and `011` is what removes it again. The lesson is the cheap one —
schema claims get verified against `information_schema`, not inferred from what
an earlier migration commented out.

Its preflight was also rewritten. The original was a single `union all` across
both tables, so an already-dropped column raised `42703` and took down the check
for the other one — a safety query that fails precisely when things are safe.
It now reads `information_schema`, which cannot error on an absent column.

**Six runtime error strings named these paths to the user** — "Run
supabase/add-settings-columns.sql to enable it" and similar, in `js/db.js` and
`js/main.js`. A rename without them would have pointed people at files that no
longer exist. Updated, along with README, PRD, LEARNINGS and REMINDERS-SETUP.

**`ROADMAP.md` deliberately not updated.** Its references are dated log entries —
"Migration: `supabase/add-integrations.sql`, run 2026-08-10" — and rewriting them
would falsify the record of what was actually run under what name. Same principle
as leaving the Backlog rows alone.

---

## Aug 11 — cadence research, and eight new tickets

`User Research: Cadence Structure` is now a Confluence page under the EPIC,
alongside Backlog and Roadmap. It argues that the flat per-contact interval is
the documented failure mode of the personal-CRM category, and proposes tiers
with researched defaults, triggers ranked above timers, and a rewrite of the
word *overdue*. It carries its own sourcing caveats — read those first.

**Nothing already in the Backlog was edited.** Existing rows stand as the record
of what was decided when. Everything forward-looking is a new ticket, so the
page reads decisions → research → what changes next.

| Ticket | | |
|---|---|---|
| ORB-51 | Cadence strategy: tiers and triggers | Aug 11 · **In Progress** |
| ORB-52 | Relationship tiers replace the interval picker | TBD |
| ORB-53 | Trigger-first ordering for the reach-out list | TBD |
| ORB-54 | Reframe "overdue" outside the inner circle | TBD |
| ORB-55 | Digest orders by trigger and shows the reason | TBD |
| ORB-56 | Tier as a filter axis | TBD |
| ORB-57 | Restate the success metrics tiers invalidate | TBD |
| ORB-58 | Finish the mark-as-reached-out rework | TBD |

**Two things worth carrying forward:**

The shipped picker stops at **quarterly**. The two outer tiers the research says
matter most — twice-yearly and annual — cannot be expressed today except through
the custom-days field. The options that matter are the ones the UI makes hardest.

**ORB-22 and ORB-52 answer the same question twice.** A `starred` boolean and a
four-tier system are two ways to say "this one matters." ORB-22 is scheduled for
today; ORB-52 supersedes its approach. Open decision on the research page.

### ORB-58 — what ORB-13 actually left behind

ORB-13's row still describes a two-click modal. The code moved past that:
`markReachedOut()` gives one past-tense click with an 8-second undo on the
dashboard list, My Network and the contact profile, and the old dialog is already
demoted to a secondary **Draft** button. The EPIC's Open Questions answered *row
gone*, and the build followed it.

Two gaps survive, and they are ORB-58, not ORB-13:

- the **app-open nudge** still opens the old "Draft a message" modal — the one
  surface that interrupts you never got the rework
- the button only renders when `health.scheduled` is true, so **a contact given a
  cadence later never appears in Reach out next**

### Roadmap: Team colours

The Team cells set a `background-color` on the *text run*. Confluence's HTML
converter copies that colour into `textColor` as well, so the label was rendering
in the same light purple as its own highlight — the "light grey, can't read it"
symptom. Setting `color` explicitly does not survive the conversion.

Fixed by moving the highlight to the **cell** (`data-background` on the `td`) and
leaving the text unstyled, so it renders in the default dark. Core Functionality
`#dfd8fd`, Integrations `#c6edfb`.

---

## Aug 11 plan, set on Aug 10 evening

Three moved up, one scheduled, one deferred, one shipped.

| Ticket | Change | Why |
|---|---|---|
| ORB-13 | Aug 8 → **Aug 11**, DONE → **In Progress** | The decision was deferred *pending real usage*. Orbit is now in daily use, so that condition is met. Booked as thinking time, not build time |
| ORB-22 | Sep 7 → **Aug 11** | One `starred` column. Mission Control's fractions count everyone with a cadence, so "in touch" cannot distinguish who matters — this is the input those rings were missing |
| ORB-49 | TBD → **Aug 11** | Cleanup only gets more expensive, and the InternTrack leftovers have already cost time twice. Do it before ORB-48, which reshapes a column this pass would otherwise revisit |
| ORB-33 | unscheduled → **Aug 15** | **Not hypothetical.** People have tried to sign up and reported problems. Bare minimum first: unblock account creation, then the empty-state work |
| ORB-23 | Aug 19 → **Q4** | Needs historical snapshots that do not exist, so the chart would render near-empty. Wants the same confidence field ORB-47 needs — build them together |
| ORB-50 | new, **DONE Aug 10** | 2FA hidden from Settings until ORB-21 ships |
| ORB-37 | stays **Aug 11** | Deferred from today by choice: spam placement only matters once someone other than the author receives the mail |

**The filter behind most of these:** with one primary user, work that needs real
usage data to decide (ORB-13) gets *better* now, and work that serves people who
have not arrived yet can wait. ORB-33 is the exception that corrected the rule —
people *are* arriving, and some of them cannot get in.

### ORB-50 — what shipped

`js/main.js`, two blocks commented out rather than deleted, so ORB-21 restores
them by uncommenting:

- the **"Secure your account"** callout in the Settings General pane
- the **Two-factor authentication** block in the Security pane

The `#goSecurity` click handler had to go with them. Left in place it would call
`.addEventListener` on a null button and take the entire settings modal down —
a worse bug than the one being fixed. Change password is untouched.

The test harness under `tests/.harness/` is generated and gitignored, so it needed
no parallel edit. 585 tests still pass.

---

## Written on 2026-08-11

### Corrections — rows that no longer described what shipped

Three had already been fixed by hand before this pass: **ORB-27**'s cell (now the
fortnightly digest), **ORB-37** ("deliverability risk, not a blocker") and
**ORB-16** ("shares no infrastructure with ORB-15").

Three were still wrong and are now corrected:

| Ticket | Was | Now |
|---|---|---|
| ORB-15 | "Blocked on having real contacts with emails saved" | Shipped Aug 8; follow-ons are ORB-44, ORB-45, ORB-47 |
| ORB-39 | A `contact_emails` table with `is_primary`, and the old column retired | `contacts.emails` jsonb; `contacts.email` **retained** as primary |
| ORB-40 | A `contact_roles` table with title, dates and `is_current` | `contacts.company_history` jsonb, company name strings only |

ORB-39 and ORB-40 were not stale prose — they were **design specs for tables that
were never built**. Anyone reading them would have gone looking for schema that
does not exist. ORB-38's cell also now records that only its audit half shipped.

**One title:** ORB-27 was *"Revisit Email Reminder Logic: Only notify a user when
they have 14 days left until they should reach out by email"* — the lead-time
mechanism that was considered and not built. Shortened to **"Revisit email
reminder logic"**.

### Two new tickets — remainders split out of part-done work

ORB-38 and ORB-40 stay **DONE**, because what shipped for each is real and in use.
What was specced but not built is split out rather than reopened, so the roadmap
dates keep their meaning.

| Requirement | User Story | Importance | Jira Issue | Dependencies |
|---|---|---|---|---|
| Role titles and dates on contact history | As a user, I can record what someone did at each company and when, so I remember whether they were a mentor, a peer or an interviewer | Should have | ORB-48 | Remainder of ORB-40, which shipped company names only. Titles, start and end dates and a current flag are more structure than a string array holds — so this is the point where `contacts.company_history` either grows to objects or becomes a table. **Breaking change to watch:** ORB-2 autocomplete disambiguates by role and company, so it must read current role from the new shape if the old columns retire. ORB-28 person summaries get sharper once dates exist |
| Numbered migrations and dead column cleanup | As a developer, I want database state reproducible from the repo, so a fresh project matches the running one and setup drift stops looking like bugs | Should have | ORB-49 | Remainder of ORB-38, which shipped the audit — `catch-up.sql` reports every expected column as present or missing — but not the reproducibility half. Migrations are still hand-named files applied in no defined order, and the dead columns survive: `manager_name`, `next_steps`, and the orphan `internship_id` columns left over from InternTrack. Dropping columns is irreversible, so it needs the audit trusted first — an ORB-38 dependency, not a parallel track |

Roadmap rows for both: Core Functionality, date TBD, MEDIUM priority, Not Started.
Effort MEDIUM for ORB-48, LOW for ORB-49.

---

## Written earlier — ORB-43…47

Added to both pages on 2026-08-10. The live text is the narrative version, which
is the one that stands; an alternative stricter draft that once lived in this file
has been dropped to stop the two versions competing.

| Jira Issue | Requirement | Status |
|---|---|---|
| ORB-43 | Reminder digest in the reader's timezone | DONE |
| ORB-44 | Calendar connection follows the account | DONE |
| ORB-45 | Ask about a conversation only once it has ended | DONE |
| ORB-46 | "Coming up" holds its height | DONE |
| ORB-47 | Match calendar events by name | NOT STARTED — specced only |

ORB-24 Idle Pause Resilience was also flipped to **DONE**.

---

## Still open

**ORB-27's user story** still reads *"notified while I still have time to reach out
to my connection"* — a lead time. What shipped is a digest of people already
overdue. The cell and the title now describe the digest, but the story describes
the other mechanism. That is a scope question rather than a typo: either the story
is rewritten to match the digest, or a separate ticket covers a genuine
before-the-deadline nudge. Left alone pending a decision.

**ORB-42's cell** is still the pre-build sequencing plan ("Sequence last. The field
set changes underneath in ORB-38 to 41"). It reads as a dependency that has since
been satisfied, so it is accurate rather than wrong. Harmless; not touched.

**The EPIC page** has an empty Milestones section, and its Requirements table holds
only *Shipped — M0* (ORB-1…12). That is correct as far as it goes, but it means the
EPIC alone never shows the backlog. Open questions on it are all answered and
dated, and all three reference links resolve.

**`docs/PRD.md`** is not a faithful export — it has a Milestones table and a Design
section Confluence does not, and a Backlog table whose keys stop at ORB-24. It is
marked as a partial local copy. Reading keys off it once caused a collision with
real tickets, so check the live Backlog page before inventing an ORB number.
