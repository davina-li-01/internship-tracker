-- Orbit — database schema
--
-- Reconstructed from the live database on 2026-08-06 and verified against
-- Postgres 15. This is the disaster-recovery record: if the Supabase project is
-- ever lost, this file rebuilds the structure.
--
-- Two deliberate differences from what was live when this was captured:
--
--   1. Policies here are owner-scoped. The live database had "Allow all (dev)"
--      policies (`for all to public using (true)`) on contacts, internships and
--      logs, which gave anyone with the public key full access to every row.
--      Restoring from this file gives you the secure version; `fix-rls.sql`
--      migrates an existing database to match.
--
--   2. The `internships`, `logs`, `interactions` and `follow_ups` tables that
--      existed when this was captured have since been dropped
--      (`drop-legacy-tables.sql`). They are deliberately not recreated here.
--      Conversations, company history and follow-ups live in jsonb columns on
--      `contacts`.
--
-- Safe to re-run.

-- ═══ Tables the app actually uses ════════════════════════════════════════════

create table if not exists public.contacts (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  name                text,
  email               text,
  role                text,
  company             text,
  industry            text default '',
  date_met            date,
  last_contacted      date,
  follow_up_frequency text,
  next_reminder       date,
  reminder_enabled    boolean default false,
  notes               text,
  advice_given        text,
  interests           text,
  interactions        jsonb default '[]'::jsonb,
  company_history     jsonb default '[]'::jsonb,
  follow_ups          jsonb default '[]'::jsonb,
  -- Last time the reminder job emailed about this person (ORB-16). Someone
  -- stays overdue until you reach out, so without this they would appear in
  -- every digest forever.
  last_nudged_at      timestamptz,
  created_at          timestamp default now()
);

create index if not exists contacts_user_id_idx on public.contacts (user_id);

-- The reminder job's only read: who is past their deadline.
create index if not exists contacts_due_idx
  on public.contacts (next_reminder)
  where reminder_enabled = true;

create table if not exists public.preferences (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  your_name             text,
  your_email            text,
  phone                 text,
  manager_name          text,
  next_steps            text,
  -- 'off' | 'daily' | 'weekly'. Defaults to off: email is the only thing here
  -- that reaches someone who did not open the app, so it must be opted into.
  email_reminders       text default 'off'
    check (email_reminders in ('off', 'daily', 'weekly')),
  last_reminder_sent_at timestamptz
);

-- NOTE: internship_id and contact_id are `text`, not `uuid`, even though
-- contacts.id is a uuid. Kept as-is to match the live database — js/main.js
-- joins these client-side by string, so it works, but it is a latent mismatch.
create table if not exists public.storage_files (
  id            uuid primary key,
  user_id       uuid not null references auth.users(id),
  contact_id    text,
  internship_id text,
  name          text not null,
  file_url      text not null,
  storage_path  text not null,
  category      text default 'general'::text,
  created_at    timestamptz default now()
);

-- ═══ Row Level Security ══════════════════════════════════════════════════════
-- Without these, RLS denies everything and the app silently reads empty lists.

alter table public.contacts      enable row level security;
alter table public.preferences   enable row level security;
alter table public.storage_files enable row level security;

drop policy if exists "contacts_owner" on public.contacts;
create policy "contacts_owner" on public.contacts
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "preferences_owner" on public.preferences;
create policy "preferences_owner" on public.preferences
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "storage_files_owner" on public.storage_files;
create policy "storage_files_owner" on public.storage_files
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ═══ Storage ═════════════════════════════════════════════════════════════════
-- Public read, because db.uploadFileToStorage() hands out getPublicUrl() links.
-- Writes are scoped to `${userId}/…`, the path db.js uploads to.

insert into storage.buckets (id, name, public)
values ('interntrack-files', 'interntrack-files', true)
on conflict (id) do update set public = true;

drop policy if exists "orbit read"   on storage.objects;
drop policy if exists "orbit insert" on storage.objects;
drop policy if exists "orbit update" on storage.objects;
drop policy if exists "orbit delete" on storage.objects;

create policy "orbit read" on storage.objects
  for select using (bucket_id = 'interntrack-files');

create policy "orbit insert" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'interntrack-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "orbit update" on storage.objects
  for update to authenticated using (
    bucket_id = 'interntrack-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "orbit delete" on storage.objects
  for delete to authenticated using (
    bucket_id = 'interntrack-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ═══ Legacy tables — dropped 2026-08-06 ═════════════════════════════════════
-- `internships`, `logs`, `interactions` and `follow_ups` were removed by
-- supabase/drop-legacy-tables.sql. They are intentionally NOT recreated here:
-- restoring from this file should give you the current app, not its history.
