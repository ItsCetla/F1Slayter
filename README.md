# Slayter League — f1.cetla.dev

Website for the Slayter League, a CETLA league racing the F1 video game. A static site
(plain HTML, CSS and ES modules, no build step) hosted on GitHub Pages from `main`.

## Pages

| URL | What it shows |
| --- | --- |
| `/` | Next race + countdown, latest result, standings snapshot, champion, schedule, season stats |
| `/schedule/` | Every round of a season with status, podiums, countdown and an "Add to calendar" (.ics) download |
| `/results/` | Season results summary; `?round=N` shows a race classification |
| `/standings/` | Driver standings; `?view=teams` for team standings |
| `/drivers/` | Driver cards; `?id=<driver id>` shows a driver profile with career stats |
| `/analytics/` | Timeline playback, insights and charts (points, gaps, positions, heatmap, form, head-to-head) |

Every page takes `?season=<season id>` (the header's season picker sets it); without it the
active season is shown. Links from the old site (`pages/*.html`, `analytics.html`) redirect to
the new pages.

## Updating the data

Everything lives in **`data/league.json`**. Standings, points, wins, podiums, gaps, form and the
"next race" are all calculated from race results, so the only thing you ever enter is who
finished where.

### Add a race result

Find the round in the season's `rounds` and fill its `results` — one line per league driver,
using the race position they actually finished (AI cars included, so P14 is fine):

```json
"results": [
  {"driver": "tastethebo", "team": "Williams", "position": 1},
  {"driver": "cbreezyll", "team": "Ferrari", "position": 2, "fastestLap": true},
  {"driver": "comanderhp", "team": "Red Bull", "position": 9}
]
```

- `driver` is the driver's `id` (their name or an alias also works).
- `team` is the team they drove for in that race (colours come from the `teams` list).
- Points follow `league.points` (25-18-15-12-10-8-6-4-2-1). To override a single result, add
  `"points": 12`. Set `"fastestLapPoint": true` in `league` if fastest lap should earn a point.
- Leave out drivers who didn't start; the site shows them as DNS.
- Optional `"highlights": ["...", "..."]` on the round shows on the results page.

### Schedule a round

```json
{
  "round": 3,
  "name": "Bahrain",
  "grandPrix": "Bahrain Grand Prix",
  "circuit": "Bahrain International Circuit",
  "country": "BH",
  "laps": 57,
  "lengthKm": 5.412,
  "start": "2026-10-20T20:00:00-04:00",
  "trackImage": "assets/tracks/bahrain.avif",
  "results": []
}
```

- `start` is ISO-8601 with the UTC offset (`-04:00` during US daylight time, `-05:00` after
  early November). Times display in the league time zone (`league.timezone`).
- `country` is a two-letter code; it drives the flag.
- A round with a past `start` and no results shows as "Results pending". Add
  `"status": "cancelled"` to a round that won't run.
- Track maps live in `assets/tracks/`. Rounds without one show a placeholder.

### Start a new season

Add an object to `seasons` with `"status": "active"` and set the previous one to
`"status": "complete"` (that's what crowns its champion):

```json
{
  "id": "season-3",
  "label": "Season 3",
  "year": 2027,
  "status": "active",
  "entries": [{"driver": "tastethebo", "team": "Williams"}],
  "rounds": []
}
```

`entries` (optional) lists the roster before any race is run; once results exist the roster
comes from them.

### Add a driver

Add them to `drivers`: `{"id": "newdriver", "name": "NewDriver", "code": "NEW"}`. `aliases`
lets an old gamertag resolve to the same driver.

### Check your edit

The browser console warns about data problems (unknown drivers, two drivers in the same
position, unreadable dates). With Node installed you can also run the tests:

```bash
node --test tests/league.test.mjs
```

## Running locally

The pages load `data/league.json` with `fetch`, so open them through a local server rather
than `file://`:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000/
```

## Code layout

```
index.html                 home page
schedule/ results/ standings/ drivers/ analytics/   one index.html per page
404.html                   GitHub Pages not-found page
data/league.json           all league data
assets/js/league.js        data model: loads league.json, derives standings and stats
assets/js/ui.js            page shell (header, nav, season picker, footer) + helpers
assets/js/pages/*.js       one script per page
assets/css/f1.css          design system
assets/css/pages/*.css     page-specific styles
assets/tracks/             circuit maps
tests/                     node --test unit tests for the data model
pages/, analytics.html     redirects from the old site's URLs
```

External resources: Google Fonts (Titillium Web), country flags from the `flag-icons` package on
jsDelivr, and Chart.js 4.4.1 on the analytics page.

Not affiliated with Formula 1, the FIA or any team.
