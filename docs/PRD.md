# Orbit — Product Requirements

**Epic:** Orbit — a networking tracker that keeps relationships from going cold
**Status:** v1 shipped · v2 scoped
**Owner:** Davina Li
**Last updated:** 2026-08-07

---

## 1. Summary

Orbit helps people stay in touch with the professionals they meet on purpose rather than
by accident. You log who you spoke to and what was said, choose how often you want to
reach out to them, and Orbit tells you who you are drifting away from before the
relationship goes cold.

*Keep your people in orbit.*

---

## 2. Problem

Most people meet someone useful at an event, say "let's keep in touch," and never do.
The failure is not intent — it is that there is no system. Specifically:

| Problem | Consequence |
|---|---|
| Contacts scatter across LinkedIn, phone contacts, notes apps and email | No single place to look |
| Nothing tracks *when* you last spoke | You cannot tell a warm contact from a cold one |
| Nothing prompts you before it is awkward | You reach out only when you need something |
| Conversation details are forgotten | The next message is generic, so it doesn't land |

Existing tools fail at either end. A CRM is built for sales pipelines and is far too heavy
for a personal network. A contacts app stores who someone *is* but nothing about the
relationship. Neither answers the only question that matters: **who should I reach out to
this week?**

---

## 3. Target user

**Primary:** students and early-career professionals actively building a network —
internships, career fairs, coffee chats, alumni connections.

**Characteristics**
- 20–150 professional contacts; large enough to lose track, small enough to care individually
- Networking matters for real outcomes (referrals, internships, mentorship)
- No CRM experience and no interest in acquiring any
- Feels guilt about lapsed contacts but has no system to act on it

**Not the target:** sales teams, recruiters managing pipelines, anyone needing shared or
team-owned data.

---

## 4. Jobs to be done

1. When I meet someone worth knowing, I want to capture them and what we discussed while
   it is fresh, so I do not lose the detail that makes a follow-up feel personal.
2. When I decide someone matters, I want to commit to a rhythm, so staying in touch is a
   default rather than a decision I have to make repeatedly.
3. When I open the app, I want to know who to contact today, so I can act in five minutes
   instead of browsing a list and feeling bad.
4. When I do reach out, I want to remember what we last talked about, so the message is
   specific rather than "just checking in".

---

## 5. Goals and non-goals

### Goals
- **G1** — Make "who should I reach out to?" answerable in under ten seconds
- **G2** — Make logging a conversation fast enough to do immediately after having one
- **G3** — Make relationship decay *visible* before it becomes embarrassing
- **G4** — Preserve enough context that a follow-up can be specific

### Non-goals
- **NG1** — Not a CRM. No pipelines, deals, or forecasting.
- **NG2** — Not a messaging client. Orbit drafts; your email client sends.
- **NG3** — Not collaborative. One person's network, private to them.
- **NG4** — Not an address book. Orbit tracks the *relationship*, not just the person.
- **NG5** — No social feed, no public profiles, no discovery.

---

## 6. Core concept: relationship health

The idea the whole product rests on. Every connection you commit to gets a cadence
(weekly, monthly, custom). Health is how much of the current window is left:

```
health = (1 − days_since_last_contact / cadence_days) × 100
```

| Band | Meaning |
|---|---|
| **In touch** | 60%+ of the window remains |
| **Reach out soon** | Under 60% remains, deadline not yet passed |
| **Overdue** | The deadline has passed |

**Three rules that are load-bearing:**

1. **Overdue means genuinely past due**, never merely a low percentage. Someone 80 days
   into a 90-day cadence is at 11% but has 10 days left — calling that overdue would
   contradict the countdown displayed beside it.
2. **Connections without a cadence are not measured.** They are not unhealthy; they are
   simply not being tracked. The point is deliberate choice, not guilt about everyone.
3. **A new cadence grants a one-week grace window.** Committing to reconnect with someone
   you last spoke to months ago should not paint the dashboard red for work you just
   decided to do. It stays on the reach-out list until you confirm you contacted them.

---

## 7. Shipped in v1

Written as user stories. Each is complete and in production.

| ID | Story | Notes |
|---|---|---|
| **OR-1** | As a user, I can create an account and sign in, so my network is private and persists across devices | Supabase Auth; Row Level Security scopes every row to its owner |
| **OR-2** | As a user, I can log a conversation, and if I have met the person before their details fill themselves in, so I only have to write what was said | Name autocomplete disambiguates by role, company and recency. Never creates a duplicate contact |
| **OR-3** | As a user, I can set how often I want to reach out to someone, including a custom interval | Weekly → quarterly, or any number of days |
| **OR-4** | As a user, I can see at a glance who I am in touch with, who to reach out to soon, and who is overdue | Status tiles, health ring, breakdown bar |
| **OR-5** | As a user, I can see a prioritised list of who to contact next, most overdue first | "Reach out next" on the dashboard |
| **OR-6** | As a user, I can browse my whole network alphabetically and filter it | A–Z sections; filters for health, cadence, industry, and time since last contact |
| **OR-7** | As a user, I can review every conversation in reverse-chronological order | Networking Log, grouped by month |
| **OR-8** | As a user, I can open a connection's profile and see their full history, roles, companies and talking points | Includes an editable "things to bring up next" checklist |
| **OR-9** | As a user, I get a draft message when someone is due, so I don't stare at a blank compose window | Copy to clipboard or hand off to my email client |
| **OR-10** | As a user, I can upload documents and link them to a person | PDF previews, in-app rename |
| **OR-11** | As a user, I can manage my profile, password, notification frequency and theme | Two-pane settings |
| **OR-12** | As a user, I can export my whole network as CSV, so I am not locked in | Data controls |

**Quality bar met:** 137 automated tests; every page verified by rendering in a headless
browser; database secured with owner-scoped RLS; schema in version control.

---

## 8. v2 backlog

Ordered by expected value, with the reasoning stated so the order can be argued with.

### OR-13 — Rework "mark as reached out" · **P0 · UX debt**
> As a user, I want recording that I reached out to feel like one obvious action, so the
> core loop is not the clumsiest part of the app.

**Problem:** you click a button labelled **"Reach out"** — which describes something you
are about to do — to report something you already did, and it opens a dialog where you
click "I reached out". Two clicks and a dialog for one gesture, with the label pointing
the wrong way in time.

**Options** (undecided, deliberately):
1. Rename to "Mark reached out" — one line, fixes the tense
2. One-click done with undo — fastest, loses note capture
3. Open the conversation logger pre-filled — most consistent, most work
4. Swipe to dismiss — hides the action, awkward on desktop

**Decision needed:** do people usually have notes worth capturing, or do they just want
the row gone? Resolve with a week of real usage, not discussion.

**Acceptance criteria**
- Marking a reach-out complete takes one deliberate action
- The control's label describes what the user is reporting, not what they might do
- The cadence rolls forward and the person leaves "Reach out next"

---

### OR-14 — Logging from **+** gives no visible result · **P1 · Papercut**
> As a user, after I log a conversation I want to see that it landed, so I trust the app
> recorded what I wrote.

**The data is saved correctly** — this is a display gap. Neither page carrying the **+**
button displays conversations: the Dashboard lists only people needing attention (someone
you just spoke to is healthy, so correctly absent), and My Network rows show role, company
and health but never notes. The Networking Log is the only page that previews
conversations, and it has no **+**.

The page that would show you what you wrote is the one page you cannot write from.

**Acceptance criteria**
- After logging, the user sees confirmation naming the person
- There is a path from that confirmation to where the conversation is visible
- No page offers creating something it will never display

**Options:** confirmation with a link (cheapest) · show latest conversation in My Network
rows (better if the real complaint is that My Network shows nothing about the
relationship) · a "recently logged" strip on the dashboard · put **+** on the log too.

---

### OR-15 — Google Calendar auto-logging · **P1 · Highest leverage**
> As a user, I want conversations logged automatically from my calendar, so staying
> current does not depend on me remembering.

**Why it matters:** Orbit only works if you log touchpoints — which is exactly the habit
that fails. This removes the dependency on memory entirely and is the single biggest
change to the product's real-world effectiveness.

**Shape:** Google Cloud project → OAuth consent → `calendar.events.readonly` → Google
Identity Services with PKCE in the browser → poll recent events → match attendee emails
against saved contacts → create a conversation and roll the cadence forward.

**Acceptance criteria**
- Connect and disconnect a Google account from Settings
- Events with a matching attendee create a conversation automatically
- Auto-logged conversations are visibly distinguished from manual ones
- Unmatched attendees are offered as new connections, never created silently

**Risks:** only works for contacts with a saved email; Google requires app verification
before non-test users can grant the scope; needs a token-refresh story.

**Blocked by:** enough real contacts with emails saved to make matching meaningful.

---

### OR-16 — Scheduled email reminders · **P1**
> As a user, I want a reminder to arrive when someone is overdue, so I don't have to open
> the app to find out.

**Constraint that shapes the whole ticket:** Orbit runs entirely in the browser. A browser
tab cannot send mail, and cannot wake up in seven days to do it. This requires
server-side infrastructure that does not exist yet — a Supabase Edge Function on a cron
schedule plus an email provider.

**Acceptance criteria**
- A daily job finds overdue connections and emails a digest
- Frequency is user-controlled, including off
- The email links straight to the connection's profile

**Note:** same infrastructure as OR-15. Sequence them together; build the server-side
piece once.

---

### OR-17 — AI talking points · **P2 · Best next feature**
> As a user, I want suggested talking points drawn from my notes, so my follow-up is
> specific rather than generic.

Today `generateFollowUpSuggestions()` is a keyword heuristic — it pattern-matches action
verbs. It works but reads mechanically. Self-contained: no external auth, no new
infrastructure, immediately visible payoff.

**Acceptance criteria**
- Suggestions are generated from actual conversation notes
- Clearly marked as AI-generated and individually dismissible
- Degrades to the current heuristic if the model call fails

---

### OR-18 — Draft a thank-you from the conversation · **P2**
> As a user, I want a thank-you drafted from what I just wrote, so I can send it while the
> conversation is fresh.

Distinct from the existing reconnect template, which is generic by design. This one is
specific to what was just said.

**Dependency:** same model integration as OR-17. One prompt path, two entry points.

---

### OR-19 — PDF notes on a conversation · **P2**
> As a user, I want to attach a PDF to a conversation, so handwritten notes and shared
> decks live with the context they belong to.

**Mostly plumbing that exists:** `uploadFileToStorage()` already accepts a contact id, and
the profile's conversation form already takes a PDF. Missing: the same field on the
Networking Log, and showing attachments inline in the history.

---

### OR-20 — Two-factor authentication · **P3**
> As a user, I want 2FA, so a stolen password is not enough to reach my network.

**Recommendation: authenticator app (TOTP), not SMS.** TOTP is free on Supabase, works
offline, and has no per-message cost. SMS requires a paid provider and is the weaker
mechanism — SIM-swap attacks are why security guidance now prefers an app.

---

### OR-21 — Smaller items · **P3**
- **Key people tier** — mark a subset as high-priority (needs a `starred` column)
- **Network health over time** — is my network improving or decaying?
- **Company logos on profiles** — needs an external logo API; deliberately skipped so far

---

### OR-22 — Idle-pause resilience · **Tech debt**
> As a user, I want the app to work after I have not used it for a while.

Free-tier Supabase projects pause after ~7 days idle, which removes the project's DNS
record — the app dies with no useful error. A red banner now explains it when it happens,
but the fragility remains. Options: a scheduled ping, or accept it and rely on the banner.

---

## 9. Success metrics

The app is working if, after one month of use:

| Metric | Target | Why |
|---|---|---|
| Connections with a cadence set | > 50% of network | Measures whether the core commitment feels worth making |
| "Overdue" count trend | Falling | The whole point is fewer lapsed relationships |
| Conversations logged per week | ≥ 3 | Below this, the data is too thin to be useful |
| Days from meeting someone to logging them | < 2 | Capture must be fast enough to happen at all |
| Reach-outs initiated from Orbit | > 5/month | Distinguishes a used tool from a graveyard |

**The single number that matters:** *overdue count trending down while network size grows.*
Anything else can be gamed by simply adding fewer people.

---

## 10. Open questions

1. **Is a fixed cadence the right model?** Some relationships are naturally seasonal.
   Should cadence adapt to observed behaviour rather than being declared up front?
2. **What is the right grace window?** Seven days is a guess. It should be validated.
3. **Should Orbit ever suggest who to add?** Contacts you emailed but never logged, for
   instance — or does that make it feel invasive?
4. **How does this behave at 500 contacts?** Every design decision so far assumes 20–150.

---

## Appendix — Organising this in Jira

**Hierarchy**

```
Epic: Orbit — networking tracker
├── Story: OR-13  Rework "mark as reached out"
│   ├── Sub-task: Usage research — do users capture notes?
│   ├── Sub-task: Prototype the two leading options
│   └── Sub-task: Implement and test
├── Story: OR-15  Google Calendar auto-logging
│   ├── Sub-task: Google Cloud project + OAuth consent screen
│   ├── Sub-task: PKCE flow with Google Identity Services
│   ├── Sub-task: Attendee → contact matching
│   └── Sub-task: Auto-logged conversation UI treatment
└── …
```

**Suggested fields**
- **Priority** — P0 blocks the core loop; P1 changes real-world effectiveness; P2 improves
  a working flow; P3 is nice to have
- **Labels** — `ux-debt`, `infrastructure`, `ai`, `security`, `tech-debt`
- **Story points** — OR-14 ≈ 1 · OR-13 ≈ 3 · OR-17 ≈ 5 · OR-19 ≈ 3 · OR-15 ≈ 13 · OR-16 ≈ 8

**Two habits worth keeping from this document**
1. **Write the user story before the solution.** OR-13 stayed open specifically because
   the story was clear but the solution was not — and that is a legitimate state for a
   ticket to be in.
2. **Record what a ticket is blocked on, including when the blocker is knowledge rather
   than code.** OR-15 is blocked on having real contacts with emails; OR-13 is blocked on
   knowing how people actually use the flow. Both are real blockers.
