# Orbit — action plan

Everything outstanding from the rebuild, ordered by what would hurt most if ignored.
Last updated 2026-08-06.

---

## 🔴 Blockers — things that are broken or will break

### ~~1. Run the `industry` migration~~ ✅ done
Verified live 2026-08-06 — `contacts.industry` returns from the API.

### ~~2. Add storage policies~~ ✅ done
The `interntrack-files` bucket existed and was public, but had **0 policies** — public
only governs *reading* by URL, while uploading is an INSERT into `storage.objects` with
RLS on, so every upload was denied. Added via the dashboard: SELECT for authenticated,
plus INSERT/UPDATE/DELETE scoped to each user's own folder. Upload verified working
2026-08-06. `supabase/storage-policies.sql` records the equivalent SQL.

### ~~3. There is no way to set your own name~~ ✅ done
`buildReminderEmailText()` reads `preferences.your_name` to sign draft messages, but the
settings UI that wrote it was deleted with the Workspace, so every draft signed off
`[Your Name]`. Fixed: **Settings** in the sidebar footer opens a name + email panel.

### 4. The project pauses after ~7 days idle
This already cost a full debugging session. A paused project loses its DNS record
entirely and the app dies with no useful error. The red banner in `js/db.js` now explains
it, but the underlying fragility remains. Options: a scheduled ping, or accept it and
rely on the banner.

---

### ~~5. Replace the "Allow all (dev)" policies~~ ✅ done 2026-08-06
`contacts`, `internships` and `logs` each carry a policy defined as
`for all to public using (true) with check (true)`. That is no protection at all:
anyone holding the publishable key — which ships in `js/supabase.js` and is served
publicly from GitHub Pages — can read, modify or delete every row.

Demonstrated against a replica: before the fix a signed-in user could see another
user's contacts; after it, each user sees only their own and anon sees nothing.

Fixed by `supabase/fix-rls.sql`, which also scoped the storage policies to each user's
own folder (the dashboard-created ones only checked the bucket), made `contacts.user_id`
`not null` with a foreign key, and added the missing index on it.

**Verified after running:** with only the publishable key and no session, all five
tables return 0 rows and writes return HTTP 401. Before the fix, the same request
returned live contact data.

---

## 🟠 Worth doing soon

### ~~6. Back up the real schema~~ ✅ done
`supabase/schema.sql` — reconstructed from the live database, verified against
Postgres 15, idempotent across repeat runs.

### ~~7. Drop the vestigial tables~~ ✅ done
`internships`, `logs`, `interactions` and `follow_ups` removed by
`supabase/drop-legacy-tables.sql`. Conversations and follow-ups live in jsonb columns on
`contacts`. Two orphan `internship_id` columns remain on `contacts` and `storage_files`;
drop statements are commented at the bottom of that file.

### ~~8. Repo cleanup~~ ✅ mostly done
- ~~`app.js.bak`~~ deleted
- ~~Dead CSS~~ ~24KB removed
- ~~Repo renamed to `orbit`~~ — live at https://davina-li-01.github.io/orbit/
- The local folder is still `internship-tracker`. Cosmetic; renaming it moves your editor
  and terminal paths, so it is only worth doing if it bothers you.

---

## 🟢 Features discussed

### 9. Google Calendar auto-logging  ★ highest leverage
The whole app depends on remembering to log touchpoints manually — which is exactly the
habit that fails. Auto-logging from calendar events fixes the core weakness.

**Shape:** Google Cloud project → OAuth consent screen → `calendar.events.readonly` →
Google Identity Services with PKCE in the browser (no backend needed, which matters on
GitHub Pages) → poll recent events → match attendee emails against `contacts.email` →
create a conversation and roll the cadence forward.

**Costs to accept:** only works for contacts whose email you saved; Google requires app
verification before non-test users can grant the scope; needs a token-refresh story.

### 10. AI talking points
`generateFollowUpSuggestions()` is currently a keyword heuristic — it pattern-matches
action verbs in your notes. It works, but the output is literal. Replacing it with a real
model call would make "things to bring up next" genuinely useful. This was always the
plan; the manual MVP is in place.

### 11. Smaller ideas
- Company logos on profiles (needs an external logo API — deliberately skipped)
- A `starred` / "key people" tier (needs `alter table contacts add column starred boolean`)
- Trend over time: is my network getting healthier or worse?
- Export the network to CSV

---

## Agreed sequence

You picked all four tracks. Suggested order, since some depend on others:

1. ~~**Finish the blockers**~~ ✅ all done — mostly your dashboard, ~10 minutes. Everything
   else sits on top of a working database.
2. **Polish** — use it daily and fix what feels wrong — while using it day to day. Cheap, and it surfaces the
   real UX problems that speculation won't.
3. **AI talking points** (#10) — self-contained, no external auth, immediately visible
   payoff. Good first "real feature."
4. **Google Calendar** (#9) — last, because it is the biggest and needs Google Cloud
   setup, OAuth verification, and a token-refresh story. Also benefits from having more
   real contacts with emails saved, which #2 will produce.

**Navigation decided:** Networking Log is its own top-level tab, not nested under My
Network. Files stays nested under Networking Log.

---

## ✅ Done in this rebuild

- Renamed to Orbit; scoped down from an all-purpose internship tracker
- Dashboard: 4 KPI tiles, 2 ring meters, stacked-bar breakdown, "Reach out next"
- Relationship health model (`(1 − elapsed/cadence) × 100`, banded)
- My Network / Networking Log / Files / profile pages
- Collapsible icon-rail sidebar
- Fixed: dead anon key, KPI denominators, 0% ring artifact, unbalanced markup
- 56 automated tests covering health logic and chart rendering
