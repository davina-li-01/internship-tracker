# Orbit — action plan

Everything outstanding, ordered by what would hurt most if ignored.
Last updated 2026-08-07.

---

## ✅ Cleared

### ~~1. Finish the settings migration~~ done 2026-08-07


`your_email`, `phone` and `avatar_url` all verified present.

### ~~2. Push~~ done — `main` is in sync with GitHub.

---

---

## 🟠 Worth doing

### ~~3. Drop the legacy tables~~ ✅ done 2026-08-07
`internships`, `logs`, `interactions` and `follow_ups` dropped and verified gone.
`contacts`, `preferences` and `storage_files` untouched and healthy.

### 4. The project pauses after ~7 days idle
Already cost a full debugging session once. A paused project loses its DNS record and
the app dies with no useful error. The red banner in `js/db.js` explains it when it
happens, but the fragility remains. Options: a scheduled ping, or accept it and rely on
the banner.

### 5. Loose ends
- Orphan `internship_id` columns on `contacts` and `storage_files`, left over from the
  dropped table. Drop statements are commented at the bottom of `drop-legacy-tables.sql`.
- The local folder is still `internship-tracker` while the repo is `orbit`. Purely
  cosmetic — renaming it moves your editor and terminal paths.

---

## 🟢 Features

### 6. Scheduled email reminders  — deferred by choice
The in-app nudge only fires when you open Orbit, and "Open in email" hands the draft to
your mail client. Neither is a reminder that arrives on its own.

A real one needs something awake when you are not: a **Supabase Edge Function** on a cron
schedule that queries overdue contacts and sends through an email provider (Resend has a
free tier). Same class of infrastructure as #7, so they are worth doing together.

### 7. Google Calendar auto-logging  ★ highest leverage
Orbit only works if you remember to log touchpoints — exactly the habit that fails.
Auto-logging from calendar events fixes the core weakness.

**Shape:** Google Cloud project → OAuth consent screen → `calendar.events.readonly` →
Google Identity Services with PKCE in the browser → poll recent events → match attendee
emails against `contacts.email` → create a conversation and roll the cadence forward.

**Costs:** only works for contacts whose email you saved; Google requires app
verification before non-test users can grant the scope; needs a token-refresh story.

### 8. AI talking points
`generateFollowUpSuggestions()` is a keyword heuristic — it pattern-matches action verbs
in your notes. It works, but reads mechanically. A real model call would make "things to
bring up next" genuinely useful. Self-contained, no external auth: the best first feature.

### 9. Two-factor authentication
The Security tab explains the options but nothing is wired. **Authenticator app (TOTP)**
is free on Supabase and is the one worth building; SMS needs a paid provider and is
weaker (SIM-swap).

### 10. Smaller ideas
- A `starred` / "key people" tier (needs `alter table contacts add column starred boolean`)
- Trend over time: is my network getting healthier or worse?
- Company logos on profiles (needs an external logo API — deliberately skipped)

---

## Suggested order

1. **#1 and #2** — ten minutes, and everything else depends on them
2. **Use it for a week** — add real people, set real cadences. This surfaces the UX
   problems that speculation will not, and produces the contacts-with-emails that #7 needs
3. **#8 AI talking points** — self-contained, immediately visible
4. **#6 + #7 together** — both need server-side infrastructure, so build that once

---

## ✅ Done

**Backend** — dead anon key replaced with the publishable key; `industry` column; storage
bucket policies; schema backed up to `supabase/schema.sql`; the "Allow all (dev)" RLS
policies replaced with owner-scoped ones (they had left every row readable by anyone
holding the public key).

**App** — renamed to Orbit and scoped down from an internship tracker. Mission Control
with status tiles, a health ring and a breakdown bar. Relationship health with a
one-week grace window on new cadences. My Network (A–Z), Networking Log, Files with
document previews and in-app rename, connection profiles, two-pane Settings, edit-profile
modal, collapsible icon-rail sidebar, CSV export.

**Fixes found by rendering rather than reading** — a status label that contradicted the
countdown beside it, a container with no CSS rule that stacked every card flush, a 0%
ring painting a stray dot, and a dead-CSS sweep that would have broken the status colors.

**109 automated tests** across health logic, chart rendering, the grace window, and filters.
