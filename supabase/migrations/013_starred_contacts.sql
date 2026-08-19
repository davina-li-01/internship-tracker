-- Orbit — star the people who matter (ORB-93)
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- WHY THIS AND NOT A TIER
--
-- Survey 1 asked five students when they knew which contacts genuinely
-- mattered. Two knew from the first conversation. One knew after several
-- months. Two only know looking back, now.
--
-- Every design that resolves that split by asking a better question is still
-- asking. A tier (012) demands a classification — which of five kinds is this —
-- at the moment you have the least information, and 3 of 5 could not answer it.
-- A star asks you to point rather than classify: one bit, no taxonomy, no
-- cadence attached, and simply absent for the people who cannot answer yet.
--
-- So the split stops being a design problem. The two who know are served; the
-- two who only know in hindsight are never blocked on a question.
--
-- STORED, NOT DERIVED
--
-- This column is written by the user and never by inference. That is the whole
-- distinction from ORB-86, which may later SUGGEST a tier from history. A
-- suggestion recorded as a choice would make ORB-57's first metric — a user
-- stars at least one person in their first week — unmeasurable, because every
-- contact would look deliberately marked.
--
-- 012 IS NOT REVERSED HERE
--
-- ORB-94 removes the tier picker from the UI, but `tier` stays on the table and
-- keeps its check constraint. Dropping the column would throw away the only
-- data that could ever tell us whether tiers were worth reviving, which is
-- exactly the question ORB-86 is parked waiting to answer.

alter table public.contacts
  add column if not exists starred boolean not null default false;

-- Reach out next sorts starred people first, and the dashboard counts them
-- separately. Both filter by user_id first, so the index is composite.
create index if not exists contacts_user_starred_idx
  on public.contacts (user_id, starred)
  where starred;

comment on column public.contacts.starred is
  'ORB-93. Set by the user, never by inference — see ORB-86 before deriving it.';
