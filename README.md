# Orbit

**Keep your people in orbit.**

Orbit is a networking tracker I built to help students actually stay in touch with the people they meet. You log who you connected with, what they do, and what you want to bring up next time — and the app tells you who you're starting to drift away from.

It started out as a general internship tracker (daily logs, weekly manager updates, the works), but it was trying to do too many things at once and none of them well. I scoped it down to the one thing I actually kept using: keeping my network warm.

---

## Live Demo

[https://davina-li-01.github.io/orbit/](https://davina-li-01.github.io/orbit/)

You need to make a free account to use it. Your data is saved to the cloud so it won't disappear if you close the tab.

---

## The idea

Most people meet someone great at an event, say "let's keep in touch," and then never do. Not because they don't want to — because there's no system. Orbit is that system:

1. **Log the connection** while it's fresh — name, role, company, industry, and what you talked about.
2. **Pick a cadence** — how often you want to reach out to this person.
3. **Let the dashboard nag you** — a health bar per relationship shows who you're in touch with, who needs reaching out to soon, and who's overdue.

The name is the mechanic: a follow-up cadence is an orbital period. People come back around, and Orbit tells you when.

---

## Features

- **Mission Control** — four status tiles, two health rings, and a breakdown bar showing exactly where your network stands
- **Relationship health** — decays from 100% right after you talk to someone down to 0% as your chosen cadence runs out
- **My Network** — everyone you know, searchable and filterable by industry and status
- **Networking Log** — a chronological feed of every connection, grouped by month, with filters on the right
- **Quick add** — a **+** button in the bottom right opens the capture widget from anywhere
- **Connection profiles** — conversation history, roles and companies over time, industry tag, and a "things to bring up next" checklist
- **Suggested talking points** — pulls action-y sentences out of your notes and past conversations
- **Files** — upload PDFs and optionally link them to a person, with search and filters
- **Light and dark mode**

---

## How relationship health works

Every connection you give a cadence to (say, monthly = 30 days) gets a health score — how much of that window is left:

```
health = (1 − days_since_last_contact / cadence_days) × 100
```

| Band | Meaning |
|---|---|
| **In touch** | 60% or more of the window is left. You're current. |
| **Reach out soon** | Under 60% left, but the deadline hasn't passed. |
| **Overdue** | The cadence has fully elapsed. Reach out. |

**Overdue means genuinely past due**, not just a low percentage. An 80-day-old contact on a 90-day cadence is down to 11% but still has 10 days left — calling that overdue would contradict the countdown right next to it.

Connections with no cadence still appear everywhere; they just don't get a health score. The point is to be deliberate about who you're actively maintaining, not to feel guilty about everyone you've ever met.

---

## Technologies Used

- **HTML** — the structure of every page
- **CSS** — all the styling, including making it work on mobile
- **JavaScript** — ES modules, no framework and no build step
- **Supabase** — Postgres database, authentication, file storage, and Row Level Security so you only ever see your own data
- **localStorage** — small UI preferences like dark mode and whether the sidebar is collapsed

---

## AI Tools Used

I used **Claude** to help me build this project.

Here's specifically how it helped:

- Generated a lot of the JavaScript, especially the parts that talk to Supabase
- Helped me debug things that weren't loading in the right order, and login problems
- Helped scope the app down from an everything-tracker to a focused networking tool
- Caught two bugs I couldn't see: a dashboard where the status label contradicted the countdown beside it, and a container with no CSS rule that made every card stack flush together
- Suggested wording for reminder messages and empty state text

I still had to review all the code, adjust it to fit my project, and make a lot of the decisions myself. AI wrote the first draft of a lot of things but I had to actually understand it and make it work together.

---

## Challenges I Faced

**1. Switching from saving data in the browser to saving it in the cloud**

At first I was saving everything in localStorage (basically the browser's memory). But that meant your data would disappear if you switched browsers or cleared your cache. I had to rewrite how data gets saved so it uses Supabase instead. This was hard because almost every function had to become "async" — meaning it waits for the data to load before doing anything.

**2. My Supabase project paused and I thought I'd lost everything**

Free Supabase projects pause after about a week of inactivity, and a paused project's URL stops resolving entirely. The app just bounced everyone to the login screen with no error. On top of that, the project had migrated to a new API key format, so my old key silently stopped working — which made the database look completely empty even though all my data was fine. Two different problems stacked on top of each other, and neither one produced a useful error message.

That's why `js/db.js` now shows a red banner when the backend is unreachable or a table is missing, instead of quietly rendering an empty page.

**3. "Public" bucket did not mean uploads worked**

File uploads failed silently for a while. The storage bucket was marked public and I assumed that was enough — but public only controls *reading* a file from its URL. Uploading is an insert into `storage.objects`, which has Row Level Security turned on, and my bucket had zero policies. So every write was denied by default. Fixed by adding policies that let signed-in users write inside their own folder.

**4. Doing too much**

The first version had internships, daily logs, weekly manager update emails, resume bullet points, a calendar, and networking. It was confusing to use and confusing to build on. Cutting it back to just networking made every remaining screen better.

**5. ES Modules not working locally**

My JavaScript uses ES Modules (the import/export system). This doesn't work if you just double-click the HTML file — you need a local server. I use VS Code's Live Server extension, or `python3 -m http.server`.

---

## Future Improvements

See [ROADMAP.md](ROADMAP.md) for the full list. The big ones:

- **Google Calendar auto-logging** — match calendar invites against saved emails so touchpoints log themselves, instead of relying on me to remember
- **Real AI talking points** — the current suggestions are a keyword heuristic; a model would make them read like a person wrote them
- Charts showing how network health trends over time
- Importing connections from LinkedIn
- A "key people" tier (needs a `starred` column on `contacts`)

---

## Project Structure

```
orbit/
├── index.html        # Mission Control — stats, health rings, who to reach out to
├── contacts.html     # My Network — everyone, searchable and filterable
├── network.html      # Networking Log — capture widget + chronological feed
├── files.html        # Files — upload and browse PDFs
├── contact.html      # One connection's profile
├── auth.html         # Login and sign up
├── css/
│   └── style.css     # All the styles
├── js/
│   ├── main.js       # All the UI logic, one init function per page
│   ├── db.js         # Reading/writing Supabase
│   └── supabase.js   # Supabase connection and auth helpers
├── supabase/
│   └── storage-policies.sql
├── ROADMAP.md
└── README.md
```

### Database

Three tables in Supabase, all protected by Row Level Security:

- **`contacts`** — one row per person. Their conversations, past companies, and follow-up talking points are stored as JSON columns.
- **`storage_files`** — metadata for uploaded PDFs; the files themselves live in the `interntrack-files` storage bucket.
- **`preferences`** — your name and email, used to sign the draft messages Orbit writes.
