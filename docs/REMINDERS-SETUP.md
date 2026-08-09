# Scheduled email reminders — setup (ORB-16)

Everything in Orbit until now ran in a browser tab. This is the first piece that
runs when the tab is closed, which is why it needs setup that nothing else did.

Roughly 25 minutes, and **most of it is on your side** — I cannot create your
Resend account or deploy under your Supabase login.

---

## What you are building

```
pg_cron (daily, 13:00 UTC)
   └─ pg_net makes an HTTP call
        └─ send-reminders Edge Function
             ├─ reads contacts where next_reminder <= today
             ├─ groups them per user into ONE digest
             └─ sends it via Resend
```

Nothing here recomputes relationship health. `contacts.next_reminder` is the
deadline the app already calculated, so the job only asks whether that date has
passed. That is deliberate — a second implementation of the health rules is how
the email would start disagreeing with the dashboard.

---

## Step 1 — Run the migration

Supabase dashboard → **SQL Editor** → paste `supabase/add-reminder-columns.sql`
→ Run.

It should print three rows: `contacts.last_nudged_at`,
`preferences.email_reminders`, `preferences.last_reminder_sent_at`.

## Step 2 — Get a Resend API key

1. Sign up at [resend.com](https://resend.com) — the free tier is 3,000
   emails/month, which is far more than this will ever use.
2. **API Keys** → **Create API Key** → copy it (`re_...`). You only see it once.

You can send from `onboarding@resend.dev` immediately without verifying a
domain. It is fine for testing, but it will land in spam more often and you
cannot change the display name. If you want reminders that reliably reach your
inbox, verify a domain under **Domains** and set `REMINDER_FROM` in step 4.

## Step 3 — Invent a cron secret

**Nothing gives you this one — you make it up.** It is a password you choose, and
its only job is to stop anyone else from triggering your reminder job. The Edge
Function ignores any request that does not present it.

Run this in your terminal, anywhere:

```bash
openssl rand -hex 32
```

It prints a single long line:

```
7f3a9c1e5b2d8a460f1c7e93b4a52d81c6f0e7a394b25d8f1e0c7a63b95d4e28
```

That string **is** the secret. Copy it.

`hunter2` would technically work too — don't. Anyone who found the function URL
could then run your job whenever they liked.

**It goes in exactly two places, and they must match character for character:**

| Where | How |
|---|---|
| Supabase function secret | `npx supabase secrets set CRON_SECRET=...` (step 4) |
| Supabase Vault | replaces `REPLACE_WITH_YOUR_CRON_SECRET` (step 6) |

A mismatch is the most common failure here, and it shows up as `401
unauthorized`.

You do **not** need to remember it afterwards — it lives in those two places for
good. Keep it in your clipboard for the next few minutes; if you lose it later,
generate a new one and update both sides.

## Step 4 — Set the function secrets

```bash
cd /path/to/orbit

npx supabase login
npx supabase link --project-ref kctmclcjqpytswwyewti

npx supabase secrets set RESEND_API_KEY=re_your_key_here
npx supabase secrets set CRON_SECRET=the_string_from_step_3
npx supabase secrets set ORBIT_APP_URL=https://davina-li-01.github.io/orbit/

# Only if you verified a domain in step 2:
# npx supabase secrets set REMINDER_FROM="Orbit <reminders@yourdomain.com>"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically. **Do
not** add the service-role key to any file in this repo — it bypasses every RLS
policy, and this repo is public.

## Step 5 — Deploy the function

```bash
npx supabase functions deploy send-reminders --no-verify-jwt
```

**The flag matters.** Edge Functions demand a JWT `Authorization` header by
default. This one is invoked by pg_cron, which has no signed-in user and so no
JWT to send — leave the gate on and every scheduled run is rejected by the
gateway with `UNAUTHORIZED_NO_AUTH_HEADER` before the function ever runs.

`supabase/config.toml` sets `verify_jwt = false` for this function too, so the
flag is belt and braces; deploying from this repo does the right thing either
way.

This does not leave the function unprotected. It checks `CRON_SECRET` itself on
the first line of the handler and returns 401 without it — that check *is* the
auth, and it is the reason the secret has to be unguessable.

Then test it before scheduling anything. `?dry=1` reports what it *would* send
without sending or stamping:

```bash
curl -i "https://kctmclcjqpytswwyewti.supabase.co/functions/v1/send-reminders?dry=1" \
  -H "x-cron-secret: the_string_from_step_3"
```

**Expected:** `{"ok": true, "dryRun": true, "results": [...]}`

| What you see | What it means |
|---|---|
| `results: []` | No user has email reminders switched on yet — that is step 7 |
| `"skipped": "nothing due"` | Working. Nobody is overdue right now |
| `wouldSend: {...}` | Working, and there is something to send |
| `{"error":"unauthorized"}` | Your header does not match `CRON_SECRET` |
| `UNAUTHORIZED_NO_AUTH_HEADER` | Deployed without `--no-verify-jwt`. The gateway blocked it before the function ran — redeploy with the flag |
| `"CRON_SECRET is not configured"` | Step 4 did not take — re-run and redeploy |

Both failures are a 401, so read the body, not the status line. The gateway's
rejection carries `sb-error-code`; the function's own is a plain
`{"error":"unauthorized"}`.

Drop the `?dry=1` when you want a real send.

## Step 6 — Schedule it

SQL Editor → paste `supabase/schedule-reminders.sql`, **replace
`REPLACE_WITH_YOUR_CRON_SECRET` with the value from step 3**, → Run.

The secret goes into Supabase Vault rather than into the schedule itself,
because anything written into `cron.job` is readable in plain text by anyone who
can query that table.

The verification queries at the bottom of that file show whether the job is
registered and what the function replied.

## Step 7 — Turn it on in Orbit

Settings → **Notifications** → *Email me* → "At most once a day" or "once a
week" → **Save email setting**.

If your contact email is blank it will refuse rather than switch on silently
with nowhere to send.

---

## Why it will not spam you

Three independent brakes, which is deliberate — this is the one feature that
reaches you when you are not asking for it.

| Brake | Effect |
|---|---|
| **One digest per user** | Five overdue people produce one email listing five names, never five emails |
| **Per-contact cool-off (7 days)** | Someone stays overdue until you actually reach out. Without this they would be in every digest forever |
| **Per-user cadence** | Your daily/weekly choice, tracked by `last_reminder_sent_at`, independent of the cool-off |
| **`MAX_PER_DIGEST` = 8** | A wall of names is a guilt trip, not a prioritised list. The rest wait — and are *not* stamped, so they surface next time |

The cron job runs daily regardless. Running daily is not the same as emailing
daily: most days it finds nothing eligible and sends nothing.

---

## Troubleshooting

**The job runs but no email arrives.** `cron.job_run_details.status` only tells
you the HTTP call was made. What the function actually said is here:

```sql
select id, created, status_code, content
from net._http_response order by created desc limit 5;
```

**Emails go to spam.** Expected with `onboarding@resend.dev`. Verify a domain in
Resend and set `REMINDER_FROM`.

**Nothing is ever due.** Confirm there is something to find:

```sql
select name, next_reminder, reminder_enabled, last_nudged_at
from contacts
where reminder_enabled = true and next_reminder <= current_date;
```

**Function logs.** Supabase dashboard → Edge Functions → send-reminders → Logs.

**Turning it all off.** Settings → Email me → Never stops the mail. To stop the
job entirely: `select cron.unschedule('orbit-send-reminders');`

---

## Costs

| | Free tier | This uses |
|---|---|---|
| Supabase Edge Functions | 500K invocations/month | ~30 |
| Supabase pg_cron | included | 1 job |
| Resend | 3,000 emails/month | at most ~30 |

Comfortably free. The one thing to watch is that the **Supabase project still
pauses after ~7 days idle** (ORB-24) — and a paused project means the cron job
stops too. Ironically, the reminder that would bring you back is the thing that
stops when you stay away.
