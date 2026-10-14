// Makes the replay viewer lighter to run on phones and laptops: run it after copying a new player from F1 Pit Wall,
// after tools/add-mobile-player.mjs (python3 tools/slim-player-models.py does the same for the models' pictures).
//   node tools/lighten-player.mjs
// Each step is done once and fails loudly if the player has changed under it; running it again changes nothing.
//
// Everywhere:
//   - Props stood all round the circuit (palms, trees, shrubs, tyre walls, boards, marshal posts) were one drawing
//     each, as big as the circuit, so the graphics card drew every one of them every frame, and drew them again
//     into the shadows, wherever the camera was. The floodlight masts alone were 1.3 million triangles a frame.
//     They are now drawn in blocks of about 200 m, and a block out of the picture, or out of the shadows' reach,
//     is skipped. (A mast that would stand in front of a trackside camera is still hidden: each block of masts
//     knows which masts it holds.)
//   - On a 120 or 144 Hz screen the 3D picture is drawn every other refresh (60 or 72 times a second, where it was
//     twice that for nothing), and at 30 while the replay is paused and nobody is moving the camera.
//   - The player asked for a model of every team's own car one after another, ten files that are not here, before
//     it would show the cars. It now asks only for those that are in replays/player/rides/local.
// On a phone:
//   - Effects come down as the player means them to: it asked for no glow on a phone, but asked before the 3D view
//     was set up, so the glow stayed on.
//   - A car is drawn as the plain model from closer in (the detailed one is ten times the work), the floodlight
//     masts are the plain poles the player draws (the model is 5,700 triangles a mast, 226 masts), and the crowds
//     in the stands and the furniture inside the pit garages are left out: about 18 MB less to download.
import { readFile, writeFile, readdir } from "node:fs/promises";

const file = name => new URL(`../replays/player/${name}`, import.meta.url);
const notes = [];

async function edit(name, steps, also = text => text) {
  let text = await readFile(file(name), "utf8");
  const before = text;
  for (const { done, find, put } of steps) {
    if (text.includes(done)) continue;
    if (!text.includes(find)) throw new Error(`replays/player/${name}: can't find where to put "${done.slice(0, 80)}". Has the player changed? Look at tools/lighten-player.mjs.`);
    text = text.replace(find, put);
  }
  text = also(text);
  if (text !== before) { await writeFile(file(name), text); notes.push(`${name} updated`); }
  else notes.push(`${name} already has it`);
}

// ---- replay3d.js

if (!(await readFile(file("replay3d.js"), "utf8")).includes("const PHONE_SCREEN")) throw new Error("run node tools/add-mobile-player.mjs first: this uses its PHONE_SCREEN");

const CHUNKED = `function vCopies(lay, parts, places, o = {}) {      // a prop stood in many places: [x, y, z, turned so far about the upright, how big]; o.wear(kind, part) may give a part another material
  // f1.cetla.dev (tools/lighten-player.mjs): stood in blocks of about 200 m, each a drawing of its own, so the ones out
  // of the picture or out of the shadows' reach are skipped. With o.listed (the masts) each block knows which of the
  // places it holds (userData.at: place → its own index), for mastsOutOf().
  const d = new THREE.Object3D(), made = [];
  if (!places.length) return made;
  const blocks = new Map();
  places.forEach((p, n) => { const key = Math.floor(p[0] / 200) + ":" + Math.floor(p[2] / 200); if (!blocks.has(key)) blocks.set(key, []); blocks.get(key).push(n); });
  for (const p of parts) {
    const material = (o.wear && o.wear(p.kind, p)) || p.material;
    for (const block of blocks.values()) {
      const mesh = new THREE.InstancedMesh(p.geometry, material, block.length);
      block.forEach((n, i) => { const [x, y, z, turn = 0, size = 1] = places[n]; d.position.set(x, y, z); d.rotation.set(0, turn, 0); d.scale.setScalar(size); d.updateMatrix(); mesh.setMatrixAt(i, d.matrix); });
      mesh.computeBoundingSphere();
      if (o.listed) mesh.userData.at = new Map(block.map((n, i) => [n, i]));
      mesh.castShadow = o.cast !== false && p.kind !== "lamp";
      lay.add(mesh); made.push(mesh);
    }
  }
  return made;
}`;
const MASTS_OUT_OLD = `  for (const mesh of mastSet.meshes) {
    const a = mesh.instanceMatrix.array, home = mesh.userData.home;
    for (const j of was) a.set(home.subarray(j * 16, j * 16 + 16), j * 16);
    for (const j of hide) { a.fill(0, j * 16, j * 16 + 16); a[j * 16 + 15] = 1; }      // (shrunk to nothing)
    mesh.instanceMatrix.needsUpdate = true;
  }`;
const MASTS_OUT_NEW = `  for (const mesh of mastSet.meshes) {
    const a = mesh.instanceMatrix.array, home = mesh.userData.home, at = mesh.userData.at;      // (at: a drawing of one block of masts, tools/lighten-player.mjs)
    for (const m of was) { const j = at ? at.get(m) : m; if (j !== undefined) a.set(home.subarray(j * 16, j * 16 + 16), j * 16); }
    for (const m of hide) { const j = at ? at.get(m) : m; if (j !== undefined) { a.fill(0, j * 16, j * 16 + 16); a[j * 16 + 15] = 1; } }      // (shrunk to nothing)
    mesh.instanceMatrix.needsUpdate = true;
  }`;
const ORIGINAL_COPIES = `function vCopies(lay, parts, places, o = {}) {      // a prop stood in many places: [x, y, z, turned so far about the upright, how big]; o.wear(kind, part) may give a part another material
  const d = new THREE.Object3D(), made = [];
  if (!places.length) return made;
  for (const p of parts) {
    const mesh = new THREE.InstancedMesh(p.geometry, (o.wear && o.wear(p.kind, p)) || p.material, places.length);
    places.forEach(([x, y, z, turn = 0, size = 1], i) => { d.position.set(x, y, z); d.rotation.set(0, turn, 0); d.scale.setScalar(size); d.updateMatrix(); mesh.setMatrixAt(i, d.matrix); });
    mesh.castShadow = o.cast !== false && p.kind !== "lamp";
    lay.add(mesh); made.push(mesh);
  }
  return made;
}`;

const here = new Set((await readdir(file("rides/local"))).filter(n => n.endsWith(".glb")).map(n => n.slice(0, -4)));

await edit("replay3d.js", [
  { done: "With o.listed (the masts) each block knows which of the", find: ORIGINAL_COPIES, put: CHUNKED },
  { done: `{ wear: kind => (kind === "lamp" ? lit : steel), listed: true }`, find: `{ wear: kind => (kind === "lamp" ? lit : steel) }`, put: `{ wear: kind => (kind === "lamp" ? lit : steel), listed: true }` },
  { done: MASTS_OUT_NEW, find: MASTS_OUT_OLD, put: MASTS_OUT_NEW },
  // a phone keeps the plain floodlight poles the player draws until the masts' model comes (5,700 triangles a mast)
  { done: 'if (own && !PHONE_SCREEN) vModel("mast"', find: '  if (own) vModel("mast", parts => {', put: '  if (own && !PHONE_SCREEN) vModel("mast", parts => {' },
  // a phone leaves out the crowds and the pit garages' furniture (what the stand's own file says each kit is)
  { done: "if (PHONE_SCREEN && /seats and people|^ASSET/i.test(kit.what || \"\")) continue;",
    find: "    for (const kit of (about && about.kits) || []) vModel(kit.file, kparts => vCopies(home, kparts, kit.places.map(([x, y, z, turn]) => [x, z, -y, turn, 1]), { cast: false, wear: (kind, part) => vLook(part.material) }));",
    put: "    for (const kit of (about && about.kits) || []) { if (PHONE_SCREEN && /seats and people|^ASSET/i.test(kit.what || \"\")) continue; vModel(kit.file, kparts => vCopies(home, kparts, kit.places.map(([x, y, z, turn]) => [x, z, -y, turn, 1]), { cast: false, wear: (kind, part) => vLook(part.material) })); }" },
  // the effects asked for before the 3D view was set up are put on when it is
  { done: "ready = true; api.quality = quality;      // (tools/lighten-player.mjs)", find: "  ready = true;\n}", put: "  ready = true; api.quality = quality;      // (tools/lighten-player.mjs)\n}" },
  // a phone, or a machine that is struggling, draws the plain car from closer in
  { done: "const near = PHONE_SCREEN || quality < 2 ? 0.55 : 1, far = alt.far ? size > 30 * near : size > 36 * near;",
    find: "const far = alt.far ? size > 30 : size > 36;",
    put: "const near = PHONE_SCREEN || quality < 2 ? 0.55 : 1, far = alt.far ? size > 30 * near : size > 36 * near;" },
], text => {
  // only the teams' own cars that are really here. Eric's list is kept on the line, so this can be run again when a
  // model is added, and a new copy of the player brings his list back as it was.
  const line = /^const F1_REAL = (\[[^\]]*\]);(?:.*?\(of (\[[^\]]*\])\))?.*$/m, m = text.match(line);
  if (!m) throw new Error("replays/player/replay3d.js: can't find F1_REAL. Look at tools/lighten-player.mjs.");
  const all = JSON.parse(m[2] || m[1]);
  return text.replace(line, `const F1_REAL = ${JSON.stringify(all.filter(id => here.has(id)))};      // f1.cetla.dev: those in rides/local (of ${JSON.stringify(all)}) (tools/lighten-player.mjs)`);
});

// ---- index.html

await edit("index.html", [
  // the 3D picture at most 60 times a second, 30 while paused and left alone
  { done: "let drawnFor = 0, touchedAt = 0;",
    find: "let towerAt = 0, slowFor = 0;",
    put: "let towerAt = 0, slowFor = 0;\n" +
         "// f1.cetla.dev (tools/lighten-player.mjs): the 3D picture is drawn every other refresh on a 120 or 144 Hz screen, and\n" +
         "// at 30 a second while the replay is paused and nobody has touched it for a second (a frame is drawn once 10.7 ms,\n" +
         "// or 27.3 ms, have gone by: a 60 or 90 Hz screen keeps every frame however unevenly they come)\n" +
         "let drawnFor = 0, touchedAt = 0;\n" +
         "for (const ev of [\"pointerdown\", \"pointermove\", \"wheel\", \"keydown\", \"touchmove\"]) addEventListener(ev, () => { touchedAt = performance.now(); }, { passive: true });" },
  { done: "drawnFor += dtSec; if (drawnFor >= (playing || now - touchedAt < 1000 ? 0.0107 : 0.0273) || manual)",
    find: "if (view3d && window.Stage3D) { Stage3D.render(T, dtSec); if (building) { building = false; $(\"stageNote\").hidden = true; } } else renderMap(dtSec);",
    put: "if (view3d && window.Stage3D) { drawnFor += dtSec; if (drawnFor >= (playing || now - touchedAt < 1000 ? 0.0107 : 0.0273) || manual) { Stage3D.render(T, drawnFor); drawnFor = 0; } if (building) { building = false; $(\"stageNote\").hidden = true; } } else renderMap(dtSec);" },
]);

console.log(notes.join("\n"));
