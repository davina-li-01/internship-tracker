-- Orbit — replace the permissive dev policies with real ownership rules
--
-- WHY THIS MATTERS
-- `contacts`, `internships` and `logs` each carry a policy named
-- "Allow all (dev)" defined as:
--
--     for all to public using (true) with check (true)
--
-- `to public` means every role including `anon`, and `using (true)` means no
-- row is ever filtered. Combined, that lets anyone holding the publishable key
-- read, modify, or delete every row in those tables. That key is shipped in
-- js/supabase.js and served publicly from GitHub Pages, so it is not a secret.
--
-- Row Level Security is the ONLY thing standing between a public key and your
-- data. These policies remove that protection entirely.
--
-- Verified before writing this: every existing contacts row has user_id set,
-- so tightening the policy will not hide any of your data.
--
-- Safe to re-run.

begin;

-- ─── contacts: owner-only ─────────────────────────────────────────────────────

drop policy if exists "Allow all (dev)" on public.contacts;
drop policy if exists "contacts_owner"  on public.contacts;

create policy "contacts_owner" on public.contacts
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- user_id is the whole basis of that policy, so stop it being nullable and
-- point it at the real user table.
alter table public.contacts
  alter column user_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'contacts_user_id_fkey' and conrelid = 'public.contacts'::regclass
  ) then
    alter table public.contacts
      add constraint contacts_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- Every query in js/db.js filters on user_id; there was no index for it.
create index if not exists contacts_user_id_idx on public.contacts (user_id);

-- ─── internships / logs: unused by the app ────────────────────────────────────
-- Orbit no longer reads or writes these. Dropping the permissive policy without
-- adding a replacement leaves RLS enabled with no policy, which denies all
-- access — the safe default for a table nothing uses.

drop policy if exists "Allow all (dev)" on public.internships;
drop policy if exists "Allow all (dev)" on public.logs;

-- ─── storage: scope writes to each user's own folder ──────────────────────────
-- The dashboard-created policies only check the bucket, so any signed-in user
-- can overwrite or delete anyone's file. js/db.js uploads to
-- `${userId}/${timestamp}-${filename}`, so the first path segment is the owner.

drop policy if exists "read rs3hur_0"              on storage.objects;
drop policy if exists "manage own files rs3hur_0"  on storage.objects;
drop policy if exists "manage own files rs3hur_1"  on storage.objects;
drop policy if exists "manage own files rs3hur_2"  on storage.objects;
drop policy if exists "manage own files rs3hur_3"  on storage.objects;
drop policy if exists "orbit read"                 on storage.objects;
drop policy if exists "orbit insert"               on storage.objects;
drop policy if exists "orbit update"               on storage.objects;
drop policy if exists "orbit delete"               on storage.objects;

create policy "orbit read" on storage.objects
  for select
  using (bucket_id = 'interntrack-files');

create policy "orbit insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'interntrack-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "orbit update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'interntrack-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "orbit delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'interntrack-files'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

commit;

-- ─── Optional: drop the tables Orbit no longer uses ───────────────────────────
-- `internships` (1 row), `logs`, `interactions` and `follow_ups` are all dead —
-- nothing in js/db.js reads or writes them. Conversations and follow-ups live in
-- jsonb columns on `contacts` instead. Uncomment ONLY when you are sure you do
-- not want the old internship record back; this is irreversible.
--
-- drop table if exists public.logs;
-- drop table if exists public.internships;
-- drop table if exists public.interactions;
-- drop table if exists public.follow_ups;
