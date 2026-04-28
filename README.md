# InternTrack

InternTrack is a website I built to help students keep track of everything that happens during their internship. You can log what you worked on each day, keep track of people you meet, and even generate a weekly update email to send to your manager. Basically it's like a personal journal + contact book just for internships.

---

## Live Demo

[https://davinali.github.io/internship-tracker](https://davinali.github.io/internship-tracker)

You need to make a free account to use it. Your data is saved to the cloud so it won't disappear if you close the tab.

---

## Features

Here's everything you can do with InternTrack:

- Add your internships and switch between them if you have more than one
- Write daily logs of what you worked on, what skills you used, and what impact you made
- Upload PDFs like your offer letter, resume, or project docs to each internship
- Click a button and get a pre-written weekly update email ready to send to your manager
- Add networking contacts (people you met at work or events) with their name, company, and role
- Log every time you talk to a contact — coffee chats, emails, meetings, etc.
- Get reminders when it's been too long since you reached out to someone
- See AI suggestions for what to say or do next with a contact
- Switch between light mode and dark mode

---

## Technologies Used

- **HTML** — the structure of every page
- **CSS** — all the styling and making it look nice, including making it work on mobile
- **JavaScript** — all the interactive stuff like forms, buttons, and loading data
- **Supabase** — this is where all the data gets saved (like a Google Sheets but for apps). It also handles login and making sure you can only see your own data
- **Quotable API** — a free public API that gives a random motivational quote
- **localStorage** — saves small things in your browser like whether you prefer dark mode

---

## AI Tools Used

I used **Claude** (through GitHub Copilot) to help me build this project.

Here's specifically how it helped:

- Helped me figure out how to set up my database structure with 5 tables (users, internships, logs, files, contacts)
- Generated a lot of the JavaScript code, especially the parts that connect to Supabase
- Helped me fix bugs when things weren't loading in the right order or the login wasn't working
- Suggested wording for things like reminder messages and empty state text

I still had to review all the code, adjust it to fit my project, and make a lot of decisions myself. AI wrote the first draft of a lot of things but I had to actually understand it and make it work together.

---

## Challenges I Faced

**1. Switching from saving data in the browser to saving it in the cloud**

At first I was saving everything in localStorage (basically the browser's memory). But that meant your data would disappear if you switched browsers or cleared your cache. I had to completely rewrite how data gets saved so it uses Supabase instead. This was really hard because I had to change almost every function in my JavaScript file to be "async" (meaning it waits for the data to load before doing anything).

**2. Writing a really long JavaScript file**

My main JS file ended up being over 2000 lines. At one point when I tried to write it using the terminal, the file got corrupted because some characters like backticks and emoji confused the terminal. I had to use a Python script to write the file safely instead.

**3. Getting the login system to work**

I wanted each user to only see their own data. Supabase has a feature called Row Level Security that makes this work, but I had to set it up manually for all 5 of my database tables. It took a while to figure out the right settings.

**4. ES Modules not working locally**

My JavaScript uses a newer feature called ES Modules (the import/export system). This doesn't work if you just open the HTML file by double-clicking it — you have to use a local server. I had to use VS Code's Live Server extension for local testing.

---

## Future Improvements

If I had more time, I would add:

- Charts showing how often you logged, what skills came up most, etc.
- Actually sending reminder emails instead of just showing a reminder on screen
- A way to import contacts directly from LinkedIn
- Making it work offline like a real app you can install on your phone
- Better AI-generated summaries using the OpenAI API
- Filtering your logs by skill tag so you can find entries faster

---

## Project Structure

```
internship-tracker/
├── index.html        # Main workspace page
├── network.html      # Networking contacts page
├── contact.html      # Individual contact profile page
├── auth.html         # Login and sign up page
├── files.html        # Files page
├── css/
│   └── style.css     # All the styles
├── js/
│   ├── main.js       # Main JavaScript logic
│   ├── db.js         # Functions for reading/writing to Supabase
│   └── supabase.js   # Supabase connection and login helpers
├── assets/
│   └── images/       # Image files
└── README.md
```
