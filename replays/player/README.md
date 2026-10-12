# Race replay player

Every car of a race, lap by lap, drawn from the game's own telemetry: a 2D map and a 3D view, a timing tower,
the followed car in detail, race control, and a scrubber with every highlight on it. Made by F1 Pit Wall.

Plain files, no build step and no server code. This folder goes at `replays/player/` in the site.

| File | What it is |
|---|---|
| `index.html`, `replay3d.js` | the player |
| `races/index.json` | the list of races, which the player reads to know what there is |
| `races/<id>/replay.bin` | a race (a few MB) |
| `races/<id>/voice.bin` | its commentary voices, fetched after the race itself; a race without this file is silent |
| `rides/` | the sculpted car skins (the Cars menu): each is fetched when it is picked; without this folder the skins are drawn from plain shapes |

- `replays/player/` opens the only race there is, or lists them when there are several (`?list` always lists).
- `replays/player/?race=<id>` opens one race. Add `&embed=1` for a copy with only the picture and the scrubber,
  made for an `<iframe allowfullscreen>`.
- A new race: copy the newer `races` folder over this one (its `index.json`, and the new race's folder).
  The player picks it up by itself.
- For the site's own Replay buttons, give the round its link in `data/league.json`:
  `"replay": "https://f1.cetla.dev/replays/player/?race=<id>"`
- The 3D view fetches three.js from cdn.jsdelivr.net and the typeface from fonts.googleapis.com. Without the
  first, the map still works.
