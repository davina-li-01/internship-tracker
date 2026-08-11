# Migrations

Run these in order against a fresh Supabase project and you get the database
Orbit actually runs on. That is the whole point of the numbering — before
ORB-49 these were hand-named files in one flat folder, and the order you had to
apply them in existed only in my head and in commit dates.

**Every file is safe to re-run.** They use `create table if not exists`,
`add column if exists`, and drop-then-create for policies. Running the whole
sequence against the live project is a no-op rather than a disaster.

| # | File | What it does |
|---|---|---|
| 001 | `001_schema.sql` | Tables, indexes, RLS enabled |
| 002 | `002_rls_policies.sql` | Owner-scoped policies on every table, plus the four storage policies |
| 003 | `003_drop_legacy_tables.sql` | Removes `internships`, `logs`, `interactions`, `follow_ups` |
| 004 | `004_settings_columns.sql` | Settings fields; drops `preferences.manager_name` and `next_steps` |
| 005 | `005_reminder_columns.sql` | Reminder scheduling columns (ORB-16) |
| 006 | `006_schedule_reminders.sql` | pg_cron + pg_net + Vault, daily digest job (ORB-16) |
| 007 | `007_digest_streak.sql` | `contacts.nudge_streak` (ORB-27) |
| 008 | `008_contact_emails.sql` | `contacts.emails` jsonb, back-filled (ORB-39) |
| 009 | `009_timezone_hourly_digest.sql` | `preferences.timezone`; re-schedules the cron hourly (ORB-43) |
| 010 | `010_integrations.sql` | `preferences.integrations` jsonb (ORB-44) |
| 011 | `011_drop_orphan_internship_columns.sql` | Drops the last two `internship_id` columns (ORB-49) |
| 012 | `012_relationship_tiers.sql` | `contacts.tier`, back-filled from the existing interval (ORB-52) |

## Two things that look wrong and are not

**001 creates columns that 004 drops.** `manager_name` and `next_steps` are in
the original schema and removed four steps later. The sequence is a history, not
a design — it reproduces how the database actually got here. Collapsing it would
mean `001_schema.sql` no longer matches the file that was really applied.

**006 schedules the digest daily and 009 re-schedules it hourly.** Same reason.
The end state after a full run is the hourly job, which is correct.

## Requires a manual step

`006_schedule_reminders.sql` contains `REPLACE_WITH_YOUR_CRON_SECRET`. Substitute
the real value — the same one set as the `CRON_SECRET` function secret — before
running it. It is the only file in the sequence that is not paste-and-go, and the
only one that fails on a second run, because `vault.create_secret` errors if the
secret already exists. Use `vault.update_secret` instead, as noted in the file.

## Not migrations

`supabase/scripts/` holds two diagnostics that change nothing:

- `check-rls.sql` — proves row level security is scoping rows to their owner
- `catch-up.sql` — reports every column the app writes as present or missing

## If you ever want `supabase db push`

These are ordinals, not the 14-digit timestamps the Supabase CLI expects, because
the CLI is not how they have been applied — they go into the SQL Editor by hand.
Switching later means renaming to timestamps and running `supabase migration
repair --status applied` for each one already live, so the CLI does not try to
replay them. Worth doing when a second environment exists; pointless before then.

## Removed

`storage-policies.sql` was deleted in the ORB-49 pass. Its four policies are
reproduced exactly in `002_rls_policies.sql`, which also clears the older
`rs3hur_*` policies — it was a strict subset. `git log --diff-filter=D` will find
it if it is ever wanted back.
