-- Orbit — columns needed by scheduled email reminders (ORB-16)
--
-- Run this in the Supabase SQL editor before deploying the send-reminders
-- Edge Function. Safe to re-run.
--
-- Why these three and nothing else:
--
--   The reminder job deliberately does NOT re-implement relationship health.
--   `contacts.next_reminder` is already the deadline the app computed and
--   stored, so the job's whole question is "is next_reminder in the past?".
--   Duplicating the banding logic in TypeScript is how the server and the UI
--   would end up disagreeing about who is overdue.

-- ── Per-contact cool-off ─────────────────────────────────────────────────────
-- Someone stays overdue until you actually reach out, so without this they
-- would appear in every single digest, every day, forever. Stamping the send
-- means one nudge per person per cool-off window.
--
-- This is also what honours "remind me about the grace window, but only ONCE":
-- a newly scheduled contact is emailed about once, and not again for a week.
alter table public.contacts
  add column if not exists last_nudged_at timestamptz;

-- Finding overdue contacts is the job's only read, so index for it.
create index if not exists contacts_due_idx
  on public.contacts (next_reminder)
  where reminder_enabled = true;

-- ── Per-user email settings ──────────────────────────────────────────────────
-- Defaults to 'off' on purpose. Email is the one thing in this app that reaches
-- a person who did not open it, so it has to be opted into, never inherited.
alter table public.preferences
  add column if not exists email_reminders text default 'off';

-- Throttles the digest itself, independently of the per-contact cool-off. Without
-- it, one person going overdue each day would mean an email each day.
alter table public.preferences
  add column if not exists last_reminder_sent_at timestamptz;

-- Only these three values are meaningful; anything else is treated as 'off' by
-- the Edge Function, but reject it here so bad data cannot get in.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'preferences_email_reminders_check'
  ) then
    alter table public.preferences
      add constraint preferences_email_reminders_check
      check (email_reminders in ('off', 'daily', 'weekly'));
  end if;
end $$;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- Should return three rows.
select table_name, column_name, data_type
from information_schema.columns
where (table_name = 'contacts'    and column_name = 'last_nudged_at')
   or (table_name = 'preferences' and column_name in ('email_reminders', 'last_reminder_sent_at'))
order by table_name, column_name;
