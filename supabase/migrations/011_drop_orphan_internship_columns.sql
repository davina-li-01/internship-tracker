-- Orbit — drop the last two InternTrack columns (ORB-49)
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- WHAT THIS REMOVES
--
-- `storage_files.internship_id` was a foreign key into `public.internships`,
-- which 003_drop_legacy_tables.sql deleted on 2026-08-06. The column outlived
-- the table it pointed at, and no code has read or written it since Orbit
-- stopped being an internship tracker. See the dated note below for what was
-- actually still present when this was run.
--
-- Verified before writing this: neither name appears anywhere under js/.
--
-- The drops were left commented out in 003 at the time, deliberately — dropping
-- a column is irreversible and the data was still fresh. It is not fresh now.
--
-- NOT IN HERE, because it already happened:
--   preferences.manager_name and preferences.next_steps were dropped by
--   004_settings_columns.sql, which ran on 2026-08-10. The ORB-49 ticket lists
--   them as surviving; they do not.

-- ─── Already satisfied on the live database, 2026-08-11 ───────────────────────
-- Checked before running: neither column exists. This file was a no-op against
-- the project as it stands, and is kept because it is not a no-op against a
-- project rebuilt from 001 — `001_schema.sql` still declares
-- `storage_files.internship_id`, so a fresh restore creates it and this removes
-- it again. Same shape as 001-creates/004-drops, noted in the README.
--
-- `contacts.internship_id` is not declared in 001 at all. The commented drop in
-- 003 assumed it and this file inherited the assumption instead of checking the
-- database. The guarded drop stays below — it costs nothing, and the column did
-- exist in some earlier state — but the header above overstated what survived.

-- ─── Preflight ────────────────────────────────────────────────────────────────
-- Run this FIRST. It changes nothing, and unlike `count(internship_id)` it
-- cannot error on a column that is already gone. That matters: the first version
-- of this preflight was one `union all` across both tables, so a column that was
-- already dropped took down the check for the one that was not. A safety query
-- that fails when things are safe is worse than no safety query.
--
--   select table_name, column_name
--     from information_schema.columns
--    where table_schema = 'public'
--      and column_name  = 'internship_id'
--    order by table_name;
--
-- Zero rows means there is nothing to do — stop, do not run the drops. For any
-- table it does list, this shows whether rows still carry a value:
--
--   select count(*) as rows_total, count(internship_id) as rows_with_a_value
--     from public.<that table>;
--
-- `rows_with_a_value` above zero is expected and is not a reason to stop — the
-- values point at a table that no longer exists. It is only there so the number
-- is a decision you made rather than one you discovered afterwards.

-- ─── The drops ────────────────────────────────────────────────────────────────

alter table public.contacts      drop column if exists internship_id;
alter table public.storage_files drop column if exists internship_id;

-- ─── Confirmation ─────────────────────────────────────────────────────────────
-- Returns one row per column still present. Zero rows means the drop worked.

select table_name, column_name
  from information_schema.columns
 where table_schema = 'public'
   and column_name  = 'internship_id'
 order by table_name;
