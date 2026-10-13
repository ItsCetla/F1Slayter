// Puts this site's phone additions into the replay viewer: run it after copying a new player from F1 Pit Wall.
//   node tools/add-mobile-player.mjs
// 1. index.html loads the phone layout (replays/player/mobile.css and mobile.js).
// 2. replay3d.js keeps a phone's 3D picture sharp. The player renders one pixel per CSS pixel whenever it is
//    below full effects, which it always is on a phone; a phone screen packs about three, so the race came out
//    blurred. On a phone it now renders at up to two (1.5 when the phone is struggling), within a pixel budget.
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
// A desktop as the player has it. A phone keeps its sharpness whatever effects are off: up to 2 (1.5 when struggling),
// and never past a budget of about 1.4 million pixels, so a big picture on its side does not swamp the phone.
const PHONE_SCREEN = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 600;
function sharpness(w, h) {
  const dpr = window.devicePixelRatio || 1;
  if (!PHONE_SCREEN) return quality > 1 ? Math.min(dpr, 2) : 1;
  return Math.max(1, Math.min(dpr, quality > 0 ? 2 : 1.5, Math.sqrt(1.4e6 / Math.max(1, w * h))));
}
`;
await edit("replay3d.js", [
  { done: "function sharpness(w, h)", find: "function resize() {", put: SHARP + "function resize() {" },
  { done: "const pr = set ? 1 : sharpness(w, h);", find: "const pr = set ? 1 : quality > 1 ? Math.min(window.devicePixelRatio || 1, 2) : 1;", put: "const pr = set ? 1 : sharpness(w, h);" },
  { done: "sun.castShadow = quality > 0; resize(); }", find: "sun.castShadow = quality > 0; renderer.setPixelRatio(quality > 1 ? Math.min(window.devicePixelRatio || 1, 2) : 1); }", put: "sun.castShadow = quality > 0; resize(); }" },
]);
console.log(notes.join("\n"));
