// Wires the phone layout into the replay viewer: run it after copying a new player from F1 Pit Wall.
//   node tools/add-mobile-player.mjs
// Adds mobile.css and mobile.js (both in replays/player/) to replays/player/index.html, once.
import { readFile, writeFile } from "node:fs/promises";

const page = new URL("../replays/player/index.html", import.meta.url);
const CSS = '<link rel="stylesheet" href="mobile.css">';
const JS = '<script src="mobile.js" defer></script>';

let html = await readFile(page, "utf8");
let changed = false;
for (const [tag, before] of [[CSS, "</head>"], [JS, "</body>"]]) {
  if (html.includes(tag)) continue;
  const at = html.lastIndexOf(before);
  if (at < 0) throw new Error(`replays/player/index.html has no ${before}: is it the Pit Wall player?`);
  html = html.slice(0, at) + tag + "\n" + html.slice(at);
  changed = true;
}
if (changed) await writeFile(page, html);
console.log(changed ? "Phone layout added to replays/player/index.html" : "Phone layout already in replays/player/index.html");
