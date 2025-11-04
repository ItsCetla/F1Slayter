# F1 Slayter League Leaderboard

A single-page, front-end only dashboard for managing the Slayter League's Formula-style championship. The page features an interactive leaderboard, quick stats, and an AI-friendly session database that can be updated directly in the browser.

## Features

- Responsive hero and dashboard layout with F1-inspired styling.
- Interactive standings table with multiple sorting options.
- Highlight cards for leader, wins champion, and momentum "Driver to Watch" insights.
- Session database with recent event summaries sourced from the CSV data file.
- Dedicated analytics page highlighting points trajectories, team comparisons, and current form trends.
- Clipboard-friendly JSON snapshot for use with AI tools or reporting.

## Usage

Open `index.html` in any modern browser.

Driver standings, session history, and insight cards are powered by the records inside `data/league-data.csv`. Update the CSV with your latest races, then refresh the page to see the new information reflected across the dashboard.

Use the **Copy JSON Snapshot** button to grab the full data model (standings + sessions) for quick sharing with AI copilots, commentators, or analytics scripts.

## Data format

`data/league-data.csv` accepts three record types that let you manage standings and race history without editing JavaScript:

| `recordType` value | Purpose | Required fields |
| ------------------ | ------- | --------------- |
| `driver` | Aggregate data for a single driver. | `driverName`, `driverCode` (optional), `team`, `points`, `wins`, `podiums`, `fastestLaps`, `previousRank` (optional), `consistencyIndex` (optional) |
| `session` | Summary of a session/event. Use the `highlights` column to provide a pipe (`|`) separated list of headline moments. | `sessionDate`, `sessionName`, `highlights` (optional) |
| `session-result` | Classified results for a driver in a specific session. Add one row per finisher. | `sessionDate`, `sessionName`, `driverName`, `team` (optional), `position`, `points`, `fastestLap` (`true`/`false`) |

Populate as many rows as needed—standings and cards will automatically recalculate based on the CSV contents. Leave the header row in place and keep the file encoded as UTF-8 for best results.
