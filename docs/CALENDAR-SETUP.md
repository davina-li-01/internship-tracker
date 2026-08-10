# Google Calendar sync — setup (ORB-15)

Orbit only works if you remember to log the people you spoke to, which is
exactly the habit that fails. This reads your calendar and finds those meetings
for you.

Unlike email reminders, there is **nothing to deploy** — this runs entirely in
your browser. The setup is a Google Cloud project and a client ID.

---

## What this does and does not do

| | |
|---|---|
| Scope | `calendar.events.readonly` — Orbit **cannot** create, change or delete anything. Google enforces this, not us |
| Where it runs | Your browser. Nothing routes through a server |
| What is stored | **Nothing.** The access token lives in the tab and is gone when you close it. No refresh token, nothing in the database |
| Cost | Free. No billing account needed. Quota is 1M queries/day; a sync uses one |
| Matching | By email address, so only connections whose email you have saved can be found |
| Writing | Nothing is written until you confirm. Every match is shown first |

**The trade:** sync only happens while Orbit is open. That was chosen (2026-08-09)
over a server-side version, which would have meant storing Google refresh tokens
in the database and submitting the app for Google's verification review.

---

## Setup

### 1 · Create a project

[console.cloud.google.com](https://console.cloud.google.com) → new project → name
it `Orbit`.

Ignore the "$300 free trial — activate billing" banner. Calendar API needs no
billing account.

### 2 · Enable the API

**APIs & Services → Library** → search **Google Calendar API** → **Enable**.

### 3 · Configure the consent screen

**APIs & Services → OAuth consent screen** → **External**, then app name and
your email.

The console was redesigned recently; this may appear as **Google Auth Platform →
Audience** instead. You are looking for a **Test users** section either way.

**Add your own Google address to Test users.** Owning the project does not grant
you access — for an External app in Testing mode Google blocks every account
that is not explicitly listed, including the developer's. Skipping this gives:

```
Error 403: access_denied
Orbit has not completed the Google verification process.
```

Staying in **Testing** mode is what avoids Google's verification review, which
for a sensitive scope like Calendar wants a privacy policy and a demo video.
Fine while you are the only user — and there is room for 100 of them. Do not
press **Publish app**.

### 4 · Create the client ID

**APIs & Services → Credentials → Create Credentials → OAuth client ID → Web
application**.

Under **Authorized JavaScript origins**, add every origin Orbit runs on:

```
http://localhost:5500
http://localhost:5501
http://127.0.0.1:5500
http://127.0.0.1:5501
https://davina-li-01.github.io
https://orbit-network-sigma.vercel.app
```

**Both `localhost` and `127.0.0.1` are listed on purpose.** They are the same
machine but *different origins* to Google, and which one Live Server hands you
is not something you chose. Both ports are listed for the same reason: Live
Server claims 5500 and silently moves up if it is taken.

Origins are scheme + host + port — **no trailing slash, no path**.
`http://localhost:5500` is right; `http://localhost:5500/` is not.

Leave **Authorized redirect URIs** empty; the token flow does not use them.

Changes take a minute to propagate, and the browser caches the old config — do
a hard reload (`Cmd+Shift+R`) before deciding it did not work.

### 5 · Put the client ID in the code

It is already set at the top of `js/calendar.js`:

```js
const CLIENT_ID = "4293730503-517jknqdk0kfkouikg9h20hsektkrcsf.apps.googleusercontent.com";
```

**This is not a secret.** Google issues these to be shipped in browser code —
that is the whole reason this design needs no server and stores no tokens.
Changing project means changing this line.

### 6 · Connect it, once

Settings → **Integrations** → **Connect Google Calendar**.

Google asks for permission. Expect an **"unverified app"** warning — that is
Testing mode, not a problem. Click *Advanced* → *Go to Orbit (unsafe)*.

**After that you never open Settings for this again.** Orbit checks on its own
every few hours when you open it, and only speaks up when it has found
something:

```
3 meetings found on your calendar.   [Review]  ✕
```

**Review** opens the pre-ticked list. Untick anything wrong, press **Log
selected**.

Settings keeps **Check now** for forcing a sync, and **Disconnect**.

---

## Why it asks you to confirm

A meeting on a calendar is not proof you spoke. Logging one moves that person's
next reach-out date, so a wrong match makes a drifting relationship look
healthy — the exact failure Orbit exists to prevent.

So the matching is filtered hard before you ever see it. An event is skipped if:

- it is **cancelled**, or has not happened yet
- **you declined** it
- it has more than **12 attendees** — that is a broadcast, not a conversation
- the other person **declined**
- it is **already logged**, either from an earlier sync or typed by hand

Everything arriving pre-ticked means the common case is still one click. What it
avoids is writing silently.

### Not logging the same meeting twice

Each synced conversation stores the calendar event's id. Re-running a sync
compares against that, so a meeting is offered once even if you rename it later.

Entries you typed yourself have no event id, so those are matched by date and
title instead — that is what stops the first sync duplicating a history you
already wrote up by hand.

---

## Troubleshooting

| What you see | Cause |
|---|---|
| `Error 400: origin_mismatch` | The address in your bar is not in the list from step 4. Check it exactly — `127.0.0.1` and `localhost` are different origins to Google, and Live Server moves off 5500 when it is taken. After fixing, wait a minute and hard-reload |
| `redirect_uri_mismatch` | Same cause as above |
| "Google hasn't verified this app" | Expected in Testing mode. *Advanced* → *Go to Orbit (unsafe)* |
| `Error 403: access_denied` | Your account is not on the **Test users** list from step 3. Being the project owner is not enough |
| "Google sign-in was closed" | The popup was dismissed. Try again |
| "Google access expired. Connect again." | Normal. Testing-mode tokens are short-lived — click the button again |
| "None of your connections have an email saved" | Matching is by email. Add some |
| No meetings found | Nothing in the last 30 days matched, or it is all already logged |
| Popup never appears | Browser blocked it. Allow popups for this site |

**Re-authorising is usually silent.** Your consent is granted once and Google
remembers it — what expires is the hour-long access token, not your permission.
Orbit asks with `prompt: ""`, which lets Google reissue quietly whenever it can.
The one case it cannot is when you are no longer signed in to Google in that
browser, and then a chooser is unavoidable.

(This used to pass `prompt: "consent"`, which forced the full approval screen on
every single reconnect — making a renewal Google was happy to do silently look
like being asked to approve the app all over again.)

Tokens for apps in Testing mode still expire. When that happens the background sync stops silently and Orbit
offers a **Reconnect** toast — at most once a day, because an app that nags on
every page load about a background feature is worse than one that goes quiet.

### How the background sync behaves

| | |
|---|---|
| Frequency | At most once every 4 hours. Every page here is a full page load, so without a throttle it would hit Google on every navigation |
| Popups | Never unprompted. It asks Google to reissue silently; if that needs a popup, the browser blocks it (no user gesture) and the sync is simply skipped |
| Timeout | 8 seconds. `requestAccessToken` only settles when Google calls back, so without one a blocked popup would leave a promise pending forever and the sync stamp would never be written |
| Failure | Silent. Returns no candidates, keeps the connection remembered, retries later |
| Stored | Still nothing but a flag saying you connected before. No token, ever |

---

## If you ever want it fully automatic

The event-matching logic in `js/calendar.js` is pure and has no browser
dependencies, so it would move to an Edge Function unchanged. What server-side
sync would additionally need:

- a client **secret**, and Google refresh tokens stored per user
- a token refresh path
- Google's verification review, since other people's tokens would be involved
- the cron infrastructure ORB-16 already has

`LOOKBACK_DAYS` and `MAX_ATTENDEES` are the two knobs worth revisiting first —
both are guesses.
