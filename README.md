# InternTrack

**InternTrack** is a multi-page internship activity tracker built for students managing internship work, networking contacts, and weekly manager updates — all in one place.

## Live Demo

🔗 [https://davinali.github.io/internship-tracker](https://davinali.github.io/internship-tracker)

> **Note:** The app requires a free account sign-up to use (powered by Supabase Auth). Data is stored securely per user in the cloud.

---

## Features

- **Multi-internship support** — add and switch between current and past internships
- **Impact log** — record daily tasks, measurable impact, skills used, and tags
- **PDF file uploads** — attach PDFs (resumes, offer letters, project docs) to each internship
- **Weekly summary generator** — one-click formal manager update email pre-filled with your week's logs
- **Networking CRM** — track contacts with company, role, date met, and follow-up frequency
- **Interaction timeline** — log every coffee chat, email, or meeting with a contact
- **Follow-up reminders** — automated nudges when it's time to reconnect (monthly, bimonthly, quarterly)
- **AI-suggested next steps** — smart follow-up task suggestions based on contact notes and role
- **Weekly insight quote** — motivational quote from the Quotable API on every load
- **Light / dark theme toggle** — preference saved in localStorage
- **Responsive layout** — works on mobile and desktop
- **User accounts** — sign up, sign in, and sign out via Supabase Auth; all data is private per user

---

## Pages

| Page | Description |
|---|---|
| **Dashboard** (`index.html`) | Log impact, upload PDFs, preview weekly summary, see follow-up alerts |
| **Networking** (`network.html`) | Add/view contacts, see reminder alerts |
| **Contact Profile** (`contact.html`) | Full CRM profile — interactions, follow-ups, documents, reminder settings |
| **Weekly Summary** (`summary.html`) | Generate and copy a formal manager update email |
| **Auth** (`auth.html`) | Sign up, sign in, forgot password |

---

## Technologies Used

- **HTML5** — semantic structure, ARIA accessibility attributes
- **CSS3** — external stylesheet, Flexbox + CSS Grid, media queries for responsive design
- **Vanilla JavaScript (ES Modules)** — async/await, DOM manipulation, form validation, event handling
- **Supabase** — cloud Postgres database + Row Level Security + Auth (sign up / sign in / sign out)
- **Quotable API** (`https://api.quotable.io/random`) — external fetch for weekly insight quotes
- **localStorage** — active internship selection and light/dark theme preference
- **FileReader API** — client-side PDF encoding for upload

---

## JavaScript Interactivity Checklist

| Requirement | Where |
|---|---|
| ✅ DOM manipulation | Logs, contacts, files, contact profiles all rendered dynamically |
| ✅ Event handling | All forms, buttons, selects, keyboard nav throughout the app |
| ✅ Form with validation and feedback | Log form, contact form, auth form — all validate and show inline errors |
| ✅ API integration | `fetchQuote()` calls `api.quotable.io` for weekly insight |
| ✅ Local storage | Theme preference + active internship ID stored in `localStorage` |
| ✅ Dynamic filtering/sorting | Logs and contacts sorted by date; follow-up reminders filtered by due/soon status |
| ✅ Theme toggle | Light/dark toggle in every page nav, persisted in `localStorage` |

---

## AI Tools Used

**GitHub Copilot (Claude Sonnet)** was used extensively throughout this project:

- **Architecture planning** — helped design the 5-table Supabase schema (preferences, internships, logs, files, contacts) and the async ES module data layer (`db.js`)
- **Code generation** — generated the full `app.js` rewrite converting ~2000 lines of localStorage code to async Supabase calls; generated `supabase.js`, `db.js`, `auth.html`
- **Debugging** — helped diagnose issues with ES module `import` ordering, Supabase Row Level Security policies, and `async` rendering chains
- **UI copy** — suggested reminder email templates, follow-up suggestion logic, and empty state messages

All AI-generated code was reviewed and adapted. Key AI contributions are marked with `// AI-assisted` comments in the source files.

---

## Challenges and How I Solved Them

**1. Migrating from localStorage to Supabase mid-project**
The original app stored all data in localStorage. Switching to async Supabase calls required rewriting every render function to be `async` and restructuring the boot sequence into an async IIFE. Solved by building a dedicated `db.js` abstraction layer first, then updating `app.js` to call it.

**2. Writing large JS files via terminal**
Attempts to write the new `app.js` using terminal heredocs failed catastrophically because backtick template literals and emoji in the JS code confused the shell parser. Solved by writing a small Python file-write script to `/tmp` and running it instead.

**3. ES module scope on GitHub Pages**
`type="module"` scripts are deferred automatically and require CORS-safe hosting. GitHub Pages serves files over HTTPS, which satisfies this. Local development required VS Code Live Server instead of opening `file://` URLs directly.

**4. Row Level Security**
Supabase tables needed RLS policies so each user can only see their own data. Solved by adding `auth.uid() = user_id` policies to all 5 tables via the Supabase SQL editor.

---

## Future Improvements

- **Internship analytics dashboard** — charts showing log frequency, skills mentioned most, top impact areas (Chart.js)
- **Email reminder delivery** — send actual follow-up reminder emails via a serverless function (Resend API)
- **Contact import from LinkedIn** — paste a LinkedIn profile URL and auto-populate contact fields
- **PWA / offline mode** — make the app installable on mobile with a service worker
- **AI summary polish** — use OpenAI API to rewrite the weekly summary in a more natural tone
- **Tag-based log filtering** — filter impact logs by skill tag on the dashboard

---

## Run Locally

1. Clone the repository
2. Open with VS Code and run **Live Server** (needed for ES module `import` to work)
3. Sign up for an account at the `/auth.html` page
4. The app uses a shared Supabase project — your data is private via Row Level Security

---

## Project Structure

```
internship-tracker/
├── index.html        # Dashboard
├── network.html      # Networking CRM
├── summary.html      # Weekly summary generator
├── contact.html      # Individual contact profile
├── auth.html         # Sign in / sign up
├── app.js            # Main application logic (ES module)
├── db.js             # Supabase data access layer
├── supabase.js       # Supabase client + auth helpers
├── styles.css        # All styles (responsive)
└── README.md
```
