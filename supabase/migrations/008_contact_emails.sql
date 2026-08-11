-- Orbit — several email addresses per person
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- People have a work address, a personal one, one from school, one for a side
-- project — and a calendar invite arrives at whichever is relevant. Orbit
-- matches calendar attendees against saved addresses, so storing only one meant
-- every invite sent to any of the others silently failed to match, which looks
-- exactly like "no meetings found".
--
-- `contacts.email` is NOT dropped. It stays as the primary address, so anything
-- reading a single string — mailto links, the capture form, search — keeps
-- working, and so the app degrades to single-address behaviour rather than
-- breaking if this column is ever missing.
--
-- Shape: [{ "id": "...", "label": "personal|work|school|other", "address": "..." }]
-- jsonb for the same reason conversations and follow-ups are: it needs no
-- further migrations as the shape grows.

alter table public.contacts
  add column if not exists emails jsonb not null default '[]'::jsonb;

-- Back-fill from the address already stored, so nobody has to re-enter what
-- Orbit already knows. Idempotent: only touches rows with an empty list.
update public.contacts
set emails = jsonb_build_array(
      jsonb_build_object(
        'id', gen_random_uuid()::text,
        'label', 'personal',
        'address', email
      )
    )
where coalesce(email, '') <> ''
  and (emails is null or jsonb_array_length(emails) = 0);

-- ── Verify ───────────────────────────────────────────────────────────────────
select name,
       email                       as primary_address,
       jsonb_array_length(emails)  as addresses_stored
from public.contacts
order by name;
