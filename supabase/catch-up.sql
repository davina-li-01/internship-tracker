-- Orbit — bring the database level with the app
--
-- Run the whole thing in the Supabase SQL editor. Safe to re-run: every
-- statement is `if not exists` or an idempotent update.
--
-- WHY THIS FILE EXISTS
--
-- js/db.js degrades rather than failing when a column is missing: if the save
-- is rejected for an unknown column it drops that one field and retries, so the
-- rest of the record still saves. That is deliberate — an unrun migration
-- should cost you one field, not every field. The cost is that a missing column
-- is SILENT. Nothing errors. The value just never comes back.
--
-- That is exactly what "emails are not saving" was.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — What is actually there right now
-- ═════════════════════════════════════════════════════════════════════════════
-- Run this on its own first if you want to see the before/after. It lists every
-- column the app reads or writes and whether your database has it.

with expected(tbl, col, needed_for) as (values
  ('contacts',    'emails',                'Several addresses per person, and calendar matching'),
  ('contacts',    'industry',              'Industry field on the profile'),
  ('contacts',    'company_history',       'Past companies'),
  ('contacts',    'interactions',          'Conversation history'),
  ('contacts',    'follow_ups',            'Things to bring up next'),
  ('contacts',    'next_reminder',         'Reach-out deadline'),
  ('contacts',    'reminder_enabled',      'Whether this person is on a cadence'),
  ('contacts',    'last_nudged_at',        'Email digest — per-person cool-off (ORB-16)'),
  ('contacts',    'nudge_streak',          'Email digest — chronic cases (ORB-27)'),
  ('preferences', 'your_email',            'Where reminder email is sent'),
  ('preferences', 'phone',                 'Settings'),
  ('preferences', 'avatar_url',            'Profile photo'),
  ('preferences', 'email_reminders',       'Email opt-in'),
  ('preferences', 'last_reminder_sent_at', 'Email digest — per-user rhythm')
)
select e.tbl                                    as table_name,
       e.col                                    as column_name,
       case when c.column_name is null
            then '❌ MISSING' else '✅ present' end as status,
       e.needed_for
from expected e
left join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = e.tbl and c.column_name = e.col
order by (c.column_name is not null), e.tbl, e.col;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — Several addresses per person  ← this is the "emails not saving" fix
-- ═════════════════════════════════════════════════════════════════════════════
--
-- jsonb, for the same reason conversations and follow-ups are: the shape can
-- grow without another migration.
--
-- Shape: [{ "id": "...", "label": "personal|work|school|other", "address": "..." }]
--
-- contacts.email is NOT dropped. It stays as the primary, so everything that
-- reads a single string — mailto links, the capture form, search — keeps
-- working, and so the app can still degrade to one address if this is missing.

alter table public.contacts
  add column if not exists emails jsonb not null default '[]'::jsonb;

-- Back-fill from the address already stored, so nothing has to be re-entered.
-- Only touches rows with an empty list, so re-running cannot duplicate.
update public.contacts
set emails = jsonb_build_array(
      jsonb_build_object(
        'id',      gen_random_uuid()::text,
        'label',   'personal',
        'address', email
      )
    )
where coalesce(email, '') <> ''
  and (emails is null or jsonb_array_length(emails) = 0);

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 3 — Past companies
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Almost certainly already present — company_history has been in the schema
-- from the start, and if it were missing NOTHING on the profile would save,
-- not just this. Included so the file is complete and this can be ruled out.
--
-- If past companies still do not stick after running this, the cause was the
-- app, not the database: clicking Save discarded whatever was typed into "Add
-- a past company" (only the + button or Enter committed it). Fixed 2026-08-10.

alter table public.contacts
  add column if not exists company_history jsonb not null default '[]'::jsonb;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 4 — Email digest (ORB-27)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Two things here, and the second one is a live bug rather than a new feature.

-- How many consecutive digests a person has appeared in. Past the threshold
-- they collapse into one line pointing at their cadence — repeating a name you
-- have ignored three times is nagging, and by then the problem has changed:
-- it is not that you forgot, it is that you said monthly and meant quarterly.
alter table public.contacts
  add column if not exists nudge_streak integer not null default 0;

-- THE LIVE BUG: the app writes 'fortnightly', but the old CHECK constraint only
-- permits ('off','daily','weekly') — so turning email reminders on in Settings
-- is rejected by the database. The old values stay valid on purpose: a
-- migration that silently unsubscribes someone is worse than one that changes
-- their rhythm, and the Edge Function honours all three as opted-in.
alter table public.preferences
  drop constraint if exists preferences_email_reminders_check;

alter table public.preferences
  add constraint preferences_email_reminders_check
  check (email_reminders in ('off', 'fortnightly', 'daily', 'weekly'));

update public.preferences
set email_reminders = 'fortnightly'
where email_reminders in ('daily', 'weekly');

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 5 — Columns Settings writes
-- ═════════════════════════════════════════════════════════════════════════════
-- No-ops if you have already run add-settings-columns.sql.

alter table public.preferences add column if not exists your_email text default '';
alter table public.preferences add column if not exists phone      text default '';
alter table public.preferences add column if not exists avatar_url text default '';

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 6 — Verify
-- ═════════════════════════════════════════════════════════════════════════════

-- Every row should now read ✅.
with expected(tbl, col) as (values
  ('contacts','emails'), ('contacts','company_history'), ('contacts','nudge_streak'),
  ('contacts','last_nudged_at'), ('preferences','your_email'), ('preferences','avatar_url'),
  ('preferences','email_reminders'), ('preferences','last_reminder_sent_at')
)
select e.tbl as table_name, e.col as column_name,
       case when c.column_name is null then '❌ STILL MISSING' else '✅ present' end as status
from expected e
left join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = e.tbl and c.column_name = e.col
order by e.tbl, e.col;

-- What the back-fill did. addresses_stored should be at least 1 for anyone who
-- had an email; 0 means they never had one saved.
select name,
       email                                  as primary_address,
       coalesce(jsonb_array_length(emails), 0) as addresses_stored,
       coalesce(jsonb_array_length(company_history), 0) as past_companies
from public.contacts
order by name;
