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
| `rides/local/` | cars somebody else made, cut down for the replay (the F1 car and its driver, the film's DeLorean, the Warthogs and their crew), and `f1_stickers.glb`, the teams' sticker sheets. Each is looked for first; where a file is not there the player draws what it drew before |
| `venue/` | photographs of the road, its paint, gravel, concrete, sand and fence (public domain) |
| `venue/local/` | what stands round a circuit: grandstands, the pit building, plants, lamps (made for this), and boards, tyre walls, masts and palms that somebody else made |
| `sounds/local/` | the engines (the Engines menu): four of them, a `.wav` and a `.json` each, and `index.json`. Without this folder there is no menu |
| `credits.json` | who made what, and under which licence: the Credits button shows it. Made from what each file says of itself |

- `replays/player/` opens the only race there is, or lists them when there are several (`?list` always lists).
- `replays/player/?race=<id>` opens one race. Add `&embed=1` for a copy with only the picture and the scrubber,
  made for an `<iframe allowfullscreen>`.
- A new race: copy the newer `races` folder over this one (its `index.json`, and the new race's folder).
  The player picks it up by itself.
- For the site's own Replay buttons, give the round its link in `data/league.json`:
  `"replay": "https://f1.cetla.dev/replays/player/?race=<id>"`
- The 3D view fetches three.js from cdn.jsdelivr.net and the typeface from fonts.googleapis.com. Without the
  first, the map still works.

## What is whose

Until 13 October 2026 the three `local` folders stayed on Eric's PC and the site drew its own stand-ins. They are
here at his word ("add everything"), and whoever keeps the site should know what they are putting up:

- **Open licences that ask only to be named** (the Credits button names them): the F1 car, the boards, tyre walls,
  mast and palm. The stands, pit building, plants and lamps were made for this and are ours.
- **Other companies' property, here on Eric's say-so**: `rides/local/f1_stickers.glb` (the real teams' and
  sponsors' marks); `warthog_a/b/c.glb` and `chief.glb` (Halo: a game's own models, whatever licence their
  uploaders put on them); `delorean.glb` (the film's car; its uploader's licence is non-commercial, share-alike).
- **The engines** in `sounds/local/` were cut from Formula 1's own broadcasts.

The second and third could be asked to come down. To leave any of it off the site, delete the file or the folder:
the player notices and carries on without it (plain paint and the league's own lettering for the stickers, the
sculpted or typed-in car for a model, no Engines menu for the sounds).
