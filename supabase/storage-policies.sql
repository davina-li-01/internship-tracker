-- Orbit — storage policies for the `interntrack-files` bucket
--
-- The bucket being "public" only makes objects READABLE through their public
-- URL. Uploading is an INSERT into storage.objects, which has row level
-- security enabled — with zero policies, every upload is denied.
--
-- js/db.js uploads to `${userId}/${timestamp}-${filename}`, so the first path
-- segment is the owner's user id. These policies use that to scope writes:
-- anyone can read, but you can only write and delete inside your own folder.
--
-- Safe to re-run.

drop policy if exists "orbit read"   on storage.objects;
drop policy if exists "orbit insert" on storage.objects;
drop policy if exists "orbit update" on storage.objects;
drop policy if exists "orbit delete" on storage.objects;

-- Read: public, matching the bucket's public setting and getPublicUrl() links.
create policy "orbit read" on storage.objects
  for select
  using (bucket_id = 'interntrack-files');

-- Write: signed-in users, own folder only.
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
