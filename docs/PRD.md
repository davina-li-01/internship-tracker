# Orbit — Product Requirements

| | |
|---|---|
| **Epic** | Orbit — a networking tracker that keeps relationships from going cold |
| **Owner** | Davina Li |
| **Status** | v1 shipped · v2 scoped |
| **Target release** | v2 — TBD |
| **Last updated** | 2026-08-07 |

---

## Objective

Help students and early-career professionals stay in touch with the people they meet **on
purpose rather than by accident.**

Most people meet someone useful at an event, say "let's keep in touch," and never do. The
failure is not intent — it is that there is no system. Contacts scatter across LinkedIn,
phone contacts, notes apps and email; nothing tracks when you last spoke; nothing prompts
you before it becomes awkward; and the details that would make a follow-up feel personal
are forgotten within a week.

Existing tools fail at both ends. A CRM is built for sales pipelines and is far too heavy
for a personal network. A contacts app stores who someone *is* but nothing about the
relationship. Neither answers the only question that matters: **who should I reach out to
this week?**

Orbit answers exactly that. You log who you spoke to and what was said, choose how often
you want to reach out, and the dashboard shows you who is drifting before the relationship
goes cold.

*Keep your people in orbit.*

---

## Success metrics

The app is working if, after one month of real use:

| Goal | Metric |
|---|---|
| People commit to relationships deliberately | More than 50% of the network has a reach-out cadence set |
| Fewer relationships lapse | **Overdue count trends down while network size grows** — the single number that matters, because every other metric can be gamed by adding fewer people |
| Capture is fast enough to actually happen | Median time from meeting someone to logging them is under 2 days |
| The habit sticks | At least 3 conversations logged per week |
| The tool drives real action | More than 5 reach-outs per month initiated from Orbit |
| "Who do I contact?" is answerable at a glance | Under 10 seconds from opening the dashboard to naming a person |

---

## Assumptions

- The user has **20–150 professional contacts** — large enough to lose track of, small enough to care about individually.
- Networking matters to them for concrete outcomes: referrals, internships, mentorship.
- They have **no CRM experience and no appetite for one**. Any concept borrowed from sales software must be re-explained in plain language or dropped.
- They feel guilt about lapsed contacts but have no system to act on it. Orbit should convert that guilt into a short, specific list — not amplify it.
- **A declared cadence is a reasonable proxy for intent.** Someone willing to say "monthly" is signalling the relationship matters.
- The user will not log every interaction. The system must stay useful with partial data.
- Single-user. No shared or team-owned networks.
- Mobile-friendly web is sufficient; a native app is not required for v1 or v2.

---

## Milestones

| Milestone | Scope | Status |
|---|---|---|
| **M1 — Core product** | Auth, contacts, conversation logging, cadences, relationship health, dashboard, files, settings | ✅ Shipped |
| **M2 — Core loop polish** | Fix the two flows that undercut daily use: marking a reach-out complete, and confirming a logged conversation landed | 🔜 Next |
| **M3 — Intelligence** | Model-written talking points and thank-you drafts from real conversation notes | Planned |
| **M4 — Automation** | Google Calendar auto-logging and scheduled email reminders — both require server-side infrastructure, so build it once | Planned |
| **M5 — Hardening** | Two-factor authentication, idle-pause resilience | Planned |

---

## Requirements

**Importance** uses MoSCoW: Must have · Should have · Could have · Won't have (this release).
**Jira Issue** keys are placeholders to be linked once the epic is created.

### Shipped — M1

| Requirement | User Story | Importance | Jira Issue | Notes |
|---|---|---|---|---|
| Account and private data | As a user, I can create an account and sign in, so my network is private and persists across devices | Must have | ORB-1 | Supabase Auth. Row Level Security scopes every row to its owner — verified by confirming an anonymous request returns zero rows and 401 on writes |
| Log a conversation | As a user, I can log a conversation, and if I have met the person before their details fill in automatically, so all I write is what was said | Must have | ORB-2 | Name autocomplete disambiguates by role, company and recency. Appends to history; never creates a duplicate contact |
| Set a reach-out cadence | As a user, I can choose how often to reach out to someone, including a custom interval | Must have | ORB-3 | Weekly → quarterly, or any number of days |
| See relationship health | As a user, I can see who I am in touch with, who to reach out to soon, and who is overdue | Must have | ORB-4 | Status tiles, health ring, breakdown bar. Denominators count only people on a cadence |
| Prioritised reach-out list | As a user, I can see who to contact next, most overdue first | Must have | ORB-5 | "Reach out next" on the dashboard |
| Browse and filter the network | As a user, I can browse my network A–Z and filter it | Must have | ORB-6 | Filters: connection health, cadence type, industry, and time since last contact |
| Chronological conversation log | As a user, I can review every conversation, most recent first | Should have | ORB-7 | Grouped by month |
| Connection profile | As a user, I can see someone's full history, roles, companies and talking points | Must have | ORB-8 | Includes an editable "things to bring up next" checklist |
| Draft a message | As a user, I get a draft when someone is due, so I don't face a blank compose window | Should have | ORB-9 | Copy to clipboard, or hand off to the OS email client via `mailto:` |
| Documents | As a user, I can upload documents and link them to a person | Should have | ORB-10 | PDF page previews, in-app rename |
| Settings | As a user, I can manage my profile, password, notification frequency and theme | Should have | ORB-11 | Two-pane settings; nudge frequency defaults to once a day |
| Export | As a user, I can export my whole network as CSV, so I am not locked in | Should have | ORB-12 | Data controls |

**Quality bar met:** 137 automated tests · every page verified by rendering in a headless browser · owner-scoped RLS on every table · schema in version control.

### Backlog — M2 to M5

| Requirement | User Story | Importance | Jira Issue | Notes |
|---|---|---|---|---|
| Rework "mark as reached out" | As a user, I want recording that I reached out to be one obvious action, so the core loop is not the clumsiest part of the app | Must have | ORB-13 | **Open design problem.** You click **Reach out** — a future-tense label — to report something you already did, then click "I reached out" in a dialog. Two clicks and a modal for one gesture. Four options costed; decision deferred pending real usage. See Open Questions |
| Confirm a logged conversation landed | As a user, I want to see that my conversation was recorded, so I trust the app kept what I wrote | Must have | ORB-14 | **Data is correct; this is a display gap.** Neither page with a **+** button displays conversations, and the one page that does (Networking Log) has no **+** |
| Google Calendar auto-logging | As a user, I want conversations logged automatically from my calendar, so staying current does not depend on my memory | Should have | ORB-15 | ★ Highest leverage — removes the dependency on the habit that fails. Google Cloud project → OAuth consent → `calendar.events.readonly` → PKCE in-browser → match attendee emails → auto-log. Blocked on having real contacts with emails saved |
| Scheduled email reminders | As a user, I want a reminder to arrive when someone is overdue, so I don't have to open the app to find out | Should have | ORB-16 | Requires infrastructure that does not exist: a browser tab cannot send mail or wake up in seven days. Needs a Supabase Edge Function on cron plus an email provider. Same infrastructure as ORB-15 — sequence together |
| AI talking points | As a user, I want suggested talking points drawn from my notes, so my follow-up is specific rather than generic | Should have | ORB-17 | Best next feature: self-contained, no external auth, immediately visible. Must degrade to the current keyword heuristic if the model call fails |
| Thank-you draft from a conversation | As a user, I want a thank-you drafted from what I just wrote, so I can send it while it is fresh | Could have | ORB-18 | Distinct from the generic reconnect template. Same model integration as ORB-17 — one prompt path, two entry points |
| PDF notes on a conversation | As a user, I want to attach a PDF to a conversation, so handwritten notes and shared decks live with their context | Could have | ORB-19 | Mostly existing plumbing: `uploadFileToStorage()` already takes a contact id, and the profile form already accepts a PDF |
| Two-factor authentication | As a user, I want 2FA, so a stolen password is not enough to reach my network | Could have | ORB-20 | **Authenticator app (TOTP), not SMS.** TOTP is free on Supabase and works offline; SMS needs a paid provider and is weaker — SIM-swap is why guidance now prefers an app |
| Key people tier | As a user, I want to mark a subset as high-priority, so the most important relationships stand out | Could have | ORB-21 | Needs a `starred` column on `contacts` |
| Network health over time | As a user, I want to see whether my network is improving or decaying | Could have | ORB-22 | Requires historical snapshots — not currently stored |
| Idle-pause resilience | As a user, I want the app to work after not using it for a while | Could have | ORB-23 | Free-tier Supabase pauses after ~7 days idle, removing the project's DNS record. A red banner now explains it; the fragility remains. Options: scheduled ping, or accept and rely on the banner |
| Company logos on profiles | As a user, I want to recognise companies visually | Won't have | ORB-24 | Needs an external logo API on every render — a dependency for decoration. Deliberately skipped |

---

## Out of Scope

| Not building | Why |
|---|---|
| **A CRM** | No pipelines, deals, stages or forecasting. Sales concepts are the reason existing tools are unusable for a personal network |
| **A messaging client** | Orbit drafts; your email client sends. Sending mail means deliverability, spam handling and reputation management — a product of its own |
| **Anything collaborative** | One person's network, private to them. No sharing, no team accounts, no shared notes |
| **An address book** | Orbit tracks the *relationship*, not the person. It is not trying to replace phone contacts |
| **A social feed or discovery** | No public profiles, no suggested connections, no network graph browsing |
| **Native mobile apps** | Responsive web is sufficient for the target user and workload |
| **Account deletion in-app** | Deleting a Supabase user requires a service-role key, which cannot safely live in a browser. Documented as a dashboard action rather than faked with a button that cannot work |

---

## Design

### Core concept: relationship health

The idea the whole product rests on. Every connection you commit to gets a cadence.
Health is how much of the current window is left:

```
health = (1 − days_since_last_contact / cadence_days) × 100
```

| Band | Meaning |
|---|---|
| **In touch** | 60% or more of the window remains |
| **Reach out soon** | Under 60% remains, or you owe a first reach-out |
| **Overdue** | The deadline has passed |

### Four rules that are load-bearing

1. **Overdue means genuinely past due**, never merely a low percentage. Someone 80 days into a 90-day cadence sits at 11% but still has 10 days left — labelling that "Overdue" would contradict the countdown displayed beside it. Enforced by a test asserting `band === "critical"` if and only if `daysLeft < 0`, across cadences from 7 to 200 days.

2. **Connections without a cadence are not measured.** They are not unhealthy; they are simply not being tracked. Dashboard denominators count only people on a cadence, so "1 of 3" means "one of the three I chose to keep up with." The point is deliberate choice, not guilt about everyone you have ever met.

3. **A new cadence grants a one-week grace window.** Committing to reconnect with someone you last spoke to months ago should not paint the dashboard red for work you have just decided to do. You get seven days to make the first contact.

4. **A grace window is never "In touch".** It stays on the "Reach out next" list until you confirm you actually reached out. The first version of this rule made people *disappear* from the list the moment you committed to contacting them — the exact opposite of the intent. Granting time to act is not the same as marking it done.

### Interaction principles

- **Labels must agree with the data beside them.** Where a label and a number describe the same thing, one derives from the other so they cannot diverge.
- **Failures are visible in the UI, not the console.** An unreachable backend or missing table shows a banner rather than rendering a plausible-looking empty page.
- **Never offer to create something a page will never display** — the defect behind ORB-14.
- **Avoid the word "tracking"** in user-facing copy. The vocabulary is "reach out again?", "in touch", "no schedule".

### Visual system

Warm sand and orange, light and dark. Status colours are a fixed palette
(good `#0ca30c`, warning `#fab219`, critical `#d03b3b`) and every status element carries an
**icon and a text label as well as colour** — the amber measures 1.75:1 against the light
surface, so colour alone would not be readable.

Charts follow one rule: rings are meters showing a single ratio; part-to-whole uses a
stacked bar, never a pie.

---

## Open questions

| Question | Answer | Date Answered |
|---|---|---|
| When marking a reach-out complete, do users usually have notes worth capturing, or do they just want the row gone? Determines whether ORB-13 becomes one-click-done or opens the conversation logger | | |
| Is a fixed cadence the right model at all? Some relationships are naturally seasonal. Should cadence adapt to observed behaviour instead of being declared up front? | | |
| Is seven days the right grace window? It is currently a guess | | |
| Should Orbit ever *suggest* who to add — people you emailed but never logged — or does that feel invasive? | | |
| How does the experience hold up at 500 contacts? Every design decision so far assumes 20–150 | | |
| Is CSV export enough of a portability story, or do users expect direct import into another tool? | | |

---

## Reference Links

| Resource | Link |
|---|---|
| Live app (GitHub Pages) | https://davina-li-01.github.io/orbit/ |
| Live app (Vercel mirror) | https://internship-tracker-sigma.vercel.app/ |
| Repository | https://github.com/davina-li-01/orbit |
| Engineering roadmap | `ROADMAP.md` |
| Build retrospective | `docs/LEARNINGS.md` |
| Database schema | `supabase/schema.sql` |
| Row Level Security policies | `supabase/fix-rls.sql` |
| Storage bucket policies | `supabase/storage-policies.sql` |
