-- Orbit — columns the Settings panel needs
--
-- `preferences` only had user_id, manager_name, your_name and next_steps, but
-- the Settings panel writes your_email (and now phone). Saving silently failed.
--
-- Safe to re-run.

alter table public.preferences add column if not exists your_email text default '';
alter table public.preferences add column if not exists phone      text default '';

-- manager_name and next_steps are left over from the internship tracker and are
-- no longer written by anything. Uncomment to drop them:
--
-- alter table public.preferences drop column if exists manager_name;
-- alter table public.preferences drop column if exists next_steps;
