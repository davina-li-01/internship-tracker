# Orbit — Confluence reconciliation log

Confluence is the source of truth. This file is the staging copy and the record of
what was reconciled, so when the two disagree the **live page wins**.

Since 2026-08-10 the pages are written directly through the Atlassian MCP server
rather than pasted by hand, so this file no longer needs to be a transcript of
what to copy.

Pages: **Customer Experience EPIC**, **Backlog**, **Roadmap Q3 2026** — all in the
`PM` space.

---

## Writing the Roadmap: the Team column round-trip trap

**Declare `color` before `background-color`, always.** Confluence's HTML→ADF
conversion overwrites the text colour to match the background when
`background-color` comes first — the Team names go invisible against their own
highlight.

The trap is that Confluence **re-serialises to background-first on read**. So
fetching the page and writing it back verbatim destroys the column, even though
nothing was edited. It happened on Aug 10 and again on Aug 12, the second time
while fixing something unrelated: 49 of 50 cells went unreadable. The one that
survived was a row authored fresh with the correct order.

Correct form:

```html
<span style="color: #000000"><span style="background-color: #dfd8fd">Core Functionality</span></span>
```

`#dfd8fd` is Core Functionality, `#c6edfb` is Integrations.

---

## Editing Confluence: use `scripts/confluence.py`, not the MCP

**Superseded by tooling, 13 Aug.** Both traps below were symptoms of the same
thing: writes went through the MCP as HTML or markdown, which meant a conversion
step that could silently mangle the page, and the whole document had to pass
through the model as text — about 35,000 tokens to change one cell.

`scripts/confluence.py` does the same full-document `PUT` — Confluence has no
partial-update endpoint, in the REST API or the MCP — but the bytes stay on
disk. A one-cell edit costs a few hundred tokens instead of tens of thousands.

**It works in ADF, which removes both traps rather than avoiding them:**

- **No conversion step.** The markdown table-break below cannot happen; JSON has
  nothing to misparse.
- **No Team-column order trap.** In ADF the colours are two independent marks on
  a text node, so "declare `color` before `background-color`" is meaningless —
  there is no HTML serialisation to get backwards.
- **Concurrent edits 409 instead of overwriting**, because the version read is
  the version incremented.

Credentials come from `~/.netrc` via `curl -n`, so no token appears in a
command, in shell history, or in this repo. Homebrew's Python has no CA bundle,
which is why the transport shells out to `curl` rather than using `urllib`.

```
python3 scripts/confluence.py rows 1343550           # list ticket rows
python3 scripts/confluence.py cell 1343550 ORB-74 4  # read one cell
python3 scripts/confluence.py get  1343550           # fetch to /tmp
python3 scripts/confluence.py put  1343550 FILE -m "why"
```

Page ids: Backlog `1343550`, Roadmap `1147139`, ORB-73 PRD `6520834`.

**Still verify after every write.** The tooling removes the conversion faults,
not the possibility of a bad patch — and a `200` has already been shown twice to
mean nothing about whether the page is intact.

---

## Writing the Backlog: never send markdown, send HTML

**Write Confluence tables as `contentFormat: "html"`.** Markdown is converted on
the way in, and a cell containing a literal `\n` inside a backtick span ends the
row there — everything after it, including all the rows that followed, is dumped
after `</table>` as one paragraph of raw pipe syntax.

That is what happened to the Backlog on Aug 13. ORB-66's cell held
``​`title + "\n\n" + notes`​``; the row broke at the `\n`, and ORB-66 through
ORB-73 spilled out of the table. It survived a write because the response was
`200` and the version number incremented — the page reported success and was
visibly wrong. Found the next time the page was fetched, and repaired in v24.

**Two rules that follow:**

- **HTML in, always.** Then a `\n`, a quote or a `**` inside a code span is just
  text. Confluence re-encodes `"` to `&quot;` and may lift a `<code>` out of a
  `<strong>` on read; both are cosmetic and neither loses content.
- **Verify by comparing visible text, not markup.** A byte diff against what you
  sent is all false positives — entity encoding and tag nesting both change on
  the round trip. Strip tags, unescape, compare cell by cell. That check is what
  proved the v24 repair lost nothing, and a markup diff could not have.

Always verify after any Roadmap write — a full-body replacement is the only
update the API offers, so every write puts all 50 cells at risk:

```
readable = the two hex values in a Team cell differ
```

Also check the Roadmap Planner macro survived: 22 bars, and the hash
`716d1f1e…4e9a6d4` still present in `data-parameters`.

---

## The Dependencies column

The fifth column is **Dependencies**, not Notes. It leads with what had to exist
first — other ORB tickets, new columns or tables, constraints another ticket
imposes on the design — and then carries a short account of what shipped and why.

That second half is deliberate (ruled 2026-08-11). A stricter version was written,
which cut every cell to bare prerequisites and moved the design detail into
`ROADMAP.md`; it was rejected because the Backlog has to stay readable to someone
with no access to this repo.

---

## ORB-78 and ORB-79 — the prompt says who and how long, shipped Aug 19

The two highest-scoring tickets on the board (RICE **720** and **567**) and the
two cheapest. Both are copy and display on surfaces that already existed; no
schema, no new page, no migration.

### What the survey actually said

Survey 1 asked five people what prompted the last message they sent a
professional contact. **Three of five** answered some version of *"it had been a
while and I felt bad about it."* **One** was moved by a reminder they had set.

That one is the mechanism Orbit shipped. The app was reproducing the stimulus
that worked for a fifth of respondents and none of the one that worked for
three-fifths.

The answer that won fuses three things — **elapsed time, a named person, and the
feeling between them**. Orbit had the first two in bureaucratic form, *Reach out
soon · 14 days left*, and none of the third. A countdown is a fact about a
schedule. *You last spoke to Marcus 4 months ago* is a fact about a person.

### ORB-78 — what changed

One renderer, `reachOutPromptHtml`, used by all three surfaces that propose a
reach-out, so the wording cannot drift between them:

| Surface | Was | Is |
|---|---|---|
| Reach out next row | Last connected 4 months ago · Every month | You last spoke to Marcus 4 months ago. + their own words |
| Section subtitle | People on a schedule who are drifting — most overdue first | Longest since you spoke, first |
| Profile strip | **Last connected** / 4 months ago | the sentence, plus the last conversation |
| Draft modal | Every month · Next: 12 Sep | the sentence, then the cadence demoted to fine print |

**The echo is the part worth keeping.** What you actually said last time is a
stronger prompt than any status the app can compute, because it makes the person
concrete again. Marks are stripped and it clips at 120 characters — this is a
reminder of a conversation, not a place to read one.

**Three things were deliberately NOT done.** The health bar keeps its countdown,
because the band still drives colour, ordering and the dashboard counts and the
deadline is the one fact the sentence does not carry. My Network keeps *Last
connected · Every month*, because a directory is not asking for anything and a
sentence addressed to the reader repeated down an alphabetical list is noise.
And a never-contacted person gets *You met Priya 3 months ago and have not spoken
since* — never *You last spoke*, which would be a claim the data cannot support.
That last one is **ORB-75's rule applied again**, and it is asserted both ways,
including the ORB-64 case where a deleted conversation leaves an empty array
behind a real date.

### ORB-79 — the other half of the feeling

Guilt starts the action and then blocks it. The same feeling producing *I should
message her* produces *it would be weird now*. Survey 1 shows both halves: three
acted on the feeling, and the stated blockers were *just forgot*, *got lazy*,
*procrastination*.

**The blocking half is not a preference to respect. It is factually wrong.** Liu
et al. — 13 preregistered experiments, ~6,000 participants — find people
underestimate how much an out-of-the-blue message is appreciated, and that the
underestimate **grows** with surprise and social distance. Flynn and Lake find
people agree to requests roughly three times more often than the asker predicts.

So the line is written as a correction, not as reassurance:

> It has been 4 months — long enough that reaching out feels awkward. It is not:
> people consistently underestimate how welcome an out-of-the-blue message is,
> and the longer the gap the more that holds.

It fires only past **60 days** and only in the draft modal. Both limits are the
point. Nobody agonises over a fortnight, and a correction shown on every surface
every time is wallpaper rather than an argument. This completes **ORB-75**, which
removed the accusation without putting anything in its place.

### The escaping boundary, restated

`lastSpokeSentence` returns **plain text** and is escaped by the renderer. It
originally escaped the name inside itself, which would have returned
half-escaped HTML — a trap for whoever called it next. There is a test asserting
the raw sentence still contains `<b>Marcus</b>` unescaped, which reads oddly
until you understand it is guarding the boundary rather than the output.

The echo also puts **other people's pasted words on a new surface**, which is the
case ORB-63 was careful about. Marks are stripped rather than rendered, and both
the name and the notes are tested with live payloads.

**81 new assertions; 1188 across 34 suites.** The profile and the modal are
rendered for real rather than asserted through the helper, because "three
surfaces share one renderer" is the claim worth guarding and testing the helper
alone would not have caught a surface that stopped calling it.

| Requirement | User Story | Importance | Jira Issue | Dependencies |
|---|---|---|---|---|
| Say how long it has been, and to whom | As a user, I want to be told when I last spoke to someone rather than that a timer expired, so the prompt produces the feeling that actually makes me reach out | Must have | ORB-78 | Display only. Reuses **ORB-75**'s never-contacted vocabulary rather than inventing a second set, and **constrains ORB-54**, which is briefed to reframe "overdue" for dormant ties and must change this shared renderer rather than adding a fourth variant. **ORB-90** will hang its stated reason off the same line |
| Tell them the gap is an asset, not a debt | As a user hesitating over a long silence, I want to know the gap makes my message land better rather than worse, so the feeling that got me here does not also stop me | Must have | ORB-79 | Depends on **ORB-78** for the elapsed-time vocabulary it quotes. Completes **ORB-75**. One line, one surface, one threshold — deliberately not shown wherever a reach-out is mentioned |

---

## ORB-80 — show what has accumulated, shipped Aug 19

RICE **189**. Rides on **ORB-78**'s renderer, so it shipped the same day for a
third line of code.

**Survey 1 asked what people would lose if their system vanished.** The two
highest-volume respondents answered **"Cooked"** and **"Everything"**. The one
relying on memory answered *"not much — I think I rely too heavily on memory."*

Value scales with what is recorded. That is a good property for a product to
have and a useless one if it is invisible at the only moment it would change a
decision — which is the reach-out prompt, because the prompt is also the screen
carrying **Remove schedule**. The ledger and the button that abandons the
relationship are now on the same surface, deliberately.

The prompt is three lines in the order the decision is made:

> **You last spoke to Marcus 4 months ago.**
> 6 conversations over 2 years · 3 files
> *"Talked about her move to the payments team."*

**Four judgement calls.**

- **Zero shows nothing.** A prompt opening *"0 conversations"* tells someone
  their network is empty at the exact moment it is asking them to act on it.
- **A span under a week is dropped.** *"3 conversations over 4 days"* is a burst,
  not accumulation, and it undersells a relationship the count described better
  alone.
- **Span is measured across the conversations**, not from `dateMet`. "6
  conversations over 2 years" is a claim about a relationship; the date you
  happened to meet is not evidence for it.
- **Attachments are counted, which the ticket did not ask for.** A PDF is the
  answer to "what would you lose" in a way a row in a table is not, and the same
  reduce already ran in `conversationPreview`. Flagging it as a scope addition
  rather than burying it.

One assertion documents something worth knowing: there is no such thing as an
undated conversation once saved, because `normalizeInteraction` dates a blank as
today. The empty-date guard exists for callers holding raw rows and is tested
directly rather than through the model, so the test does not quietly assert a
thing the model already prevents.

19 new assertions; **1207 across 34 suites.**

| Requirement | User Story | Importance | Jira Issue | Dependencies |
|---|---|---|---|---|
| Show what has accumulated when prompting | As a user deciding whether to reach out, I want to see what I already have with this person, so the value of the relationship is visible at the moment I might abandon it | Should have | ORB-80 | Depends on **ORB-78** for the shared prompt renderer — it is one line inside it, not a fourth surface. Reads existing data; no schema. **ORB-90** adds a stated reason to the same block and should extend this renderer rather than adding another |

---

## ORB-57 — two metrics restated against the star, Aug 19

Half the metric set was written in terms of tiers, and **ORB-94** deletes the
tier picker. Nothing would have errored; the numbers would just have gone flat
six days before **ORB-76** re-reads them.

| Goal | Was | Is |
|---|---|---|
| People commit to relationships deliberately | 30%+ of contacts sit in a tier the user **changed from the default** | **A user stars at least one person in their first week** |
| Fewer relationships lapse | **Inner-circle** contacts past their cadence trends down while network size grows | **Starred** contacts past their cadence trends down while network size grows |

**The threshold moved with the control, on purpose.** The old metric measured
*deviation from a default* — every contact already had a tier, so changing one
was the signal. A star starts from nothing, and a realistic user stars maybe five
people out of forty. "30% starred" would have been a far harder bar reworded, not
the same bar. Stated as reach rather than share, it tests the same belief —
people know who matters and will say so — without a percentage neither the survey
nor the literature supports.

Metric 2 is a straight substitution and arguably truer: an inner circle was a
bucket you were sorted into, a star is a person you chose. The dormant-tie carve-
out survives unchanged — a distant contact untouched for a year is an opportunity
(**ORB-54**), not a lapse.

**Downstream catch, same class as the one ORB-57 found last time.** The PRD's
field table said the `tier` column *"counts toward ORB-57's changed-from-default
metric"*. It no longer counts toward anything. Fixed on page 6520834; the column
itself stays, because ORB-86 may revive tiers as a suggestion.

The two metrics that were already trigger-based — 2+ reconnections a month, and
over half of reach-outs carrying a trigger — are untouched. Those are the direct
test of **ORB-90/91/92** and had nothing to do with tiers.

---

## Survey re-read at n = 9 — one finding reversed, Aug 19

Four more responses on the **same instrument**, so this supersedes the n = 5
reading rather than sitting beside it. Confluence page 10256385 restated with
old figures shown beside new ones.

### The correction that matters

**"Only 1 in 5 acted on a reminder they set themselves" is wrong.** At n = 9 it
is **3 of 9**, tied with guilt at 3 of 9. That sentence went into the
justification for **ORB-90, ORB-91 and ORB-92** and into their commit messages.

The tickets are still right, for a reason that survives the correction: a
trigger and a timer are not competing, and ORB-92 **demotes** the clock to a
fallback rather than removing it. But the evidence is **an even split, not a
rout**, and the way it was written overstates it. Guilt remains joint-first, so
**ORB-79** is untouched.

### What strengthened

| | n = 5 | n = 9 |
|---|---|---|
| Realised outside any tool | 5 of 5 | **8 of 9** — 4 lying awake |
| Recruiting-weighted outreach | 3 of 5 | **6 of 9** |
| Cannot say who matters at first contact | 3 of 5 | **6 of 9** |
| Self-rated system quality | — | **median 2/5; 8 of 9 rate ≤ 3** |

**Retrieval is now the confirmed pain, and one respondent named the mechanism
outright** — asked what stopped them messaging someone: *"I didn't want to look
up our old conversation to see when the last time we spoke was. Procrastination
got in the way."* That is precisely the friction **ORB-78** and **ORB-80** remove
by putting the elapsed time and the last exchange into the prompt. Unprompted
confirmation of two tickets shipped hours earlier.

### What it says about decisions already made

- **ORB-93's star is more justified, not less.** The split went from two-way to
  four-way: 3 know at first contact, 2 after two or three conversations, 2 after
  months, 2 only in hindsight. **Six of nine cannot answer** the question the
  tier picker asked.
- **Deferring ORB-83 is right on the numbers.** **8 of 9 already knew the
  recruiting timeline** by sophomore year. The addressable population is one
  respondent in nine — arrived at independently, and this is the figure that
  justifies it.
- **The primary persona is under-specified at the top end.** Median contacts
  moved to 26–50 and a third have 50+.

### Two gaps closed, two did not

First-gen went 0 → 2, juniors 0 → 1. **And first-gen is not a proxy for
beginner**, which the personas quietly assumed: R6 is first-generation and the
**only respondent with a working system** — a CRM, self-rated 5/5, the highest
score on the page.

Still missing after two rounds: **first-years and anyone with about four
contacts.** The entire secondary persona. Two rounds failing to reach them is a
recruiting problem with the instrument, not bad luck.

Interview pool 3 → 5: **Adith Kannan** (50+ contacts, no system, *"not too much,
just contact details, not names"* — the clearest statement on the page that
contact details are not the valuable part) and **Kaavya Chandrasekhar** (chose a
dedicated tool and still rated it 2, which makes her the most useful interview
on the list).

---

## ORB-76 read, and two defects it exposed (ORB-96, ORB-97) — Aug 19

Read **eight days early**. Eleven tickets shipped on the 19th and the app changed
underneath the experiment; reading on the 27th would have measured a different
product against a 13 August baseline.

| Metric | 13 Aug | 19 Aug | |
|---|---|---|---|
| 1. No conversation logged | 1 of 8 — 12.5% | **4 of 13 — 30.8%** | **up, as predicted** |
| 2. First conversation on creation day | 3 of 7 — 42.9% | 5 of 9 — 55.6% | up — *metric retired* |
| 3. Added on the account's first day | 1 | 1 | **cannot move** |

### ORB-73 worked

Five contacts added since the baseline, **three with no conversation** — a state
that was impossible before ORB-73, because the only way to create a contact also
logged one. The other two came through the conversation logger, which is the
ORB-74 chooser doing exactly what it was designed to do. **Both paths are in
use.**

### Metric 2 is retired, not failed

It went the wrong way, and the metric is at fault rather than the build. It asks
*is a conversation invented on the day the contact is created?* and cannot
separate:

- **invented** — you added a person, the app fabricated a conversation
- **real** — you had coffee with someone new and logged it that day

After ORB-73 the first is **structurally impossible**: the add path writes
`interactions: []` and an empty `lastContacted`. So every remaining hit is the
second kind, and the metric can only rise as the app is used normally. **The
ORB-57 mistake in reverse** — not a metric that cannot fail, but one that cannot
succeed. Nothing replaces it; metric 1 answers the same question from the side
that still carries information.

### Metric 3 was never able to move

It counts contacts created on the account's **earliest** day. That day is in the
past and does not change, so on a single existing account the number is a
constant. The 13 Aug risk note said "almost no room to move" — too generous.

Worth keeping as a class of error: **a metric anchored to a fixed point in the
past cannot measure a change made after it.** It was written before the account
existed, when the first day was still ahead.

### Decision: bulk paste is dropped

ORB-76 required it be scheduled or dropped **with a reason**. Dropped.

1. **The evidence it would rest on cannot exist.** Metric 3 is the only
   instrument pointed at bulk-entry pain and it is a constant.
2. **Per-person entry is not visibly painful.** Five contacts in six days
   without complaint — one motivated user, weak evidence, but the only evidence
   there is, and it points away from building.
3. **The cost is out of proportion.** Not a field: parsing, deduplication and
   error reporting. §4 said so before the numbers existed and they have not
   argued with it.

Reopens if a second account shows a high first-day count, or if a user says
entry is why they stopped. Survey 1's senior — seven places, relies on memory —
is the profile to ask. That is an interview question, not a ticket.

---

### ORB-96 — a reach-out counts as a touchpoint

**Davina found this by reading the context row: 13 contacts, 13 conversations.**
The question was whether conversations were being tracked wrong, and the answer
was yes.

`markReachedOut` moved `lastContacted` and nothing else. Press the button twenty
times and the app believed you had never spoken. So `interactions` meant *times
you wrote something down* while every surface read it as *times you were in
touch* — **ORB-80's ledger worst of all**, since it exists to show what has
accumulated at the moment you might abandon someone, and it was counting a
fraction of it.

**Not the ORB-73 mistake.** That fabricated a conversation you never had, on a
day you merely added someone. This records something you did — you said so by
pressing the button. No notes, ever, and the type is deliberately absent from
`INTERACTION_TYPES` because it is not an answer to *what kind of conversation was
this*. The ledger now reads *6 conversations · 14 reach-outs*: two claims,
because they are two different things.

**The trap worth remembering:** ORB-91's just-met trigger fires on a conversation
in the last four days with no reach-out since. A touchpoint **is** the reach-out,
so counting it would have fired *"you spoke to Marcus today — a note now lands
better"* the instant you pressed the button saying you had sent one. It reads
conversations only.

### ORB-97 — the quote says when it is from

A **live defect in ORB-78**, shipped this morning and surfaced by ORB-96. The
sentence comes from `lastContacted`; the quote is the most recent thing you
actually wrote. They diverge the moment the button is used:

> You last spoke to Marcus **3 days ago**.
> *"Talked about her move to the payments team."* ← eight months old

Presented as what you last said. The quote is now **dated rather than hidden** —
an old note is still the best thing on that screen for remembering who someone is
— and only when it disagrees, so the common case stays clean.

**36 new assertions; 1469 across 40 suites.**

| Requirement | User Story | Importance | Jira Issue | Dependencies |
|---|---|---|---|---|
| A reach-out counts as a touchpoint | As a user who keeps in touch by pressing the button rather than writing notes, I want those to count, so the app does not tell me I have never spoken to someone I contact every month | Must have | ORB-96 | Corrects a reading error in **ORB-80** and constrains **ORB-91**, whose trigger had to be narrowed to conversations. No migration — `interactions` is jsonb. **ORB-95** should read conversations only, not touchpoints |
| The quote says when it is from | As a user reading a reach-out prompt, I want the quoted conversation dated when it is older than the line above it, so the prompt is not telling me two different things at once | Must have | ORB-97 | A defect in **ORB-78**, exposed by **ORB-96**. Display only |

---

## ORB-90, ORB-91, ORB-92 — trigger before timer, shipped Aug 19

The three tickets ORB-53 was split into, and the direct test of the central bet.
**Survey 1 found exactly one person in five acted on a reminder they had set
themselves** — which is the only mechanism this app shipped with. Gollwitzer and
Sheeran put if-then plans at **d = .65** across 94 tests: *when X happens, I will
do Y* beats *I will do Y eventually*, and a timer is the second dressed as the
first.

### ORB-90 — every row says why

The reason leads, above the elapsed time. **"It has been a while" stays as the
honest fallback but prints no tag** — ORB-78 already says it in a full sentence,
and printing it twice with a label on it is the fallback shouting.

### ORB-91 — two triggers, from data already on disk

That constraint is what kept it small. **A job change would be the strongest
trigger of all and needs LinkedIn or manual entry, so it is explicitly out.**

**You just met.** A conversation in the last four days with no reach-out since.
This is the one worth reading twice: **the cadence actively hides it.** Having
just spoken makes you *in touch*, so the single moment a note lands best was the
single moment the dashboard said there was nothing to do. There is a test
asserting both halves — the person is on the list, and the health model still
says they are fine.

It clears itself. Met Monday, reached out Tuesday, gone by Wednesday — otherwise
it is nagging about a job already done.

**The anniversary of meeting.** From `dateMet` (ORB-73). Not a milestone worth
celebrating on its own; it is an *excuse*, and an excuse is what the survey says
people are short of.

### ORB-92 — the ranking

    capture → just-met → anniversary → first-contact → elapsed
    then the star, then the clock

**One array is both the reason list and the sort order.** Two lists is how a row
ends up showing one reason and sorting by another.

A reason beats a star, and a star breaks ties within a reason. Both are
asserted, because the ordering claim is the ticket.

### The bug worth remembering: the year boundary

`anniversaryTrigger` first checked only the current year's anniversary. **On 2
January, a 30 December anniversary is three days ago and lives in the previous
year** — so every turn-of-year anniversary would have been skipped, silently,
for the other eleven months of testing. It now checks the years either side.

The related fix is smaller and more useful: it originally compared against
`daysSince`, which always reads the real clock, so the `today` parameter did
nothing. **A trigger whose test can only be written on the day it fires is a
trigger nobody tests at the boundary.** It now measures against the date passed
in, which is what made the December case checkable at all.

### What ORB-81 already paid for

ORB-92 was scored at effort 2 partly because the capture shipped first. Captures
had already established that something other than a lapsed cadence can put a
person on this list, so the triggers slotted into a filter and a sort that
existed. Splitting ORB-53 and doing the pieces in this order was worth roughly
half the effort of the original ticket.

**51 new assertions; 1400 across 38 suites.**

| Requirement | User Story | Importance | Jira Issue | Dependencies |
|---|---|---|---|---|
| Say why someone is on the reach-out list | As a user looking at who to contact, I want to see the reason each person is there, so the list gives me something to act on rather than a queue of dates | Must have | ORB-90 | First of three splitting **ORB-53**. Rides **ORB-78**'s renderer; the tag sits above the elapsed sentence. **ORB-55** should reuse `reachOutReason()` in the digest rather than inventing a second vocabulary |
| Two triggers from data we already hold | As a user, I want to be told when something actually happened rather than when a timer expired, so the prompt arrives with a reason attached | Must have | ORB-91 | Second of three. Uses `dateMet` from **ORB-73** and stored conversations. Job changes are out of scope pending LinkedIn or manual entry — worth raising separately once there is evidence anyone wants it |
| Order by trigger before timer | As a user, I want the people with a real reason at the top of the list, so the clock becomes the fallback rather than the whole ranking | Must have | ORB-92 | Third of three, and the piece that delivers ORB-53's original intent. Cheaper than scored because **ORB-81** had already made membership independent of the cadence. **ORB-55** must reuse this ordering, not invent a second one |

---

## ORB-93, ORB-94, ORB-54, ORB-81 — shipped Aug 19

Four tickets, one coherent change: **the app stops asking you to classify people
and starts letting you point at them.**

### ORB-93 — the star

Migration **013**, one boolean, **stored and never inferred**. That last part is
the whole distinction from ORB-86 and the reason ORB-57's first metric can mean
anything — the moment something derives a star, every contact looks deliberately
marked.

It carries the same missing-column fallback `tier` got in 012, which matters more
here: a silent save failure would read as *nobody stars anyone* rather than as a
migration nobody ran. **The migration still has to be run by hand** — until then
the control saves nothing and warns in the console.

Reach out next now sorts **starred → clock**. Membership is unchanged: an
unstarred overdue person is still on the list, below the starred ones. Solving
ordering by removing people is the trap ORB-75 named.

### ORB-94 — the picker goes

Removed from all three surfaces: profile, add-connection form, conversation
widget. `TIERS`, `frequencyForTier`, migration 012 and the column all stay —
`effectiveTier` still answers *was this interval deliberate?*, and ORB-86 may
revive tiers as a suggestion.

**The riskiest line was the profile save.** It wrote `tier: tierSelect.value` on
every press, deliberately, because pressing Save was the user answering the tier
question. With the picker gone, the mechanical fix — write `effectiveTier(c)` —
would have recorded an **inference as a choice** on every schedule edit and
quietly destroyed the evidence ORB-86 is parked waiting for. It now does not
write the field at all, and there is a test asserting an untiered contact stays
untiered through a save.

### ORB-54 — a long silence is an opportunity

Written against the inner-circle tier, which had just been deleted, so the star
is what decides now. **Failure language is reserved for the starred.** Everyone
else past their date reads **"Worth reviving"**, *quiet 170 days*, in indigo.

Not a paler red — a paler red still reads as a warning, and the point is that
this is a different *kind* of state, not a milder one. The dormant-tie research
says the contact untouched for two years may be the most valuable in the network;
Orbit was painting exactly that person as a failure.

**Mechanism: a `tone` beside `band`, not a fifth band.** The band drives
ordering, membership and every denominator on the dashboard. A new one would move
these people out of Reach out next and solve the colour by hiding the person —
ORB-75's trap, avoided the same way. Words and colour change; placement does not,
and both halves are asserted.

The **Overdue** KPI tile became **Past their date** with *"N you starred"*
beneath, because after this change the old label overstated most of what it
counted. `countByBand` gained `starredCritical` as a **subset**, never a band.

### ORB-81 — catching a thought

Survey 1 asked where people were when they realised they had forgotten someone:
**lying awake (twice), scrolling LinkedIn, going through email, seeing the name
by accident.** Not one was inside a system built to tell them, and **two were in
bed**. A notification at 9am loses to a thought that arrived at 2am.

So it is not a form. **One required field — who — and it is the first thing you
type.** The thought is optional: *"Marcus"* alone is a complete intention, and
requiring a sentence at 2am is how the thought gets lost. A permanent bar at the
top of the dashboard, plus a third chooser option so the **+** reaches it from
every page.

**Storage is a third provenance on `followUps`, not a second list.** Same shape,
same completion, and the profile already renders them. What `capture` buys is
behaviour: an **open** one puts its person on Reach out next *regardless of
cadence* — even with no schedule at all — and leads the prompt as the reason.
A manual talking point deliberately does neither, and that is asserted, because
they share an array and it would be easy to catch both.

Reaching out completes open captures; Undo reopens them. Manual points are left
alone — they may outlive the conversation they were written for.

### The prompt after four tickets

> **YOU NOTED** Ask about the payments move
> **You last spoke to Marcus 4 months ago.**
> 6 conversations over 2 years · 3 files
> *"Talked about her move to the payments team."*
> ◇ Worth reviving · quiet 170 days

Every line is a different ticket and they all go through one renderer.

**196 new assertions across four suites; 1349 across 37.**

| Requirement | User Story | Importance | Jira Issue | Dependencies |
|---|---|---|---|---|
| Star the people who matter | As a user who already knows which handful of people matter, I want to mark them, so the app reflects what I know instead of asking me to classify everyone | Must have | ORB-93 | Migration 013. Stored, never inferred — that is what separates it from **ORB-86** and what keeps **ORB-57**'s first metric measurable. Shipped before **ORB-94** so no day had neither control |
| Take the tier picker out of the flow | As a user adding someone I met once, I do not want to be asked what kind of relationship it is before I know | Must have | ORB-94 | Depends on **ORB-93**. Removes the surface, not the code — **ORB-86** can revive tiers as a suggestion. Forced the **ORB-57** metric restatement |
| Reframe "overdue" outside the starred set | As a user, I want a long gap to read as an opportunity rather than a failure, so I open the app instead of avoiding it | Must have | ORB-54 | Was written against the inner-circle tier; **ORB-94** deleted it, so **ORB-93**'s star decides instead. Reuses `bandWords()` from **ORB-75** rather than inventing a parallel set, exactly as ORB-75 asked |
| Catch a thought about someone in one gesture | As a user who realises at 2am that I forgot someone, I want to record it in one action, so the realisation survives to a moment when I can act on it | Must have | ORB-81 | Distinct from **ORB-73**, which captures a *person*; this captures an *intention*. Rides **ORB-78**'s prompt renderer to resurface. **ORB-92** should treat an open capture as the strongest trigger rather than inventing a second ordering |

---

## ORB-51 decided — a star instead of a tier, Aug 19

**Davina's call, and it closes ORB-51.** Tiering is parked. In its place, people
who already know who matters get to say so with one click.

### The reasoning

Survey 1 split on when people know which contacts genuinely matter: **2 knew from
the first conversation, 1 after several months, 2 only looking back now.**

Every design that resolves that split by *asking better* is still asking. A tier
demands a classification — which of five kinds is this — at the moment you have
the least information. A **star** asks you to point, not to classify. It costs
one click, has no taxonomy to learn, no cadence attached, and it is simply absent
for the people who cannot answer yet.

So the split stops being a design problem: the 2 who know are served, and the 2
who only know in hindsight are never blocked on a question.

### Three tickets

| | Feature | RICE | When |
|---|---|---|---|
| **ORB-93** | Star the people who matter | 252 | Thu 20 Aug |
| **ORB-94** | Take the tier picker out of the flow | **350** | Fri 21 Aug |
| **ORB-95** | Talking points from what you attached | 23.3 | Fri 25 Sep |

**ORB-93 ships before ORB-94 even though ORB-94 scores higher.** Removing the
picker first would leave a day with neither control. The star has to exist before
the tier can go.

**The star is stored, not computed.** One boolean on `contacts`, set by the user
and never overwritten by inference — that is exactly what separates it from
**ORB-86**, and the reason it needs migration 013 rather than a derivation. It
carries the same missing-column fallback `tier` got in 012, because the free-tier
project drifts from `js/db.js`.

**ORB-94 removes the surface, not the code.** `TIERS`, `frequencyForTier` and
migration 012 all stay, so ORB-86 can bring tiers back as a *suggestion* if the
data ever supports it. The interval picker remains as the cadence control.

**ORB-95 exists because ORB-20 made PDFs attachable and nothing reads them.** They
are the richest thing in the app and completely inert. It depends on **ORB-17**
for the generator and is honestly scored at effort 6 — PDF text extraction, a
larger prompt payload, and an edge function holding the key.

### Deferred, not cancelled

**ORB-86** (suggest a tier from history) and **ORB-56** (tier as a filter axis) are
now **DEFERRED** with their dates cleared, so the roadmap stops claiming they are
scheduled. Both come back only if starring shows people want a richer model than
one bit. Watching first is the point.

### One thing that needs an answer

**ORB-57's "changed from the default" metric measures a control that ORB-94
removes.** A metric left pointing at a deleted surface reads as a healthy zero
forever. It has to be restated when ORB-94 lands, not after.

---

## RICE scored, ORB-53 split, and a column bug worth remembering

### The bug: I wrote every score one column to the right

Columns on the in-flight table are `0 Feature, 1 Jira, 2 Team, 3 Complete By,
4 Reach, 5 Impact, 6 Confidence, 7 Effort, 8 RICE Score, 9 Status`. The first
pass wrote Reach into index **5**, so every value shifted right by one and the
score landed in **Status**, wiping it from all 28 rows.

**The verification missed it because it read the same wrong indices.** Reach and
Impact are both plain numbers, so nothing looked malformed and the arithmetic
"checked out" — I was multiplying the same shifted cells I had written. Davina
spotted it by reading the page.

**The fix is the lesson:** derive column indices from the header row rather than
hard-coding them, and check a column's *type* — Status holds a `status` node,
never a number — instead of only checking that values are self-consistent.
Statuses were recovered from Confluence version 54.

### Effort re-scored for how this is actually built

Effort was scored as though implementation volume were the cost. It is not — the
code is vibe-coded, and the real cost is **integrations and third-party APIs**.
Rescaled: pure UI and copy drop to **1**, logic and schema to **2–3**, and only
genuine external dependencies stay high. **ORB-88** (Granola, unknown API) and
**ORB-18** (transcription API) are the only 8s left.

**ORB-18 is explicitly not superseded by Granola.** Davina wants the plain audio
transcript regardless, so its confidence rose from 4 to 7 even though its effort
keeps the score low.

**ORB-82 dropped from 5th to 21st** on Davina's own numbers: impact 2 and
confidence 5 rather than the 2 and 9 first assigned. It stays scheduled for
28 Aug because the segmentation data has research value RICE does not measure.

### ORB-53 split into three

One 8-effort ticket became three small ones, which is both easier to build and
scores far better — the original scored 81, the pieces score 288, 252 and 149.

| Requirement | User Story | Importance | Jira Issue | Dependencies |
|---|---|---|---|---|
| Say why someone is on the reach-out list | As a user looking at who to contact, I want to see the reason each person is there, so the list gives me something to act on rather than a queue of dates | Must have | ORB-90 | **First of three splitting ORB-53.** Foundation for the other two: every row carries a stated reason, with *it has been a while* as the honest fallback. Display only — reasons are computed in **ORB-91**. Pairs with **ORB-78** |
| Two triggers from data we already hold | As a user, I want to be told when something actually happened rather than when a timer expired, so the prompt arrives with a reason attached | Must have | ORB-91 | **Second of three.** Limited to triggers computable from stored data, which is what makes it small: **a meeting just ended** (already supplied by **ORB-45**) and **the anniversary of when you met** (from `dateMet`, added by **ORB-73**). Job changes need LinkedIn and are out of scope. Gollwitzer & Sheeran put if-then plans at **d = .65**; Survey 1 found only 1 of 5 acted on a timer |
| Order by trigger before timer | As a user, I want the people with a real reason at the top of the list, so the clock becomes the fallback rather than the whole ranking | Must have | ORB-92 | **Third of three**, and the piece that delivers ORB-53's original intent. Sorting only, once **ORB-90** and **ORB-91** exist. The clock is demoted, not removed. **ORB-55** should reuse this ordering rather than inventing a second one |

ORB-53 keeps its Backlog row as the decision-log entry and is off the roadmap,
which now carries the three executable pieces instead.

### Where RICE and judgement disagree

Worth recording, because both times the number is arguably the thing that is
wrong:

- **Granola (ORB-88) scores 30, 24th of 29.** Reach is capped at Granola users
  and confidence is held down by the unknown API. But RICE measures reach across
  all users, and with one real user **Jack *is* the reach** — the framework
  cannot see design-partner value. Overridden deliberately; it stays scheduled
  right after core.
- **ORB-82 scores 33** and is kept at 28 Aug for the same class of reason: the
  value is research, not user-facing.

---

## Rescheduled from 19 Aug, and Granola raised (ORB-88, ORB-89)

**Five items were genuinely overdue** and two were due the day this was written.
The roadmap did not show it: the dates lived in the *Date Started* column, which
was dropped on 14 Aug when the table was restructured, so the in-flight table has
been dateless since. Recovered from Confluence version 40 rather than from memory.

| Ticket | Was due | State |
|---|---|---|
| ORB-51 | 12 Aug | In Progress — **and blocks ORB-53, 54, 55, 56** |
| ORB-22 | 12 Aug | SUPERSEDED — should not be scheduled at all |
| ORB-54 | 13 Aug | Not started |
| ORB-13 | 14 Aug | In Progress |
| ORB-33 | 15 Aug | Not started |
| ORB-21 | 17 Aug | Not started |
| ORB-17, ORB-18 | 18 Aug | Due that day |

Everything live is rescheduled from **Wed 19 Aug**, dated in the *Complete By*
column, and the table is now **sorted by that date** so it reads as a schedule
rather than a list. ORB-22 is deliberately left undated — dating superseded work
implies it is going to happen. **ORB-76 was missing from the roadmap entirely**
despite being the one dated commitment on the books; it is now on it, for 27 Aug.

**Two scheduling bugs caught in the making.** The first pass put three items on
Saturdays because 19 Aug was assumed to be a Tuesday and is a Wednesday. The
working days are now generated rather than typed, and an assertion refuses any
date that falls on a weekend.

### Granola — the first request from a real user

**Jack Witt** — Survey 1, fifth year, 50+ contacts, answered **"Cooked"** when
asked what he would lose — asked for Granola integration unprompted, before being
shown anything. That is the first outside confirmation of a pain point
(**ORB-18**) that had until now only been suspected.

**The matching path is cheaper than it looks.** A Granola note attaches to a
calendar event; **ORB-15** already maps calendar events to contacts by attendee
email; **ORB-47** is the by-name fallback for events with no attendees. So
*Granola note → event → contact* reuses machinery that shipped in August rather
than needing new matching logic.

**Step 1 is a spike, not a build.** Nothing should be scheduled past it until it
is known what Granola actually exposes — export, webhook, public API or nothing.
Depending on the answer, **ORB-88 may shrink or supersede ORB-18**, which was
scoped as building transcription rather than integrating a tool the user already
runs.

**One scope warning is recorded on ORB-89.** Handing the notes surface to Granola
is where Orbit stops being a record and starts being a capture tool — a different
product claim. Survey 1 found retrieval and initiation are the failures and that
**capture is not the bottleneck**. Build it because a real user asked and
note-taking is a known pain, not because the survey called for it.

| Requirement | User Story | Importance | Jira Issue | Dependencies |
|---|---|---|---|---|
| Link a Granola note to the contact it was about | As a user who records conversations in Granola, I want the note to land on the right person in Orbit automatically, so my history is complete without me copying anything across | Must have | ORB-88 | First feature request from a real user (Jack Witt, Survey 1). **Step 1 is a spike:** establish what Granola exposes before scheduling any build. Matching reuses **ORB-15** (event → contact by attendee email) with **ORB-47** as the by-name fallback. Probably shrinks or supersedes **ORB-18** |
| Granola as the note-taker when logging a conversation | As a user logging a conversation, I want Granola to take the notes rather than an empty box, so the thing I already use is where the writing happens | Should have | ORB-89 | Depends on **ORB-88** for the surface, and on **ORB-77**'s editor boundary — whatever Granola returns must arrive as marker text, not HTML, or **ORB-63**'s escape-first guarantee breaks. **Scope warning:** this is where Orbit becomes a capture tool, which Survey 1 did not ask for |

### The plan, 19 Aug to 24 Sep

Core first, Granola immediately after it, as asked.

| Days | Work |
|---|---|
| **Wed 19 Aug** | **ORB-78**, **ORB-79** — the two cheapest engine tickets |
| **Thu 20 Aug** | **ORB-80** — completes the trio |
| **Fri 21 Aug** | **ORB-51** — close the cadence decision the survey largely answered |
| **Mon 24 Aug** | **ORB-54** — now inherits ORB-78/79's vocabulary |
| **Tue 25 Aug** | **ORB-81** — capture the 2am realisation |
| **Wed 26 Aug** | **ORB-83** — tell them when recruiting opens |
| **Thu 27 Aug** | **ORB-76** — run the three PRD metrics *(already committed)* |
| **Fri 28 Aug** | **ORB-82**, **ORB-58** |
| **Mon 31 Aug** | **ORB-84** — outreach awaiting a reply |
| **Tue–Wed 1–2 Sep** | **ORB-53** — the prospective-memory gap |
| **Thu–Fri 3–4 Sep** | **ORB-88** — Granola spike, then build |
| **Mon 7 Sep** | **ORB-89** — Granola as the note surface |
| **8–11 Sep** | ORB-86, ORB-56, ORB-13, ORB-33 |
| **14–18 Sep** | ORB-17, ORB-19, ORB-18 *(re-scope after ORB-88)*, ORB-21, ORB-55 |
| **21–24 Sep** | ORB-48, ORB-85, ORB-87, ORB-47 |

Q3 closes 30 Sep, so the plan finishes with four working days of slack. That slack
is the buffer for the ORB-88 spike coming back with an answer nobody wants.

---

## Survey 1 — what five real students said, Aug 18

First real user research. Five responses, so everything is directional — but three
patterns are unanimous or near-unanimous, and one of them **reverses an assumption
behind two tickets**. Full write-up and the response table live in Confluence under
*User research → Survey 1*.

**Finding 1 — nobody's system works, and the type does not matter.** Every
respondent rated their system **2 out of 5**; one said 3. That holds across a
person with seven storage locations and a person with one, across two maintained
spreadsheets, a notes app, LinkedIn alone, and no system at all. The tool is not
the variable. **The counter-example is the most useful row:** one respondent keeps
everything in a single notes app — no fragmentation at all — and still could not
find something 2–3 times in three months, and still rates it 2/5. *Storage location
is not the failure. Retrieval and initiation are.* That demotes "one central place"
from a value proposition to table stakes.

**Finding 2 — guilt is the engine, and we have been removing it.** Asked what
prompted their last message to a professional contact, **three of five** said *"it
had been a while and I felt bad about it."* Exactly **one** was moved by a reminder
they had set — the mechanism Orbit ships. **ORB-54** and **ORB-75** both treated
guilt as the enemy. They were right to remove an accusation and wrong to put
nothing in its place: the app became gentler and quieter at the same time. The
second half matters too — the same feeling produces *I should message her* and *it
would be weird now*, and the dread half is the part the literature says is factually
wrong. Recorded as a scope delta; **ORB-78** and **ORB-79** are the response.

**Finding 3 — the moment of realising is never inside a tool.** Asked where they
were when they realised they had forgotten someone: *lying awake* twice, *scrolling
LinkedIn*, *going through email*, *seeing their name by accident*. **Not one person
realised inside a system built to tell them; two were in bed.** Prospective memory
observed directly, and hard on a reminder-shaped product — a 9am notification
competes with a 2am thought. **ORB-81**.

**The finding nobody was looking for.** Learning when recruiting opens changed
behaviour in **4 of 5** — all four "started reaching out". One **senior** answered
*"I still don't know"*, and is the same respondent who relies on memory and once
went into a conversation having never found their notes. **ORB-83**.

**What got more complicated.** The tier design call split evenly — 2 knew who
mattered from the first conversation, 2 only looking back, 1 after several months —
so *always derive* is wrong for 40% and *always ask* is wrong for the other 40%
(**ORB-86**). "Networking is bursty" is a majority pattern, not a rule: 2 of 5 said
evenly spread, and the busiest three weeks is usually 4–10 conversations rather
than twenty. Maya's ~25 contacts sits at the median and holds.

**Sample gaps, which matter more than any number above.** Zero first-generation
respondents — the largest split in the literature, entirely untested. No juniors,
which is the primary persona's exact band. No first-years and nobody with four
contacts, so the secondary persona is unrepresented. All business, consulting or
finance; three of five share an institution.

**On juniors not responding.** The tempting reading is that they already know what
they are doing. This survey argues against it: one senior has 1–5 contacts, another
still does not know when recruiting opens, and the fifth-year with 50+ contacts
answered **"Cooked"**. Nobody ages out of this. The likelier reading is that
juniors in mid-August are *inside* the window — non-response as a symptom of the
pressure the persona describes rather than evidence of its absence.

### Ten tickets raised, in priority order

Priority is set by evidence strength and by cost, not by appetite. The first three
are copy and layout on surfaces that already exist, which is the unusual part —
the highest-leverage work here is nearly free.

| Requirement | User Story | Importance | Jira Issue | Dependencies |
|---|---|---|---|---|
| Say how long it has been, and to whom | As a user, I want to be told when I last spoke to someone rather than that a timer expired, so the prompt produces the feeling that actually makes me reach out | Must have | ORB-78 | **Survey 1, 3 of 5.** Replaces schedule language (*Reach out soon · 14 days left*) with person-and-time language and the last conversation's own words. Display only, no schema. **Constrains ORB-54**, which is unbuilt and currently briefed to remove this vocabulary rather than replace it |
| Tell them the gap is an asset, not a debt | As a user hesitating over a long silence, I want to know the gap makes my message land better rather than worse, so the feeling that got me here does not also stop me | Must have | ORB-79 | Cheapest item on the roadmap, most evidence behind it. Liu et al. (13 preregistered experiments, ~6,000 people) find appreciation is underestimated and the underestimate *grows* with gap length; Flynn & Lake find people agree roughly 3× more often than predicted. One line at the point of hesitation. **Completes ORB-75**, which removed the accusation without adding the permission |
| Show what has accumulated when prompting | As a user deciding whether to reach out, I want to see what I already have with this person, so the value of the relationship is visible at the moment I might abandon it | Should have | ORB-80 | Survey 1: the two highest-volume respondents answered **"Cooked"** and **"Everything"**; the one relying on memory answered *"not much"*. Value scales with what is recorded, and is currently invisible at the only moment it would change a decision. Reads existing data. Pairs with **ORB-78** |
| Capture a thought about someone in one gesture | As a user who realises at 2am that I forgot someone, I want to record that in one action, so the realisation survives to a moment when I can act on it | Must have | ORB-81 | **Survey 1, 5 of 5** realised away from any tool; two were lying awake. Distinct from **ORB-73**, which captures a *person* — this captures an *intention* |
| Tell them when recruiting opens | As a student who does not know the timeline, I want the app to tell me, so I find out before it is too late rather than after | Should have | ORB-83 | **Survey 1, 4 of 5** started reaching out in the month after they found out. One senior still does not know it exists. Corroborated by Cornell and Princeton: finance applications open as early as sophomore spring and many firms do not recruit seniors. Content problem more than an engineering one |
| Ask how experienced at networking they are, and store it | As the product owner, I want to know which kind of user I am looking at, so I can tell whether beginners and established networkers behave differently before designing for either | Should have | ORB-82 | Segmentation only, **deliberately does not branch the product**. Survey 1 has zero first-generation respondents, zero first-years and nobody under five contacts. One onboarding question buys the split that is missing; routing by experience level is a later decision that should rest on data. Feeds **ORB-33** |
| An outreach that is waiting for a reply | As a user who has messaged someone and heard nothing, I want that recorded, so the attempt exists and the one follow-up I am willing to send actually happens | Should have | ORB-84 | Gap 1 from the networking flows. A contact either has a conversation or none; there is no state for *I reached out and heard nothing*, which is where the follow-up decision lives. Matters most for the secondary persona, who reads each silence as confirmation. Reply-rate figures behind it are vendor data and must not be quoted as findings |
| Suggest a tier from history rather than demanding one | As a user adding someone I have met once, I want the app to work out what they are to me over time, so I am not asked a question I cannot yet answer | Should have | ORB-86 | **Survey 1 split evenly** — 2 knew from the first conversation, 2 only looking back. Both patterns are real, so offer a tier and let it change. Revisits **ORB-51** and **ORB-52**. **ORB-57**'s "changed from the default" metric must survive: a suggested tier is not a chosen one |
| Record the ask, and whether it landed | As a user working toward a referral, I want to record that I asked and what came of it, so the outcome the whole sequence exists for is not the one thing I cannot see | Could have | ORB-85 | Gap 2 from the networking flows. **No survey evidence** — the instrument did not ask about referrals, which is itself a gap for Survey 2. Depends on **ORB-84** |
| Introductions onward | As a user who has been referred, I want to record who else I was introduced to and by whom, so the network compounds instead of growing one cold message at a time | Could have | ORB-87 | Gap 3 from the flows, and the mechanism behind the strongest 18–20 finding: near-peers have a direct effect on career progress where same-age peers have none, and their value arrives through introductions rather than search. **No survey evidence yet**; most likely of these to change shape before it is built |

---

## ORB-77 — the notes box behaves like a text editor, shipped Aug 13

Not planned — five complaints from one session of real use, all in the same box.

**Paste kept the words and threw away the writing.** ORB-72 took only
`text/plain`, so a Claude answer, a Google Doc or a ChatGPT reply arrived as one
undifferentiated block: every heading, bold and bullet gone. Paste now reads
`text/html` and converts it to markers.

**This is the ORB-63 property under real pressure, and it holds.** The clipboard
HTML is *read* but never inserted — it is parsed in a detached `DOMParser`
document, walked for tag names and text only, and the resulting **marker text**
goes back through `renderNotes`, which escapes before it translates. So the tag
set that can reach the box is fixed by `main.js`, not by whatever was copied.
The old test asserted "no tags came through"; that is now the wrong assertion,
and it was replaced with the stronger one — **no tags but ours** — plus a paste
of `<script>`, `<img onerror>`, `javascript:` and `<style>` through the real
handler.

**Reading style, not just tags, is what makes it work at all.** Google Docs does
not emit `<b>`; it emits `<span style="font-weight:700">`. Matching tag names
alone would have lost every bit of formatting from the source these notes are
most often pasted from. `600` counts as bold, `500` does not.

**Bullets are a line, not a span**, so they could not be a fifth entry in
`NOTE_MARKS` — the text is split into lines and consecutive bullets gathered
into one `<ul>`. The marker is `-` only: `*` is already italic, and a line
beginning `*this*` is far more often a sentence than a bullet. `•`, `▪`, `‣` are
accepted on the way in because that is what everything else puts on the
clipboard, and normalised to `-` before storage. Enter continues a list; Enter
on an empty bullet leaves it.

**Undo was broken, and it was our doing.** ORB-72 removed `execCommand` and
edits the DOM directly, so the browser's native stack never saw the toolbar's
changes and Cmd+Z walked into states the note had never been in. There is now a
real history — innerHTML plus a caret offset, typing coalesced on a 400ms timer
so a word is one step, deliberate edits recorded on both sides so they are
always exactly one. Cmd+Z, Cmd+Shift+Z, Ctrl+Y, and Cmd+B/I/U are intercepted;
the browser's own bold would otherwise insert a `<b>` the history never saw.
Undo and redo buttons sit on the far left of the toolbar and grey out when dead.

**The box grew instead of scrolling.** It had `min-height` and no ceiling, so it
was always exactly as tall as its content — meaning it never scrolled, and a
long note pushed Attach a PDF and Save off the bottom of the dialog. Fixed
height, `overflow-y: auto`, `overscroll-behavior: contain`.

**Spacing:** the attachment row was jammed against the note box, and When/Type
had their own 2-column grid while the six fields above used 3 — so "Type" landed
halfway between "Role" and "Company". They share the tracks now and line up.

**What the tests can and cannot see.** jsdom has no layout engine, so the height
and the scrolling are read off the stylesheet, and the assertions check the
value that *wins* rather than whether a value appears — `.notes-input` is given
`resize: vertical` by the shared typography group and `resize: none` by its own
rule, and only the source order makes the second one apply. Both CSS guards were
verified by reintroducing the bug.

100 new assertions; 1,107 across 33 suites.

| Requirement | User Story | Importance | Jira Issue | Dependencies |
|---|---|---|---|---|
| The notes box behaves like a text editor | As a user, I want to paste from a doc and keep the formatting, write bullet points, and undo a mistake, so writing a note does not feel worse than writing it anywhere else | Should have | ORB-77 | Reported from use, not planned. Extends **ORB-63**'s marker format with a line-level bullet and **ORB-72**'s editor boundary with a real undo stack — ORB-72 removed `execCommand`, which is what broke native undo, so this is the other half of that change. Paste reads HTML but never inserts it: parsed detached, converted to markers, re-rendered through `renderNotes`, so ORB-63's escape-first property still holds and is asserted against hostile input. No schema — storage is still plain text with markers, so **ORB-12** CSV export is unaffected |

---

## ORB-75 — a person you have not spoken to reads as a starting point, shipped Aug 13

Phase 2 of ORB-73. Phase 1 made the state reachable; this makes it legible.

**"Overdue" was the wrong word.** Overdue means a rhythm lapsed, and there is no
rhythm to lapse before the first conversation — it reads as an accusation about
a relationship that has not started. A never-contacted person now reads
**"Not contacted yet"**, and past the grace window the detail says *"waiting 14
days"* rather than *"14 days over"*.

**Only the words changed.** The tempting fix was a fifth health band, and it
would have been wrong: the band drives colour, ordering and the dashboard
counts, so a new one would have quietly moved these people out of Reach out
next — solving the wording by hiding the person. `getHealth` returns a
`firstContact` flag instead, and a `bandWords()` helper picks the vocabulary.
The tests assert both halves: the words are different **and** the placement is
identical.

**ORB-75 shipped before ORB-54, so it owns this vocabulary.** ORB-54 should
reuse `FIRST_CONTACT_META` and `bandWords()` when it reframes "overdue" for
dormant ties rather than inventing a parallel set of words.

**Three surfaces:**

| Surface | Was | Now |
|---|---|---|
| Status chip / health bar | Overdue · 14 days over | Not contacted yet · waiting 14 days |
| Reach-out row | Last connected **no date** | Not contacted yet |
| Profile history | "No conversations logged yet." | "No conversations yet." plus when you met them and what happens next |

**The `dateMet` fallback finally had to be dealt with, and was — locally.**
`normalizeContact` derives `lastContacted` from `dateMet`, so recording a known
meeting date filed the meeting as a conversation: the contact showed *"Last
connected 30 days ago"* about someone never spoken to, and lost the
`firstContact` flag. The fallback is **still correct for every other caller** —
they only reach it with a real conversation date — so it was left alone and the
add path clears `lastContacted` after normalising instead. Weakening it for
everyone would have been a cadence change smuggled inside a wording ticket, and
it would have broken two assertions in `grace.test.mjs` and `health.test.mjs`
that document the old behaviour on purpose. **This also makes ORB-73's stated
guardrail literally true** — it was previously only true when no meeting date
was given.

**Over-claiming is guarded explicitly.** A contact whose only conversation was
deleted under **ORB-64** also has an empty array, but a real `lastContacted`
behind it. Calling them "not contacted yet" would state something the data
cannot support, so the flag requires *both* no conversations and no contact
date. That case has its own assertion.

**Known edge, not fixed:** editing an unrelated field on the profile re-runs
`normalizeContact`, which re-derives `lastContacted` from `dateMet` and drops
the flag. Fixing it properly means changing the fallback, which is the thing
this ticket deliberately did not do. Worth a ticket if it shows up in use.

45 new assertions; 999 across 32 suites.

| Requirement | User Story | Importance | Jira Issue | Dependencies |
|---|---|---|---|---|
| A profile with no conversations reads as a starting point | As a user, I want someone I have added but not yet spoken to to look deliberate rather than broken, so an empty history reads as a beginning and not a fault | Should have | ORB-75 | Depends on **ORB-73**, which created the state this describes. Vocabulary and empty states only — no schema. Deliberately **not** a fifth health band: the band drives colour, ordering and counts, so adding one would move these contacts out of Reach out next and solve the wording by hiding the person. Shipped before **ORB-54**, so it owns the first-contact vocabulary and ORB-54 reuses `bandWords()` rather than inventing a parallel set. Closes Phase 2 of ORB-73; **ORB-76** runs the metrics on Aug 27 |

---

## ORB-74 — every label agrees with what it opens, shipped Aug 13

Phase 1 of ORB-73 left one mismatch on purpose: the **+** still announced *"Add a
new connection"* while opening a chooser offering two actions, so the label named
one of the two things behind it. A screen reader user was told about adding and
then offered logging as an equal option.

**The fix is four characters of markup.** `aria-label` and `title` on both pages
are now **"Add to your network"**, matching the chooser heading they open. The
rest already agreed — each chooser option is headed by the words it was chosen
with.

| Control | Says | Opens | Heading |
|---|---|---|---|
| **+** (index, contacts) | Add to your network | chooser | Add to your network |
| Chooser option 1 | Add a connection | add dialog | Add a connection |
| Chooser option 2 | Log a conversation | log dialog | Log a conversation |

**The test is the actual deliverable.** The label lives in markup and the heading
lives in a JS string, in different files, with nothing making them move together
— which is exactly how the original mismatch arose. So `labels.test.mjs`
**discovers** the pages carrying a **+** by globbing the HTML rather than listing
them, then asserts the label equals the heading it opens and each option equals
its dialog's. A third page that grows a **+** is held to the same rule instead of
drifting unnoticed. That is the ORB-63 and ORB-65 lesson applied on purpose: a
component test proves a thing works, not that it is present everywhere.

**Both failure directions were verified by breaking them.** Restoring the old
`aria-label` fails 2 assertions; renaming a chooser option without its dialog
heading fails 1. A test for label drift that has never been seen to fail is the
ORB-57 mistake — a metric that cannot fail is not measuring anything.

20 new assertions; 954 across 31 suites.

| Requirement | User Story | Importance | Jira Issue | Dependencies |
|---|---|---|---|---|
| Every label agrees with what it opens | As someone using a screen reader, I want a control to announce the thing it actually does, so I am not told "Add a new connection" and dropped into a conversation logger | Should have | ORB-74 | Depends on **ORB-73** having settled what the surfaces are — reconciling labels against a chooser that did not exist yet was not possible. Markup only: two `aria-label`/`title` pairs, no logic and no schema. The lasting part is the test, which discovers pages rather than listing them, so the rule survives a page being added. Phase 1 of ORB-73's rollout closes here; **ORB-75** is Phase 2 |

---

## ORB-73 — add someone you have not spoken to yet, shipped Aug 13 (Phase 1)

Built to the PRD *"Adding a connection you have not spoken to"*, frozen the same
day. The open questions below were answered there: **option B**, a chooser behind
the **+** offering *Add a connection* and *Log a conversation*, each with a line
saying what it does. Naming both actions where the choice is made is what removes
the ambiguity; one control silently meaning two things is what created it.

**What shipped.** `openQuickAddChooser` is now what the **+** opens on both pages.
`addConnectionFormHtml` / `wireAddConnectionForm` write a contact with
`interactions: []` and no `lastContacted`. The conversation logger is unchanged
and one click further away.

**The bug that did not make it out.** Passing `dateMet` through and letting
`normalizeContact` derive the deadline would have re-created the exact failure the
ticket exists to fix: a person met yesterday gets a natural deadline a month out,
reads **In touch**, and never appears in Reach out next — the cold-relationship-
looks-healthy bug, arriving through `dateMet` instead of through a fabricated
interaction. So `nextReminder` is passed explicitly as `firstDeadlineFor("", freq)`
— the grace window — because no conversation means there is no anchor to count
from. Both cases are asserted in `add-connection.test.mjs`.

**`lastContacted` is empty** when no meeting date is given, which is the default
and the common case. When a date *is* given it flows through
`normalizeContact`'s existing `dateMet` fallback — deliberately not changed here,
because `grace.test.mjs` and `health.test.mjs` encode that fallback for contacts
that *do* have conversations, and rewriting it inside a UI ticket is how a cadence
change ships without review. The guarantee that matters holds either way: no date
is ever fabricated, and the contact never reads as healthy.

**Duplicates** are caught by exact name match, case- and padding-insensitive, and
offer the existing profile instead of creating a second row. Substring matches are
allowed through — *Marcus Chenoweth* is not *Marcus Chen*.

**Not in Phase 1:** empty states for a profile with no history (**ORB-75**), label
reconciliation across the **+**, both chooser options and both dialog headings
(**ORB-74**), and re-running the metrics on 27 Aug (**ORB-76**). The **+** still
carries `aria-label="Add a new connection"` while opening a chooser — a known
mismatch that is ORB-74's to close, not left by accident.

72 new assertions; 934 across 30 suites.

| Requirement | User Story | Importance | Jira Issue | Dependencies |
|---|---|---|---|---|
| Add someone you have not spoken to yet | As someone building out my network, I can add a person I have met but not yet spoken to, so their record is honest and their cadence does not start from a conversation that never happened | Must have | ORB-73 | **ORB-69** is the dependency that made this cheap — a cadence with no anchor date is judged against the grace window instead of reading "No schedule", so a contact with no conversation still appears in Reach out next rather than vanishing. Tier defaults come from **ORB-51** and the picker shape from **ORB-52**; the toast pattern from **ORB-14**. Deduplication is deliberately the existing autocomplete and no new matching logic. Phase 1 of three: **ORB-74** reconciles the labels, **ORB-75** the empty states, **ORB-76** re-reads the metrics on 27 Aug |

---

## ORB-73 — add someone you have not spoken to yet (opened Aug 13)

**The only way in fabricates a conversation.** The **+** on My Network and the
dashboard is labelled *"Add a new connection"* — that is its `aria-label` and
its `title` — and it opens a dialog headed **"Log a conversation"** whose first
question is *"Who did you speak with?"*. There is no path that adds a person
without also writing an interaction.

**This is a data problem before it is a UX one.** Saving always builds a
`normalizeInteraction` and sets `lastContacted` to its date, so adding someone
you have never spoken to records a conversation that did not happen and starts
their cadence from it. A relationship with no contact yet immediately reads as
freshly touched — the *"makes a cold relationship look healthy"* failure that
`MAX_ATTENDEES` and **ORB-47** are both written to avoid, arriving through the
front door.

It bites hardest at exactly the moment **ORB-33** cares about: someone filling in
their network on day one has thirty people and no conversations, and the app
requires a date for each of them.

**Scope:** a way to add a contact with name, role, company, email and a tier,
writing no interaction and leaving `lastContacted` empty. **ORB-69** already made
that state coherent — a cadence with no anchor date is scheduled against the
grace window rather than reading as "No schedule" — so the contact still appears
in Reach out next, which is where a person you have not spoken to belongs.

**Open questions:**

- One dialog with a mode, or two entry points? The **+** is a single button on
  two pages, and the honest reading of *"Add a new connection"* is that adding a
  person is the primary action and logging a conversation is the variant.
- Does the label move? If **+** becomes add-a-contact, logging needs its own
  reachable entry — the profile already has one, the dashboard does not.
- Bulk paste is tempting for the day-one case and is **ORB-33**'s territory, not
  this ticket's.

Whatever the shape, the `aria-label` and the dialog heading have to agree. A
screen reader user is currently told "Add a new connection" and dropped into a
conversation logger.

---

## ORB-66 — the meeting name beside the conversation, shipped Aug 13

A synced conversation stored `title + "\n\n" + notes` in one field, so Orbit's
words and the user's words were the same string. The event title was read back
as a note preview, and editing your notes could delete the heading.

`title` is its own key on the interaction — jsonb, so no migration. A synced
meeting with nothing typed now saves **empty** notes rather than saving Orbit's
own text back as though it were an answer.

**No back-fill, deliberately.** Every row already written still has the title
baked in, and the split happens at display time. A migration would have had to
guess on exactly the ambiguous rows the runtime check can decline to touch.

**The guard that matters:** the split only applies to rows with a
`sourceEventId`, and only when the notes have the shape the old writer actually
produced — a first line alone, or a first line followed by a blank one. A
hand-written note whose first line happens to be short is not a title, and
carving one out would hide the user's own first sentence behind a heading they
never wrote. Both shapes are asserted, along with the synced-but-wrong-shape
case where consecutive lines must be left whole.

**Editing migrates the row for good.** Opening a legacy conversation hands the
editor the note without the heading, and saving writes `title` as a real field —
so the split stops being re-derived on every render for that conversation's
remaining life. Where an existing title and a calendar title disagree, the
existing one wins: a name the user set is an answer, the event's is a default.

Thirty-two assertions in `tests/meeting-title.test.mjs`; 862 passing.

---

## ORB-62 — conversation history holds its height, shipped Aug 13

Three conversations, then the list scrolls inside itself. Same pattern as
**ORB-46** on the dashboard, and `wireUpcomingScroll` was generalised to
`wireScrollFade` and shared rather than copied — two lists doing the same thing
from two implementations is how they drift.

**A max-height, not a slice.** Dropping conversations to keep a card short is
the exact failure ORB-46 spent a ticket undoing, so the tests assert the
opposite of the obvious implementation: with twelve conversations, all twelve
still render and all twelve are still openable. The count in the heading says
how many are below the fold, and only appears once there are more than three.

**What the suite cannot see.** The cap is a CSS `max-height` and the fade is
driven by measuring `scrollHeight` against `clientHeight`. jsdom has no layout
engine, so both are zero. Those are read off the stylesheet instead — that a
max-height exists, that it scrolls rather than clips, and that the fade is bound
to `is-scrollable:not(.at-end)` rather than always on. The visual result is
eye-verified, and the tests say so rather than implying otherwise.

---

## ORB-72 — notes look formatted while you write them, shipped Aug 13

Not planned. Reported from use on Aug 12: the toolbar wrote `**asterisks**` into
the box and formatting only appeared after saving.

**Storage and display are separable and I had conflated them.** ORB-63's marker
format is load-bearing — plain text keeps the injection surface shut and keeps
CSV export free of tags — but nothing required it to be what the user reads
while typing. The notes box is a contenteditable now; conversion happens at the
boundary, markers in on open and markers out on save, and the only HTML that
exists lives somewhere that never reaches the database.

**Three bugs the tests forced out.** Focusing the box before applying a mark
collapses the selection when the box was not already focused, so the range is
captured first. Paste and the toolbar both honoured any selection, including a
stale one in a different field. And marks only compose — bold then italic
giving `***both***` — because the selection is restored over the newly wrapped
element, which nothing was asserting.

**`execCommand` removed** on Aug 13. Bold, italic and underline went through it;
jsdom does not implement it, so a test clicking **B** called a function that was
not there and could not distinguish a broken feature from a missing API. Three
of the four tools were browser-verified and nothing more. They use the same
manual wrap-or-unwrap as highlight now, which also drops a deprecated API with
no replacement. The trade is real and worth stating: `execCommand` is hardened
against strange selections in a way new code is not.

---

## The toolbar that shipped to one surface out of four (Aug 12)

Worth recording as a pattern, not just an incident. **ORB-63 added the
formatting toolbar to the edit dialog and nowhere else**, so two-thirds of the
places a note gets typed had none. Every assertion in the suite passed, because
they all exercised the toolbar in isolation and never asked whether the boxes
people type in had one.

The same shape appeared twice more the same day: `renderNotes` was wired into
the timeline but not the three surfaces that print note text plain, so
`**markers**` leaked into headlines, talking points and the calendar clash
quote; and `.cal-notes` was redeclaring a font size the ORB-65 scale was meant
to own.

**The lesson is about test shape, not diligence.** A component test proves a
thing works. It says nothing about whether it is *present*. Coverage for
anything shared should assert it at every call site, and the cheap version of
that is a test that reads the source or the stylesheet — which is what caught
`.cal-notes` and what now guards the toolbar.

---

## Evidence for ORB-32, from real use (Aug 12)

The first day of tiers against a real network produced two observations. Neither
changes anything shipped; both are input to **ORB-32** (season or location
condition), which **ORB-51** absorbs as a sub-case.

**A cadence is not always the right shape.** Three contacts — Tim, Assaf, Hunter
— are based in Hawaii, and the honest trigger for reaching out is *being home*,
not a number of elapsed days. A time-based deadline for them manufactures guilt
about a reach-out that is not situationally possible, which is the failure
**ORB-54** is about, arriving from a direction that ticket does not cover. This
is a **location** condition, not a seasonal one; ORB-32's row already names both,
and this is a concrete instance rather than a hypothetical.

**The tiers conflate warmth with professional relevance.** Chris is a valued
mentor for career progression and not someone to ask about day-to-day work. Both
facts are true and the four tiers can only record one of them. Not worth a fifth
tier — the answer for now is that the interval is the override, which is what the
Adjust control exists for.

**Defaults stay research-driven.** Explicitly ruled: the tier defaults follow
*User Research: Cadence Structure*, not one user's preference. The custom
interval is how a person departs from them, and ORB-57's "changed from the
default" metric is how often that happens gets measured. If overrides turn out to
be the norm rather than the exception, that is the signal to revisit the
defaults — not a reason to pre-emptively loosen them now.

---

## ORB-52 — the tier picker, shipped Aug 12

Schema landed Aug 11; this is the rest. `tier` existed in the database and
nothing in `js/` read or wrote it, so the whole path is new: column mapping,
model, and a picker in both places a cadence gets chosen.

**Tier first, interval second, everywhere.** "What kind of relationship is
this?" leads; "reach out again?" follows and stays editable. Choosing a tier
fills in that tier's interval; changing the interval afterwards is the override
and both are kept. Nothing downstream moved — health, digest and dashboard still
read `followUpFrequency`, which is what made this safe to ship in one pass.

**The rule now exists twice**, in `tierForFrequency()` and in `012`'s back-fill,
in two languages. If they drift, a contact shows one tier in the picker and
carries another in the database and nothing errors. The boundaries — 1–60,
61–135, 136–272, >272, with named frequencies matched *before* day counts, so
`bimonthly` is mentors while `custom:60` is inner circle — are asserted directly
against the SQL's own `between` clauses. There is also a round-trip assertion
that every tier's default interval classifies back to that tier, or picking a
tier and reloading would show a different one.

**A derived tier is never persisted.** `normalizeContact` leaves it blank and
`effectiveTier()` derives one only for display. Saving a derived value would make
ORB-57's "30%+ sit in a tier the user changed from the default" unmeasurable,
because every contact would look deliberately classified.

**Missing-column degradation**, following `industry` and `emails`: an unrun `012`
costs the tier, not the save, because the interval is still the effective
schedule.

**Deliberately not changed:** the quick-add default is still `monthly`, with the
tier defaulting to whatever that implies so the two controls agree on load.
Whether monthly is right for someone you have just met is **ORB-51**'s question,
and answering it here would have buried a cadence change inside a UI ticket.

**Reality check before building:** the back-fill mapped one-to-one onto the two
intervals in use — every `quarterly` became a mentor, every `custom:150` became
professional network, nobody landed in `inner_circle`. So the tier column carried
no information the interval did not already have. That is not a fault in the
back-fill; it is what makes the picker the point, and why ORB-57 measures
corrections rather than counting classified contacts.

Sixty-eight assertions in `tests/tiers.test.mjs`; 681 passing.

---

## ORB-69 — shipped Aug 12

**Decision: yes, a cadence with no anchor date is scheduled**, judged against the
grace deadline. Two parts of the code already assumed it and only `getHealth`
disagreed, so the fix was to make it agree rather than to narrow the other two.

`getHealth` no longer bails when `elapsed === null`. It falls back to
`firstDeadlineFor`, treats the window as grace — a first reach-out is owed, so it
never reads as "in touch" — and leaves `elapsed` null, because there genuinely is
nothing to measure. A stored `nextReminder` still wins, so a snooze survives.

Verified against the shipped module: the contact that reported
`{ scheduled: false, band: "none" }` now reports
`{ scheduled: true, band: "warning", daysLeft: 7, grace: true }`, appears in
`needsAttention`, and counts in the rings. A contact with no cadence at all is
still unscheduled. Nine assertions added; 613 passing.

### What it looked like before

`firstDeadlineFor()` was written specifically for a contact with no anchor date —
`if (!natural) return graceUntil`, today plus `GRACE_DAYS`. `getHealth()` never
reached it: it returned `scheduled: false` the moment `elapsed === null`, which
is true whenever both `lastContacted` and `dateMet` are empty.

Measured against the shipped module, not reasoned about:

```
firstDeadlineFor('', 'monthly') = 2026-08-18   ← a real deadline
getHealth(...)                  = { scheduled: false, band: 'none' }
displays as                     = "No schedule"
needsAttention()                = does not include them
```

**The digest disagreed with the app.** `listDueContacts` filters on
`reminder_enabled = true AND next_reminder <= today` in SQL and never calls
`getHealth`, so the same contact would be emailed while the dashboard said they
had no schedule. That mismatch is what made this a defect rather than a
preference — the fix had to move one of them, and the decision was which.

Reachability was limited — every add path traced sets `lastContacted`, so it
arrived mainly through CSV import or an edit clearing both dates. That is why it
survived: rare enough never to be reported, and silent when it happened.

The alternative was defensible and was considered: rule that a cadence without a
measurable date is not a schedule, leave `getHealth` alone, and narrow the digest
query instead. It was rejected because it would have made `firstDeadlineFor`'s
grace branch dead code, and because a contact you have committed to and not yet
contacted is exactly who a reach-out list exists to surface.

---

## ORB-37 — custom SMTP, shipped Aug 11

Auth email now leaves through Resend on an owned domain. `orbit-networking.com`,
bought at Namecheap for $11.28/yr, verified in Resend, and wired into
**Supabase → Authentication → SMTP Settings** as `smtp.resend.com:465`, username
`resend`, sender `noreply@orbit-networking.com`, sender name `Orbit`.

Three problems closed at once, which is why this was worth doing before anything
cosmetic: the sender is no longer `noreply@mail.app.supabase.io`, the *powered by
Supabase* footer is gone with the built-in service, and the built-in rate limit —
which drops overflow **silently**, so a signup looks identical to the localhost
bug from the user's side — no longer applies.

**Four DNS records at Namecheap**, verified live against the authoritative
nameserver rather than trusted from the UI:

| Type | Host | Purpose |
|---|---|---|
| TXT | `resend._domainkey` | DKIM — proves ownership; without it nothing verifies |
| MX | `send` | SES return path, priority 10 |
| TXT | `send` | SPF |
| TXT | `_dmarc` | `p=none`, optional but helps placement |

**Two things cost time and are worth writing down.** Namecheap hides MX behind
**MAIL SETTINGS → Custom MX** — it is not in the Type dropdown under HOST
RECORDS, so it reads as missing. And each row needs its own teal **✓** committed
before **SAVE ALL CHANGES** picks it up; the DKIM row was silently discarded the
first time, which surfaced as a domain stuck on Pending with no error anywhere.

A separate 535 `Authentication credentials invalid` in the Auth logs was the API
key, not the domain — different failure, different fix. Worth reading the log
line rather than guessing: 535 means the key, 550 means the domain.

**The reminder digest was still broken, and this ticket was always about it.**
ORB-37's user story is *"I want reminder emails to arrive in my inbox rather than
my spam folder"* — the digest, not auth. Auth had taken over the day, so the
digest went unchecked until after SMTP was live. `send-reminders/index.ts`
defaulted to `Orbit <onboarding@resend.dev>`, which **delivers only to the Resend
account owner and drops every other recipient without an error.** The function
returns `ok`, the logs are clean, and one person receives the digest. Live since
ORB-16 shipped; no user would have reported it, because a reminder that never
arrives looks exactly like having nothing due.

Fixed twice over: `REMINDER_FROM` set as an Edge Function secret, *and* the
hardcoded fallback changed to `noreply@orbit-networking.com`. The old default was
a footgun — a value that works in testing and silently fails in production is
worse than no default at all.

**Not done:** `davina@orbit-networking.com` receives nothing. Sending and
receiving are separate, and no mailbox exists. Cloudflare Email Routing or a
mailbox provider covers it when wanted, and will not collide, because Resend's MX
sits on `send.` while inbound uses the root.

---

## ORB-129 — a caught thought about someone new becomes a connection

Shipped 1 Sep. **The capture bar was refusing the case it exists for.**

An unknown name got *"No one in your network by that name yet."* So the one
gesture ORB-81 built to be cheap — catch the thought before it goes — worked
only for people already saved, which is the smaller half.

**Three ways a typed name resolves now.**

| Typed | What happens |
|---|---|
| A full name that matches | Saves against that person. No question — you have typed their whole name, and asking would be the app pretending not to understand |
| Something several people could be | **Asks.** *"Which Chris?"* — each candidate with their role and company, and *Someone new* last |
| Nobody it matches | Becomes a connection, and takes you to their profile |

**The question is the whole ticket.** Both alternatives fail silently: attaching
to the first Chris puts a note on the wrong person and says nothing; creating a
second Chris leaves two of them and no way to tell which the thought was about.
A candidate list with nothing but identical first names is not a choice either,
so each option carries what distinguishes them.

`captureCandidates` matches on substring **or** exact first name — the second is
what makes one word find the right person, the first is what makes half a
surname do it.

**Creating navigates; attaching does not.** A new contact is a name and nothing
else, so the profile is where the rest of what you know goes and now is when you
know it. Attaching to somebody already described would interrupt a gesture whose
entire value is being cheap.

Nothing is invented on the way: no cadence (ORB-128), no meeting date, no
conversation, no contact date (ORB-75). All five asserted.

**And the profile says what to put in.** A card shows only while a contact is a
bare name — no role, no company, no email, no conversations, no notes — and each
line carries its reason rather than just naming a field. *Role and company* so a
second Chris is never a guess. *Where you know them from* because it is the first
thing you will want and the first thing you will forget. *An email* so reaching
out does not mean leaving Orbit. It says outright that a schedule is optional,
three tickets after the app stopped assuming one, and it removes itself when it
stops being true.

**Two things tidied on the way.** `describeContact` is now written once — the
profile heading was rolling its own `[role, company].join(" at ")` and this
needed a third copy. And navigation is injected rather than read off
`window.location`, which jsdom will not let anyone redefine — the same seam
ORB-108 cut for `mailto`, and it is what makes "you land on their profile"
testable at all.

**Tests.** New `capture-new-person.test.mjs` (51). Like ORB-128's, it **cannot
be run against the old code** — `captureCandidates` does not exist there, so the
module will not load. `capture.test.mjs`'s "a stranger saves nothing" was
reversed rather than deleted, and carries the reason. 1883 assertions, 51
suites, green.

---

## ORB-128 — stop deciding things for people, and say what was done

Shipped 25 Aug. **The first five reports from users who did not build this**,
and they share one cause: the app decided things on their behalf and then did
not say what it had decided.

| Report | What was actually happening |
|---|---|
| *"Why did it say just met when they talked to them a while ago?"* | The trigger fires on a conversation in the last few days. It was labelled **Just met** — a claim about the relationship, and for someone known for years a false one. Now **Just spoke**. The trigger was always right; the words were not |
| They wanted to delete a conversation and could not find how | It exists. ORB-64 put it inside the editor so a slip cannot destroy a note, and that still stands — **the entry point was the problem.** `Edit notes` named one of the five things that dialog does, and not the one they wanted. Now `Edit conversation` |
| A contact saved and they could not see it | **It had saved, twice.** The page re-reads the database before it can redraw — seconds on a free-tier project that has been idle — and since ORB-124 a new contact is *on schedule* rather than overdue, so nothing on the dashboard listed them at all |
| A health bar for a schedule nobody set | **Monthly was selected for you.** Every contact arrived on a cadence nobody chose, counting down against it |

**The invisible-save one is worth naming as mine.** ORB-124 was right — adding
someone should not create a deadline — but it also took new contacts off the one
list the dashboard shows, and I did not notice that the page then has no way to
show you what you just did. `render(preloaded)` draws from the record the save
already returned, so the person is on screen before the round trip. `withSaved`
replaces by id rather than prepending, so logging a conversation against someone
already in the network does not show them twice.

**"When you met" was removed and put back, and the correction is the useful
part.** I read *"don't put a date and don't have the health bar loading"* as two
requests and it was one: **the objection was never to being asked when you met
somebody, it was to a date quietly becoming a countdown.** The field is back.
It cannot start anything, and rather than assert that in a comment the suite now
asserts each of the three routes it might have taken — `lastContacted` is
cleared after it (ORB-75), no cadence means no bar to start, and
`firstDeadlineFor` is handed `""` rather than the date, so a meeting 400 days
ago still produces a deadline 30 days out (ORB-124).

**No cadence is now the default, and that completes ORB-126.** The clock stopped
nagging on the 23rd; now it stops being assumed. You get a health bar when you
ask for one, and it starts the day you ask. Everything ORB-124 established still
holds for people who do choose a rhythm — it starts today, and it is not a
seven-day clock.

**Tests.** New `user-reports-25-aug.test.mjs` (22), plus `add-connection.test.mjs`
rewritten around the cadence default and extended around the meeting date. Unlike ORB-127's, this suite **could not be
run against the old code as a whole** — `withSaved` did not exist there, so the
module will not load. The two label assertions are failing-first by construction
(they assert `Just met` and `Edit notes` are absent); the rest is new behaviour
with no old counterpart. Worth saying rather than implying the same check was
done. 1829 assertions, 50 suites, green.

---

## ORB-127 — editing a name saves the name

Reported and fixed 25 Aug. **Two writers, one record, and the wrong one won.**

The name input saved itself on `blur`, independently of the details form it sits
inside. Pressing Save blurs the input first, so two writes started in a row:

1. **blur** — read the contact, write it back with the new name
2. **click Save** — read the contact, *usually before step 1's write had landed*,
   and write the whole form over it from stale state, name included

Last write wins, the last write held the old name, and Save still said
**"Details saved."** Everything else on the card saved correctly, which is
exactly what the report described.

**The fix was already written in this file, ten lines below, for the primary
email:** *"This form owns the whole list, so it owns the primary too."* The same
rule applies to the name. `readDetails` reads it, `applyDetails` writes it, the
blur handler is gone. One writer, one read, no race.

Two things fall out of that, both improvements:

- **Cancel now discards a name edit**, like it discards every other field on the
  same card. Previously a name was already committed before Cancel could refuse it.
- **An empty name is refused with a message** instead of silently restoring the
  old one. A silent restore is indistinguishable from the bug being fixed.

`applyDetails` falls back to `cur.name` rather than blanking, because
`commitDetails` also runs on email changes elsewhere on the card, where the name
input may not be on screen at all.

**The test was checked against the old code before it was trusted.** `main.js`
was stashed and `rename.test.mjs` run against the committed version: four
assertions fail there, including the browser's real blur-then-click order, which
reproduced the race in jsdom rather than only in theory. A regression test nobody
has watched fail is a test of the fix, not of the bug. 1803 assertions, 49
suites, green.

---

## ORB-126 — the clock observes, it does not oblige

Shipped 23 Aug, out of interview 2. **Reverses part of ORB-54 and retires the
word "overdue" from the product.**

**The evidence.** Jack Witt, asked whether he ever reaches out with no reason:
*"I don't randomly reach out — I want to respect their time."* He contacts the
people he values most about once a year. Interview 1 never cited frequency in
either direction. Two for two, and the second is the harder result: **silence
can be an oversight, a stated principle cannot.**

**The clock was doing three jobs and only two were wrong.**

| Job | Verdict |
|---|---|
| **Ranks** — who is at the top of Reach out next | Already demoted behind triggers by ORB-92. Left alone |
| **Obligates** — `Overdue`, `Reach out soon`, `N days over`, and a digest reading `3 months overdue` | **Gone.** This is what the app was calling failure |
| **Observes** — how long it has actually been | **Kept.** Jack's own once-a-year trigger needs it: when he has something to ask, he has no idea whether it has been a year or three |

`Overdue` → **`Long silence`**. `Reach out soon` → **`Going quiet`**. `N days over`
→ **`quiet N days`**. ORB-54's distinction survives — a starred lapse and an
unstarred one still read differently — but neither reads as a debt now.

**The digest was fixed too, and it mattered most.** It is the only surface that
reaches somebody with the app closed, so it is where a verdict costs the most.
`overdueLabel` is `silenceLabel`, **renamed rather than left returning the word
"quiet" under the old name** — a function whose name disagrees with what it does
is how the vocabulary drifted apart in the first place. Deno is not installed on
this machine so `test:functions` could not run; the label logic was transliterated
into node and checked against the same six cases, and the Deno assertions were
updated to match.

## The reported bug, and the half of it that was not a bug

*"It keeps saying say thank you to Hunter. I already sent the thank you message.
I want to keep dismissing it, but it keeps popping up."*

**The thank-you was a capture, and she sent the message from her own email.** The
app never heard, so the capture stayed open. That is not a defect and it cannot
be fixed by noticing harder — the app cannot see outside itself, and the answer
is to make being wrong cheap rather than to nag until it is right.

**The ✕ was a defect.** It removed a DOM node and recorded nothing, so the same
person returned the next morning with the same sentence, for ever. Dismissal cost
nothing and bought nothing.

Now: 30 days, per person, in localStorage beside the nudge's other settings.
**Thirty rather than seven** — a week's silence is a pause for breath, not a
dismissal, to somebody who reaches out annually. The person stays on the
dashboard the whole time; the nudge moves to the next one. Quieter is not hidden,
which is the ORB-64 rule. Reaching out clears the snooze.

## A timezone bug found on the way, and it was live

This machine is **Pacific/Honolulu, UTC-10** — the account's real timezone.

Every DATE in Orbit is local (`todayDateString`, a date input). Every TIMESTAMP
is UTC (`toISOString`). ORB-121 compared them by slicing ten characters off the
timestamp, which is a **UTC** day. In Honolulu anything entered after 2pm carries
tomorrow's UTC date, so a talking point raised the evening before a conversation
read as raised the day of it — **and landed in the wrong group.** The bug hid
carried-over points, which is precisely the guardrail ORB-125 is going to read.

`localDayOf` converts before comparing. The same fix went into
`orb-122-metrics.sql`, which now reads the zone from `preferences.timezone`
(migration 009) and defaults to UTC. Verified against a throwaway Postgres with
a Honolulu fixture: a point stored at `2026-08-20T01:00:00Z` against a
conversation on `2026-08-20` is **carried over**, where the old slice called it
raised-since.

It surfaced as a test failing by one day — `completedAt` reading 24 Aug on the
23rd — which is the harmless version of the same fault.

**Tests.** New `nudge-dismiss.test.mjs` (24), and nine assertions across three
suites rewritten to record the reversal rather than deleted. 1787 assertions,
48 suites, green.

---

## ORB-105 + ORB-110 — say which list, and stop arguing a won case

Shipped 23 Aug. Both from the 20 Aug session, and both are about saying less or
saying it in the right place.

**ORB-105 was the strongest signal in the set** — four of the twenty-two items
are one problem. *"The thought goes to the checklist. Not sure if that's the
right place. It's not clear where it goes."* ORB-81 shipped the capture input
without its output being legible.

- **Only what you did not type carries a label.** `You noted` for a capture,
  `Suggested` for an AI point, nothing for something you typed. A tag on every
  row would be noise on the majority to explain the minority.
- **`You noted` is the dashboard's exact wording** (ORB-90), not a synonym. A
  test asserts the two strings are the same value, because two words for one
  concept is ORB-74's failure in miniature.
- **The colour collision was real and specific.** `.fu-tag-ai` was
  `rgba(249,115,22,0.1)` with `--primary-deep`; `.email-label` is
  `rgba(249,115,22,0.12)` with `--primary-deep`. A tag on a talking point and a
  `PERSONAL` badge on an address were the same colour, which is why a caught
  thought read as contact information. Nothing in that list uses the primary hue
  now. **`.fu-tag-manual` was deleted rather than recoloured**, so it cannot
  return as a third colour.
- **The confirmation names the place.** *"It is on your list"* was the reported
  problem stated as a reassurance — there are several lists and it named none of
  them. It now says `Things to bring up next, on their profile`, matching the
  heading on screen.

**ORB-110 reversed an argument this codebase made.** ORB-80's ledger was
justified as *the prompt is where a relationship gets abandoned* — Remove
schedule is on the same screen. Item 5 took that apart: it holds for the
dashboard row, where the decision is still open, and not for the draft dialog,
where **opening it is the decision**.

The split that survived: **the ledger argues whether to reach out, the quote is
material for what to say.** So the ledger goes and the echo stays — the ticket
said "consider dropping the echo" and the answer is no, for that reason.

`reachOutPromptHtml` gained a `ledger` flag beside ORB-97's existing `echo` flag.
A test asserts the two are independent, so the older switch cannot be quietly
co-opted into meaning "trim the dialog".

**Tests.** New `capture-legible.test.mjs`, and the ORB-80 block in
`reach-out-prompt.test.mjs` rewritten to record the reversal rather than deleted
— the argument it used to assert is written out above the new assertions so
nobody restores it. One assertion initially failed because a CSS *comment*
explaining the deletion of `.fu-tag-manual` matched the regex looking for the
rule; comments are stripped first now. Same trap as `password-reset.test.mjs`.
1760 assertions, 47 suites, green.

---

## ORB-121 + ORB-122 — the talking-points list gets a lifecycle

Shipped 23 Aug, against **PRD: What to bring up next**.

**The diagnosis was not volume.** Item 21 of the 20 Aug session — *"is this
section just going to get longer and longer?"* — reads as a complaint about
length and is not one. A talking point had no relationship to time: it was
created, it sat on the contact, and nothing connected it to the conversation it
came from or the one it was for. So the list *could not* be short. It had no
basis on which to drop anything.

**ORB-121 — two facts a point did not have.**

- `sourceInteractionId` — the conversation that prompted it, or empty. A capture
  has none and a point typed on the profile has none, and that is not a gap:
  they genuinely came from nowhere in particular.
- *Has a conversation happened since* — **derived, never stored.** A saved flag
  would need maintaining and would go stale the moment a conversation was edited
  or deleted under ORB-64. A comparison cannot go stale.

No migration. `follow_ups` is jsonb, the same reason ORB-96 could add a
touchpoint type for free; items written before today read `""`.

`generateFollowUpSuggestions` now returns objects rather than strings, so each
suggestion carries the conversation it was lifted from. Sentences taken from the
contact's own notes carry `""` — claiming a conversation there would be an
invented fact about provenance.

**ORB-122 — three groups, and no deletions.**

`raised since your last conversation · carried over · ticked`. Sorting by
completed-last was the entire lifecycle before this, so a point raised before a
conversation that has since happened sat exactly where it did the day it was
written.

**Headings appear only when there is more than one non-empty group.** That risk
was named in the PRD against its own solution: three headings over four items is
furniture, not structure. One group renders exactly as it did before this ticket.

**Two decisions worth recording.**

- **Only a conversation moves the pivot, never a touchpoint** (ORB-96). Pressing
  *Reached out* is you sending a message. If it counted, following up on a point
  would retire that point — the app closing an intention because you acted on it.
- **Same-day counts as still to come.** `createdAt` is a timestamp and an
  interaction `date` is a day, so a point raised on the day of a conversation
  cannot be ordered against it. The safe failure is leaving a fresh point
  visible, and in practice a point typed the day you logged a conversation is
  usually for the next one.

**Provenance is rendered, not just stored.** A point from a conversation reads
`from 6 days ago`; a dangling id after an ORB-64 delete renders nothing, because
"from a conversation that is no longer here" is worse than silence. Storing the
label instead would have frozen a deleted date on screen forever.

**ORB-116 is narrowed, not closed.** The *Ticked* group is the separation half of
it. What remains is the half item 21 actually asked — the ticked group itself
still grows without limit — and that is capping or archiving, not grouping.

**Measurement, added the same day.** `supabase/scripts/orb-122-metrics.sql` —
one statement, one paste, same shape as ORB-76's.

Writing it surfaced a KPI that could not be read at all. *Points ticked before
the next conversation* needs to know **when** a point was ticked, and `completed`
was a bare boolean. So `completedAt` was added alongside it — stamped on the
tick, cleared on the un-tick, no migration. Points ticked before today carry
none, so that half reads `0 of N` on the first run and becomes real from the
second.

**The SQL was run before it was shipped.** A throwaway Postgres in Docker, a
table with the same jsonb columns, and five seeded contacts chosen to exercise
every branch: a touchpoint that must not move the pivot, a point raised on the
day of a conversation, an ancient point on a contact with no conversation at
all, a contact with zero points that must stay in the median denominator, and a
legacy tick with no `completedAt`. Every number matched what was computed by
hand, and the empty-account case was checked separately for division by zero.
That is the ORB-76 lesson applied one step earlier — a plausible-looking query
that silently answers a different question costs a whole reading.

**Tests.** New `talking-points.test.mjs`, 31 assertions. The three it exists for
are the ones that would ship looking fine: a stored flag instead of a derived
one, a touchpoint counting as a conversation, and grouping making a short list
feel longer. 1731 assertions, 46 suites, green.

---

## ORB-118 + ORB-119 — the way in says what it is

Shipped 23 Aug, from item 22 of the 20 Aug session: *"I didn't even know about
Add a connection until I clicked the + button."*

**ORB-118.** The entry point to the entire product was a 56px orange circle
containing `+`. It carried `aria-label="Add to your network"` and a matching
`title`, so **a screen reader user was told what it does and a sighted user was
not** — and `labels.test.mjs` passed the whole time, because the rule it checked
was "the label agrees with the dialog", not "there is a label anyone can see".

It is a pill with the words on it now. The `aria-label` and `title` are **gone
rather than kept**: three copies of one string is three chances to drift, which
is the exact failure ORB-74 was written for. The visible text is the accessible
name. Nothing collapses it back to an icon at any width — "small screen" is not
a reason to stop saying what a button does.

**ORB-119.** My Network is where you go when you want to add somebody, and it
was the only page with no visible way to do it. Two placements:

- a button in the page header, wrapping rather than shrinking on narrow screens
- the empty state, which said `Nobody in your network yet.` and offered nothing —
  the first screen every new account sees, and a dead end

The empty state **names the spreadsheet route**, because ORB-98 shipped and
nothing anywhere announced it. Someone with fifty contacts in Excel would
otherwise have started typing them in one at a time.

**One string, four controls.** `ADD_TO_NETWORK_LABEL` is declared once and used
by the chooser heading, the header button and the empty-state button. The two
`.html` files cannot import it, so `labels.test.mjs` checks the markup against
the constant instead — a test standing in for an import.

Filters matching nobody deliberately does **not** offer the action. That nothing
is fixed by changing the filters; offering "add someone" there answers a question
nobody asked.

**Judgement call worth revisiting.** The floating button stays on My Network
alongside the header button, so two controls with identical labels are on screen
at once. Removing it from one page would make the one persistent affordance
inconsistent, which seemed the worse trade — but if the duplication reads as
clutter in use, the header button is the one to keep.

**Tests.** `labels.test.mjs` rewritten for what "announces" now means, plus a new
`network-add.test.mjs` holding the wiring: every control lands in the *same*
chooser with all four routes, and the loaded contact list travels with it. That
last one is the failure that would have looked fine — a button wired to an empty
array opens every dialog correctly and makes each behave as though the network
were empty. 1700 assertions, 45 suites, green.

---

## ORB-124 — adding someone does not start a seven-day clock

Shipped 23 Aug. **A deliberate reversal of part of ORB-69 and ORB-75**, on the
user's own report that the behaviour was friction in the wrong place.

**What was happening.** `firstDeadlineFor` had one grace window and two callers
that meant different things by it:

| Case | What it means | Grace is |
|---|---|---|
| Back-filling a conversation from 2023 onto a monthly cadence | The deadline is already two years past. Arriving overdue punishes you for recording history | **Right.** A week to make the first reach-out |
| Adding someone you have never spoken to | Nothing is late. There was never a deadline to miss | **Wrong.** It invents one, seven days out, whatever cadence you chose |

The second case also set `grace: true` on the health, which pins the band to
`warning` no matter how much of the window is left — so the person landed on
Reach out next the moment they were saved. **Moving the date without the band
would have been cosmetic: the right deadline, still shouting.**

**The fix, three edits in `js/main.js`.**

- `firstDeadlineFor` — no anchor date at all now returns `today + interval`.
  A blown cadence still gets `GRACE_DAYS`.
- `getHealth` — `grace` is `!firstContact && (…)`. A never-contacted person runs
  the ordinary countdown like everybody else.
- the health detail line — `first reach-out in 30 days` rather than
  `7 days to first reach-out`, and `due today` at zero rather than `in 0 days`.

**Also fixed, without being asked.** CSV import passes `contact.lastContacted`,
which is empty for rows where the file gave no last-spoke date. Fifty imported
contacts all became due in the same week. They now start their cadences today.

**What did not change, and why it matters.** ORB-75's whole point was that
never-contacted people must not be filed somewhere gentler. They are still
scheduled, still counted in the rings, still get `Not contacted yet` rather than
`Overdue`, and once their deadline does pass they are on Reach out next in the
same band as everyone else. What moved is *when*, not *whether*.

**Tests.** Thirteen assertions across five suites were asserting the old
behaviour and had to be rewritten rather than deleted — each now records what
changed and why, so nobody restores the window as a bug fix. One fixture in
`add-connection.test.mjs` was passing for the wrong reason: it re-ran
`normalizeContact` on the saved row, which re-derived `lastContacted` from
`dateMet` and turned a never-contacted person into a contacted one. It now
mirrors the shipped shape. 1680 assertions, 44 suites, green.

**No migration.** Existing contacts keep whatever `next_reminder` they were
given, including seven-day ones already written. They resolve themselves the
first time a conversation is logged or the cadence is changed.

---

## ORB-52 — the four decisions, made Aug 11

| Question | Decision |
|---|---|
| How many tiers | **Four**, as researched: inner circle ~monthly, mentors and managers ~quarterly, professional network ~twice yearly, met once ~annually |
| Existing contacts | **Derive the tier from the interval already chosen.** Those were deliberate and carry intent a blanket default would throw away |
| "No schedule" | **Survives as a deliberate opt-out**, but is no longer where a new contact lands by default |
| ORB-22 | **Absorbed.** Inner circle is the star; a separate `starred` boolean would be a second answer to one question |

**The model.** `follow_up_frequency` stays and remains the effective interval, so
every existing health calculation keeps working untouched. Choosing a tier sets
the interval to that tier's default; changing the interval afterwards is the
override. Tier is what you pick, interval is what runs. That keeps the blast
radius to the picker rather than the whole health engine.

`012_relationship_tiers.sql` adds the column and back-fills it. Custom intervals
map to the nearest tier by day count, and a malformed suffix falls through to
professional network rather than erroring.

## ORB-57 — success metrics restated

Done on the EPIC. Two metrics replaced, two added.

- ~~"50%+ of the network has a cadence set"~~ → **30%+ sit in a tier the user
  changed from the default.** The old one is trivially 100% once everyone gets a
  default tier. The 30% is provisional and needs a baseline.
- ~~"Overdue count trends down"~~ → **"Inner-circle contacts past their cadence
  trends down while network size grows."** Still the headline; now scoped to
  where a missed cadence is genuinely a failure.
- **New:** 2+ reconnections a month with contacts untouched six months or more.
- **New:** over half of reach-outs carry a trigger rather than only a timer —
  the direct test of the central bet.

The "declared cadence proxies intent" assumption was rewritten to hold at the
centre of the network and weaken with distance, and a new assumption records
that memory may not be the binding constraint — held loosely, since the
underlying finding has a live replication dispute.

**Downstream catch:** the EPIC's Reference Links still pointed at
`supabase/schema.sql`, `fix-rls.sql` and `storage-policies.sql`, all moved or
removed by ORB-49 an hour earlier. Now point at `supabase/migrations/`,
`002_rls_policies.sql` and `supabase/scripts/`, plus a link to the research page.

---

## ORB-49 — numbered migrations and dead column cleanup

`supabase/` was thirteen hand-named SQL files in one flat folder, with the apply
order recorded nowhere. Now:

- **`supabase/migrations/001…011`** — the real sequence, every file idempotent,
  with a README explaining the two places where the order looks wrong and is not
  (001 creates columns 004 drops; 006 schedules daily and 009 re-schedules
  hourly). All moved with `git mv`, so history follows each file.
- **`supabase/scripts/`** — `check-rls.sql` and `catch-up.sql`, which diagnose
  rather than migrate and were never migrations.
- **`storage-policies.sql` deleted** — verified a strict subset of
  `002_rls_policies.sql`, which creates the same four policies and also clears
  the older `rs3hur_*` ones.

**The ticket was wrong about what survives, and so was this row.** The ticket
lists `manager_name`, `next_steps` and the orphan `internship_id` columns. The
first two were dropped by `004_settings_columns.sql` on Aug 10. This row then
claimed the two `internship_id` columns survived — but that was read off the
commented drops in `003_drop_legacy_tables.sql`, not off the database. Queried
on Aug 11: **neither exists.** `contacts.internship_id` is not declared in `001`
at all, so it may never have existed here.

`011` therefore did nothing when run, and is kept anyway: `001` still declares
`storage_files.internship_id`, so a project rebuilt from the migrations creates
the column and `011` is what removes it again. The lesson is the cheap one —
schema claims get verified against `information_schema`, not inferred from what
an earlier migration commented out.

Its preflight was also rewritten. The original was a single `union all` across
both tables, so an already-dropped column raised `42703` and took down the check
for the other one — a safety query that fails precisely when things are safe.
It now reads `information_schema`, which cannot error on an absent column.

**Six runtime error strings named these paths to the user** — "Run
supabase/add-settings-columns.sql to enable it" and similar, in `js/db.js` and
`js/main.js`. A rename without them would have pointed people at files that no
longer exist. Updated, along with README, PRD, LEARNINGS and REMINDERS-SETUP.

**`ROADMAP.md` deliberately not updated.** Its references are dated log entries —
"Migration: `supabase/add-integrations.sql`, run 2026-08-10" — and rewriting them
would falsify the record of what was actually run under what name. Same principle
as leaving the Backlog rows alone.

---

## Aug 11 — cadence research, and eight new tickets

`User Research: Cadence Structure` is now a Confluence page under the EPIC,
alongside Backlog and Roadmap. It argues that the flat per-contact interval is
the documented failure mode of the personal-CRM category, and proposes tiers
with researched defaults, triggers ranked above timers, and a rewrite of the
word *overdue*. It carries its own sourcing caveats — read those first.

**Nothing already in the Backlog was edited.** Existing rows stand as the record
of what was decided when. Everything forward-looking is a new ticket, so the
page reads decisions → research → what changes next.

| Ticket | | |
|---|---|---|
| ORB-51 | Cadence strategy: tiers and triggers | Aug 11 · **In Progress** |
| ORB-52 | Relationship tiers replace the interval picker | TBD |
| ORB-53 | Trigger-first ordering for the reach-out list | TBD |
| ORB-54 | Reframe "overdue" outside the inner circle | TBD |
| ORB-55 | Digest orders by trigger and shows the reason | TBD |
| ORB-56 | Tier as a filter axis | TBD |
| ORB-57 | Restate the success metrics tiers invalidate | TBD |
| ORB-58 | Finish the mark-as-reached-out rework | TBD |

**Two things worth carrying forward:**

The shipped picker stops at **quarterly**. The two outer tiers the research says
matter most — twice-yearly and annual — cannot be expressed today except through
the custom-days field. The options that matter are the ones the UI makes hardest.

**ORB-22 and ORB-52 answer the same question twice.** A `starred` boolean and a
four-tier system are two ways to say "this one matters." ORB-22 is scheduled for
today; ORB-52 supersedes its approach. Open decision on the research page.

### ORB-58 — what ORB-13 actually left behind

ORB-13's row still describes a two-click modal. The code moved past that:
`markReachedOut()` gives one past-tense click with an 8-second undo on the
dashboard list, My Network and the contact profile, and the old dialog is already
demoted to a secondary **Draft** button. The EPIC's Open Questions answered *row
gone*, and the build followed it.

Two gaps survive, and they are ORB-58, not ORB-13:

- the **app-open nudge** still opens the old "Draft a message" modal — the one
  surface that interrupts you never got the rework
- the button only renders when `health.scheduled` is true, so **a contact given a
  cadence later never appears in Reach out next**

### Roadmap: Team colours

The Team cells set a `background-color` on the *text run*. Confluence's HTML
converter copies that colour into `textColor` as well, so the label was rendering
in the same light purple as its own highlight — the "light grey, can't read it"
symptom. Setting `color` explicitly does not survive the conversion.

Fixed by moving the highlight to the **cell** (`data-background` on the `td`) and
leaving the text unstyled, so it renders in the default dark. Core Functionality
`#dfd8fd`, Integrations `#c6edfb`.

---

## Aug 11 plan, set on Aug 10 evening

Three moved up, one scheduled, one deferred, one shipped.

| Ticket | Change | Why |
|---|---|---|
| ORB-13 | Aug 8 → **Aug 11**, DONE → **In Progress** | The decision was deferred *pending real usage*. Orbit is now in daily use, so that condition is met. Booked as thinking time, not build time |
| ORB-22 | Sep 7 → **Aug 11** | One `starred` column. Mission Control's fractions count everyone with a cadence, so "in touch" cannot distinguish who matters — this is the input those rings were missing |
| ORB-49 | TBD → **Aug 11** | Cleanup only gets more expensive, and the InternTrack leftovers have already cost time twice. Do it before ORB-48, which reshapes a column this pass would otherwise revisit |
| ORB-33 | unscheduled → **Aug 15** | **Not hypothetical.** People have tried to sign up and reported problems. Bare minimum first: unblock account creation, then the empty-state work |
| ORB-23 | Aug 19 → **Q4** | Needs historical snapshots that do not exist, so the chart would render near-empty. Wants the same confidence field ORB-47 needs — build them together |
| ORB-50 | new, **DONE Aug 10** | 2FA hidden from Settings until ORB-21 ships |
| ORB-37 | stays **Aug 11** | Deferred from today by choice: spam placement only matters once someone other than the author receives the mail |

**The filter behind most of these:** with one primary user, work that needs real
usage data to decide (ORB-13) gets *better* now, and work that serves people who
have not arrived yet can wait. ORB-33 is the exception that corrected the rule —
people *are* arriving, and some of them cannot get in.

### ORB-50 — what shipped

`js/main.js`, two blocks commented out rather than deleted, so ORB-21 restores
them by uncommenting:

- the **"Secure your account"** callout in the Settings General pane
- the **Two-factor authentication** block in the Security pane

The `#goSecurity` click handler had to go with them. Left in place it would call
`.addEventListener` on a null button and take the entire settings modal down —
a worse bug than the one being fixed. Change password is untouched.

The test harness under `tests/.harness/` is generated and gitignored, so it needed
no parallel edit. 585 tests still pass.

---

## Written on 2026-08-11

### Corrections — rows that no longer described what shipped

Three had already been fixed by hand before this pass: **ORB-27**'s cell (now the
fortnightly digest), **ORB-37** ("deliverability risk, not a blocker") and
**ORB-16** ("shares no infrastructure with ORB-15").

Three were still wrong and are now corrected:

| Ticket | Was | Now |
|---|---|---|
| ORB-15 | "Blocked on having real contacts with emails saved" | Shipped Aug 8; follow-ons are ORB-44, ORB-45, ORB-47 |
| ORB-39 | A `contact_emails` table with `is_primary`, and the old column retired | `contacts.emails` jsonb; `contacts.email` **retained** as primary |
| ORB-40 | A `contact_roles` table with title, dates and `is_current` | `contacts.company_history` jsonb, company name strings only |

ORB-39 and ORB-40 were not stale prose — they were **design specs for tables that
were never built**. Anyone reading them would have gone looking for schema that
does not exist. ORB-38's cell also now records that only its audit half shipped.

**One title:** ORB-27 was *"Revisit Email Reminder Logic: Only notify a user when
they have 14 days left until they should reach out by email"* — the lead-time
mechanism that was considered and not built. Shortened to **"Revisit email
reminder logic"**.

### Two new tickets — remainders split out of part-done work

ORB-38 and ORB-40 stay **DONE**, because what shipped for each is real and in use.
What was specced but not built is split out rather than reopened, so the roadmap
dates keep their meaning.

| Requirement | User Story | Importance | Jira Issue | Dependencies |
|---|---|---|---|---|
| Role titles and dates on contact history | As a user, I can record what someone did at each company and when, so I remember whether they were a mentor, a peer or an interviewer | Should have | ORB-48 | Remainder of ORB-40, which shipped company names only. Titles, start and end dates and a current flag are more structure than a string array holds — so this is the point where `contacts.company_history` either grows to objects or becomes a table. **Breaking change to watch:** ORB-2 autocomplete disambiguates by role and company, so it must read current role from the new shape if the old columns retire. ORB-28 person summaries get sharper once dates exist |
| Numbered migrations and dead column cleanup | As a developer, I want database state reproducible from the repo, so a fresh project matches the running one and setup drift stops looking like bugs | Should have | ORB-49 | Remainder of ORB-38, which shipped the audit — `catch-up.sql` reports every expected column as present or missing — but not the reproducibility half. Migrations are still hand-named files applied in no defined order, and the dead columns survive: `manager_name`, `next_steps`, and the orphan `internship_id` columns left over from InternTrack. Dropping columns is irreversible, so it needs the audit trusted first — an ORB-38 dependency, not a parallel track |

Roadmap rows for both: Core Functionality, date TBD, MEDIUM priority, Not Started.
Effort MEDIUM for ORB-48, LOW for ORB-49.

---

## Written earlier — ORB-43…47

Added to both pages on 2026-08-10. The live text is the narrative version, which
is the one that stands; an alternative stricter draft that once lived in this file
has been dropped to stop the two versions competing.

| Jira Issue | Requirement | Status |
|---|---|---|
| ORB-43 | Reminder digest in the reader's timezone | DONE |
| ORB-44 | Calendar connection follows the account | DONE |
| ORB-45 | Ask about a conversation only once it has ended | DONE |
| ORB-46 | "Coming up" holds its height | DONE |
| ORB-47 | Match calendar events by name | NOT STARTED — specced only |

ORB-24 Idle Pause Resilience was also flipped to **DONE**.

---

## Still open

**ORB-27's user story** still reads *"notified while I still have time to reach out
to my connection"* — a lead time. What shipped is a digest of people already
overdue. The cell and the title now describe the digest, but the story describes
the other mechanism. That is a scope question rather than a typo: either the story
is rewritten to match the digest, or a separate ticket covers a genuine
before-the-deadline nudge. Left alone pending a decision.

**ORB-42's cell** is still the pre-build sequencing plan ("Sequence last. The field
set changes underneath in ORB-38 to 41"). It reads as a dependency that has since
been satisfied, so it is accurate rather than wrong. Harmless; not touched.

**The EPIC page** has an empty Milestones section, and its Requirements table holds
only *Shipped — M0* (ORB-1…12). That is correct as far as it goes, but it means the
EPIC alone never shows the backlog. Open questions on it are all answered and
dated, and all three reference links resolve.

**`docs/PRD.md`** is not a faithful export — it has a Milestones table and a Design
section Confluence does not, and a Backlog table whose keys stop at ORB-24. It is
marked as a partial local copy. Reading keys off it once caused a collision with
real tickets, so check the live Backlog page before inventing an ORB number.
