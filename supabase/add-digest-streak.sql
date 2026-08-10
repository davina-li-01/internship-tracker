-- Orbit — fortnightly digest, with chronic cases demoted (ORB-27)
--
-- Run after add-reminder-columns.sql. Safe to re-run.
--
-- WHAT CHANGED AND WHY
--
-- The first version emailed whenever someone crossed their deadline, then
-- fought the consequences with a per-contact cool-off and a per-user throttle.
-- Event-driven delivery arrives unpredictably, so it can never become a habit —
-- it can only interrupt, and interruption is what gets email muted.
--
-- It is a fixed fortnight now: one email per period by construction, containing
-- whoever is drifting at that moment. The schedule IS the grouping.

-- How many consecutive digests a person has appeared in.
--
-- Repeating a name you have ignored three times is nagging, and by then the
-- problem has changed: it is not that you forgot, it is that you said monthly
-- and meant quarterly. Past the threshold they collapse into one line pointing
-- at the cadence, which is a settings fix rather than a guilt trip.
alter table public.contacts
  add column if not exists nudge_streak integer not null default 0;

-- 'fortnightly' is the value the app writes now. The old ones are kept valid on
-- purpose: a migration that silently stops someone's email is worse than one
-- that changes its rhythm, so the Edge Function honours them as opted-in.
alter table public.preferences
  drop constraint if exists preferences_email_reminders_check;

alter table public.preferences
  add constraint preferences_email_reminders_check
  check (email_reminders in ('off', 'fortnightly', 'daily', 'weekly'));

-- Move existing subscribers onto the new rhythm.
update public.preferences
set email_reminders = 'fortnightly'
where email_reminders in ('daily', 'weekly');

-- ── Verify ───────────────────────────────────────────────────────────────────
select 'nudge_streak' as check_name, count(*)::text as detail
from information_schema.columns
where table_name = 'contacts' and column_name = 'nudge_streak'
union all
select 'subscribers on the new rhythm',
       coalesce(string_agg(distinct email_reminders, ', '), '(none opted in)')
from public.preferences
where email_reminders <> 'off';
