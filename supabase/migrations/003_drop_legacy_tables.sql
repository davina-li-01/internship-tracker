-- Orbit — drop the tables left over from the internship tracker
--
-- IRREVERSIBLE. Anything in these tables is gone for good.
--
-- None of them are read or written by the app:
--   internships   — the Workspace feature was removed
--   logs          — daily logs went with it
--   interactions  — conversations live in contacts.interactions (jsonb)
--   follow_ups    — talking points live in contacts.follow_ups (jsonb)
--
-- Run the count query at the bottom FIRST if you want to see what you are
-- about to lose. `internships` held one row the last time it was checked.
--
-- No foreign keys point at these tables, so no CASCADE is needed. Dropping a
-- table also drops its policies and indexes.

begin;

drop table if exists public.logs;
drop table if exists public.internships;
drop table if exists public.interactions;
drop table if exists public.follow_ups;

commit;

-- ─── Leftover columns ─────────────────────────────────────────────────────────
-- `contacts.internship_id` and `storage_files.internship_id` pointed at the
-- table you just dropped. Nothing writes them any more. Uncomment to remove:
--
-- alter table public.contacts      drop column if exists internship_id;
-- alter table public.storage_files drop column if exists internship_id;

-- ─── Preflight (run this on its own BEFORE the drops if you want) ─────────────
-- select 'internships' as t, count(*) from public.internships
-- union all select 'logs',         count(*) from public.logs
-- union all select 'interactions', count(*) from public.interactions
-- union all select 'follow_ups',   count(*) from public.follow_ups;
