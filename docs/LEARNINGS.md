# Building Orbit — What I Learned

*A reflection on rebuilding my internship tracker into a focused networking tool.*

---

## What I built

I started with **InternTrack**: a tool that tracked internships, daily work logs, weekly
manager update emails, resume bullet points, uploaded files, a calendar, and networking
contacts. Seven features in one app.

I finished with **Orbit**: a networking tracker that does one thing. You log the people
you meet and the conversations you have with them, choose how often you want to stay in
touch, and the dashboard tells you who you are drifting away from.

| | Before | After |
|---|---|---|
| Features | 7 loosely related | 1, deeply built |
| `main.js` | 2,503 lines | ~2,100 lines, all networking |
| CSS | 114 KB | 91 KB (24 KB of dead styles removed) |
| Database tables | 7 (3 unused) | 3, all used |
| Automated tests | 0 | 137 |

---

## The decision that mattered most: doing less

The first version had a Workspace tab with daily logs, a weekly manager email generator,
and an AI resume-point widget. None of it was bad. It was just that I never used most of
it, and every screen was crowded because it was trying to serve seven jobs at once.

Cutting it down to networking made every remaining screen better. Not because I improved
them individually, but because each one finally had room to be about one thing.

**What I would tell myself at the start:** build one feature until it is genuinely good
before adding a second. A half-built feature is not "progress toward" a good one — it is
clutter that makes the good one harder to find.

---

## Technical lessons

### 1. Row Level Security was the only thing protecting my data — and it was switched off

My database had a policy on three tables called `"Allow all (dev)"`:

```sql
for all to public using (true) with check (true)
```

`to public` means every role, including anonymous. `using (true)` means no row is ever
filtered out. Together, that let **anyone holding my API key read, edit, or delete every
row**. And that key ships inside `js/supabase.js`, which is served publicly from GitHub
Pages. It was never a secret and was never meant to be.

I had assumed the key was the security boundary. It is not. **The key identifies the
app; RLS decides what the app is allowed to see.** With RLS effectively off, the public
key was a skeleton key to my whole database.

The proof was uncomfortable: signed in as myself, I could see another test user's
contacts. After replacing the policies with owner-scoped ones, each user sees only their
own rows and an anonymous request gets nothing — verified by hitting the API with just
the public key and getting back zero rows and a 401 on writes.

**Lesson:** for anything client-side, write the security rule *first* and treat a
permissive dev policy as a bug you have already shipped, not a to-do.

### 2. A "public" storage bucket does not mean you can upload to it

File uploads failed silently for a while. The bucket was marked **public**, so I assumed
it was open. It wasn't:

- **Public** governs *reading* an object from its URL.
- **Uploading** is an `INSERT` into `storage.objects`, which has Row Level Security on.

My bucket had **zero policies**, so RLS denied every write by default. The dashboard even
showed `POLICIES: 0` next to the bucket — I just did not know that number mattered.

**Lesson:** two words that sound like one setting ("public", "policies") can control
completely different things. When something fails silently, find the specific mechanism
rather than the plausible-sounding one.

### 3. My code and my database had quietly drifted apart

`js/db.js` had read and write functions for a `files` table that **did not exist**. It
also wrote a `starred` column that had been deleted, and read an `industry` column that
had never been created. None of this produced a visible error — the app just silently
did less than it appeared to.

The root cause: **the database schema existed only inside the Supabase dashboard.** There
was no copy in the repository, so there was nothing to compare the code against, and
nothing to rebuild from if the project were lost.

Now `supabase/migrations/001_schema.sql` lives in version control alongside the code that depends on it.

**Lesson:** if part of your system's definition lives only in someone else's web UI, you
do not actually have a backup, and you have no way to catch drift.

### 4. A successful build is not a successful deploy

My GitHub Pages site served a three-month-old version of the app for weeks. The
deployment history showed why:

```
build   → success     (Jekyll compiled the site fine)
deploy  → failure     (GitHub could not publish the result)
```

I had been checking whether the build passed. The build was never the problem. Renaming
the repository had broken the deployment target, and the two steps fail independently.

It got worse: because I kept toggling settings, each new build cancelled the previous
one, so I never got a clean result to read. The fix was to change nothing and push once.

**Lesson:** when a pipeline has stages, find out *which stage* failed before theorising.
And do not retry so fast that you destroy the evidence.

### 5. Verify by rendering, not by reading

This changed how I work more than anything else on the list.

Three bugs made it past careful code review and were caught in seconds by taking a
screenshot of the actual page:

- **A container with no CSS rule at all.** `#dashboardContent` wrapped three sections and
  had no styling, so they stacked flush against each other with zero gap. I had adjusted
  padding on the children repeatedly without fixing it, because the problem was in
  something I had never thought to style.
- **A status label contradicting the number beside it.** A contact showed **"Overdue"**
  and **"10 days left"** at the same time.
- **A stray dot on an empty chart.** A ring at 0% still painted a mark, because a rounded
  line cap renders even when the arc has zero length.

None of these were logic errors I could have reasoned my way to. They were things you can
only see.

**Lesson:** for anything visual, "I read the code and it looks right" is not verification.
Render it and look.

### 6. A label and its data must never disagree

The "Overdue / 10 days left" bug had a real cause. I was computing status from a
*percentage*: below 25% remaining meant overdue. But an 80-day-old contact on a 90-day
cadence is at 11% and still has **10 days left**. The percentage was low; the deadline had
not passed.

I redefined it so overdue means the deadline actually passed, and wrote a test asserting
that `band === "critical"` if and only if `daysLeft < 0` — across cadences from 7 to 200
days. Now the two cannot disagree, by construction.

**Lesson:** when a label and a number sit next to each other, make one derive from the
other. Two independent calculations of "the same thing" will eventually diverge.

### 7. Automated cleanup needs a safety net

Removing dead CSS, I wrote a script to find class names that appeared in the stylesheet
but nowhere else. It flagged 319 of 526 classes — including `chip-good` and
`chip-critical`, which are **built at runtime** as `'chip-' + band`. A naive sweep would
have silently broken every status colour in the app.

I rewrote it to also check hyphen-prefixes, only delete rules where *every* selector was
dead, and then verified two ways: assert that every class still used retains at least one
rule, and confirm screenshots before and after are byte-identical.

**Lesson:** the danger of an automated cleanup is not the code it removes — it is the code
it *thinks* is unused. Give yourself a check that would catch you being wrong.

---

## Process lessons

### Reproduce before fixing

When my app broke completely, my first instinct was to look for a bug in my code. There
wasn't one. The Supabase project had been paused for inactivity — which removes its DNS
record entirely, so nothing resolved.

Then, once restored, it still failed: the project had migrated to a new API key format
and my old key had silently stopped working. Because the API filters what it returns
based on what your key can access, a dead key looks *exactly* like an empty database.

**Two unrelated problems stacked on top of each other, neither producing a useful error.**
I spent time debugging code that was never broken.

That is why `js/db.js` now shows a red banner when the backend is unreachable or a table
is missing, instead of quietly rendering an empty page. The failure was always visible in
the console — but nobody reads the console when the page looks merely *empty* rather than
*broken*.

**Lesson:** make failures loud. An app that fails silently costs more than one that
crashes honestly.

### Tests are how you stop re-deciding things

I did not write tests for coverage. I wrote them to lock in decisions that were hard to
get right, so I could not accidentally undo them later:

- Overdue means the deadline passed, never just a low percentage
- Logging a conversation against an existing person never creates a duplicate
- Back-dating an old conversation does not pretend you spoke yesterday
- A grace window is granted once and never re-granted on save

Each one encodes a judgment call. When I changed the health model later, the tests told me
immediately which behaviours I had altered — including one I had not intended to.

### Ask what a number actually means

My dashboard showed **"In touch: 0/0"**. Technically correct, completely useless.

The denominator was "people with a check-in schedule", and I had none. The right question
was not "is this computed correctly" but **"what is this number for?"** Later, once I had
three people on cadences, the answer changed again — dividing by my whole network mixed in
people who were never scheduled and therefore could not be "in touch" or "overdue".

**Lesson:** a metric that is arithmetically right can still be meaningless. Say the
sentence out loud: "1 out of 3 people I chose to keep up with are current." If that
sentence is not useful, the metric is wrong regardless of the maths.

### Design intent has to survive contact with the flow

I built a one-week grace window: put someone on a cadence after months of silence and you
get seven days to make the first contact, instead of being marked overdue instantly.

It worked — and it was wrong. Because the grace made them read as healthy, they
*disappeared* from the "Reach out next" list the moment I committed to contacting them.
The exact opposite of the intent.

**Lesson:** shipping the mechanism is not the same as shipping the outcome. Ask where the
change *surfaces*, not just whether it computes.

---

## What I would do differently

1. **Write the security rule before the feature.** A permissive dev policy is a shipped
   vulnerability, not a to-do.
2. **Keep the schema in the repo from day one.** It costs nothing until the day it is the
   only copy you have.
3. **Screenshot the page as part of building it**, not as a final check.
4. **Build one thing well.** Six half-features are worse than one good one — not just for
   users, but for me, because they make the codebase harder to change.
5. **Make errors visible in the UI.** A console message is invisible to the person who
   most needs to see it: me, three months later.

---

## Where it stands

Orbit works end to end: authentication, contacts, conversation logging, cadences with
health tracking, file storage with previews, and a settings system — with 137 automated
tests and a properly secured database.

The most interesting problem left is not technical. To record that you reached out, you
currently click a button labelled **"Reach out"**, which opens a dialog, where you click
**"I reached out"**. The label describes something you are about to do, but you are
reporting something you already did — two clicks and a dialog for what should be one
gesture.

I have written down four possible directions and deliberately not chosen one, because
which is right depends on something I do not know yet: whether people usually have notes
worth capturing, or just want the row to go away. That is a question a week of real use
will answer and no amount of speculation will.

Which is maybe the last lesson: **knowing which decisions to defer is as useful as knowing
how to make them.**
