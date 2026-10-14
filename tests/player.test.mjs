// The replay viewer's page is copied in from F1 Pit Wall; the phone layout is ours and is wired in by
// tools/add-mobile-player.mjs, which also keeps a phone's 3D picture sharp; tools/lighten-player.mjs and
// tools/slim-player-models.py make it lighter to run. This fails if a new copy of the
// player went in without them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";

const at = p => new URL(`../replays/player/${p}`, import.meta.url);

test("the replay viewer carries the phone layout", async () => {
  const html = await readFile(at("index.html"), "utf8");
  assert.ok(html.includes('<link rel="stylesheet" href="mobile.css">'), "run: node tools/add-mobile-player.mjs");
  assert.ok(html.includes('<script src="mobile.js" defer></script>'), "run: node tools/add-mobile-player.mjs");
  await access(at("mobile.css"));
  await access(at("mobile.js"));
  const module = await readFile(at("replay3d.js"), "utf8");
  assert.ok(module.includes("const pr = set ? 1 : sharpness(w, h);"), "the phone's sharp 3D picture is missing: run node tools/add-mobile-player.mjs");
});

test("the replay viewer is lightened for phones and laptops", async () => {
  const module = await readFile(at("replay3d.js"), "utf8"), html = await readFile(at("index.html"), "utf8");
  const run = "run: node tools/lighten-player.mjs";
  assert.ok(module.includes("With o.listed (the masts) each block knows which of the"), "scenery is not split into blocks: " + run);
  assert.ok(module.includes("ready = true; api.quality = quality;"), "a phone's effects are not put down: " + run);
  assert.ok(/^const F1_REAL = .*\(tools\/lighten-player\.mjs\)$/m.test(module), "the player asks for team cars that are not here: " + run);
  assert.ok(html.includes("let drawnFor = 0, touchedAt = 0;"), "the 3D picture has no frame cap: " + run);
});

test("the viewer's models carry no big PNG or JPEG pictures", async () => {
  const { readdir } = await import("node:fs/promises");
  const heavy = [];
  for (const dir of ["rides/local", "venue/local"]) {
    let names = [];
    try { names = await readdir(at(dir)); } catch { continue; }      // (a copy of the player without them is fine)
    for (const name of names.filter(n => n.endsWith(".glb"))) {
      const buf = await readFile(at(`${dir}/${name}`));
      const doc = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString());
      const big = i => (i.mimeType === "image/png" || i.mimeType === "image/jpeg") && doc.bufferViews[i.bufferView].byteLength > 256000;      // (small ones stay when WebP is no smaller)
      if ((doc.images || []).some(big)) heavy.push(`${dir}/${name}`);
    }
  }
  assert.deepEqual(heavy, [], "run: python3 tools/slim-player-models.py");
});
