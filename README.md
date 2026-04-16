# InternTrack MVP

InternTrack is a clean, minimal internship activity tracker for students.

## Features

- Dashboard for daily/weekly logs
- File name tracking (MVP stores names only)
- Networking tracker with delete support
- Weekly summary generator (formal/casual tone)
- Copy summary to clipboard
- Weekly insight quote via Quotable API
- Local persistence via `localStorage`
- Light/dark theme toggle
- Responsive layout for mobile + desktop

## Tech Stack

- HTML
- CSS
- Vanilla JavaScript
- `localStorage`
- Quotable API: https://api.quotable.io/random

## Run Locally

Open [index.html](index.html) in your browser.

For best behavior with fetch APIs, use a local static server (optional), for example with VS Code Live Server.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, choose:
	- **Source**: Deploy from a branch
	- **Branch**: `main` (or your default), folder `/ (root)`
4. Save and wait for deployment.
5. Your public URL will appear in the Pages section.

## Pages

- [Dashboard](index.html)
- [Networking Tracker](network.html)
- [Weekly Summary](summary.html)

