# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

f1.cetla.dev, the site for the Slayter League (a CETLA league racing the F1 video game).
Static GitHub Pages site deployed from `main`: plain HTML/CSS/ES modules, no build step, no
framework. The look is modelled on formula1.com, but it must never use the F1 logo or imply
it is an official F1 site.

## Data

- `data/league.json` is the only data source. See README.md for the schema and editing workflow.
- Never store totals (points, wins, podiums). `assets/js/league.js` derives everything from
  `results` (`position`, optional `fastestLap`, optional `points` override).
- AI drivers are not stored. `position` is the real race position, so gaps in positions are normal.
- Season `status`: `active` (the default season shown) or `complete` (crowns a champion).
  Round status is derived: complete / awaiting-results / scheduled, or `"status": "cancelled"`.
- Keep `league.json` formatted with one result per line so it stays easy to edit by hand.

## Code

- `assets/js/league.js`: pure data functions with no DOM access. Covered by `tests/league.test.mjs`.
- `assets/js/ui.js`: shared page shell. `initPage(key)` renders the header and footer, loads the
  data and returns `{ league, season, params }`. It also holds the HTML helpers (`esc`, `link`,
  `driverId`, `finishChip`, `fmt.*`).
- `assets/js/pages/<page>.js` and `assets/css/pages/<page>.css`: one per page. Shared styles go in
  `assets/css/f1.css`.
- Escape every data value that goes into HTML with `esc()`. Build internal links with `link()`
  so the selected `?season=` is kept.
- `pages/*.html` and `analytics.html` are redirects for old URLs. Keep them.

## Commands

```bash
node --test tests/league.test.mjs     # data model tests
python3 -m http.server 8000           # serve locally, then open http://localhost:8000/
```
