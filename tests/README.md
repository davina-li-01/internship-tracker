# Tests

```bash
npm install     # once — jsdom is the only dependency
npm test
npm test -- calendar     # only suites whose filename contains "calendar"
```

The Edge Function has its own suite, run by Deno rather than node:

```bash
npm run test:functions
```

---

## How the app gets loaded

Orbit has no build step, and these tests do not add one. `js/main.js` imports
`js/supabase.js`, which fetches the Supabase client from a CDN and cannot be
imported outside a browser — so `helpers/load-main.mjs` reads the source from
disk, rewrites those two import specifiers to local stubs, appends an export
line, and imports the result. The generated copy lands in `tests/.harness/` and
is gitignored.

**Nothing is copied by hand.** That matters more than it sounds: these suites
used to import from a manually maintained duplicate of `main.js`, and it passed
133 assertions right up until anyone checked what it contained. The duplicate
predated the reach-out rework, the toast, calendar sync and conversation
attachments — a third of the suite was proving things about code that had not
run in days. Reading the source at load time makes that impossible.

`js/calendar.js` has no imports at all, so the calendar suites import it
directly.

## The fake database

`helpers/load-main.mjs` exports a `state` object backed by a `Map`, plus
`resetState()`. Suites assert on **what the data looks like afterwards** rather
than on which functions were called, because the questions worth asking here are
"did the conversation survive" and "did the cadence roll forward".

`state.failSave` and `state.failUpload` force failures. Those paths matter: a
storage error must never cost someone their notes.

## Suites

| Suite | Covers |
|---|---|
| `health` | Relationship health bands, intervals, `needsAttention`, band counting |
| `grace` | The one-week grace window on a newly set cadence, date arithmetic across year and leap boundaries |
| `convo` | Conversation normalising, previews, cadence after logging |
| `filters` | Search, cadence and status filters, dashboard denominators |
| `charts` | Ring geometry and the part-to-whole split bar |
| `reach-out` | One-click "reached out", undo, the toast surviving a re-render (ORB-13/14) |
| `attachments` | Attaching a file to a conversation, both write paths, upload failure (ORB-20) |
| `file-types` | What may be attached; photo vs PDF previews |
| `calendar-matching` | Which calendar events become conversations, and dedupe (ORB-15) |
| `calendar-autosync` | Background sync throttling, reconnect nudges, timeouts |
| `calendar-upcoming` | Upcoming meetings, meeting medium, the display cache |
| `calendar-collisions` | Same-day clashes, deleting, the collapsed conversation row |
| `dates` | Every date helper agrees, in the local timezone |
| `password` | Strength scoring and the one shared minimum |

## Writing one

```js
import { loadMain, state, resetState } from "./helpers/load-main.mjs";
import { eq, ok, group, done } from "./helpers/assert.mjs";

const { getHealth, normalizeContact } = await loadMain();

group("What this covers");
resetState();
eq("a label that reads as a sentence", getHealth(normalizeContact({})).band, "none");

done();
```

Add the symbol to the `EXPORTS` list in `helpers/load-main.mjs` if it is not
already exposed. Every suite shares one module instance — node caches imports by
URL, so generating per-suite variants would silently hand back whichever loaded
first.

`tests/run.mjs` runs each suite in its own process for the same reason: the
loader caches, and the fake database is mutable, so one suite's leftovers must
not decide another's result.

## What these do not cover

Anything that needs a real browser or a real network. Layout, CSS and anything
depending on Supabase, Google or Resend responding are verified by rendering in
headless Chrome and by running against the live services — several bugs this
suite could never have caught were found that way, including a row that
collapsed to zero width and a primary button that was white text on white.
