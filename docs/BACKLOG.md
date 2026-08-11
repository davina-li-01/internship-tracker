# Orbit — what to paste into Confluence

Reconciled against the three exported pages on 2026-08-10: **Customer Experience
EPIC**, **Backlog**, and **Roadmap Q3 2026**.

Confluence is the source of truth. Everything below is either a **new row**, a
**status change**, or a **correction to a note that no longer describes what
shipped**.

Keys start at **ORB-43** because the Backlog page already runs to ORB-42.

---

## 1. New rows for the **Backlog** page

Five. Everything else I built maps onto a ticket you already have — see §3.

The fifth column is **Dependencies**, not Notes: what this item needed to exist
first, so the shape of the project is readable from the table alone. What each one
actually does, and why, lives in `ROADMAP.md` — that split is deliberate, so the
backlog stays a plan rather than a changelog.

| Requirement | User Story | Importance | Jira Issue | Dependencies |
|---|---|---|---|---|
| Reminder digest in the reader's timezone | As a user, I want the reminder email to arrive in my morning, so it lands when I can actually act on it rather than overnight | Should have | ORB-43 | **ORB-16** for the Edge Function, pg_cron and email provider. New column `preferences.timezone`. Requires the cron schedule to move from daily to hourly — the function, not the scheduler, decides whose hour it is. Soft dependency on **ORB-37**: better timing does not help mail that lands in spam |
| Calendar connection follows the account | As a user, I want my calendar connection to work on any device I sign in on, so I do not reconnect every time I switch browsers | Should have | ORB-44 | **ORB-15** for the connection itself. **ORB-34** constrains the design: its nav rule is read from localStorage before first paint, so localStorage has to remain the synchronous copy and the database can only be the durable one. **ORB-36** surfaces the connected account this stores. New column `preferences.integrations` |
| Ask about a conversation only once it has ended | As a user, I want to be asked how a meeting went after it happens, not while it is still ahead of me | Must have | ORB-45 | **ORB-15** for the calendar feed. Shares that feed with the "Coming up" dashboard widget, so the two must partition the same events — a meeting belongs to exactly one of "upcoming" and "loggable", never both. No schema change |
| "Coming up" holds its height | As a user, I want a busy week of meetings to scroll inside its card rather than stretching the whole dashboard row | Should have | ORB-46 | **ORB-15** for the meetings, **ORB-35** for the card it lives in. Constrained by the dashboard chart row, which sizes every card to the tallest — so this is a layout dependency, not a data one. No schema change |
| Match calendar events by name | As a user, I want an in-person coffee logged even when there was no calendar invite to match on | Should have | ORB-47 | **Not built.** Needs **ORB-15**. Blocked on three things that do not exist yet: an alias field per contact to remember disambiguation answers, a confidence level on an interaction to distinguish a confirmed name match from an accepted invite, and sticky per-event rejections. **ORB-23** will need the confidence field too, so build it once. **ORB-39** reduced the need by matching every stored address |

## 2. New rows for the **Detailed Quarterly Roadmap**

| Feature | Jira Issue | Team | Dates | Priority | Effort | Status |
|---|---|---|---|---|---|---|
| Reminder digest in the reader's timezone | ORB-43 | Integrations | Aug 10, 2026 | MEDIUM | LOW | DONE |
| Calendar connection follows the account | ORB-44 | Integrations | Aug 10, 2026 | MEDIUM | MEDIUM | DONE |
| Ask about a conversation only once it has ended | ORB-45 | Integrations | Aug 10, 2026 | HIGH | LOW | DONE |
| "Coming up" holds its height | ORB-46 | Core Functionality | Aug 10, 2026 | MEDIUM | LOW | DONE |
| Match calendar events by name | ORB-47 | Integrations | — | MEDIUM | HIGH | NOT STARTED |

**One status change:** ORB-24 Idle Pause Resilience is **DONE**, not NOT STARTED.

---

## 3. Corrections — tickets marked DONE that do not describe what shipped

This is the part worth your time. Six existing rows now disagree with the code, and
four of them would send whoever reads them next looking for something that is not
there.

Written against the old **Notes** column, since that is what those rows still have.
If you want, I can convert all forty-two existing rows to **Dependencies** in one
pass and move the descriptive text into `ROADMAP.md` — say the word and I will.

### ORB-39 · Multiple email addresses per contact — note is wrong
Says *"New `contact_emails` table … unique on (contact_id, address) … migrate the
existing single email column into the new table, then retire the column."*

**What shipped:** `contacts.emails` **jsonb**, and `contacts.email` was **kept** as
the primary rather than retired. jsonb for the same reason conversations and
follow-ups are — the shape grows without another migration. The column stayed
because everything reading a single address (mailto, search, the capture form)
keeps working, and because `js/db.js` can then degrade to one address when the
column is missing instead of failing every save.

> Suggested note: `contacts.emails` jsonb: `[{id, label, address}]`, label one of
> personal/work/school/other. `contacts.email` is retained as the primary and kept
> in sync with the first entry. Migration `add-contact-emails.sql` back-fills from
> the existing column. Calendar matching in ORB-15 checks every stored address.

### ORB-40 · Role and company history — marked DONE, only half shipped
Says a `contact_roles` table with `title`, `start_date`, `end_date`, `is_current`.

**What shipped:** `contacts.company_history`, a jsonb array of **company name
strings**. No titles, no dates, no `is_current`. The profile shows past companies as
chips. So "where someone worked before" is there; "what they did and when" is not.

> Either reopen it, or split the dates-and-titles part into a new ticket.

### ORB-27 · Revisit email reminder logic — note describes a different mechanism
Says *"Only notify a user when they have 14 days left until they should reach out"*
— a **lead time** before the deadline.

**What shipped:** a **fortnightly digest of people already overdue**, which is what
you chose on Aug 10 when you asked what cadence I would recommend. Different
mechanism, same number of days, and the note reads as the other one.

> Suggested note: One digest every 14 days containing whoever is overdue at that
> moment, most overdue first, capped at 8 names. The fixed period *is* the
> grouping, so there is no batching heuristic. Someone still overdue after three
> consecutive digests stops being listed and becomes one line pointing at their
> cadence. A quiet fortnight does not stamp the period, so the clock only starts
> when an email actually goes.

### ORB-38 · Schema audit and alignment — marked DONE, partially shipped
`supabase/catch-up.sql` reconciles the columns the app actually writes and reports
every one as present or missing. **Not done:** unused columns were not dropped
(`manager_name`, `next_steps`, the orphan `internship_id` columns), and migrations
are still hand-named files rather than the numbered, reproducible sequence the note
asks for.

### ORB-37 · Custom email domain — "hard blocker" is not true in practice
Says *"Hard blocker for ORB-16 and ORB-27. Neither can be tested or validated while
delivery is unreliable."*

Both shipped and a real digest was delivered end to end from
`onboarding@resend.dev`. It is a **deliverability risk** — mail lands in spam more
often and the display name cannot be changed — not a blocker. Worth keeping as
MEDIUM/HIGH for Aug 11, with the dependency line corrected so nobody blocks work on
it that does not need to be blocked.

### ORB-16 · Scheduled email reminders — dependency note is wrong
Says *"Same infrastructure as ORB-15 — sequence together."*

They share nothing. ORB-16 is server-side: Supabase Edge Function, pg_cron, pg_net,
Vault, Resend. ORB-15 is **entirely browser-side** — Google Identity Services with
the token held in a variable for the life of the tab, and nothing stored. Reasonable
to assume up front, wrong once built.

### ORB-15 · Google Calendar — stale blocker
*"Blocked on having real contacts with emails saved"* is no longer true.

### ORB-42 · Profile page UI rebuild — worth recording what shipped
View-first with an **Edit** button rather than a permanently editable form; the same
grid in both modes so nothing moves when switching. Repeatable fields commit when
you leave them rather than on a save button. Two rows: role/company/industry, then
addresses and past companies.

---

## 4. The EPIC page itself

- **The Milestones section is empty** — heading, then straight to Requirements.
- The Requirements table holds only *Shipped — M0* (ORB-1…12), which is correct, but
  means the EPIC alone never shows the backlog. That is what misled me into
  numbering from ORB-29: `docs/PRD.md` in this repo merges the EPIC with an old copy
  of the Backlog and stops at ORB-24.
- Open questions are all answered and dated. Nothing to do.
- All three reference links resolve (checked: GitHub Pages, Vercel mirror, repo).

---

## 5. Repo hygiene

`docs/PRD.md` is **not** a faithful export — it has a Milestones table and a Design
section Confluence does not, and a Backlog table with keys that stopped at ORB-24.
It is now marked as a partial local copy. `ROADMAP.md`'s Q3 table has been rewritten
to mirror the Detailed Quarterly Roadmap exactly, including the dates I had wrong
(ORB-17 and ORB-18 are **Aug 18**, not Aug 12).
