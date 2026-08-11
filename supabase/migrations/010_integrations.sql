-- Orbit — the calendar connection follows your account, not your browser (ORB-39)
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- WHAT WAS WRONG
--
-- Everything about the Google connection lived in localStorage: whether you had
-- connected, which account, which calendar, when it last synced. All of that is
-- a property of the BROWSER, so opening Orbit somewhere new claimed you had
-- never connected Google — and "synced 2 hours ago" quietly meant *on this
-- device*, which is a worse kind of wrong because it looks right.
--
-- WHY jsonb AND NOT FOUR COLUMNS
--
-- Same reason conversations, follow-ups and email addresses are jsonb: the
-- shape grows without another migration. It is keyed by integration id, so a
-- second integration needs a key here and no schema change at all — which
-- matches integrationStates() in js/calendar.js, already written as a list of
-- one rather than as a single hard-coded calendar.
--
--   {
--     "google-calendar": {
--       "connected":  true,
--       "account":    "you@gmail.com",
--       "calendarId": "primary",
--       "lastSyncAt": 1786400000000,
--       "lastResult": { "at": 1786400000000, "found": 4, "logged": 3 }
--     }
--   }
--
-- `connected: false` is stored on disconnect rather than removing the key. The
-- difference matters: no record means nobody ever connected, false means
-- somebody deliberately disconnected. Collapsing the two would let a device
-- with stale localStorage push the connection back up — the same resurrection
-- bug that once made a deleted email address reappear.
--
-- WHAT IS *NOT* HERE
--
-- No access token, and no refresh token. Orbit still never stores either: the
-- token lives in a variable for the life of the tab. Everything in this column
-- is a label, so leaking it would let somebody learn which calendar you read,
-- not read it.

alter table public.preferences
  add column if not exists integrations jsonb not null default '{}'::jsonb;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- Empty until you next connect, disconnect, or change which calendar is read.
select user_id,
       integrations -> 'google-calendar' ->> 'account'    as connected_account,
       integrations -> 'google-calendar' ->> 'calendarId' as reading,
       integrations -> 'google-calendar' ->> 'connected'  as connected
from public.preferences;
