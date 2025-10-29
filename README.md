# F1 Slayter League Leaderboard

A single-page, front-end only dashboard for managing the Slayter League's Formula-style championship. The page features an interactive leaderboard, quick stats, and an AI-friendly session database that can be updated directly in the browser.

## Features

- Responsive hero and dashboard layout with F1-inspired styling.
- Interactive standings table with multiple sorting options.
- Highlight cards for leader, wins champion, and momentum "Driver to Watch" insights.
- Session database with recent event summaries sourced from the data file.
- Clipboard-friendly JSON snapshot for use with AI tools or reporting.

## Usage

Open `index.html` in any modern browser.

Driver standings, session history, and insight cards are powered by the data structures inside `script.js`. Update the driver or session arrays in that file to reflect new results, then refresh the page to see the latest information.

Use the **Copy JSON Snapshot** button to grab the full data model (standings + sessions) for quick sharing with AI copilots, commentators, or analytics scripts.
