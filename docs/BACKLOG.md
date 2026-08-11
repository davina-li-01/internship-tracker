# Orbit — backlog additions for Confluence

Work done or specced that is **not yet in the Confluence Requirements table**.
Same columns as `docs/PRD.md`, so the rows below paste straight in.

**Importance** uses MoSCoW: Must have · Should have · Could have · Won't have.
**Jira Issue** keys are provisional — see *Numbering* at the bottom before pasting.

Last updated 2026-08-10.

---

## Shipped

| Requirement | User Story | Importance | Jira Issue | Notes |
|---|---|---|---|---|
| Several addresses per person | As a user, I can save someone's work, personal and school addresses, so an invite sent to any of them still matches them | Must have | ORB-29 | `contacts.emails` jsonb; `contacts.email` stays as the primary so mailto, search and the capture form keep working. Calendar matching now checks every address — matching only the primary missed invites silently, which looks identical to "no meetings found". Migration: `add-contact-emails.sql` |
| Contact profile reads before it edits | As a user, I can read someone's details without a screen of input boxes, and edit them only when I choose to | Should have | ORB-30 | Modelled on Apple Contacts. Same grid in both modes so nothing moves when switching. An always-editable form makes a record you mostly read look like a form you must fill in, and turns a stray keystroke into an edit of real data |
| Fields save when you leave them | As a user, I can type an address or a past company and move on, without hunting for a save button | Should have | ORB-31 | `change`, not `blur`, so tabbing through a form you only read does not write. Does not re-render — rebuilding the form under a live caret loses whatever else is half-typed. Found and fixed a bug underneath: the primary address could never be deleted |
| "Coming up" holds its height | As a user, I can have a full week of meetings without the dashboard row stretching to fit them | Should have | ORB-32 | The card was 735px with five meetings and dragged the health ring and breakdown with it. `max-height` on the list plus a count and a fade, so a fixed-height list does not hide things silently |
| A meeting is over when it ends | As a user, I am asked how a conversation went only after it has actually happened | Must have | ORB-33 | "Happened" was decided on the date, so a 4pm coffee looked loggable from breakfast — Orbit asked how it went while the same meeting sat under "Coming up". Boundary is the clock now. A meeting that ended within 24h opens the log dialog directly; older ones get a dismissible toast |
| Digest arrives in the reader's morning | As a user, I receive the reminder digest at 9am my time, not at 2:30am | Should have | ORB-38 | pg_cron is UTC-only, so one daily fire suited one timezone. Cron runs hourly; the function picks whose turn it is from `preferences.timezone`. Also fixed a quieter bug: "who is overdue" is a date comparison taken from UTC, so east of Greenwich a contact due today was not found at all. Migration: `add-timezone.sql` |
| Connection follows the account | As a user, my Google Calendar connection works on any device I sign in on, and "last synced" means what it says | Should have | ORB-39 | Connection state lived in localStorage, so it was a property of the browser. `preferences.integrations` jsonb is the durable copy; localStorage stays as the synchronous one the pre-paint script needs. Re-auth state is deliberately per-device. Migration: `add-integrations.sql` |
| Survive the free-tier idle pause | As a user, I can come back after two weeks away and find Orbit working | Should have | ORB-23 | *Already ORB-23 in the PRD — status change only, from "options" to done.* A ping from pg_cron cannot work: it pauses with the project. A GitHub Actions workflow pings daily from outside. Protects the digest too, since the reminder job is also pg_cron |

## Specced, not built

| Requirement | User Story | Importance | Jira Issue | Notes |
|---|---|---|---|---|
| Match calendar events by name | As a user, I want an in-person coffee logged even when there was no calendar invite to match on | Should have | ORB-37 | Matching is email-only today, so *"Coffee — Assaf"* with no attendees is invisible. Cannot auto-log: a name is not unique, and a wrong match rolls someone's cadence forward, making a drifting relationship look healthy — the exact failure Orbit exists to prevent. Depends on an alias field per contact, a confidence level on interactions, and sticky "not this person" answers |
| Audio transcription | *Davina is writing this* | Must have | ORB-18? | Deferred 2026-08-10. Needs a decision first: transcribe a voice memo recorded **after** a conversation, or a live one **during** it. Different products, different privacy stories, different costs |

---

## ⚠️ Numbering — please resolve before pasting

Three conflicts, none of which I should settle on my own:

**1. `docs/PRD.md` is one position behind the Confluence roadmap from ORB-18 on.**

| Key | PRD.md says | Confluence roadmap says |
|---|---|---|
| ORB-18 | Thank-you draft | Audio transcription |
| ORB-19 | PDF notes | Thank-you draft |
| ORB-20 | Two-factor auth | PDF attached to conversation |
| ORB-21 | Key people tier | Two-factor auth |
| ORB-23 | Idle-pause resilience | Network health over time |
| ORB-24 | Company logos (won't have) | Idle-pause resilience |

`PRD.md` looks like an export from before the realignment on 2026-08-08. **Confluence
is the source of truth**, so PRD.md is probably the file to correct — but that is
your call, and I have not touched it.

**2. ORB-27 is used twice** in `ROADMAP.md`: "Photos as attachments" and "Revisit
email reminder logic". One of them needs a different key.

**3. ORB-29 to ORB-33, and ORB-37 to ORB-39, are keys I invented** so the
engineering notes had something to hang on. They are not from Confluence. Once Jira
assigns real ones, tell me and I will renumber `ROADMAP.md` and this file to match
rather than letting the two drift apart.
