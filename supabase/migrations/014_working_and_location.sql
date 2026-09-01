-- Orbit — two relationships that do not run on a clock (ORB-130, ORB-131)
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- WHY BOTH IN ONE FILE
--
-- They are the same idea twice. A cadence answers "how often should I contact
-- this person", and by 1 September two interviews and the app's own owner had
-- all said that is the wrong question for most people. These are the two
-- circumstances that replace it — one permanent, one temporary.
--
--   working_together  You are already in touch daily. Slack, standups, the same
--                     project. A countdown here is not merely unnecessary, it
--                     is wrong: it reports drift between two people who spoke
--                     an hour ago.
--
--   location          Where a person is. Interview 1 found three of five
--                     contacts gated entirely by geography — "I don't really
--                     reach out unless I'm back home, I love meeting up with
--                     them in person." The clock never fires on the week that
--                     matters and fires constantly on the fifty that do not.
--
-- WHERE YOU ARE lives on `preferences`, not here: it is one fact about the
-- reader, not a fact about each contact.
--
-- WHY location_until IS NOT NULL-BY-DEFAULT FOREVER
--
-- A trip with no end is a toggle, and a toggle you must remember to turn off
-- gets left on — after which the trigger fires permanently and becomes the
-- nagging ORB-126 spent a day removing. The column is nullable so "I live here"
-- is still expressible, but the UI asks for an end date.

alter table public.contacts
  add column if not exists working_together boolean not null default false;

alter table public.contacts
  add column if not exists location text not null default '';

alter table public.preferences
  add column if not exists current_location text not null default '';

alter table public.preferences
  add column if not exists location_until date;

-- Reach out next asks "who is where I am" on every dashboard load, and the
-- answer is a small slice of one user's rows. Filtered by user_id first, so
-- composite, and partial because a blank location can never match.
create index if not exists contacts_user_location_idx
  on public.contacts (user_id, location)
  where location <> '';

comment on column public.contacts.working_together is
  'ORB-130. Set by the user. Suppresses the cadence entirely rather than '
  'satisfying it — see getHealth, which returns early on this before it looks '
  'at follow_up_frequency.';

comment on column public.contacts.location is
  'ORB-131. Free text, matched case-insensitively against '
  'preferences.current_location. Deliberately not a place ID: the point is that '
  'the two strings came from the same person.';
