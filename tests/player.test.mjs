// The replay viewer's page is copied in from F1 Pit Wall; the phone layout is ours and is wired in by
// tools/add-mobile-player.mjs. This fails if a new copy of the player went in without it.
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
});
