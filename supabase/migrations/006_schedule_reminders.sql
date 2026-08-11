-- Orbit — schedule the reminder digest (ORB-16)
--
-- Run AFTER add-reminder-columns.sql and after the send-reminders Edge Function
-- is deployed. Safe to re-run: the schedule is dropped and recreated.
--
-- pg_cron is what makes Orbit able to reach you when it is closed. pg_net is
-- what lets a database row trigger an HTTP call to the Edge Function.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── The shared secret ────────────────────────────────────────────────────────
-- The Edge Function refuses any request without this header, because it runs
-- with the service-role key and can read every user's rows.
--
-- Vault is used rather than pasting the secret into the schedule below: anything
-- written into cron.job is readable in plain text by anyone who can query that
-- table. Use the SAME value you set as the CRON_SECRET function secret.
select vault.create_secret(
  'REPLACE_WITH_YOUR_CRON_SECRET',
  'orbit_cron_secret',
  'Shared secret for the Orbit send-reminders Edge Function'
);
-- Already created it and need to change the value? Use this instead:
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'orbit_cron_secret'),
--     'NEW_VALUE');

-- ── The schedule ─────────────────────────────────────────────────────────────
-- 13:00 UTC daily — about 9am Eastern, 6am Pacific. Adjust the cron expression
-- if you want it to land at a different local hour; pg_cron works in UTC only.
--
-- Running daily does NOT mean a daily email. The function throttles per user
-- ('daily' or 'weekly' in Settings) and per contact (a 7-day cool-off), so this
-- job usually finds nothing to do and sends nothing.

select cron.unschedule('orbit-send-reminders')
where exists (select 1 from cron.job where jobname = 'orbit-send-reminders');

select cron.schedule(
  'orbit-send-reminders',
  '0 13 * * *',
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

-- The job should be listed and active.
select jobid, jobname, schedule, active from cron.job where jobname = 'orbit-send-reminders';

-- After the first run, this shows whether it succeeded. `status` is the cron
-- job's own status — it says the HTTP call was made, not that mail was sent.
select jobid, status, return_message, start_time
from cron.job_run_details
where jobid in (select jobid from cron.job where jobname = 'orbit-send-reminders')
order by start_time desc
limit 5;

-- What the Edge Function actually replied. This is the one that tells you
-- whether an email went out.
select id, created, status_code, content
from net._http_response
order by created desc
limit 5;
