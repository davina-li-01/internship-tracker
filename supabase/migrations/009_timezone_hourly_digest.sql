-- Orbit — send the digest at 9am in the READER's timezone
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- WHAT WAS WRONG
--
-- pg_cron works in UTC only, so the job fired at 13:00 UTC for everybody. That
-- is a reasonable mid-morning in London and half past two in the morning in
-- Honolulu. A nudge that lands overnight gets read the next day along with
-- everything else, which defeats the point of a fixed rhythm: it is supposed to
-- arrive when you can act on it.
--
-- HOW IT IS FIXED
--
-- The cron runs HOURLY and the Edge Function decides whose turn it is, by
-- comparing the hour in each user's own timezone against SEND_HOUR (9). Running
-- hourly is not the same as emailing hourly — 23 of those runs find nobody at
-- 9am and send nothing at all.
--
-- The timezone also fixes a quieter bug. "Who is overdue" is a DATE comparison,
-- and the date was taken from UTC. Sending at 9am local in a zone far enough
-- east means the UTC date has not rolled over yet, so a contact due today would
-- not be found. Same fault that once made the browser stamp tomorrow's date.

-- ── The column ───────────────────────────────────────────────────────────────
-- IANA name, e.g. 'Pacific/Honolulu'. Orbit fills this in from the browser the
-- next time you save a setting. UTC is the default because it is the honest
-- answer before anyone has told us otherwise — and the function falls back to
-- it for anything it cannot parse, so a bad value costs one person a
-- well-timed email rather than costing everyone their email.
alter table public.preferences
  add column if not exists timezone text not null default 'UTC';

-- ── Re-schedule the job hourly ───────────────────────────────────────────────
-- Requires supabase/schedule-reminders.sql to have been run first: the cron
-- secret must already be in Vault as 'orbit_cron_secret'.

select cron.unschedule('orbit-send-reminders')
where exists (select 1 from cron.job where jobname = 'orbit-send-reminders');

select cron.schedule(
  'orbit-send-reminders',
  '0 * * * *',
  $$
  select net.http_post(
    url     := 'https://kctmclcjqpytswwyewti.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
                 'content-type',  'application/json',
                 'x-cron-secret', (select decrypted_secret
                                     from vault.decrypted_secrets
                                    where name = 'orbit_cron_secret')
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- ── Verify ───────────────────────────────────────────────────────────────────

-- Should show one active job on '0 * * * *'.
select jobname, schedule, active from cron.job where jobname = 'orbit-send-reminders';

-- Everyone's timezone, and what 9am there is in UTC right now. If your row says
-- 'UTC' still, open Orbit and save any setting once — that is what fills it in.
select user_id,
       timezone,
       to_char(timezone(timezone, now()), 'YYYY-MM-DD HH24:MI') as their_local_time,
       email_reminders
from public.preferences;
