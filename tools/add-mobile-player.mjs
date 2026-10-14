// Puts this site's phone additions into the replay viewer: run it after copying a new player from F1 Pit Wall.
//   node tools/add-mobile-player.mjs
// 1. index.html loads the phone layout (replays/player/mobile.css and mobile.js).
// 2. replay3d.js keeps a phone's 3D picture sharp. The player renders one pixel per CSS pixel whenever it is
//    below full effects, which it always is on a phone; a phone screen packs about three, so the race came out
//    blurred. On a phone it now renders at the screen's own sharpness (up to 3; 2 when the phone is struggling),
//    within a pixel budget (2 million pixels, 1.2 million when struggling).
//    A desktop's rule is unchanged.
// Each step is done once: running it again changes nothing.
import { readFile, writeFile } from "node:fs/promises";

const file = name => new URL(`../replays/player/${name}`, import.meta.url);
const notes = [];

async function edit(name, steps) {
  let text = await readFile(file(name), "utf8");
  const before = text;
  for (const { done, find, put } of steps) {
    if (text.includes(done)) continue;
    if (!text.includes(find)) throw new Error(`replays/player/${name}: can't find where to put "${done}". Has the player changed? Look at tools/add-mobile-player.mjs.`);
    text = text.replace(find, put);
  }
  if (text !== before) { await writeFile(file(name), text); notes.push(`${name} updated`); }
  else notes.push(`${name} already has it`);
}

await edit("index.html", [
  { done: '<link rel="stylesheet" href="mobile.css">', find: "</head>", put: '<link rel="stylesheet" href="mobile.css">\n</head>' },
  { done: '<script src="mobile.js" defer></script>', find: "</body>", put: '<script src="mobile.js" defer></script>\n</body>' },
]);

const SHARP = `// f1.cetla.dev: how many device pixels each CSS pixel of the picture gets (put here by tools/add-mobile-player.mjs).
// A desktop as the player has it. A phone draws at its screen's own sharpness (up to 3; 2 once it is struggling and
// its effects are down), whatever effects are off, within about 2 million pixels for the whole picture (1.2 million
// once it is struggling): more was sharper but too slow for a phone with the circuit's full scenery.
const PHONE_SCREEN = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 600;
function sharpness(w, h) {
  const dpr = window.devicePixelRatio || 1;
  if (!PHONE_SCREEN) return quality > 1 ? Math.min(dpr, 2) : 1;
  return Math.max(1, Math.min(dpr, quality > 0 ? 3 : 2, Math.sqrt((quality > 0 ? 2e6 : 1.2e6) / Math.max(1, w * h))));
}
`;
await edit("replay3d.js", [
  { done: "function sharpness(w, h)", find: "function resize() {", put: SHARP + "function resize() {" },
  { done: "const pr = set ? 1 : sharpness(w, h);", find: "const pr = set ? 1 : quality > 1 ? Math.min(window.devicePixelRatio || 1, 2) : 1;", put: "const pr = set ? 1 : sharpness(w, h);" },
  // (a copy made with an earlier version of this: 2.6 million pixels, which a phone could not keep up with)
  { done: "Math.sqrt((quality > 0 ? 2e6 : 1.2e6) / Math.max(1, w * h))", find: "Math.sqrt(2.6e6 / Math.max(1, w * h))", put: "Math.sqrt((quality > 0 ? 2e6 : 1.2e6) / Math.max(1, w * h))" },
  { done: "// once it is struggling): more was sharper but too slow for a phone with the circuit's full scenery.", find: "// its effects are down), whatever effects are off, and never past about 2.6 million pixels for the whole picture.", put: "// its effects are down), whatever effects are off, within about 2 million pixels for the whole picture (1.2 million\n// once it is struggling): more was sharper but too slow for a phone with the circuit's full scenery." },
  { done: "sun.castShadow = quality > 0; resize(); }", find: "sun.castShadow = quality > 0; renderer.setPixelRatio(quality > 1 ? Math.min(window.devicePixelRatio || 1, 2) : 1); }", put: "sun.castShadow = quality > 0; resize(); }" },
]);
console.log(notes.join("\n"));
