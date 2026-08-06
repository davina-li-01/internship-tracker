# InternTrack

InternTrack is a networking tracker I built to help students actually stay in touch with the people they meet. You log who you connected with, what they do, and what you want to bring up next time — and the app tells you who you're starting to drift away from.

It started out as a general internship tracker (daily logs, weekly manager updates, the works), but it was trying to do too many things at once and none of them well. I scoped it down to the one thing I actually kept using: keeping my network warm.

---

## Live Demo

[[https://davinali.github.io/internship-tracker](https://davina-li-01.github.io/internship-tracker/)]

You need to make a free account to use it. Your data is saved to the cloud so it won't disappear if you close the tab.

---

## The idea

Most people meet someone great at an event, say "let's keep in touch," and then never do. Not because they don't want to — because there's no system. InternTrack is that system:

1. **Log the connection** while it's fresh — name, role, company, and what you talked about.
2. **Pick a cadence** — how often you want to check in with this person.
3. **Let the dashboard nag you** — a health bar per relationship shows who's healthy, who's fading, and who's overdue.

---

## Features

- **Dashboard (mission control)** — network stats, plus health bars showing which relationships are healthy, fading, or overdue
- **Quick add** — a **+** button in the bottom corner opens the capture widget from anywhere on the dashboard
- **Chronological connection list** — everyone you've met, most recent touchpoint first, grouped by month
- **Relationship health** — decays from 100% right after you talk to someone down to 0% when your chosen cadence has fully elapsed
- **Follow-up cadences** — weekly, biweekly, monthly, quarterly, or a custom number of days
- **Contact profiles** — conversation history, roles and companies over time, and a "things to bring up next" checklist
- **Suggested talking points** — pulls action-y sentences out of your notes and past conversations
- **Files** — upload PDFs and optionally link them to a person (nested under Networking in the sidebar)
- **Light and dark mode**

---

## How relationship health works

Each contact you choose to track has a cadence (say, monthly = 30 days). Health is how much of that window is left:

```
health = (1 - days_since_last_contact / cadence_days) × 100
```

- **60–100% — Healthy.** You're on track.
- **25–59% — Fading.** The window is closing.
- **0–24% — Overdue.** Reach out.

Contacts with no cadence aren't tracked and don't count toward your network health — the point is to be deliberate about who you're actively maintaining, not to feel guilty about everyone you've ever met.

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
- Suggested wording for reminder messages and empty state text

I still had to review all the code, adjust it to fit my project, and make a lot of the decisions myself. AI wrote the first draft of a lot of things but I had to actually understand it and make it work together.

---

## Challenges I Faced

**1. Switching from saving data in the browser to saving it in the cloud**

At first I was saving everything in localStorage (basically the browser's memory). But that meant your data would disappear if you switched browsers or cleared your cache. I had to rewrite how data gets saved so it uses Supabase instead. This was hard because almost every function had to become "async" — meaning it waits for the data to load before doing anything.

**2. My Supabase project paused and I thought I'd lost everything**

Free Supabase projects pause after about a week of inactivity, and a paused project's URL stops resolving entirely. The app just bounced everyone to the login screen with no error. On top of that, the project had migrated to a new API key format, so my old key silently stopped working — which made the database look completely empty even though all my data was fine. Two different problems stacked on top of each other, and neither one produced a useful error message.

That's why `js/db.js` now shows a red banner when the backend is unreachable or a table is missing, instead of quietly rendering an empty page.

**3. Doing too much**

The first version had internships, daily logs, weekly manager update emails, resume bullet points, a calendar, and networking. It was confusing to use and confusing to build on. Cutting it back to just networking made every remaining screen better.

**4. ES Modules not working locally**

My JavaScript uses ES Modules (the import/export system). This doesn't work if you just double-click the HTML file — you need a local server. I use VS Code's Live Server extension, or `python3 -m http.server`.

---

## Future Improvements

- Actually sending reminder emails instead of just showing them on screen
- Importing contacts from LinkedIn
- Charts showing how your network health trends over time
- Making it installable on your phone and usable offline
- A "starred / potential mentors" section (needs a `starred` column added to the `contacts` table first)

---

## Project Structure

```
internship-tracker/
├── index.html        # Dashboard — network stats and health bars
├── network.html      # Networking — capture widget + chronological list
├── contact.html      # Individual contact profile
├── files.html        # Files (nested under Networking)
├── auth.html         # Login and sign up
├── css/
│   └── style.css     # All the styles
├── js/
│   ├── main.js       # All the UI logic, one init function per page
│   ├── db.js         # Reading/writing Supabase
│   └── supabase.js   # Supabase connection and auth helpers
├── assets/
│   └── images/
└── README.md
```

### Database

Three tables in Supabase, all protected by Row Level Security:

- **`contacts`** — one row per person. Their conversations, past companies, and follow-up talking points are stored as JSON columns.
- **`storage_files`** — metadata for uploaded PDFs; the files themselves live in the `interntrack-files` storage bucket.
- **`preferences`** — your name and email, used for drafting reminder messages.
