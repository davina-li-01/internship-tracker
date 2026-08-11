-- Orbit — drop the last two InternTrack columns (ORB-49)
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- WHAT THIS REMOVES
--
-- `contacts.internship_id` and `storage_files.internship_id` were foreign keys
-- into `public.internships`, which 003_drop_legacy_tables.sql deleted on
-- 2026-08-06. The columns outlived the table they pointed at: they hold values
-- that reference nothing, and no code has read or written them since Orbit
-- stopped being an internship tracker.
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

-- ─── Preflight ────────────────────────────────────────────────────────────────
-- Run this block on its own FIRST. It changes nothing and tells you exactly
-- what is about to disappear, including whether any row still carries a value.
--
--   select 'contacts.internship_id' as column_name,
--          count(*)                  as rows_total,
--          count(internship_id)      as rows_with_a_value
--     from public.contacts
--   union all
--   select 'storage_files.internship_id',
--          count(*),
--          count(internship_id)
--     from public.storage_files;
--
-- `rows_with_a_value` above zero is expected and is not a reason to stop — the
-- values point at a table that no longer exists. It is only there so the number
-- is a decision you made rather than one you discovered afterwards.
--
-- If either column is already gone the query errors with "column does not
-- exist". That is the all-clear, not a problem: the drops below are guarded.

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
