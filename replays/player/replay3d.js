// The replay in three dimensions: the circuit rebuilt from where the cars' wheels went (track3d.py), every car
// placed and tilted as the game reported it, and cameras that stay on the car you pick.
// Inlined into replay.html by replay_build.py, with replay3d_sky.js and the other parts joined on after it (they
// are one module); talks to the page through window.__stage.
//
// What is surveyed and what is dressing: the road, its kerbs, the pit lane and its boxes, the grid and the cars
// are where the telemetry put them. Everything beyond the kerbs (run-off, walls, stands, lights) is scenery
// laid out by rule round the surveyed road, so the place reads as a circuit at night.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

const S = window.__stage;
const K = S.D.track3d;
const n = K.centre.length, BIN = K.bin;
const LEFT = K.left, RIGHT = K.right;
const RIDE = 0.33;                    // the game's car position sits this far above the road
const TAU = Math.PI * 2;
const canvas = document.getElementById("map3d");
let renderer, composer, bloom, scene, camera, sun, cars = [], ready = false, startLights = [];
let mode = "auto", orbit = { az: 2.5, pol: 1.25, r: 9, up: 0 }, follow = { yaw: null, cut: true };      // up: how far it looks up from the road, once it is down at it
let quality = 2;                      // 2 everything on, 1 no bloom and lighter shadows, 0 plain
let skyRoot = null, hemi = null, fillLight = null, farGround = null;      // what the model on a table (replay3d_toy.js) lights its own way
const nightOnly = [];                 // things that belong to the night: the lamps' glows
const toySkin = [];                   // [a material, how it is in the model's daylight]: what was painted to fade into the dark

// ------------------------------------------------------------------ small helpers
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = k => ((k % n) + n) % n;
const turn = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
const lerpAngle = (a, b, t) => a + turn(a, b) * t;
function seeded(seed) {               // the same scenery every time the page opens
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const rnd = seeded(11);
function ease(values, span) {         // running mean round the closed lap
  const out = new Float32Array(n);
  let sum = 0;
  for (let d = -span; d <= span; d++) sum += values[wrap(d)];
  for (let k = 0; k < n; k++) { out[k] = sum / (2 * span + 1); sum += values[wrap(k + span + 1)] - values[wrap(k - span)]; }
  return out;
}
function tex(w, h, draw, o = {}) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  draw(c.getContext("2d", o.read ? { willReadFrequently: true } : undefined), w, h);      // read: its pixels get looked at afterwards
  const t = new THREE.CanvasTexture(c);
  if (o.srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = o.aniso ?? 8;
  if (o.repeat !== false) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function speckle(c, w, h, base, count, strength = 0.3, size = 2) {
  c.fillStyle = base; c.fillRect(0, 0, w, h);
  for (let i = 0; i < count; i++) {
    c.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${rnd() * strength})` : `rgba(0,0,0,${rnd() * strength * 1.4})`;
    const s = 1 + rnd() * size; c.fillRect(rnd() * w, rnd() * h, s, s);
  }
}

// ------------------------------------------------------------------ geometry kit
function withUV(g) {
  if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  return g;
}
function merge(list) { return mergeGeometries(list.map(g => withUV(g.index ? g.toNonIndexed() : g)), false); }
// one loop of a body's cross-section at station z: a squared-off oval, w half as wide, from y0 up to y1
function ring(z, w, y0, y1, p = 2.5, cx = 0, m = 16) {
  const out = [], cy = (y0 + y1) / 2, h = (y1 - y0) / 2, e = 2 / p;
  for (let j = 0; j < m; j++) {
    const a = j / m * TAU - Math.PI / 2, c = Math.cos(a), s = Math.sin(a);       // from the keel, up the left side, over the top, down the right
    out.push([cx + w * Math.sign(c) * Math.abs(c) ** e, cy + h * Math.sign(s) * Math.abs(s) ** e, z]);
  }
  return out;
}
function lid(r) {                     // a flat lid over a loop of points
  const c = [0, 0, 0], pos = [];
  for (const p of r) for (let a = 0; a < 3; a++) c[a] += p[a] / r.length;
  for (let j = 0; j < r.length; j++) pos.push(...c, ...r[j], ...r[(j + 1) % r.length]);
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  return g;
}
function skin(rings, o = {}) {        // stretch a surface over a row of loops (a nose, a sidepod, a wing)
  // o.map = [x0, x1, y0, y1] wraps part of a picture round it: along the picture runs along the body, up it runs round the loop
  const m = rings[0].length, cols = o.map ? m + 1 : m, pos = [], uv = [], idx = [];
  const far = Math.abs(rings[rings.length - 1][0][2] - rings[0][0][2]) || 1;
  for (const r of rings) for (let j = 0; j < cols; j++) {
    const q = r[j % m];
    pos.push(q[0], q[1], q[2]);
    if (o.map) uv.push(lerp(o.map[0], o.map[1], Math.abs(q[2] - rings[0][0][2]) / far), lerp(o.map[2], o.map[3], j / m));
  }
  for (let i = 0; i + 1 < rings.length; i++) for (let j = 0; j < m; j++) {
    const a = i * cols + j, b = i * cols + (o.map ? j + 1 : (j + 1) % m), c = (i + 1) * cols + (o.map ? j + 1 : (j + 1) % m), d = (i + 1) * cols + j;
    idx.push(a, b, c, a, c, d);
  }
  let g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  if (o.map) g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  if (o.flat) { g = g.toNonIndexed(); g.computeVertexNormals(); } else { g.computeVertexNormals(); g = g.toNonIndexed(); }
  const parts = [g];
  if (o.caps !== false) parts.push(lid(rings[0]), lid(rings[rings.length - 1]));
  return merge(parts);
}
function strut(a, b, w = 0.024, h = 0.012) {      // a flat bar from a to b: a wishbone, a stay
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), g = new THREE.BoxGeometry(w, h, A.distanceTo(B));
  const m = new THREE.Matrix4().lookAt(A, B, new THREE.Vector3(0, 1, 0));
  m.setPosition(A.add(B).multiplyScalar(0.5));
  return g.applyMatrix4(m);
}
const box = (w, h, l, x, y, z) => new THREE.BoxGeometry(w, h, l).translate(x, y, z);

// ------------------------------------------------------------------ the lie of the land
const BANK = K.bank;                  // metres the road rises for each metre to the driver's right, by section
const SLOPE_OUT = 3;                  // the ground beyond the road carries on leaning as the road does for this many metres
const RAMP = [1.5, 4.5];              // and between these, on the pit side, it comes to the level of the pit lane
function at(k, off, lift = 0) {       // the point on the ground `off` metres to the driver's right of the line at section k
  const c = K.centre[wrap(k)], nm = K.normal[wrap(k)];
  return [c[0] + nm[0] * off, verge(k, off) + lift, c[2] + nm[1] * off];
}
const heading = k => { const a = K.centre[wrap(k - 1)], b = K.centre[wrap(k + 1)]; return Math.atan2(b[0] - a[0], b[2] - a[2]); };
// how hard the road bends, per metre: positive to the driver's right
const bend = (() => { const out = new Float32Array(n); for (let k = 0; k < n; k++) out[k] = -turn(heading(k - 1), heading(k + 1)) / (2 * BIN); return out; })();
const lane = K.pitlane ? (() => {
  const L = K.pitlane, count = L.offset.length, where = new Map();
  for (let j = 0; j < count; j++) where.set(wrap(L.from + j), j);
  return { side: L.side || 1, from: L.from, count, has: k => where.has(wrap(k)), j: k => where.get(wrap(k)),
           off: k => L.offset[where.get(wrap(k))], y: k => L.y[where.get(wrap(k))], entry: L.entry || [], exit: L.exit || [] };
})() : null;
const FADE = 30;                      // sections over which the ground beside the pit lane comes back to the level of the road
// how much higher the pit lane's side of the circuit stands than the ground beside the road would, by section
const pitRise = (() => {
  const out = new Float32Array(n);
  if (!lane) return out;
  const first = lane.from, last = lane.from + lane.count - 1;
  const settled = k => K.centre[k][1] + BANK[k] * ((lane.side < 0 ? LEFT : RIGHT)[k] + lane.side * SLOPE_OUT);
  for (let j = 0; j < lane.count; j++) { const k = wrap(first + j); out[k] = lane.y(k) - settled(k); }
  for (let d = 1; d <= FADE; d++) {
    out[wrap(first - d)] = out[wrap(first)] * (1 - d / FADE);
    out[wrap(last + d)] = out[wrap(last)] * (1 - d / FADE);
  }
  return out;
})();
// The height of the ground at section k, `off` metres to the right of the line. The road leans as the survey
// found it (a banked corner, the fall of a straight); the ground beyond carries the lean on a little way and then
// lies level, or beside the pit lane comes to the lane's own level. Everything laid on the ground takes its height
// from here, and so does every wheel: that is what keeps the cars on the road.
function verge(k, off) {
  k = wrap(k);
  const l = LEFT[k], r = RIGHT[k];
  if (off >= l && off <= r) return K.centre[k][1] + BANK[k] * off;
  const sd = off < l ? -1 : 1, e = sd < 0 ? l : r, d = (off - e) * sd;
  const h = K.centre[k][1] + BANK[k] * (e + sd * Math.min(d, SLOPE_OUT));
  return lane && sd === lane.side && d > RAMP[0] ? h + pitRise[k] * Math.min(1, (d - RAMP[0]) / (RAMP[1] - RAMP[0])) : h;
}
// kerbs: how wide the kerb is at each section, each side (0 where there is none), narrowing to nothing at its ends
const KERB = (() => {
  const out = { L: new Float32Array(n), R: new Float32Array(n) };
  for (const kerb of K.kerbs) {
    const len = kerb.to - kerb.from + 1, side = kerb.side === "left" ? out.L : out.R;
    for (let j = 0; j < len; j++)
      side[wrap(kerb.from + j)] = Math.max(1.1, Math.abs(kerb.outer[j] - kerb.inner[j])) * clamp(Math.min(j + 0.3, len - 0.7 - j) / 2, 0.15, 1);
  }
  return out;
})();
const kerbLift = t => (t < 0.5 ? 0.09 * t : 0.045 + 0.04 * (t - 0.5));       // a kerb climbs from the road to 6.5 cm at its back
function ground(k, off) {             // the same with the kerbs on it: what a wheel stands on
  k = wrap(k);
  const h = verge(k, off), l = LEFT[k], r = RIGHT[k];
  if (off >= l && off <= r) return h;
  const sd = off < l ? -1 : 1, d = (off - (sd < 0 ? l : r)) * sd, w = (sd < 0 ? KERB.L : KERB.R)[k];
  return w > 0 && d <= w ? h + kerbLift(d / w) : h;
}
function groundAt(x, z, hint) {       // the ground under a point of the world, and which section of the lap it is beside
  const k = sectionOf(x, z, hint), c = K.centre[k], nm = K.normal[k];
  const dx = x - c[0], dz = z - c[2], off = dx * nm[0] + dz * nm[1], along = dx * nm[1] - dz * nm[0];
  return { k, off, y: lerp(ground(k, off), ground(k + (along >= 0 ? 1 : -1), off), Math.min(1, Math.abs(along) / BIN)) };
}
function painted(x, z, yaw, rects) {  // flat shapes painted about a point, lying on whatever the ground does there
  const out = [], sn = Math.sin(yaw), cs = Math.cos(yaw);
  let hint = null;
  const corner = (lx, lz) => { const wx = x + lz * sn + lx * cs, wz = z + lz * cs - lx * sn, g = groundAt(wx, wz, hint); hint = g.k; return [wx, g.y, wz]; };
  for (const [w, l, px, pz] of rects)
    out.push(quad(corner(px - w / 2, pz - l / 2), corner(px + w / 2, pz - l / 2), corner(px + w / 2, pz + l / 2), corner(px - w / 2, pz + l / 2)));
  return out;
}
// where the walls stand: close on the straights and the inside of a bend, set back behind run-off on the outside
const WALL = (() => {
  const mean = ease(bend, 26), tight = ease(bend, 3);
  let L = new Float32Array(n), R = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const b = mean[wrap(k + 6)], out = 11 + Math.min(36, 2400 * Math.abs(b));
    L[k] = -LEFT[k] + (b > 0 ? out : 9);
    R[k] = RIGHT[k] + (b < 0 ? out : 9);
  }
  if (lane) {
    const side = lane.side > 0 ? R : L;
    for (let j = 0; j < lane.count; j++) { const k = wrap(lane.from + j); side[k] = Math.max(side[k], Math.abs(lane.off(k)) + 34); }
    lane.entry.forEach((v, j) => { if (v != null) { const k = wrap(lane.from - lane.entry.length + j); side[k] = Math.max(side[k], v + 8); } });
    lane.exit.forEach((v, j) => { if (v != null) { const k = wrap(lane.from + lane.count + j); side[k] = Math.max(side[k], v + 8); } });
  }
  L = ease(L, 7); R = ease(R, 7);
  for (let k = 0; k < n; k++) {
    // inside a bend the wall stays nearer than the bend's own centre, or it would fold over itself
    const rad = 0.7 / Math.max(1e-4, Math.abs(tight[k]));
    if (tight[k] > 0) R[k] = Math.min(R[k], Math.max(RIGHT[k] + 3, rad)); else L[k] = Math.min(L[k], Math.max(-LEFT[k] + 3, rad));
  }
  for (const [W, sign] of [[L, -1], [R, 1]]) for (let k = 0; k < n; k++) {      // and it never strays onto another part of the lap
    const p = at(k, sign * W[k]);
    let near = 1e9;
    for (let j = 0; j < n; j += 3) {
      if (Math.min(wrap(j - k), wrap(k - j)) < 50) continue;
      const c = K.centre[j], d = (c[0] - p[0]) ** 2 + (c[2] - p[2]) ** 2;
      if (d < near) near = d;
    }
    near = Math.sqrt(near);
    if (near < 22) W[k] = Math.max((sign < 0 ? -LEFT[k] : RIGHT[k]) + 3, W[k] - (22 - near));
  }
  return { L: ease(L, 2), R: ease(R, 2) };
})();

// how far from the line anything may be laid, each side, before it would cross the middle of a bend and fold over
const ROOM = (() => {
  const soft = ease(bend, 4), L = new Float32Array(n), R = new Float32Array(n);
  for (let k = 0; k < n; k++) { const r = Math.min(500, 0.9 / Math.max(1e-4, Math.abs(soft[k]))); R[k] = soft[k] > 0 ? r : 500; L[k] = soft[k] < 0 ? r : 500; }
  const least = a => { const out = new Float32Array(n); for (let k = 0; k < n; k++) { let m = 1e9; for (let d = -5; d <= 5; d++) m = Math.min(m, a[wrap(k + d)]); out[k] = m; } return out; };
  return { L: ease(least(L), 3), R: ease(least(R), 3) };
})();
const within = (k, sign, d) => Math.min(d, (sign < 0 ? ROOM.L : ROOM.R)[wrap(k)]);

// A strip laid along the lap. Each column is a function of the section giving [metres right of the line, height
// above the ground there, or instead an absolute height as a third value]. Things that lie on one another are
// told apart by their materials' depth offsets, not by lifting them. Texture runs in metres unless `uv` says otherwise.
function strip(cols, o = {}) {
  const from = o.from ?? 0, count = o.count ?? n, rows = count >= n ? n + 1 : count, m = cols.length, tile = o.tile ?? 8;
  const pos = new Float32Array(rows * m * 3), uv = new Float32Array(rows * m * 2), tint = o.alpha ? 4 : 3, shade = o.shade || o.alpha ? new Float32Array(rows * m * tint) : null;
  const idx = [];
  for (let j = 0; j < rows; j++) {
    const k = wrap(from + j), c0 = K.centre[k], nm = K.normal[k], dist = (from + j) * BIN;
    for (let c = 0; c < m; c++) {
      const [off, up, level] = cols[c](k, j), i = j * m + c;
      pos[i * 3] = c0[0] + nm[0] * off; pos[i * 3 + 1] = level ?? verge(k, off) + up; pos[i * 3 + 2] = c0[2] + nm[1] * off;
      const t = o.uv ? o.uv(k, c, off, dist) : [off / tile, dist / tile];
      uv[i * 2] = t[0]; uv[i * 2 + 1] = t[1];
      if (shade) { shade[i * tint] = shade[i * tint + 1] = shade[i * tint + 2] = o.shade ? o.shade(k, c, off) : 1; if (o.alpha) shade[i * tint + 3] = o.alpha(k, c, off); }
      if (j && c) idx.push(i - m - 1, i - m, i - 1, i - m, i, i - 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  if (shade) g.setAttribute("color", new THREE.BufferAttribute(shade, tint));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function quad(a, b, c, d, uvs = [0, 0, 1, 0, 1, 1, 0, 1]) {           // four corners, in order round the face
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([uvs[0], uvs[1], uvs[2], uvs[3], uvs[4], uvs[5], uvs[0], uvs[1], uvs[4], uvs[5], uvs[6], uvs[7]], 2));
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ the circuit
const both = THREE.DoubleSide;
const MAST_FACES = 0;                  // which way the adopted mast's lamps face, as it was made: turned by this to face the road
const WALL_RUN = () => 8 * (K.venue && K.venue.boards ? K.venue.boards.length : 4);      // metres of wall one picture of its boards covers
const MASTS = [];                     // every floodlight mast: where its lamps are and where they point
const GRAVEL = { L: null, R: null };  // each side: how far beyond the road's edge the gravel begins and ends, by section
function buildCircuit() {
  const G = new THREE.Group();
  const lay = (geo, mat, o = {}) => { const m = new THREE.Mesh(geo, mat); m.receiveShadow = o.receive !== false; m.castShadow = !!o.cast; G.add(m); return m; };
  lay.add = thing => { G.add(thing); return thing; };          // (anything already made: a mesh of many copies, a group)
  const floor = K.centre.reduce((m, c) => Math.min(m, c[1]), 1e9) - 0.6;

  // ---- surfaces
  const tarmacTex = tex(512, 512, (c, w, h) => {
    speckle(c, w, h, "#3b3c40", 30000, 0.13, 1.4);
    for (let i = 0; i < 30; i++) { c.fillStyle = `rgba(0,0,0,${0.03 + rnd() * 0.05})`; c.fillRect(rnd() * w, 0, 1 + rnd() * 4, h); }
    for (let i = 0; i < 14; i++) {          // patches where the surface has worn differently
      const g = c.createRadialGradient(0, 0, 0, 0, 0, 60 + rnd() * 90); g.addColorStop(0, `rgba(${rnd() < 0.5 ? "0,0,0" : "255,255,255"},0.05)`); g.addColorStop(1, "rgba(0,0,0,0)");
      c.save(); c.translate(rnd() * w, rnd() * h); c.fillStyle = g; c.fillRect(-150, -150, 300, 300); c.restore();
    }
  }, { aniso: 16 });
  const grain = tex(512, 512, (c, w, h) => speckle(c, w, h, "#a6a6a6", 60000, 0.5, 1.2), { srgb: false, aniso: 16 });       // the stones in the surface
  const mTarmac = new THREE.MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, map: tarmacTex, bumpMap: grain, bumpScale: 0.12,
                                                   roughnessMap: grain, vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.5, side: both });
  const mPaint = new THREE.MeshStandardMaterial({ color: 0xe6e6e0, roughness: 0.55, side: both, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 });
  const mYellow = new THREE.MeshStandardMaterial({ color: 0xe8c21c, roughness: 0.55, side: both, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 });
  const mKerb = new THREE.MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, map: tex(16, 64, (c, w, h) => {
    c.fillStyle = "#e4e4de"; c.fillRect(0, 0, w, h); c.fillStyle = "#c81e1a"; c.fillRect(0, 0, w, h / 2);
  }, { aniso: 16 }), roughness: 0.6, side: both });
  const mAstro = new THREE.MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, map: tex(256, 256, (c, w, h) => speckle(c, w, h, "#0c4439", 12000, 0.16, 1.5)), roughness: 0.95, side: both });
  const mRunoff = new THREE.MeshStandardMaterial({ map: tex(512, 512, (c, w, h) => {
    speckle(c, w, h, "#2a3138", 16000, 0.25, 2);
    c.fillStyle = "rgba(60,150,150,0.10)"; for (let i = 0; i < 4; i++) c.fillRect(0, i * 128, w, 40);      // faded painted bands
  }), vertexColors: true, roughness: 0.8, side: both });
  const mGravel = new THREE.MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, map: tex(512, 512, (c, w, h) => speckle(c, w, h, "#7f7157", 40000, 0.4, 3)), vertexColors: true, roughness: 1, side: both });
  const mSand = new THREE.MeshStandardMaterial({ map: tex(256, 256, (c, w, h) => speckle(c, w, h, "#b9a37a", 9000, 0.3, 3)), vertexColors: true, roughness: 1, side: both });      // sand (it was a brown, "#6b5c44", and read as dirt)
  toySkin.push([mSand, { map: null, vertexColors: false, color: new THREE.Color(TOY.ground) }]);      // (the ground beyond the walls shades away to black, for the night)
  const mConcrete = new THREE.MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, map: tex(256, 256, (c, w, h) => speckle(c, w, h, "#5d5e60", 9000, 0.07, 1)), roughness: 0.75, side: both });      // (its speckle is slight: the picture is stretched over seven metres of pit lane, and anything more reads as cobbles from low down)

  // Photographs of the real surfaces, where there are some to fetch (replay3d_venue.js, surfaced): the road's stones
  // and how they catch the light, gravel, painted concrete. What is drawn above stays until they come.
  surfaced(mTarmac, "asphalt", { repeat: 2.4, tint: [2.5, 2.75, 3.15], bump: 1.0 });
  surfaced(mGravel, "gravel", { repeat: 2.5, tint: [1.2, 1.12, 1.0] });
  surfaced(mConcrete, "paint", { repeat: 3, tint: [1.17, 1.3, 1.6], bump: 0.5 });      // (the photograph's own colours, brought to the grey that was drawn: smooth painted concrete, as a pit lane is)
  surfaced(mRunoff, "paint", { repeat: 3, bump: 0.6 });
  surfaced(mSand, "sand", { repeat: 2.5, tint: [0.88, 0.85, 0.78], bump: 0.9 });      // (pale Gulf sand with wind ripples: venues\make_sand.py)
  // the far ground: dark, the circuit is the only thing lit out here
  const ground = lay(new THREE.PlaneGeometry(12000, 12000), new THREE.MeshStandardMaterial({ color: 0x0b0a08, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = floor;
  farGround = ground;

  // the road, eleven strips across so the line the field drove can show as the darker, rubbered-in strip it is
  const across = [-1, -0.5, -3.2, -2, -1, 0, 1, 2, 3.2, 0.5, 1];
  const roadCols = across.map((a, c) => k => {
    const l = LEFT[k], r = RIGHT[k];
    if (c === 0) return [l, 0]; if (c === 10) return [r, 0];
    if (c === 1) return [(l + Math.max(l, Math.min(r, -3.2))) / 2, 0];
    if (c === 9) return [(r + Math.min(r, Math.max(l, 3.2))) / 2, 0];
    return [clamp(a, l, r), 0];
  });
  lay(strip(roadCols, { tile: 6, shade: (k, c, off) => 1 - 0.14 * Math.exp(-((off / (1.25 + K.rubber[k])) ** 2)) }), mTarmac);
  // the rubber the field laid down along its line: dark and smoother than the road, so it catches the lights
  const braking = K.braking || [];
  // (Eric: "darker marks on the track where the optimal racing lines are". It was a smooth dark band, and faint;
  // it is laid in streaks now, as tyres lay it: many narrow tracks side by side, some darker than others.)
  const streaks = tex(256, 256, (c, w, h) => {
    c.fillStyle = "#8a8a8a"; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) { const v = Math.floor(40 + rnd() * 215); c.fillStyle = `rgba(${v},${v},${v},${0.25 + rnd() * 0.5})`; c.fillRect(rnd() * w, 0, 1 + rnd() * 7, h); }
    for (let i = 0; i < 500; i++) { c.fillStyle = `rgba(${rnd() < 0.5 ? "0,0,0" : "255,255,255"},${rnd() * 0.12})`; c.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 3, 6 + rnd() * 30); }
  }, { srgb: false, aniso: 16 });
  const mRubber = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.36, metalness: 0, envMapIntensity: 0.6, vertexColors: true, transparent: true, depthWrite: false, alphaMap: streaks,
                                                   side: both, polygonOffset: true, polygonOffsetFactor: -3.5, polygonOffsetUnits: -3.5 });
  lay(strip([-1, -0.6, -0.25, 0.25, 0.6, 1].map(f => k => [clamp(f * (1.9 + K.rubber[k]), LEFT[k], RIGHT[k]), 0]),
            { tile: 5, alpha: (k, c) => [0, 0.72, 1, 1, 0.72, 0][c] * (0.5 + 0.5 * (braking[k] || 0)) }), mRubber);
  for (const edge of [LEFT, RIGHT]) {       // the white line down each edge
    const s = edge === LEFT ? 1 : -1;
    lay(strip([k => [edge[k], 0], k => [edge[k] + s * 0.16, 0]]), mPaint);
  }
  // kerbs, red and white, exactly where a wheel found one: up from the road to their backs, and down again behind
  for (const kerb of K.kerbs) {
    const s = kerb.side === "left" ? -1 : 1, edge = s < 0 ? LEFT : RIGHT, wide = s < 0 ? KERB.L : KERB.R;
    lay(strip([k => [edge[k], 0], k => [edge[k] + s * wide[k] * 0.5, kerbLift(0.5)], k => [edge[k] + s * wide[k], kerbLift(1)], k => [edge[k] + s * wide[k], 0]],
              { from: kerb.from, count: kerb.to - kerb.from + 1, uv: (k, c, off, dist) => [Math.min(c, 2) / 2, dist / 3] }), mKerb);
  }

  // ---- either side of the road: a ribbon of astroturf, painted run-off, gravel where the bend wants it, then the wall
  const mWall = new THREE.MeshStandardMaterial({ map: wallTexture(), roughness: 0.7, side: both });
  mWall.emissiveMap = mWall.map; mWall.emissive = new THREE.Color(0x30302c);
  const mWallBack = surfaced(new THREE.MeshStandardMaterial({ map: tex(128, 128, (c, w, h) => speckle(c, w, h, "#8b8c88", 2500, 0.14, 2)), roughness: 0.85, side: both }), "concrete", { tint: [1.5, 1.5, 1.5] });
  const mTecpro = new THREE.MeshStandardMaterial({ map: tex(64, 32, (c, w, h) => {
    c.fillStyle = "#d8d8d4"; c.fillRect(0, 0, w, h); c.fillStyle = "#c4221c"; c.fillRect(0, 0, w / 2, h);
    c.fillStyle = "rgba(0,0,0,0.25)"; c.fillRect(0, 0, 2, h); c.fillRect(w / 2, 0, 2, h);
  }), roughness: 0.6, side: both });
  const mFence = new THREE.MeshStandardMaterial({ map: tex(128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.strokeStyle = "rgba(170,176,184,0.5)"; c.lineWidth = 1;
    for (let i = -h; i < w; i += 8) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i + h, h); c.moveTo(i + h, 0); c.lineTo(i, h); c.stroke(); }       // the diamond mesh
    c.fillStyle = "rgba(120,126,134,0.95)"; c.fillRect(0, 0, 5, h); c.fillRect(0, 0, w, 3); c.fillRect(0, h * 0.5, w, 2);                          // a post, and the cables
  }, { aniso: 16 }), transparent: true, depthWrite: false, roughness: 0.5, metalness: 0.7, side: both });
  const fencePosts = [];                 // (a post every six metres, each side: stood only if the photographed fence comes, since the drawn one has its posts in its picture)
  vPhoto("fence.png", t => {
    mFence.map = t; mFence.roughness = 0.5; mFence.metalness = 0.6; mFence.opacity = 0.8; mFence.needsUpdate = true;
    vPosts(lay, fencePosts, 0.1, new THREE.MeshStandardMaterial({ color: 0x8a9098, roughness: 0.45, metalness: 0.8 }), false);
  }, { repeat: [3.4, 2.7] });
  for (const sign of [-1, 1]) {
    const E = k => (sign < 0 ? LEFT : RIGHT)[k], W = k => sign * (sign < 0 ? WALL.L : WALL.R)[k];
    for (let k = 0; k < n; k += 1.5) { const p = at(Math.round(k), W(Math.round(k)) + sign * 0.2); fencePosts.push([p[0], p[1] + 2.7, p[2], 3.3]); }
    const depth = k => Math.abs(W(k) - E(k));
    const pitSide = lane && lane.side === sign;
    const out = (k, d) => E(k) + sign * Math.min(d, depth(k));        // d metres beyond the edge, never past the wall
    const found = K.loose && K.loose[sign < 0 ? "left" : "right"] || [];
    // gravel: on the deep side of a bend, and anywhere a wheel found it; opening and closing gently
    const wants = new Float32Array(n);
    for (let k = 0; k < n; k++) wants[k] = (!V && depth(k) > 21 && !(pitSide && lane.has(k))) || found[k] != null ? 1 : 0;      // (a circuit that has been looked up has gravel only where a wheel found it: its run-off is paint)
    const open = ease(wants, 6), from = new Float32Array(n);
    for (let k = 0; k < n; k++) from[k] = found[k] != null ? clamp(found[k] - Math.abs(E(k)) - 0.6, pitSide ? RAMP[1] : SLOPE_OUT, 7) : 7;
    const start = ease(from, 5);
    const g0 = k => lerp(depth(k) - 2.6, Math.min(start[k], depth(k) - 2.6), open[k]), g1 = k => depth(k) - 2.6;
    GRAVEL[sign < 0 ? "L" : "R"] = { from: Float32Array.from({ length: n }, (_, k) => g0(k)), to: Float32Array.from({ length: n }, (_, k) => g1(k)) };
    // (a column wherever the ground changes its slope, so the strip lies on the ground all the way across)
    if (!venuePaint(sign, E, W, lay)) {                               // a circuit that has been looked up paints its own run-off (replay3d_venue.js)
      lay(strip([k => [out(k, RAMP[0]), 0], k => [out(k, SLOPE_OUT), 0], k => [out(k, RAMP[1]), 0], k => [out(k, Math.max(6, depth(k) * 0.5)), 0], k => [W(k), 0]],
                { shade: (k, c) => [1, 1, 0.97, 0.92, 0.8][c] }), mRunoff);
      lay(strip([k => [E(k), 0], k => [out(k, RAMP[0]), 0]], { tile: 4 }), mAstro);
    }
    lay(strip([k => [E(k) + sign * g0(k), 0], k => [E(k) + sign * (g0(k) + g1(k)) / 2, 0], k => [E(k) + sign * g1(k), 0]],
              { tile: 5, shade: (k, c) => [1, 0.95, 0.88][c] }), mGravel);
    // beyond the wall the light falls away into the dark
    lay(strip([k => [W(k), -0.02], k => [sign * within(k, sign, Math.abs(W(k)) + 26), -0.02], k => [sign * within(k, sign, Math.abs(W(k)) + 110), 0, floor + 0.05]],
              { tile: 10, shade: (k, c) => [0.86, 0.46, 0.04][c] }), mSand);      // (sand under the lamps is pale: at half strength and gone in fourteen metres it was dark earth)
    // the wall: a face and a top, with a crisp edge between them
    lay(strip([k => [W(k), -0.05], k => [W(k), 1.05], k => [W(k), 1.05], k => [W(k) + sign * 0.45, 1.05]],
              { uv: (k, c, off, dist) => [-sign * dist / WALL_RUN(), c === 0 ? 0 : c === 1 ? 1 : 0.02] }), mWall, { cast: true });
    lay(strip([k => [W(k) + sign * 0.46, -0.05], k => [W(k) + sign * 0.46, 1.05]], { tile: 3 }), mWallBack);      // (its back: bare concrete, not its boards seen from behind)
    // a catch fence standing on it: posts every four metres and the mesh between
    lay(strip([k => [W(k) + sign * 0.2, 1.05], k => [W(k) + sign * 0.2, 4.3]], { uv: (k, c, off, dist) => [dist / 4, c] }), mFence);
    // red and white blocks in front of it on the outside of the bends
    let run = null;
    for (let k = 0; k <= n; k++) {
      const deep = !V && k < n && open[k] > 0.6;
      if (deep && run === null) run = k;
      else if (!deep && run !== null) {
        if (k - run > 4) lay(strip([j => [W(j) - sign * 1.3, -0.03], j => [W(j) - sign * 1.3, 1.0], j => [W(j) - sign * 1.3, 1.0], j => [W(j) - sign * 0.2, 1.0]],
                                   { from: run, count: k - run, uv: (j, c, off, dist) => [dist / 2.4, c === 0 ? 0 : 1] }), mTecpro, { cast: true });
        run = null;
      }
    }
  }

  // ---- the start: finish line, grid slots, and the lights
  const onLine = (ahead, off) => { const a = at(0, off), b = at(1, off), t = ahead / BIN; return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; };
  lay(quad(onLine(-0.5, LEFT[0]), onLine(-0.5, RIGHT[0]), onLine(0.5, RIGHT[0]), onLine(0.5, LEFT[0])), new THREE.MeshStandardMaterial({
    map: tex(256, 16, (c, w, h) => { for (let i = 0; i < 48; i++) for (let j = 0; j < 3; j++) { c.fillStyle = (i + j) % 2 ? "#141414" : "#ececec"; c.fillRect(i * w / 48, j * h / 3, w / 48 + 1, h / 3 + 1); } }, { repeat: false }),
    roughness: 0.6, side: both, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }));
  const marks = [];
  for (const [x, , z, yaw] of K.grid || []) marks.push(...painted(x, z, yaw, [[2.5, 0.14, 0, 2.95], [0.14, 1.4, 1.18, 2.3], [0.14, 1.4, -1.18, 2.3]]));
  if (marks.length) lay(merge(marks), mPaint);
  // and the black lines every start leaves ahead of the slots
  const fade = tex(4, 64, (c, w, h) => { const g = c.createLinearGradient(0, h, 0, 0); g.addColorStop(0, "#d0d0d0"); g.addColorStop(1, "#000"); c.fillStyle = g; c.fillRect(0, 0, w, h); }, { repeat: false, srgb: false });
  const launches = [];
  for (const [x, , z, yaw] of K.grid || []) launches.push(...painted(x, z, yaw, [[0.36, 11, 0.76, 3.9], [0.36, 11, -0.76, 3.9]]));
  if (launches.length) lay(merge(launches), new THREE.MeshStandardMaterial({ color: 0x09090a, roughness: 0.34, alphaMap: fade, transparent: true, depthWrite: false, side: both,
                                                                             polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  if ((K.grid || []).length) G.add(gantry(K.grid));

  // ---- the pit lane and what stands beside it
  if (lane) pits(G, lay, { mConcrete, mPaint, mYellow, mTarmac, mWall });
  if (V) { venueBuild(lay); venueProps(lay); }      // a circuit that has been looked up: its stands, its buildings, what is beyond its fence; and things somebody made properly, where they are on this PC (replay3d_venue.js)

  // ---- floodlights: masts down both sides, each a glow in the night
  const masts = [];
  MASTS.length = 0;
  mastSet.meshes.length = mastSet.per.length = 0; mastSet.out = -1; mastSet.halo = null;
  // (A circuit that has been looked up says how often they stand, how tall and how many lamps across: then there is
  // one each side, in front of the grandstand too, and on the pits' side they stand behind the pit building.)
  const own = V && V.masts, every = own ? Math.max(4, Math.round(own.every / BIN)) : 13, tall = own ? own.h : 24, headWide = own ? own.heads * 1.7 : 4.6;
  for (let k = 0, i = 0; k < n; k += every, i++) for (const sign of own ? [-1, 1] : [i % 2 ? -1 : 1]) {
    if (!own && lane && lane.has(k) && sign !== lane.side) continue;       // the grandstand has its own lights
    // (a venue's stand behind the television cameras, which are 2.5 m beyond the wall)
    const stand = q => { const w = sign < 0 ? WALL.L[q] : WALL.R[q], pitSide = lane && lane.has(q) && sign === lane.side; return at(q, sign * within(q, sign, own ? (pitSide ? Math.max(w + 10, vPitBack + 6) : w + 10) : w + 5)); };
    masts.push({ k, p: stand(k), sign });
  }
  const steel = new THREE.MeshStandardMaterial({ color: 0xb4bac1, roughness: 0.55, metalness: 0.2 });      // galvanised: pale enough to be seen against a night sky (dark steel was not, and the lamps hung in the air)
  const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.16, 0.3, tall, 6).translate(0, tall / 2, 0), steel, masts.length);
  const head = new THREE.InstancedMesh(new THREE.BoxGeometry(headWide, 1.7, 0.4), steel, masts.length);
  const face = new THREE.InstancedMesh(new THREE.PlaneGeometry(headWide - 0.3, 1.4).translate(0, 0, 0.21), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 5.5, 4.6) }), masts.length);
  const glow = [], dummy = new THREE.Object3D();
  masts.forEach((m, i) => {
    dummy.position.set(m.p[0], m.p[1], m.p[2]); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); pole.setMatrixAt(i, dummy.matrix);
    const c = K.centre[m.k];
    dummy.position.set(m.p[0], m.p[1] + tall + 0.4, m.p[2]); dummy.lookAt(c[0], c[1], c[2]); dummy.updateMatrix(); head.setMatrixAt(i, dummy.matrix); face.setMatrixAt(i, dummy.matrix);
    glow.push(m.p[0], m.p[1] + tall + 0.4, m.p[2]);
    MASTS.push({ x: m.p[0], y: m.p[1] + tall + 0.4, z: m.p[2], tx: c[0], ty: c[1], tz: c[2] });
  });
  G.add(pole, head, face);
  for (const mesh of [pole, head, face]) mastsListed(mesh);
  if (own) vModel("mast", parts => {      // the venue's masts as somebody made them properly (venues\props.py: on this PC), in place of the poles drawn here
    const lit = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 5.5, 4.6) });
    for (const mesh of vCopies(lay, parts, masts.map(m => { const c = K.centre[m.k]; return [m.p[0], m.p[1], m.p[2], Math.atan2(-(c[2] - m.p[2]), c[0] - m.p[0]) + MAST_FACES, tall / 27.1]; }),
                               { wear: kind => (kind === "lamp" ? lit : steel) })) mastsListed(mesh);
    pole.visible = head.visible = face.visible = false;
  });
  const glowGeo = new THREE.BufferGeometry(); glowGeo.setAttribute("position", new THREE.Float32BufferAttribute(glow, 3));
  const halo = new THREE.Points(glowGeo, new THREE.PointsMaterial({ map: tex(64, 64, (c, w) => {
    const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStop(0, "rgba(255,246,225,1)"); g.addColorStop(0.18, "rgba(255,240,210,0.5)"); g.addColorStop(0.5, "rgba(255,230,190,0.1)"); g.addColorStop(1, "rgba(255,230,190,0)");
    c.fillStyle = g; c.fillRect(0, 0, w, w);
  }, { repeat: false }), size: own ? 21 : 30, sizeAttenuation: true, transparent: true, opacity: own ? 0.62 : 0.8, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));      // (twice as many masts at a venue: each a smaller glow)
  G.add(halo);
  halo.userData.home = Float32Array.from(glow); mastSet.halo = halo;
  nightOnly.push(halo);
  return G;
}
// A floodlight mast is not in a television camera's way. Real cameras are put where nothing is; these are every
// 280 m and film a long stretch of road, so there are poles between some of them and the cars. While a camera is
// filming, the masts that would stand in front of the cars in its picture (inShotOf()) are not drawn; from every
// other camera, and from that one's own place when it is not the one filming, they are all there.
const mastSet = { meshes: [], halo: null, per: [], out: -1 };
function mastsListed(mesh) {              // something drawn once for every mast, in the masts' order
  mesh.userData.home = mesh.instanceMatrix.array.slice();
  mastSet.meshes.push(mesh);
  const now = mastSet.out;                // (one that comes late, a model that had to be fetched, is brought into line)
  mastSet.out = -1; mastsOutOf(now);
}
function mastsOutOf(i) {                  // i: the camera that is filming, or -1 for none of them
  if (i === mastSet.out) return;
  const hide = i < 0 ? [] : (mastSet.per[i] = mastSet.per[i] || MASTS.map((m, j) => (inShotOf(i, m.x, m.z) ? j : -1)).filter(j => j >= 0));
  const was = mastSet.out < 0 ? [] : mastSet.per[mastSet.out] || [];
  for (const mesh of mastSet.meshes) {
    const a = mesh.instanceMatrix.array, home = mesh.userData.home;
    for (const j of was) a.set(home.subarray(j * 16, j * 16 + 16), j * 16);
    for (const j of hide) { a.fill(0, j * 16, j * 16 + 16); a[j * 16 + 15] = 1; }      // (shrunk to nothing)
    mesh.instanceMatrix.needsUpdate = true;
  }
  if (mastSet.halo) {
    const at3 = mastSet.halo.geometry.attributes.position, home = mastSet.halo.userData.home;
    for (const j of was) at3.array[j * 3 + 1] = home[j * 3 + 1];
    for (const j of hide) at3.array[j * 3 + 1] = -1e4;                                    // (its glow, sunk out of sight)
    at3.needsUpdate = true;
  }
  mastSet.out = i;
}
function wallTexture() {
  // 32 m of concrete wall with painted panels. The names are the event's own, never a real sponsor's.
  // (A circuit that has been looked up has its own boards: twice as many, in its own colours. Still not a real sponsor's.)
  const boards = V && V.boards ? V.boards.map(([word, back, ink]) => [word, vHex(back), vHex(ink)])
    : [K.track.toUpperCase(), "PIT WALL", "GRAND PRIX", "NIGHT RACE"].map((word, i) => [word, ["#0c3b66", "#101214", "#7a1512", "#0f5a4c"][i], "#f2f2ee"]);
  const count = boards.length, each = 512;
  return tex(count * each, 64, (c, w, h) => {
    speckle(c, w, h, V ? "#b4b4ae" : "#9a9a96", 5000 * count / 4, 0.15, 2);
    c.fillStyle = "#c2241f"; c.fillRect(0, h - 9, w, 5);
    boards.forEach(([word, back, ink], i) => {
      const x = i * each + 24, ww = each - 48;
      c.fillStyle = back; c.fillRect(x, 6, ww, h - 22);
      c.fillStyle = ink; c.font = "800 30px system-ui, Segoe UI, Arial, sans-serif"; c.textAlign = "center"; c.textBaseline = "middle";
      c.fillText(word, x + ww / 2, 6 + (h - 22) / 2 + 1, ww - 24);
    });
  }, { aniso: 16 });
}
function gantry(grid) {
  // over the road just ahead of pole: five pairs of red lights that come on one by one and go out together
  let front = -1, best = -1e9;
  for (const [x, , z] of grid) {
    let near = 0, d0 = 1e18;
    for (let k = 0; k < n; k++) { const c = K.centre[k], d = (c[0] - x) ** 2 + (c[2] - z) ** 2; if (d < d0) { d0 = d; near = k; } }
    const ahead = near > n / 2 ? near - n : near;              // sections either side of the line count on from it
    if (ahead > best) { best = ahead; front = near; }
  }
  const k = wrap(front + 5), g = new THREE.Group(), c = K.centre[k];
  g.position.set(c[0], c[1], c[2]); g.rotation.y = heading(k);           // local +z down the road, +x to the driver's left
  const steel = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.5, metalness: 0.6 });
  const xl = -LEFT[k] + 2.0, xr = -(RIGHT[k] + 2.0), xm = -(LEFT[k] + RIGHT[k]) / 2, H = 6.6;
  const frame = [box(0.5, H + 0.6, 0.5, xl, (H + 0.6) / 2, 0), box(0.5, H + 0.6, 0.5, xr, (H + 0.6) / 2, 0), box(xl - xr + 0.5, 0.7, 0.6, (xl + xr) / 2, H + 0.5, 0)];
  const bars = new THREE.Mesh(merge(frame), steel); bars.castShadow = true; g.add(bars);
  const [wide, high, back, words] = V ? [xl - xr - 1.2, 2.4, vHex("maroon"), "SLAYTER LEAGUE      SLAYTER LEAGUE"] : [9, 1.3, "#0b0c0e", K.track.toUpperCase()];      // (a circuit that has been looked up: a banner the width of the road, the title on it twice)
  const banner = new THREE.MeshBasicMaterial({ map: tex(1024, Math.round(1024 * high / wide), (cx, w, h) => {
    cx.fillStyle = back; cx.fillRect(0, 0, w, h); cx.fillStyle = "#f4f4f0"; cx.font = `800 ${Math.round(h * 0.6)}px system-ui, Segoe UI, Arial, sans-serif`; cx.textAlign = "center"; cx.textBaseline = "middle"; cx.fillText(words, w / 2, h / 2 + 2, w - 30);
  }, { repeat: false }) });
  g.add(new THREE.Mesh(new THREE.PlaneGeometry(wide, high).rotateY(Math.PI).translate(xm, H + 1.0 + high / 2, -0.32), banner));
  if (V) g.add(new THREE.Mesh(new THREE.PlaneGeometry(wide, high).translate(xm, H + 1.0 + high / 2, 0.32), banner));       // and on its other face, for whoever comes the other way
  const lampGeo = new THREE.CircleGeometry(0.17, 16).rotateY(Math.PI), plain = [];
  for (let i = 0; i < 5; i++) {
    const x = xm + (2 - i) * 1.25;       // the first light is the one on the drivers' left: +x
    plain.push(new THREE.Mesh(box(0.72, 1.1, 0.25, x, H - 0.35, -0.1), steel));
    const mat = new THREE.MeshBasicMaterial({ color: 0x1a0505 });
    for (const dy of [-0.08, -0.6]) { const lamp = new THREE.Mesh(lampGeo, mat); lamp.position.set(x, H + dy, -0.24); plain.push(lamp); }
    startLights.push(mat);
  }
  g.add(...plain);
  // Where somebody's board of start lamps is on this PC (venues\props.py, "panel": five columns of four), it hangs
  // under the beam in place of the five boxes, each column lit by the same light as the box it stands in for.
  vModel("panel", parts => {
    const size = 1.9, hang = new THREE.Group(), lamps = parts.filter(q => q.kind === "lamp"), nz = [0, 0];
    for (const q of lamps) { const N = q.geometry.attributes.normal; for (let i = 0; i < N.count; i++) { nz[0] += N.getZ(i); nz[1]++; } }
    const back = nz[0] > 0;                                   // its lamps face up the road as it was made: turned round, to face the grid
    for (const q of parts.filter(q => q.kind !== "lamp")) hang.add(new THREE.Mesh(q.geometry, q.material));
    for (const q of lamps) {                                  // its lamps, told apart by which column they are in
      const geo = q.geometry.index ? q.geometry.toNonIndexed() : q.geometry, P = geo.attributes.position, cols = [[], [], [], [], []];
      geo.computeBoundingBox();
      const x0 = geo.boundingBox.min.x, wide = geo.boundingBox.max.x - x0 || 1;
      for (let i = 0; i < P.count; i += 3) {
        const cx = (P.getX(i) + P.getX(i + 1) + P.getX(i + 2)) / 3, col = clamp(Math.floor((cx - x0) / wide * 5), 0, 4);
        for (let j = 0; j < 3; j++) cols[col].push(P.getX(i + j), P.getY(i + j), P.getZ(i + j));
      }
      cols.forEach((list, col) => {
        const one = new THREE.BufferGeometry(); one.setAttribute("position", new THREE.Float32BufferAttribute(list, 3));
        hang.add(new THREE.Mesh(one, startLights[back ? col : 4 - col]));      // (the first light is the one on the drivers' left)
      });
    }
    hang.scale.setScalar(size); if (back) hang.rotation.y = Math.PI;
    hang.position.set(xm, H - 0.2 - 1.5 * size, -0.25); g.add(hang);
    for (const m of plain) m.visible = false;
  });
  return g;
}
function pits(G, lay, M) {
  const s = lane.side, first = lane.from, last = lane.from + lane.count - 1;
  const E = k => (s < 0 ? LEFT : RIGHT)[wrap(k)];
  // the lane itself, and the roads that join it to the circuit (all of it lying on the ground as verge() has it)
  lay(strip([k => [lane.off(k) - s * 3.3, 0], k => [lane.off(k) + s * 11.5, 0]], { from: first, count: lane.count, tile: 7 }), M.mConcrete);
  for (const edge of [-3.1, 2.5]) lay(strip([k => [lane.off(k) + s * edge, 0], k => [lane.off(k) + s * (edge + 0.14), 0]],
                                            { from: first + 4, count: lane.count - 8 }), edge < 0 ? M.mPaint : M.mYellow);
  const join = (list, k0) => {
    let a = list.findIndex(v => v != null), b = list.length - 1 - [...list].reverse().findIndex(v => v != null);
    if (a < 0) return;
    const far = (k, j) => (list[a + j] ?? Math.abs(E(k))) + 0.9;                       // how far out the road reaches, from the line
    const step = (d, back = 0) => (k, j) => [s * Math.min(Math.abs(E(k)) + d, far(k, j) - back), 0];
    lay(strip([(k, j) => [E(k) - s * 0.2, 0], step(RAMP[0]), step(SLOPE_OUT), step(RAMP[1]), step(1e9)],
              { from: k0 + a, count: b - a + 1, tile: 6, shade: () => 0.95 }), M.mTarmac);
    lay(strip([step(1e9, 0.3), step(1e9, 0.15)], { from: k0 + a, count: b - a + 1 }), M.mPaint);
  };
  join(lane.entry, first - lane.entry.length); join(lane.exit, last + 1);
  // the pit wall, between the racing and the working
  const wallAt = k => (E(k) + lane.off(k) - s * 3.3) / 2;
  lay(strip([k => [wallAt(k) - s * 0.22, 0], k => [wallAt(k) - s * 0.22, 1.1], k => [wallAt(k) - s * 0.22, 1.1],
             k => [wallAt(k) + s * 0.22, 1.1], k => [wallAt(k) + s * 0.22, 1.1], k => [wallAt(k) + s * 0.22, 0]],
            { from: first + 10, count: lane.count - 20, uv: (k, c, o, dist) => [s * (c < 3 ? -1 : 1) * dist / WALL_RUN(), c === 0 || c === 5 ? 0 : c === 1 || c === 4 ? 1 : 0.02] }), M.mWall, { cast: true });
  if (!(K.boxes || []).length) return;
  // the boxes the cars stopped in, painted on the ground, and the garages behind them
  const paint = [], where = [];
  for (const [x, , z, yaw] of K.boxes) {
    paint.push(...painted(x, z, yaw, [[2.9, 0.12, 0, 3.0], [2.9, 0.12, 0, -3.0], [0.12, 6.1, 1.45, 0], [0.12, 6.1, -1.45, 0]]));
    let near = first, d0 = 1e18;
    for (let k = first; k <= last; k++) { const c = K.centre[wrap(k)], d = (c[0] - x) ** 2 + (c[2] - z) ** 2; if (d < d0) { d0 = d; near = k; } }
    const c = K.centre[wrap(near)], nm = K.normal[wrap(near)];
    where.push({ k: near, off: (x - c[0]) * nm[0] + (z - c[2]) * nm[1] });
  }
  lay(merge(paint), M.mYellow);
  where.sort((a, b) => a.k - b.k);
  const a = where[0].k - 5, b = where[where.length - 1].k + 5, count = b - a + 1;
  const bay = where.length > 1 ? (where[where.length - 1].k - where[0].k) * BIN / (where.length - 1) : 13;
  const front = Math.abs(where[Math.floor(where.length / 2)].off) + 4.4, back = front + 17, top = 9.4;
  const y0 = k => lane.y(lane.has(k) ? k : first);
  if (V && V.pit) { venuePits(lay, { s, front, bay, first: where[0].k, y0, wall: wallAt }); return; }      // a circuit that has been looked up has its own pit building, and its stands are where they really are
  const u = (k, c, o, dist) => (dist - where[0].k * BIN) / bay + 0.5;
  const mShell = new THREE.MeshStandardMaterial({ color: 0x7d8187, roughness: 0.6, side: both });
  const garage = tex(256, 128, (c, w, h) => {           // one team's garage: two lit doors in a dark wall, a number board over them
    c.fillStyle = "#17191d"; c.fillRect(0, 0, w, h);
    for (const x of [18, 138]) {
      const g = c.createLinearGradient(0, 30, 0, h); g.addColorStop(0, "#d9d2bf"); g.addColorStop(0.55, "#8f8b80"); g.addColorStop(1, "#5b5a57");
      c.fillStyle = g; c.fillRect(x, 34, 100, h - 34);
      c.fillStyle = "rgba(20,22,26,0.55)"; c.fillRect(x + 8, 70, 30, h - 70); c.fillRect(x + 62, 78, 30, h - 78);       // tool cabinets, a car on stands
      c.fillStyle = "rgba(255,250,235,0.9)"; c.fillRect(x + 6, 37, 88, 4);                                             // the strip lights
    }
    c.fillStyle = "#24272c"; c.fillRect(0, 0, w, 24); c.fillStyle = "#cfcfc9"; c.fillRect(100, 7, 56, 10);
  }, { aniso: 16 });
  const mGarage = new THREE.MeshStandardMaterial({ map: garage, emissiveMap: garage, emissive: new THREE.Color(0.75, 0.72, 0.66), roughness: 0.8, side: both });
  const glass = tex(128, 64, (c, w, h) => {
    c.fillStyle = "#0e1622"; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 8; i++) { c.fillStyle = rnd() < 0.7 ? `rgba(190,215,255,${0.35 + rnd() * 0.5})` : "rgba(40,60,90,0.5)"; c.fillRect(i * 16 + 2, 8, 12, h - 16); }
  });
  const mGlass = new THREE.MeshStandardMaterial({ map: glass, emissiveMap: glass, emissive: new THREE.Color(0.9, 1.0, 1.2), roughness: 0.25, metalness: 0.4, side: both });
  const F = s * front, B = s * back;
  lay(strip([k => [F, 0, y0(k)], k => [F, 0, y0(k) + 4.6]], { from: a, count, uv: (k, c, o, dist) => [u(k, c, o, dist), c] }), mGarage);
  lay(strip([k => [F, 0, y0(k) + 4.6], k => [F - s * 2.4, 0, y0(k) + 4.75], k => [F - s * 2.4, 0, y0(k) + 5.05], k => [F, 0, y0(k) + 5.05]], { from: a, count }), mShell, { cast: true });
  lay(strip([k => [F, 0, y0(k) + 5.05], k => [F, 0, y0(k) + top]], { from: a, count, uv: (k, c, o, dist) => [u(k, c, o, dist), c] }), mGlass);
  lay(strip([k => [F, 0, y0(k) + top], k => [F, 0, y0(k) + top], k => [B, 0, y0(k) + top], k => [B, 0, y0(k) + top], k => [B, 0, y0(k)]], { from: a, count }), mShell, { cast: true });
  for (const k of [a, b]) {               // the two ends
    const p = at(k, F), q = at(k, B), h = y0(k);
    lay(quad([p[0], h, p[2]], [q[0], h, q[2]], [q[0], h + top, q[2]], [p[0], h + top, p[2]]), mShell, { cast: true });
  }
  // the grandstand across the road: a bank of seats under a lit roof
  const W = k => (s > 0 ? WALL.L : WALL.R)[wrap(k)], sa = a - 6, sc = count + 12;
  const crowd = tex(512, 256, (c, w, h) => {
    c.fillStyle = "#15171c"; c.fillRect(0, 0, w, h);
    const tones = ["#d8d2c4", "#c8463c", "#3d7bd0", "#e8c24a", "#7fb08a", "#f0f0f0", "#8a5fb0", "#e08a3c"];
    for (let row = 0; row < 26; row++) for (let i = 0; i < 150; i++) if (rnd() < 0.78) { c.fillStyle = tones[Math.floor(rnd() * tones.length)]; c.globalAlpha = 0.5 + rnd() * 0.5; c.fillRect(i * 3.42 + rnd(), row * 9.6 + 3 + rnd() * 2, 2.2, 3.4); }
    c.globalAlpha = 1;
  }, { aniso: 16 });
  const mCrowd = new THREE.MeshStandardMaterial({ map: crowd, emissiveMap: crowd, emissive: new THREE.Color(0.22, 0.22, 0.22), roughness: 0.9, side: both });
  const g0 = k => -s * (W(k) + 3.5), g1 = k => -s * (W(k) + 23.5);
  lay(strip([k => [g0(k), 0], k => [g0(k), 3.0]], { from: sa, count: sc, uv: (k, c, o, dist) => [dist / WALL_RUN(), c] }), M.mWall, { cast: true });
  lay(strip([k => [g0(k), 3.0], k => [g1(k), 14.5]], { from: sa, count: sc, uv: (k, c, o, dist) => [dist / 30, c] }), mCrowd);
  lay(strip([k => [g1(k), 14.5], k => [g1(k), 14.5], k => [g1(k), 0]], { from: sa, count: sc }), mShell, { cast: true });
  const mRoof = new THREE.MeshStandardMaterial({ color: 0x3a3e45, roughness: 0.7, metalness: 0.3, side: both });
  lay(strip([k => [g0(k) + s * 1.5, 17.4], k => [g1(k) - s * 1.0, 20.2]], { from: sa, count: sc }), mRoof, { cast: true });
  // a row of lamps under the roof's front edge
  lay(strip([k => [g0(k) + s * 1.2, 17.2], k => [g0(k) + s * 0.6, 17.3]], { from: sa, count: sc }), new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 3.0, 2.6), side: both }));
  for (const k of [sa, sa + sc - 1]) {
    const p = at(k, g0(k)), q = at(k, g1(k));
    lay(quad([p[0], p[1], p[2]], [q[0], q[1], q[2]], [q[0], q[1] + 14.5, q[2]], [p[0], p[1] + 3, p[2]]), mShell, { cast: true });
  }
}
function surroundings(above) {
  // what the paintwork reflects: the night sky, two rows of floodlights, and the lit ground below
  const env = new THREE.Scene();
  env.background = above || new THREE.Color(0x030408); env.backgroundIntensity = above ? night.clear : 1;
  const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(60, 55, 46) });
  for (const side of [-1, 1]) for (let i = -7; i <= 7; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(6, 2.4, 0.5), lamp); m.position.set(side * 70, 34, i * 34); m.lookAt(0, 0, i * 34); env.add(m);
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.10, 0.10, 0.11) }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -1; env.add(floor);
  const pm = new THREE.PMREMGenerator(renderer), out = pm.fromScene(env, 0.02, 1, 500).texture;
  pm.dispose();
  return out;
}

// ------------------------------------------------------------------ the cars
// One shape for the whole field, built once: a 2026-sized car (3.5 m between the axles, 1.9 m wide) drawn from
// loops and plates. +z is forward, +x the driver's left, the road is y = 0.
const AXLE = 1.75, TYRE_R = 0.36;
const WHEEL_AT = [[0.80, AXLE], [-0.80, AXLE], [0.76, -AXLE], [-0.76, -AXLE]];      // front left, front right, rear left, rear right: metres to the left, metres forward
// ---- what each team's car looks like
// A car's paint is one picture wrapped round the tub, the engine cover and the two sidepods: along the picture runs
// along the car, nose first; up it runs round the body from the keel, up the left side, over the top, down the
// right side and back to the keel. Above that is a row of plain colours for everything that is one colour (wings,
// endplates, the fin, the helmet). Each team has its own colours and its own way of laying them out, after its real
// 2026 car; a team this doesn't know wears the two colours the game gives it.
const SKINS = { tub: [0, 0.48, 0, 0.72], cover: [0.5, 0.76, 0, 0.72], podL: [0.78, 1, 0.36, 0.72], podR: [0.78, 1, 0, 0.36] };
const SPAN = { tub: [2.8, -0.62], cover: [-0.02, -2.45], podL: [0.78, -1.75], podR: [0.78, -1.75] };      // where each begins and ends along the car
const SWATCH = { main: 0, second: 1, carbon: 2, flap: 3, plate: 4, rear: 5, rflap: 6, trim: 7 };
function dot(g, name) {               // make a whole piece one of the plain colours
  const uv = new Float32Array(g.attributes.position.count * 2);
  for (let i = 0; i < uv.length; i += 2) { uv[i] = (SWATCH[name] + 0.5) / 8; uv[i + 1] = 0.88; }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}
const TEAM_OF = { 476: "mercedes", 477: "ferrari", 478: "redbull", 479: "williams", 480: "aston", 481: "alpine", 482: "rb", 483: "haas", 484: "mclaren", 485: "audi", 486: "cadillac",
                  0: "mercedes", 1: "ferrari", 2: "redbull", 3: "williams", 4: "aston", 5: "alpine", 6: "rb", 7: "haas", 8: "mclaren", 9: "sauber" };
const CARBON = "#0d0e10", WHITE = "#f3f3f1";
// colours: main, second, flap (front wing's upper elements), plate (its endplates), rear (rear wing endplates), rflap (rear wing flap), trim (helmet)
// body(p): p.all(colour, or [[metres along the car, colour], ...] nose to tail), p.top(part, from, to, half width, colour) a band over the top,
//          p.flank((tub, cover, pod) => ...) drawn once for each side (0 is the keel, 0.25 the flank, 0.5 the top), p.side(right?, colour)
const LOOKS = {
  mclaren: { colours: { main: "#ff8000", second: CARBON, flap: "#ff8000", plate: CARBON, rear: CARBON, rflap: "#ff8000", trim: "#ffd21f" },      // papaya above, black down the flanks of the sidepods and the engine cover as the real car is, a black stripe down the middle
    body(p) { p.all("#ff8000"); p.top("tub", 0.08, 0.62, 0.065, CARBON); p.top("cover", 0, 1, 0.11, CARBON);
      p.flank((tub, cover, pod) => { cover.shape([[0.2, 0.17], [1, 0.17], [1, 0.42], [0.45, 0.3]], CARBON); pod.band(0, 1, 0.17, 0.41, CARBON); pod.band(0.55, 1, 0.41, 0.56, CARBON); }); } },
  ferrari: { colours: { main: "#e00620", second: WHITE, flap: "#e00620", plate: CARBON, rear: CARBON, rflap: CARBON, trim: "#ffec40" },           // red, white round the cockpit and airbox, a black rear wing
    body(p) { p.all("#e00620"); p.top("tub", 0.6, 1, 0.16, WHITE); p.top("cover", 0, 0.5, 0.19, WHITE);
      p.flank((tub, cover) => { cover.shape([[0.5, 0.31], [0.74, 0.5], [0.5, 0.5]], WHITE); tub.band(0.1, 0.6, 0.3, 0.307, WHITE); }); } },
  redbull: { colours: { main: "#12235f", second: "#e0101f", flap: "#12235f", plate: "#e0101f", rear: "#12235f", rflap: "#e0101f", trim: "#ffc906" },   // deep blue, red down the flanks, yellow nose and airbox
    body(p) { p.all("#12235f"); p.top("tub", 0, 0.05, 0.5, "#ffc906"); p.top("cover", 0, 0.28, 0.09, "#ffc906");
      p.flank((tub, cover, pod) => { tub.shape([[0.05, 0.21], [0.05, 0.27], [1, 0.36], [1, 0.31]], "#e0101f"); cover.shape([[0, 0.31], [0, 0.36], [0.9, 0.2], [0.7, 0.2]], "#e0101f");
        pod.shape([[0, 0.22], [0, 0.3], [1, 0.24], [1, 0.2]], "#e0101f"); tub.band(0.05, 1, 0.197, 0.204, WHITE); pod.band(0, 1, 0.188, 0.195, WHITE); }); } },
  mercedes: { colours: { main: "#c9cdd0", second: "#00d2be", flap: CARBON, plate: "#00d2be", rear: CARBON, rflap: "#00d2be", trim: WHITE },        // silver at the nose going to black at the tail, a teal line
    body(p) { p.all([[2.8, "#c9cdd0"], [1.25, "#c9cdd0"], [0.55, "#2c2f33"], [0.2, CARBON], [-2.5, CARBON]]);      // (black from the cockpit back, sidepods and all, as the real car is: the names on them are white)
      p.flank((tub, cover, pod) => { tub.band(0.08, 1, 0.2, 0.212, "#00d2be"); cover.band(0, 1, 0.2, 0.212, "#00d2be"); pod.band(0, 1, 0.41, 0.422, "#00d2be");
        pod.shape([[0, 0.17], [0.07, 0.17], [0.2, 0.5], [0.13, 0.5]], "rgba(201,205,208,0.5)");
        cover.shape([[0.05, 0.17], [0.14, 0.17], [0.3, 0.42], [0.21, 0.42]], "rgba(201,205,208,0.35)"); }); } },
  williams: { colours: { main: "#1b3fd2", second: WHITE, flap: WHITE, plate: "#1b3fd2", rear: WHITE, rflap: "#1b3fd2", trim: WHITE },             // cobalt blue, a white engine cover, lighter blue sidepods
    body(p) { p.all("#1b3fd2"); p.top("cover", 0, 0.8, 0.17, WHITE);
      p.flank((tub, cover, pod) => { pod.band(0, 1, 0.17, 0.5, "#0a7fd4"); pod.shape([[0.7, 0.17], [1, 0.17], [1, 0.5], [0.9, 0.5]], "#061a4d");
        tub.shape([[0.55, 0.11], [1, 0.11], [1, 0.3], [0.8, 0.22]], "#061a4d"); cover.band(0, 0.8, 0.322, 0.334, CARBON); }); } },
  aston: { colours: { main: "#00594f", second: "#cedc00", flap: "#00594f", plate: "#cedc00", rear: "#00594f", rflap: "#00594f", trim: "#cedc00" },    // racing green, darker to the tail, lime lines
    body(p) { p.all([[2.8, "#0f7a66"], [0.5, "#00594f"], [-2.5, "#00382f"]]);
      p.flank((tub, cover, pod) => { pod.band(0.04, 1, 0.3, 0.312, "#cedc00"); pod.band(0.12, 1, 0.262, 0.269, "#cedc00"); tub.band(0.3, 1, 0.2, 0.207, "#cedc00"); cover.band(0, 0.9, 0.2, 0.207, "#cedc00"); }); } },
  alpine: { colours: { main: "#1166d6", second: "#ff7fc1", flap: "#1166d6", plate: "#ff7fc1", rear: "#ff7fc1", rflap: "#1166d6", trim: WHITE },    // blue at the front, pink behind
    body(p) { p.all([[2.8, "#1166d6"], [0.9, "#1166d6"], [0.1, "#ff7fc1"], [-2.5, "#ff7fc1"]]);
      p.flank((tub, cover, pod) => { cover.shape([[0.78, 0.17], [1, 0.17], [1, 0.5], [0.92, 0.5]], "#1166d6"); pod.band(0, 1, 0.17, 0.42, "#1166d6"); pod.shape([[0, 0.42], [0.3, 0.42], [0.08, 0.56], [0, 0.56]], "#1166d6"); }); } },      // (the sidepods' flanks blue, as the real car's are)
  haas: { colours: { main: WHITE, second: "#e2001a", flap: CARBON, plate: "#e2001a", rear: CARBON, rflap: WHITE, trim: "#e2001a" }, low: 0.05,    // white, black sweeping up at the tail, red lines (its sidepods white to the floor, as the real car's are: its name is black on them)
    body(p) { p.all(WHITE);
      p.flank((tub, cover, pod) => { tub.shape([[0.35, 0.11], [1, 0.11], [1, 0.25], [0.6, 0.2]], CARBON);
        cover.shape([[0.75, 0.17], [1, 0.17], [1, 0.5], [0.9, 0.5]], CARBON); cover.shape([[0.72, 0.17], [0.75, 0.17], [0.9, 0.5], [0.87, 0.5]], "#e2001a");
        tub.shape([[0.3, 0.2], [1, 0.25], [1, 0.285], [0.3, 0.215]], "#e2001a"); pod.band(0, 1, 0.4, 0.418, "#e2001a"); pod.shape([[0.8, 0.05], [1, 0.05], [1, 0.4], [0.93, 0.4]], CARBON); }); } },
  rb: { colours: { main: WHITE, second: "#1b33c9", flap: "#1b33c9", plate: WHITE, rear: WHITE, rflap: "#1b33c9", trim: "#e8242c" }, numInk: "#e8242c",   // white, blue low on the flanks, red numbers
    body(p) { p.all(WHITE); p.top("tub", 0.04, 0.35, 0.028, "#1b33c9");
      p.flank((tub, cover, pod) => { pod.shape([[0, 0.17], [1, 0.17], [1, 0.3], [0, 0.44]], "#1b33c9"); cover.shape([[0.25, 0.17], [1, 0.17], [1, 0.4]], "#1b33c9");
        tub.shape([[0.55, 0.11], [1, 0.11], [1, 0.24]], "#1b33c9"); cover.band(0, 0.25, 0.17, 0.182, "#e8242c"); }); } },
  audi: { colours: { main: "#c3c7cb", second: "#ff2d00", flap: CARBON, plate: "#ff2d00", rear: "#ff2d00", rflap: CARBON, trim: WHITE }, low: 0.05,   // titanium going to black at the tail, blocks of red
    body(p) { p.all([[2.8, "#c6cacd"], [1.0, "#b9bec2"], [-0.9, "#a7acb1"], [-1.5, CARBON], [-2.5, CARBON]]); p.top("cover", 0, 0.3, 0.1, "#ff2d00");      // (silver all down the sidepods, as the real car is: the name on them is black)
      p.flank((tub, cover, pod) => { cover.shape([[0.42, 0.17], [1, 0.17], [1, 0.5], [0.7, 0.5]], "#ff2d00"); pod.shape([[0.78, 0.05], [1, 0.05], [1, 0.56], [0.58, 0.56]], "#ff2d00"); }); } },
  cadillac: { colours: { main: "#0a0c10", second: WHITE, flap: "#d7d9dc", plate: "#0a0c10", rear: "#0a0c10", rflap: WHITE, trim: WHITE }, outlined: true, low: 0.05,     // one side black, the other white, chevrons down the seam
    body(p) { p.side(false, "#0a0c10"); p.side(true, "#f1f1ee");
      for (const key of ["tub", "cover"]) for (let t = 0.06; t < 0.96; t += 0.075) p.part(key).shape([[t, 0.455], [t + 0.03, 0.5], [t, 0.545], [t + 0.018, 0.545], [t + 0.048, 0.5], [t + 0.018, 0.455]], "#8a8e93"); } },
  sauber: { colours: { main: "#00e701", second: CARBON, flap: "#00e701", plate: CARBON, rear: CARBON, rflap: "#00e701", trim: WHITE },
    body(p) { p.all([[2.8, "#00e701"], [0.2, "#00e701"], [-1.0, CARBON], [-2.5, CARBON]]); } },
};
function plain(c) {                   // a team this doesn't know: the game's two colours, a flash down each flank
  const main = c.color, second = c.color2 || "#e8e8e8";
  return { colours: { main, second, flap: second, plate: main, rear: main, rflap: second, trim: second },
    body(p) { p.all(main); p.top("tub", 0.045, 0.63, 0.03, second); p.top("cover", 0, 0.82, 0.07, second);
      p.flank((tub, cover, pod) => { tub.shape([[0.03, 0.2], [0.03, 0.3], [0.5, 0.39], [1, 0.41], [1, 0.11], [0.6, 0.11]], second); cover.shape([[0, 0.17], [0, 0.25], [1, 0.3], [1, 0.17]], second);
        pod.shape([[0, 0.36], [0, 0.46], [1, 0.27], [1, 0.19]], second); }); } };
}
// The words on a car, on one sheet: the driver's three letters, the car's number, and what liveries.json gives the
// team for its sidepods, its engine cover and the back of its rear wing: a name set in type, or a picture of your own.
const SHEET = { code: [0, 176, 0], num: [192, 320, 0], nose: [336, 400, 0], pod: [0, 512, 1], banner: [512, 896, 1], cover: [0, 384, 2] };    // left and right in pixels of 1024, and which of four rows
function cell(name) { const [x0, x1, row] = SHEET[name]; return [x0 / 1024, x1 / 1024, 1 - (row + 1) / 4, 1 - row / 4]; }
const lightness = hex => { const v = parseInt(hex.slice(1, 7), 16); return ((v >> 16) * 0.3 + ((v >> 8) & 255) * 0.59 + (v & 255) * 0.11) / 255; };
function dress(c) {
  const key = TEAM_OF[c.team], look = LOOKS[key] || plain(c), book = S.D.liveries || {};
  const say = (book.stickers !== false && (book.teams || {})[key]) || {};
  let g, W, H;
  const part = (name, flip) => {
    const [x0, x1, y0, y1] = SKINS[name], [zf, zr] = SPAN[name];
    const x = t => (x0 + (x1 - x0) * t) * W, y = a => (1 - (y0 + (y1 - y0) * (flip ? 1 - a : a))) * H;
    const ink = col => {              // a colour, or colours by how far along the car
      if (typeof col === "string") return col;
      const sweep = g.createLinearGradient(x(0), 0, x(1), 0);
      for (const [z, tone] of col) sweep.addColorStop(clamp((zf - z) / (zf - zr), 0, 1), tone);
      return sweep;
    };
    return { x, y,
      band(t0, t1, a0, a1, col) { g.fillStyle = ink(col); g.fillRect(x(t0), Math.min(y(a0), y(a1)), x(t1) - x(t0), Math.abs(y(a1) - y(a0))); },
      shape(points, col) { g.fillStyle = ink(col); g.beginPath(); points.forEach(([t, a], i) => (i ? g.lineTo(x(t), y(a)) : g.moveTo(x(t), y(a)))); g.closePath(); g.fill(); } };
  };
  const flank = fn => { for (const flip of [false, true]) fn(part("tub", flip), part("cover", flip), part(flip ? "podR" : "podL", flip)); };
  const paint = tex(512, 256, (ctx, w, h) => {
    g = ctx; W = w; H = h;
    g.fillStyle = CARBON; g.fillRect(0, 0, W, H);
    look.body({ part, flank,
      all(col) { for (const name of ["tub", "cover", "podL", "podR"]) part(name).band(0, 1, 0, 1, col); },
      top(name, t0, t1, half, col) { part(name).band(t0, t1, 0.5 - half, 0.5 + half, col); },
      side(right, col) { for (const name of ["tub", "cover"]) part(name).band(0, 1, right ? 0.5 : 0, right ? 1 : 0.5, col); part(right ? "podR" : "podL").band(0, 1, 0, 1, col); } });
    // carbon below, and on the side of the pod nobody sees. (low: a team whose sidepods are painted down into the undercut: its big name lies
    // across that line, and half of a dark name on light paint was on the carbon)
    flank((tub, cover, pod) => { tub.band(0, 1, 0, 0.11, CARBON); cover.band(0, 1, 0, 0.17, CARBON); pod.band(0, 1, 0, look.low ?? 0.17, CARBON); pod.band(0, 1, 0.56, 1, CARBON); });
    for (const [name, j] of Object.entries(SWATCH)) { g.fillStyle = name === "carbon" ? CARBON : look.colours[name]; g.fillRect(j * W / 8, 0, W / 8, H * 0.24); }               // the row of plain colours
  }, { repeat: false, aniso: 8, read: true });
  const inkOn = (name, t, a) => {     // dark lettering on light paint, light on dark
    if (look.outlined) return "outlined";
    const q = part(name), d = g.getImageData(Math.round(q.x(t)), Math.round(q.y(a)), 1, 1).data;
    return (d[0] * 0.3 + d[1] * 0.59 + d[2] * 0.11) / 255 > 0.55 ? "#101114" : "#f4f4f2";
  };
  let signs = null;
  signs = tex(1024, 256, (sh, w, h) => {
    sh.clearRect(0, 0, w, h);
    const put = (name, what, ink, ground) => {
      const [x0, x1, row] = SHEET[name], y0 = row * 64, wide = x1 - x0;
      if (ground) { sh.fillStyle = ground; sh.fillRect(x0, y0, wide, 64); }
      if (what == null || what === "") return;
      if (typeof what === "object") {           // a picture of your own: laid in when it has loaded
        const img = new Image();
        img.onload = () => { const k = Math.min((wide - 12) / img.width, 54 / img.height); sh.drawImage(img, x0 + (wide - img.width * k) / 2, y0 + (64 - img.height * k) / 2, img.width * k, img.height * k); signs.needsUpdate = true; };
        img.src = what.image;
        return;
      }
      const str = String(what);
      sh.save(); sh.font = "italic 800 100px system-ui, Segoe UI, Arial, sans-serif"; sh.textAlign = "center"; sh.textBaseline = "middle";
      const natural = sh.measureText(str).width, fit = Math.min(1, (wide - 18) / (natural * 0.62));
      sh.translate(x0 + wide / 2, y0 + 35); sh.scale(0.62 * fit, 0.62);
      if (ink === "outlined") { sh.lineWidth = 13; sh.lineJoin = "round"; sh.strokeStyle = "rgba(0,0,0,0.62)"; sh.strokeText(str, 0, 0); sh.fillStyle = "#ffffff"; } else sh.fillStyle = ink;
      sh.fillText(str, 0, 0); sh.restore();
    };
    const num = c.num == null ? "" : String(c.num);
    put("code", S.code(c.i), "outlined");
    put("num", num, look.numInk || inkOn("cover", 0.63, 0.33));
    put("nose", num, look.numInk || inkOn("tub", 0.375, 0.5));
    put("pod", say.pod, inkOn("podL", 0.37, 0.27));
    put("cover", say.cover, inkOn("cover", 0.32, 0.33));
    put("banner", say.wing, look.outlined ? "outlined" : lightness(look.colours.rflap) > 0.55 ? "#101114" : "#f4f4f2", look.colours.rflap);
  }, { repeat: false, aniso: 8 });
  return { paint, signs, shards: [look.colours.flap, look.colours.plate, CARBON, look.colours.main].map(h => new THREE.Color(h)) };
}

// ---- the shape of the car
// A 2026-sized car (3.5 m between the axles, 1.9 m wide) drawn from loops and plates, the same shape for the whole
// field. +z is forward, +x the driver's left, the road is y = 0. Each loop: [station, half width, bottom, top,
// how square, off centre].
const TUB = [[2.8, 0.055, 0.17, 0.25, 2], [2.6, 0.10, 0.17, 0.30, 2.2], [2.2, 0.15, 0.18, 0.40, 2.4], [1.8, 0.20, 0.19, 0.50, 2.5], [1.4, 0.25, 0.17, 0.58, 2.8],
             [1.0, 0.29, 0.12, 0.63, 3], [0.62, 0.32, 0.09, 0.66, 3.2], [0.2, 0.34, 0.08, 0.66, 3.2], [-0.25, 0.34, 0.08, 0.68, 3.2], [-0.62, 0.33, 0.08, 0.66, 3]];
const COVER = [[-0.02, 0.13, 0.60, 0.99, 2.2], [-0.3, 0.17, 0.50, 1.0, 2.2], [-0.7, 0.26, 0.20, 0.94, 2.4], [-1.2, 0.24, 0.16, 0.80, 2.4], [-1.7, 0.17, 0.16, 0.64, 2.4],
               [-2.15, 0.10, 0.20, 0.50, 2.2], [-2.45, 0.06, 0.24, 0.40, 2]];
const SIDEPOD = side => [[0.78, 0.20, 0.30, 0.60, 3, side * 0.56], [0.4, 0.25, 0.18, 0.62, 3, side * 0.58], [-0.2, 0.27, 0.10, 0.60, 3, side * 0.58],
                     [-0.8, 0.24, 0.10, 0.52, 2.8, side * 0.52], [-1.3, 0.18, 0.10, 0.40, 2.6, side * 0.40], [-1.75, 0.10, 0.12, 0.30, 2.4, side * 0.26]];
const loops = (spec, m) => spec.map(([z, w, y0, y1, sq, cx]) => ring(z, w, y0, y1, sq, cx || 0, m));
function on(spec, z, a, lift = 0) {   // the point on a body's skin at station z, `a` of the way round from the keel, lifted a little off it
  let i = 0;
  while (i < spec.length - 2 && spec[i + 1][0] > z) i++;
  const A = spec[i], B = spec[i + 1], f = clamp((A[0] - z) / (A[0] - B[0]), 0, 1), v = j => lerp(A[j] || 0, B[j] || 0, f);
  const e = 2 / v(4), ang = a * TAU - Math.PI / 2, c = Math.cos(ang), sn = Math.sin(ang);
  const px = v(1) * Math.sign(c) * Math.abs(c) ** e, py = (v(3) - v(2)) / 2 * Math.sign(sn) * Math.abs(sn) ** e, d = Math.hypot(px, py) || 1;
  return [v(5) + px + px / d * lift, (v(2) + v(3)) / 2 + py + py / d * lift, z];
}
// a label lying on a body. Plainly: z runs p0 to p1 across the label and `a` runs q0 to q1 up it. Turned: `a` runs across and z runs up.
function patch(spec, p0, p1, q0, q1, name, turned) {
  const [u0, u1, v0, v1] = cell(name), nu = 8, nv = 4, pos = [], uv = [], idx = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const fu = i / nu, fv = j / nv;
    pos.push(...(turned ? on(spec, lerp(q0, q1, fv), lerp(p0, p1, fu), 0.004) : on(spec, lerp(p0, p1, fu), lerp(q0, q1, fv), 0.004)));
    uv.push(lerp(u0, u1, fu), lerp(v0, v1, fv));
    if (i && j) { const q = j * (nu + 1) + i; idx.push(q - nu - 2, q - nu - 1, q - 1, q - nu - 1, q, q - 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function plaque(g, name) {            // a flat label: the same, for a plane
  const [u0, u1, v0, v1] = cell(name), uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, lerp(u0, u1, uv.getX(i)), lerp(v0, v1, uv.getY(i)));
  return g;
}
function carKit() {
  const paint = [], carbon = [];
  paint.push(skin(loops(TUB, 16), { map: SKINS.tub }), skin(loops(COVER, 16), { map: SKINS.cover }));
  carbon.push(new THREE.CircleGeometry(0.095, 14).scale(1, 1.35, 1).translate(0, 0.83, -0.012));                    // the air intake over the driver's head
  const fin = [[0, 0.99, -0.45], [0, 0.99, -0.75], [0, 0.62, -2.0], [0, 0.56, -2.0], [0, 0.80, -0.75]];
  paint.push(dot(skin([fin.map(([x, y, z]) => [x - 0.008, y, z]), fin.map(([x, y, z]) => [x + 0.008, y, z])], { flat: true }), "second"));
  carbon.push(box(0.26, 0.03, 0.10, 0, 1.045, -0.24), box(0.03, 0.06, 0.08, 0, 1.01, -0.24));                       // the camera pod on top
  // sidepods, undercut at the front and drawn in to the gearbox at the back
  for (const s of [-1, 1]) {
    paint.push(skin(loops(SIDEPOD(s), 12), { map: s > 0 ? SKINS.podL : SKINS.podR }));
    carbon.push(new THREE.PlaneGeometry(0.30, 0.20).translate(s * 0.56, 0.46, 0.785));                               // the radiator inlet
    paint.push(dot(new THREE.SphereGeometry(1, 10, 8).scale(0.075, 0.034, 0.03).translate(s * 0.47, 0.725, 0.44), "main"));       // mirrors
    carbon.push(strut([s * 0.33, 0.66, 0.44], [s * 0.42, 0.715, 0.44], 0.02, 0.02));
  }
  // floor and diffuser
  const edge = [[0.2, 1.38], [0.36, 1.02], [0.79, 0.86], [0.81, -1.15], [0.56, -1.45], [0.5, -2.3]];
  const outline = [...edge, ...edge.slice().reverse().map(([x, z]) => [-x, z])];
  carbon.push(skin([outline.map(([x, z]) => [x, 0.085, z]), outline.map(([x, z]) => [x, 0.045, z])], { flat: true }));
  carbon.push(strut([0, 0.085, -1.88], [0, 0.27, -2.34], 1.0, 0.02));
  // The wings are made in pieces, because they are what breaks. Front: four elements swept back to the tips, cut
  // into a middle, an inner and an outer length each side, and the two endplates.
  const plate = (pts, x, t) => skin([pts.map(([z, y]) => [x - t / 2, y, z]), pts.map(([z, y]) => [x + t / 2, y, z])], { flat: true });
  const wingLength = (xa, xb, steps) => {
    const out = [];
    for (let e = 0; e < 4; e++) {
      const rings = [];
      for (let i = 0; i <= steps; i++) {
        const x = lerp(xa, xb, i / steps), t = Math.abs(x) / 0.93, z0 = 2.82 - 0.105 * e - 0.24 * t ** 1.5, ch = 0.15 - 0.012 * e;
        const y = 0.10 + 0.036 * e + 0.035 * e * t * t, up = 0.012 + 0.014 * e;
        rings.push([[x, y, z0], [x, y + up * 0.7 + 0.012, z0 - ch * 0.45], [x, y + up, z0 - ch], [x, y + up - 0.012, z0 - ch], [x, y - 0.012, z0 - ch * 0.3]]);
      }
      out.push(dot(skin(rings), e < 2 ? "carbon" : "flap"));
    }
    return merge(out);
  };
  const endplate = s => dot(plate([[2.6, 0.06], [2.6, 0.20], [2.42, 0.31], [2.2, 0.33], [2.2, 0.06]], s * 0.94, 0.016), "plate");
  const front = { C: wingLength(-0.22, 0.22, 4), Li: wingLength(0.22, 0.56, 3), Lo: wingLength(0.56, 0.93, 4), Le: endplate(1),
                  Ri: wingLength(-0.56, -0.22, 3), Ro: wingLength(-0.93, -0.56, 4), Re: endplate(-1) };
  front.whole = merge(Object.values(front));
  // Rear: the flap on top, and under it the main plane between its two endplates. The beam wing and the pylon stay whatever happens.
  const across = (z0, ch, y, up, drop) => {
    const rings = [];
    for (let i = 0; i <= 8; i++) { const x = -0.5 + i / 8, d = drop * (1 - (2 * x) ** 2); rings.push([[x, y - d, z0], [x, y - d + up * 0.7 + 0.014, z0 - ch * 0.45], [x, y - d + up, z0 - ch], [x, y - d + up - 0.014, z0 - ch], [x, y - d - 0.014, z0 - ch * 0.3]]); }
    return skin(rings);
  };
  const rearPlate = s => dot(plate([[-2.18, 0.30], [-2.14, 0.72], [-2.22, 0.97], [-2.72, 0.97], [-2.72, 0.50], [-2.5, 0.30]], s * 0.515, 0.018), "rear");
  const rear = { flap: dot(across(-2.53, 0.15, 0.89, 0.07, 0.02), "rflap"), upper: merge([dot(across(-2.26, 0.30, 0.80, 0.07, 0.035), "carbon"), rearPlate(1), rearPlate(-1)]) };
  rear.labels = merge([plaque(new THREE.PlaneGeometry(0.44, 0.165).rotateY(Math.PI / 2).translate(0.526, 0.74, -2.46), "code"),
                       plaque(new THREE.PlaneGeometry(0.44, 0.165).rotateY(-Math.PI / 2).translate(-0.526, 0.74, -2.46), "code"),
                       plaque(new THREE.PlaneGeometry(0.94, 0.155).rotateY(Math.PI).translate(0, 0.885, -2.705), "banner")]);
  carbon.push(across(-2.3, 0.15, 0.43, 0.03, 0), box(0.03, 0.34, 0.16, 0, 0.62, -2.36), box(0.09, 0.12, 0.3, 0, 0.36, -2.52));
  // halo, cockpit and driver
  const hoop = new THREE.CatmullRomCurve3([[0.30, 0.70, -0.3], [0.29, 0.85, 0.08], [0.18, 0.895, 0.4], [0, 0.895, 0.52], [-0.18, 0.895, 0.4], [-0.29, 0.85, 0.08], [-0.30, 0.70, -0.3]].map(q => new THREE.Vector3(...q)));
  carbon.push(new THREE.TubeGeometry(hoop, 28, 0.03, 7), strut([0, 0.63, 0.62], [0, 0.885, 0.52], 0.045, 0.03));
  carbon.push(new THREE.SphereGeometry(1, 14, 8).scale(0.215, 0.03, 0.42).translate(0, 0.665, 0.16));               // the cockpit opening
  paint.push(dot(new THREE.SphereGeometry(0.128, 16, 12).scale(1, 1, 1.12).translate(0, 0.75, 0.08), "trim"));       // helmet
  carbon.push(new THREE.SphereGeometry(1, 12, 8).scale(0.105, 0.042, 0.06).translate(0, 0.762, 0.185));             // visor
  // suspension: wishbones, pushrods, track rods, driveshafts
  for (const s of [-1, 1]) {
    const f = s * 0.63, r = s * 0.57;
    carbon.push(strut([f, 0.50, AXLE], [s * 0.19, 0.50, 1.98]), strut([f, 0.50, AXLE], [s * 0.22, 0.53, 1.36]), strut([f, 0.22, AXLE], [s * 0.16, 0.22, 2.02]),
                strut([f, 0.22, AXLE], [s * 0.21, 0.2, 1.4]), strut([f, 0.24, AXLE], [s * 0.2, 0.55, 1.62], 0.02, 0.02), strut([f, 0.36, AXLE + 0.12], [s * 0.19, 0.36, 1.92], 0.016, 0.016),
                strut([r, 0.50, -AXLE], [s * 0.13, 0.46, -1.45]), strut([r, 0.50, -AXLE], [s * 0.1, 0.46, -2.06]), strut([r, 0.2, -AXLE], [s * 0.15, 0.2, -1.4]),
                strut([r, 0.2, -AXLE], [s * 0.1, 0.22, -2.1]), strut([r, 0.36, -AXLE], [s * 0.1, 0.36, -AXLE], 0.04, 0.04));
  }
  // the lettering: a name down each sidepod, the team's name and the car's number on each side of the engine cover, the
  // number on the nose (facing forward, as a real one does), the driver's letters on the fin
  const labels = merge([
    patch(SIDEPOD(1), 0.45, -0.75, 0.215, 0.33, "pod"), patch(SIDEPOD(-1), -0.75, 0.45, 0.785, 0.67, "pod"),
    patch(COVER, -0.35, -1.25, 0.29, 0.375, "cover"), patch(COVER, -1.25, -0.35, 0.71, 0.625, "cover"),
    patch(COVER, -1.36, -1.74, 0.28, 0.385, "num"), patch(COVER, -1.74, -1.36, 0.72, 0.615, "num"),
    patch(TUB, 0.58, 0.42, 1.64, 1.40, "nose", true),
    plaque(new THREE.PlaneGeometry(0.5, 0.19).rotateY(Math.PI / 2).translate(0.0095, 0.80, -1.16), "code"),
    plaque(new THREE.PlaneGeometry(0.5, 0.19).rotateY(-Math.PI / 2).translate(-0.0095, 0.80, -1.16), "code")]);
  // a wheel: the tyre with rounded shoulders, turned on its side
  const tyre = w => new THREE.LatheGeometry([[0.236, -w / 2 + 0.012], [0.30, -w / 2], [0.342, -w / 2 + 0.028], [TYRE_R, -w / 2 + 0.075], [TYRE_R, w / 2 - 0.075],
                                             [0.342, w / 2 - 0.028], [0.30, w / 2], [0.236, w / 2 - 0.012]].map(q => new THREE.Vector2(...q)), 28).rotateZ(Math.PI / 2);
  return { paint: merge(paint), carbon: merge(carbon), front, rear, labels, tyreF: tyre(0.30), tyreR: tyre(0.38) };
}
function coverTexture(blurred) {
  return tex(128, 128, (c, w) => {
    const m = w / 2;
    c.clearRect(0, 0, w, w); c.fillStyle = "#16181b"; c.beginPath(); c.arc(m, m, m - 1, 0, TAU); c.fill();
    c.strokeStyle = "#8d949c"; c.lineWidth = 5; c.beginPath(); c.arc(m, m, m - 6, 0, TAU); c.stroke();
    if (blurred) { c.strokeStyle = "rgba(190,196,204,0.28)"; c.lineWidth = 9; c.beginPath(); c.arc(m, m, m * 0.52, 0, TAU); c.stroke(); }
    else { c.strokeStyle = "#aeb4bb"; c.lineWidth = 5; for (let i = 0; i < 5; i++) { const a = i / 5 * TAU; c.beginPath(); c.moveTo(m + Math.cos(a) * 14, m + Math.sin(a) * 14); c.lineTo(m + Math.cos(a) * (m - 9), m + Math.sin(a) * (m - 9)); c.stroke(); }
           c.fillStyle = "#c81e1a"; c.beginPath(); c.arc(m, m - m * 0.62, 5, 0, TAU); c.fill(); }
    c.fillStyle = "#2a2d31"; c.beginPath(); c.arc(m, m, 12, 0, TAU); c.fill();
  }, { repeat: false });
}
let kit, shared;
function makeCar(c) {
  kit = kit || carKit();
  shared = shared || {
    carbon: new THREE.MeshStandardMaterial({ color: 0x0e0f11, roughness: 0.5, metalness: 0.35, envMapIntensity: 0.45, side: both }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.88, envMapIntensity: 0.4 }),
    cover: new THREE.MeshStandardMaterial({ map: coverTexture(false), roughness: 0.4, metalness: 0.5, transparent: true, alphaTest: 0.5 }),
    blur: new THREE.MeshStandardMaterial({ map: coverTexture(true), roughness: 0.4, metalness: 0.5, transparent: true, alphaTest: 0.5 }),
    stripes: {}, stripe(color) { return this.stripes[color] = this.stripes[color] || new THREE.MeshBasicMaterial({ color: new THREE.Color(color || "#444444").multiplyScalar(0.85), side: both }); },
    disc: new THREE.CircleGeometry(0.238, 24), band: new THREE.RingGeometry(0.256, 0.304, 32),
    shadow: new THREE.MeshBasicMaterial({ map: tex(64, 128, (g, w, h) => {
      g.clearRect(0, 0, w, h); g.shadowColor = "rgba(0,0,0,0.9)"; g.shadowBlur = 13; g.fillStyle = "rgba(0,0,0,0.62)"; g.fillRect(15, 17, w - 30, h - 34);
    }, { repeat: false }), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 }),
  };
  const car = new THREE.Group(), body = new THREE.Group();        // the car stands on its wheels; the body rides on springs inside it
  car.add(body);
  const wear = dress(c);
  const paint = new THREE.MeshPhysicalMaterial({ map: wear.paint, roughness: 0.34, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08, side: both });
  const lettering = new THREE.MeshStandardMaterial({ map: wear.signs, transparent: true, alphaTest: 0.3, roughness: 0.4, side: both, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const piece = (geo, mat, shadow = true) => { const m = new THREE.Mesh(geo, mat); m.castShadow = shadow; return m; };
  body.add(piece(kit.paint, paint), piece(kit.carbon, shared.carbon), piece(kit.labels, lettering, false));
  // the wings: whole until something hits them, then whichever pieces are left
  const front = { whole: piece(kit.front.whole, paint), parts: {} };
  body.add(front.whole);
  for (const name of ["C", "Li", "Lo", "Le", "Ri", "Ro", "Re"]) { const m = piece(kit.front[name], paint); m.visible = false; front.parts[name] = m; body.add(m); }
  const rear = { flap: piece(kit.rear.flap, paint), upper: new THREE.Group() };
  rear.upper.add(piece(kit.rear.upper, paint), piece(kit.rear.labels, lettering, false));
  body.add(rear.flap, rear.upper);
  // the rain light, used here as a brake light
  const light = new THREE.MeshBasicMaterial({ color: 0x330000 });
  body.add(new THREE.Mesh(box(0.1, 0.13, 0.03, 0, 0.36, -2.675), light));
  // wheels: each in a hub that steers, holding a tyre that spins. The coloured band on each sidewall is the compound.
  const wheels = [];
  for (const [x, z] of WHEEL_AT) {
    const hub = new THREE.Group(), spin = new THREE.Group(), isFront = z > 0, w = isFront ? 0.30 : 0.38, out = Math.sign(x);
    hub.position.set(x, TYRE_R, z);
    const tyre = new THREE.Mesh(isFront ? kit.tyreF : kit.tyreR, shared.rubber); tyre.castShadow = true;
    const cover = new THREE.Mesh(shared.disc, shared.cover); cover.rotation.y = out * Math.PI / 2; cover.position.x = out * (w / 2 - 0.006);
    const inner = new THREE.Mesh(shared.disc, shared.carbon); inner.rotation.y = -out * Math.PI / 2; inner.position.x = -out * (w / 2 - 0.02);
    const bands = [1, -1].map(face => { const m = new THREE.Mesh(shared.band, shared.stripe(null)); m.rotation.y = face * out * Math.PI / 2; m.position.x = face * out * (w / 2 + 0.002); return m; });
    spin.add(tyre, cover, inner, ...bands); hub.add(spin); car.add(hub);
    wheels.push({ hub, spin, front: isFront, cover, bands });
  }
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 6.3).rotateX(-Math.PI / 2), shared.shadow); blob.position.y = 0.012; blob.renderOrder = 1; car.add(blob);
  // the three-letter name floating over the car
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex(160, 56, (g, w, h) => {
    g.clearRect(0, 0, w, h); g.fillStyle = "rgba(8,9,11,0.82)"; g.beginPath(); g.roundRect(2, 2, w - 4, h - 4, 9); g.fill();
    g.fillStyle = c.color; g.fillRect(10, 10, 9, h - 20);
    g.fillStyle = "#fff"; g.font = "700 32px system-ui, Segoe UI, Arial, sans-serif"; g.textBaseline = "middle"; g.fillText(S.code(c.i), 30, h / 2 + 2);
  }, { repeat: false }), depthFunc: THREE.AlwaysDepth, alphaTest: 0.05, transparent: true }));      // seen through anything, and known to be as far off as its car is (so a long lens leaves the chosen car's name sharp)
  tag.position.set(0, 1.75, 0); tag.renderOrder = 6; car.add(tag);
  car.userData = { i: c.i, body, wheels, light, tag, front, rear, wear, shards: wear.shards, hurt: undefined, spin: 0, tyre: undefined, hint: null, t: null, scrape: 0, sus: { y: null, v: 0, ground: 0 } };
  return car;
}

// ---- damage
// The game reports how much of each wing is left, as it happens. Here a wing loses its endplate first, then its
// outer length, then the whole side; a new one goes on at the next pit stop, because the report says so.
function damageAt(i, t) {             // the last damage report for car i at or before replay time t: [time, front left, front right, rear wing, floor, diffuser, sidepods, engine]
  const rows = (S.D.damage || {})[i];
  let found = null;
  if (rows) for (const row of rows) { if (row[0] > t) break; found = row; }
  return found;
}
function wreck(u, d) {
  const left = d ? d[1] : 0, right = d ? d[2] : 0, back = d ? d[3] : 0, hurt = left > 0 || right > 0, q = u.front.parts;
  u.front.whole.visible = !hurt;
  q.C.visible = hurt;
  q.Le.visible = hurt && left < 5; q.Lo.visible = hurt && left < 30; q.Li.visible = hurt && left < 55;
  q.Re.visible = hurt && right < 5; q.Ro.visible = hurt && right < 30; q.Ri.visible = hurt && right < 55;
  u.rear.flap.visible = back < 25; u.rear.upper.visible = back < 60;
}

// where car i is at replay time t: position on the road, heading, tilt, speed and inputs, eased between samples
function pose(i, t) {
  const C = S.CH, f = S.frameAt(t), k = Math.min(S.N - 2, Math.floor(f)), a = f - k;
  const x0 = C.x[i][k], z0 = C.z[i][k], x1 = C.x[i][k + 1], z1 = C.z[i][k + 1];
  if (!x0 && !z0) return null;
  const jump = Math.abs(x1 - x0) + Math.abs(z1 - z0) > 600, b = jump ? 0 : a;      // a teleport (to the grid, to the garage) is not a drive
  return { x: lerp(x0, x1, b) / 10, y: lerp(C.y[i][k], C.y[i][k + 1], b) / 10 - RIDE, z: lerp(z0, z1, b) / 10,
           yaw: lerpAngle(C.yaw[i][k] / 1e4, C.yaw[i][k + 1] / 1e4, b), pitch: lerp(C.pitch[i][k], C.pitch[i][k + 1], b) / 1e4,
           roll: lerp(C.roll[i][k], C.roll[i][k + 1], b) / 1e4, speed: lerp(C.speed[i][k], C.speed[i][k + 1], b),
           steer: lerp(C.steer[i][k], C.steer[i][k + 1], b) / 100, brake: C.brake[i][k] / 100 };
}

// ------------------------------------------------------------------ wheels on the ground, the body on its springs
// Each wheel stands on the ground under it: the same ground that is drawn, kerbs and all. The car sits on the plane
// through its four contact patches, and each wheel rides up or down from that plane by whatever is left over, so
// one wheel on a kerb comes up while the other three stay down. The body rides on top. Its pitch and roll are the
// game's own (it reports the body leaning on its springs: about a degree in a fast corner, a dip under brakes),
// made a little livelier and held within what a suspension allows. Its height is a damped spring over the
// ground, pressed down by speed as downforce does. Stage3D.suspension holds the numbers.
const SPRING = {
  pitch: 2.5, roll: 1.15,             // how much of the game's own dive and lean to show (1 = as reported; its dive is slight, so that is shown larger)
  maxPitch: 0.021, maxRoll: 0.027,    // and the most the body may tip against its wheels, radians
  aero: 1.6e-6,                       // metres the car is pressed down per (m/s) squared: about 14 mm flat out
  stiff: 20, damp: 0.45,              // the spring the body rides on: about 3 Hz, settling in a bounce or so
  up: 0.03, down: 0.024,              // how far the body may rise or sink on it
  ride: 0.02, clear: 0.012,           // how high the body rides at rest, and the least air kept under its floor and wings
  rest: { pitch: 0, roll: 0 },        // how the game's cars sit when nothing is happening (found by calibrate())
};
const contact = [0, 0, 0, 0], loose = [false, false, false, false];
const TREAD = [0, 0.11, -0.11];       // a tyre is wide: it stands on the highest ground under it, so it rides a kerb until it is clear of it
// places the floor or a wing would touch first: metres to the left, height, metres forward (in the body's own frame)
const SKIDS = [[0.94, 0.06, 2.45], [-0.94, 0.06, 2.45], [0.8, 0.045, -0.15], [-0.8, 0.045, -0.15], [0.5, 0.045, -2.25], [-0.5, 0.045, -2.25]];
function stand(u, p) {                // the ground under each wheel, and the plane through the four
  const sn = Math.sin(p.yaw), cs = Math.cos(p.yaw);
  for (let w = 0; w < 4; w++) {
    const lz = WHEEL_AT[w][1];
    let top = -1e9;
    for (const across of TREAD) {
      const lx = WHEEL_AT[w][0] + across, hit = groundAt(p.x + lz * sn + lx * cs, p.z + lz * cs - lx * sn, u.hint);
      u.hint = hit.k;
      if (hit.y > top) top = hit.y;
      if (!across) {                    // the middle of the tyre says what it is running on
        const side = hit.off < LEFT[hit.k] ? GRAVEL.L : hit.off > RIGHT[hit.k] ? GRAVEL.R : null;
        const out = side ? (hit.off < LEFT[hit.k] ? LEFT[hit.k] - hit.off : hit.off - RIGHT[hit.k]) : 0;
        loose[w] = side !== null && side.to[hit.k] - side.from[hit.k] > 1.5 && out > side.from[hit.k] && out < side.to[hit.k];
      }
    }
    contact[w] = top;
  }
  const fore = (contact[0] + contact[1] - contact[2] - contact[3]) / (4 * AXLE);            // metres up per metre forward
  const left = ((contact[0] - contact[1]) / 1.6 + (contact[2] - contact[3]) / 1.52) / 2;      // metres up per metre to the left
  return { y: (contact[0] + contact[1] + contact[2] + contact[3]) / 4, fore, left, pitch: -Math.atan(fore), roll: Math.atan(left) };
}
function place(car, p, t) {
  const u = car.userData, on = stand(u, p), sus = u.sus, dt = u.t === null ? -1 : t - u.t;
  u.t = t;
  if (Math.abs(on.y - p.y) > 0.8 || Math.abs(p.roll - on.roll) > 0.14 || Math.abs(p.pitch - on.pitch) > 0.14) {
    // off the surveyed world, or on its side: drawn just as the game had it
    car.position.set(p.x, p.y, p.z); car.rotation.set(p.pitch, p.yaw, p.roll, "YXZ");
    for (const w of u.wheels) w.hub.position.y = TYRE_R;
    u.body.position.y = SPRING.ride; u.body.rotation.set(0, 0, 0); sus.y = null;
    return;
  }
  car.position.set(p.x, on.y, p.z); car.rotation.set(on.pitch, p.yaw, on.roll, "YXZ");
  for (let w = 0; w < 4; w++) u.wheels[w].hub.position.y = TYRE_R - 0.004 + contact[w] - (on.y + on.fore * WHEEL_AT[w][1] + on.left * WHEEL_AT[w][0]);
  const dive = clamp((p.pitch - on.pitch - SPRING.rest.pitch) * SPRING.pitch, -SPRING.maxPitch, SPRING.maxPitch);
  const lean = clamp((p.roll - on.roll - SPRING.rest.roll) * SPRING.roll, -SPRING.maxRoll, SPRING.maxRoll);
  const press = -SPRING.aero * (p.speed / 3.6) ** 2;
  let climb = 0;
  if (sus.y === null || dt < 0 || dt >= 0.12) { sus.y = on.y + press; sus.v = 0; }             // first sight, a seek, a cut: start settled
  else if (dt > 0) {
    const steps = Math.ceil(dt / 0.008), h = dt / steps;
    climb = (on.y - sus.ground) / dt;                                                          // the ground's own rise and fall under the car
    for (let st = 1; st <= steps; st++) {
      sus.v += (SPRING.stiff ** 2 * (sus.ground + climb * h * st + press - sus.y) + 2 * SPRING.damp * SPRING.stiff * (climb - sus.v)) * h;
      sus.y += sus.v * h;
    }
    const rel = sus.y - on.y;
    if (rel < -SPRING.down || rel > SPRING.up) { sus.y = on.y + clamp(rel, -SPRING.down, SPRING.up); sus.v = climb; }       // the bump stops
  }
  // the floor and the wings ride over whatever is under them: a kerb lifts the body as it would
  const sn = Math.sin(p.yaw), cs = Math.cos(p.yaw);
  let short = 0;
  for (const [lx, ly, lz] of SKIDS) {
    const air = sus.y + SPRING.ride + ly + lx * (on.left + lean) + lz * (on.fore - dive) - groundAt(p.x + lz * sn + lx * cs, p.z + lz * cs - lx * sn, u.hint).y;
    if (SPRING.clear - air > short) short = SPRING.clear - air;
  }
  if (short > 0) { sus.y += short; if (sus.v < climb) sus.v = climb; }
  if (dt > 0 && dt < 0.12 && fx) {
    const v = p.speed / 3.6;
    // sparks: the plank under the floor touching down, on a kerb or when the car is pressed flat at full speed
    // (it comes in bursts: once it touches, it scrapes for a moment)
    if ((short > FX.sparkKerb && p.speed > 170) || (p.speed > FX.sparkSpeed && sus.y - on.y - press < -FX.sparkDip)) u.scrape = 0.08 + Math.random() * 0.24;
    if (u.scrape > 0) {
      u.scrape -= dt;
      for (let q = Math.round(dt * FX.sparkRate * (0.6 + Math.random())); q > 0; q--) {
        const lx = (Math.random() - 0.5) * 0.4, lz = -0.3 - Math.random() * 1.2, drag = 0.25 + Math.random() * 0.4, side = (Math.random() - 0.5) * 5;
        spark(p.x + lz * sn + lx * cs, on.y + 0.03, p.z + lz * cs - lx * sn, sn * v * drag + cs * side, 0.4 + Math.random() * 2.8, cs * v * drag - sn * side);
      }
    }
    // dust: any wheel in the gravel throws it up
    for (let w = 0; w < 4; w++) if (loose[w] && v > 6 && Math.random() < dt * FX.dustRate * Math.min(1, v / 30)) {
      const lx = WHEEL_AT[w][0], lz = WHEEL_AT[w][1] - 0.3;
      puff(p.x + lz * sn + lx * cs, contact[w] + 0.25, p.z + lz * cs - lx * sn, sn * v * 0.12 + (Math.random() - 0.5) * 2, 0.8 + Math.random() * 1.6, cs * v * 0.12 + (Math.random() - 0.5) * 2);
    }
  }
  sus.ground = on.y;
  u.body.position.y = SPRING.ride + sus.y - on.y;
  u.body.rotation.set(dive, 0, lean);
}
// Sparks are short bright streaks that fly, fall and die in under half a second. Dust is soft puffs that swell and
// fade. Both live in fixed pools (the oldest is reused) and move on replay time, so a paused replay holds them still.
const FX = { sparks: 420, dust: 150, bits: 64, bitLife: 14, sparkSpeed: 292, sparkDip: 0.0068, sparkKerb: 0.013, sparkRate: 300, dustRate: 26 };
let fx = null;
const bitM = new THREE.Matrix4(), bitQ = new THREE.Quaternion(), bitV = new THREE.Vector3(), bitP = new THREE.Vector3(), bitS = new THREE.Vector3();
function effects() {
  const sg = new THREE.BufferGeometry();
  sg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(FX.sparks * 6), 3));
  sg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(FX.sparks * 6), 3));
  const streaks = new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }));
  streaks.frustumCulled = false;
  const dg = new THREE.BufferGeometry();
  dg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(FX.dust * 3), 3));
  dg.setAttribute("size", new THREE.BufferAttribute(new Float32Array(FX.dust), 1));
  dg.setAttribute("fade", new THREE.BufferAttribute(new Float32Array(FX.dust), 1));
  const cloud = new THREE.Points(dg, new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { scale: { value: 500 }, tone: { value: new THREE.Color(0.40, 0.35, 0.27) } },
    vertexShader: "attribute float size; attribute float fade; uniform float scale; varying float vFade; void main(){ vFade = fade; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = size * scale / max(0.5, -mv.z); gl_Position = projectionMatrix * mv; }",
    fragmentShader: "uniform vec3 tone; varying float vFade; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = (1.0 - smoothstep(0.15, 1.0, d)) * vFade; if (a < 0.004) discard; gl_FragColor = vec4(tone, a); }" }));
  cloud.frustumCulled = false;
  // pieces of broken wing: they fly, tumble, land and lie on the road a while
  const shards = new THREE.InstancedMesh(new THREE.BoxGeometry(0.28, 0.018, 0.14), new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.25 }), FX.bits);
  shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage); shards.frustumCulled = false; shards.castShadow = true;
  const nowhere = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < FX.bits; i++) { shards.setMatrixAt(i, nowhere); shards.setColorAt(i, new THREE.Color(0x101010)); }
  scene.add(streaks, cloud, shards);
  fx = { streaks, cloud, shards, at: null, nextSpark: 0, nextPuff: 0, nextBit: 0,
         bp: new Float32Array(FX.bits * 3), bv: new Float32Array(FX.bits * 3), bx: new Float32Array(FX.bits * 3), ba: new Float32Array(FX.bits), bw: new Float32Array(FX.bits),
         bl: new Float32Array(FX.bits), bf: new Float32Array(FX.bits), bs: new Float32Array(FX.bits),
         sp: new Float32Array(FX.sparks * 3), sv: new Float32Array(FX.sparks * 3), sl: new Float32Array(FX.sparks), ss: new Float32Array(FX.sparks), sf: new Float32Array(FX.sparks),
         dv: new Float32Array(FX.dust * 3), dl: new Float32Array(FX.dust), ds: new Float32Array(FX.dust) };
}
function shatter(p, y, lx, lz, colours) {     // a wing breaking: pieces of it, and a shower of sparks
  const sn = Math.sin(p.yaw), cs = Math.cos(p.yaw), v = p.speed / 3.6, x = p.x + lz * sn + lx * cs, z = p.z + lz * cs - lx * sn, floor = groundAt(x, z, null).y;
  for (let q = 0; q < 10; q++) {
    const i = fx.nextBit; fx.nextBit = (i + 1) % FX.bits;
    const keep = 0.45 + Math.random() * 0.5, out = (Math.random() - 0.5) * 10, axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    fx.bp.set([x, y + 0.15 + Math.random() * 0.25, z], i * 3); fx.bv.set([sn * v * keep + cs * out, 1 + Math.random() * 4.5, cs * v * keep - sn * out], i * 3);
    fx.bx.set([axis.x, axis.y, axis.z], i * 3); fx.ba[i] = Math.random() * 6; fx.bw[i] = (Math.random() - 0.5) * 30; fx.bl[i] = FX.bitLife; fx.bf[i] = floor + 0.012; fx.bs[i] = 0.6 + Math.random() * 0.9;
    fx.shards.setColorAt(i, colours[q % colours.length]);
  }
  fx.shards.instanceColor.needsUpdate = true;
  for (let q = 0; q < 36; q++) spark(x, y + 0.1, z, sn * v * (0.3 + Math.random() * 0.5) + (Math.random() - 0.5) * 9, 0.5 + Math.random() * 4.5, cs * v * (0.3 + Math.random() * 0.5) + (Math.random() - 0.5) * 9);
}
function spark(x, y, z, vx, vy, vz) {
  const i = fx.nextSpark; fx.nextSpark = (i + 1) % FX.sparks;
  fx.sp.set([x, y, z], i * 3); fx.sv.set([vx, vy, vz], i * 3); fx.sl[i] = fx.ss[i] = 0.16 + Math.random() * 0.34; fx.sf[i] = y - 0.03;
}
function puff(x, y, z, vx, vy, vz) {
  const i = fx.nextPuff; fx.nextPuff = (i + 1) % FX.dust;
  fx.cloud.geometry.attributes.position.array.set([x, y, z], i * 3); fx.dv.set([vx, vy, vz], i * 3); fx.dl[i] = fx.ds[i] = 1.0 + Math.random() * 0.9;
}
function stepEffects(t) {
  let dt = fx.at === null ? 0 : t - fx.at;
  fx.at = t;
  if (dt < 0 || dt > 0.25) { fx.sl.fill(0); fx.dl.fill(0); fx.bl.fill(0); dt = 0; }       // a seek: clear the air, and the road
  const sp = fx.sp, sv = fx.sv, pos = fx.streaks.geometry.attributes.position.array, col = fx.streaks.geometry.attributes.color.array;
  for (let i = 0; i < FX.sparks; i++) {
    const a = i * 3, b = i * 6;
    if (fx.sl[i] <= 0) { col[b] = col[b + 1] = col[b + 2] = col[b + 3] = col[b + 4] = col[b + 5] = 0; continue; }
    fx.sl[i] -= dt;
    sv[a + 1] -= 9.8 * dt;
    const hold = Math.max(0, 1 - 2.2 * dt);                                 // the air slows them
    sv[a] *= hold; sv[a + 2] *= hold;
    sp[a] += sv[a] * dt; sp[a + 1] += sv[a + 1] * dt; sp[a + 2] += sv[a + 2] * dt;
    if (sp[a + 1] < fx.sf[i]) { sp[a + 1] = fx.sf[i]; sv[a + 1] = Math.abs(sv[a + 1]) * 0.35; }     // and they skip off the road
    const f = Math.max(0, fx.sl[i] / fx.ss[i]), tail = 0.016;
    pos[b] = sp[a]; pos[b + 1] = sp[a + 1]; pos[b + 2] = sp[a + 2];
    pos[b + 3] = sp[a] - sv[a] * tail; pos[b + 4] = sp[a + 1] - sv[a + 1] * tail; pos[b + 5] = sp[a + 2] - sv[a + 2] * tail;
    col[b] = 9 * f; col[b + 1] = 4.2 * f * f; col[b + 2] = 1.1 * f * f * f;                       // white-hot, then orange, then gone
    col[b + 3] = 3 * f; col[b + 4] = 1.1 * f * f; col[b + 5] = 0.2 * f * f;
  }
  fx.streaks.geometry.attributes.position.needsUpdate = fx.streaks.geometry.attributes.color.needsUpdate = true;
  const dp = fx.cloud.geometry.attributes.position.array, size = fx.cloud.geometry.attributes.size.array, fade = fx.cloud.geometry.attributes.fade.array;
  for (let i = 0; i < FX.dust; i++) {
    if (fx.dl[i] <= 0) { fade[i] = 0; continue; }
    fx.dl[i] -= dt;
    const a = i * 3, f = Math.max(0, fx.dl[i] / fx.ds[i]), hold = Math.max(0, 1 - 1.6 * dt);
    fx.dv[a] *= hold; fx.dv[a + 1] *= hold; fx.dv[a + 2] *= hold;
    dp[a] += fx.dv[a] * dt; dp[a + 1] += fx.dv[a + 1] * dt; dp[a + 2] += fx.dv[a + 2] * dt;
    size[i] = 0.9 + (1 - f) * 3.4; fade[i] = 0.42 * f * Math.min(1, (1 - f) * 8);               // swelling as it thins
  }
  for (const name of ["position", "size", "fade"]) fx.cloud.geometry.attributes[name].needsUpdate = true;
  for (let i = 0; i < FX.bits; i++) {
    const a = i * 3;
    if (fx.bl[i] <= 0) { if (fx.bl[i] > -1) { fx.shards.setMatrixAt(i, bitM.makeScale(0, 0, 0)); fx.bl[i] = -2; } continue; }
    fx.bl[i] -= dt;
    fx.bv[a + 1] -= 9.8 * dt;
    fx.bp[a] += fx.bv[a] * dt; fx.bp[a + 1] += fx.bv[a + 1] * dt; fx.bp[a + 2] += fx.bv[a + 2] * dt;
    fx.ba[i] += fx.bw[i] * dt;
    if (fx.bp[a + 1] < fx.bf[i]) {                                           // it lands: a bounce or two, then it slides to a stop and lies flat
      fx.bp[a + 1] = fx.bf[i]; fx.bv[a + 1] = Math.abs(fx.bv[a + 1]) * 0.3;
      const grip = Math.max(0, 1 - 6 * dt) * 0.8; fx.bv[a] *= grip; fx.bv[a + 2] *= grip; fx.bw[i] *= 0.5;
      if (fx.bv[a + 1] < 0.6) { fx.bv[a + 1] = 0; fx.bx.set([0, 1, 0], a); }
    }
    const size = fx.bs[i] * Math.min(1, fx.bl[i]);                          // shrinking away in its last second
    bitQ.setFromAxisAngle(bitV.set(fx.bx[a], fx.bx[a + 1], fx.bx[a + 2]), fx.ba[i]);
    fx.shards.setMatrixAt(i, bitM.compose(bitP.set(fx.bp[a], fx.bp[a + 1], fx.bp[a + 2]), bitQ, bitS.set(size, size, size)));
  }
  fx.shards.instanceMatrix.needsUpdate = true;
  fx.cloud.material.uniforms.scale.value = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360));
}
function calibrate() {                // how the game's cars sit when running straight at a steady speed: taken off, so the body rests level
  const r = seeded(3), pitches = [], rolls = [], probe = { hint: null };
  for (let tries = 0; tries < 6000 && pitches.length < 300; tries++) {
    const c = S.CARS[Math.floor(r() * S.CARS.length)], t = S.D.t0 + r() * (S.D.frames - 10) * S.D.dt;
    if (!S.active(c.i, t)) continue;
    const p = pose(c.i, t), q = pose(c.i, t + 0.3);
    if (!p || !q || p.speed < 60 || Math.abs(q.speed - p.speed) > 3 || Math.abs(turn(p.yaw, q.yaw)) > 0.006) continue;
    probe.hint = null;
    const on = stand(probe, p);
    if (Math.abs(on.y - p.y) > 0.8) continue;
    pitches.push(p.pitch - on.pitch); rolls.push(p.roll - on.roll);
  }
  const middle = v => (v.length ? v.sort((a, b) => a - b)[Math.floor(v.length / 2)] : 0);
  SPRING.rest.pitch = middle(pitches); SPRING.rest.roll = middle(rolls);
}

// ------------------------------------------------------------------ cameras
// Every camera stays with the chosen car.
//   TV pod     the broadcast's onboard: in the left arm of the T on top of the airbox, fixed to the car, so the world
//              tilts and shakes as it does. Set against frames of the real feed (Eric: "that iconic camera angle of
//              the top left of the car"): it looks 15 degrees down, so the horizon is a quarter of the way down the
//              picture, the halo arches across the lower half and the driver's hands and the top of his helmet are
//              at the bottom; its lens is a good deal longer than a game's (57 degrees top to bottom); and being off
//              to one side it is turned in, to look at the car's middle line a little way ahead, which keeps the
//              nose near the middle of the picture. Every vehicle's pod camera looks the same way from wherever
//              that vehicle has it (kit.pod).
//   Chase      behind and above, swinging round after the car a moment late
//   Orbit      anywhere on the half sphere over the car; drag to move, wheel or pinch to zoom
//   Trackside  television cameras on the walls round the lap, each panning and zooming with the car as it comes by
//   Director   cuts between them all, as a broadcast does
//   Commentary the director, told by the page what the hosts are talking about (its storyStep): the car, the shot, and
//              for two cars in something together a shot of its own ("duo": both in one picture, from behind and
//              above the middle of the pair, along the road)
//   Drone      a racing drone flown round the car for show: chases, orbits, a loop over it, a tornado (replay3d_lens.js)
// The trackside cameras and the helicopter have long lenses: what is nearer or farther than the chosen car is soft.
const POD = { at: new THREE.Vector3(0.12, 1.1, -0.12), down: 0.26, ahead: 1.4, fov: 57 };      // where it is on the typed-in car; how far down it looks; how far ahead the point on the middle line it is turned to; its lens
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), e1 = new THREE.Euler();
const STATIONS = (() => {       // a camera every 280 m or so, on the outside of the bends, never behind the pit building
  const out = [], mean = ease(bend, 18), count = Math.max(4, Math.round(n / 70));
  for (let i = 0; i < count; i++) {
    const k = Math.round(i * n / count), b = mean[wrap(k + 8)];
    let sign = Math.abs(b) > 0.0015 ? (b > 0 ? -1 : 1) : (i % 2 ? -1 : 1);
    if (lane && lane.has(k)) sign = -lane.side;
    const w = (sign < 0 ? WALL.L : WALL.R)[k], at3 = at(k, sign * within(k, sign, w + 2.5), 5.4 + (i * 7 % 5) * 0.9);
    out.push({ k, pos: new THREE.Vector3(at3[0], at3[1], at3[2]) });
  }
  return out;
})();
function sectionOf(x, z, hint) {            // which 4 m of the lap a point is beside
  let best = hint ?? 0, d0 = 1e18;
  const scan = (from, to) => { for (let j = from; j <= to; j++) { const c = K.centre[wrap(j)], d = (c[0] - x) ** 2 + (c[2] - z) ** 2; if (d < d0) { d0 = d; best = wrap(j); } } };
  if (hint != null) scan(hint - 40, hint + 40);
  if (hint == null || d0 > 3600) { d0 = 1e18; scan(0, n - 1); }
  return best;
}
function stationFor(k) {                    // the camera the car is coming up to; it keeps the car until 40 m after it has gone by
  let best = 0, d0 = 1e9;
  STATIONS.forEach((st, i) => { const d = wrap(st.k + 10 - k); if (d < d0) { d0 = d; best = i; } });
  return best;
}
// What is in a television camera's way. Each camera films the stretch of road up to it; a place is in its picture,
// in front of the cars, if it lies between the camera and some part of that stretch, inside what the lens takes in
// (about 52 m across where the car is, and narrowing towards the camera). The masts that are, are not drawn while
// that camera films (mastsOutOf()).
const SIGHTS = STATIONS.map((st, i) => { const ks = []; for (let k = 0; k < n; k += 2) if (stationFor(k) === i) ks.push(k); return ks; });
function inShotOf(i, x, z) {
  const p = STATIONS[i].pos, ax = x - p.x, az = z - p.z;
  for (const k of SIGHTS[i]) {
    const c = K.centre[k], bx = c[0] - p.x, bz = c[2] - p.z, len2 = bx * bx + bz * bz, t = (ax * bx + az * bz) / len2;
    if (t > 0.02 && t < 0.97 && Math.abs(ax * bz - az * bx) / Math.sqrt(len2) < 26 * t + 1.5) return true;
  }
  return false;
}
// The director: a new shot every nine seconds, counted from the start of the highlight being shown so each one
// opens on a trackside camera. While the hosts talk over a held picture, a slow circle overhead.
const SHOTS = ["tv", "chase", "tv", "pod", "tv", "heli", "tv", "tv", "chase"];
function directed(t) {
  const seg = S.seg;
  if (seg && seg.hold) return "heli";
  return SHOTS[((Math.floor((t - (seg ? seg.from : 0)) / 9) % SHOTS.length) + SHOTS.length) % SHOTS.length];
}
function aim(car, p, dt, t) {
  const told = mode === "story" ? S.story : null, other = told && told.shot === "duo" ? cars.find(c => c.visible && c.userData.i === told.partner) : null;
  let shot = told ? (told.shot === "duo" && !other ? "chase" : told.shot) : mode === "auto" || mode === "story" ? directed(t) : mode;
  const py = car.position.y;
  if (told && shot === "tv") {          // the commentary's camera wants the car seen: a trackside camera over 150 m from it looks across walls and boards
    if (!follow.asked) follow.poor = STATIONS[stationFor(sectionOf(p.x, p.z, null))].pos.distanceTo(v1.set(p.x, py + 0.55, p.z)) > 150;
    if (follow.poor) shot = "chase";
  }
  follow.asked = !!told && told.shot === "tv";      // (decided when the shot is cut to, and kept while it lasts)
  follow.clock = (follow.clock || 0) + dt;
  if ((told ? told.key : null) !== (follow.told ?? null)) { follow.told = told ? told.key : null; follow.cut = true; }      // the hosts have moved on: a cut, whatever the shot
  if (shot !== follow.shot) { follow.shot = shot; follow.cut = follow.fresh = true; }
  let fov = 55;
  if (follow.yaw === null || follow.cut) follow.yaw = p.yaw;
  follow.yaw = lerpAngle(follow.yaw, p.yaw, 1 - Math.exp(-dt / (shot === "orbit" ? 0.45 : 0.16)));
  if (shot !== "tv") mastsOutOf(-1);
  if (shot === "pod") {
    const body = car.userData.body;
    car.updateMatrixWorld(true);
    camera.position.copy(POD.at).applyMatrix4(body.matrixWorld);
    camera.quaternion.copy(body.getWorldQuaternion(q1)).multiply(q2.setFromEuler(e1.set(-POD.down, Math.PI - Math.atan2(POD.at.x, POD.ahead), 0, "YXZ")));
    fov = POD.fov;
  } else if (shot === "iso") {
    fov = toyAim(car, p, dt);             // the model on a table (replay3d_toy.js)
  } else if (shot === "drone") {
    fov = droneAim(car, p, t);            // (replay3d_lens.js)
  } else if (shot === "tv") {
    follow.k = sectionOf(p.x, p.z, follow.cut ? null : follow.k);
    const i = stationFor(follow.k), st = STATIONS[i], cut = follow.cut || follow.station !== i || !follow.look;
    follow.station = i;
    mastsOutOf(i);
    v1.set(p.x, py + 0.55, p.z);
    const want = clamp(2 * Math.atan((told && told.tight ? 7 : 12) / st.pos.distanceTo(v1)) * 180 / Math.PI, told && told.tight ? 2.8 : 4.5, 46);      // (closer in on a moment the hosts are calling)
    if (cut) { follow.look = (follow.look || new THREE.Vector3()).copy(v1); follow.zoom = want; follow.fresh = true; }
    else { follow.look.lerp(v1, 1 - Math.exp(-dt / 0.06)); follow.zoom = lerp(follow.zoom, want, 1 - Math.exp(-dt / 0.35)); }   // an operator, a touch behind the car
    camera.position.copy(st.pos); camera.up.set(0, 1, 0); camera.lookAt(follow.look);
    fov = follow.zoom;
  } else if (shot === "duo") {
    // Two cars in one picture. The camera rides behind and above the point half way between them, back along the
    // road (the road's own line there, not the cars' noses: a car that is spinning does not swing the camera), and
    // further back and higher the further apart they are. How far back, how high and which way are eased; the
    // middle of the pair is not, so the camera keeps up at any speed and nothing jumps when the two change places.
    follow.k = sectionOf(p.x, p.z, follow.cut ? null : follow.k);
    const a = K.centre[follow.k], b = K.centre[wrap(follow.k + 3)], q = other.position;
    const d = Math.hypot(p.x - q.x, p.z - q.z), back = 10 + d * 0.75, high = 3.4 + d * 0.2;
    let tx = b[0] - a[0], tz = b[2] - a[2];
    const tl = Math.hypot(tx, tz) || 1, F = follow.duo || (follow.duo = { tx: 0, tz: 0, back: 0, high: 0 });
    tx /= tl; tz /= tl;
    // (cars far apart: the line from one to the other, not the road's line at one of them, or round a bend the
    // other is out of the side of the picture; cars side by side have no such line worth the name)
    let cx = (q.x - p.x) / (d || 1), cz = (q.z - p.z) / (d || 1);
    if (cx * tx + cz * tz < 0) { cx = -cx; cz = -cz; }
    const far = clamp((d - 12) / 28, 0, 1), mix = far * far * (3 - 2 * far);
    tx += (cx - tx) * mix; tz += (cz - tz) * mix;
    if (follow.cut || !F.back) { F.tx = tx; F.tz = tz; F.back = back; F.high = high; follow.fresh = true; }
    else { const e = 1 - Math.exp(-dt / 0.35); F.tx += (tx - F.tx) * e; F.tz += (tz - F.tz) * e; F.back += (back - F.back) * e; F.high += (high - F.high) * e; }
    const fl = Math.hypot(F.tx, F.tz) || 1, ux = F.tx / fl, uz = F.tz / fl, mx = (p.x + q.x) / 2, my = (py + q.y) / 2, mz = (p.z + q.z) / 2;
    camera.position.set(mx - ux * F.back, my + F.high, mz - uz * F.back);
    // It looks down the road at the point that puts the nearer car as far below the middle of the picture as the
    // farther is above it (seen from behind, one is under the other), and its lens takes in both with room round them.
    const along = ((p.x - q.x) * ux + (p.z - q.z) * uz) / 2, lowest = Math.atan(F.high / Math.max(5, F.back - Math.abs(along))), highest = Math.atan(F.high / (F.back + Math.abs(along)));
    const reach = F.high / Math.tan((lowest + highest) / 2) - F.back;
    v1.set(mx + ux * reach, my + 0.6, mz + uz * reach);
    camera.up.set(0, 1, 0); camera.lookAt(v1);
    fov = clamp((lowest - highest) * 180 / Math.PI + 20 + 60 / Math.max(10, F.back), 30, 60);
  } else {
    const y = follow.yaw;
    if (shot === "chase") {
      const back = 6.4 + p.speed * 0.004;
      camera.position.set(p.x - Math.sin(y) * back, py + 1.85, p.z - Math.cos(y) * back);
      v1.set(p.x + Math.sin(p.yaw) * 5, py + 0.75, p.z + Math.cos(p.yaw) * 5);
      fov = 56 + 12 * Math.min(1, p.speed / 330) ** 2;
    } else if (shot === "heli") {
      const az = follow.clock * 0.05, r = 62, pol = 0.74;
      camera.position.set(p.x + r * Math.sin(pol) * Math.sin(az), py + r * Math.cos(pol), p.z + r * Math.sin(pol) * Math.cos(az));
      v1.set(p.x, py, p.z);
      fov = 34;
    } else {
      const az = y + orbit.az, sn = Math.sin(orbit.pol);
      camera.position.set(p.x + orbit.r * sn * Math.sin(az), py + 0.55 + orbit.r * Math.cos(orbit.pol), p.z + orbit.r * sn * Math.cos(az));
      v1.set(p.x, py + 0.55, p.z);
      if (orbit.up) {                     // down at the road and pulled down still: it stays there and looks up, past the car to the sky
        v2.copy(v1).sub(camera.position).normalize(); v3.set(v2.z, 0, -v2.x).normalize();      // (the way it was looking, and the level line across that)
        v1.copy(camera.position).addScaledVector(v2.applyAxisAngle(v3, -orbit.up), orbit.r);
      }
      fov = 46;
    }
    camera.up.set(0, 1, 0); camera.lookAt(v1);
  }
  const near = shot === "pod" ? 0.08 : shot === "drone" ? 0.2 : shot === "iso" ? TOY.near : 0.4, far = shot === "iso" ? TOY.far : 9000;
  if (Math.abs(camera.fov - fov) > 0.01 || camera.near !== near || camera.far !== far) {
    camera.fov = follow.fresh || shot === "tv" || shot === "drone" || shot === "iso" ? fov : lerp(camera.fov, fov, 0.15); camera.near = near; camera.far = far; camera.updateProjectionMatrix();
  }
  follow.cut = follow.fresh = false;
}
function controls() {
  const down = new Map();
  let moved = 0, pinch = 0;
  canvas.addEventListener("pointerdown", e => { down.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0; canvas.setPointerCapture(e.pointerId); pinch = 0; });
  canvas.addEventListener("pointermove", e => {
    const p = down.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
    if (mode === "iso") {               // the model on a table: turned, tipped, brought nearer
      if (down.size === 2) { const [a, b] = [...down.values()], d = Math.hypot(a.x - b.x, a.y - b.y); if (pinch) TOY.tall = clamp(TOY.tall * pinch / d, 90, 2600); pinch = d; }
      else { TOY.az -= dx * 0.006; TOY.el = clamp(TOY.el + dy * 0.004, 0.4, 1.25); }
      return;
    }
    if (mode === "story") return;       // (the Commentary camera is not the viewer's to move)
    if (moved > 6 && mode !== "orbit") api.setCamera("orbit");
    if (down.size === 2) {              // two fingers: pinch to zoom
      const [a, b] = [...down.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) orbit.r = clamp(orbit.r * pinch / d, 3.2, 160);
      pinch = d;
    } else if (mode === "orbit") {
      orbit.az -= dx * 0.006;
      // Never under the road. Dragged on once it is down there, the camera stays at the road and looks up instead, most
      // of the way to straight up (Eric: "i want to be able to look up at the sky box"); pulled back, it looks down again first.
      const LOW = Math.PI / 2 - 0.02, pull = clamp(orbit.pol + (orbit.up || 0) - dy * 0.005, 0.1, LOW + 1.4);
      orbit.pol = Math.min(pull, LOW); orbit.up = Math.max(0, pull - LOW);
    }
  });
  const up = e => { if (down.has(e.pointerId) && down.size === 1 && moved < 6) pick(e); down.delete(e.pointerId); pinch = 0; };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", e => { down.delete(e.pointerId); pinch = 0; });
  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    if (mode === "iso") { TOY.tall = clamp(TOY.tall * (e.deltaY > 0 ? 1.12 : 0.89), 90, 2600); return; }
    if (mode === "story") return;
    if (mode !== "orbit") api.setCamera("orbit");
    orbit.r = clamp(orbit.r * (e.deltaY > 0 ? 1.12 : 0.89), 3.2, 160);
  }, { passive: false });
}
const ray = new THREE.Raycaster();
function pick(e) {
  const r = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
  let best = null;
  for (const car of cars) {
    if (!car.visible) continue;
    const d = ray.ray.distanceToPoint(v2.copy(car.position).setY(car.position.y + 0.5));
    if (d < 2.4 && (!best || d < best.d)) best = { d, i: car.userData.i };
  }
  if (best && best.i !== S.focus && S.setFocus(best.i) !== false) follow.cut = true;      // (the page may say no: the Commentary camera chooses for itself)
}

// ------------------------------------------------------------------ the frame
const Finish = {        // what a camera adds: a darker edge to the picture, and a little grain (which also hides banding in the night sky)
  uniforms: { tDiffuse: { value: null }, amount: { value: 0.3 }, grain: { value: 0.022 }, time: { value: 0 }, rich: { value: 1 } },      // rich: how strong the colours are (1 as they come)
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: "uniform sampler2D tDiffuse; uniform float amount; uniform float grain; uniform float time; uniform float rich; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); c.rgb = mix(vec3(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722))), c.rgb, rich); float d = length(vUv - 0.5); float n = fract(sin(dot(gl_FragCoord.xy + time * 61.7, vec2(12.9898, 78.233))) * 43758.5453); gl_FragColor = vec4(c.rgb * (1.0 - amount * smoothstep(0.3, 0.8, d)) + (n - 0.5) * grain, c.a); }",
};
// The light. A floodlit circuit is lit evenly from end to end, so nearly all of it is light that is the same
// everywhere: the masts down both sides taken together (two lights from opposite sides, one casting the shadows)
// and what comes back off the ground and the sky. On top of that the few masts nearest the car being followed
// shine for real, weakly, for the highlights that slide over the paint as it passes each one.
// (They used to be most of the light there was. Six lamps reach about 60 m, and a looked-up circuit has a mast
// every 46 m on both sides: so the road was 1.8 times brighter round the followed car than anywhere else, and each
// time the car passed a pair of masts a lamp behind it went out at full strength and one ahead came on. Eric,
// 11 Oct 2026: "the lights brighten where the car youre watching is and then a few car lengths back they dim".)
const LAMPS = 6, LAMP = 600;          // how many masts shine at once, and how brightly (candela)
let lamps = [], order = null, reach = null, finish = null;
function relight(x, z) {
  for (let i = 0; i < MASTS.length; i++) { order[i] = i; reach[i] = Math.hypot(MASTS[i].x - x, MASTS[i].z - z); }
  order.sort((a, b) => reach[a] - reach[b]);
  const edge = MASTS.length > LAMPS ? reach[order[LAMPS]] : 1e9;       // the nearest mast that is not lit
  lamps.forEach((lamp, i) => {
    const m = MASTS[order[i]], d = i < MASTS.length ? reach[order[i]] : 1e9;
    if (!m || d > 175) { lamp.intensity = 0; return; }
    lamp.position.set(m.x, m.y, m.z); lamp.target.position.set(m.tx, m.ty, m.tz);
    // Each is out by the time it is as far off as the nearest unlit mast (which is when it would be swapped for
    // that one), and by 175 m whatever: none is ever switched on or off while it is shining.
    const far = clamp((d - 115) / 60, 0, 1), near = clamp((edge - d) / (0.45 * edge), 0, 1);
    lamp.intensity = LAMP * (1 - far * far) * near * near * (3 - 2 * near);
  });
}
function init() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: true });
  canvas.addEventListener("webglcontextlost", e => {      // the browser took the graphics away: nothing here survives that (the page starts again: see the template)
    e.preventDefault();
    document.dispatchEvent(new CustomEvent("stage3d-lost"));
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05060a, 0.00042);
  camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.08, 9000);
  skyRoot = sky(); scene.add(skyRoot);
  scene.environment = surroundings(night.cube.texture); scene.environmentIntensity = 0.9;
  hemi = new THREE.HemisphereLight(0x9fb0d0, 0x3a332a, 0.8); scene.add(hemi);
  sun = new THREE.DirectionalLight(0xfff2dd, 2.7);        // the floodlights down one side, taken together
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.04;
  Object.assign(sun.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55, near: 10, far: 420 });
  scene.add(sun, sun.target);
  fillLight = new THREE.DirectionalLight(0xdfe8ff, 2.3);   // and those down the other
  fillLight.position.set(-70, 110, -50); scene.add(fillLight);
  scene.add(buildCircuit());
  // The masts nearest the car being followed also shine for real (relight()): the rest are only bright to look at.
  for (let i = 0; i < LAMPS; i++) { const lamp = new THREE.SpotLight(0xfff0d6, 0, 0, 1.08, 0.8, 2); scene.add(lamp, lamp.target); lamps.push(lamp); }
  order = new Uint16Array(MASTS.length); reach = new Float32Array(MASTS.length);
  for (const c of S.CARS) { const car = makeCar(c); scene.add(car); cars.push(car); }
  calibrate();
  effects();
  // (the picture is kept with how far away each thing in it is, for the lens: replay3d_lens.js)
  const target = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4, depthTexture: new THREE.DepthTexture(2, 2) });
  composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(lensInit());
  bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.42, 0.55, 1.5);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  finish = new ShaderPass(Finish);
  composer.addPass(finish);
  controls();
  const look = new URLSearchParams(location.search).get("look");      // ?look=az,alt,fov in the page's address does the same
  if (look) api.debug.look = look.split(",").map(Number);
  ready = true;
}
// f1.cetla.dev: how many device pixels each CSS pixel of the picture gets (put here by tools/add-mobile-player.mjs).
// A desktop as the player has it. A phone draws at its screen's own sharpness (up to 3; 2 once it is struggling and
// its effects are down), whatever effects are off, and never past about 2.6 million pixels for the whole picture.
const PHONE_SCREEN = matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 600;
function sharpness(w, h) {
  const dpr = window.devicePixelRatio || 1;
  if (!PHONE_SCREEN) return quality > 1 ? Math.min(dpr, 2) : 1;
  return Math.max(1, Math.min(dpr, quality > 0 ? 3 : 2, Math.sqrt(2.6e6 / Math.max(1, w * h))));
}
function resize() {                   // the size of its place on the page, or the size it has been told to film at
  const set = api.fixed, r = canvas.getBoundingClientRect();
  const w = set ? set[0] : Math.max(2, Math.floor(r.width)), h = set ? set[1] : Math.max(2, Math.floor(r.height));
  const pr = set ? 1 : sharpness(w, h);
  if (renderer.getPixelRatio() !== pr || canvas.width !== Math.floor(w * pr) || canvas.height !== Math.floor(h * pr)) {
    renderer.setPixelRatio(pr); renderer.setSize(w, h, false); composer.setPixelRatio(pr); composer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
}
function lightsShowing(t) {             // how many of the five red lights are on at replay time t
  let on = 0;
  for (const e of S.D.events || []) {
    if (e.t > t) break;
    if (e.code === "STLG") on = e.numLights; else if (e.code === "LGOT") on = 0;
  }
  return on;
}
function render(t, dt) {
  if (!ready) init();
  resize();
  toySet(mode === "iso");               // the model on a table has its own daylight (replay3d_toy.js)
  if (!TOY.on) skyStep(t);
  let focusCar = null, focusPose = null;
  for (const car of cars) {
    const u = car.userData, i = u.i, p = S.active(i, t) ? pose(i, t) : null;
    car.visible = !!p;
    if (!p) continue;
    const moved = u.t === null ? 0 : t - u.t;       // replay time since this car was last drawn
    place(car, p, t);
    if (moved > 0 && moved < 0.5) u.spin = (u.spin + p.speed / 3.6 * moved / TYRE_R) % TAU;
    const cover = p.speed > 60 ? shared.blur : shared.cover, tyre = S.tyreColor ? S.tyreColor(i, t) : null;
    for (const w of u.wheels) {
      w.spin.rotation.x = u.spin;
      if (w.front) w.hub.rotation.y = -p.steer * 0.32;
      if (w.cover.material !== cover) w.cover.material = cover;
      if (tyre !== u.tyre) for (const band of w.bands) band.material = shared.stripe(tyre);
    }
    u.tyre = tyre;
    u.light.color.setRGB(0.22 + p.brake * 7, 0.015, 0.015);
    const hurt = damageAt(i, t);
    if (hurt !== u.hurt) {              // something has just broken (or been mended): bits fly if we watched it happen
      const was = u.hurt || [0, 0, 0, 0];
      if (hurt && fx && moved > 0 && moved < 0.5) {
        if (hurt[1] > was[1]) shatter(p, car.position.y, 0.8, 2.5, u.shards);
        if (hurt[2] > was[2]) shatter(p, car.position.y, -0.8, 2.5, u.shards);
        if (hurt[3] > was[3]) shatter(p, car.position.y + 0.7, 0, -2.5, u.shards);
      }
      u.hurt = hurt; wreck(u, hurt);
    }
    if (i === S.focus) { focusCar = car; focusPose = p; }
  }
  if (!focusPose) { focusCar = cars.find(c => c.visible); if (focusCar) focusPose = pose(focusCar.userData.i, t); }
  if (focusPose) {
    if (follow.car !== focusCar) { follow.car = focusCar; follow.cut = true; }
    aim(focusCar, focusPose, Math.max(0.001, dt), t);
    if (api.debug.look) {               // for looking the sky over: [degrees right of the start straight, degrees up, field of view]
      const [az, alt, fov] = api.debug.look;
      camera.up.set(0, 1, 0); camera.lookAt(v1.copy(camera.position).add(night.at(az, alt)));
      if (fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
    }
    if (TOY.on) toyLight();
    else {
      relight(focusPose.x, focusPose.z);
      sun.target.position.copy(focusCar.position);
      sun.position.set(focusPose.x + 75, focusCar.position.y + 150, focusPose.z + 55);
    }
  }
  toyStep();
  stepEffects(t);
  const lens = Math.tan(camera.fov * Math.PI / 360);
  for (const car of cars) {             // name tags: readable from far off, small up close, gone from the car you sit on
    if (!car.visible) continue;
    const tag = car.userData.tag, d = camera.position.distanceTo(car.position);
    tag.visible = api.labels && !((follow.shot === "pod" || follow.shot === "chase") && car === focusCar) && (TOY.on || d * lens < 235);
    const s = TOY.on ? TOY.tall * 0.02 : Math.max(0.42, Math.min(d * lens, 75) * 0.056), big = car.scale.x;      // (a model's cars are bigger than life: their tags are not)
    tag.scale.set(2.86 * s / big, s / big, 1); tag.position.y = 1.35 + s * 0.75 / big;
  }
  const on = lightsShowing(t);
  startLights.forEach((m, i) => m.color.setRGB(i < on ? 9 : 0.1, i < on ? 0.25 : 0.02, i < on ? 0.15 : 0.02));
  carsStep(t);                          // whatever the field is driving today (replay3d_cars.js)
  lensStep(t, Math.max(0.001, dt), focusCar);      // the heat over the exhausts, what a long lens leaves soft (replay3d_lens.js)
  mirrorsStep(focusCar);                // what is behind the car being followed, in its mirrors (replay3d_mirrors.js)
  // The grain is new in every frame, which is nothing to an eye and the dearest thing there is to a video encoder: it
  // cannot be predicted from the frame before, so the encoder spends most of what it has on it and smears the cars
  // and the track to pay for it. A film is made with as much of it as filmGrain says (none), and what there is of it
  // goes by the film's own clock, so the same film made twice is the same film.
  const grain = finish.uniforms.grain.value;
  if (api.fixed) finish.uniforms.grain.value = grain * api.filmGrain;
  finish.uniforms.time.value = api.fixed ? (t * 60) % 97 : (performance.now() / 1000) % 97;
  if (quality > 0) composer.render(); else renderer.render(scene, camera);
  finish.uniforms.grain.value = grain;
}
const api = window.Stage3D = {
  labels: true,
  mirrors: true,                      // the followed car's mirrors show what is behind it (replay3d_mirrors.js); false: they are left dark
  fixed: null,                        // [width, height] to draw at exactly that size (the video export), null to fit the page
  filmGrain: 0,                       // how much of the picture's grain a film keeps (see render)
  render,
  setCamera(m) { mode = m; follow.cut = follow.fresh = true; document.dispatchEvent(new CustomEvent("stage3d-camera", { detail: m })); },
  get camera() { return mode; },
  get shot() { return follow.shot; },
  ear() {                             // where the camera is and which way is its right: what the engines are heard from (the page's engineStep)
    if (!ready) return null;
    const e = camera.matrixWorld.elements;
    return { x: camera.position.x, y: camera.position.y, z: camera.position.z, rx: e[0], rz: e[2] };
  },
  get orbit() { return orbit; },
  suspension: SPRING,
  effects: FX,
  get quality() { return quality; },
  set quality(q) {
    quality = clamp(q | 0, 0, 2);
    if (ready) { bloom.enabled = quality > 1 && !TOY.on; renderer.shadowMap.enabled = quality > 0; sun.castShadow = quality > 0; resize(); }
  },
  debug: { look: null, K, WALL, bend, lane, STATIONS, MASTS, groundAt, ground, verge, stand, pose, damageAt, wreck, LOOKS, TEAM_OF, get scene() { return scene; }, get renderer() { return renderer; }, get masts() { return mastSet; }, get cars() { return cars; }, get view() { return camera; } },
};

/* THE VENUE. track3d.py rebuilds the road from where the cars went, and replay3d.js dresses any circuit the same way:
   a wall, a fence, run-off, a pit building, a grandstand. A circuit that has been looked up (venue.py, from a map
   and from pictures: venues\<name>.py) brings its own: what is painted beside its road and where, its buildings and
   stands where they really are, its lights, what stands on its skyline. K.venue is that, in the game's own
   measures; this file draws it, and replay3d.js asks it first wherever a circuit may have something of its own.

   Places are [x, z] in the game's world. Things beside the track are in metres round the lap from the finish line
   ("from", "to", "at") and metres to the driver's right of the middle of the road ("near", "far"). */
const V = K.venue || null;
const vHex = key => (V && V.palette[key]) || key;                       // a colour of the venue's palette by name, or any colour as it is
const vSec = metres => Math.round(metres / BIN);                         // metres round the lap -> which section
const vSpan = (from, to) => { const a = vSec(from); return [a, ((vSec(to) - a) % n + n) % n + 1]; };      // first section, how many (a span may run through the finish line)

/* PAINT. A painted run-off is bands of colour lying beside the road, each so many metres wide, the last of them
   running on to the wall. A band is one plain colour or a pattern; a pattern is a picture that repeats along the
   track. A band's name says which: "navy" is a colour of the palette; "diamonds sky on navy" is a row of diamonds
   in those colours on that ground; the rest are in PATTERNS. */
const PATTERNS = {
  // name -> [metres of track one picture covers (times the band's width when it says "x"), does it stretch across the band (true) or repeat in metres (a number: metres across), how to draw it]
  "sadu rectangles": [44, true, (c, w, h) => {
    c.fillStyle = vHex("cream"); c.fillRect(0, 0, w, h);
    const tones = ["maroon", "royal", "cyan", "green", "purple", "maroon", "orange", "royal"];
    for (let row = 0; row < 2; row++) for (let i = 0; i < 8; i++) {
      c.fillStyle = vHex(tones[(i + row * 3) % tones.length]);
      c.fillRect(i * w / 8 + w * 0.012, row * h / 2 + h * 0.07, w / 8 - w * 0.024, h / 2 - h * 0.14);
      c.fillStyle = vHex("cream"); c.fillRect(i * w / 8 + w * 0.045, row * h / 2 + h * 0.2, w / 8 - w * 0.09, h * 0.035);      // a pale line woven through each
    }
  }],
  "mosaic": [28, 14, (c, w, h) => {
    const tones = ["orange", "pink", "royal", "white", "coral", "sky"], m = 8, s = w / m;
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) for (let half = 0; half < 2; half++) {
      c.fillStyle = vHex(tones[Math.floor(rnd() * tones.length)]);
      c.beginPath();
      if (half) { c.moveTo(i * s, j * s); c.lineTo(i * s + s, j * s); c.lineTo(i * s, j * s + s); } else { c.moveTo(i * s + s, j * s); c.lineTo(i * s + s, j * s + s); c.lineTo(i * s, j * s + s); }
      c.fill();
    }
  }],
  "turf": [24, 12, (c, w, h) => {              // artificial turf, in stripes of two greens across the way the cars go
    for (let i = 0; i < 4; i++) { c.fillStyle = i % 2 ? "#2c8f46" : "#1d6b33"; c.fillRect(i * w / 4, 0, w / 4 + 1, h); }
    speckleOver(c, w, h, 9000, 0.12, 1.4);
  }],
  "turf dark": [12, 12, (c, w, h) => { c.fillStyle = "#184d2a"; c.fillRect(0, 0, w, h); speckleOver(c, w, h, 9000, 0.14, 1.4); }],
  "coral stripes": [12, true, (c, w, h) => {
    c.fillStyle = vHex("coral"); c.fillRect(0, 0, w, h);
    c.fillStyle = vHex("green"); c.fillRect(0, h * 0.22, w, h * 0.09); c.fillStyle = vHex("yellow"); c.fillRect(0, h * 0.62, w, h * 0.09);
  }],
};
function speckleOver(c, w, h, count, strength, size) {      // light and dark flecks over whatever is there
  for (let i = 0; i < count; i++) { c.fillStyle = `rgba(${rnd() < 0.5 ? "0,0,0" : "255,255,255"},${rnd() * strength})`; c.fillRect(rnd() * w, rnd() * h, size, size); }
}
function diamondRow(names, back) {      // a row of diamonds, one of each colour in turn, edged white, on a ground
  return (c, w, h) => {
    c.fillStyle = vHex(back); c.fillRect(0, 0, w, h);
    const count = 4, s = w / count;
    for (let i = 0; i < count; i++) {
      c.beginPath(); c.moveTo(i * s + s / 2, h * 0.06); c.lineTo(i * s + s * 0.96, h / 2); c.lineTo(i * s + s / 2, h * 0.94); c.lineTo(i * s + s * 0.04, h / 2); c.closePath();
      c.fillStyle = vHex(names[i % names.length]); c.fill();
      c.lineWidth = Math.max(2, h * 0.035); c.strokeStyle = vHex("white"); c.stroke();
      c.beginPath(); c.moveTo(i * s + s / 2, h * 0.3); c.lineTo(i * s + s * 0.72, h / 2); c.lineTo(i * s + s / 2, h * 0.7); c.lineTo(i * s + s * 0.28, h / 2); c.closePath();
      c.fillStyle = vHex(back); c.fill();
    }
  };
}
const vPaints = {};
function vPaint(name) {                 // the material for a band, and how its picture is laid: { mat, along (metres a picture covers), across (true: stretched over the band; a number: metres) }
  if (vPaints[name]) return vPaints[name];
  const lying = { roughness: 0.82, metalness: 0, side: both, polygonOffset: true, polygonOffsetFactor: -1.5, polygonOffsetUnits: -1.5 };
  let made;
  const diamonds = /^diamonds (.+) on (\w+)$/.exec(name);
  if (diamonds) made = { mat: new THREE.MeshStandardMaterial({ ...lying, map: tex(512, 128, diamondRow(diamonds[1].split(" "), diamonds[2]), { aniso: 16 }) }), along: "x4.4", across: true };
  else if (PATTERNS[name]) { const [along, across, draw] = PATTERNS[name]; made = { mat: new THREE.MeshStandardMaterial({ ...lying, map: tex(512, across === true ? 256 : 512, draw, { aniso: 16 }) }), along, across }; }
  else {                                 // one colour: painted concrete, a little uneven, with the grain of its anti-slip coat
    const colour = vHex(name);
    made = { mat: new THREE.MeshStandardMaterial({ ...lying, map: tex(256, 256, (c, w, h) => {
      c.fillStyle = colour; c.fillRect(0, 0, w, h); speckleOver(c, w, h, 9000, 0.045, 1.3);
      for (let i = 0; i < 5; i++) { const g = c.createRadialGradient(0, 0, 0, 0, 0, 50 + rnd() * 60); g.addColorStop(0, `rgba(${rnd() < 0.5 ? "0,0,0" : "255,255,255"},0.035)`); g.addColorStop(1, "rgba(0,0,0,0)"); c.save(); c.translate(rnd() * w, rnd() * h); c.fillStyle = g; c.fillRect(-120, -120, 240, 240); c.restore(); }
    }, { aniso: 8 }) }), along: 9, across: 9 };
  }
  return vPaints[name] = made;
}
/* One side of the road painted as the venue has it. E(k): the road's edge, W(k): the wall, both metres to the right
   of the line. Gives back what it painted, by section: how far out from the edge the paint goes (the wall), so the
   caller knows where it need not lay its own. */
function venuePaint(sign, E, W, lay) {
  if (!V || !V.paint) return null;
  const done = new Uint8Array(n), depth = k => Math.abs(W(k) - E(k));
  const breaks = [RAMP[0], SLOPE_OUT, RAMP[1]];         // where the ground changes its slope: a band has a line of points there, to lie on it
  for (const zone of V.paint) {
    if (zone.side !== sign) continue;
    const [from, count] = vSpan(zone.from, zone.to);
    for (let j = 0; j < count; j++) done[wrap(from + j)] = 1;
    let a = 0;
    for (const [wide, name] of zone.bands) {
      const b = wide == null ? 1e9 : a + wide, p = vPaint(name), a0 = a;
      const at0 = k => Math.min(a0, depth(k)), at1 = k => Math.min(b, depth(k));
      const cols = [k => [E(k) + sign * at0(k), 0]];
      for (const s of breaks) if (s > a0 + 0.2 && s < b - 0.2) cols.push(k => [E(k) + sign * Math.min(s, depth(k)), 0]);
      if (wide == null) cols.push(k => [E(k) + sign * Math.max(Math.min(a0 + 6, depth(k)), (at0(k) + depth(k)) / 2), 0]);      // (and one more across a wide field, which may be laid over a rise)
      cols.push(k => [E(k) + sign * at1(k), 0]);
      const along = typeof p.along === "string" ? (wide || 3) * +p.along.slice(1) : p.along;
      lay(strip(cols, { from, count, uv: (k, c, off, dist) => {
        const out = Math.abs(off - E(k));
        return [dist / along, p.across === true ? (out - at0(k)) / Math.max(0.01, at1(k) - at0(k)) : out / p.across];
      } }), p.mat);
      a = b;
    }
  }
  // words painted on a field, in giant letters: a strip of the field's own shape with the letters on it
  for (const word of V.words || []) {
    if (word.side !== sign) continue;
    const from = vSec(word.at - word.long / 2), count = Math.max(2, vSec(word.long)), near = word.out - word.tall / 2, far = word.out + word.tall / 2;
    const letters = tex(2048, 256, (c, w, h) => {
      c.clearRect(0, 0, w, h); c.fillStyle = vHex(word.colour); c.textAlign = "center"; c.textBaseline = "middle";
      c.font = "900 215px system-ui, Segoe UI, Arial, sans-serif"; c.fillText(word.text, w / 2, h / 2 + 8, w - 40);
    }, { repeat: false, aniso: 16 });
    const start = from * BIN;
    lay(strip([k => [E(k) + sign * near, 0], k => [E(k) + sign * (near + far) / 2, 0], k => [E(k) + sign * far, 0]],
              { from, count, uv: (k, c, off, dist) => { const u = (dist - start) / (count * BIN - BIN); return [sign < 0 ? u : 1 - u, c / 2]; } }),      // (to be read from the road: its foot nearest the road, and running the way a head turned that way reads)
        new THREE.MeshStandardMaterial({ map: letters, transparent: true, alphaTest: 0.35, roughness: 0.7, side: both, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  }
  return done;
}

/* STRUCTURES. What stands beside the track is drawn as the road is: in strips that follow it, section by section,
   so a building 400 m long bends with the straight it stands on. An upright face is a strip of two lines one above
   the other; a slab is its underside, its edge and its top. Heights are above the ground at the place (or, for
   the pits, above the pit lane). What is lit from inside (windows, a screen, a crowd under lamps) wears its own
   picture as its light as well. */
const vFn = v => (typeof v === "function" ? v : () => v);
function vFace(lay, a, count, off, y0, y1, mat, per = 8, o = {}) {
  off = vFn(off); y0 = vFn(y0); y1 = vFn(y1);
  return lay(strip([k => [off(k), 0, y0(k)], k => [off(k), 0, y1(k)]],
                   { from: a, count, uv: (k, c, f, dist) => [(o.flip ? -1 : 1) * (dist - (o.u0 || 0)) / per, c * (o.v || 1)] }), mat, { cast: o.cast !== false });
}
function vSlab(lay, a, count, off0, off1, y0, y1, mat, o = {}) {      // off0 is the edge that shows; its top runs back to off1
  off0 = vFn(off0); off1 = vFn(off1); y0 = vFn(y0); y1 = vFn(y1);
  return lay(strip([k => [off1(k), 0, y0(k)], k => [off0(k), 0, y0(k)], k => [off0(k), 0, y0(k)], k => [off0(k), 0, y1(k)], k => [off0(k), 0, y1(k)], k => [off1(k), 0, y1(k)]],
                   { from: a, count, tile: o.tile || 8 }), mat, { cast: o.cast !== false });
}
function vEnds(lay, a, count, off0, off1, y0, y1, mat, y1far) {       // the two ends of something that runs beside the track (y1far: the far side's top, where it is not the near side's)
  off0 = vFn(off0); off1 = vFn(off1); y0 = vFn(y0); y1 = vFn(y1); y1far = y1far ? vFn(y1far) : y1;
  for (const k of [a, a + count - 1]) {
    const p = at(k, off0(k)), q = at(k, off1(k));
    lay(quad([p[0], y0(k), p[2]], [q[0], y0(k), q[2]], [q[0], y1far(k), q[2]], [p[0], y1(k), p[2]]), mat, { cast: true });
  }
}
const vMats = {};
function vMat(name, colour) {           // the venue's own materials, each made the first time it is wanted
  const key = name + (colour || "");
  if (vMats[key]) return vMats[key];
  const lit = (map, glow, o = {}) => new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: new THREE.Color(...glow), roughness: 0.7, side: both, ...o });
  const pictures = {
    white: () => new THREE.MeshStandardMaterial({ color: 0xd9dadc, roughness: 0.6, side: both, emissive: new THREE.Color(0x24262a) }),
    grey: () => new THREE.MeshStandardMaterial({ color: 0x7d8187, roughness: 0.65, side: both }),
    dark: () => new THREE.MeshStandardMaterial({ color: 0x2a2d32, roughness: 0.6, metalness: 0.4, side: both }),
    steel: () => new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.5, metalness: 0.7 }),
    led: () => new THREE.MeshBasicMaterial({ color: new THREE.Color(colour || "#3a7cff").multiplyScalar(2.6), side: both }),
    lamp: () => new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 3.0, 2.6), side: both }),
    garage: () => lit(tex(512, 128, (c, w, h) => {          // one team's garage: two lit doors in a dark wall, the team's board over them
      c.fillStyle = "#1b1d21"; c.fillRect(0, 0, w, h);
      for (const x of [26, 270]) {
        const g = c.createLinearGradient(0, 30, 0, h); g.addColorStop(0, "#e2dccb"); g.addColorStop(0.5, "#9d998d"); g.addColorStop(1, "#5d5c58");
        c.fillStyle = g; c.fillRect(x, 30, 216, h - 30);
        c.fillStyle = "rgba(18,20,24,0.6)"; c.fillRect(x + 14, 64, 44, h - 64); c.fillRect(x + 150, 70, 52, h - 70); c.fillRect(x + 78, 92, 54, h - 92);       // cabinets, a car on its stands
        c.fillStyle = "rgba(255,250,235,0.95)"; c.fillRect(x + 10, 33, 196, 4);                                                                                 // the strip lights
      }
      c.fillStyle = "#101114"; c.fillRect(0, 0, w, 24); c.fillStyle = "#d4d4ce"; c.fillRect(196, 6, 120, 12);
    }, { aniso: 16 }), [0.8, 0.77, 0.7]),
    glass: () => lit(tex(256, 64, (c, w, h) => {            // a glazed floor at night: lit rooms behind dark mullions, people against the light
      c.fillStyle = "#0d141f"; c.fillRect(0, 0, w, h);
      for (let i = 0; i < 16; i++) {
        c.fillStyle = rnd() < 0.82 ? `rgba(${200 + rnd() * 50},${215 + rnd() * 30},255,${0.45 + rnd() * 0.5})` : "rgba(40,60,90,0.5)"; c.fillRect(i * 16 + 1.5, 7, 13, h - 14);
        if (rnd() < 0.55) { c.fillStyle = "rgba(10,14,22,0.75)"; const x = i * 16 + 3 + rnd() * 7; c.fillRect(x, h * 0.42, 3.4, h * 0.5); c.beginPath(); c.arc(x + 1.7, h * 0.38, 2.2, 0, TAU); c.fill(); }
      }
    }, { aniso: 16 }), [0.95, 1.0, 1.15], { roughness: 0.25, metalness: 0.4 }),
    windows: () => lit(tex(256, 128, (c, w, h) => {         // the back of a building: a pale wall, rows of windows, some of them lit
      c.fillStyle = "#8f9094"; c.fillRect(0, 0, w, h);
      for (let row = 0; row < 3; row++) for (let i = 0; i < 12; i++) { c.fillStyle = rnd() < 0.4 ? "rgba(255,228,170,0.95)" : "#20262f"; c.fillRect(i * 21 + 5, 14 + row * 38, 13, 20); }
    }, { aniso: 8 }), [0.5, 0.48, 0.42]),
    office: () => vMat("windows"),
    villa: () => lit(tex(256, 128, (c, w, h) => {           // a paddock villa: beige, with the lit screens the teams hang on its upper floor
      c.fillStyle = "#b9b1a0"; c.fillRect(0, 0, w, h);
      c.fillStyle = "#0e1118"; c.fillRect(8, 12, w - 16, 44);
      for (let i = 0; i < 4; i++) { c.fillStyle = `hsl(${Math.floor(rnd() * 360)},70%,${45 + rnd() * 20}%)`; c.fillRect(12 + i * 60, 16, 54, 36); }
      for (let i = 0; i < 8; i++) { c.fillStyle = rnd() < 0.6 ? "rgba(255,232,180,0.95)" : "#232830"; c.fillRect(10 + i * 31, 76, 20, 40); }
    }, { aniso: 8 }), [0.7, 0.68, 0.64]),
    workshop: () => lit(tex(256, 128, (c, w, h) => {        // a steel shed: ribbed cladding, big doors, a lamp over each
      c.fillStyle = "#70757b"; c.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 6) { c.fillStyle = "rgba(0,0,0,0.12)"; c.fillRect(x, 0, 2, h); }
      for (let i = 0; i < 3; i++) { c.fillStyle = "#3c4046"; c.fillRect(18 + i * 82, 48, 56, h - 48); c.fillStyle = "rgba(255,240,205,0.95)"; c.fillRect(38 + i * 82, 38, 16, 5); }
    }, { aniso: 8 }), [0.4, 0.38, 0.34]),
    crowd: () => lit(tex(512, 256, (c, w, h) => {           // a full stand: rows of people in every colour, the steps between the blocks
      c.fillStyle = "#16181d"; c.fillRect(0, 0, w, h);
      const tones = ["#d8d2c4", "#c8463c", "#3d7bd0", "#e8c24a", "#7fb08a", "#f0f0f0", "#8a5fb0", "#e08a3c", "#7a1a34", "#f2f2f2"];
      for (let row = 0; row < 26; row++) for (let i = 0; i < 150; i++) if (rnd() < 0.86) { c.fillStyle = tones[Math.floor(rnd() * tones.length)]; c.globalAlpha = 0.55 + rnd() * 0.45; c.fillRect(i * 3.42 + rnd(), row * 9.6 + 3 + rnd() * 2, 2.2, 3.6); }
      c.globalAlpha = 1; c.fillStyle = "#3a3d42"; for (let x = 0; x < w; x += 128) c.fillRect(x, 0, 5, h);
    }, { aniso: 16 }), [0.34, 0.34, 0.34], { roughness: 0.9 }),
    grass: () => lit(tex(512, 256, (c, w, h) => {           // a banked lawn with concrete steps across it, and people sat about on it
      c.fillStyle = "#245f33"; c.fillRect(0, 0, w, h); speckleOver(c, w, h, 12000, 0.14, 1.6);
      c.fillStyle = "#8d8f8c"; for (let row = 0; row < 6; row++) c.fillRect(0, row * h / 6, w, 5);
      const tones = ["#d8d2c4", "#c8463c", "#3d7bd0", "#e8c24a", "#f0f0f0", "#7a1a34"];
      for (let i = 0; i < 520; i++) { c.fillStyle = tones[Math.floor(rnd() * tones.length)]; c.fillRect(rnd() * w, rnd() * h, 2.4, 3.6); }
    }, { aniso: 16 }), [0.2, 0.2, 0.2], { roughness: 0.95 }),
    banner: () => lit(tex(1024, 48, (c, w, h) => {          // the strip along the balcony rail
      c.fillStyle = colour || "#e2c21f"; c.fillRect(0, 0, w, h);
      c.fillStyle = "#b0181a"; c.font = "800 30px system-ui, Segoe UI, Arial, sans-serif"; c.textBaseline = "middle"; c.textAlign = "center";
      c.fillText("SLAYTER LEAGUE", w * 0.25, h / 2 + 2); c.fillText("ROUND 1  QATAR", w * 0.75, h / 2 + 2);
    }, { aniso: 16 }), [0.55, 0.55, 0.55]),
    ramp: () => lit(tex(128, 128, (c, w, h) => {            // a spiral ramp, seen from outside: bands of concrete with the dark between them, climbing
      c.fillStyle = "#14161a"; c.fillRect(0, 0, w, h);
      c.fillStyle = "#a9aaa6"; for (let i = -2; i < 6; i++) { c.beginPath(); c.moveTo(0, i * 32 + 30); c.lineTo(w, i * 32 - 2); c.lineTo(w, i * 32 + 12); c.lineTo(0, i * 32 + 44); c.fill(); }
    }), [0.22, 0.22, 0.22]),
    tent: () => lit(tex(64, 64, (c, w, h) => { c.fillStyle = "#2a55b8"; c.fillRect(0, 0, w, h); c.fillStyle = "rgba(255,255,255,0.14)"; for (let x = 0; x < w; x += 16) c.fillRect(x, 0, 2, h); }), [0.3, 0.34, 0.5]),
    lattice: () => new THREE.MeshStandardMaterial({ map: tex(256, 256, (c, w, h) => {      // a web of steel, with the night between its members
      c.clearRect(0, 0, w, h); c.strokeStyle = "#15171b"; c.lineWidth = 7;
      for (let i = -w; i < w * 2; i += 64) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i + w, h); c.moveTo(i + w, 0); c.lineTo(i, h); c.stroke(); }
      c.lineWidth = 5; for (let y = 0; y <= h; y += 64) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    }, { aniso: 8 }), transparent: true, alphaTest: 0.4, roughness: 0.5, metalness: 0.6, side: both }),
    truss: () => new THREE.MeshStandardMaterial({ map: tex(64, 64, (c, w, h) => {          // scaffold or a truss: tubes up, across, and crossed between
      c.clearRect(0, 0, w, h); c.strokeStyle = "#8d949d"; c.lineWidth = 5;
      c.strokeRect(2, 2, w - 4, h - 4); c.beginPath(); c.moveTo(0, 0); c.lineTo(w, h); c.moveTo(w, 0); c.lineTo(0, h); c.stroke();
    }, { aniso: 8 }), transparent: true, alphaTest: 0.4, roughness: 0.45, metalness: 0.7, side: both }),
    screen: () => new THREE.MeshBasicMaterial({ map: tex(512, 288, (c, w, h) => {          // a big screen: the league card, bright enough to light the faces opposite
      const g = c.createLinearGradient(0, 0, w, h); g.addColorStop(0, "#5c0f2e"); g.addColorStop(1, "#16243f"); c.fillStyle = g; c.fillRect(0, 0, w, h);
      c.fillStyle = "#f2f2ee"; c.textAlign = "center"; c.textBaseline = "middle"; c.font = "900 64px system-ui, Segoe UI, Arial, sans-serif"; c.fillText("SLAYTER LEAGUE", w / 2, h * 0.4, w - 40);
      c.font = "700 34px system-ui, Segoe UI, Arial, sans-serif"; c.fillStyle = "#e2c21f"; c.fillText("ROUND 1  ·  QATAR", w / 2, h * 0.68, w - 40);
    }, { repeat: false }), color: new THREE.Color(1.7, 1.7, 1.7), side: both }),
    wallBoards: () => { const m = new THREE.MeshStandardMaterial({ map: wallTexture(), roughness: 0.7, side: both }); m.emissiveMap = m.map; m.emissive = new THREE.Color(0x30302c); return m; },
    apron: () => new THREE.MeshStandardMaterial({ map: tex(256, 256, (c, w, h) => { speckle(c, w, h, "#55575a", 9000, 0.16, 2); c.strokeStyle = "rgba(0,0,0,0.18)"; c.lineWidth = 2; c.strokeRect(0, 0, w, h); }),
                                                  roughness: 0.85, side: both, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    lot: () => new THREE.MeshStandardMaterial({ map: tex(256, 256, (c, w, h) => {          // a car park: dark tarmac, white bays, and cars in most of them
      speckle(c, w, h, "#131416", 6000, 0.1, 2);
      for (let row = 0; row < 4; row++) for (let i = 0; i < 16; i++) {
        c.fillStyle = "rgba(200,200,194,0.16)"; c.fillRect(i * 16, row * 64 + 8, 1, 22); c.fillRect(i * 16, row * 64 + 34, 1, 22);
        for (const y of [10, 36]) if (rnd() < 0.62) { c.fillStyle = `hsl(${Math.floor(rnd() * 360)},${Math.floor(rnd() * 22)}%,${6 + Math.floor(rnd() * 22)}%)`; c.fillRect(i * 16 + 3, row * 64 + y, 10, 18); }
      }
    }, { aniso: 8 }), roughness: 0.9, side: both }),
  };
  return vMats[key] = (pictures[name] || pictures.grey)();
}

/* The pit building, where the game has its garages (P, from pits(): which side, how far out its front is, how far
   apart the boxes are and where the first is, the height of the lane). Three floors, each set back from the one
   below: the garages; a glazed floor behind a balcony, with a banner along the rail; a terrace under a thin roof. */
function venuePits(lay, P) {
  venuePitStands(lay, P);
  const pit = V.pit, s = P.s, [a, count] = vSpan(pit.from, pit.to), F = s * P.front, B = s * (P.front + pit.deep), [h1, h2, h3] = pit.floors;
  vPitBack = P.front + pit.deep;
  const up = h => k => P.y0(k) + h, u0 = P.first * BIN - P.bay / 2;
  const white = vMat("white"), glass = vMat("glass"), led = vMat("led", pit.led);
  lay(strip([k => [s * (P.front - 0.4), 0, P.y0(k) + 0.01], k => [B + s * 96, 0, P.y0(k) + 0.01]], { from: a - 26, count: count + 52, tile: 9 }), vMat("apron"));      // the paddock, paved
  const whole = lay, drawn = [];                              // (the building as it is drawn here is kept track of: it goes when the model of it comes)
  lay = Object.assign((g, m, o) => { const mesh = whole(g, m, o); drawn.push(mesh); return mesh; }, { add: thing => { drawn.push(thing); return whole.add(thing); } });
  venuePitModel(whole, P, drawn);
  vFace(lay, a, count, F, up(0), up(h1 - 0.55), vMat("garage"), P.bay, { u0 });
  vSlab(lay, a, count, F - s * 2.4, F + s * 2.6, up(h1 - 0.55), up(h1), white);
  vFace(lay, a, count, F + s * 2.6, up(h1), up(h2 - 0.5), glass, 6);
  vFace(lay, a, count, F - s * 2.3, up(h1), up(h1 + 1.05), vMat("banner", vHex(pit.strip)), 26, { flip: s > 0 });
  vSlab(lay, a, count, F - s * 1.2, F + s * 7, up(h2 - 0.5), up(h2), white);
  vFace(lay, a, count, F - s * 1.23, up(h2 - 0.64), up(h2 - 0.5), led, 8, { cast: false });
  vFace(lay, a, count, F + s * 7, up(h2), up(h3 - 0.35), glass, 6);
  vSlab(lay, a, count, F + s * 2.0, B, up(h3 - 0.35), up(h3), white);
  vFace(lay, a, count, F + s * 1.97, up(h3 - 0.49), up(h3 - 0.35), led, 8, { cast: false });
  vFace(lay, a, count, B, up(0), up(h3 - 0.35), vMat("windows"), 14);
  vEnds(lay, a, count, F, B, up(0), up(h3 - 0.35), vMat("windows"));
  // the columns that carry the top roof
  const cols = [];
  for (let d = pit.from; d <= pit.to; d += 8) { const k = vSec(d), p = at(k, F + s * 2.3); cols.push([p[0], P.y0(wrap(k)) + (h2 + h3 - 0.35) / 2, p[2], h3 - 0.35 - h2]); }
  vPosts(lay, cols, 0.26, white);
  lay = whole;
  // four screens along its roof, for the grandstand opposite
  for (let i = 0; i < 4; i++) vScreen(lay, pit.from + (pit.to - pit.from) * (i + 0.5) / 4, F + s * 9, P.y0(vSec(pit.from)) + h3 + 0.4, 15, 6.4, -s);
  for (const b of V.paddock || []) venueBlock(lay, b, P.y0(vSec(b.from)));
  for (const t of V.tents || []) venueTent(lay, t, P.y0(vSec(t.from)));
}
/* THE PIT BUILDING AS A MODEL, where this PC has one (venues\local\pit_shell.glb and its kits: venues\from_blend.py
   makes them of a building built in Blender, the first of them the one GPT Astra built for Eric: 402 m, fifty
   numbered garages with their doors, two floors of glazed boxes with terraces and glass rails, V columns, lamps
   along every edge, and in every garage and box what stands in one). It is one straight piece, laid on the line of
   the garages' doors. There is no slow renderer here to bounce lamplight round a room, so what is inside a garage
   or a box glows a little of its own colour instead: a lit room seen from outside at night. */
function venuePitModel(lay, P, drawn) {
  const pit = V.pit, s = P.s, k = vSec((pit.from + pit.to) / 2), p = at(k, s * P.front), y0 = P.y0(vSec(pit.from)), y1 = P.y0(vSec(pit.to));
  venueModel(lay, "pit", [p[0], (y0 + y1) / 2, p[2]], vAlong(k) + (s > 0 ? Math.PI : 0), drawn, Math.atan2(y1 - y0, pit.to - pit.from) * (s > 0 ? -1 : 1));
}
/* ANYTHING BUILT IN BLENDER, STOOD IN ITS PLACE (venues\local\<name>_shell.glb: what there is one of, one mesh a
   material; and inside that file the names of its kits, each a thing built once, with every place it stands).
   venues\make builds them by rule the way Astra built the pits: the grandstands with every seat and everybody in
   them. A model's own x runs along it, its front is where it is put, its back is to the left of its x.
   Each material is drawn as its name says. "Glazing" is a pane. " | lit" is where lamps reach: there is no slow
   renderer here to work out how much light falls where, so such a face gives off a part of its own colour (its own
   colour face by face, where each seat and each shirt has one), which is what a lit thing looks like at night.
   A long one leans with its ground (lean: how far its own x climbs, as an angle): Lusail's main straight falls
   1.2 m in the length of its grandstand, and a level building 417 m long would be buried at one end and
   standing in the air at the other. */
function vSelfLit(m, r, g, b) {
  m.onBeforeCompile = shader => {
    shader.uniforms.uGlow = { value: new THREE.Color(r, g, b) };
    shader.fragmentShader = shader.fragmentShader.replace("void main() {", "uniform vec3 uGlow;\nvoid main() {")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * uGlow;");
  };
  m.customProgramCacheKey = () => "selflit";
}
function vLook(m) {
  if (m.userData.looked) return m;
  m.userData.looked = true;
  if (/glazing/i.test(m.name)) { m.transparent = true; m.opacity = 0.16; m.depthWrite = false; m.color.set(0xbfe9e4); m.roughness = 0.06; m.metalness = 0.5; }
  else if (/lit suite|^Suite \||^Person \|/i.test(m.name)) vSelfLit(m, 0.62, 0.5, 0.36);              // warm lamps indoors
  else if (/lit garage|^Workshop \||^Equipment \||^Car \|/i.test(m.name)) vSelfLit(m, 0.55, 0.58, 0.62);      // white work lights
  else if (/^People \|/i.test(m.name)) vSelfLit(m, 0.3, 0.3, 0.31);
  else if (/\| lit/i.test(m.name)) vSelfLit(m, 0.4, 0.4, 0.42);                                         // out of doors, under a roof's lamps and the circuit's
  return m;
}
function venueModel(lay, name, p, turn, drawn = [], lean = 0) {       // (drawn: what was drawn in its place, put away when it comes)
  vModel(name + "_shell", (parts, about) => {
    const home = new THREE.Group();
    home.position.set(p[0], p[1], p[2]); home.rotation.set(0, turn, lean, "YZX");
    for (const part of parts) { const mesh = new THREE.Mesh(part.geometry, vLook(part.material)); mesh.castShadow = !part.material.transparent; mesh.receiveShadow = true; home.add(mesh); }
    lay.add(home);
    for (const old of drawn) old.visible = false;
    for (const kit of (about && about.kits) || []) vModel(kit.file, kparts => vCopies(home, kparts, kit.places.map(([x, y, z, turn]) => [x, z, -y, turn, 1]), { cast: false, wear: (kind, part) => vLook(part.material) }));
  });
}
function vPosts(lay, list, wide, mat, cast = true) {      // upright posts: [x, the height of its middle, z, how tall]
  if (!list.length) return null;
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(wide, 1, wide), mat, list.length), d = new THREE.Object3D();
  list.forEach(([x, y, z, tall], i) => { d.position.set(x, y, z); d.scale.set(1, tall, 1); d.updateMatrix(); mesh.setMatrixAt(i, d.matrix); });
  mesh.castShadow = cast; mesh.frustumCulled = false;
  return lay.add(mesh);
}
function vScreen(lay, metres, off, y, wide, tall, facing) {      // a screen beside the track at so many metres round the lap; facing: which way from it the road is (-1 to its left, 1 to its right)
  const k = vSec(metres), p = at(k, off), nm = K.normal[wrap(k)];
  const m = new THREE.Mesh(new THREE.PlaneGeometry(wide, tall), vMat("screen"));
  m.position.set(p[0], y + tall / 2, p[2]); m.lookAt(p[0] + nm[0] * facing, y + tall / 2, p[2] + nm[1] * facing);
  lay.add(m);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(wide + 0.8, tall + 0.8, 0.5), vMat("dark"));
  frame.position.copy(m.position); frame.quaternion.copy(m.quaternion); frame.translateZ(-0.3); lay.add(frame);
}
function venueBlock(lay, b, base) {      // a plain building beside the track: from, to, near, far, h, look
  const [a, count] = vSpan(b.from, b.to), y0 = base ?? verge(a + (count >> 1), b.near), face = vMat(b.look || "windows");
  vFace(lay, a, count, b.near, y0, y0 + b.h, face, 16);
  vFace(lay, a, count, b.far, y0, y0 + b.h, face, 16, { flip: true });
  vSlab(lay, a, count, b.near, b.far, y0 + b.h - 0.3, y0 + b.h, vMat("white"));
  vEnds(lay, a, count, b.near, b.far, y0, y0 + b.h, vMat("grey"));
}
function venueTent(lay, t, base) {       // a marquee: low walls and a ridged roof
  const [a, count] = vSpan(t.from, t.to), y0 = base ?? verge(a + (count >> 1), t.near), mid = (t.near + t.far) / 2, cloth = vMat("tent");
  vFace(lay, a, count, t.near, y0, y0 + 3, cloth, 4); vFace(lay, a, count, t.far, y0, y0 + 3, cloth, 4);
  lay(strip([k => [t.near, 0, y0 + 3], k => [mid, 0, y0 + 5.6], k => [mid, 0, y0 + 5.6], k => [t.far, 0, y0 + 3]], { from: a, count, tile: 4 }), cloth, { cast: true });
  vEnds(lay, a, count, t.near, t.far, y0, y0 + 3, cloth);
}
/* A grandstand beside the track: a wall at the front, a bank of seats rising behind it, a wall at the back; a flat
   roof on columns over as much of the back of it as the venue says; spiral ramps behind where it has them. "grass"
   is a banked lawn with steps (Lusail Hill), not seats. */
function venueStand(lay, st) {
  const [a, count] = vSpan(st.from, st.to), mid = wrap(a + (count >> 1)), away = Math.sign(st.far - st.near), deep = Math.abs(st.far - st.near), foot = st.look === "grass" ? 0.6 : 2.6, top = foot + st.rise;
  // Where the map has it, or behind the wall where the game's wall stands further out than that (a run-off that widens towards a corner)
  const wall = k => (away < 0 ? WALL.L : WALL.R)[wrap(k)], near = k => away * Math.max(Math.abs(st.near), wall(k) + 4), far = k => near(k) + away * deep;
  const y0 = verge(mid, near(mid)), seats = vMat(st.look === "grass" ? "grass" : "crowd"), shell = vMat("grey");
  const whole = lay, drawn = [];                              // (the stand as it is drawn here goes when a model of it comes: venues\make\stand_<name>.py)
  lay = Object.assign((g, m, o) => { const mesh = whole(g, m, o); drawn.push(mesh); return mesh; }, { add: thing => { drawn.push(thing); return whole.add(thing); } });
  if (st.look !== "grass") {
    const p = at(mid, near(mid)), ya = verge(a, near(a)), yb = verge(a + count - 1, near(a + count - 1));
    venueModel(whole, "stand_" + st.name, [p[0], (ya + yb) / 2, p[2]], vAlong(mid) + (away > 0 ? Math.PI : 0), drawn, Math.atan2(yb - ya, (count - 1) * BIN) * (away > 0 ? -1 : 1));
  }
  if (st.look !== "grass") lay(strip([k => [near(k), 0, y0], k => [near(k), 0, y0 + foot]], { from: a, count, uv: (k, c, o, dist) => [-away * dist / WALL_RUN(), c] }), vMat("wallBoards"), { cast: true });
  lay(strip([k => [near(k), 0, y0 + foot], k => [far(k), 0, y0 + top]], { from: a, count, uv: (k, c, o, dist) => [dist / 34, c] }), seats);
  vFace(lay, a, count, far, y0, y0 + top + 1.1, shell, 12);
  vEnds(lay, a, count, near, far, y0, y0 + foot, shell, y0 + top);
  whole(strip([k => [away * (wall(k) + 0.3), 0.03], k => [far(k) + away * 34, 0.03]], { from: a - 2, count: count + 4, tile: 9 }), vMat("apron"));      // paving from the fence to it, and the concourse behind, lying on the ground
  if (st.roof) {
    const front = k => far(k) - away * deep * st.roof, high = y0 + top + 4.6;
    vSlab(lay, a, count, front, k => far(k) + away * 1.5, high, high + 0.45, vMat("white"));
    lay(strip([k => [front(k) + away * 0.4, 0, high - 0.03], k => [front(k) + away * 1.1, 0, high - 0.03]], { from: a, count }), vMat("lamp"));      // the lamps under its front edge
    const posts = [];
    for (let d = st.from + 4; d <= st.to; d += 18) { const k = vSec(d), p = at(k, front(k) + away * 0.6), low = y0 + foot + st.rise * (1 - st.roof); posts.push([p[0], (low + high) / 2, p[2], high - low]); }
    vPosts(lay, posts, 0.45, shell);
  }
  for (const d of st.ramps || []) {
    const k = vSec(d), p = at(k, far(k) + away * 14), ramp = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 8.5, top + 1.5, 28, 1, true), vMat("ramp"));
    ramp.material.map.repeat.set(4, 1); ramp.position.set(p[0], y0 + (top + 1.5) / 2, p[2]); ramp.castShadow = true; lay.add(ramp);
    const lid = new THREE.Mesh(new THREE.RingGeometry(5.2, 8.9, 28).rotateX(-Math.PI / 2), vMat("white")); lid.position.set(p[0], y0 + top + 1.5, p[2]); lay.add(lid);
  }
}
function venueStandAt(lay, st) {         // a stand by where its front edge is on the map: [x, z] of its two ends, how deep, how high its back
  const [p, q] = st.front, mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2, g = groundAt(mx, mz), nm = K.normal[g.k], away = Math.sign(g.off) || 1;
  let dx = -(q[1] - p[1]), dz = q[0] - p[0];                               // square to its front; turned to point away from the road
  const len = Math.hypot(dx, dz); dx /= len; dz /= len;
  if ((dx * nm[0] + dz * nm[1]) * away < 0) { dx = -dx; dz = -dz; }
  const y0 = verge(g.k, g.off), foot = 2.2, top = foot + st.rise, P = (e, d, y) => [e[0] + dx * d, y, e[1] + dz * d];
  const wide = Math.hypot(q[0] - p[0], q[1] - p[1]), u = wide / 34;
  const whole = lay, drawn = [];                              // (as it is drawn here it goes when a model of it comes: venues\make\stand_temp.py)
  lay = Object.assign((g, m, o) => { const mesh = whole(g, m, o); drawn.push(mesh); return mesh; }, { add: thing => { drawn.push(thing); return whole.add(thing); } });
  {                                                           // the model: its own x runs along the line between the ends of its front, its back is to the left of that
    const M = st.model || st, [a, b] = M.front, cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2;
    let ex = b[0] - a[0], ez = b[1] - a[1];
    const el = Math.hypot(ex, ez), bx = M.behind ? M.behind[0] - cx : dx, bz = M.behind ? M.behind[1] - cz : dz;      // (which side is its back: the side a place behind it is on, or the side away from the road)
    ex /= el; ez /= el;
    if (ez * bx - ex * bz < 0) { ex = -ex; ez = -ez; }
    const ya = vFloor(cx - ex * el / 2, cz - ez * el / 2), yb = vFloor(cx + ex * el / 2, cz + ez * el / 2);
    venueModel(whole, "stand_" + st.name, [cx, (ya + yb) / 2, cz], Math.atan2(-ez, ex), drawn, Math.atan2(yb - ya, el));
  }
  lay(quad(P(p, 0, y0 + foot), P(q, 0, y0 + foot), P(q, st.deep, y0 + top), P(p, st.deep, y0 + top), [0, 0, u, 0, u, 1, 0, 1]), vMat("crowd"));
  lay(quad(P(p, 0, y0), P(q, 0, y0), P(q, 0, y0 + foot), P(p, 0, y0 + foot)), vMat("grey"), { cast: true });
  lay(quad(P(p, st.deep, y0), P(q, st.deep, y0), P(q, st.deep, y0 + top + 1), P(p, st.deep, y0 + top + 1)), vMat("grey"), { cast: true });
  for (const e of [p, q]) lay(quad(P(e, 0, y0), P(e, st.deep, y0), P(e, st.deep, y0 + top), P(e, 0, y0 + foot)), vMat("grey"), { cast: true });
  whole(quad(P(p, -6, y0 + 0.03), P(q, -6, y0 + 0.03), P(q, st.deep + 14, y0 + 0.03), P(p, st.deep + 14, y0 + 0.03), [0, 0, wide / 9, 0, wide / 9, 4, 0, 4]), vMat("apron"));
}

/* THE REST OF THE PLACE: what stands by itself, and what is beyond the fence. */
let vPitBack = 0;                       // how far out the back of the pit building is (the floodlights on that side stand behind it)
const vFloor = (x, z) => { const g = groundAt(x, z); return verge(g.k, g.off); };
function vBoxAt(lay, b, mat, roof) {    // a block by where it is on the map: at [x, z], size [long, wide], way [x, z] its long side runs, h
  const [long, wide] = b.size, g = new THREE.BoxGeometry(wide, b.h, long), uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {  // its picture repeats every 16 m along a wall and once up it (a box's faces come in fours: +x, -x, top, bottom, +z, -z)
    const face = Math.floor(i / 4);
    if (face === 2 || face === 3) continue;
    uv.setX(i, uv.getX(i) * (face < 2 ? long : wide) / 16);
  }
  const m = new THREE.Mesh(g, [mat, mat, roof || vMat("white"), vMat("grey"), mat, mat]);
  m.position.set(b.at[0], vFloor(b.at[0], b.at[1]) + b.h / 2, b.at[1]); m.rotation.y = Math.atan2(b.way[0], b.way[1]); m.castShadow = true;
  return lay.add(m);
}
function venueDome(lay, d) {            // a canopy of steel lattice over a pale raft, with a curved wall under it
  const r = d.across / 2, y = vFloor(d.at[0], d.at[1]), web = vMat("lattice");
  const whole = lay, drawn = [];          // (as it is drawn here it goes when the model of it comes: venues\make\vvip.py, three storeys under a round canopy on columns like trees)
  lay = { add: thing => { drawn.push(thing); return whole.add(thing); } };
  venueModel(whole, "vvip", [d.at[0], y, d.at[1]], 0, drawn);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 8, 0, TAU, 0, Math.PI * 0.44).scale(1, d.h / r, 1), web);
  const uv = cap.geometry.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 14, uv.getY(i) * 3);
  cap.position.set(d.at[0], y + 2.5, d.at[1]); cap.castShadow = true; lay.add(cap);
  const raft = new THREE.Mesh(new THREE.CircleGeometry(r * 0.92, 40).rotateX(-Math.PI / 2), vMat("white")); raft.position.set(d.at[0], y + 0.06, d.at[1]); lay.add(raft);
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.62, 5.5, 32, 1, true, 0, Math.PI * 1.25), vMat("white")); wall.position.set(d.at[0], y + 2.75, d.at[1]); wall.castShadow = true; lay.add(wall);
  const rooms = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.6, r * 0.6, 4, 32, 1, true, 0, Math.PI * 1.25), vMat("glass")); rooms.material.map.repeat.set(1, 1);
  rooms.position.set(d.at[0], y + 2.6, d.at[1]); rooms.scale.set(0.985, 1, 0.985); lay.add(rooms);
}
function venueLot(lay, p, far) {        // a car park: tarmac with bays and cars, and lamps on poles over it
  const [long, wide] = p.size, g = new THREE.PlaneGeometry(wide, long).rotateX(-Math.PI / 2), uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * wide / 40, uv.getY(i) * long / 40);
  const m = new THREE.Mesh(g, vMat("lot")), y = vFloor(p.at[0], p.at[1]), yaw = Math.atan2(p.way[0], p.way[1]), sn = Math.sin(yaw), cs = Math.cos(yaw);
  m.position.set(p.at[0], y + 0.04, p.at[1]); m.rotation.y = yaw; m.receiveShadow = false; lay.add(m);
  for (let a = -long / 2 + 35; a < long / 2; a += 70) for (let b = -wide / 2 + 35; b < wide / 2; b += 70) far.cool.push(p.at[0] + a * sn + b * cs, y + 10, p.at[1] + a * cs - b * sn);
}
/* WHAT IS GREEN, AND WHERE. A circuit in the desert is bare sand with a few planted places, so nothing is planted by
   guess: the venue's file has every tree, every row of trees, every lawn and every planted bed that OpenStreetMap's
   mappers have drawn from aerial pictures (venues\green.py), and each is stood where it is. (An older venue file
   may still give patches of trees by the lap, and those are scattered as they were.)
   The plants are sculpted on this PC from a concept picture and rebuilt as something a circuit can hold thousands
   of (venues\plant.py; venues\local\plant_<name>.glb): a tree near the road is its trunk with its leaves on cards,
   a tree far from it is three crossed photographs of itself (plant_<name>_far.glb), a shrub is one skin and a clump
   of grass its own photographs. Where a plant's file has not come (the website, or a PC that has not made them)
   a low dark shape stands in its place. */
const PLANTS = { tree: [["sidr", 0.4], ["ghaf", 0.35], ["acacia", 0.25]], low: [["shrub", 0.55], ["grass", 0.45]],
                 near: 110,       // a tree within this many metres of the road is the whole model
                 share: 0.34,     // of the trees the map has, how many are stood: they were planted in 2023 and are saplings, and
                 young: [0.42, 0.22],   // a third of them at this much of a grown tree's size (and as much again at most) is what the eye finds there:
                 row: 0,          // "i dont see many trees out there in real life" (Eric). A row of trees has one this often (0: none: the map has 22 km of rows)
                 bed: 16 };       // a planted bed has a shrub or a grass to this many square metres
function venueTrees(lay) {              // the trees, shrubs, grasses and lawns
  const where = [], low = [], own = seeded(41);      // (the plants have dice of their own, so that nothing else the circuit is built with moves)
  for (const patch of V.trees || []) {
    const L = patch.lap;
    for (let i = 0; i < patch.n; i++) { const p = at(vSec(L.from + rnd() * (L.to - L.from)), L.near + rnd() * (L.far - L.near)); where.push([p[0], p[1], p[2], 0.7 + rnd() * 0.9]); }
    for (let i = 0; i < patch.n * 1.1; i++) { const p = at(vSec(L.from + own() * (L.to - L.from)), L.near + own() * (L.far - L.near)); low.push([p[0], p[1], p[2], own() * TAU, 0.75 + own() * 0.6, own()]); }
  }
  for (let i = 0; i < (V.dice || 0); i++) rnd();      // (the throws of the circuit's dice that its trees used to take, thrown still: nothing else it is built with moved when the trees went to where the map has them)
  for (const [x, z] of V.treesAt || []) { const stood = own() < PLANTS.share, s = PLANTS.young[0] + own() * PLANTS.young[1]; if (stood) where.push([x, vFloor(x, z), z, s, true]); }
  if (PLANTS.row) for (const row of V.treeRows || []) for (let i = 0; i + 1 < row.length; i++) {
    const [x0, z0] = row[i], [x1, z1] = row[i + 1], long = Math.hypot(x1 - x0, z1 - z0);
    for (let d = own() * PLANTS.row; d < long; d += PLANTS.row) { const x = x0 + (x1 - x0) * d / long, z = z0 + (z1 - z0) * d / long; where.push([x, vFloor(x, z), z, PLANTS.young[0] + own() * PLANTS.young[1], true]); }
  }
  const inside = (ring, x, z) => { let odd = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, zi] = ring[i], [xj, zj] = ring[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) odd = !odd; } return odd; };
  const span = ring => { let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, twice = 0; ring.forEach(([x, z], i) => { const [u, v] = ring[(i + 1) % ring.length]; twice += x * v - u * z; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }); return { x0, x1, z0, z1, area: Math.abs(twice) / 2 }; };
  for (const ring of V.gardens || []) {            // a planted bed: shrubs and grasses all over it
    const q = span(ring), want = Math.round(q.area / PLANTS.bed);
    for (let got = 0, tries = 0; got < want && tries < want * 40; tries++) { const x = q.x0 + own() * (q.x1 - q.x0), z = q.z0 + own() * (q.z1 - q.z0); if (inside(ring, x, z)) { low.push([x, vFloor(x, z), z, own() * TAU, 0.75 + own() * 0.6, own()]); got++; } }
  }
  if ((V.lawns || []).length) {                    // a lawn: its outline, laid flat
    const turf = new THREE.MeshStandardMaterial({ color: 0x17361d, roughness: 1 });      // (dark: under the floodlights a brighter green reads as paint)
    toySkin.push([turf, { color: new THREE.Color(0x4f9d4b) }]);
    for (const ring of V.lawns) {
      const q = span(ring), m = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, -z)))).rotateX(-Math.PI / 2), turf);
      m.position.y = vFloor((q.x0 + q.x1) / 2, (q.z0 + q.z1) / 2) + 0.05; m.receiveShadow = true; lay.add(m);
    }
  }
  if (!where.length && !low.length) return;
  const leaf = new THREE.MeshStandardMaterial({ color: 0x1f4f2c, roughness: 1, flatShading: true }), bark = new THREE.MeshStandardMaterial({ color: 0x3b2f24, roughness: 1 });
  toySkin.push([leaf, { color: new THREE.Color(0x4f9d4b) }], [bark, { color: new THREE.Color(0x7a5c40) }]);      // (dark, for the night: in the model's daylight they are green)
  const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.4, 1).scale(1, 0.8, 1).translate(0, 4.2, 0), leaf, Math.max(1, where.length));
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.16, 0.24, 2.6, 6).translate(0, 1.3, 0), bark, Math.max(1, where.length)), d = new THREE.Object3D(), turns = [];
  crown.count = trunk.count = where.length;
  where.forEach(([x, y, z, s], i) => { d.position.set(x, y, z); d.rotation.y = turns[i] = own() * TAU; d.scale.set(s, s * (0.8 + own() * 0.5), s); d.updateMatrix(); crown.setMatrixAt(i, d.matrix); trunk.setMatrixAt(i, d.matrix); });
  crown.castShadow = trunk.castShadow = true; lay.add(crown); lay.add(trunk);
  const road = []; for (let k = 0; k < K.centre.length; k += 3) road.push(K.centre[k][0], K.centre[k][2]);      // how far each tree is from the road
  const off = (x, z) => { let least = Infinity; for (let i = 0; i < road.length; i += 2) { const far = (road[i] - x) * (road[i] - x) + (road[i + 1] - z) * (road[i + 1] - z); if (far < least) least = far; } return Math.sqrt(least); };
  const pick = (list, r) => { let sum = 0; for (const [name, share] of list) { sum += share; if (r < sum) return name; } return list[list.length - 1][0]; };
  const places = {}, put = (name, place) => (places[name] = places[name] || []).push(place);
  where.forEach(([x, y, z, s, mapped], i) => put(pick(PLANTS.tree, own()) + (off(x, z) > PLANTS.near ? "_far" : ""), [x, y, z, turns[i], mapped ? s : 0.55 + 0.45 * s, i]));
  for (const [x, y, z, turn, size, r] of low) put(pick(PLANTS.low, r), [x, y, z, turn, size, -1]);
  const gone = new THREE.Matrix4().makeScale(0, 0, 0);
  for (const [name, list] of Object.entries(places)) vModel("plant_" + name, parts => {
    vCopies(lay, parts, list, { cast: !name.endsWith("_far"), wear: (kind, p) => { if (kind === "leaf") { p.material.alphaTest = Math.max(p.material.alphaTest || 0, 0.4); p.material.transparent = false; if (name.endsWith("_far")) p.material.color.setScalar(0.62); } return p.material; } });      // (cut out by its picture; every card has a back of its own, so neither side is drawn from behind)
    for (const place of list) if (place[5] >= 0) { crown.setMatrixAt(place[5], gone); trunk.setMatrixAt(place[5], gone); }      // and the shape that stood in for it goes
    crown.instanceMatrix.needsUpdate = trunk.instanceMatrix.needsUpdate = true;
  });
}
function venuePanels(lay) {             // the light panels the marshals' flags are shown on, on the fence where the circuit has them: green, the track is clear
  const list = V.panels || [];
  if (!list.length) return;
  const face = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.3, 0.9), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 3.2, 0.5), side: both }), list.length);
  const back = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, 1.2, 0.25), vMat("dark"), list.length), d = new THREE.Object3D();
  const sides = V.panelSides || [];      // (which side of the road each is on, where the venue knows: else the outside of its bend)
  list.forEach((metres, i) => {
    const k = vSec(metres), sign = sides[i] || (bend[wrap(k)] > 0 ? -1 : 1), w = (sign < 0 ? WALL.L : WALL.R)[wrap(k)], p = at(k, sign * (w + 0.5)), c = K.centre[wrap(k - 12)];
    d.position.set(p[0], p[1] + 3.4, p[2]); d.lookAt(c[0], p[1] + 3.4, c[2]); d.updateMatrix(); back.setMatrixAt(i, d.matrix);
    d.translateZ(0.14); d.updateMatrix(); face.setMatrixAt(i, d.matrix);
  });
  lay.add(back); lay.add(face);
}
/* THE MARSHAL POSTS, each where the FIA's own circuit map has it (venues\fia_map.py reads them off the drawing: 45
   at Lusail, MP0.0 to MP16.9, each on its side of the road). At this circuit a post is a bay behind the barrier:
   concrete blocks with framed mesh panels on them, open at the back (the fence-maker's photographs of the place).
   In each stands a wheeled extinguisher, where this PC has the model (venues\local\trolley.glb, the one GPT Astra
   made by itself: venues\thing.py). */
function venuePosts(lay) {
  const list = V.posts || [];
  if (!list.length) return;
  const long = 3.4, deep = 1.9, block = 0.85, mesh = 2.1, end = long / 2 - 0.22;
  const blocks = merge([new THREE.BoxGeometry(long, block, 0.45).translate(0, block / 2, 0), new THREE.BoxGeometry(0.45, block, deep).translate(-end, block / 2, deep / 2), new THREE.BoxGeometry(0.45, block, deep).translate(end, block / 2, deep / 2)]);
  const panels = merge([new THREE.PlaneGeometry(long, mesh).translate(0, block + mesh / 2, 0), new THREE.PlaneGeometry(deep, mesh).rotateY(Math.PI / 2).translate(-end, block + mesh / 2, deep / 2), new THREE.PlaneGeometry(deep, mesh).rotateY(Math.PI / 2).translate(end, block + mesh / 2, deep / 2)]);
  const places = list.map(([metres, sign]) => { const k = vSec(metres), w = (sign < 0 ? WALL.L : WALL.R)[wrap(k)], p = at(k, sign * (w + 1.2)); return [p[0], p[1], p[2], vAlong(k) + (sign > 0 ? 0 : Math.PI), 1]; });      // (its open back away from the road)
  vCopies(lay, [{ kind: "body", geometry: blocks, material: vMat("grey") }, { kind: "body", geometry: panels, material: vMat("truss") }], places);
  vModel("trolley", parts => vCopies(lay, parts, places.map(([x, y, z, turn]) => [x + Math.cos(turn) * 0.9 + Math.sin(turn) * 1.0, y, z - Math.sin(turn) * 0.9 + Math.cos(turn) * 1.0, turn + 2.6, 1])));
}
/* THE TEAMS' STANDS ON THE PIT WALL: a roofed desk of screens with a row of seats, looking at the road, on its own
   length of wall (venues\local\pit_stand.glb: sculpted on this PC from a picture GPT Astra drew, venues\thing.py).
   Eleven, a team each, along the wall in front of the garages. Where each team's really stands is in no source
   found, so they are evenly spaced: that much is ours and not the circuit's. */
function venuePitStands(lay, P) {       // (P: the pit lane as replay3d.js laid it: which side it is on, and where its wall runs)
  const pit = V.pit, places = [];
  if (!pit || !P.wall) return;
  for (let i = 0; i < 11; i++) { const k = vSec(pit.from + 40 + i * 30), p = at(k, P.wall(k) + P.s * 0.95); places.push([p[0], p[1], p[2], vAlong(k) + (P.s > 0 ? 0 : Math.PI), 1]); }      // (its own length of wall against the lane's side of the wall that is there)
  vModel("pit_stand", parts => vCopies(lay, parts, places));
}
function venueArena(lay, A) {           // the dome on the skyline: white, a dark lattice over it, lit from below
  const skin = new THREE.MeshStandardMaterial({ map: tex(512, 256, (c, w, h) => {
    c.fillStyle = "#d9d6cc"; c.fillRect(0, 0, w, h); c.strokeStyle = "#1f2d55"; c.lineWidth = 3;
    for (let i = -w; i < w * 2; i += 32) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i + h, h); c.moveTo(i + h, 0); c.lineTo(i, h); c.stroke(); }
  }), roughness: 0.6, side: both });
  skin.emissiveMap = skin.map; skin.emissive = new THREE.Color(0.32, 0.31, 0.3);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 14, 0, TAU, 0, Math.PI / 2).scale(A.size[0] / 2, A.h, A.size[1] / 2), skin);
  dome.position.set(A.at[0], vFloor(A.at[0], A.at[1]), A.at[1]); dome.rotation.y = Math.atan2(A.way[0], A.way[1]) + Math.PI / 2; lay.add(dome);
}
function vGlows(list, colour, size) {   // lamps a long way off: a soft point of light each
  if (!list.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(list, 3));
  const glows = new THREE.Points(g, new THREE.PointsMaterial({ map: tex(32, 32, (c, w) => {
    const q = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); q.addColorStop(0, "rgba(255,255,255,1)"); q.addColorStop(0.3, "rgba(255,255,255,0.45)"); q.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = q; c.fillRect(0, 0, w, w);
  }, { repeat: false }), color: new THREE.Color(...colour), size, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  nightOnly.push(glows);                // (put away in daylight: replay3d_toy.js)
  return glows;
}
/* THE SHORT LIGHTS. Lusail is lit by about a thousand posts, and most of them are short: a slim pole a little
   taller than the fence with one lamp on it, every ten metres or so down both sides of the road just behind the
   fence, all the way round (the venue's file says how often and how tall, and from what that is known). The pole
   is venues\local\light_short_shell.glb (venues\make\lights.py); with or without it each lamp is a small glow,
   and a string of those round the lap is most of what the place looks like from a distance at night. None on the
   pits' side while the lane runs there, and none where it would stand in front of a television camera. */
function venueLights(lay) {
  const L = V.lights;
  if (!L) return;
  const every = Math.max(1, Math.round(L.every / BIN)), places = [], glow = [];
  for (let k = 0; k < n; k += every) for (const sign of [-1, 1]) {
    if (lane && lane.has(k) && sign === lane.side) continue;
    const w = (sign < 0 ? WALL.L : WALL.R)[k];
    if (!(w > 0)) continue;
    const p = at(k, sign * (w + 1.1)), nm = K.normal[k];
    if (STATIONS.some(st => Math.hypot(st.pos.x - p[0], st.pos.z - p[2]) < 7)) continue;
    places.push([p[0], p[1], p[2], vAlong(k) + (sign > 0 ? Math.PI : 0), 1]);
    glow.push(p[0] - nm[0] * sign * 0.5, p[1] + L.h - 0.15, p[2] - nm[1] * sign * 0.5);
  }
  vModel("light_short_shell", parts => vCopies(lay, parts, places, { cast: false, wear: (kind, part) => vLook(part.material) }));
  const lamps = vGlows(glow, [1.0, 0.95, 0.86], 3.4);
  if (lamps) lay.add(lamps);
}
function venueBuild(lay) {
  const far = { warm: [], cool: [], red: [] };
  for (const st of V.stands || []) venueStand(lay, st);
  for (const st of V.standsAt || []) venueStandAt(lay, st);
  if (V.vvip) venueDome(lay, V.vvip);
  for (const b of V.blocks || []) vBoxAt(lay, b, vMat(b.look || "windows"));
  for (const p of V.carParks || []) venueLot(lay, p, far);
  venueTrees(lay);
  venuePanels(lay);
  venuePosts(lay);
  venueLights(lay);
  if (V.arena) { venueArena(lay, V.arena); for (let i = 0; i < 28; i++) { const a = i / 28 * TAU; far.warm.push(V.arena.at[0] + Math.cos(a) * V.arena.size[0] * 0.62, vFloor(...V.arena.at) + 9, V.arena.at[1] + Math.sin(a) * V.arena.size[1] * 0.62); } }
  for (const t of V.towers || []) {      // a mast with a red lamp on it
    const y = vFloor(t[0], t[1]), mast = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.6, 60, 4, 6, true), vMat("truss"));
    mast.material.map.repeat.set(1, 1); mast.position.set(t[0], y + 30, t[1]); lay.add(mast); far.red.push(t[0], y + 61, t[1]);
  }
  if (V.road) {                           // a lit road beyond the fence: a lamp every 45 m along it, both sides
    const line = V.road.through;
    for (let i = 0; i + 1 < line.length; i++) {
      const [x0, z0] = line[i], [x1, z1] = line[i + 1], len = Math.hypot(x1 - x0, z1 - z0), nx = -(z1 - z0) / len, nz = (x1 - x0) / len;
      for (let d = 0; d < len; d += 45) for (const side of [-14, 14]) far.warm.push(x0 + (x1 - x0) * d / len + nx * side, vFloor(x0, z0) + 12, z0 + (z1 - z0) * d / len + nz * side);
    }
  }
  for (const st of STATIONS) {            // the television cameras the replay looks through: each on a scaffold tower, with a deck and a rail
    const y = vFloor(st.pos.x, st.pos.z), tall = Math.max(2, st.pos.y - y - 2.1), g = new THREE.BoxGeometry(2.4, tall, 2.4), uv = g.attributes.uv;      // (the deck is a man's height below the lens)
    for (let i = 0; i < uv.count; i++) if (Math.floor(i / 4) !== 2 && Math.floor(i / 4) !== 3) uv.setY(i, uv.getY(i) * tall / 2.4);
    const tower = new THREE.Mesh(g, vMat("truss")); tower.position.set(st.pos.x, y + tall / 2, st.pos.z); tower.castShadow = true; lay.add(tower);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.14, 3.0), vMat("dark")); deck.position.set(st.pos.x, y + tall + 0.07, st.pos.z); lay.add(deck);
  }
  for (const [list, colour, size] of [[far.warm, [1.0, 0.72, 0.4], 26], [far.cool, [0.85, 0.92, 1.0], 16], [far.red, [1.0, 0.1, 0.08], 30]]) { const glow = vGlows(list, colour, size); if (glow) lay.add(glow); }
}
/* What stands on the horizon, each thing the way it really is from here and as big as it really looks: towers with
   their windows lit, a pair of crescents, a stadium's bowl. Hung on the sky's own shell (4200 m out), so they sit
   behind everything and the haze does not take them. */
function venueSkyline() {
  const g = new THREE.Group(), R = 4200;
  V.skyline.forEach((s, i) => {
    const tall = Math.max(6, R * s.h / (s.km * 1000)), wide = Math.max(4, R * s.w / (s.km * 1000));
    const picture = tex(64, 128, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      if (s.what === "bowl") {            // a wide low bowl, glowing from within
        const q = c.createLinearGradient(0, h * 0.2, 0, h); q.addColorStop(0, "rgba(255,214,150,0.95)"); q.addColorStop(1, "rgba(120,84,40,0.9)");
        c.fillStyle = q; c.beginPath(); c.ellipse(w / 2, h, w / 2, h * 0.8, 0, Math.PI, TAU); c.fill();
      } else if (s.what === "crescent") { // two curved blades, leaning apart
        for (const side of [-1, 1]) { c.fillStyle = "#0a0c12"; c.beginPath(); c.moveTo(w / 2 + side * 2, h); c.quadraticCurveTo(w / 2 + side * w * 0.5, h * 0.5, w / 2 + side * w * 0.2, 0); c.quadraticCurveTo(w / 2 + side * w * 0.28, h * 0.55, w / 2 + side * w * 0.16, h); c.fill();
          for (let y = 6; y < h - 4; y += 5) if (rnd() < 0.8) { c.fillStyle = "rgba(255,220,160,0.9)"; c.fillRect(w / 2 + side * (w * 0.2 + Math.sin(y / h * Math.PI) * w * 0.14), y, 2, 2); } }
      } else {                            // a tower: dark, most of its windows lit, a lamp on top
        c.fillStyle = "#161b28"; c.fillRect(w * 0.12, 0, w * 0.76, h);
        for (let y = 5; y < h - 3; y += 5) for (let x = w * 0.18; x < w * 0.84; x += 6) if (rnd() < 0.62) { c.fillStyle = rnd() < 0.7 ? "rgba(255,216,150,1)" : "rgba(175,212,255,1)"; c.fillRect(x, y, 4, 3); }
        c.fillStyle = "rgba(255,60,50,1)"; c.fillRect(w / 2 - 2, 0, 4, 3);
      }
    }, { repeat: false, aniso: 4 });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(wide, tall), new THREE.MeshBasicMaterial({ map: picture, color: new THREE.Color(1.9, 1.9, 1.9), transparent: true, fog: false, depthWrite: false }));
    m.position.set(s.way[0] * R, tall / 2 - 12, s.way[1] * R); m.lookAt(0, tall / 2 - 12, 0); m.renderOrder = -1 + i * 0.001; g.add(m);
  });
  // and the light a city throws into the air over itself: one soft glow behind the lot, where the middle of them is
  let mx = 0, mz = 0;
  for (const s of V.skyline) { mx += s.way[0]; mz += s.way[1]; }
  const len = Math.hypot(mx, mz) || 1, haze = new THREE.Mesh(new THREE.PlaneGeometry(1500, 300), new THREE.MeshBasicMaterial({ map: tex(128, 64, (c, w, h) => {
    const q = c.createRadialGradient(w / 2, h, 0, w / 2, h, w / 2); q.addColorStop(0, "rgba(255,196,130,0.42)"); q.addColorStop(0.25, "rgba(255,180,118,0.2)"); q.addColorStop(0.5, "rgba(255,170,110,0.08)"); q.addColorStop(0.75, "rgba(255,165,105,0.025)"); q.addColorStop(1, "rgba(255,160,100,0)");
    c.fillStyle = q; c.fillRect(0, 0, w, h);
  }, { repeat: false }), transparent: true, fog: false, depthWrite: false, blending: THREE.AdditiveBlending }));
  haze.position.set(mx / len * (R + 30), 150 - 12, mz / len * (R + 30)); haze.lookAt(0, 138, 0); haze.renderOrder = -1.1; g.add(haze);
  return g;
}

/* PHOTOGRAPHED SURFACES. The road, its paint, gravel, concrete and the fence are drawn here in the page, which is why
   they look drawn. Beside the player there may be photographs of the real things (venues\textures: public-domain
   scans, made small by venues\make_textures.py), and a material takes them up when they have come: its colours if
   it wants them, the lie of its surface, how rough it is. Until they come, and wherever there is nowhere to fetch
   them from (a replay opened as a file), what is drawn here stays. */
const vPictures = new THREE.TextureLoader();
function vPhoto(file, then, o = {}, tries = 2) {
  if (!S.venueAt) return;
  vPictures.load(S.venueAt + file, t => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 16;
    t.colorSpace = o.data ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    if (o.repeat) t.repeat.set(...(Array.isArray(o.repeat) ? o.repeat : [o.repeat, o.repeat]));
    then(t);
  }, undefined, () => { if (tries > 1) setTimeout(() => vPhoto(file, then, o, tries - 1), 600); });      // (once more, in case nobody answered: see glbLoad in replay3d_cars.js)
}
function surfaced(mat, name, o = {}) {      // o: repeat (how many times the photograph goes into one of the drawn picture), tint (what its colours are multiplied by; none: its colours are not used), bump (how strongly its surface shows)
  if (o.tint) vPhoto(name + "_d.jpg", t => { mat.map = t; mat.color.setRGB(...o.tint); mat.needsUpdate = true; }, o);
  vPhoto(name + "_n.jpg", t => { mat.normalMap = t; mat.normalScale.set(o.bump ?? 1, o.bump ?? 1); mat.bumpMap = null; mat.needsUpdate = true; }, { ...o, data: true });
  vPhoto(name + "_arm.jpg", t => { mat.roughnessMap = t; mat.roughness = o.rough ?? 1; mat.needsUpdate = true; }, { ...o, data: true });
  return mat;
}

/* PROPS. Things somebody else made and adopted (venues\props.py, rides\adopt.py), and the stands and buildings made
   by rule in Blender (venues\make): venues\local\<name>.glb, which goes wherever the player goes (venue/local beside
   it: see ADOPTED in replay3d_cars.js). Each is asked for when the circuit is built and stood in its places when it
   has come; where it never comes, what is drawn here stays. */
function vModel(name, then) {
  if (!S.venueAt) return;
  if (!sculptLoader) {
    const draco = new DRACOLoader();
    draco.setDecoderPath("https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/");
    sculptLoader = new GLTFLoader(); sculptLoader.setDRACOLoader(draco);
  }
  glbLoad(S.venueAt + "local/" + name + ".glb", gltf => {      // (asked for again if nobody answers: replay3d_cars.js)
    gltf.scene.updateMatrixWorld(true);
    const parts = [];
    gltf.scene.traverse(o => {
      if (!o.isMesh) return;
      if (o.material.map) o.material.map.anisotropy = 8;
      parts.push({ name: o.name, kind: o.name.split("_")[0], geometry: o.geometry.clone().applyMatrix4(o.matrixWorld), material: o.material });
    });
    then(parts, (gltf.asset && gltf.asset.extras) || null);
  }, () => {});
}
function vCopies(lay, parts, places, o = {}) {      // a prop stood in many places: [x, y, z, turned so far about the upright, how big]; o.wear(kind, part) may give a part another material
  const d = new THREE.Object3D(), made = [];
  if (!places.length) return made;
  for (const p of parts) {
    const mesh = new THREE.InstancedMesh(p.geometry, (o.wear && o.wear(p.kind, p)) || p.material, places.length);
    places.forEach(([x, y, z, turn = 0, size = 1], i) => { d.position.set(x, y, z); d.rotation.set(0, turn, 0); d.scale.setScalar(size); d.updateMatrix(); mesh.setMatrixAt(i, d.matrix); });
    mesh.castShadow = o.cast !== false && p.kind !== "lamp";
    lay.add(mesh); made.push(mesh);
  }
  return made;
}
const vAlong = k => heading(k) - Math.PI / 2;      // the turn that lays a prop's own length (its x) along the road at section k
/* What the venue asks for, each stood where the venue's file says: boards counting down to the corners, walls of
   tyres at the ends of the big run-offs, palms in the gardens, the lamps of the start. (The floodlight masts are
   asked for where the masts are made, in replay3d.js.) */
function venueProps(lay) {
  const P = V.props || {};
  const wallAt = (k, sign) => (sign < 0 ? WALL.L : WALL.R)[wrap(k)];
  // boards on the fence that count down to a corner: 200, 150, 100, 50 metres before it is turned into
  for (const far of [200, 150, 100, 50]) {
    const places = (P.boards || []).map(([turnIn, side]) => {
      const k = vSec(turnIn - far), p = at(k, side * (wallAt(k, side) - 0.12));
      return [p[0], p[1] + 1.5, p[2], heading(k), 1.7];
    });
    if (places.length) vModel("board" + far, parts => vCopies(lay, parts, places, { cast: false }));
  }
  // walls of tyres in front of the wall: a length of them every five metres
  for (const [from, to, side] of P.tyres || []) {
    const places = [];
    for (let d = from; d < to; d += 5.02) { const k = vSec(d), p = at(k, side * (wallAt(k, side) - 1.2)); places.push([p[0], p[1], p[2], vAlong(k) + (side > 0 ? Math.PI : 0), 1]); }
    vModel("tyres", parts => vCopies(lay, parts, places));
  }
  // palms, in rows and in the gardens
  const palms = [];
  for (const patch of P.palms || []) {
    const L = patch.lap;
    for (let i = 0; i < patch.n; i++) {
      const d = patch.row ? L.from + (L.to - L.from) * (i + 0.5) / patch.n : L.from + rnd() * (L.to - L.from), off = patch.row ? L.near : L.near + rnd() * (L.far - L.near);
      const p = at(vSec(d), off); palms.push([p[0], p[1], p[2], rnd() * TAU, 0.85 + rnd() * 0.5]);
    }
  }
  if (palms.length) vModel("palm", parts => vCopies(lay, parts, palms, { wear: (kind, p) => { p.material.side = both; p.material.alphaTest = Math.max(p.material.alphaTest || 0, 0.4); return p.material; } }));
}

// The sky over the circuit: part of the 3D view. replay_build.py joins this file onto the end of replay3d.js, so
// everything in that file is in reach here, nothing is imported, and this is not a module on its own.

// ------------------------------------------------------------------ the night sky
/* The sky of a race run after dark, and not the one a floodlit circuit really gets: the Milky Way from one horizon
   to the other, pale, with its dust lanes; faint clouds of coloured gas; a moon; and some thousands of stars.

   The glow is painted once, when the scene is built, into a cube map: all of it is noise laid on the sphere of
   directions, so there is no seam and no pole, and it costs nothing afterwards. The stars are separate, drawn as
   points so they stay sharp at any size of picture; they are thickest along the Milky Way and each has a colour,
   a brightness and a twinkle of its own. The whole sky is hung on the circuit: the heart of the Milky Way stands
   low over the far end of the start straight, where the cameras look as the lights go out, and it turns about
   the pole at the rate the real one does. */
const SKY = { nebula: 1, stars: 1, twinkle: 1, meteors: 0.5, spin: 1 };      // each can be changed as it runs (Stage3D.sky); nebula is all the painted glow
const CLOUDS = [   // where (degrees right of the start straight, degrees up), how wide (degrees), two colours, how strong
  [ -34, 27, 24, [1.00, 0.16, 0.34], [0.52, 0.14, 0.86], 1.15],      // rose into violet, left of the core
  [   9, 15, 14, [1.00, 0.46, 0.10], [1.00, 0.20, 0.26], 1.20],      // amber and red, in the core's own dust
  [  50, 30, 21, [0.08, 0.80, 0.72], [0.14, 0.36, 1.00], 1.15],      // teal into blue
  [ 104, 46, 25, [0.22, 0.40, 1.00], [0.60, 0.30, 0.95], 0.80],      // blue and violet, high on the arch
  [ 131, 16, 13, [1.00, 0.24, 0.42], [1.00, 0.55, 0.30], 0.90],      // pink and peach, low
  [ 162, 27, 25, [0.62, 0.18, 0.92], [0.10, 0.74, 0.78], 1.10],      // violet and teal, behind the grid
  [-158, 17, 16, [0.16, 0.50, 1.00], [0.10, 0.85, 0.80], 0.80],      // blue and cyan, low
  [-112, 33, 22, [1.00, 0.30, 0.14], [1.00, 0.66, 0.16], 1.25],      // red and gold
  [ -72, 16, 14, [0.12, 0.82, 0.60], [0.50, 0.24, 0.95], 0.75],      // green-teal and violet, low
  [-150, 66, 30, [0.25, 0.42, 0.95], [0.80, 0.25, 0.66], 0.70],      // blue and pink, overhead
  [  20, 62, 50, [0.16, 0.20, 0.62], [0.44, 0.12, 0.44], 0.30],      // and two wide thin veils, so the dark between them has colour in it too
  [-128, 30, 54, [0.42, 0.10, 0.30], [0.10, 0.26, 0.50], 0.28],
];
const night = { dome: null, stars: null, streak: null, cube: null, grain: null, far: null, moon: null, shown: null, clear: 1, at: null,
                pole: new THREE.Vector3(), q: new THREE.Quaternion(), m4: new THREE.Matrix4(),
                a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3() };
/* The noise all of it is made from: four separate fields of gradient noise, worked out once here and kept in a
   small volume that repeats every eight cells, which the painting shader then reads. Doing the same sums in
   the shader looks no different, but the graphics driver took over twenty seconds to compile them. */
function noiseVolume() {
  const N = 64, CELLS = 8, r = seeded(77), data = new Uint16Array(N * N * N * 4), grad = new Float32Array(CELLS ** 3 * 4 * 3);
  for (let i = 0; i < grad.length; i += 3) {          // a direction at every corner of every cell, for each field
    const z = r() * 2 - 1, th = r() * TAU, q = Math.sqrt(1 - z * z);
    grad[i] = q * Math.cos(th); grad[i + 1] = q * Math.sin(th); grad[i + 2] = z;
  }
  const ease = t => t * t * t * (t * (t * 6 - 15) + 10), half = THREE.DataUtils.toHalfFloat;
  for (let z = 0, at = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const px = (x + 0.5) / N * CELLS, py = (y + 0.5) / N * CELLS, pz = (z + 0.5) / N * CELLS;
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz), fx = px - ix, fy = py - iy, fz = pz - iz;
    const ux = ease(fx), uy = ease(fy), uz = ease(fz);
    for (let c = 0; c < 4; c++, at++) {
      let v = 0;
      for (let k = 0; k < 8; k++) {                    // the eight corners of the cell this point is in
        const cx = k & 1, cy = (k >> 1) & 1, cz = k >> 2;
        const g = ((((iz + cz) % CELLS * CELLS + (iy + cy) % CELLS) * CELLS + (ix + cx) % CELLS) * 4 + c) * 3;
        v += (grad[g] * (fx - cx) + grad[g + 1] * (fy - cy) + grad[g + 2] * (fz - cz)) * (cx ? ux : 1 - ux) * (cy ? uy : 1 - uy) * (cz ? uz : 1 - uz);
      }
      data[at] = half(v);
    }
  }
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RGBAFormat; t.type = THREE.HalfFloatType; t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping; t.needsUpdate = true;
  return t;
}
const NOISE = `
  uniform highp sampler3D grain;
  vec4 noise4(vec3 p) { return textureLod(grain, p * 0.125, 0.0); }        // four fields at once, each about -0.6 to 0.6
  vec4 fbm4(vec3 p) { vec4 s = vec4(0.0); float a = 0.5; for (int k = 0; k < 6; k++) { s += a * noise4(p); p = p * 2.02 + vec3(17.1, 3.7, 9.2); a *= 0.5; } return s; }
  float fbm(vec3 p) { return fbm4(p).x; }
  vec3 fbm3(vec3 p) { return fbm4(p).yzw; }
  float cloudy(vec3 p) { return clamp(0.5 + 1.25 * fbm4(p).x, 0.0, 1.0); }  // 0 to 1, mostly in the middle
  float ridge(vec3 p) { float a = 0.5, s = 0.0; for (int k = 0; k < 5; k++) { s += a * (1.0 - 2.4 * abs(noise4(p).w)); p = p * 2.07 + vec3(5.3, 11.9, 2.6); a *= 0.5; } return s; }   // filaments
`;
const GAS = `varying vec3 vDir;${NOISE}
  uniform vec3 c, one, two; uniform float rad, seed, power;                 // one cloud of gas: where, its two colours, how wide, which, how strong
  void main() {
    vec3 d = normalize(vDir);
    if (dot(d, c) < cos(min(rad * 1.9, 3.1))) discard;                      // well clear of it: nothing to work out
    // its outline: pushed about by noise, and longer one way than the other, so no two are the same round puff
    vec3 q = normalize(d + 0.72 * rad * fbm3(d * (0.8 / rad) + seed));
    vec3 e1 = normalize(cross(c, vec3(0.31, 0.89, 0.33))), e2 = cross(c, e1);
    float ca = cos(seed * 1.7), sa = sin(seed * 1.7);
    vec2 uv = vec2(dot(q, e1), dot(q, e2));
    uv = vec2(ca * uv.x - sa * uv.y, (sa * uv.x + ca * uv.y) * (1.3 + 1.1 * fract(seed * 0.37)));
    float fall = 1.0 - length(uv) / sin(rad);
    if (fall <= 0.0 || dot(q, c) < 0.0) discard;
    vec3 p = d * (1.9 / rad) + seed;
    p += 0.55 * fbm3(p * 1.1 + 2.1);                                                  // wisps
    float body = cloudy(p), edge = smoothstep(0.0, 0.55, fall);
    float dens = edge * smoothstep(0.42, 0.96, body * 0.58 + ridge(p * 1.9 + 3.0) * 0.40 + ridge(p * 4.6 + 17.0) * 0.13 + fall * 0.16);
    dens *= 1.0 - 0.75 * smoothstep(0.50, 0.78, ridge(p * 1.3 + 23.0)) * edge;        // rifts of dark dust across it
    vec3 col = mix(one, two, smoothstep(0.3, 0.7, cloudy(p * 0.55 + 14.0))) * dens;
    col += mix(vec3(0.16, 0.24, 0.62), two, 0.35) * 0.5 * dens * (1.0 - dens) * edge;      // where the gas is thin, starlight scattered blue
    col += mix(one, two, 0.5) * 0.035 * fall * fall;                                  // a faint veil round it: it fades out, it doesn't end
    col += vec3(0.34) * pow(dens, 3.0);                                               // and its thickest knots burn towards white
    gl_FragColor = vec4(col * power, 1.0);
  }`;
function milkyWay(galN, core) {         // the first layer, with everything that isn't a cloud; its alpha says how much dust is in the way of the gas
  const v3 = v => `vec3(${v.x.toFixed(5)}, ${v.y.toFixed(5)}, ${v.z.toFixed(5)})`;
  return `varying vec3 vDir;${NOISE}
  void main() {
    vec3 d = normalize(vDir), galN = ${v3(galN)}, core = ${v3(core)};
    float lat = dot(d, galN), toCore = dot(d, core) * 0.5 + 0.5;
    vec3 w = d * 2.4 + 0.5 * fbm3(d * 3.1 + 1.3);
    // the Milky Way: a pale band right round the sky, wider and creamier towards its core, dark dust down its middle,
    // wisps of that dust reaching out either side, and a few knots of rose where gas is lit along it (its grain is real stars, below)
    float width = mix(0.14, 0.30, pow(toCore, 3.0)), coreAng = acos(clamp(dot(d, core), -1.0, 1.0));
    float band = exp(-pow(lat / width, 2.0)), spine = exp(-pow(lat / (width * 0.45), 2.0)), reach = exp(-pow(lat / (width * 2.4), 2.0));
    float clump = cloudy(w * 2.6 + 4.0), fine = cloudy(w * 7.0 + 31.0);
    float lanes = smoothstep(0.40, 0.72, ridge(w * 2.1 + 9.0)) * spine;
    vec3 disc = mix(vec3(0.74, 0.79, 0.96), vec3(1.00, 0.87, 0.68), pow(toCore, 2.0));
    vec3 col = disc * 0.125 * band * (0.22 + 0.78 * clump * clump) * (0.5 + 0.5 * fine) * (0.9 + 2.0 * pow(toCore, 4.0));
    col += vec3(1.0, 0.87, 0.66) * 0.20 * exp(-pow(coreAng / 0.22, 2.0)) * (0.5 + 0.5 * clump);
    col += disc * 0.034 * reach * smoothstep(0.50, 0.92, cloudy(w * 1.5 + 52.0) * 0.6 + ridge(w * 1.25 + 61.0) * 0.5) * (0.6 + 0.8 * toCore);
    col += vec3(1.0, 0.36, 0.46) * 0.045 * spine * smoothstep(0.66, 0.84, cloudy(w * 5.3 + 40.0));
    col *= 1.0 - 0.9 * lanes;
    // and the rest of the sky is never quite black, nor quite even
    col += vec3(0.0034, 0.0046, 0.0105) * (0.65 + 0.7 * cloudy(d * 1.7 + 21.0));
    gl_FragColor = vec4(max(col, 0.0), 1.0 - 0.6 * lanes);
  }`;
}
function sky() {
  // the circuit's own bearings: along the start straight, to its right, and up
  const g = (K.grid || [])[0], c = K.centre, yaw = g ? g[3] : Math.atan2(c[1][0] - c[0][0], c[1][2] - c[0][2]);
  const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
  const at = night.at = (az, alt) => {
    const a = az * Math.PI / 180, e = alt * Math.PI / 180;
    return new THREE.Vector3().addScaledVector(fwd, Math.cos(e) * Math.cos(a)).addScaledVector(right, Math.cos(e) * Math.sin(a)).setY(Math.sin(e));
  };
  const core = at(4, 19), galN = core.clone().cross(at(100, 50)).normalize();
  night.pole.copy(at(90, 25));
  night.clear = [1, 0.75, 0.3, 0.16, 0.08, 0.05][S.D.session.weather] ?? 1;        // cloud hides it: clear, light cloud, overcast, rain...

  // the glow, painted into a cube map a layer at a time: the Milky Way, then each cloud added where the dust lets it through
  const cube = night.cube = new THREE.WebGLCubeRenderTarget(quality > 1 ? 1024 : 512, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const grain = noiseVolume(), ball = new THREE.SphereGeometry(5, 48, 24), studio = new THREE.Scene();
  const layer = (fragmentShader, uniforms, more) => studio.add(new THREE.Mesh(ball, new THREE.ShaderMaterial({ side: THREE.BackSide, depthTest: false, depthWrite: false,
    vertexShader: "varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader, uniforms: { grain: { value: grain }, ...uniforms }, ...more }))).children.at(-1);
  layer(milkyWay(galN, core), {});
  const pale = c => { const grey = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]; return new THREE.Vector3(...c.map(v => grey + (v - grey) * 0.72)); };
  CLOUDS.forEach(([az, alt, wide, one, two, power], k) => {
    layer(GAS, { c: { value: at(az, alt) }, rad: { value: wide * Math.PI / 180 }, one: { value: pale(one) }, two: { value: pale(two) },
                 seed: { value: 3.7 + k * 11.3 }, power: { value: power * 0.085 } },
          { transparent: true, blending: THREE.CustomBlending, blendSrc: THREE.DstAlphaFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor }).renderOrder = k + 1;
  });
  new THREE.CubeCamera(0.1, 20, cube).update(renderer, studio);
  for (const m of studio.children) m.material.dispose();
  ball.dispose(); night.grain = grain;                              // the noise is kept: the other skies use it

  // the dome it is shown on: the painted sky, turned to the hour, behind the air's own glow low down
  const dome = night.dome = new THREE.Mesh(new THREE.SphereGeometry(5000, 48, 24), new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { sky: { value: cube.texture }, spin: { value: new THREE.Matrix3() }, gain: { value: 1 } },
    vertexShader: "varying vec3 p; void main(){ p = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform samplerCube sky; uniform mat3 spin; uniform float gain; varying vec3 p;
      void main() {
        vec3 d = normalize(p);
        float h = d.y, air = smoothstep(-0.01, 0.15, h);                   // the thick air near the ground dims what is behind it
        vec3 col = textureCube(sky, spin * d).rgb * gain * (0.12 + 0.88 * air);
        col += vec3(0.060, 0.050, 0.075) * exp(-max(h, 0.0) * 7.0);          // the circuit's and the city's light, hanging in that air
        col = mix(col, vec3(0.010, 0.010, 0.015), smoothstep(0.0, -0.05, h));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` }));
  dome.renderOrder = -3;

  // the stars
  const r = seeded(23), count = quality > 1 ? 20000 : 8000, place = [], star = [], tint = [];
  const COLOURS = [[0.12, [0.72, 0.82, 1.00]], [0.42, [1.00, 0.98, 0.96]], [0.72, [1.00, 0.93, 0.78]], [0.90, [1.00, 0.80, 0.58]], [1.01, [1.00, 0.66, 0.50]]];
  const across = galN.clone().cross(core);                    // with the core and the pole, the Milky Way's own bearings
  for (let made = 0; made < count;) {
    let x, y, z, crowd = made >= 22 && r() < 0.45;            // nearly half of them are the Milky Way's own faint crowd
    if (crowd) {
      const l = r() * TAU, b = 0.105 * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(r() * TAU), cb = Math.cos(b);      // anywhere along the band, close to its middle
      if (r() > 0.22 + 0.78 * (0.5 + 0.5 * Math.cos(l)) ** 2) continue;                                               // and mostly towards the core
      x = cb * (Math.cos(l) * core.x + Math.sin(l) * across.x) + Math.sin(b) * galN.x;
      y = cb * (Math.cos(l) * core.y + Math.sin(l) * across.y) + Math.sin(b) * galN.y;
      z = cb * (Math.cos(l) * core.z + Math.sin(l) * across.z) + Math.sin(b) * galN.z;
      if (y < -0.3) continue;
    } else {
      y = r() * 1.3 - 0.3;                                    // even over the sky, and a little below it: the sky turns
      const th = r() * TAU, q = Math.sqrt(1 - y * y);
      x = q * Math.cos(th); z = q * Math.sin(th);
      const lat = x * galN.x + y * galN.y + z * galN.z, toCore = (x * core.x + y * core.y + z * core.z) * 0.5 + 0.5;
      if (r() > 0.3 + 0.7 * Math.exp(-((lat / 0.2) ** 2)) * (0.4 + 0.6 * toCore)) continue;      // still a little thicker along the Milky Way
    }
    const top = made < 22, u = r();                           // twenty-two that stand out, with rays
    const bright = top ? 2.6 + 3.4 * r() : crowd ? 0.05 + 0.22 * u * u : 0.07 + 0.42 * u ** 3 + 2.5 * u ** 12;
    const size = top ? 7.5 + 4.5 * r() : crowd ? 1.3 + 0.7 * u : 1.4 + 1.5 * u ** 3 + 3.6 * u ** 10;
    place.push(4800 * x, 4800 * y, 4800 * z);
    star.push(size, bright, r() * TAU, 1.2 + 3.6 * r());
    const pick = r(), col = COLOURS.find(q => pick < q[0])[1], f = 0.92 + 0.16 * r();
    tint.push(col[0] * f, col[1] * f, col[2] * f);
    made++;
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute("position", new THREE.Float32BufferAttribute(place, 3));
  sg.setAttribute("star", new THREE.Float32BufferAttribute(star, 4));
  sg.setAttribute("tint", new THREE.Float32BufferAttribute(tint, 3));
  const stars = night.stars = new THREE.Points(sg, new THREE.ShaderMaterial({ transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    uniforms: { time: { value: 0 }, scale: { value: 1 }, gain: { value: 1 }, twinkle: { value: 1 } },
    vertexShader: `attribute vec4 star; attribute vec3 tint; uniform float time, scale, gain, twinkle; varying vec3 vCol; varying float vSize;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        float h = normalize(world.xyz).y, low = 1.0 - smoothstep(0.0, 0.6, h);      // the air again: it dims a star low down, and makes it dance
        float flick = sin(time * star.w + star.z) * sin(time * star.w * 0.37 + star.z * 2.3);
        vCol = tint * star.y * gain * smoothstep(0.012, 0.2, h) * (1.0 + twinkle * (0.08 + 0.30 * low) * flick);
        vSize = star.x;
        gl_PointSize = max(1.6, star.x * scale);
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `varying vec3 vCol; varying float vSize;
      void main() {
        vec2 q = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(q, q), big = smoothstep(3.0, 7.5, vSize);
        float a = exp(-r2 * mix(3.2, 26.0, big)) + big * 0.10 * exp(-r2 * 3.0);        // a point; a big one is a tight core in a soft glow...
        a += big * 0.34 * (exp(-abs(q.x) * 20.0 - abs(q.y) * 3.2) + exp(-abs(q.y) * 20.0 - abs(q.x) * 3.2));      // ...with four fine rays
        gl_FragColor = vec4(vCol * a * smoothstep(1.0, 0.7, sqrt(r2)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` }));
  stars.renderOrder = -2;
  dome.add(stars);

  // a shooting star now and then: one line, bright at the head, nothing at the tail
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  lg.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  const streak = night.streak = new THREE.Line(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }));
  streak.frustumCulled = false; streak.visible = false; streak.renderOrder = -2;
  dome.add(streak);

  // a city on the horizon: dark towers, lit windows
  const city = tex(2048, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    for (let x = 0; x < w;) {
      const bw = 10 + r() * 34, bh = 14 + r() * r() * 100;
      c.fillStyle = "#07080d"; c.fillRect(x, h - bh, bw, bh);
      for (let wy = h - bh + 3; wy < h - 3; wy += 4) for (let wx = x + 2; wx < x + bw - 2; wx += 3) if (r() < 0.2) { c.fillStyle = r() < 0.75 ? "rgba(255,214,140,0.9)" : "rgba(170,210,255,0.9)"; c.fillRect(wx, wy, 1.4, 1.6); }
      x += bw + r() * 12;
    }
  }, { aniso: 4 });
  city.repeat.set(3, 1);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(4200, 4200, 230, 64, 1, true), new THREE.MeshBasicMaterial({ map: city, transparent: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  band.position.y = 100; band.renderOrder = -1;                       // drawn after the stars, so a tower hides the ones behind it
  dome.add(V && V.skyline ? venueSkyline() : band);                   // (a circuit that has been looked up has its own horizon: what really stands there, where it really is)
  // the moon: a few days short of full, well clear of the Milky Way's core, with the glow it throws round itself
  night.far = new THREE.Group(); night.moon = new THREE.Group();
  night.moon.add(farPlace(haloDisc(1100, "#aab8ff", 0.42), -138, 40, 4640), farPlace(moonDisc(128, [0.72, 0.38, 0.58], 31, "#e9e6dc", 1.55), -138, 40));
  night.far.add(night.moon); dome.add(night.far);
  return dome;
}
const dice = x => { const v = Math.sin(x * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };      // the same throw for the same number, every time

// ---- the moon, and anything else too far off to slide across the sky as the camera moves
// A disc that is shaded as the ball it stands for: `sun` is where the light comes from, as the viewer sees it
// (x to the right, y up, z towards the viewer), so it can be full, gibbous or a thin crescent.
function moonDisc(radius, sun, seed = 31, tintHex = "#e9e6dc", glow = 2.3) {
  const face = tex(256, 256, (g, w, h) => {
    const r = seeded(seed), R = w / 2 - 2;
    g.clearRect(0, 0, w, h);
    g.save(); g.beginPath(); g.arc(w / 2, h / 2, R, 0, TAU); g.clip();
    g.fillStyle = tintHex; g.fillRect(0, 0, w, h);
    g.filter = "blur(7px)";                                        // the seas: wide, soft, darker
    for (let k = 0; k < 9; k++) {
      g.fillStyle = `rgba(70,68,64,${(0.25 + 0.3 * r()).toFixed(2)})`;
      g.beginPath(); g.ellipse((0.25 + 0.5 * r()) * w, (0.2 + 0.55 * r()) * h, (0.07 + 0.12 * r()) * w, (0.06 + 0.1 * r()) * h, r() * 3, 0, TAU); g.fill();
    }
    g.filter = "none";
    for (let k = 0; k < 110; k++) {                                // craters: a dark floor inside a pale rim
      const x = r() * w, y = r() * h, q = 1 + r() * r() * 7;
      g.fillStyle = "rgba(60,58,55,0.30)"; g.beginPath(); g.arc(x, y, q, 0, TAU); g.fill();
      g.strokeStyle = "rgba(255,253,246,0.45)"; g.lineWidth = 0.8; g.beginPath(); g.arc(x - 0.5, y - 0.5, q, 0, TAU); g.stroke();
    }
    const cx = 0.58 * w, cy = 0.74 * h;                            // one young crater, with rays
    g.strokeStyle = "rgba(255,253,246,0.22)"; g.lineWidth = 1.2;
    for (let k = 0; k < 14; k++) { const a = r() * TAU, len = (0.1 + 0.25 * r()) * w; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); g.stroke(); }
    g.fillStyle = "rgba(255,253,246,0.8)"; g.beginPath(); g.arc(cx, cy, 3, 0, TAU); g.fill();
    g.restore();
  }, { repeat: false });
  const disc = new THREE.Mesh(new THREE.PlaneGeometry(2 * radius, 2 * radius), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, fog: false,
    uniforms: { map: { value: face }, sun: { value: new THREE.Vector3(...sun).normalize() }, glow: { value: glow } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform sampler2D map; uniform vec3 sun; uniform float glow; varying vec2 vUv;
      void main() {
        vec2 q = vUv * 2.0 - 1.0;
        float r2 = dot(q, q);
        if (r2 > 1.0) discard;
        vec3 n = vec3(q, sqrt(1.0 - r2));                              // the ball it is, seen face on
        float d = dot(n, sun), lit = smoothstep(-0.04, 0.16, d);
        vec3 col = texture2D(map, vUv).rgb * (lit * glow * (0.5 + 0.5 * pow(max(d, 0.0), 0.6)) + 0.014);      // sunlit, and the faint glow of the rest
        gl_FragColor = vec4(col, smoothstep(1.0, 0.955, r2));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` }));
  disc.renderOrder = -1.5;                                           // over the stars, under the skyline
  return disc;
}
function haloDisc(radius, colour, power) {                           // the light a bright thing spreads in the air round it
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2 * radius, 2 * radius), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    uniforms: { colour: { value: new THREE.Color(colour) }, power: { value: power } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform vec3 colour; uniform float power; varying vec2 vUv;
      void main() {
        float r = length(vUv * 2.0 - 1.0);
        gl_FragColor = vec4(colour * power * exp(-r * 5.5) * smoothstep(1.0, 0.6, r), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` }));
  m.renderOrder = -1.6;
  return m;
}
function farPlace(thing, az, alt, dist = 4600) {                     // hang something in the sky that way, facing the viewer
  thing.position.copy(night.at(az, alt)).multiplyScalar(dist);
  thing.lookAt(0, 0, 0);
  return thing;
}

// ---- which sky
// The night sky is always there. Each of the others adds its own things to it (and turns the Milky Way down to
// suit); they are built the first time they are picked.
const SKIES = [["night", "Night sky"], ["fleet", "Star Destroyers vs MC75 cruisers"], ["borg", "Starfleet vs the Borg"], ["giant", "Ringed giant"]];
const SKY_BUILD = { giant: ringedGiant };                            // name -> a function giving { group, far, glow, step(t) }
const skySets = {};
let skyNow = "night";
function setSky(name) {
  skyNow = SKIES.some(q => q[0] === name) ? name : "night";
  document.dispatchEvent(new CustomEvent("stage3d-looks"));
}
function showSky() {
  if (skyNow !== "night" && !skySets[skyNow]) {
    const made = skySets[skyNow] = SKY_BUILD[skyNow]();
    (made.far ? night.far : night.dome).add(made.group);
  }
  for (const k in skySets) skySets[k].group.visible = k === skyNow;
  night.moon.visible = skyNow === "night";
  night.shown = skyNow;
}
function skyStep(t) {                 // each frame: the hour, the twinkle, whichever sky is up, and now and then a shooting star
  const dome = night.dome;
  if (!dome) return;
  if (night.shown !== skyNow) showSky();
  const set = skySets[skyNow];
  night.far.position.copy(camera.position);                          // the moon and its like keep their place in the sky wherever the camera goes
  night.q.setFromAxisAngle(night.pole, -t * 7.2921e-5 * SKY.spin);          // once round the pole in a day, as the real one goes
  night.stars.quaternion.copy(night.q);
  dome.material.uniforms.spin.value.setFromMatrix4(night.m4.makeRotationFromQuaternion(night.q).transpose());      // the other way: where to look in the painted sky
  dome.material.uniforms.gain.value = SKY.nebula * night.clear * (set ? set.glow : 1);
  const u = night.stars.material.uniforms;
  u.time.value = t; u.scale.value = renderer.domElement.height / 1080; u.gain.value = SKY.stars * night.clear; u.twinkle.value = SKY.twinkle;
  if (set && set.step) set.step(t);
  // At most one shooting star in each stretch of 26 seconds; when, where and which way come from that stretch's own
  // dice, so the same moment of a replay always has the same one (a video made twice comes out the same).
  const SPAN = 26, LIFE = 0.8, slot = Math.floor(t / SPAN), streak = night.streak;
  const age = t - (slot * SPAN + 2 + dice(slot + 0.31) * (SPAN - 4));
  streak.visible = skyNow === "night" && dice(slot) < SKY.meteors * night.clear && age >= 0 && age <= LIFE;
  if (!streak.visible) return;
  const az = dice(slot + 0.57) * TAU, alt = (30 + 40 * dice(slot + 0.83)) * Math.PI / 180, lean = (dice(slot + 0.11) - 0.5) * 1.7;
  const from = night.a.set(Math.cos(alt) * Math.cos(az), Math.sin(alt), Math.cos(alt) * Math.sin(az));
  const fall = night.b.set(Math.sin(alt) * Math.cos(az), -Math.cos(alt), Math.sin(alt) * Math.sin(az)).multiplyScalar(Math.cos(lean))      // down the sky from there...
    .addScaledVector(night.c.set(-Math.sin(az), 0, Math.cos(az)), Math.sin(lean));                                                          // ...leaning to one side
  const head = 0.42 * age, tail = Math.max(0, head - 0.11), k = 2.6 * Math.sin(Math.PI * age / LIFE) ** 0.7;
  const P = streak.geometry.attributes.position, C = streak.geometry.attributes.color;
  [tail, head].forEach((th, j) => P.setXYZ(j, 4700 * (from.x * Math.cos(th) + fall.x * Math.sin(th)), 4700 * (from.y * Math.cos(th) + fall.y * Math.sin(th)), 4700 * (from.z * Math.cos(th) + fall.z * Math.sin(th))));
  C.setXYZ(0, 0, 0, 0); C.setXYZ(1, 0.85 * k, k, 0.92 * k);
  P.needsUpdate = C.needsUpdate = true;
}

// ---- a ringed giant, hanging over the circuit with three of its moons
function ringedGiant() {
  const group = new THREE.Group(), R = 1500, sunW = night.at(-70, 38);                    // the light comes from high on the left
  const world = new THREE.Group();                                                        // the planet's own tilt: its rings lean towards us
  world.position.copy(night.at(34, 17)).multiplyScalar(4300);
  world.rotation.set(0.42, 0.3, -0.36, "ZXY");
  const sunO = sunW.clone().applyQuaternion(world.quaternion.clone().invert());           // the same light, in the planet's own bearings
  const ball = new THREE.Mesh(new THREE.SphereGeometry(R, 96, 48), new THREE.ShaderMaterial({ fog: false,
    uniforms: { grain: { value: night.grain }, sun: { value: sunO }, R: { value: R } },
    vertexShader: "varying vec3 vP; varying vec3 vV; void main(){ vP = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize((inverse(modelViewMatrix) * vec4(0.0, 0.0, 0.0, 1.0)).xyz - position); gl_Position = projectionMatrix * mv; }",
    fragmentShader: `uniform highp sampler3D grain; uniform vec3 sun; uniform float R; varying vec3 vP; varying vec3 vV;
      float ringAt(float r) {                                           // how much of the light the rings stop, by distance from the middle
        if (r < 1.28 || r > 2.32) return 0.0;
        float gap = smoothstep(1.90, 1.93, r) * smoothstep(1.99, 1.96, r);
        return (0.55 + 0.45 * sin(r * 60.0) * sin(r * 23.0)) * (1.0 - 0.9 * gap) * smoothstep(1.28, 1.36, r) * smoothstep(2.32, 2.22, r);
      }
      void main() {
        vec3 n = normalize(vP);
        vec4 turb = textureLod(grain, n * vec3(0.5, 2.6, 0.5) * 0.9, 0.0) + 0.5 * textureLod(grain, n * vec3(1.1, 6.0, 1.1) * 0.9 + 0.3, 0.0);
        float lat = n.y + 0.035 * turb.x;                               // bands round it, their edges pulled about by its weather
        float b = 0.5 + 0.5 * sin(lat * 23.0 + 1.2 * sin(lat * 7.0)) , b2 = 0.5 + 0.5 * sin(lat * 51.0 + 2.0);
        vec3 col = mix(vec3(0.80, 0.62, 0.42), vec3(0.95, 0.87, 0.70), b);
        col = mix(col, vec3(0.62, 0.38, 0.26), 0.35 * b2 * (0.5 + turb.y));
        col = mix(col, vec3(0.74, 0.78, 0.84), smoothstep(0.62, 0.95, abs(n.y)));      // its poles, paler and bluer
        col *= 0.85 + 0.3 * turb.z;
        float d = dot(n, sun), lit = smoothstep(-0.10, 0.30, d);
        // the rings' shadow across it: follow the light back from this point to the rings' plane
        float shade = 1.0;
        if (sun.y * vP.y < 0.0) { vec3 hit = vP - sun * (vP.y / sun.y); shade = 1.0 - 0.8 * ringAt(length(hit.xz) / R); }
        float rim = pow(1.0 - max(dot(n, normalize(vV)), 0.0), 3.0);
        vec3 outc = col * (lit * shade * (0.25 + 0.75 * max(d, 0.0)) * 0.95 + 0.004) + vec3(0.45, 0.62, 1.0) * rim * lit * 0.22;
        gl_FragColor = vec4(outc, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` }));
  const rings = new THREE.Mesh(new THREE.RingGeometry(1.28 * R, 2.32 * R, 160, 1).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({ fog: false, transparent: true, depthWrite: false, side: both,
    uniforms: { sun: { value: sunO }, R: { value: R } },
    vertexShader: "varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform vec3 sun; uniform float R; varying vec3 vP;
      void main() {
        float r = length(vP.xz) / R;
        float gap = smoothstep(1.90, 1.93, r) * smoothstep(1.99, 1.96, r);
        float dens = (0.55 + 0.45 * sin(r * 60.0) * sin(r * 23.0)) * (1.0 - 0.92 * gap) * smoothstep(1.28, 1.36, r) * smoothstep(2.32, 2.22, r);
        float b = dot(vP, sun), shadow = (b < 0.0 && dot(vP, vP) - b * b < R * R) ? 0.06 : 1.0;      // the planet's own shadow lies across them
        vec3 col = mix(vec3(0.78, 0.66, 0.50), vec3(0.97, 0.92, 0.80), 0.5 + 0.5 * sin(r * 37.0)) * (0.35 + 0.65 * abs(sun.y)) * 1.15 * shadow;
        gl_FragColor = vec4(col, dens * 0.92);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` }));
  ball.renderOrder = -1.5; rings.renderOrder = -1.4;
  world.add(ball, rings);
  group.add(world);
  const sunSeen = [-0.75, 0.45, 0.35];                                // the same light, as it falls on the moons' faces
  group.add(farPlace(moonDisc(105, sunSeen, 44, "#d8cfc0", 2.0), -18, 46));
  group.add(farPlace(moonDisc(60, sunSeen, 57, "#c9b9a6", 1.8), 82, 36));
  group.add(farPlace(moonDisc(38, sunSeen, 63, "#b9c3cf", 1.8), -62, 24));
  return { group, far: true, glow: 0.55 };
}

api.sky = SKY; api.skies = SKIES; api.setSky = setSky; api.debug.night = night;
Object.defineProperty(api, "skyName", { get: () => skyNow });

// Two more skies for the 3D view: fleets fighting over the circuit. Joined onto replay3d.js after replay3d_sky.js
// (see there); not a module on its own.
//
// The ships are made here from scratch, as plain shapes that read as what they are from the ground: nothing is
// copied in from anywhere. They hang over the circuit as real things a few kilometres off, so they slide past
// each other as the cars go round. What they fire is worked out from replay time alone, so a moment of a replay
// always shows the same shot (and a video made twice comes out the same).

// ---- hulls: plates, seams and lit ports, lit by one far-off sun
function hullMaterial(base, glow, o = {}) {
  return new THREE.ShaderMaterial({ fog: false, side: both,
    uniforms: { base: { value: new THREE.Vector3(...base) }, glow: { value: new THREE.Vector3(...glow) }, sun: { value: night.at(-70, 38) },
                panel: { value: o.panel || 30 }, ports: { value: o.ports ?? 0.04 }, veins: { value: o.veins || 0 } },
    vertexShader: "varying vec3 vO; varying vec3 vW; void main(){ vO = position; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }",
    fragmentShader: `uniform vec3 base, glow, sun; uniform float panel, ports, veins; varying vec3 vO; varying vec3 vW;
      float h31(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float flat3(vec3 v, vec3 an, float other) { return max(max(mix(v.x, other, step(0.7, an.x)), mix(v.y, other, step(0.7, an.y))), mix(v.z, other, step(0.7, an.z))); }
      void main() {
        vec3 nW = normalize(cross(dFdx(vW), dFdy(vW))), an = abs(normalize(cross(dFdx(vO), dFdy(vO))));      // flat faces: a hull is plates
        float d = dot(nW, sun), light = 0.06 + 1.05 * smoothstep(-0.1, 0.85, d) + 0.05 * max(-nW.y, 0.0);  // the sun, a little from everywhere, the circuit's glow from below
        vec3 q = vO / panel, e = min(fract(q), 1.0 - fract(q));
        float far = clamp(1.0 - (length(fwidth(q)) - 0.12) / 0.3, 0.0, 1.0);                               // too small to see: leave the detail out, so it does not sparkle
        float seam = -flat3(-e, an, -1.0);                                                                 // how near the edge of its plate, along the face
        float line = mix(1.0, smoothstep(0.0, 0.045, seam), far);
        float plate = 0.74 + 0.26 * h31(floor(q) + 3.0 * floor(an + 0.5)) * far;
        vec3 col = base * plate * mix(0.5, 1.0, line) * light;
        vec3 w = vO / (panel * 0.2);
        float lit = step(1.0 - ports, h31(floor(w) + 11.0)) * step(flat3(abs(fract(w) - 0.5), an, 0.0), 0.27);
        col += glow * lit * 2.4 * clamp(1.0 - (length(fwidth(w)) - 0.5) / 0.6, 0.0, 1.0);
        col += glow * (1.0 - line) * veins * (0.4 + 0.8 * h31(floor(q) + 7.0));                            // light in the seams themselves
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` });
}
function solid(...geos) {               // several shapes as one, corners only: the hull's shader works its own faces out
  const bare = geos.flat().map(g => { const q = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(q.attributes)) if (k !== "position") q.deleteAttribute(k); return q; });
  return mergeGeometries(bare);
}
const tris = points => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(points.flat(), 3)); return g; };
const ball = (rx, ry, rz, x, y, z, seg = 14) => new THREE.SphereGeometry(1, seg, Math.max(6, seg >> 1)).scale(rx, ry, rz).translate(x, y, z);
const tube = (r0, r1, len, x, y, z, seg = 14) => new THREE.CylinderGeometry(r0, r1, len, seg).rotateX(Math.PI / 2).translate(x, y, z);      // along the ship: r0 at the bow end

// A dagger of a warship: a flat wedge, terraces rising towards the stern, a bridge on a neck across the top.
// One unit long, bow towards +z.
function destroyerShape() {
  const B = [0, 0, 0.5], L = [0.31, 0, -0.5], R = [-0.31, 0, -0.5], T = [0, 0.085, -0.5], D = [0, -0.07, -0.44], DS = [0, -0.035, -0.5];
  const wedge = tris([B, L, T, B, T, R, B, D, L, B, R, D, L, D, DS, R, DS, D, L, DS, T, R, T, DS]);
  const parts = [wedge, box(0.27, 0.03, 0.36, 0, 0.068, -0.29), box(0.19, 0.03, 0.26, 0, 0.096, -0.32), box(0.12, 0.028, 0.17, 0, 0.124, -0.355),
                 box(0.045, 0.07, 0.055, 0, 0.17, -0.405), box(0.21, 0.034, 0.05, 0, 0.215, -0.405), box(0.16, 0.014, 0.036, 0, 0.238, -0.405),
                 ball(0.017, 0.017, 0.017, 0.07, 0.253, -0.405, 10), ball(0.017, 0.017, 0.017, -0.07, 0.253, -0.405, 10),
                 box(0.05, 0.02, 0.12, 0.15, 0.03, -0.36), box(0.05, 0.02, 0.12, -0.15, 0.03, -0.36),
                 ball(0.06, 0.035, 0.06, 0, -0.05, -0.2, 14), box(0.09, 0.012, 0.13, 0, -0.045, 0.02)];      // and underneath: the reactor's dome, the hangar's mouth
  for (const [x, y, r] of [[0, 0.005, 0.045], [0.115, 0.004, 0.04], [-0.115, 0.004, 0.04], [0.2, 0.002, 0.018], [-0.2, 0.002, 0.018]]) parts.push(tube(r * 0.8, r, 0.05, x, y, -0.515));
  return { geo: solid(parts), engines: [[0, 0.005, -0.55, 0.11], [0.115, 0.004, -0.55, 0.1], [-0.115, 0.004, -0.55, 0.1], [0.2, 0.002, -0.55, 0.05], [-0.2, 0.002, -0.55, 0.05]],
           guns: () => [(Math.random() - 0.5) * 0.3, 0.05, -0.3 + Math.random() * 0.5] };
}
// A long rounded cruiser: a spindle of a hull, a blister on its back, a deep fin under it, pods along its sides.
function cruiserShape() {
  const profile = [[0, 0.5], [0.028, 0.485], [0.05, 0.44], [0.066, 0.34], [0.078, 0.12], [0.082, -0.15], [0.07, -0.36], [0.05, -0.47], [0.04, -0.5], [0, -0.5]];
  const hull = new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r, z)), 20).rotateX(Math.PI / 2).scale(1.15, 0.72, 1);
  const fin = tris([[0.006, -0.05, 0.02], [0.006, -0.05, -0.3], [0.006, -0.19, -0.2], [0.006, -0.05, 0.02], [0.006, -0.19, -0.2], [0.006, -0.17, -0.08],
                    [-0.006, -0.05, 0.02], [-0.006, -0.19, -0.2], [-0.006, -0.05, -0.3], [-0.006, -0.05, 0.02], [-0.006, -0.17, -0.08], [-0.006, -0.19, -0.2],
                    [0.006, -0.17, -0.08], [0.006, -0.19, -0.2], [-0.006, -0.19, -0.2], [0.006, -0.17, -0.08], [-0.006, -0.19, -0.2], [-0.006, -0.17, -0.08],
                    [0.006, -0.05, 0.02], [0.006, -0.17, -0.08], [-0.006, -0.17, -0.08], [0.006, -0.05, 0.02], [-0.006, -0.17, -0.08], [-0.006, -0.05, 0.02],
                    [0.006, -0.19, -0.2], [0.006, -0.05, -0.3], [-0.006, -0.05, -0.3], [0.006, -0.19, -0.2], [-0.006, -0.05, -0.3], [-0.006, -0.19, -0.2]]);
  const parts = [hull, fin, ball(0.04, 0.03, 0.13, 0, 0.055, -0.02), ball(0.022, 0.018, 0.05, 0, 0.07, 0.14), box(0.03, 0.012, 0.05, 0, 0.085, -0.03)];
  for (const s of [1, -1]) parts.push(ball(0.028, 0.022, 0.09, s * 0.092, -0.012, 0.1), ball(0.03, 0.024, 0.11, s * 0.096, -0.016, -0.18), ball(0.02, 0.016, 0.06, s * 0.085, 0.02, -0.34));
  const engines = [];
  for (let k = 0; k < 9; k++) { const a = k / 9 * TAU, r = k % 3 ? 0.03 : 0.012; engines.push([Math.cos(a) * r * 1.15, Math.sin(a) * r * 0.72, -0.52, k % 3 ? 0.045 : 0.06]); }
  return { geo: solid(parts), engines, guns: () => [(Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.06, -0.35 + Math.random() * 0.7] };
}
// An explorer: a wide saucer, a hull slung under and behind it, two long engines on swept pylons.
function saucerShape() {
  const disc = new THREE.SphereGeometry(1, 28, 10).scale(0.25, 0.034, 0.3).translate(0, 0.07, 0.2);
  const parts = [disc, ball(0.09, 0.022, 0.1, 0, 0.098, 0.2, 16), ball(0.022, 0.012, 0.022, 0, 0.122, 0.2, 10),
                 box(0.05, 0.085, 0.13, 0, 0.02, -0.02).rotateX(0.5).translate(0, 0.02, 0.03),
                 ball(0.058, 0.052, 0.2, 0, -0.045, -0.16, 16), tube(0.03, 0.045, 0.04, 0, -0.045, 0.045, 14)];
  for (const s of [1, -1]) {
    parts.push(box(0.014, 0.012, 0.19, 0, 0, 0).rotateX(-0.15).rotateZ(s * -0.55).translate(s * 0.09, 0.01, -0.24),
               tube(0.026, 0.024, 0.42, s * 0.17, 0.062, -0.29, 12), ball(0.026, 0.026, 0.03, s * 0.17, 0.062, -0.08, 10));
  }
  return { geo: solid(parts), engines: [[0.17, 0.062, -0.07, 0.07, "red"], [-0.17, 0.062, -0.07, 0.07, "red"], [0.17, 0.062, -0.5, 0.05], [-0.17, 0.062, -0.5, 0.05], [0, -0.045, 0.07, 0.08, "dish"]],
           guns: () => { const a = Math.random() * TAU; return [Math.cos(a) * 0.22, 0.09, 0.2 + Math.sin(a) * 0.27]; } };
}

// ---- lights that fly: shots, the flash where they land, engines, small craft. One set of points for a whole sky.
function flares(count) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute("tint", new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute("size", new THREE.Float32BufferAttribute(new Float32Array(count), 1));
  const pts = new THREE.Points(g, new THREE.ShaderMaterial({ transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, uniforms: { scale: { value: 1000 } },
    vertexShader: "attribute vec3 tint; attribute float size; uniform float scale; varying vec3 vC; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = clamp(size * scale / -mv.z, 0.0, 240.0); gl_Position = projectionMatrix * mv; vC = tint; }",
    fragmentShader: `varying vec3 vC;
      void main() {
        float r = length(gl_PointCoord * 2.0 - 1.0);
        gl_FragColor = vec4(vC * (exp(-r * r * 9.0) + 0.25 * exp(-r * 3.0)) * smoothstep(1.0, 0.75, r), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` }));
  pts.frustumCulled = false;
  const P = g.attributes.position, C = g.attributes.tint, Z = g.attributes.size;
  let n = 0;
  return { points: pts,
    begin() { n = 0; },
    put(p, colour, size, power = 1) { if (n >= count) return; P.setXYZ(n, p.x, p.y, p.z); C.setXYZ(n, colour[0] * power, colour[1] * power, colour[2] * power); Z.setX(n, size); n++; },
    end() { for (let k = n; k < count; k++) Z.setX(k, 0); P.needsUpdate = C.needsUpdate = Z.needsUpdate = true; pts.material.uniforms.scale.value = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360)); } };
}
function beams(count, colour) {         // straight bright bars: bolts in flight, or a beam held on its target
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(...colour), fog: false }), count);
  mesh.frustumCulled = false;
  const dummy = new THREE.Object3D();
  let n = 0;
  return { mesh,
    begin() { n = 0; },
    put(a, b, thick) { if (n >= count) return; dummy.position.copy(a).add(b).multiplyScalar(0.5); dummy.lookAt(b); dummy.scale.set(thick, thick, a.distanceTo(b)); dummy.updateMatrix(); mesh.setMatrixAt(n++, dummy.matrix); },
    end() { mesh.count = n; mesh.instanceMatrix.needsUpdate = true; } };
}
function circuitCentre() {              // the middle of the lap, on the ground
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y = 0;
  for (const p of K.centre) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); y += p[1] / K.centre.length; }
  return new THREE.Vector3((x0 + x1) / 2, y, (z0 + z1) / 2);
}
// Put a ship in the sky: where (degrees right of the start straight, degrees up, metres from the middle of the
// circuit), how long, and the point it is heading for. Gives back the ship with what the fighting needs.
function launch(group, shape, material, [az, alt, dist], length, towards, bank = 0, show = 0.5) {
  const ship = new THREE.Mesh(shape.geo, material), C = circuitCentre();
  ship.position.copy(night.at(az, alt)).multiplyScalar(dist).add(C);
  ship.scale.setScalar(length);
  ship.up.copy(C).sub(ship.position).normalize().multiplyScalar(show).setY(1 - show * 0.5);      // its back leans towards the circuit, so its upper works can be seen from below
  ship.lookAt(towards); ship.rotateZ(bank);
  ship.updateMatrixWorld(true);
  group.add(ship);
  const at = local => new THREE.Vector3(...local).applyMatrix4(ship.matrixWorld);
  return { ship, length, at, gun: () => at(shape.guns()), engines: shape.engines.map(([x, y, z, r, kind]) => ({ p: at([x, y, z]), r: r * length, kind })) };
}
const seededPoint = (r, ship) => { const save = Math.random; Math.random = r; const p = ship.gun(); Math.random = save; return p; };       // the same hardpoints every time

// ---- Star Destroyers against MC75 star cruisers
SKY_BUILD.fleet = () => {
  const group = new THREE.Group(), r = seeded(404), C = circuitCentre(), up = (az, alt, d) => night.at(az, alt).multiplyScalar(d).add(C);
  const grey = hullMaterial([0.60, 0.62, 0.66], [1.0, 0.92, 0.75], { panel: 0.034, ports: 0.03 }), tan = hullMaterial([0.56, 0.52, 0.47], [1.0, 0.82, 0.55], { panel: 0.028, ports: 0.05 });
  const wedge = destroyerShape(), whale = cruiserShape();
  const them = up(42, 26, 3300), us = up(-44, 24, 3300);
  const empire = [[[-46, 23, 3000], 1000, 0.1], [[-24, 35, 3800], 1000, -0.15], [[-66, 14, 3900], 1000, 0.2]].map(([where, len, bank]) => launch(group, wedge, grey, where, len, them, bank, 1.3));
  const rebels = [[[38, 20, 3000], 800, -0.12], [[60, 32, 3700], 800, 0.2], [[20, 38, 4000], 800, 0.05]].map(([where, len, bank]) => launch(group, whale, tan, where, len, us, bank));
  // and one of each further round, so there is a fight whichever way the cameras look
  empire.push(launch(group, wedge, grey, [172, 27, 3400], 1000, up(128, 22, 3300), -0.1, 1.3));
  rebels.push(launch(group, whale, tan, [128, 22, 3300], 800, up(172, 27, 3400), 0.15));
  const GREEN = [0.10, 2.5, 0.22], RED = [2.6, 0.10, 0.07];
  const shots = [];                     // each gun fires again and again: from, to, how long between shots, when in that it fires
  const duel = (from, to, colour, n) => { for (let k = 0; k < n; k++) shots.push({ a: seededPoint(r, from), b: seededPoint(r, to), every: 1.8 + r() * 3.4, phase: r(), colour }); };
  for (const [e, f] of [[0, 0], [0, 1], [1, 1], [1, 2], [2, 0], [3, 3]]) { duel(empire[e], rebels[f], GREEN, 7); duel(rebels[f], empire[e], RED, 6); }
  for (const q of shots) q.time = q.a.distanceTo(q.b) / 620;                 // metres a second: slow enough to follow
  const green = beams(60, GREEN), red = beams(60, RED), lights = flares(260);
  group.add(green.mesh, red.mesh, lights.points);
  // small craft, weaving through the gap between the lines
  const craft = Array.from({ length: 36 }, () => ({ c: up(-6 + r() * 12, 22 + r() * 12, 2800 + r() * 900), a: [r() * TAU, r() * TAU, r() * TAU], w: [0.11 + r() * 0.2, 0.09 + r() * 0.2, 0.13 + r() * 0.2], size: 500 + r() * 900, ours: r() < 0.5 }));
  const p = new THREE.Vector3(), q2 = new THREE.Vector3();
  return { group, glow: 0.5,
    step(t) {
      green.begin(); red.begin(); lights.begin();
      for (const s of shots) {
        const since = ((t / s.every + s.phase) % 1 + 1) % 1 * s.every, go = since / s.time;        // seconds since this gun last fired
        if (go < 1) {
          p.lerpVectors(s.a, s.b, go); q2.lerpVectors(s.a, s.b, Math.max(0, go - 95 / s.a.distanceTo(s.b)));
          (s.colour === GREEN ? green : red).put(q2, p, 5.5);
        } else if (since - s.time < 0.3) lights.put(s.b, [1.0, 0.8, 0.55], 150, 3.2 * (1 - (since - s.time) / 0.3));      // the hit
        if (since < 0.12) lights.put(s.a, s.colour, 70, 0.5);                                           // the flash at the gun
      }
      for (const fleet of [empire, rebels]) for (const ship of fleet) for (const e of ship.engines) lights.put(e.p, fleet === empire ? [0.5, 0.75, 1.0] : [1.0, 0.55, 0.42], e.r * 2.6, 1.5);
      for (const c of craft) {
        p.set(Math.sin(t * c.w[0] + c.a[0]), 0.45 * Math.sin(t * c.w[1] + c.a[1]), Math.cos(t * c.w[2] + c.a[2])).multiplyScalar(c.size).add(c.c);
        lights.put(p, c.ours ? [1.0, 0.6, 0.45] : [0.6, 0.85, 1.0], 22, 1.6);
      }
      green.end(); red.end(); lights.end();
    } };
};

// ---- a Starfleet squadron against a Borg cube
SKY_BUILD.borg = () => {
  const group = new THREE.Group(), r = seeded(1701), C = circuitCentre(), up = (az, alt, d) => night.at(az, alt).multiplyScalar(d).add(C);
  const SIDE = 860, home = up(8, 27, 3500);
  const cube = new THREE.Mesh(solid(new THREE.BoxGeometry(1, 1, 1, 1, 1, 1)), hullMaterial([0.075, 0.085, 0.08], [0.25, 1.0, 0.35], { panel: 0.052, ports: 0.10, veins: 0.5 }));
  cube.position.copy(home); cube.scale.setScalar(SIDE); cube.rotation.set(0.5, 0.6, 0.2);
  group.add(cube);
  const white = hullMaterial([0.74, 0.77, 0.83], [1.0, 0.95, 0.8], { panel: 0.03, ports: 0.07 }), explorer = saucerShape();
  const ships = [[-22, 17, 2600, 0.2], [40, 15, 2800, -0.25], [-13, 45, 3300, 0.1], [35, 42, 3200, -0.1], [-50, 31, 3500, 0.3], [62, 29, 3600, -0.2], [152, 30, 3600, 0.15]]
    .map(([az, alt, d, bank]) => launch(group, explorer, white, [az, alt, d], 520, home, bank));
  const ORANGE = [2.8, 0.85, 0.10], GREENB = [0.12, 2.6, 0.3];
  const onCube = towards => {            // a point on the cube's skin, on the side facing a ship
    const d = towards.clone().sub(home).normalize().multiplyScalar(SIDE * 0.42);
    return home.clone().add(d).add(new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(SIDE * 0.5));
  };
  const phasers = ships.map(s => ({ a: s.at([0, 0.06, 0.48]), b: onCube(s.ship.position), every: 4.5 + r() * 4, phase: r(), hold: 1.1 + r() * 0.8 }));
  const cutters = [0, 1, 3, 4].map(k => ({ a: onCube(ships[k].ship.position), b: ships[k].at([0, 0.05, 0.1]), every: 6 + r() * 5, phase: r(), hold: 0.9 + r() * 0.7 }));
  const torpedoes = [];
  for (const s of ships) for (let k = 0; k < 3; k++) torpedoes.push({ a: s.at([0, -0.02, 0.2]), b: onCube(s.ship.position), every: 3 + r() * 5, phase: r(), colour: k ? [3.6, 0.9, 0.3] : [0.7, 1.4, 4.0] });
  for (const k of [0, 2, 5]) torpedoes.push({ a: onCube(ships[k].ship.position), b: ships[k].at([0, 0.06, 0.25]), every: 5 + r() * 4, phase: r(), colour: [0.4, 3.4, 0.7] });
  for (const q of torpedoes) q.time = q.a.distanceTo(q.b) / 430;
  const orange = beams(12, ORANGE), green = beams(8, GREENB), lights = flares(160);
  group.add(orange.mesh, green.mesh, lights.points);
  const p = new THREE.Vector3(), spin = new THREE.Vector3(0.3, 1, 0.2).normalize();
  return { group, glow: 0.5,
    step(t) {
      cube.quaternion.setFromAxisAngle(spin, 0.6 + t * 0.012);                 // it turns, slowly, as they do
      orange.begin(); green.begin(); lights.begin();
      for (const [list, bar, colour] of [[phasers, orange, ORANGE], [cutters, green, GREENB]]) for (const s of list) {
        const since = ((t / s.every + s.phase) % 1 + 1) % 1 * s.every;
        if (since > s.hold) continue;
        const flicker = 0.75 + 0.25 * Math.sin(t * 61 + s.phase * 40);
        bar.put(s.a, s.b, 4.5 * flicker);
        lights.put(s.b, colour, 170, 0.9 * flicker); lights.put(s.a, colour, 60, 0.5);
      }
      for (const s of torpedoes) {
        const since = ((t / s.every + s.phase) % 1 + 1) % 1 * s.every, go = since / s.time;
        if (go < 1) lights.put(p.lerpVectors(s.a, s.b, go), s.colour, 42, 1.4);
        else if (since - s.time < 0.35) lights.put(s.b, [1.0, 0.85, 0.6], 190, 3.0 * (1 - (since - s.time) / 0.35));
      }
      for (const s of ships) for (const e of s.engines) lights.put(e.p, e.kind === "red" ? [1.0, 0.25, 0.15] : e.kind === "dish" ? [0.5, 0.75, 1.0] : [0.45, 0.6, 1.0], e.r * 2.2, e.kind ? 1.6 : 1.2);
      orange.end(); green.end(); lights.end();
    } };
};

// What the cars are: part of the 3D view. Joined onto replay3d.js after the sky files (see replay3d_sky.js); not
// a module on its own. This file is the workshop: the tools the vehicles are made with, and the fitting of them
// to the field. The vehicles themselves are in replay3d_models.js.
//
// The race is the race whatever is drawn: every vehicle stands where the telemetry put a car, on the same
// wheels-on-the-ground and springs as the F1 cars, wearing its team's colours. Each is made from scratch (nothing
// is copied in from anywhere), once, and shared by the whole field; only the paint is each car's own.

const GARAGE = [["f1", "F1 cars"], ["wiener", "Wienermobiles"], ["brick", "LEGO F1 cars"], ["delorean", "DeLorean time machines"],
                ["warthog", "Warthogs"], ["chariot", "Roman chariots"], ["duck", "Rubber ducks"], ["saucer", "Flying saucers"]];
let rideNow = "f1", rideShown = "f1", kitShown = null;
function setCars(name) {
  rideNow = GARAGE.some(q => q[0] === name) && (name === "f1" || MAKE[name]) ? name : "f1";      // a vehicle that is not there is an F1 car
  ridePending(rideNow);                  // (its models are sent for now, not at the next frame)
  document.dispatchEvent(new CustomEvent("stage3d-looks"));
}

// ---- shapes
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const cylX = (r, len, x, y, z, seg = 18) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(Math.PI / 2).translate(x, y, z);      // across the car
const cylY = (r0, r1, h, x, y, z, seg = 16) => new THREE.CylinderGeometry(r0, r1, h, seg).translate(x, y, z);                       // upright: r0 at the top
const cylZ = (r0, r1, len, x, y, z, seg = 16) => new THREE.CylinderGeometry(r0, r1, len, seg).rotateX(Math.PI / 2).translate(x, y, z);      // along the car: r0 at the front
const rbox = (w, h, l, r, x, y, z, seg = 2) => new RoundedBoxGeometry(w, h, l, seg, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, l / 2 - 1e-4)).translate(x, y, z);      // a box with its edges eased
const spun = (profile, seg = 28) => new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4), y)), seg);      // a shape turned on a lathe, upright
function rod(a, b, r, seg = 8, r2 = r) {    // a round bar from one point to another (r at the first end, r2 at the second)
  const A = V3(...a), B = V3(...b), g = new THREE.CylinderGeometry(r2, r, A.distanceTo(B), seg);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), B.clone().sub(A).normalize()));
  return g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
}
function slab(profile, width, x = 0) {   // a side view (pairs of z, y, going round it) pushed out sideways to a width
  return new THREE.ExtrudeGeometry(new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(z, y))), { depth: width, bevelEnabled: false }).rotateY(-Math.PI / 2).translate(x + width / 2, 0, 0);
}
/* A body stretched over stations along the car, front to back or back to front. Each station is
     [z, y, half width, up, down, squareness above, squareness below, x]
   where y is the height of its widest line, up and down how far it reaches above and below that, and squareness
   2 for an ellipse, more for squarer shoulders (the top and the underside may differ: a flat floor under a
   round roof). `arc` keeps only part of the way round, as fractions of a turn starting at the keel and going up
   the right side (0.25 is the right flank, 0.5 the roof): a windscreen, a roof skin, a saddle cloth. `lift`
   stands it off the body it lies on. */
function loft(stations, o = {}) {
  const M = o.around || 28, N = stations.length, part = o.arc, lift = o.lift || 0;
  const cols = part ? Math.max(2, Math.round(M * (part[1] - part[0]))) + 1 : M, pos = [], uv = [], idx = [];
  stations.forEach(([z, y, w, up, down, sqU = 2.4, sqD = sqU, cx = 0], i) => {
    for (let j = 0; j < cols; j++) {
      const a = (part ? part[0] + (part[1] - part[0]) * j / (cols - 1) : j / M) * TAU - Math.PI / 2, c = Math.cos(a), s = Math.sin(a), e = 2 / (s >= 0 ? sqU : sqD);
      const px = (w + lift) * Math.sign(c) * Math.abs(c) ** e, py = ((s >= 0 ? up : down) + lift) * Math.sign(s) * Math.abs(s) ** e;
      pos.push(cx + px, y + py, z); uv.push(i / (N - 1), j / (cols - 1));
    }
  });
  for (let i = 0; i < N - 1; i++) for (let j = 0; j < (part ? cols - 1 : cols); j++) {
    const a = i * cols + j, b = i * cols + (j + 1) % cols, c = a + cols, d = b + cols;
    idx.push(a, b, d, a, d, c);
  }
  if (!part && o.caps !== false) for (const i of [0, N - 1]) {           // closed at both ends
    const [z, y, , up, down, , , cx = 0] = stations[i], mid = pos.length / 3;
    pos.push(cx, y + (up - down) / 2, z); uv.push(i ? 1 : 0, 0.5);
    for (let j = 0; j < cols; j++) idx.push(mid, i * cols + j, i * cols + (j + 1) % cols);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/* A limb along a path that may go anywhere: each point is [x, y, z, half width, half depth]. The rings stand
   square to the path; width is sideways (across the car, unless the limb itself runs across it). */
function sweep(path, o = {}) {
  const M = o.around || 12, e = 2 / (o.square || 2), N = path.length, pos = [], uv = [], idx = [], P = path.map(q => V3(q[0], q[1], q[2]));
  const t = V3(), side = V3(), up = V3();
  for (let i = 0; i < N; i++) {
    t.copy(P[Math.min(N - 1, i + 1)]).sub(P[Math.max(0, i - 1)]).normalize();
    side.set(1, 0, 0); if (Math.abs(t.x) > 0.85) side.set(0, 0, 1);
    up.crossVectors(t, side).normalize(); side.crossVectors(up, t).normalize();
    for (let j = 0; j < M; j++) {
      const a = j / M * TAU, c = Math.cos(a), s = Math.sin(a), px = path[i][3] * Math.sign(c) * Math.abs(c) ** e, py = (path[i][4] ?? path[i][3]) * Math.sign(s) * Math.abs(s) ** e;
      pos.push(P[i].x + side.x * px + up.x * py, P[i].y + side.y * px + up.y * py, P[i].z + side.z * px + up.z * py); uv.push(i / (N - 1), j / M);
    }
  }
  for (let i = 0; i < N - 1; i++) for (let j = 0; j < M; j++) { const a = i * M + j, b = i * M + (j + 1) % M; idx.push(a, b, b + M, a, b + M, a + M); }
  for (const i of [0, N - 1]) { const mid = pos.length / 3; pos.push(P[i].x, P[i].y, P[i].z); uv.push(i ? 1 : 0, 0.5); for (let j = 0; j < M; j++) idx.push(mid, i * M + j, i * M + (j + 1) % M); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function mergeable(g, colour) {         // fit to be joined to others: every corner its own, with a normal, a uv, and a colour if it is given one
  const q = g.index ? g.toNonIndexed() : g;
  if (!q.attributes.normal) q.computeVertexNormals();
  const n = q.attributes.position.count;
  if (!q.attributes.uv) q.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  for (const k of Object.keys(q.attributes)) if (!["position", "normal", "uv"].includes(k)) q.deleteAttribute(k);
  if (colour !== undefined) {              // one colour all over, or a rule giving the colour at each place
    const a = new Float32Array(n * 3), P = q.attributes.position;
    if (typeof colour === "function") for (let i = 0; i < n; i++) a.set(colour(P.getX(i), P.getY(i), P.getZ(i)), i * 3);
    else { const c = Array.isArray(colour) ? colour : rgb(colour); for (let i = 0; i < n; i++) a.set(c, i * 3); }
    q.setAttribute("color", new THREE.Float32BufferAttribute(a, 3));
  }
  return q;
}
const rgb = hex => new THREE.Color(hex).toArray();
function fade(from, to, how) {          // one colour running into another: how(x, y, z) says how far along, 0 to 1
  const A = rgb(from), B = rgb(to);
  return (x, y, z) => { const f = clamp(how(x, y, z), 0, 1); return [lerp(A[0], B[0], f), lerp(A[1], B[1], f), lerp(A[2], B[2], f)]; };
}
/* A vehicle is a few lumps, one for each kind of surface. "paint" and "second" take the team's two colours;
   "coat" and "aura" a colour the vehicle chooses for each car (coat is tinted corner by corner too, so a hoof
   can be darker than the leg); the rest are shared by everyone and carry their colours corner by corner:
   matte, satin, gloss, metal, chrome, steel (brushed), rubber, glow (lamps: brighter than white is allowed),
   and glass, tint and clear, which have no colours of their own. */
const UNTINTED = ["paint", "second", "aura", "beam", "glass", "tint", "clear"];
class Kit {
  constructor() { this.lumps = {}; }
  add(slot, g, colour) { (this.lumps[slot] = this.lumps[slot] || []).push(mergeable(g, UNTINTED.includes(slot) ? undefined : colour ?? 0xffffff)); return this; }
  both(slot, make, colour) { for (const s of [1, -1]) this.add(slot, make(s), colour); return this; }      // the same thing on the left and on the right
  join() { const out = {}; for (const k in this.lumps) out[k] = mergeGeometries(this.lumps[k]); return out; }
}
const SHADE = {};
let brushTex = null;
function brushed() {                    // fine streaks running the length of a body, for brushed steel (the lofts' u runs along them)
  if (brushTex) return brushTex;
  brushTex = tex(64, 512, (g, w, h) => {
    const r = seeded(31);
    for (let y = 0; y < h; y++) { const v = Math.round(206 + r() * 49); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, y, w, 1); }
  });
  brushTex.repeat.set(1, 2);
  return brushTex;
}
function shade(kind) {
  if (!SHADE.matte) Object.assign(SHADE, {
    matte: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.02, side: both }),
    satin: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.1, side: both }),
    gloss: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.2, clearcoat: 0.9, clearcoatRoughness: 0.12, side: both }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.34, metalness: 0.95, envMapIntensity: 1.2, side: both }),
    chrome: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.07, metalness: 1, envMapIntensity: 1.7, side: both }),
    steel: new THREE.MeshStandardMaterial({ vertexColors: true, map: brushed(), roughness: 0.5, metalness: 0.92, envMapIntensity: 1.0, side: both }),
    rubber: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, envMapIntensity: 0.35, side: both }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true, side: both }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x070b10, roughness: 0.05, metalness: 0.55, envMapIntensity: 1.9, clearcoat: 1, side: both }),
    tint: new THREE.MeshPhysicalMaterial({ color: 0x8fb0a4, roughness: 0.05, metalness: 0.2, envMapIntensity: 1.6, transparent: true, opacity: 0.32, depthWrite: false, side: both }),
    clear: new THREE.MeshPhysicalMaterial({ color: 0xa8dcff, roughness: 0.04, envMapIntensity: 1.8, transparent: true, opacity: 0.26, depthWrite: false }),
  });
  return SHADE[kind];
}

// ---- wheels: a tyre with rounded shoulders on a rim. The outer face is at +x; the same wheel is turned round for the other side.
function tyre(r, w, rim, tread = 0) {
  const h = w / 2, wall = r - rim;
  const k = new Kit().add("rubber", spun([[rim, -h + 0.012], [rim + wall * 0.25, -h], [r - wall * 0.3, -h], [r - wall * 0.07, -h + w * 0.1], [r, -h + w * 0.22], [r, h - w * 0.22],
                                         [r - wall * 0.07, h - w * 0.1], [r - wall * 0.3, h], [rim + wall * 0.25, h], [rim, h - 0.012]], 32).rotateZ(Math.PI / 2), 0x0d0d0e);
  for (let a = 0; a < tread; a++) k.add("rubber", rbox(w * 0.56, r * 0.1, r * 0.2, 0.012, (a % 2 ? 1 : -1) * w * 0.2, r * 0.985, 0, 1).rotateX(a / tread * TAU), 0x0d0d0e);      // blocks standing off it, for mud
  return k.join().rubber;
}
function rimOf(style, rim, w, o = {}) {  // the wheel inside the tyre, as lumps
  const k = new Kit(), face = w / 2 - 0.02, main = o.colour ?? 0xb9bdc3, slot = o.slot || "metal";
  k.add(slot, new THREE.CylinderGeometry(rim, rim, w - 0.03, 28, 1, true).rotateZ(Math.PI / 2), 0x1b1c1f);                         // the barrel
  k.add(slot, new THREE.TorusGeometry(rim - 0.008, 0.012, 6, 28).rotateY(Math.PI / 2).translate(face + 0.006, 0, 0), main);       // the lip
  k.add(slot, cylX(rim * 0.74, 0.012, face - 0.07, 0, 0, 24), 0x3a3c40);                                                          // the brake disc, behind
  if (style === "cap") {                  // a pressed steel wheel under a polished dome
    k.add(slot, cylX(rim * 0.97, 0.02, face - 0.02, 0, 0, 24), main);
    k.add("chrome", new THREE.SphereGeometry(rim * 0.86, 22, 8, 0, TAU, 0, Math.PI / 2).rotateZ(-Math.PI / 2).scale(0.3, 1, 1).translate(face - 0.01, 0, 0), 0xf2f2f2);
  } else if (style === "turbine") {       // many thin vanes, each leaning
    k.add(slot, cylX(rim * 0.99, 0.014, face - 0.03, 0, 0, 28), 0x55585d).add(slot, cylX(rim * 0.3, 0.05, face - 0.005, 0, 0, 16), main);
    for (let a = 0; a < 16; a++) k.add(slot, box(0.022, rim * 0.66, rim * 0.085, 0, 0, 0).rotateY(0.5).translate(face - 0.012, rim * 0.62, 0).rotateX(a / 16 * TAU), main);
  } else if (style === "dish") {          // a deep dish with a ring of bolts
    k.add(slot, spun([[rim * 0.98, face], [rim * 0.8, face - 0.02], [rim * 0.42, face - 0.1], [0.001, face - 0.1]], 24).rotateZ(-Math.PI / 2), main);
    for (let a = 0; a < 6; a++) k.add("metal", cylX(0.016, 0.03, face - 0.085, rim * 0.3 * Math.cos(a / 6 * TAU), rim * 0.3 * Math.sin(a / 6 * TAU), 6), 0x9a9da2);
  } else if (style === "toy") {           // a plain moulded disc with holes
    k.add(slot, cylX(rim * 0.98, 0.03, face - 0.01, 0, 0, 24), main).add(slot, cylX(rim * 0.26, 0.05, face, 0, 0, 12), main);
    for (let a = 0; a < 6; a++) k.add("matte", cylX(rim * 0.12, 0.034, face - 0.008, rim * 0.6 * Math.cos(a / 6 * TAU), rim * 0.6 * Math.sin(a / 6 * TAU), 10), 0x15161a);
  } else {                                // o.spokes spokes
    const n = o.spokes || 5;
    k.add(slot, cylX(rim * 0.24, 0.06, face - 0.005, 0, 0, 16), main);
    for (let a = 0; a < n; a++) k.add(slot, rbox(0.03, rim * 0.8, rim * 0.2, 0.01, face - 0.015, rim * 0.55, 0, 1).rotateX(a / n * TAU), main);
  }
  return k.join();
}
const wheelKind = (r, w, rimR, style, o = {}) => ({ r, w, tyre: tyre(r, w, rimR, o.tread || 0), rim: rimOf(style, rimR, w, o) });

// ---- putting the field into them
const MAKE = {};                       // name -> a function giving the vehicle (replay3d_models.js fills this)
const POD_F1 = POD.at.clone();

/* SCULPTS. A body with real shape to it (a horse, a man in armour, a car's bodywork) is not typed in here: it is
   sculpted (rides\things.py says how), cut down and kept as a file beside the player, and fetched when a vehicle
   that has one is picked. Until its files have come, and wherever they cannot be had, the shapes above stand in.
   A sculpt is painted once; where its mask says so (red, green, blue) each car paints its own colours through. */
const SCULPTS = {};                     // name -> { state: "loading" | "ready" | "none", parts: [{ name, geometry, material, painted }], mask, adopted, credit }
let sculptLoader = null;
/* ADOPTED. A thing everyone knows the exact look of (a film's car) is not sculpted from a picture: a model somebody
   made properly is downloaded by Eric and cut down for here (rides\adopt.py), with its maker's name and licence
   written into the file. It is kept in rides\local, which goes wherever the player goes (rides/local beside it: Eric,
   13 Oct 2026, of what had until then stayed on his PC, "add everything"), it is looked for first, and the sculpt is
   what is drawn wherever it is not there: a site that has left a model out answers "not here" and gets the sculpt.
   Its parts are told apart by their names: body_, glass_, wheel_FL .. wheel_RR, calliper_FL .., glow_ (lit by the
   kit), lamp_ (always lit), over_ (laid over another part). */
function sculpt(name, masked, adoptedOnly) {      // adoptedOnly: an adopted model with no sculpt of ours behind it, so where it is not there, there is nothing
  if (SCULPTS[name]) return SCULPTS[name];
  const rec = SCULPTS[name] = { state: "loading", parts: [], mask: null, adopted: false, credit: null }, at = S.ridesAt;
  if (!at) { rec.state = "none"; return rec; }
  if (!sculptLoader) {
    const draco = new DRACOLoader();
    draco.setDecoderPath("https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/");
    sculptLoader = new GLTFLoader(); sculptLoader.setDRACOLoader(draco);
  }
  const take = gltf => {
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse(o => {
      if (!o.isMesh) return;
      if (o.material.map) o.material.map.anisotropy = 8;
      rec.parts.push({ name: o.name, geometry: o.geometry.clone().applyMatrix4(o.matrixWorld), material: o.material, painted: !!o.material.map });
    });
  };
  const ours = () => adoptedOnly ? void (rec.state = "none") : glbLoad(at + name + ".glb", gltf => {
    take(gltf);
    if (!masked) { rec.state = "ready"; return; }
    new THREE.TextureLoader().load(at + name + "_mask.png", t => { t.flipY = false; t.colorSpace = THREE.NoColorSpace; rec.mask = t; rec.state = "ready"; }, undefined, () => { rec.state = "ready"; });
  }, () => { rec.state = "none"; });
  glbLoad(at + "local/" + name + ".glb", gltf => {
    take(gltf);
    rec.adopted = true; rec.credit = (gltf.asset && gltf.asset.extras) || null; rec.state = "ready";
  }, ours);
  return rec;
}
// A model asked for, and asked for again if nobody answered. A page opening asks for seventy of them at once, and
// until 13 Oct 2026 Pit Wall kept only five callers waiting: now and then one was turned away, and that load of the
// page had cars with no driver in them, or a stand with a piece missing, or no team's stickers. An answer of "it is
// not here" is an answer, and is not asked about again: that is how a model that has not been adopted is found out.
function glbLoad(url, got, failed, tries = 3) {
  sculptLoader.load(url, got, undefined, e => {
    if (tries > 1 && !(e && e.response)) setTimeout(() => glbLoad(url, got, failed, tries - 1), 400);
    else failed(e);
  });
}
// The line a wheel turns about: the line its tyre's walls are square to. Looked at along that line, the outermost
// point of a wall is as far out all the way round; looked at along any other, the wall goes in and out once round
// (which is the wobble: Eric, of the F1 car's wheels, "a slight side to side off center wobble, it looks good form
// the side but not from the front or back"). So: starting from the car's own cross-line, the outermost point of
// each wall is found in every ten degrees round the wheel, the once-round part of how far out they are says how
// the wall leans, and the line is put square to it; twice, which is plenty. Lettering on a tyre's wall and uneven
// numbers of points do not fool this. (Two things that were tried first did: the direction the points are spread
// least along left an F1 tyre 0.6 degrees off; and the direction square to every normal's turning moment, which is
// exact for a shape turned on a lathe, was 2 degrees off on a tyre with blocks, whose sides face round the wheel.)
function axleOf(geometries, middle) {
  const pts = [];
  for (const g of geometries) { const P = g.attributes.position; for (let i = 0; i < P.count; i++) pts.push(P.getX(i) - middle.x, P.getY(i) - middle.y, P.getZ(i) - middle.z); }
  const axle = V3(1, 0, 0), e1 = V3(), e2 = V3(), BINS = 36;
  for (let round = 0; round < 2; round++) {
    e1.set(0, 1, 0).addScaledVector(axle, -axle.y).normalize(); e2.crossVectors(axle, e1);
    let far = 0;
    for (let i = 0; i < pts.length; i += 3) far = Math.max(far, Math.hypot(pts[i] * e1.x + pts[i + 1] * e1.y + pts[i + 2] * e1.z, pts[i] * e2.x + pts[i + 1] * e2.y + pts[i + 2] * e2.z));
    const out = new Array(BINS).fill(null), inn = new Array(BINS).fill(null);
    for (let i = 0; i < pts.length; i += 3) {
      const x = pts[i], y = pts[i + 1], z = pts[i + 2], u = x * e1.x + y * e1.y + z * e1.z, v = x * e2.x + y * e2.y + z * e2.z, rad = Math.hypot(u, v);
      if (rad < 0.6 * far) continue;                     // (the tyre: a hub cap may stand out further than it, in the middle)
      const along = x * axle.x + y * axle.y + z * axle.z, phi = Math.atan2(v, u), k = Math.min(BINS - 1, Math.floor((phi + Math.PI) / (2 * Math.PI) * BINS));
      if (!out[k] || along > out[k][0]) out[k] = [along, rad, phi];
      if (!inn[k] || along < inn[k][0]) inn[k] = [along, rad, phi];
    }
    let s1 = 0, s2 = 0, walls = 0;
    for (const wall of [out, inn]) {
      const got = wall.filter(Boolean);
      if (got.length < 8) continue;
      let cc = 0, ss = 0, cs = 0, xc = 0, xs = 0, rr = 0;
      const mean = got.reduce((t, q) => t + q[0], 0) / got.length;
      for (const [along, rad, phi] of got) { const c = Math.cos(phi), sn = Math.sin(phi); cc += c * c; ss += sn * sn; cs += c * sn; xc += (along - mean) * c; xs += (along - mean) * sn; rr += rad; }
      const det = cc * ss - cs * cs;
      if (Math.abs(det) < 1e-9) continue;
      s1 += (xc * ss - xs * cs) / det / (rr / got.length); s2 += (xs * cc - xc * cs) / det / (rr / got.length); walls++;
    }
    if (!walls) break;
    axle.addScaledVector(e1, -s1 / walls).addScaledVector(e2, -s2 / walls).normalize();
  }
  return axle.x < 0 ? axle.negate() : axle;
}
// An adopted model's parts by what they are, its wheels (and the brakes behind them) moved to stand about their own
// middles so that they can be turned: { body, glass, over, glow, lamp, paint, sign, light, wheels: { FL: { at, r, w, own, fixed } .. } }.
function adoptedParts(rec) {
  if (rec.sorted) return rec.sorted;
  const by = { body: [], glass: [], over: [], glow: [], lamp: [], paint: [], sign: [], light: [], wheels: {} }, brakes = {}, round = {};
  for (const p of rec.parts) {
    const [kind, which] = p.name.split("_");
    if (kind === "wheel") (round[which] = round[which] || []).push(p);
    else if (kind === "calliper") brakes[which] = p;
    else if (kind === "glow") {            // a tube's glow lies on the tube, and the tube wears a woven sleeve a few millimetres out: so the glow is
      const g = p.geometry.clone(), P = g.attributes.position, N = g.attributes.normal;      // swollen to lie outside the sleeve, which then shows as weave with light on it
      for (let i = 0; i < P.count; i++) P.setXYZ(i, P.getX(i) + N.getX(i) * 0.009, P.getY(i) + N.getY(i) * 0.009, P.getZ(i) + N.getZ(i) * 0.009);
      by.glow.push({ ...p, geometry: g });
    } else (by[kind] = by[kind] || []).push(p);      // (any other kind is kept under its own name: a figure's "driver" and "gunner")
  }
  for (const which in round) {           // a wheel may be several parts (its rim, its tyre, the markings on its wall): they turn about the middle of them all
    const box = new THREE.Box3();
    for (const p of round[which]) { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); }
    const at = box.getCenter(V3());
    const same = new Map();              // (those of one material are made one part: a part is a draw for every car)
    for (const p of round[which]) same.set(p.material, [...(same.get(p.material) || []), p.geometry]);
    // A racing car's wheels lean (an F1 car's fronts by three degrees) and toe in or out, and the model has them so.
    // Turned about the car's own cross-line they would wobble from side to side as they went round, plain from in
    // front or behind. So each turns about its own axle (axleOf): the wheel is laid square for the turning, and
    // stood back at its lean by what holds it (tilt).
    const tilt = new THREE.Quaternion().setFromUnitVectors(V3(1, 0, 0), axleOf(round[which].map(p => p.geometry), at)), square = tilt.clone().invert();
    by.wheels[which] = { at, tilt, r: (box.max.y - box.min.y) / 2, w: box.max.x - box.min.x, fixed: [],
                         own: [...same].flatMap(([material, gs]) => { const one = gs.length > 1 ? mergeGeometries(gs) : null; return (one ? [one] : gs.map(g => g.clone())).map(geometry => ({ geometry: geometry.translate(-at.x, -at.y, -at.z).applyQuaternion(square), material })); }) };
  }
  for (const which in brakes) {
    const w = by.wheels[which];
    if (w) w.fixed.push({ geometry: brakes[which].geometry.clone().translate(-w.at.x, -w.at.y, -w.at.z), material: brakes[which].material });
    else by.body.push(brakes[which]);
  }
  return rec.sorted = by;
}
const kitCache = {};
function kitFor(name) {                 // the vehicle as it can be made now: with its sculpts where they have come, from shapes alone where they have not
  const got = {};
  let key = name;
  for (const n of MAKE[name].needs || []) {                              // after a sculpt's name, + : it has a mask; ! : it is only ever on this PC
    const id = n.replace(/[+!]/g, ""), s = sculpt(id, n.includes("+"), n.includes("!"));
    if (s.state === "ready") { got[id] = s; key += "+" + id; }
  }
  return kitCache[key] = kitCache[key] || MAKE[name](got);      // (nothing at all, for the F1 cars with no model here: then the typed-in car is drawn)
}
// A figure's armour in a car's colour. Its picture is painted one colour (the Master Chief's green); wherever a
// pixel of it is that green, it is given the car's colour at the same lightness, so that every scratch and every
// shadowed seam is still there; what is not green (the black suit under the plates, the visor) is left alone.
function armoured(base, colour) {
  const m = base.clone();
  m.onBeforeCompile = sh => {
    sh.uniforms.suit = { value: colour };
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform vec3 suit;")
      .replace("#include <map_fragment>", "#include <map_fragment>\n{ vec3 c = diffuseColor.rgb; float top = max(c.r, c.b), green = smoothstep(0.06, 0.2, (c.g - top) / (c.g + 0.0001)); "
        + "float light = dot(c, vec3(0.3, 0.6, 0.1)); diffuseColor.rgb = mix(c, clamp(suit * light / 0.13 + vec3(light * 0.25), 0.0, 1.0), green); }");
  };
  m.customProgramCacheKey = () => "armoured";
  return m;
}
// Paint laid on a model by where on the car a point is, not by the model's own unwrapping (which was made for its
// maker's livery): `where` is GLSL giving vec2 livUv(vec3 P), the place in a car's paint sheet (replay3d.js, dress)
// for the point P of the model. Worked out at every pixel, so a boundary between two panels is a clean line.
function liveried(base, paint, where) {
  const m = new THREE.MeshPhysicalMaterial({ map: paint, normalMap: base.normalMap || null, roughness: 0.38, metalness: 0.25, clearcoat: 0.7, clearcoatRoughness: 0.16, side: both });
  if (base.normalMap && base.normalScale) m.normalScale.copy(base.normalScale);
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vLiv;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvLiv = position;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vLiv;\n" + where)
      .replace("#include <map_fragment>", "diffuseColor *= textureLod(map, livUv(vLiv), 0.0);");
  };
  m.customProgramCacheKey = () => "liveried";
  return m;
}
function tinted(base, mask, colours, look) {      // a sculpt's material for one car: its own colours painted through the mask
  const m = base.clone();
  if (look) Object.assign(m, look);
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, { rideMask: { value: mask }, rideA: { value: colours[0] }, rideB: { value: colours[1] }, rideC: { value: colours[2] } });
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform sampler2D rideMask;\nuniform vec3 rideA, rideB, rideC;")
      .replace("#include <map_fragment>", "#include <map_fragment>\n{ vec3 rk = texture2D(rideMask, vMapUv).rgb; diffuseColor.rgb *= mix(mix(mix(vec3(1.0), rideA, rk.r), rideB, rk.g), rideC, rk.b); }");
  };
  m.customProgramCacheKey = () => "ride-tinted";
  return m;
}
const UNPAINTED = new THREE.Color(1, 1, 1);
/* LIMBS. A sculpt is one skin, and a horse has to gallop: so its legs are given bones by rule. Each limb is
     { key, x: [from, to], z: [from, to], top: [x, y, z], knee: [x, y, z], reach, bend }
   everything of the skin between those x and z that is below `top` belongs to the limb, taken over from the body
   across `reach` metres of height so a shoulder moves as one with its leg; below `knee` it belongs to the lower
   half, taken over across `bend`. Gives the skin back with a bone and a share written at every point: bone 0 is
   the body, 1 and 2 the first limb's upper and lower halves, and so on. */
function limbed(geometry, limbs) {
  const g = geometry.clone(), P = g.attributes.position, n = P.count, index = new Uint16Array(n * 4), share = new Float32Array(n * 4);
  const soft = (a, b, v) => { const f = clamp((v - a) / (b - a), 0, 1); return f * f * (3 - 2 * f); };
  for (let i = 0; i < n; i++) {
    const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
    let upper = 0, lower = 0, which = 0;
    limbs.forEach((L, j) => {
      const inside = soft(L.x[0] - 0.03, L.x[0] + 0.03, x) * soft(L.x[1] + 0.03, L.x[1] - 0.03, x) * soft(L.z[0] - 0.05, L.z[0] + 0.05, z) * soft(L.z[1] + 0.05, L.z[1] - 0.05, z);
      const limb = inside * soft(L.top[1] + L.reach * 0.4, L.top[1] - L.reach * 0.6, y);
      if (limb <= upper + lower) return;
      lower = limb * soft(L.knee[1] + L.bend, L.knee[1] - L.bend, y); upper = limb - lower; which = j;
    });
    index.set([0, 1 + which * 2, 2 + which * 2, 0], i * 4); share.set([1 - upper - lower, upper, lower, 0], i * 4);
  }
  g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(index, 4)); g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(share, 4));
  return g;
}
/* ARMS. A seated figure whose arms were brought down on to a steering wheel when it was adopted (rides\adopt.py,
   seated) says at every point of its skin whose that point is, in a second set of picture places (uv1): across,
   which arm and how much of the shoulder's turning the point takes (0.5 is none; above it the left arm, below it
   the right); up, how much of the elbow's (to half way) and then of the wrist's. So its arms are given bones here:
   bone 0 is the body, 1 to 3 the left arm's upper half, forearm and hand, 4 to 6 the right's. */
function armed(geometry) {
  const g = geometry.clone(), U = g.attributes.uv1, n = U.count, index = new Uint16Array(n * 4), share = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const s = (U.getX(i) - 0.5) * 2, v = (1 - U.getY(i)) * 2;      // (a .glb counts a picture's rows from the top)
    const arm = Math.abs(s) < 0.01 ? 0 : Math.min(1, Math.abs(s)), past = clamp(v, 0, 1), hand = clamp(v - 1, 0, 1), first = s > 0 ? 1 : 4;
    index.set([0, first, first + 1, first + 2], i * 4);
    share.set([1 - arm, arm * (1 - past), arm * past * (1 - hand), arm * past * hand], i * 4);
  }
  g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(index, 4)); g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(share, 4));
  return g;
}
// One arm brought to where its hand is wanted: the wrist goes to `wrist` and the hand is turned as `turn` says (both
// in the figure's own space), the elbow out to the side the arm's pole points (the same side adopt.py sat him with:
// rides\things.py, elbow_out). When the wrist is further off than the arm is long (a wheel at full lock), the
// shoulder gives a little, as a man's does.
const armA = V3(), armB = V3(), armC = V3(), armD = V3(), armE = V3(), armF = V3(), armM = new THREE.Matrix4(), armQ = new THREE.Quaternion(), armR = new THREE.Quaternion();
function armReach(arm, wrist, turn) {
  const { a, b } = arm, d = armA.copy(wrist).sub(arm.S), far = d.length() || 1, c = clamp(far, Math.abs(a - b) + 0.005, a + b - 0.004);
  d.divideScalar(far);
  arm.upper.position.copy(arm.S).addScaledVector(d, Math.min(0.1, Math.max(0, far - c)));
  const pole = armB.copy(arm.pole).addScaledVector(d, -arm.pole.dot(d)).normalize(), at = Math.acos(clamp((a * a + c * c - b * b) / (2 * a * c), -1, 1));
  const u = armC.copy(d).multiplyScalar(Math.cos(at)).addScaledVector(pole, Math.sin(at));      // where the upper arm points
  const f = armD.copy(d).multiplyScalar(c).addScaledVector(u, -a).normalize();                  // and the forearm
  const hinge = armE.crossVectors(u, f).normalize();
  armQ.setFromRotationMatrix(armM.makeBasis(u, hinge, armF.crossVectors(u, hinge))).multiply(arm.restU);
  armR.setFromRotationMatrix(armM.makeBasis(f, hinge, armF.crossVectors(f, hinge))).multiply(arm.restF);
  arm.upper.quaternion.copy(armQ);
  arm.lower.quaternion.copy(armQ).invert().multiply(armR);
  arm.hand.quaternion.copy(armR).invert().multiply(turn);
}
function dressCar(car, name, kit) {
  const u = car.userData;
  if (!u.f1) {                           // the first time: gather the F1 car's own body so it can be put away whole
    u.f1 = new THREE.Group();
    for (const ch of [...u.body.children]) u.f1.add(ch);
    u.body.add(u.f1);
    u.blob = car.children.find(ch => ch.isMesh && ch.geometry.type === "PlaneGeometry");
  }
  if (u.alt) {
    u.body.remove(u.alt.root); car.remove(u.alt.ground);
    for (const o of u.alt.world) scene.remove(o);          // (what it had standing in the world and not on the car: shots in flight)
    for (const m of u.alt.own) m.dispose();
    u.alt = null;
  }
  const stock = !kit;                    // the F1 car typed in in replay3d.js, unless a model of one has been adopted on this PC
  if (kit && kit.variants) kit = kit.variants[kit.which(u.i) % kit.variants.length];      // a vehicle that comes in several kinds: this driver's
  u.f1.visible = stock;
  for (const w of u.wheels) w.hub.visible = stock;
  u.blob.scale.set(1, 1, 1);
  if (stock) return;
  const c = S.CARS.find(q => q.i === u.i);
  const team = new THREE.Color(c.color), second = new THREE.Color(c.color2 || "#e8e8e8");
  const own = [], mine = (colour, o = {}) => { const m = new THREE.MeshPhysicalMaterial({ color: colour, roughness: 0.3, metalness: 0.12, clearcoat: 1, clearcoatRoughness: 0.08, side: both, ...o }); own.push(m); return m; };
  const aura = new THREE.MeshBasicMaterial({ color: team.clone().multiplyScalar(2.2), side: both }); own.push(aura);
  const beam = new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.5, alphaMap: fadeDown(), depthWrite: false, blending: THREE.AdditiveBlending, side: both, fog: false }); own.push(beam);
  const mats = { paint: mine(team, kit.paint || {}), second: mine(second, kit.paint || {}), coat: kit.coat ? mine(kit.coat(u.i), { roughness: 0.58, clearcoat: 0, metalness: 0, vertexColors: true }) : null, aura, beam };
  const mat = slot => mats[slot] || shade(slot);
  const alt = u.alt = { name, i: u.i, u, second, root: new THREE.Group(), ground: new THREE.Group(), wheels: [], m: {}, own, aura, team, dist: 0, t: null, kit, arcs: null, flux: null, close: null, far: false, world: [], arms: null };
  const piece = (geo, slot) => { const m = new THREE.Mesh(geo, mat(slot)); m.castShadow = !["clear", "tint", "beam", "glow"].includes(slot); if (slot === "tint" || slot === "clear") m.renderOrder = 2; return m; };
  for (const slot in kit.lumps) alt.root.add(piece(kit.lumps[slot], slot));
  for (const [key, shapes, at, on] of kit.movers || []) {   // a part that moves: its shapes by lump, where it hinges, and the mover it hangs from if it hangs from one
    const g = new THREE.Group();
    g.position.set(...at);
    for (const slot in shapes) g.add(piece(shapes[slot], slot));
    (on ? alt.m[on] : alt.root).add(g); alt.m[key] = g;
  }
  const coat = kit.coat ? new THREE.Color(kit.coat(u.i)) : UNPAINTED, which = { paint: team, second, coat };
  // A model with a cabin and machinery to it is a great many triangles, and a field of them is drawn twice (once
  // for shadows). So a body may say which of its parts throw no shadow of their own (`quiet`: wiring does not need
  // one) and which are only worth drawing from close by (`close`: what is inside the cabin, behind dark glass).
  for (const b of kit.bodies || []) {                       // sculpted bodies: { sculpt, at, turn, size, tint: [what the mask's red, green and blue are painted], look, on, key, quiet, close }
    const hold = new THREE.Group();
    if (b.at) hold.position.set(...b.at);
    if (b.turn) hold.rotation.y = b.turn;
    if (b.size) hold.scale.setScalar(b.size);
    for (const part of b.sculpt.parts) {
      let m = (b.wear && b.wear(part, u, alt)) || part.material;      // (a body may dress some of its parts itself, car by car: an F1 car's paint and lettering)
      if (m !== part.material) { /* dressed */ }
      else if (part.painted && b.sculpt.mask && b.tint) { m = tinted(m, b.sculpt.mask, [0, 1, 2].map(k => which[b.tint[k]] || UNPAINTED), b.look); own.push(m); }
      else if (part.painted && b.look) m = part.worn = part.worn || Object.assign(m.clone(), b.look);
      if (b.arms && part.geometry.attributes.uv1) {           // a seated figure with bones in its arms (armed, above): the kit's step puts its hands where they belong
        part.armed = part.armed || armed(part.geometry);
        const mesh = new THREE.SkinnedMesh(part.armed, m), bones = [new THREE.Bone()];
        alt.arms = b.arms.map(A => {
          const S = V3(...A.shoulder), E = V3(...A.elbow), W = V3(...A.wrist), upper = new THREE.Bone(), lower = new THREE.Bone(), hand = new THREE.Bone();
          upper.position.copy(S); lower.position.copy(E).sub(S); hand.position.copy(W).sub(E);
          bones[0].add(upper); upper.add(lower); lower.add(hand); bones.push(upper, lower, hand);
          const u0 = E.clone().sub(S).normalize(), f0 = W.clone().sub(E).normalize(), h0 = u0.clone().cross(f0).normalize();      // as he sits: the upper arm, the forearm, the line the elbow bends about
          return { S, wrist: W, a: S.distanceTo(E), b: E.distanceTo(W), pole: V3(...A.pole).normalize(), upper, lower, hand,
                   restU: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u0, h0, u0.clone().cross(h0))).invert(),
                   restF: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(f0, h0, f0.clone().cross(h0))).invert() };
        });
        mesh.add(bones[0]);
        const skeleton = new THREE.Skeleton(bones);
        mesh.bind(skeleton); mesh.castShadow = !(b.quiet && b.quiet(part)); mesh.frustumCulled = false; own.push(skeleton);
        hold.add(mesh);
        continue;
      }
      if (!b.limbs) {
        const mesh = new THREE.Mesh(part.geometry, m);
        mesh.castShadow = !m.transparent && !(b.quiet && b.quiet(part));
        if (m.transparent) mesh.renderOrder = 2;
        if (b.close && b.close(part)) { if (!alt.close) hold.add(alt.close = new THREE.Group()); alt.close.add(mesh); } else hold.add(mesh);
        continue;
      }
      part.limbed = part.limbed || limbed(part.geometry, b.limbs);                    // with bones in its legs: the kit's step() turns them, as it turns any mover
      const mesh = new THREE.SkinnedMesh(part.limbed, m), bones = [new THREE.Bone()];
      for (const L of b.limbs) {
        const upper = new THREE.Bone(), lower = new THREE.Bone();
        upper.position.set(...L.top); lower.position.set(L.knee[0] - L.top[0], L.knee[1] - L.top[1], L.knee[2] - L.top[2]);
        bones[0].add(upper); upper.add(lower); bones.push(upper, lower);
        alt.m[(b.key || "") + L.key] = upper; alt.m[(b.key || "") + L.key + "2"] = lower;
      }
      mesh.add(bones[0]);
      const skeleton = new THREE.Skeleton(bones);
      mesh.bind(skeleton); mesh.castShadow = true; mesh.frustumCulled = false; own.push(skeleton);
      hold.add(mesh);
    }
    (b.on ? alt.m[b.on] : alt.root).add(hold);
    if (b.key) alt.m[b.key] = hold;
  }
  // What is drawn over a model's own parts: its lamps and its tubes as they are when lit (their glow picture, added
  // on top as light), and anything laid over a part (soot). A copy of a part lies exactly on it, so each is drawn a
  // hair nearer, and writes no depth. "flux" is this car's own, and the kit's step turns it up and down (alt.flux).
  for (const o of kit.overlays || []) for (const part of o.parts) {
    let m;
    const nearer = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, depthWrite: false, transparent: true };
    if (o.kind === "over") m = part.laid = part.laid || Object.assign(part.material.clone(), nearer);
    else {
      const light = () => new THREE.MeshBasicMaterial({ map: part.material.emissiveMap || part.material.map, color: new THREE.Color(...(o.colour || [1, 1, 1])), blending: THREE.AdditiveBlending, fog: false, side: both, ...nearer });
      if (o.kind === "flux") { m = alt.flux = alt.flux || light(); if (!own.includes(m)) own.push(m); }
      else m = part.lit = part.lit || light();
    }
    const mesh = new THREE.Mesh(part.geometry, m);
    mesh.renderOrder = 3;
    if (o.kind === "over") { if (!alt.close) alt.root.add(alt.close = new THREE.Group()); alt.close.add(mesh); } else alt.root.add(mesh);
  }
  for (const [x, z, steers, kind = 0] of kit.wheels) {
    const w = kit.wheel[kind], hold = new THREE.Group(), turned = new THREE.Group(), spin = new THREE.Group();
    hold.position.set(x, w.r, z);
    if (w.own) {                                           // a model's own wheel, already the right one for its corner; its brake steers with it and does not turn
      if (w.tilt) turned.quaternion.copy(w.tilt);          // (stood at its own lean: see adoptedParts)
      for (const q of w.own) { const mesh = new THREE.Mesh(q.geometry, (kit.wheelWear && kit.wheelWear(q, u, alt)) || q.material); mesh.castShadow = true; spin.add(mesh); }
      for (const q of w.fixed || []) hold.add(new THREE.Mesh(q.geometry, q.material));
    } else {
      if (x < 0) turned.rotation.y = Math.PI;              // the same wheel, turned round for the other side
      spin.add(piece(w.tyre, "rubber"));
      for (const slot in w.rim) spin.add(piece(w.rim[slot], slot));
    }
    turned.add(spin); hold.add(turned); alt.ground.add(hold);
    alt.wheels.push({ hold, spin, r: w.r, steers, way: x < 0 && !w.own ? -1 : 1 });
  }
  for (const slot in kit.ground || {}) alt.ground.add(piece(kit.ground[slot], slot));      // things lying on the road under it
  if (kit.lightning) alt.arcs = lightning(alt);
  if (kit.fit) kit.fit(alt, u);                            // anything of its own a kit wants made for each car
  u.body.add(alt.root); car.add(alt.ground);
  u.blob.scale.set(kit.blob[0], 1, kit.blob[1]);
}
let fadeTex = null;
function fadeDown() {                   // bright at the top, nothing at the bottom: for a beam of light
  return fadeTex = fadeTex || tex(4, 64, (g, w, h) => { const q = g.createLinearGradient(0, 0, 0, h); q.addColorStop(0, "#ffffff"); q.addColorStop(0.5, "#5a5a5a"); q.addColorStop(1, "#000000"); g.fillStyle = q; g.fillRect(0, 0, w, h); }, { repeat: false, srgb: false });
}

/* Lightning for one car, in the order the film has it as the car gathers speed: sparks that start at its nose and
   sweep back over it; then, when it gets there, a few bolts crawling on it, a glow round the whole car, and two
   trails of fire left on the road behind the back wheels. (It was twelve bolts and a bright glow from the first
   moment, and nothing swept. Eric: "the elctric needs to be tones down a little and add some sweeping blue sparks
   from front to back like it does in the movies".) Sparks and bolts are thrown afresh every frame as thin crossed
   ribbons (a line can only be a pixel wide), and both run on the vehicle's own surface: lie(). */
let glowSpot = null, fireTex = null;
function glowDot() {                    // a soft round light, for a sprite
  return glowSpot = glowSpot || tex(64, 64, (c, w, h) => { const q = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); q.addColorStop(0, "rgba(255,255,255,1)"); q.addColorStop(0.4, "rgba(255,255,255,0.35)"); q.addColorStop(1, "rgba(255,255,255,0)"); c.clearRect(0, 0, w, h); c.fillStyle = q; c.fillRect(0, 0, w, h); }, { repeat: false });
}
/* Lengths of light laid in the world afresh each frame (tracer, a beam, a rocket's flame): begin(), then
   line(a, b, wide, colour at a, colour at b) for each, then end(). Each is two flat strips crossed, one standing
   up and one lying across, so that it has a width from any side; colours are added to what is behind them and may
   be brighter than white, which is what makes them glow. */
function strips(count) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(count * 36), 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(count * 36), 3));
  const P = g.attributes.position.array, C = g.attributes.color.array;      // (the attributes' own: one made from an array is a copy of it)
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: both });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false; mesh.visible = false;
  let n = 0;
  return { mesh, g, mat,
    begin() { n = 0; },
    line(a, b, wide, ca, cb) {
      if (n + 36 > P.length) return;
      let sx = b.z - a.z, sz = a.x - b.x;
      const flat = wide / (Math.hypot(sx, sz) || 1);
      sx *= flat; sz *= flat;
      for (const [ox, oy, oz] of [[0, wide, 0], [sx, 0, sz]]) for (const [q, side, c] of [[a, -1, ca], [a, 1, ca], [b, 1, cb], [a, -1, ca], [b, 1, cb], [b, -1, cb]]) {
        P[n] = q.x + ox * side; P[n + 1] = q.y + oy * side; P[n + 2] = q.z + oz * side; C[n] = c[0]; C[n + 1] = c[1]; C[n + 2] = c[2]; n += 3;
      }
    },
    end() { g.setDrawRange(0, n / 3); g.attributes.position.needsUpdate = g.attributes.color.needsUpdate = true; mesh.visible = n > 0; } };
}
const BOLTS = 5, BOLT_SEG = 8, LANES = 26, LANE_SEG = 5;

// How high a vehicle stands at every place along and across it. Read once off its sculpt (off every triangle, not
// only its corners: a flat bonnet is a few big ones), or, where it has none, off the kit's `shell`: the half-width,
// middle height, half-height and half-length of an egg round it.
function lie(kit) {
  if (kit.lie) return kit.lie;
  const body = (kit.bodies || [])[0], shell = kit.shell || [1.0, 0.62, 0.62, 2.3], CZ = 0.1, CX = 0.08;
  let lo = -shell[3], hi = shell[3], half = shell[0];
  if (body) {
    lo = Infinity; hi = -Infinity; half = 0;
    for (const part of body.sculpt.parts) {
      part.geometry.computeBoundingBox();
      const box = part.geometry.boundingBox;
      lo = Math.min(lo, box.min.z); hi = Math.max(hi, box.max.z); half = Math.max(half, box.max.x, -box.min.x);
    }
  }
  const nz = Math.ceil((hi - lo) / CZ) + 2, nx = Math.ceil(2 * half / CX) + 2, H = new Float32Array(nz * nx), wide = new Float32Array(nz);
  const put = (x, y, z) => {
    const i = clamp(Math.round((z - lo) / CZ), 0, nz - 1), j = clamp(Math.round((x + half) / CX), 0, nx - 1);
    if (y > H[i * nx + j]) H[i * nx + j] = y;
    if (Math.abs(x) > wide[i]) wide[i] = Math.abs(x);
  };
  if (body) for (const part of body.sculpt.parts) {
    const P = part.geometry.attributes.position, I = part.geometry.index, tris = (I ? I.count : P.count) / 3, A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
    for (let f = 0; f < tris; f++) {
      A.fromBufferAttribute(P, I ? I.getX(f * 3) : f * 3); B.fromBufferAttribute(P, I ? I.getX(f * 3 + 1) : f * 3 + 1); C.fromBufferAttribute(P, I ? I.getX(f * 3 + 2) : f * 3 + 2);
      const n = Math.min(14, Math.max(1, Math.ceil(Math.max(A.distanceTo(B), B.distanceTo(C), C.distanceTo(A)) / 0.05)));
      for (let u = 0; u <= n; u++) for (let v = 0; v <= n - u; v++) {
        const e = u / n, g = v / n, h = 1 - e - g;
        put(A.x * e + B.x * g + C.x * h, A.y * e + B.y * g + C.y * h, A.z * e + B.z * g + C.z * h);
      }
    }
  } else for (let i = 0; i < nz; i++) for (let j = 0; j < nx; j++) {
    const z = lo + i * CZ, x = -half + j * CX, inside = 1 - (z / shell[3]) ** 2 - (x / shell[0]) ** 2;
    if (inside > 0) put(x, shell[1] + shell[2] * Math.sqrt(inside), z);
  }
  return kit.lie = { lo, hi, half, nz, nx, CZ, CX, H, wide };
}
function lieAt(L, x, z) {               // its height at a place, and never lower than its sills
  const fi = clamp((z - L.lo) / L.CZ, 0, L.nz - 1.001), fj = clamp((x + L.half) / L.CX, 0, L.nx - 1.001), i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j, H = L.H, n = L.nx;
  return Math.max(0.32, (H[i * n + j] * (1 - v) + H[i * n + j + 1] * v) * (1 - u) + (H[(i + 1) * n + j] * (1 - v) + H[(i + 1) * n + j + 1] * v) * u);
}
function lieOn(L, z, s, gap, out) {     // a place just off its surface at z along it: s from -1 (the foot of one flank) over the top (0) to 1 (the foot of the other)
  const zz = clamp(z, L.lo, L.hi), f = clamp((zz - L.lo) / L.CZ, 0, L.nz - 1.001), i = Math.floor(f), w = L.wide[i] * (1 - f + i) + L.wide[i + 1] * (f - i);
  const a = Math.abs(s), side = s < 0 ? -1 : 1;
  if (a <= 0.6) { out[0] = side * a / 0.6 * w; out[1] = lieAt(L, out[0] * 0.9, zz) + gap; }
  else { const top = lieAt(L, side * w * 0.9, zz); out[0] = side * (w + gap); out[1] = top - (a - 0.6) / 0.4 * (top - 0.32); }
  out[2] = z;
}
function lightning(alt) {
  const ribbons = (segments, coloured) => {       // strips to be filled in every frame, two crossed to a segment; `coloured`: each end of a strip has its own brightness
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(segments * 36), 3));
    if (coloured) g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(segments * 36), 3));
    const mat = new THREE.MeshBasicMaterial({ color: coloured ? new THREE.Color(1, 1, 1) : new THREE.Color(1.3, 2.6, 8.5), vertexColors: !!coloured, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: both });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false; mesh.visible = false;
    alt.own.push(g, mat);
    return mesh;
  };
  const bolts = ribbons(BOLTS * BOLT_SEG, false), sparks = ribbons(LANES * LANE_SEG, true);
  glowSpot = glowSpot || tex(64, 64, (c, w, h) => { const q = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2); q.addColorStop(0, "rgba(255,255,255,1)"); q.addColorStop(0.4, "rgba(255,255,255,0.35)"); q.addColorStop(1, "rgba(255,255,255,0)"); c.clearRect(0, 0, w, h); c.fillStyle = q; c.fillRect(0, 0, w, h); }, { repeat: false });
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSpot, color: new THREE.Color(0.22, 0.55, 2.2), transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false }));      // no depth test: the road cut its lower half off in a straight line
  halo.scale.set(6.2, 2.9, 1); halo.position.y = 0.7; halo.visible = false;
  const L = lie(alt.kit);
  const flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSpot, color: new THREE.Color(0.8, 1.6, 4.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));      // where the sparks are born: a light on its nose
  flare.scale.set(1.5, 0.75, 1); flare.position.set(0, Math.max(0.5, lieAt(L, 0, L.hi - 0.15) * 0.8), L.hi + 0.06); flare.visible = false;
  fireTex = fireTex || tex(64, 256, (c, w, h) => {          // flame: bright by the wheel, torn and thin far behind
    const r = seeded(88);
    c.clearRect(0, 0, w, h);
    for (let k = 0; k < 150; k++) {
      const y = r() ** 1.7 * h, x = w / 2 + (r() - 0.5) * w * (0.35 + 0.5 * y / h), len = 10 + r() * 46, a = (1 - y / h) ** 1.4;
      const q = c.createLinearGradient(0, y, 0, y + len);
      q.addColorStop(0, `rgba(255,${Math.round(160 + 80 * r())},${Math.round(40 + 60 * r())},${(0.5 * a).toFixed(3)})`); q.addColorStop(1, "rgba(255,90,10,0)");
      c.fillStyle = q; c.beginPath(); c.ellipse(x, y + len / 2, 2 + r() * 5, len / 2, 0, 0, TAU); c.fill();
    }
  }, { repeat: false });
  const fire = new THREE.MeshBasicMaterial({ map: fireTex, color: new THREE.Color(3.2, 1.5, 0.5), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: both });
  const trails = new THREE.Group();
  for (const x of [0.86, -0.86]) trails.add(new THREE.Mesh(new THREE.PlaneGeometry(0.36, 9).rotateX(-Math.PI / 2).rotateY(Math.PI).translate(x, 0.03, -6.0), fire));
  trails.visible = false;
  const r = seeded(700 + alt.i * 13), lanes = [];           // each spark keeps to its own lane round the car, and they are brought in one by one, spread evenly however many there are
  for (let j = 0; j < LANES; j++) lanes.push({ s: (j * 0.618034 % 1) * 2 - 1, phase: r(), rate: 2.1 + 1.5 * r(), len: 0.5 + 0.6 * r(), wd: 0.004 + 0.005 * r() });
  alt.root.add(bolts, sparks, halo, flare); alt.ground.add(trails); alt.own.push(halo.material, flare.material, fire);
  return { bolts, sparks, halo, flare, trails, fire, lanes };
}
function strike(alt, k, sweep, t) {     // k: the bolts, the glow and the fire, from 0 (none) to 1; sweep: the sparks from its nose, the same
  const { bolts, sparks, halo, flare, trails, fire, lanes } = alt.arcs;
  bolts.visible = trails.visible = k > 0; sparks.visible = flare.visible = sweep > 0; halo.visible = k > 0 || sweep > 0;
  if (!halo.visible) return;
  const L = lie(alt.kit), p = [0, 0, 0], q = [0, 0, 0];
  let P = null, C = null, n = 0;
  const ribbon = (ax, ay, az, wd, from, to) => {    // one flat strip from p to q, standing along (ax, ay, az); as bright as `from` at p and `to` at q where the strips are coloured
    if (C) for (const [at, b] of [[0, from], [3, from], [6, to], [9, from], [12, to], [15, to]]) { C[n + at] = 1.0 * b; C[n + at + 1] = 2.1 * b; C[n + at + 2] = 6.4 * b; }
    P[n++] = p[0] - ax * wd; P[n++] = p[1] - ay * wd; P[n++] = p[2] - az * wd; P[n++] = p[0] + ax * wd; P[n++] = p[1] + ay * wd; P[n++] = p[2] + az * wd; P[n++] = q[0] + ax * wd; P[n++] = q[1] + ay * wd; P[n++] = q[2] + az * wd;
    P[n++] = p[0] - ax * wd; P[n++] = p[1] - ay * wd; P[n++] = p[2] - az * wd; P[n++] = q[0] + ax * wd; P[n++] = q[1] + ay * wd; P[n++] = q[2] + az * wd; P[n++] = q[0] - ax * wd; P[n++] = q[1] - ay * wd; P[n++] = q[2] - az * wd;
  };
  const flick = 0.55 + 0.45 * Math.random();
  if (sweep > 0) {                        // the sparks: born on the nose close together, they spread over it as they run back, and are gone by the tail
    P = sparks.geometry.attributes.position.array; C = sparks.geometry.attributes.color.array; n = 0;
    const live = Math.ceil(lanes.length * sweep), front = L.hi + 0.1, span = L.hi - L.lo + 0.3;
    for (let j = 0; j < live; j++) {
      const ln = lanes[j], gone = (ln.phase + t * ln.rate) % 1, bright = sweep * Math.min(1, gone / 0.05) * (1 - gone) ** 0.6 * (0.55 + 0.45 * Math.random());
      const place = (back, out) => {      // a point of it: its head (0), and where its head has been
        const z = Math.min(front, front - gone * span + back * ln.len / LANE_SEG), out2 = clamp((front - z) / (0.22 * span), 0, 1);
        lieOn(L, z, (ln.s + (back ? (Math.random() - 0.5) * 0.2 : 0)) * (0.3 + 0.7 * out2 * out2 * (3 - 2 * out2)), 0.02 + Math.random() * 0.09, out);
      };
      place(0, p);
      for (let back = 1; back <= LANE_SEG; back++) {
        place(back, q);
        const from = bright * (1 - (back - 1) / LANE_SEG), to = bright * (1 - back / LANE_SEG);
        ribbon(0, 1, 0, ln.wd, from, to); ribbon(1, 0, 0, ln.wd, from, to);
        p[0] = q[0]; p[1] = q[1]; p[2] = q[2];
      }
    }
    sparks.geometry.setDrawRange(0, n / 3);
    sparks.geometry.attributes.position.needsUpdate = sparks.geometry.attributes.color.needsUpdate = true;
    flare.material.opacity = 0.5 * sweep * flick;
  }
  if (k > 0) {                            // the bolts: two to six of them, each wandering over its surface
    P = bolts.geometry.attributes.position.array; C = null; n = 0;
    const count = Math.min(BOLTS, 2 + Math.floor(Math.random() * (BOLTS - 1) * k));
    for (let b = 0; b < count; b++) {
      let z = L.lo + Math.random() * (L.hi - L.lo), s = Math.random() * 2 - 1;
      const dz = (Math.random() - 0.5) * 0.9, ds = (Math.random() - 0.5) * 0.5, wd = 0.004 + Math.random() * 0.007;
      lieOn(L, z, s, 0.04, p);
      for (let seg = 0; seg < BOLT_SEG; seg++) {
        z = clamp(z + dz * (0.5 + Math.random()), L.lo, L.hi); s = clamp(s + ds * (0.4 + Math.random()) + (Math.random() - 0.5) * 0.3, -1, 1);
        lieOn(L, z, s, 0.02 + Math.random() * 0.12, q);
        ribbon(0, 1, 0, wd); ribbon(1, 0, 0, wd);
        p[0] = q[0]; p[1] = q[1]; p[2] = q[2];
      }
    }
    bolts.geometry.setDrawRange(0, n / 3);
    bolts.geometry.attributes.position.needsUpdate = true;
    bolts.material.opacity = 0.7 * k * flick;
    fire.opacity = k * (0.7 + 0.3 * Math.random());
  }
  halo.material.opacity = (0.2 * k + 0.07 * sweep) * flick;
}
/* A vehicle's models are files, fetched when it is first wanted, and they take a second or two to come. What is
   drawn in the meantime used to be the stand-in (the typed-in car, the sculpt), which then turned into the real
   thing in front of you: Eric, "i notice the old models pop in real quick before loading the real one, what
   gives?". Now nothing is changed until everything a vehicle needs has come or is known not to be coming: what is
   on the cars stays on them, and when the page has only just opened and nothing has been settled yet, the cars are
   not drawn at all for that moment. (Eight seconds is as long as anything is waited for.) */
let rideAsked = null, rideSince = 0, rideSettled = false;
function ridePending(name) {
  if (!MAKE[name]) return false;
  if (rideAsked !== name) { rideAsked = name; rideSince = performance.now(); }
  return performance.now() - rideSince < 8000 && (MAKE[name].needs || []).some(n => sculpt(n.replace(/[+!]/g, ""), n.includes("+"), n.includes("!")).state === "loading");
}
function carsStep(t) {                  // each frame, after the cars have been stood on the road
  const pending = ridePending(rideNow);
  const kit = pending ? kitShown : MAKE[rideNow] ? kitFor(rideNow) : null;      // none for the F1 cars, unless a model of one is here
  if (!pending && (rideShown !== rideNow || kitShown !== kit)) {
    for (const car of cars) dressCar(car, rideNow, kit);
    POD.at.copy(kit ? V3(...kit.pod) : POD_F1);
    rideShown = rideNow; kitShown = kit;
  }
  if (!pending) rideSettled = true;
  else if (!rideSettled) { for (const car of cars) car.visible = false; return; }      // the page has only just opened: no cars yet, sooner than the wrong ones
  if (!kit) return;
  const lens = Math.tan(camera.fov * Math.PI / 360);
  for (const car of cars) {
    const u = car.userData, alt = u.alt, p = car.visible && alt ? pose(u.i, t) : null;
    if (!p) continue;
    const since = alt.t === null ? 0 : t - alt.t, moved = since > 0 && since < 0.5 ? since : 0;      // replay time gone by, when it is being played forwards
    alt.t = t;
    alt.dist += p.speed / 3.6 * moved;
    for (const w of alt.wheels) { w.spin.rotation.x = w.way * alt.dist / w.r; if (w.steers) w.hold.rotation.y = -p.steer * 0.32 * (w.steers === true ? 1 : w.steers); }      // (a number: how much of the steering that wheel takes, and which way)
    if (alt.close) alt.close.visible = car.position.distanceToSquared(camera.position) < 1600;      // within 40 m
    if (alt.kit.farStock) {               // an adopted F1 car is ten times the typed-in one to draw: from far enough off that they cannot be told apart, the typed-in one is drawn
      const size = car.position.distanceTo(camera.position) * lens;      // (how far off, and how long the lens is: a long lens brings a far car close)
      const far = alt.far ? size > 30 : size > 36;
      if (far !== alt.far) { alt.far = far; alt.root.visible = alt.ground.visible = !far; u.f1.visible = far; for (const w of u.wheels) w.hub.visible = far; }
    }
    if (alt.kit.step) alt.kit.step(alt, p, t, moved);
    if (alt.arcs) {
      const hot = clamp((p.speed - 200) / 88, 0, 1);                      // the coils warm up from 200 km/h, sparks begin to sweep back over it at 250, and at 288 it lets go
      alt.aura.color.setRGB(0.1 + 0.5 * hot, 0.25 + 1.6 * hot, 0.8 + 4.4 * hot);
      if (alt.flux) alt.flux.color.setScalar((0.6 + 3.2 * hot * hot) * (hot > 0.99 ? 0.8 + 0.4 * Math.random() : 1));      // a model's own tubes: a low glow, bright as it gets there, flickering once it has
      strike(alt, clamp((p.speed - 288) / 10, 0, 1), clamp((p.speed - 250) / 38, 0, 1), t);
    }
    u.tag.position.y += alt.kit.tall;
  }
}
api.garage = GARAGE; api.setCars = setCars; api.debug.sculpts = SCULPTS;
Object.defineProperty(api, "carsPending", { get: () => ridePending(rideNow) });      // true while what the chosen vehicle needs is still on its way
api.debug.carsState = () => ({ pending: ridePending(rideNow), drawn: cars.filter(c => c.visible).length, standIns: cars.filter(c => c.visible && !c.userData.alt).length, shown: rideShown });
Object.defineProperty(api, "carsName", { get: () => rideNow });

// The vehicles the field can be drawn as: part of the 3D view, joined on after replay3d_cars.js, which has the
// tools used here (loft, sweep, rbox, Kit, wheelKind, limbed) and says what a vehicle has to give back:
//   lumps    its shapes, by kind of surface            wheel, wheels   the kinds of wheel, and [x, z, steers, kind] for each
//   movers   parts that move: [name, shapes, hinge,    step(alt, p, t, moved)   what it does each frame (moved: replay
//            the mover it hangs from if any]                                    seconds gone by, when played forwards)
//   bodies   sculpted bodies (rides\things.py): { sculpt, at, turn, size, tint, look, limbs, key }
//   ground   shapes lying on the road under it         coat(i)         a colour of its own choosing for car i
//   tall     how much higher the name tag goes         pod             where the pod camera rides
//   blob     the soft shadow's size, of the F1 car's
// Everything is in metres, +z forward, +x the driver's left, the road at y = 0.

const SHAPES = {};                      // the vehicles that can have a sculpted body, as shapes alone: what is shown until the sculpt has come, or if it cannot be had
const LAMP_WHITE = [3.0, 2.9, 2.6], LAMP_RED = [2.2, 0.08, 0.05], LAMP_AMBER = [2.4, 1.0, 0.08];
function lamp(k, x, y, z, r, colour, facing = 1) {       // a round lamp: a bright ring, a lit lens
  k.add("chrome", new THREE.TorusGeometry(r, r * 0.17, 6, 18).translate(x, y, z), 0xe8e8e8);
  k.add("glow", new THREE.SphereGeometry(r * 0.92, 14, 6, 0, TAU, 0, Math.PI / 2).rotateX(facing * Math.PI / 2).scale(1, 1, 0.35).translate(x, y, z), colour);
}
const archLip = (r, x, y, z, tube = 0.024) => new THREE.TorusGeometry(r, tube, 6, 18, Math.PI).rotateY(Math.PI / 2).translate(x, y, z);      // the edge of a wheel arch
const between = (stations, z) => {      // a body's station at any z, between the ones given
  let i = 0;
  while (i < stations.length - 2 && (stations[i + 1][0] - z) * (stations[i][0] - stations[i + 1][0]) > 0) i++;
  const A = stations[i], B = stations[i + 1], f = clamp((z - A[0]) / (B[0] - A[0]), 0, 1);
  return A.map((v, j) => lerp(v, B[j] ?? v, f));
};

// ---- a stainless wedge of a coupé with a reactor on its back. Past 288 km/h (the film's 88 mph, for a car this
// quick) the coils down its sides blaze, lightning crawls over it and it leaves fire on the road.
SHAPES.delorean = () => {
  const k = new Kit(), STEEL = 0xc3c6ca, BLACK = 0x121315, GREY = 0x2b2d31;
  const body = [[2.16, 0.42, 0.80, 0.14, 0.16, 5, 6], [2.05, 0.42, 0.88, 0.18, 0.20, 6, 7], [1.3, 0.44, 0.92, 0.27, 0.23, 7, 8], [0.9, 0.46, 0.93, 0.34, 0.25, 7, 8],
                [0, 0.46, 0.93, 0.36, 0.25, 7, 8], [-1.0, 0.47, 0.93, 0.38, 0.26, 7, 8], [-2.0, 0.47, 0.90, 0.38, 0.24, 6, 7], [-2.17, 0.48, 0.84, 0.34, 0.20, 5, 6]];
  k.add("steel", loft(body, { around: 44 }), STEEL);                       // a low wedge with square shoulders and a flat floor
  // the cabin: dark glass all round, with the roof, the screen pillars and the rear quarters laid over it in steel
  const cabin = [[1.0, 0.78, 0.80, 0.02, 0.02, 3.2], [0.62, 0.80, 0.78, 0.20, 0.02, 3.2], [0.22, 0.81, 0.74, 0.335, 0.02, 3.2], [-0.55, 0.82, 0.74, 0.325, 0.02, 3.2],
                 [-1.0, 0.83, 0.76, 0.20, 0.02, 3.2], [-1.5, 0.84, 0.78, 0.03, 0.02, 3.2]];
  k.add("glass", loft(cabin, { around: 40 }));
  k.add("steel", loft(cabin.slice(2, 4), { around: 40, arc: [0.33, 0.67], lift: 0.006 }), STEEL);
  for (const arc of [[0.285, 0.33], [0.67, 0.715]]) k.add("steel", loft(cabin.slice(0, 3), { around: 40, arc, lift: 0.006 }), STEEL);
  for (const arc of [[0.25, 0.37], [0.63, 0.75]]) k.add("steel", loft(cabin.slice(3), { around: 40, arc, lift: 0.006 }), STEEL);
  k.add("steel", loft([between(cabin, -0.5), between(cabin, -0.6)], { around: 40, arc: [0.25, 0.75], lift: 0.008 }), STEEL);      // the hoop behind the doors
  const roofAt = z => { const q = between(cabin, z); return q[1] + q[3]; };
  for (let j = 0; j < 7; j++) { const z = -0.7 - j * 0.118; k.add("satin", rbox(1.0 - j * 0.02, 0.016, 0.1, 0.005, 0, 0, 0, 1).rotateX(0.27).translate(0, roofAt(z) + 0.014, z), BLACK); }      // louvres over the back window
  k.both("satin", s => rod([s * 0.17, roofAt(0.2) + 0.007, 0.2], [s * 0.17, roofAt(-0.52) + 0.007, -0.52], 0.005, 5), BLACK);         // where the doors open, up along the roof
  // the nose: a dark band with four square lamps; the tail: a dark panel with a grid of lamps
  k.add("satin", rbox(1.74, 0.17, 0.1, 0.03, 0, 0.36, 2.15), GREY).add("satin", rbox(1.5, 0.1, 0.03, 0.01, 0, 0.5, 2.168), BLACK);
  k.add("satin", rbox(1.76, 0.15, 0.1, 0.03, 0, 0.36, -2.16), GREY).add("satin", rbox(1.72, 0.26, 0.03, 0.01, 0, 0.64, -2.175), BLACK);
  k.add("gloss", rbox(0.46, 0.13, 0.012, 0.005, 0, 0.5, -2.215), 0xe9e9e4);
  k.add("satin", rbox(1.9, 0.09, 2.36, 0.02, 0, 0.235, 0.02), GREY).add("paint", rbox(1.905, 0.045, 2.2, 0.01, 0, 0.31, 0.02));      // sills, and the team's stripe along them
  k.both("satin", s => rod([s * 0.3, 0.607, 2.02], [s * 0.3, 0.802, 0.92], 0.006, 5), BLACK);                                       // the bonnet's two creases
  for (const s of [1, -1]) {
    for (const x of [0.47, 0.7]) k.add("glow", rbox(0.2, 0.085, 0.02, 0.01, s * x, 0.5, 2.185), [2.0, 1.95, 1.8]);
    k.add("glow", rbox(0.1, 0.05, 0.02, 0.01, s * 0.84, 0.37, 2.2), LAMP_AMBER);
    for (const [col, x] of [[0, 0.38], [1, 0.55], [2, 0.72]]) for (const [row, y] of [[0, 0.69], [1, 0.59]])
      k.add("glow", rbox(0.15, 0.085, 0.02, 0.008, s * x, y, -2.195), col === 2 ? LAMP_AMBER : col === 0 && row ? [1.7, 1.7, 1.6] : LAMP_RED);
    k.add("satin", rbox(0.014, 0.05, 3.9, 0.006, s * 0.934, 0.52, -0.02), BLACK);                                                  // the rubbing strip
    for (const [z, top] of [[0.95, 0.8], [-0.58, 0.84]]) k.add("satin", rod([s * 0.936, 0.3, z], [s * 0.936, top, z], 0.005, 5), BLACK);      // the doors' edges
    k.add("satin", archLip(0.37, s * 0.94, 0.3, 1.22), BLACK).add("satin", archLip(0.4, s * 0.94, 0.33, -1.2), BLACK);
    k.add("satin", rbox(0.13, 0.085, 0.07, 0.02, s * 1.0, 0.88, 0.74), BLACK).add("satin", rod([s * 0.93, 0.84, 0.74], [s * 0.97, 0.87, 0.74], 0.015, 5), BLACK);      // mirrors
    k.add("chrome", cylZ(0.035, 0.035, 0.12, s * 0.5, 0.26, -2.18, 12), 0xdddddd);
    // the time machine's own works: a vent each side of the deck, and a coil and a cable down each flank
    k.add("satin", rbox(0.5, 0.2, 0.52, 0.03, s * 0.36, 0.95, -1.8), 0x26282c).add("glow", rbox(0.4, 0.02, 0.42, 0.005, s * 0.36, 1.046, -1.8), [0.2, 0.5, 1.3]);
    for (let j = 0; j < 6; j++) k.add("metal", box(0.44, 0.012, 0.035, s * 0.36, 1.062, -2.0 + j * 0.08), 0x8c9096);
    k.add("aura", rod([s * 0.95, 0.63, 1.3], [s * 0.95, 0.68, -1.95], 0.03, 8)).add("satin", rod([s * 0.955, 0.585, 1.3], [s * 0.955, 0.63, -1.95], 0.016, 6), BLACK);
    for (let j = 0; j < 6; j++) k.add("satin", rbox(0.03, 0.1, 0.05, 0.008, s * 0.945, 0.615 + j * 0.008, 1.15 - j * 0.6), GREY);
  }
  k.add("gloss", cylY(0.115, 0.125, 0.24, 0, 1.04, -2.0, 18), 0xeeeeea).add("satin", cylY(0.14, 0.14, 0.05, 0, 0.9, -2.0, 18), GREY)      // the little fusion unit
   .add("satin", cylY(0.07, 0.11, 0.07, 0, 1.195, -2.0, 14), GREY).add("metal", new THREE.TorusGeometry(0.122, 0.012, 6, 18).rotateX(Math.PI / 2).translate(0, 1.0, -2.0), 0x8c9096);
  k.add("metal", rod([-0.7, 0.86, -1.6], [-0.74, 1.5, -1.75], 0.006, 5), 0x8c9096);                                                // aerial
  return { lumps: k.join(), wheel: [wheelKind(0.305, 0.2, 0.19, "turbine"), wheelKind(0.335, 0.24, 0.2, "turbine")],
           wheels: [[0.86, 1.22, true, 0], [-0.86, 1.22, true, 0], [0.87, -1.2, false, 1], [-0.87, -1.2, false, 1]],
           tall: 0, pod: [0, 1.3, 0.32], blob: [0.95, 0.82], lightning: true, shell: [1.0, 0.62, 0.62, 2.3] };
};

// ---- a hot dog on wheels: the sausage lying in a split bun, toasted along its top, with the bun's skirt and its
// badge in the team's colours
SHAPES.wiener = () => {
  const k = new Kit(), DOG = 0xb23f29, DARK = 0x17181b, CHROME = 0xe8e8e8;
  const crust = fade(0xf3cb7c, 0xc4853a, (x, y) => (y - 1.0) / 0.34);       // pale down the sides, browned on top
  const half = s => [[2.34, 0.88, 0.14, 0.14, 0.18], [2.24, 0.88, 0.3, 0.28, 0.3], [1.9, 0.89, 0.42, 0.4, 0.4], [1.3, 0.9, 0.47, 0.45, 0.43], [0, 0.9, 0.48, 0.46, 0.43],
                     [-1.3, 0.9, 0.47, 0.45, 0.43], [-1.9, 0.89, 0.42, 0.4, 0.4], [-2.24, 0.88, 0.3, 0.28, 0.3], [-2.34, 0.88, 0.14, 0.14, 0.18]]
    .map(([z, y, w, up, down]) => [z, y, w, up, down, 2.3, 3, s * 0.5]);
  for (const s of [1, -1]) k.add("gloss", loft(half(s), { around: 28 }), crust);                                    // the two halves of the bun
  k.add("paint", loft([[2.3, 0.5, 0.56, 0.12, 0.14], [2.16, 0.5, 0.86, 0.15, 0.17], [1.3, 0.5, 0.975, 0.16, 0.18], [-1.3, 0.5, 0.975, 0.16, 0.18], [-2.16, 0.5, 0.86, 0.15, 0.17], [-2.3, 0.5, 0.56, 0.12, 0.14]]
    .map(q => [...q, 2.2, 3.2]), { around: 32 }));                                                                   // the skirt, down over the wheels
  const dog = [[2.775, 1.385, 0.02], [2.755, 1.388, 0.11], [2.69, 1.4, 0.22], [2.56, 1.42, 0.32], [2.36, 1.455, 0.395], [2.0, 1.495, 0.435], [1.2, 1.52, 0.445], [0, 1.53, 0.445],
               [-1.2, 1.52, 0.445], [-2.0, 1.495, 0.435], [-2.36, 1.455, 0.395], [-2.56, 1.42, 0.32], [-2.69, 1.4, 0.22], [-2.755, 1.388, 0.11], [-2.775, 1.385, 0.02]]
    .map(([z, y, r]) => [z, y, r, r, r, 2, 2]);
  k.add("gloss", loft(dog, { around: 32 }), fade(DOG, 0x8f2f1f, (x, y) => (1.3 - y) / 0.4));                        // the sausage, its ends dipping a little
  // glass: a screen wrapped over the front of the sausage, and three windows down each side, in bright frames
  const strip = (zs, arc, slot, lift, colour) => k.add(slot, loft(zs.map(z => between(dog, z)), { around: 32, arc, lift }), colour);
  strip([2.62, 2.5, 2.3, 2.05, 1.8, 1.62], [0.3, 0.7], "glass", 0.012);
  strip([2.66, 2.62], [0.29, 0.71], "chrome", 0.016, CHROME); strip([1.62, 1.57], [0.29, 0.71], "chrome", 0.016, CHROME);
  for (const [z0, z1] of [[1.4, 0.75], [0.6, -0.05], [-0.2, -0.85]]) for (const arc of [[0.275, 0.365], [0.635, 0.725]]) {
    strip([z0, (z0 + z1) / 2, z1], arc, "glass", 0.012);
    strip([z0 + 0.03, z0], arc, "chrome", 0.015, CHROME); strip([z1, z1 - 0.03], arc, "chrome", 0.015, CHROME);
  }
  for (const arc of [[0.268, 0.275], [0.365, 0.372], [0.628, 0.635], [0.725, 0.732]]) strip([1.43, 0.3, -0.88], arc, "chrome", 0.015, CHROME);
  const top = z => { const q = between(dog, z); return q[1] + q[3]; }, squiggle = [];
  for (let i = 0; i <= 16; i++) { const z = -1.9 + i * 3.3 / 16; squiggle.push(V3(i % 2 ? 0.12 : -0.12, top(z) - 0.014, z)); }
  k.add("gloss", new THREE.TubeGeometry(new THREE.CatmullRomCurve3(squiggle), 110, 0.048, 8), 0xf7cf1a);            // mustard
  for (const s of [1, -1]) {
    lamp(k, s * 0.5, 0.9, 2.345, 0.105, LAMP_WHITE); lamp(k, s * 0.5, 0.9, -2.345, 0.09, LAMP_RED, -1);
    k.add("glow", ball(0.045, 0.045, 0.03, s * 0.76, 0.84, 2.21, 8), LAMP_AMBER).add("glow", ball(0.04, 0.04, 0.03, s * 0.76, 0.84, -2.21, 8), LAMP_AMBER);
    k.add("second", ball(0.022, 0.2, 0.36, s * 0.972, 0.94, 0.2, 18)).add("paint", ball(0.026, 0.14, 0.27, s * 0.972, 0.94, 0.2, 18));      // the badge
    for (const z of [1.5, -1.5]) k.add("satin", archLip(0.44, s * 0.985, 0.38, z, 0.03), DARK);
    for (const z of [0.95, -0.55]) k.add("satin", sweep([[s * 0.972, 0.6, z, 0.006], [s * 0.984, 0.9, z, 0.006], [s * 0.93, 1.14, z, 0.006], [s * 0.82, 1.27, z, 0.006]], { around: 5 }), DARK);      // a door
    k.add("chrome", rbox(0.03, 0.035, 0.16, 0.012, s * 0.992, 0.98, 0.72), CHROME);                                // its handle
    k.add("satin", rbox(0.1, 0.07, 0.05, 0.02, s * 1.03, 1.3, 1.55), DARK).add("satin", rod([s * 0.9, 1.22, 1.55], [s * 1.0, 1.29, 1.55], 0.012, 5), DARK);      // mirrors
  }
  for (const z of [1, -1]) k.add("chrome", sweep([[-0.8, 0.42, z * 2.2, 0.045], [-0.52, 0.42, z * 2.4, 0.045], [0.52, 0.42, z * 2.4, 0.045], [0.8, 0.42, z * 2.2, 0.045]], { around: 10 }), CHROME);      // bumpers
  k.add("satin", rbox(0.5, 0.12, 0.03, 0.01, 0, 0.56, 2.345), DARK);                                                // the grille, under the sausage's chin
  for (let j = -2; j <= 2; j++) k.add("chrome", rbox(0.012, 0.11, 0.02, 0.004, j * 0.09, 0.56, 2.36, 1), CHROME);
  return { lumps: k.join(), wheel: [wheelKind(0.38, 0.25, 0.25, "cap", { colour: 0xd4d6d9 })], wheels: [[0.9, 1.5, true], [-0.9, 1.5, true], [0.9, -1.5], [-0.9, -1.5]],
           tall: 0.75, pod: [0, 2.12, -0.5], blob: [1.1, 0.95] };
};

// ---- an F1 car out of toy bricks: every piece its own, seams between them, studs on top, slopes for the bodywork
MAKE.brick = () => {
  const k = new Kit(), S = 0.25, GAP = 0.007, BLACK = 0x1b1c1f, GREY = 0xa9adb3, YELLOW = 0xf6cd2e;
  const stud = (slot, x, y, z, colour) => k.add(slot, cylY(0.078, 0.078, 0.045, x, y + 0.02, z, 12), colour);
  const piece = (slot, w, l, h, x, y, z, colour, tile) => {      // w by l studs and h tall, its middle at x, z and its underside at y; a tile has no studs
    k.add(slot, rbox(w * S - GAP, h - GAP / 2, l * S - GAP, 0.012, x, y + h / 2, z, 1), colour);
    if (!tile) for (let i = 0; i < w; i++) for (let j = 0; j < l; j++) stud(slot, x + (i - (w - 1) / 2) * S, y + h - GAP / 4, z + (j - (l - 1) / 2) * S, colour);
  };
  const run = (slot, w, l, h, x, y, z, colour, tile, cut = 4) => {   // a row of pieces filling w by l studs, cut so the seams show
    for (let done = 0; done < l;) { const n = Math.min(cut, l - done); piece(slot, w, n, h, x, y, z - l * S / 2 + (done + n / 2) * S, colour, tile); done += n; }
  };
  const slope = (slot, w, l, h, x, y, z, dir, colour) => {           // a wedge falling from h to a lip, towards the front (dir 1) or the back (-1), one row of studs on its high end
    const a = l * S / 2 - GAP / 2;
    k.add(slot, slab([[-a * dir, 0], [-a * dir, h], [(-a + S * 0.92) * dir, h], [a * dir, 0.05], [a * dir, 0]], w * S - GAP).translate(x, y, z), colour);
    for (let i = 0; i < w; i++) stud(slot, x + (i - (w - 1) / 2) * S, y + h, z - dir * (l - 1) / 2 * S, colour);
  };
  run("satin", 4, 22, 0.1, 0, 0.16, 0.0, BLACK, true); run("satin", 2, 8, 0.1, 0.75, 0.16, -0.5, BLACK, true); run("satin", 2, 8, 0.1, -0.75, 0.16, -0.5, BLACK, true);      // the floor
  run("paint", 2, 5, 0.3, 0, 0.26, 1.875); slope("paint", 2, 2, 0.3, 0, 0.26, 2.75, 1); slope("paint", 2, 3, 0.2, 0, 0.56, 1.875, 1);                                          // the nose
  piece("second", 6, 2, 0.1, 0, 0.1, 2.875); piece("paint", 2, 2, 0.1, 0.5, 0.2, 2.875, undefined, true); piece("paint", 2, 2, 0.1, -0.5, 0.2, 2.875, undefined, true);   // the front wing
  for (const s of [1, -1]) {
    piece("paint", 1, 3, 0.3, s * 0.875, 0.1, 2.75, undefined, true);
    run("paint", 1, 6, 0.3, s * 0.375, 0.26, 0.5); piece("paint", 1, 5, 0.1, s * 0.375, 0.56, 0.375, undefined, true);                                                        // the tub's sides
    piece("satin", 2, 1, 0.3, s * 0.75, 0.26, 0.375, BLACK, true); run("paint", 2, 4, 0.3, s * 0.75, 0.26, -0.25); slope("paint", 2, 3, 0.3, s * 0.75, 0.26, -1.125, -1);       // sidepods: a dark mouth, the pod, its tail
    piece("satin", 1, 1, 0.5, s * 0.5, 0.36, -2.4, BLACK, true);                                                                                                               // the rear wing's posts
    k.add("paint", rbox(0.07, 0.6, 0.72, 0.012, s * 0.8, 0.8, -2.45, 1));
    k.add("satin", rbox(0.13, 0.07, 0.04, 0.012, s * 0.58, 0.72, 0.95, 1), BLACK).add("satin", rod([s * 0.42, 0.6, 0.95], [s * 0.55, 0.7, 0.95], 0.014, 5), BLACK);            // mirrors
    k.add("satin", sweep([[s * 0.3, 0.62, -0.1, 0.034], [s * 0.3, 0.9, 0.18, 0.034], [s * 0.2, 0.93, 0.7, 0.034], [0, 0.92, 1.0, 0.034]], { around: 8 }), BLACK);              // the halo
    k.add("second", sweep([[s * 0.2, 0.74, 0.22, 0.05], [s * 0.2, 0.66, 0.42, 0.045], [s * 0.1, 0.62, 0.62, 0.04]], { around: 8 })).add("gloss", ball(0.05, 0.05, 0.05, s * 0.1, 0.62, 0.64, 8), YELLOW);      // arms, hands
    k.add("satin", cylX(0.05, 0.24, s * 0.72, 0.4, 1.9, 8), BLACK).add("satin", cylX(0.05, 0.2, s * 0.74, 0.44, -1.75, 8), BLACK);                                              // axles
  }
  k.add("satin", rod([0, 0.92, 1.0], [0, 0.56, 1.16], 0.034, 8), BLACK);
  piece("satin", 2, 1, 0.42, 0, 0.26, -0.125, BLACK, true); piece("paint", 2, 2, 0.3, 0, 0.56, -0.5);                                                                         // seat back, headrest
  run("paint", 2, 7, 0.3, 0, 0.26, -1.125); slope("paint", 2, 5, 0.3, 0, 0.56, -1.375, -1);                                                                                     // engine cover
  piece("second", 2, 1, 0.24, 0, 0.86, -0.5); k.add("satin", rbox(0.3, 0.14, 0.02, 0.006, 0, 0.99, -0.372, 1), BLACK);                                                        // airbox, its mouth
  k.add("second", slab([[-0.66, 0.86], [-0.66, 1.12], [-2.2, 0.6], [-2.2, 0.58], [-0.9, 0.58]], 0.06));                                                                        // the fin
  piece("second", 6, 2, 0.1, 0, 0.86, -2.5); piece("paint", 6, 1, 0.1, 0, 1.02, -2.625, undefined, true);                                                                     // rear wing
  k.add("glow", cylZ(0.07, 0.07, 0.05, 0, 0.36, -2.78, 10), LAMP_RED);
  // the driver: a round yellow head in a helmet, a suit in the team's second colour
  k.add("second", rbox(0.32, 0.3, 0.2, 0.03, 0, 0.6, 0.2)).add("gloss", cylY(0.14, 0.14, 0.2, 0, 0.84, 0.2, 16), YELLOW);
  k.add("second", ball(0.19, 0.19, 0.2, 0, 0.93, 0.2, 18)).add("glass", rbox(0.27, 0.085, 0.1, 0.03, 0, 0.93, 0.33)).add("paint", rbox(0.06, 0.03, 0.34, 0.012, 0, 1.115, 0.2, 1));
  k.add("satin", new THREE.TorusGeometry(0.08, 0.016, 6, 14).rotateX(0.5).translate(0, 0.64, 0.66), BLACK);
  return { lumps: k.join(), wheel: [wheelKind(0.4, 0.32, 0.22, "toy", { slot: "satin", colour: GREY }), wheelKind(0.44, 0.4, 0.24, "toy", { slot: "satin", colour: GREY })],
           wheels: [[0.9, 1.9, true, 0], [-0.9, 1.9, true, 0], [0.9, -1.75, false, 1], [-0.9, -1.75, false, 1]],
           tall: 0, pod: [0, 1.55, -1.0], blob: [1.05, 1.02], paint: { roughness: 0.16, clearcoatRoughness: 0.04, metalness: 0 } };
};

// ---- a big open 4x4 with a gun on the back and two armoured soldiers aboard: the driver in the team's first
// colour, the gunner in its second
const HOG = { driver: [0.4, 0.64, 0.27], gunner: [0, 1.25, -1.72], swing: -0.4 };      // where a sculpted driver's feet go for him to be on the seat, where a sculpted gunner stands, and how far he is turned for his gun to point ahead
function trooper(k, slot, at, pose) {    // heavy armour over a dark suit, a gold visor. `at` is the hips; the pose gives a hand, an elbow, a knee and a foot from there (the left ones: the right are their mirror)
  const [x, y, z] = at, SUIT = 0x17181b, part = (g, s = slot, c) => k.add(s, g.translate(x, y, z), c);
  const along = (a, b, f) => [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
  part(rbox(0.36, 0.2, 0.25, 0.07, 0, 0, 0), "satin", SUIT);                                                          // hips
  part(rbox(0.2, 0.15, 0.1, 0.03, 0, -0.02, 0.1));                                                                    // a plate over them
  part(sweep([[0, 0.05, 0, 0.16, 0.115], [0, 0.3, 0.01, 0.2, 0.135], [0, 0.6, 0.02, 0.22, 0.13]], { around: 12, square: 2.6 }), "satin", SUIT);      // the trunk
  part(rbox(0.3, 0.13, 0.2, 0.04, 0, 0.21, 0.035));                                                                   // belly plates
  part(rbox(0.48, 0.3, 0.3, 0.09, 0, 0.47, 0.03));                                                                    // chest plate
  part(rbox(0.16, 0.1, 0.03, 0.01, 0, 0.5, 0.185), "satin", SUIT);
  part(rbox(0.32, 0.36, 0.15, 0.04, 0, 0.44, -0.2));                                                                  // pack
  part(cylY(0.03, 0.03, 0.07, 0.09, 0.65, -0.2, 8), "metal", 0x8c9096);
  part(cylY(0.07, 0.085, 0.1, 0, 0.66, 0.02, 10), "satin", SUIT);                                                     // neck
  // the helmet: a rounded shell, a gold visor round the face, a brow over it, a jaw piece under it
  part(ball(0.158, 0.172, 0.185, 0, 0.84, 0.02, 18));
  part(new THREE.SphereGeometry(1, 18, 8, Math.PI / 2 - 0.92, 1.84, 1.12, 0.62).scale(0.164, 0.178, 0.194).translate(0, 0.84, 0.02), "chrome", 0xe9a51c);
  part(rbox(0.25, 0.05, 0.13, 0.02, 0, 0.925, 0.13));                                                                 // brow
  part(rbox(0.17, 0.075, 0.1, 0.03, 0, 0.725, 0.15));                                                                 // jaw
  part(rbox(0.06, 0.03, 0.26, 0.012, 0, 1.005, 0.0, 1));                                                              // the ridge over the top
  for (const s of [1, -1]) {
    const side = q => [s * q[0], q[1], q[2]], hand = side(pose.hand), elbow = side(pose.elbow), knee = side(pose.knee), foot = side(pose.foot);
    const shoulder = [s * 0.3, 0.54, 0.01], hip = [s * 0.11, -0.02, 0.02];
    part(cylX(0.055, 0.03, s * 0.158, 0.82, 0.02, 10));                                                               // ear pieces
    part(ball(0.135, 0.115, 0.15, s * 0.31, 0.6, 0.01, 12));                                                          // shoulder
    part(sweep([[...shoulder, 0.07], [...elbow, 0.062]], { around: 8 }), "satin", SUIT);                              // upper arm
    part(sweep([[...along(shoulder, elbow, 0.3), 0.083], [...along(shoulder, elbow, 0.75), 0.078]], { around: 8 }));  // its plate
    part(sweep([[...elbow, 0.085], [...along(elbow, hand, 0.85), 0.07]], { around: 8 }));                             // forearm
    part(ball(0.066, 0.066, 0.072, ...hand, 8), "satin", SUIT);
    part(sweep([[...hip, 0.105], [...along(hip, knee, 0.9), 0.092]], { around: 8 }));                                 // thigh
    part(ball(0.095, 0.095, 0.095, ...knee, 8));                                                                      // knee
    part(sweep([[...knee, 0.09], [foot[0], foot[1] + 0.12, foot[2], 0.08]], { around: 8 }));                          // shin
    part(rbox(0.15, 0.13, 0.3, 0.045, foot[0], foot[1] + 0.055, foot[2] + 0.05), "satin", SUIT);                      // boot
    part(rbox(0.13, 0.05, 0.14, 0.02, foot[0], foot[1] + 0.125, foot[2] + 0.1));                                      // its toe cap
  }
}
SHAPES.warthog = (got = {}) => {
  const k = new Kit(), OLIVE = 0x5b6839, DEEP = 0x3d4727, GUN = 0x24262a, IRON = 0x8d9096, HAZARD = 0xd9a514;
  // the tub: a low nose, a bonnet rising to the scuttle, a well for the crew, a flat bed behind
  const hull = [[2.3, 0.84, 0.5, 0.1, 0.18, 6], [2.05, 0.86, 0.68, 0.2, 0.27, 6], [1.2, 0.9, 0.76, 0.36, 0.34, 5], [1.0, 0.9, 0.8, 0.4, 0.36, 5], [0.93, 0.8, 0.8, 0.17, 0.26, 7],
                [-0.5, 0.8, 0.8, 0.17, 0.26, 7], [-0.6, 0.88, 0.8, 0.34, 0.34, 7], [-2.2, 0.88, 0.8, 0.34, 0.32, 7], [-2.38, 0.86, 0.7, 0.24, 0.22, 6]];
  k.add("satin", loft(hull, { around: 36 }), OLIVE);
  const onBonnet = (g, y, z) => g.rotateX(0.232).translate(0, y, z);          // lying on the bonnet's slope
  k.add("satin", onBonnet(rbox(0.86, 0.05, 0.8, 0.02, 0, 0, 0), 1.165, 1.6), DEEP).add("paint", onBonnet(rbox(0.3, 0.06, 0.82, 0.02, 0, 0, 0), 1.168, 1.6));      // a raised panel, and the team's stripe down it
  k.both("satin", s => onBonnet(rbox(0.16, 0.064, 0.3, 0.015, s * 0.29, 0, 0), 1.176, 1.48), 0x15161a);                // vents
  k.add("satin", rbox(0.84, 0.18, 0.04, 0.01, 0, 0.82, 2.31), 0x15161a);                                               // the grille
  for (let j = -3; j <= 3; j++) k.add("satin", rbox(0.03, 0.18, 0.03, 0.008, j * 0.1, 0.82, 2.325, 1), OLIVE);
  k.add("satin", rbox(1.56, 0.16, 0.14, 0.03, 0, 0.6, 2.38), GUN);                                                     // the bumper, with hazard blocks
  for (const x of [-0.63, -0.21, 0.21, 0.63]) k.add("satin", rbox(0.2, 0.165, 0.02, 0.005, x, 0.6, 2.452, 1), HAZARD);
  k.add("metal", cylX(0.075, 0.3, 0, 0.6, 2.49, 12), IRON).add("satin", rbox(0.05, 0.2, 0.2, 0.01, 0.17, 0.6, 2.47), GUN).add("satin", rbox(0.05, 0.2, 0.2, 0.01, -0.17, 0.6, 2.47), GUN);      // the winch
  k.add("satin", rbox(1.3, 0.22, 0.26, 0.05, 0, 1.19, 0.86), GUN).add("glow", rbox(0.22, 0.05, 0.01, 0.004, 0.4, 1.23, 0.727), [0.25, 0.8, 1.1]);      // the dash
  k.add("satin", rbox(1.56, 0.03, 1.74, 0.01, 0, 1.235, -1.47), DEEP);                                                 // the bed's deck
  const arch = z => [[z + 0.84, 0.82], [z + 0.76, 1.05], [z + 0.48, 1.32], [z - 0.48, 1.32], [z - 0.76, 1.05], [z - 0.84, 0.82], [z - 0.72, 0.82], [z - 0.65, 1.0], [z - 0.42, 1.2], [z + 0.42, 1.2], [z + 0.65, 1.0], [z + 0.72, 0.82]];
  for (const s of [1, -1]) {
    lamp(k, s * 0.3, 0.84, 2.335, 0.07, LAMP_WHITE); lamp(k, s * 0.44, 0.84, 2.33, 0.05, LAMP_WHITE);
    k.add("metal", sweep([[s * 0.42, 0.56, 2.36, 0.05], [s * 0.42, 0.5, 2.6, 0.05], [s * 0.42, 0.58, 2.76, 0.045], [s * 0.42, 0.74, 2.8, 0.035], [s * 0.42, 0.86, 2.74, 0.022]], { around: 8 }), IRON);      // a tusk
    for (const z of [1.62, -1.62]) {
      k.add("satin", slab(arch(z), 0.58, s * 1.03), OLIVE);                                                            // a thick wing over the wheel...
      k.add("paint", slab([[z + 0.4, 1.31], [z + 0.4, 1.345], [z - 0.4, 1.345], [z - 0.4, 1.31]], 0.38, s * 1.03));    // ...with the team's colour on top
      k.add("metal", rod([s * 0.6, 0.72, z + 0.16], [s * 0.94, 0.56, z], 0.03, 6), IRON).add("metal", rod([s * 0.6, 0.72, z - 0.16], [s * 0.94, 0.56, z], 0.03, 6), IRON);    // wishbones
      k.add("metal", rod([s * 0.62, 1.1, z], [s * 0.9, 0.62, z], 0.045, 8), 0xb9882a).add("satin", rod([s * 0.66, 1.04, z], [s * 0.86, 0.7, z], 0.058, 8), GUN);              // spring and damper
    }
    k.add("glow", rbox(0.3, 0.07, 0.02, 0.008, s * 1.03, 0.95, 2.435), LAMP_AMBER).add("glow", rbox(0.3, 0.08, 0.02, 0.008, s * 1.03, 0.95, -2.435), LAMP_RED);      // markers on the wings' ends
    k.add("satin", rbox(0.34, 0.07, 1.62, 0.02, s * 0.96, 0.84, 0), DEEP).add("metal", rod([s * 1.14, 0.8, 0.74], [s * 1.14, 0.8, -0.74], 0.03, 6), IRON);      // a step between them
    k.add("satin", rbox(0.16, 0.26, 1.46, 0.04, s * 0.72, 1.08, 0.2), OLIVE);                                          // the well's side
    k.add("satin", rbox(0.46, 0.1, 0.46, 0.04, s * 0.4, 1.02, 0.02), GUN).add("satin", rbox(0.46, 0.62, 0.12, 0.05, 0, 0, 0).rotateX(-0.16).translate(s * 0.4, 1.34, -0.27), GUN)      // a seat
     .add("satin", rbox(0.24, 0.15, 0.1, 0.04, s * 0.4, 1.72, -0.34), GUN);
    k.add("satin", sweep([[s * 0.76, 1.3, 0.98, 0.04], [s * 0.72, 2.0, 0.66, 0.04], [0, 2.03, 0.65, 0.04]], { around: 8 }), GUN);                 // the screen's frame
    k.add("satin", sweep([[s * 0.8, 1.2, -0.56, 0.05], [s * 0.76, 2.16, -0.62, 0.05], [0, 2.2, -0.62, 0.05]], { around: 8 }), GUN);               // the roll hoop...
    k.add("satin", rod([s * 0.74, 2.14, -0.62], [s * 0.72, 1.26, -2.2], 0.04, 6), GUN).add("satin", rod([s * 0.74, 2.16, -0.6], [s * 0.72, 2.0, 0.66], 0.03, 6), GUN);      // ...its stay, and a bar forward to the screen
    k.add("satin", rod([s * 0.76, 1.25, -0.75], [s * 0.76, 1.5, -0.75], 0.022, 5), GUN).add("satin", rod([s * 0.76, 1.5, -0.75], [s * 0.74, 1.5, -2.25], 0.022, 5), GUN)       // the bed's rails
     .add("satin", rod([s * 0.74, 1.25, -2.25], [s * 0.74, 1.5, -2.25], 0.022, 5), GUN).add("satin", rod([s * 0.75, 1.25, -1.5], [s * 0.75, 1.5, -1.5], 0.022, 5), GUN);
    k.add("satin", rbox(0.2, 0.42, 0.3, 0.04, s * 0.58, 1.46, -2.14), DEEP).add("metal", cylY(0.04, 0.04, 0.05, s * 0.58, 1.69, -2.06, 8), IRON)                              // a can each side, strapped down
     .add("satin", rbox(0.21, 0.03, 0.31, 0.008, s * 0.58, 1.5, -2.14, 1), GUN);
    k.add("chrome", cylZ(0.04, 0.045, 0.3, s * 0.36, 0.62, -2.42, 10), 0xb9bdc3);                                      // exhausts
  }
  k.add("tint", slab([[0.975, 1.3], [0.655, 2.0], [0.635, 2.0], [0.955, 1.3]], 1.44));                                 // the screen
  k.add("satin", rod([0, 1.3, 0.975], [0, 2.02, 0.65], 0.022, 5), GUN);
  if (!got.driver) k.add("satin", new THREE.TorusGeometry(0.17, 0.022, 6, 18).rotateX(-0.45).translate(0.4, 1.38, 0.6), GUN).add("satin", rod([0.4, 1.38, 0.6], [0.4, 1.24, 0.84], 0.022, 5), GUN);      // the wheel (a sculpted driver brings his own)
  const bodies = [];
  if (got.driver) bodies.push({ sculpt: got.driver, at: HOG.driver, tint: ["paint"], look: { roughness: 0.45 } });
  if (got.gunner) bodies.push({ sculpt: got.gunner, at: HOG.gunner, turn: HOG.swing, tint: ["second"], look: { roughness: 0.45 } });
  if (!got.gunner) {
  // the gun: a ring on the deck, a pedestal, three long barrels in a cluster, a box of belts, a shield either side
  const GY = 2.4, bar = a => [0.055 * Math.cos(a * 2.094 + 1.57), GY + 0.055 * Math.sin(a * 2.094 + 1.57)];
  k.add("satin", cylY(0.42, 0.42, 0.06, 0, 1.28, -1.3, 24), GUN).add("metal", new THREE.TorusGeometry(0.42, 0.025, 6, 28).rotateX(Math.PI / 2).translate(0, 1.31, -1.3), IRON)
   .add("satin", cylY(0.085, 0.19, 0.98, 0, 1.8, -1.3, 12), GUN).add("satin", rbox(0.4, 0.1, 0.16, 0.03, 0, GY - 0.12, -1.3), GUN)
   .add("satin", rbox(0.22, 0.22, 0.66, 0.04, 0, GY, -1.25), GUN).add("satin", cylZ(0.1, 0.1, 0.18, 0, GY, -0.85, 14), GUN)
   .add("satin", rbox(0.24, 0.28, 0.36, 0.03, 0.27, GY - 0.06, -1.28), DEEP).add("metal", rod([0.2, GY + 0.06, -1.2], [0.08, GY + 0.1, -1.1], 0.03, 6), 0xb9882a);
  for (let a = 0; a < 3; a++) k.add("metal", rod([bar(a)[0], bar(a)[1], -0.94], [bar(a)[0], bar(a)[1], 0.32], 0.03, 8), 0x5a5d63);
  for (const z of [-0.3, 0.27]) k.add("satin", cylZ(0.098, 0.098, 0.05, 0, GY, z, 14), GUN);
  for (const s of [1, -1]) {
    k.add("satin", rbox(0.04, 0.24, 0.2, 0.01, s * 0.2, GY - 0.02, -1.3), GUN);                                        // the yoke's cheeks
    k.add("satin", rbox(0.4, 0.46, 0.03, 0.01, 0, 0, 0).rotateY(s * -0.35).translate(s * 0.33, GY + 0.02, -0.95), OLIVE);      // shields
    k.add("satin", rod([s * 0.1, GY, -1.56], [s * 0.14, GY, -1.7], 0.02, 5), GUN).add("satin", rod([s * 0.14, GY - 0.08, -1.7], [s * 0.14, GY + 0.08, -1.7], 0.024, 6), GUN);      // grips
  }
  trooper(k, "second", [0, 2.11, -2.0], { hand: [0.14, GY - 2.11, 0.3], elbow: [0.36, 0.28, 0.06], knee: [0.15, -0.42, 0.05], foot: [0.17, -0.85, 0.0] });
  }
  k.add("metal", rod([-0.74, 1.25, -2.3], [-0.74, 2.95, -2.36], 0.008, 5), IRON).add("second", slab([[-2.36, 2.95], [-2.36, 2.73], [-2.72, 2.84]], 0.01, -0.74));      // an aerial with a pennant
  if (!got.driver) trooper(k, "paint", [0.4, 1.17, 0.0], { hand: [0.15, 0.2, 0.58], elbow: [0.34, 0.28, 0.3], knee: [0.14, 0.07, 0.44], foot: [0.14, -0.3, 0.66] });
  return { bodies, lumps: k.join(), wheel: [wheelKind(0.56, 0.44, 0.3, "dish", { tread: 18, colour: 0x2c2e32 })], wheels: [[1.03, 1.62, true], [-1.03, 1.62, true], [1.03, -1.62], [-1.03, -1.62]],
           tall: 1.75, pod: [0, 2.15, 0.95], blob: [1.2, 0.95] };
};

// ---- two horses and a racing chariot: the car's front in the team's colour and the driver's tunic too; his
// crest and cloak, and the horses' saddle cloths, in its second. The horses gallop, their legs folding as they
// come forward, as fast as horses can however fast the car is going.
const HORSE_AT = 1.6, MAN_AT = [0, 0.695, -1.5], REINS_FROM = [0.18, 1.81, -0.84];      // where a sculpted horse's middle stands ahead of the car's, where the sculpted driver's feet are, and where his fists are
const HORSE_LEGS = [                    // a sculpted horse's legs, in its own space (nose to +z, its middle at 0, hooves on y = 0): see limbed()
  { key: "FL", x: [0.03, 0.4], z: [0.22, 0.72], top: [0.16, 1.02, 0.46], knee: [0.16, 0.51, 0.46], reach: 0.47, bend: 0.08 },
  { key: "FR", x: [-0.4, -0.03], z: [0.22, 0.72], top: [-0.16, 1.02, 0.46], knee: [-0.16, 0.51, 0.46], reach: 0.47, bend: 0.08 },
  { key: "HL", x: [0.03, 0.4], z: [-0.95, -0.38], top: [0.17, 0.95, -0.55], knee: [0.17, 0.49, -0.74], reach: 0.45, bend: 0.07 },
  { key: "HR", x: [-0.4, -0.03], z: [-0.95, -0.38], top: [-0.17, 0.95, -0.55], knee: [-0.17, 0.49, -0.74], reach: 0.45, bend: 0.07 },
];
function horse(k, X) {                  // one horse standing at X across the car, nose forward; gives back its legs, to be hinged: four upper halves, and the lower halves that hang from them
  const HAIR = 0x1b1512, TACK = 0x3a2416, POINTS = 0x5a4a40;
  const barrel = [[2.26, 1.27, 0.1, 0.12, 0.16, 2.2, 2.2, X], [2.14, 1.26, 0.21, 0.24, 0.28, 2.3, 2.3, X], [1.9, 1.25, 0.26, 0.29, 0.33, 2.3, 2.4, X], [1.45, 1.22, 0.275, 0.25, 0.31, 2.4, 2.4, X],
                  [1.02, 1.24, 0.28, 0.28, 0.29, 2.4, 2.3, X], [0.74, 1.25, 0.25, 0.25, 0.26, 2.3, 2.3, X], [0.6, 1.27, 0.13, 0.14, 0.16, 2.2, 2.2, X]];
  k.add("coat", loft(barrel, { around: 20 }));
  k.add("coat", sweep([[X, 1.33, 2.0, 0.16, 0.28], [X, 1.6, 2.25, 0.125, 0.22], [X, 1.86, 2.43, 0.1, 0.165], [X, 2.03, 2.52, 0.088, 0.13]], { around: 12 }));      // neck
  k.add("coat", sweep([[X, 2.06, 2.49, 0.09, 0.12], [X, 2.0, 2.63, 0.1, 0.145], [X, 1.86, 2.83, 0.076, 0.1], [X, 1.76, 2.95, 0.062, 0.075]], { around: 12 }),
        fade(0xffffff, 0x6a5a50, (x, y, z) => (z - 2.74) / 0.2));                                                                                                    // head, darker to the muzzle
  k.add("coat", ball(0.064, 0.06, 0.066, X, 1.745, 2.965, 10), 0x4a403a);
  for (const s of [1, -1]) {
    k.add("coat", new THREE.ConeGeometry(0.036, 0.15, 6).rotateX(0.25).translate(X + s * 0.056, 2.175, 2.49));                                                      // ears
    k.add("gloss", ball(0.023, 0.023, 0.023, X + s * 0.094, 2.012, 2.655, 8), 0x0b0908);                                                                            // eyes
    k.add("matte", ball(0.012, 0.016, 0.02, X + s * 0.036, 1.755, 3.012, 6), 0x1a1412);                                                                             // nostrils
  }
  k.add("matte", sweep([[X, 1.56, 1.86, 0.022, 0.06], [X, 1.8, 2.12, 0.026, 0.09], [X, 2.04, 2.34, 0.026, 0.085], [X, 2.17, 2.47, 0.022, 0.055], [X, 2.11, 2.6, 0.018, 0.04]], { around: 8 }), HAIR);      // mane and forelock
  k.add("matte", sweep([[X, 1.4, 0.63, 0.045, 0.045], [X, 1.44, 0.4, 0.06, 0.07], [X, 1.36, 0.1, 0.07, 0.09], [X, 1.16, -0.14, 0.06, 0.08], [X, 0.95, -0.26, 0.025, 0.035]], { around: 10 }), HAIR);      // tail, streaming
  // harness: a collar round the chest, a girth, a saddle cloth, a noseband
  k.add("satin", loft([between(barrel, 2.15), between(barrel, 2.02)], { around: 20, arc: [0, 1], lift: 0.014 }), TACK);
  k.add("satin", loft([between(barrel, 1.84), between(barrel, 1.76)], { around: 20, arc: [0, 1], lift: 0.012 }), TACK);
  k.add("second", loft([between(barrel, 1.92), between(barrel, 1.72), between(barrel, 1.52)], { around: 20, arc: [0.3, 0.7], lift: 0.016 }));
  k.add("metal", loft([between(barrel, 1.93), between(barrel, 1.915)], { around: 20, arc: [0.3, 0.7], lift: 0.02 }), 0xd9a92e).add("metal", loft([between(barrel, 1.525), between(barrel, 1.51)], { around: 20, arc: [0.3, 0.7], lift: 0.02 }), 0xd9a92e);
  k.add("satin", new THREE.TorusGeometry(0.072, 0.011, 5, 12).rotateX(0.62).translate(X, 1.85, 2.85), TACK);
  const down = fade(0xffffff, POINTS, (x, y) => (-y - 0.1) / 0.36);                                                  // the legs darken towards the knee
  const limb = (path, colour, hoof) => { const g = new Kit().add("coat", sweep(path, { around: 10 }), colour); if (hoof) g.add("coat", sweep(hoof, { around: 10 }), 0x191512); return g.join(); };
  const foreUp = () => limb([[0, 0.1, 0, 0.1, 0.13], [0, -0.2, 0.02, 0.075, 0.09], [0, -0.44, 0.03, 0.052, 0.058]], down);
  const foreLow = () => limb([[0, 0.02, 0, 0.05, 0.056], [0, -0.3, -0.03, 0.036, 0.04], [0, -0.44, 0, 0.044, 0.05]], POINTS, [[0, -0.44, 0, 0.05, 0.055], [0, -0.55, 0.04, 0.058, 0.07], [0, -0.62, 0.05, 0.062, 0.076]]);
  const hindUp = () => limb([[0, 0.08, 0, 0.12, 0.18], [0, -0.2, 0.08, 0.095, 0.13], [0, -0.42, 0.12, 0.068, 0.085], [0, -0.66, -0.08, 0.05, 0.06]], fade(0xffffff, POINTS, (x, y) => (-y - 0.3) / 0.36));
  const hindLow = () => limb([[0, 0.02, -0.005, 0.05, 0.06], [0, -0.3, 0.05, 0.037, 0.042], [0, -0.36, 0.08, 0.045, 0.05]], POINTS, [[0, -0.36, 0.08, 0.05, 0.055], [0, -0.43, 0.12, 0.058, 0.07], [0, -0.48, 0.13, 0.062, 0.076]]);
  const out = [];
  for (const [side, s] of [["L", 1], ["R", -1]]) {
    out.push(["F" + side, foreUp(), [X + s * 0.13, 1.06, 2.0]], ["F" + side + "2", foreLow(), [0, -0.44, 0.03], "F" + side]);
    out.push(["H" + side, hindUp(), [X + s * 0.14, 1.14, 0.9]], ["H" + side + "2", hindLow(), [0, -0.66, -0.08], "H" + side]);
  }
  return out;
}
SHAPES.chariot = (got = {}) => {
  const k = new Kit(), WOOD = 0x7a5230, GOLD = 0xd9a92e, SKIN = 0xd8a67c, TACK = 0x3a2416, IRON = 0x3b3d42;
  const movers = [], bodies = [];
  for (const [n, X] of [["a", 0.5], ["b", -0.5]]) {         // the team: sculpted horses with bones in their legs where the sculpt has come, shapes on hinges where not
    if (got.horse) bodies.push({ sculpt: got.horse, key: n, at: [X, 0, HORSE_AT], tint: [null, "second", "coat"], limbs: HORSE_LEGS, look: { roughness: 0.62 } });
    else for (const [name, shapes, at, on] of horse(k, X)) movers.push([n + name, shapes, at, on && n + on]);
  }
  const man = !got.charioteer;                              // the driver typed in, when there is no sculpt of him
  if (!man) bodies.push({ sculpt: got.charioteer, at: MAN_AT, tint: ["paint", "second"], look: { roughness: 0.6 } });
  // the car: a floor on an axle, a curved front in the team's colour with its sides sweeping down behind, gold along every edge
  k.add("satin", rbox(1.5, 0.07, 1.3, 0.02, 0, 0.66, -1.45), WOOD).add("satin", cylX(0.05, 2.02, 0, 0.62, -1.45, 10), WOOD);
  k.add("paint", new THREE.CylinderGeometry(0.78, 0.78, 0.95, 24, 1, true, -Math.PI / 2, Math.PI).translate(0, 1.17, -1.2));
  k.add("metal", new THREE.TorusGeometry(0.78, 0.03, 6, 24, Math.PI).rotateX(Math.PI / 2).translate(0, 1.645, -1.2), GOLD)
   .add("metal", new THREE.TorusGeometry(0.78, 0.026, 6, 24, Math.PI).rotateX(Math.PI / 2).translate(0, 0.7, -1.2), GOLD);
  k.add("metal", cylZ(0.2, 0.2, 0.02, 0, 1.2, -0.415, 20), GOLD).add("metal", new THREE.TorusGeometry(0.27, 0.018, 6, 22).translate(0, 1.2, -0.42), GOLD);      // a boss on the front
  for (let a = 0; a < 12; a++) k.add("metal", rod([0.2 * Math.cos(a * 0.5236), 1.2 + 0.2 * Math.sin(a * 0.5236), -0.42], [0.36 * Math.cos(a * 0.5236), 1.2 + 0.36 * Math.sin(a * 0.5236), -0.44], 0.012, 4, 0.004), GOLD);      // its rays
  for (const s of [1, -1]) {
    k.add("paint", slab([[-1.2, 0.7], [-1.2, 1.645], [-1.75, 1.22], [-2.08, 0.95], [-2.08, 0.7]], 0.03, s * 0.765));
    k.add("metal", sweep([[s * 0.78, 1.645, -1.2, 0.03], [s * 0.78, 1.22, -1.75, 0.028], [s * 0.78, 0.95, -2.08, 0.026], [s * 0.78, 0.7, -2.1, 0.024]], { around: 8 }), GOLD);
    k.add("matte", rod([s * 0.62, 0.86, -0.5], got.horse ? [s * 0.8, 1.22, 2.12] : [s * 0.7, 1.3, 2.05], 0.012, 5), TACK);                          // a trace to each horse
    if (!man) continue;
    // the driver's legs and arms
    k.add("matte", sweep([[s * 0.1, 1.56, -1.45, 0.09], [s * 0.12, 1.14, -1.4, 0.07], [s * 0.13, 0.78, -1.46, 0.052]], { around: 8 }), SKIN);
    k.add("satin", rbox(0.12, 0.09, 0.26, 0.035, s * 0.13, 0.74, -1.41), TACK).add("satin", sweep([[s * 0.125, 1.0, -1.42, 0.064], [s * 0.13, 0.84, -1.45, 0.058]], { around: 8 }), TACK);      // sandals, laced up the shin
    k.add("paint", sweep([[s * 0.2, 2.0, -1.43, 0.09], [s * 0.3, 1.88, -1.4, 0.08]], { around: 8 }));                                               // a sleeve
  }
  const YOKE = got.horse ? [1.74, 2.15] : [1.47, 2.0];      // how high the yoke lies across their necks, and how far forward: just ahead of the saddles
  k.add("satin", rod([0, 0.72, -0.62], [0, YOKE[0] - 0.04, YOKE[1]], 0.045, 8), WOOD).add("satin", rod([-0.62, YOKE[0], YOKE[1]], [0.62, YOKE[0], YOKE[1]], 0.04, 8), WOOD);      // the pole and the yoke
  if (man) {
  k.add("paint", sweep([[0, 1.18, -1.45, 0.28, 0.2], [0, 1.5, -1.45, 0.2, 0.14], [0, 1.75, -1.44, 0.22, 0.14], [0, 2.0, -1.43, 0.24, 0.13], [0, 2.09, -1.43, 0.1, 0.08]], { around: 14 }));      // the tunic
  k.add("metal", sweep([[0, 1.6, -1.44, 0.205, 0.148], [0, 1.78, -1.435, 0.228, 0.15], [0, 1.97, -1.43, 0.2, 0.135]], { around: 14 }), 0xc08a2c);    // a bronze breastplate over it
  k.add("satin", sweep([[0, 1.5, -1.45, 0.205, 0.145], [0, 1.6, -1.45, 0.21, 0.15]], { around: 14 }), TACK);                                          // a belt
  k.add("matte", sweep([[0.3, 1.9, -1.4, 0.062], [0.3, 1.72, -1.2, 0.054], [0.18, 1.62, -0.9, 0.046]], { around: 8 }), SKIN)                          // the rein arm
   .add("matte", sweep([[-0.3, 1.9, -1.4, 0.062], [-0.38, 1.9, -1.62, 0.054], [-0.4, 2.12, -1.74, 0.046]], { around: 8 }), SKIN)                      // the whip arm
   .add("matte", sweep([[-0.4, 2.1, -1.74, 0.009], [-0.38, 2.6, -1.5, 0.007], [-0.3, 2.76, -0.9, 0.005], [-0.2, 2.6, -0.2, 0.003]], { around: 5 }), 0x1c1611);
  }
  for (const X of [0.5, -0.5]) k.add("matte", rod(man ? [0.18, 1.62, -0.9] : [Math.sign(X) * REINS_FROM[0], REINS_FROM[1], REINS_FROM[2]], got.horse ? [X, 1.33, 2.7] : [X, 1.84, 2.87], 0.008, 4), TACK);                              // reins
  if (man) {
  k.add("matte", cylY(0.05, 0.06, 0.1, 0, 2.12, -1.43, 8), SKIN).add("matte", ball(0.11, 0.125, 0.12, 0, 2.24, -1.42, 14), SKIN);
  k.add("metal", new THREE.SphereGeometry(0.128, 16, 8, 0, TAU, 0, 1.75).translate(0, 2.26, -1.43), GOLD)                                              // the helmet...
   .add("metal", rbox(0.03, 0.12, 0.1, 0.01, 0.105, 2.19, -1.36), GOLD).add("metal", rbox(0.03, 0.12, 0.1, 0.01, -0.105, 2.19, -1.36), GOLD);
  k.add("second", slab([[-1.24, 2.36], [-1.28, 2.5], [-1.44, 2.53], [-1.6, 2.44], [-1.63, 2.3], [-1.52, 2.36], [-1.42, 2.39]], 0.035));               // ...its crest
  k.add("second", sweep([[0, 2.02, -1.53, 0.2, 0.014], [0, 1.8, -1.72, 0.24, 0.014], [0, 1.56, -2.0, 0.27, 0.014], [0, 1.42, -2.32, 0.28, 0.012]], { around: 10, square: 6 }));      // and his cloak, streaming
  }
  // wheels: eight spokes in a wooden rim shod with iron, a gold cap on the hub
  const w = new Kit().add("rubber", spun([[0.61, -0.035], [0.65, -0.035], [0.65, 0.035], [0.61, 0.035]], 32).rotateZ(Math.PI / 2), IRON);
  w.add("satin", new THREE.TorusGeometry(0.58, 0.045, 8, 32).rotateY(Math.PI / 2), WOOD).add("satin", cylX(0.1, 0.18, 0, 0, 0, 12), WOOD)
   .add("metal", new THREE.SphereGeometry(0.075, 12, 6, 0, TAU, 0, Math.PI / 2).rotateZ(-Math.PI / 2).translate(0.09, 0, 0), GOLD);
  for (let a = 0; a < 8; a++) w.add("satin", rod([0, 0.08, 0], [0, 0.56, 0], 0.03, 6, 0.02).rotateX(a / 8 * TAU), WOOD);
  const wj = w.join();
  return { lumps: k.join(), wheel: [{ r: 0.65, w: 0.07, tyre: wj.rubber, rim: { satin: wj.satin, metal: wj.metal } }], wheels: [[0.98, -1.45], [-0.98, -1.45]], movers, bodies,
           tall: 1.25, pod: [0, 1.95, -0.55], blob: [0.001, 0.001],
           coat: i => [0x6b3f22, 0x8a4a25, 0x2a2320, 0x8d8c88, 0xe6e1d6, 0xc49a52][i % 6],
           step(alt, p, t, moved) {      // the gallop: each leg in its turn, straight as it lands and pushes, folded as it comes forward
             const v = p.speed / 3.6, go = clamp(v / 12, 0, 1);
             alt.gait = (alt.gait || 0) + moved * Math.min(v / 3.4, 3.3);                 // strides so far
             for (const [h, lag] of [["a", 0], ["b", 0.07]]) for (const [leg, when, reach, fold] of [["HL", 0, 0.5, -0.95], ["HR", 0.1, 0.5, -0.95], ["FL", 0.42, 0.62, 1.35], ["FR", 0.54, 0.62, 1.35]]) {
               const f = (alt.gait + when + lag) * TAU;
               alt.m[h + leg].rotation.x = reach * go * Math.sin(f);
               alt.m[h + leg + "2"].rotation.x = fold * go * Math.max(0, -Math.cos(f)) ** 1.2;
             }
             alt.root.position.y = 0.035 * go * Math.sin(alt.gait * 2 * TAU); alt.root.rotation.x = 0.012 * go * Math.sin(alt.gait * TAU + 1);
           } };
};

// ---- a bath duck the size of a car, in the team's colour, wearing a crash helmet and a scarf in its second. It
// has no wheels: it glides, and rocks as it goes.
SHAPES.duck = () => {
  const k = new Kit(), BILL = 0xf28c1c;
  k.add("paint", loft([[-1.66, 1.12, 0.04, 0.04, 0.04], [-1.46, 0.98, 0.24, 0.15, 0.17], [-1.05, 0.74, 0.64, 0.33, 0.42, 2.2, 3], [-0.35, 0.64, 0.92, 0.5, 0.56, 2.2, 3.4],
                       [0.35, 0.64, 0.92, 0.55, 0.56, 2.2, 3.4], [0.9, 0.68, 0.72, 0.46, 0.52, 2.2, 3], [1.22, 0.74, 0.4, 0.28, 0.34, 2.2, 2.6], [1.36, 0.78, 0.1, 0.08, 0.1]], { around: 36 }));
  k.add("paint", ball(0.46, 0.34, 0.46, 0, 1.2, 0.5, 20)).add("paint", ball(0.56, 0.54, 0.58, 0, 1.6, 0.62, 28));                                    // neck, head
  k.add("gloss", loft([[1.06, 1.5, 0.3, 0.1, 0.045, 2, 2], [1.34, 1.47, 0.31, 0.07, 0.04, 2, 2], [1.58, 1.455, 0.22, 0.045, 0.035, 2, 2], [1.67, 1.45, 0.07, 0.02, 0.02, 2, 2]], { around: 20 }), BILL)
   .add("gloss", loft([[1.06, 1.4, 0.26, 0.04, 0.06, 2, 2], [1.32, 1.39, 0.26, 0.03, 0.045, 2, 2], [1.52, 1.385, 0.17, 0.025, 0.03, 2, 2], [1.58, 1.385, 0.05, 0.015, 0.015, 2, 2]], { around: 20 }), 0xde7610);
  for (const s of [1, -1]) {
    k.add("gloss", ball(0.07, 0.115, 0.09, s * 0.345, 1.79, 1.02, 14), 0xf4f4f0).add("gloss", ball(0.05, 0.08, 0.06, s * 0.375, 1.795, 1.055, 12), 0x08080a)      // eyes
     .add("glow", ball(0.018, 0.022, 0.016, s * 0.39, 1.83, 1.1, 6), [1.8, 1.8, 1.8]).add("gloss", ball(0.012, 0.012, 0.012, s * 0.07, 1.53, 1.5, 6), 0x7a3a06);
    k.add("paint", ball(0.11, 0.36, 0.62, 0, 0, 0, 16).rotateX(-0.2).translate(s * 0.9, 0.8, -0.3)).add("paint", ball(0.09, 0.26, 0.46, 0, 0, 0, 14).rotateX(-0.32).translate(s * 0.93, 0.9, -0.66));      // wings
    k.add("chrome", new THREE.TorusGeometry(0.1, 0.02, 6, 16).rotateX(-0.75).translate(s * 0.17, 2.02, 0.98), 0xe8e8e8).add("glass", cylZ(0.095, 0.095, 0.02, 0, 0, 0, 16).rotateX(-0.75).translate(s * 0.17, 2.02, 0.975));      // goggles, pushed up
  }
  k.add("second", new THREE.SphereGeometry(0.585, 26, 12, 0, TAU, 0, 1.3).scale(1, 0.96, 1.03).rotateX(-0.22).translate(0, 1.61, 0.61));             // the helmet
  k.add("satin", new THREE.TorusGeometry(0.57, 0.022, 6, 28).rotateX(Math.PI / 2 - 0.22).translate(0, 1.76, 0.58), 0x17181b);
  k.add("second", new THREE.TorusGeometry(0.46, 0.095, 10, 24).rotateX(Math.PI / 2).translate(0, 1.2, 0.5))                                             // the scarf, and its ends
   .add("second", sweep([[-0.45, 1.2, 0.42, 0.075, 0.022], [-0.64, 1.17, 0.0, 0.085, 0.02], [-0.72, 1.1, -0.48, 0.075, 0.016]], { around: 8, square: 5 }))
   .add("second", sweep([[-0.44, 1.16, 0.4, 0.07, 0.022], [-0.66, 1.05, 0.05, 0.08, 0.02], [-0.78, 0.94, -0.36, 0.07, 0.016]], { around: 8, square: 5 }));
  return { lumps: k.join(), wheel: [], wheels: [], tall: 0.95, pod: [0, 2.4, 0.95], blob: [0.9, 0.62], paint: { roughness: 0.1, clearcoatRoughness: 0.03, metalness: 0 },
           step(alt, p, t) {             // it rocks as it goes, and leans into the corners
             alt.root.rotation.z = 0.05 * Math.sin(t * 3.1 + alt.i) - p.steer * 0.16; alt.root.rotation.x = 0.03 * Math.sin(t * 2.3 + alt.i * 2);
             alt.root.position.y = 0.02 + 0.03 * Math.sin(t * 4.2 + alt.i);
           } };
};

// ---- a saucer, hovering: bright metal in rings, a clear dome with somebody green at the controls, lights going
// round its rim, and its glow and its beam in the team's colour
MAKE.saucer = () => {
  const k = new Kit(), HULL = 0xcfd3d8, BAND = 0x8d939c, UNDER = 0xb7bcc3, GREEN = 0x86d455;
  k.add("metal", spun([[0.001, 0.37], [0.44, 0.37], [0.5, 0.345], [0.56, 0.31]], 40), 0xdfe2e6).add("metal", spun([[0.56, 0.31], [0.95, 0.235], [1.22, 0.12]], 40), HULL);
  k.add("metal", spun([[1.22, 0.12], [1.37, 0.045], [1.41, 0], [1.37, -0.045], [1.2, -0.11]], 40), BAND);
  k.add("metal", spun([[1.2, -0.11], [0.85, -0.17], [0.62, -0.2], [0.6, -0.25], [0.3, -0.28], [0.001, -0.28]], 40), UNDER);
  for (let a = 0; a < 12; a++) {
    const c = Math.cos(a / 12 * TAU), s = Math.sin(a / 12 * TAU), c2 = Math.cos((a + 0.5) / 12 * TAU), s2 = Math.sin((a + 0.5) / 12 * TAU);
    k.add("satin", rod([0.58 * c, 0.308, 0.58 * s], [1.21 * c, 0.124, 1.21 * s], 0.006, 4), 0x4b4f55);                                                 // seams between its plates
    if (a % 3 === 1) continue;                                                                                                                         // ports, lit from inside, eight of them
    k.add("glow", ball(0.062, 0.014, 0.062, 0, 0, 0, 12).rotateZ(-0.285).rotateY(-(a + 0.5) / 12 * TAU).translate(0.82 * c2, 0.246, 0.82 * s2), [1.5, 1.05, 0.35]);
    k.add("chrome", new THREE.TorusGeometry(0.066, 0.011, 5, 16).rotateX(Math.PI / 2).rotateZ(-0.285).rotateY(-(a + 0.5) / 12 * TAU).translate(0.82 * c2, 0.248, 0.82 * s2), 0xe8e8e8);
  }
  // The dome is a bubble, most of a ball: 0.5 across its foot like the ring it stands in, and tall enough for the pilot,
  // feelers and all. (It was half a ball of that size, 0.87 at its top, and his head, which reaches 1.0, came through
  // it. Eric: "aliens head is poking through the glass dome".) Everything of his is kept 0.09 or more inside the glass.
  const DOME = 0.6, DOME_Y = 0.37 + Math.sqrt(DOME * DOME - 0.25);
  k.add("clear", new THREE.SphereGeometry(DOME, 30, 18, 0, TAU, 0, Math.PI - Math.asin(0.5 / DOME)).translate(0, DOME_Y, 0)).add("chrome", new THREE.TorusGeometry(0.5, 0.03, 8, 30).rotateX(Math.PI / 2).translate(0, 0.378, 0), 0xe8e8e8);
  // the pilot: a big head, bigger eyes, two feelers, a hand on the stick
  k.add("satin", ball(0.15, 0.16, 0.11, 0, 0.5, 0, 12), 0x8fa3a8).add("matte", cylY(0.04, 0.05, 0.1, 0, 0.64, 0.01, 8), GREEN).add("matte", ball(0.17, 0.2, 0.18, 0, 0.8, 0.03, 16), GREEN);
  for (const s of [1, -1]) {
    k.add("gloss", ball(0.05, 0.075, 0.03, 0, 0, 0, 10).rotateZ(s * 0.5).translate(s * 0.078, 0.82, 0.185), 0x050506);
    k.add("matte", rod([s * 0.07, 0.97, 0.03], [s * 0.13, 1.1, 0.05], 0.01, 5), GREEN).add("matte", ball(0.025, 0.025, 0.025, s * 0.13, 1.11, 0.05, 8), GREEN);
    k.add("matte", sweep([[s * 0.15, 0.55, 0.02, 0.035], [s * 0.14, 0.46, 0.18, 0.03], [s * 0.04, 0.47, 0.27, 0.026]], { around: 6 }), GREEN);
  }
  k.add("satin", rod([0, 0.38, 0.28], [0, 0.5, 0.27], 0.012, 5), 0x33363a).add("glow", ball(0.028, 0.028, 0.028, 0, 0.52, 0.27, 8), LAMP_RED);
  k.add("aura", new THREE.CircleGeometry(0.28, 24).rotateX(Math.PI / 2).translate(0, -0.285, 0)).add("aura", new THREE.TorusGeometry(0.5, 0.022, 6, 30).rotateX(Math.PI / 2).translate(0, -0.262, 0));      // its glow underneath
  for (let a = 0; a < 3; a++) k.add("chrome", ball(0.09, 0.07, 0.09, 0.95 * Math.cos(a * 2.094 + 0.5), -0.17, 0.95 * Math.sin(a * 2.094 + 0.5), 12), 0xe0e0e0);
  const ring = (slot, turn, colour) => { const g = new Kit(); for (let a = 0; a < 8; a++) g.add(slot, ball(0.07, 0.05, 0.07, 1.3 * Math.cos((a + turn) / 8 * TAU), 0.085, 1.3 * Math.sin((a + turn) / 8 * TAU), 10), colour); return g.join(); };
  const beam = { beam: new THREE.CylinderGeometry(0.42, 0.98, 0.68, 28, 1, true).translate(0, -0.62, 0) };
  return { lumps: k.join(), wheel: [], wheels: [], ground: { beam: spun([[1.3, 0.035], [0.001, 0.035]], 28) }, movers: [["ringA", ring("aura", 0), [0, 0, 0]], ["ringB", ring("glow", 0.5, [2.4, 2.4, 2.2]), [0, 0, 0]], ["beam", beam, [0, 0, 0]]],
           tall: 0.55, pod: [0, 1.5, 0.95], blob: [0.001, 0.001],
           step(alt, p, t) {             // it bobs, banks into the corners, and its lights go round
             alt.root.position.y = 0.95 + 0.07 * Math.sin(t * 2.2 + alt.i);
             alt.root.rotation.z = -p.steer * 0.38; alt.root.rotation.x = 0.02 * Math.sin(t * 1.7 + alt.i);
             alt.m.ringA.rotation.y = alt.m.ringB.rotation.y = t * 2.2 + alt.i;
             alt.aura.color.copy(alt.team).multiplyScalar(2.2 + 1.2 * Math.sin(t * 6 + alt.i));
           } };
};

// ---- THE SAME VEHICLES WITH SCULPTED BODIES (rides\things.py), wherever the sculpt has come. What is typed in for
// these is only what has to turn, glow or follow a rule: wheels, lamps, a chariot, lightning. Each says which
// sculpts it would like (a + after a name: that one has a mask, for the cars' own colours).
for (const name of ["delorean", "wiener", "warthog", "chariot", "duck"]) MAKE[name] = () => SHAPES[name]();
MAKE.chariot = got => SHAPES.chariot(got);                  // the chariot itself is shapes either way; its horses and its driver are sculpts where they have come
MAKE.chariot.needs = ["horse+", "charioteer+"];

// The DeLorean: its bodywork and the machinery on its back are the sculpt, made from a picture of the film's car
// that Eric sent. Typed in: the wheels, which turn; the coils down its flanks, which are what blaze before the
// lightning comes; and the team's colour along its sills.
MAKE.delorean = got => {
  if (!got.delorean) return SHAPES.delorean();
  if (got.delorean.adopted) {
    // A model of the film's car made by somebody who knew it (its credit is in the file: rides\\things.py, ADOPTED),
    // downloaded by Eric. All of it is the model: bodywork, the machinery on its back, its own wheels, which turn,
    // and its own flux tubes, which run round its nose under the headlamps and down its flanks to the tail lamps
    // ("the blue neon glow on the wires leading to the headlights and down the tubes leading to the tail lights not
    // just two bars"): those glow low, come up as it gathers speed, and flicker once the lightning has it.
    const A = adoptedParts(got.delorean), W = A.wheels, order = ["FL", "FR", "RL", "RR"].filter(q => W[q]);
    const shell = /Paint_|paint_2|Base_|Grille1A/, cabin = /Interior|Textured|GrilleNoAlpha9/;      // by their materials' names: what throws a shadow, and what is inside the cabin
    return { lumps: {}, bodies: [{ sculpt: { parts: [...A.body, ...A.glass], mask: null }, quiet: q => !shell.test(q.material.name), close: q => cabin.test(q.material.name) }],
             overlays: [{ kind: "over", parts: A.over }, { kind: "flux", parts: A.glow },      // (its lamps are a warm brown glass in its picture: the front ones are whitened)
                        { kind: "lamp", parts: A.lamp.filter(q => q.name.includes("front")), colour: [4.5, 5.5, 9] }, { kind: "lamp", parts: A.lamp.filter(q => !q.name.includes("front")), colour: [4.5, 3.2, 3] }],
             wheel: order.map(q => W[q]), wheels: order.map((q, n) => [W[q].at.x, W[q].at.z, q[0] === "F", n]),
             tall: 0.1, pod: [0, 1.32, 0.3], blob: [0.95, 0.82], lightning: true, shell: [1.0, 0.62, 0.64, 2.25] };
  }
  const k = new Kit();
  k.both("aura", s => rod([s * 1.0, 0.57, 0.8], [s * 1.0, 0.61, -0.75], 0.024, 8));
  k.both("paint", s => rbox(0.016, 0.055, 1.5, 0.006, s * 0.99, 0.31, 0.0, 1));
  return { lumps: k.join(), bodies: [{ sculpt: got.delorean, look: { roughness: 0.42, metalness: 0.6, emissiveIntensity: 2.4 } }],
           wheel: [wheelKind(0.315, 0.22, 0.2, "turbine"), wheelKind(0.342, 0.27, 0.215, "turbine")],
           wheels: [[0.782, 1.236, true, 0], [-0.782, 1.236, true, 0], [0.782, -1.254, false, 1], [-0.782, -1.254, false, 1]],
           tall: 0.1, pod: [0, 1.32, 0.3], blob: [0.95, 0.82], lightning: true, shell: [1.02, 0.62, 0.64, 2.32] };
};
MAKE.delorean.needs = ["delorean"];

// The hot dog: all of it is the sculpt but its wheels. The band along the bottom of the bun is the team's colour.
MAKE.wiener = got => {
  if (!got.wiener) return SHAPES.wiener();
  return { lumps: {}, bodies: [{ sculpt: got.wiener, tint: ["paint"], look: { roughness: 0.4, emissiveIntensity: 3.0 } }],
           wheel: [wheelKind(0.28, 0.2, 0.19, "cap", { colour: 0xd4d6d9 })], wheels: [[0.7, 1.14, true], [-0.7, 1.14, true], [0.7, -0.97], [-0.7, -0.97]],
           tall: 0.7, pod: [0, 2.0, -0.3], blob: [1.0, 0.72] };
};
MAKE.wiener.needs = ["wiener+"];

// The duck: the sculpt, in the team's colour, its helmet and scarf in the second. It rocks as the shapes do.
MAKE.duck = got => {
  if (!got.duck) return SHAPES.duck();
  return { lumps: {}, bodies: [{ sculpt: got.duck, tint: ["paint", "second"], look: { roughness: 0.2 } }], wheel: [], wheels: [],
           tall: 1.05, pod: [0, 2.4, 0.9], blob: [0.7, 0.4],
           step(alt, p, t) {
             alt.root.rotation.z = 0.04 * Math.sin(t * 3.1 + alt.i) - p.steer * 0.1; alt.root.rotation.x = 0.025 * Math.sin(t * 2.3 + alt.i * 2);
             alt.root.position.y = -0.03 + 0.012 * Math.sin(t * 4.2 + alt.i);
           } };
};
MAKE.duck.needs = ["duck+"];

// The Warthog. On this PC it is three adopted models (rides\\things.py, ADOPTED: warthog_a, _b, _c: the same
// Warthog with a chain gun, a Gauss cannon, a rocket launcher), and each driver has one of the three: Eric,
// Oct 10 2026, "i downloaded a trio of warthogs can you use all three ... it just assigns a random variant to a
// driver ... doesnt matter how to do the assignment as long as theres a smattering of each type". Its crew is the
// Master Chief twice (ADOPTED: chief), sat at the wheel in the team's first colour and stood at the gun in its
// second: "make each suit colored as the teams colors". Everywhere else, and until those have come, it is the
// typed-in buggy with the sculpted crew.
const HOG_SEAT = [0.45, 1.06, -0.05], HOG_STAND = [0, 1.1, -1.4];      // where his hip joint is when he is sat in the left seat; where he stands behind the gun (the turntable is 1.1 m up)
const HOG_TURN = -1.26;                 // the gun, its turntable and the gunner on it turn about a point this far behind the Warthog's middle
// THE GUNS. Eric, Oct 10 2026: "can you make the gunners swing around and shoot bullets, gauss cannon rounds and
// rockets at each other when theres a collision". The game says when two cars touch and which two (its COLL
// event, in the replay's list of events). For three seconds from a knock, each of the two swings its gun round to
// the other and fires what it has: the chain gun a stream of tracer, the Gauss cannon a bolt every 0.9 s, the
// launcher a rocket every 1.15 s that takes half a second to get there and bursts. Everything is worked out from
// the replay's own clock, so it is the same shot at the same moment however the replay is wound about.
let hogFights = null;
function fightsOf(i) {                  // the knocks car i has had from other cars, in order, as fights: { t, end, other }
  if (!hogFights) {
    hogFights = {};
    for (const e of S.D.events || []) if (e.code === "COLL") for (const [me, other] of [[e.vehicle1Idx, e.vehicle2Idx], [e.vehicle2Idx, e.vehicle1Idx]]) {
      const list = hogFights[me] = hogFights[me] || [], last = list[list.length - 1];
      if (last && last.other === other && e.t < last.end) last.end = e.t + 3.2;      // knocked again while still at it: the same fight, longer
      else list.push({ t: e.t, end: e.t + 3.2, other });
    }
  }
  return hogFights[i] || [];
}
const hogA = V3(), hogB = V3(), hogC = V3();
const lit = (sprite, at, size, glow) => { sprite.position.copy(at); sprite.scale.set(size, size, 1); sprite.material.opacity = glow; sprite.visible = glow > 0.01; };
const HOG_FLASH = [[6, 4, 1.5], [2, 5, 10], [6, 3, 1]], HOG_BURST = [[5, 3.5, 1.5], [2.5, 5, 10], [7, 3, 0.8]];      // the light at the muzzle and at the other end, by gun
const HOG_SHOOT = [
  (F, M, T, age, i) => {                // the chain gun: seven rounds in the air at a time, each a streak
    const streak = Math.min(0.25, 2.6 / Math.max(M.distanceTo(T), 1));
    for (let k = 0; k < 7; k++) {
      const far = (age * 3.4 + k / 7 + 0.37 * Math.abs(Math.sin(k * 12.9 + i))) % 1;
      F.fx.line(hogA.lerpVectors(M, T, Math.max(0, far - streak)), hogB.lerpVectors(M, T, far), 0.022, [1.2, 0.7, 0.2], [5.5, 4.0, 1.6]);
    }
    lit(F.flash, M, 0.5 + 0.5 * Math.random(), 0.6 + 0.4 * Math.random());
    lit(F.burst, T, 0.35 + 0.5 * Math.random(), Math.random() < 0.6 ? 0.9 : 0);
  },
  (F, M, T, age) => {                   // the Gauss cannon: a bolt that is there all at once and gone in a fifth of a second
    const since = age % 0.9, k = 1 - since / 0.22;
    if (k <= 0) return;
    F.fx.line(hogA.copy(M), hogB.copy(T), 0.012 + 0.05 * k, [1.6 * k, 3.6 * k, 9 * k], [1.6 * k, 3.6 * k, 9 * k]);
    F.fx.line(hogA, hogB, 0.012, [4 * k, 5 * k, 7 * k], [4 * k, 5 * k, 7 * k]);
    lit(F.flash, M, 0.3 + 1.6 * k, k); lit(F.burst, T, 1.2 + 2.4 * (1 - k), k);
  },
  (F, M, T, age) => {                   // the launcher: a rocket on its way with its smoke behind it, then the burst
    const since = age % 1.15;
    if (since < 0.55) {
      const far = since / 0.55;
      F.fx.line(hogA.lerpVectors(M, T, Math.max(0, far - 0.035)), hogB.lerpVectors(M, T, far), 0.06, [6, 2.6, 0.6], [7, 5, 2.5]);
      F.fx.line(hogC.lerpVectors(M, T, Math.max(0, far - 0.32)), hogA, 0.05, [0, 0, 0], [0.55, 0.55, 0.6]);
      if (since < 0.09) lit(F.flash, M, 1.2, 1 - since / 0.09);
    } else if (since < 0.95) { const k = (since - 0.55) / 0.4; lit(F.burst, T, 1.2 + 4.5 * k, 1 - k); }
  },
];
function hogKit(rec, crew, kind) {
  const A = adoptedParts(rec), W = A.wheels, order = ["FL", "FR", "RL", "RR"].filter(q => W[q]);
  const suit = slot => (part, u, alt) => {                // one material for each of his two painted parts, for each car: the armour in that car's colour
    if (!/Body|Helmet/.test(part.material.name)) return null;
    const key = "suit" + slot + part.material.name;
    if (!alt[key]) alt.own.push(alt[key] = armoured(part.material, slot === "paint" ? alt.team : alt.second));
    return alt[key];
  };
  const ofGun = q => /chaingun|gauss|rocket/.test(q.material.name), gun = A.body.filter(ofGun), look = { roughness: 0.6, metalness: 0.3 };
  let tip = -Infinity, n = 0;                             // the muzzle: the middle of whatever of the gun is furthest forward, as it stands in the file
  const muzzle = V3();
  for (const q of gun) { q.geometry.computeBoundingBox(); tip = Math.max(tip, q.geometry.boundingBox.max.z); }
  for (const q of gun) { const P = q.geometry.attributes.position; for (let i = 0; i < P.count; i++) if (P.getZ(i) > tip - 0.05) { muzzle.x += P.getX(i); muzzle.y += P.getY(i); muzzle.z += P.getZ(i); n++; } }
  muzzle.multiplyScalar(1 / Math.max(1, n)); muzzle.z -= HOG_TURN;
  const bodies = [{ sculpt: { parts: [...A.body.filter(q => !ofGun(q)), ...A.glass], mask: null }, look },
                  { sculpt: { parts: gun, mask: null }, look, at: [0, 0, -HOG_TURN], on: "turret" }];      // (the gun and its turntable hang from the thing that turns)
  if (crew) bodies.push({ sculpt: { parts: crew.driver || [], mask: null }, at: HOG_SEAT, wear: suit("paint") },
                        { sculpt: { parts: crew.gunner || [], mask: null }, at: [HOG_STAND[0], HOG_STAND[1], HOG_STAND[2] - HOG_TURN], on: "turret", wear: suit("second") });
  const ease = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
  return { lumps: {}, movers: [["turret", {}, [0, 0, HOG_TURN]]], bodies,
           wheel: order.map(q => W[q]), wheels: order.map((q, n) => [W[q].at.x, W[q].at.z, q[0] === "F" ? 1 : -0.35, n]),      // (all four wheels steer, the back pair the other way)
           tall: 1.25, pod: [0, 2.0, 0.92], blob: [1.25, 0.86],
           fit(alt) {                    // each car's own shots: strips for what flies, a light at its muzzle and one at the other end
             const fx = strips(16), spot = hdr => {
               const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowDot(), color: new THREE.Color(...hdr), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
               s.visible = false; scene.add(s); alt.world.push(s); alt.own.push(s.material);
               return s;
             };
             scene.add(fx.mesh); alt.world.push(fx.mesh); alt.own.push(fx.g, fx.mat);
             alt.fire = { fx, flash: spot(HOG_FLASH[kind]), burst: spot(HOG_BURST[kind]) };
           },
           step(alt, p, t) {
             const F = alt.fire, turret = alt.m.turret;
             let fight = null;
             for (const q of fightsOf(alt.i)) { if (q.t > t) break; fight = q; }
             const foe = fight && t < fight.end + 0.9 ? cars.find(c => c.userData.i === fight.other && c.visible) : null;
             let yaw = 0.12 * Math.sin(t * 0.55 + alt.i * 1.7), firing = false;       // with nobody to shoot at, he looks about him a little
             if (foe) {
               alt.root.updateWorldMatrix(true, false);
               const to = alt.root.worldToLocal(hogA.set(foe.position.x, foe.position.y + 1.1, foe.position.z));
               const on = ease((t - fight.t) / 0.4) * (1 - ease((t - fight.end) / 0.9));      // swung round in 0.4 s, and back to the front in 0.9 when it is over
               yaw = yaw * (1 - on) + Math.atan2(to.x, to.z - HOG_TURN) * on;
               firing = t - fight.t > 0.4 && t < fight.end;
             }
             turret.rotation.y = yaw;
             F.fx.begin(); F.flash.visible = F.burst.visible = false;
             if (firing) {
               turret.updateWorldMatrix(true, false);
               const from = turret.localToWorld(v1.copy(muzzle)), at = v2.set(foe.position.x, foe.position.y + 1.05, foe.position.z);
               HOG_SHOOT[kind](F, from, at, t - fight.t - 0.4, alt.i);
             }
             F.fx.end();
           } };
}
MAKE.warthog = got => {
  const hogs = ["warthog_a", "warthog_b", "warthog_c"].map(n => got[n]).filter(q => q && q.adopted);
  if (!hogs.length) return SHAPES.warthog(got);
  const crew = got.chief && got.chief.adopted ? adoptedParts(got.chief) : null, variants = ["warthog_a", "warthog_b", "warthog_c"].filter(n => got[n] && got[n].adopted).map(n => hogKit(got[n], crew, "abc".indexOf(n.slice(-1))));
  return { ...variants[0], variants, which: i => +"012120201102210021"[i % 18] };      // which of the three a driver has: a fixed shuffle, so a car is the same Warthog every time
};
MAKE.warthog.needs = ["driver+", "gunner+", "warthog_a!", "warthog_b!", "warthog_c!", "chief!"];

// ---- THE FIELD'S OWN CAR, when a model of a 2026 car has been adopted on this PC (rides\\things.py, ADOPTED: "f1").
// Eric, Oct 10 2026: "downlaoded an f1 2026 car can you do the same thing and import that too replace the current f1
// model, make sure to repaint for each teams livery". The model is one team's car in that team's paint; here it is
// every team's. What each car wears is what the typed-in car wears (replay3d.js, dress: its paint sheet and its sheet
// of words), put on this body:
//   paint     by where on the car a point is: which panel (nose and tub, engine cover, a sidepod, a wing), how far
//             along it, how far round it from the keel: the same three things the typed-in car's panels are painted by
//   words     on labels that adopt.py laid on the model's skin (sign_<which>_n): each is given its place in the sheet
//   brake     its rain light and the lamps on its rear wing's endplates are the car's brake light
//   tyres     the markings on its tyre walls take the colour of the compound the car is on
//   driver    it has none. Where a statue of one has been adopted too ("racer": a print model Eric found, its arms
//             brought down on to the wheel and its helmet cut free by adopt.py), he sits in it, in the team's colour
//             with its trim colour for his helmet, and his head leans with the car's cornering, braking and
//             pulling away ("so at least the head bobbles back and forth with the gforces"). Otherwise a plain
//             helmet in the trim colour is put in the cockpit.
//   steering  the wheel in the cockpit is a part of its own (steer_), and is turned as far as the car is being
//             steered; the driver's hands go round with it, his wrists, elbows and shoulders following (the bones
//             adopt.py gave his arms: replay3d_cars.js, armed and armReach), and he looks a little into the corner.
//             Eric: "the steering wheel needs to react with the wheel angle properly and the arms need to move with
//             the wheel".
// Not yet: wings that break (the typed-in car's come apart in pieces; this one's stay whole).
const F1_WHERE = `
vec2 livUv(vec3 P) {
  float ax = abs(P.x);
  if (P.y > 1.04) return vec2(2.5 / 8.0, 0.88);                                                        // the camera on top of the airbox: carbon
  if (P.z > 2.05 && (ax > 0.2 || P.y < 0.3)) return vec2((ax > 0.6 ? 4.5 : 3.5) / 8.0, 0.88);         // the front wing: its endplates, its elements
  if (P.z < -1.8) return vec2((ax > 0.5 ? 5.5 : ax < 0.08 && P.y < 0.5 ? 2.5 : 6.5) / 8.0, 0.88);     // the rear wing: its endplates, the crash structure under it, its flap
  if (P.y > 0.73 && P.z > -0.05 && P.z < 1.0) return vec2(2.5 / 8.0, 0.88);                           // the halo: carbon
  float t, a; vec4 r;
  if (ax > 0.33 && P.z < 0.62 && P.z > -1.3) {                                                        // a sidepod
    t = (0.62 - P.z) / 1.92;
    a = fract(atan((ax - 0.47) / 0.15, (0.42 - P.y) / 0.25) / 6.2831853);
    if (a > 0.55) a = a < 0.8 ? 0.55 : 0.02;                                                          // its top runs on to where it meets the cover; under the undercut is the keel
    r = P.x > 0.0 ? vec4(0.78, 1.0, 0.36, 0.72) : vec4(0.78, 1.0, 0.36, 0.0);
  } else if (P.z > -0.05) {                                                                           // the nose and the tub
    t = (2.9 - P.z) / 2.95; a = fract(atan(P.x / 0.22, (0.45 - P.y) / 0.25) / 6.2831853); r = vec4(0.0, 0.48, 0.0, 0.72);
  } else {                                                                                            // the engine cover
    t = (-0.05 - P.z) / 1.62; a = fract(atan(P.x / 0.16, (0.62 - P.y) / 0.38) / 6.2831853); r = vec4(0.5, 0.76, 0.0, 0.72);
  }
  return vec2(mix(r.x, r.y, clamp(t, 0.006, 0.994)), mix(r.z, r.w, clamp(a, 0.006, 0.994)));
}`;
let f1Visor = null;
const F1_MAN = [0, 0.22, 0.62], F1_NECK = [0, 0.675, 0.15];      // where the statue of a driver goes for his helmet to be where a helmet belongs, and the point his head turns about (the car's own measures)
const F1_COLUMN = [0, 0.608, 0.67];     // the middle of the steering wheel, on the line it turns about: straight along the car, as the model has its wheel (measured: f1_wheel_pieces in the notes)
const F1_RIM = { wide: 0.16, top: 0.66, from: 0.1, to: 0.76 };      // the cockpit's opening: its half width, the height of the bodywork beside it, and from where to where along the car (read off the model: adopt.py --probe)
const F1_LOCK = 2.8;                    // how far round the wheel is at full lock, radians: the front wheels are then at 18 degrees, and an F1 car's steering is about nine to one
const f1Hub = new THREE.Vector3(F1_COLUMN[0] - F1_MAN[0], F1_COLUMN[1] - F1_MAN[1], F1_COLUMN[2] - F1_MAN[2]), f1Turn = new THREE.Quaternion(), f1At = new THREE.Vector3(), F1_ALONG = new THREE.Vector3(0, 0, 1);
// A TEAM'S REAL CAR. Eric, Oct 12 2026: "properly decaling the car up with the actual sponsors, logos, and liveries
// ... there was a ton of what looked like stickers and decals, and paint, i was hoping you would use those". A model
// that is one team's car comes in that team's livery: its paint is a picture laid on its paintwork the way its maker
// unwrapped it, and its partners' names and badges are a skin of their own over the paint. Repainting it for the
// other teams (above) throws both away. So where an adopted model says whose car it is (rides\things.py: "team"),
// that team's cars are that model as it came: its own paint (the file keeps the picture with the paintwork), its
// own badges (adopt.py keeps them as decal_), and of the replay's labels only the one a livery cannot know: the
// car's number. The other teams' cars are the first model repainted, as before, until a
// model of their own is adopted: rides\local\f1_<team>.glb, the names in F1_REAL.
const F1_REAL = ["f1_mclaren", "f1_ferrari", "f1_mercedes", "f1_aston", "f1_williams", "f1_haas", "f1_audi", "f1_cadillac", "f1_alpine", "f1_rb"];
const F1_AS = { sauber: "audi" };       // a team that goes by another name by the season the models are of
const F1_OWN = /^(num|nose)$/;          // the labels a car in its real livery still wears: its number, on the fin and the nose (its driver's letters would go on the rear wing's endplates, where a real livery has a partner's name)
// A TEAM'S OWN STICKERS ON THE SAME CAR. Eric, Oct 13 2026: "no new car model just come up with the sticker sheet for
// the other teams based on what red bulls looks like but with the appropriate logos and texts". The model's badges
// are small patches that each show one place on a sheet of pictures, so a sheet laid out as Red Bull's is, with
// another team's partners in the same places, puts their names where Red Bull's are (rides\stickers.py makes one a
// team; rides\local\f1_stickers.glb holds them all, a part named stickers_<team> wearing each). A team that has
// one drives the repainted car wearing it, and of the replay's own labels only its number, as a real livery does.
const f1Stuck = team => F1_AS[team] || team;
MAKE.f1 = got => {
  if (!got.f1 || !got.f1.adopted) return null;
  const man = got.racer && got.racer.adopted ? adoptedParts(got.racer) : null, rig = man && got.racer.credit && got.racer.credit.rig;
  f1Visor = f1Visor || new THREE.MeshStandardMaterial({ color: 0x0e0f11, roughness: 0.25, metalness: 0.6 });
  const keep = (alt, m) => { alt.own.push(m); return m; };
  const base = f1Kit(got.f1, false, man, rig, keep), real = {}, sheets = {};
  for (const rec of [got.f1, ...F1_REAL.map(id => got[id])]) {
    const team = rec && rec.adopted && rec.credit && rec.credit.team;
    if (team && !real[team]) real[team] = f1Kit(rec, true, man, rig, keep);
  }
  if (got.f1_stickers && got.f1_stickers.adopted) for (const p of got.f1_stickers.parts) if (p.material && p.material.map) sheets[p.name.replace(/^stickers_/, "")] = p.material.map;
  const teams = Object.keys(real), stuck = Object.keys(sheets).length ? f1Kit(got.f1, false, man, rig, keep, sheets) : null;
  if ((!teams.length && !stuck) || (S.D.liveries || {}).real === false) return base;      // (liveries.json can say no: every car in the replay's own paint)
  return { ...base, variants: [base, ...teams.map(team => real[team]), ...(stuck ? [stuck] : [])],       // (the first, the repainted car with the replay's own lettering, is what a team with neither drives)
           which: i => { const c = S.CARS.find(q => q.i === i), team = c ? f1Stuck(TEAM_OF[c.team]) : null, own = teams.indexOf(team);
                         return own >= 0 ? 1 + own : stuck && sheets[team] ? 1 + teams.length : 0; } };
};
function f1Kit(rec, real, man, rig, keep, sheets) {      // the car made of one adopted model: repainted for whoever drives it (wearing its team's stickers, if sheets are given), or (real) as it came
  const A = adoptedParts(rec), W = A.wheels, order = ["FL", "FR", "RL", "RR"].filter(q => W[q]);
  const badges = {};                      // (a team's stickers are the same on both its cars: one material a team)
  const labels = A.sign.filter(q => !(real || sheets) || F1_OWN.test(q.name.split("_")[1])).map(q => {      // each label's picture runs 0 to 1 across and up it: moved to its own place in the sheet of words
    const g = q.geometry.clone(), uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));      // (a .glb counts a picture's rows from the top)
    return plaque(g, q.name.split("_")[1]);
  });
  const one = labels.length > 1 ? mergeGeometries(labels) : null;                                                 // and all of them made one part
  const signs = (one ? [one] : labels).map((geometry, n) => ({ name: "sign_" + n, geometry, material: null }));
  const driver = man ? [] : [{ name: "helmet", geometry: dot(new THREE.SphereGeometry(0.128, 16, 12).scale(1, 1, 1.12).translate(0, 0.745, 0.13), "trim"), material: null },
                             { name: "visor", geometry: new THREE.SphereGeometry(1, 12, 8).scale(0.105, 0.042, 0.06).translate(0, 0.757, 0.235), material: null }];
  const wear = (part, u, alt) => {
    const kind = part.name.split("_")[0];
    // (a real livery is the same for both of a team's cars: one material for the model, not one a car, and not thrown away with a car)
    if (kind === "paint" && real) return rec.livery = rec.livery || new THREE.MeshPhysicalMaterial({ map: part.material.map, normalMap: part.material.normalMap || null, roughness: 0.38, metalness: 0.25, clearcoat: 0.7, clearcoatRoughness: 0.16, side: both });
    if (kind === "decal" && sheets) {
      const c = S.CARS.find(q => q.i === alt.i), team = c ? f1Stuck(TEAM_OF[c.team]) : null, map = sheets[team], right = sheets[team + "_right"];
      if (map) map.anisotropy = 8;
      if (badges[team]) return badges[team];
      const m = badges[team] = new THREE.MeshStandardMaterial({ map: map || null, visible: !!map, transparent: true, alphaTest: 0.3, roughness: 0.4, side: both, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      // A car that is one colour on its left and another on its right (the Cadillac: black and white) has a sheet
      // for each side, since a name that reads on the one is lost on the other (rides\stickers.py, "sides"): what
      // is to the right of the car's middle line is taken from the second.
      if (map && right) {
        right.anisotropy = 8;
        m.onBeforeCompile = sh => {
          sh.uniforms.mapRight = { value: right };
          sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying float vAcross;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvAcross = position.x;");
          sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform sampler2D mapRight;\nvarying float vAcross;")
            .replace("#include <map_fragment>", "#ifdef USE_MAP\n  vec4 onLeft = texture2D(map, vMapUv), onRight = texture2D(mapRight, vMapUv);\n  diffuseColor *= vAcross < 0.0 ? onRight : onLeft;\n#endif");      // (both looked up, then one chosen: a look-up inside the choice has no slope to pick its size by)
        };
        m.customProgramCacheKey = () => "a sheet a side";
      }
      return m;
    }
    if (kind === "decal") return rec.badges = rec.badges || new THREE.MeshStandardMaterial({ map: part.material.map, transparent: true, alphaTest: 0.35, roughness: 0.4, side: both, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    if (kind === "paint") return alt.livery = alt.livery || keep(alt, liveried(part.material, u.wear.paint, F1_WHERE));
    if (kind === "sign") return alt.letters = alt.letters || keep(alt, new THREE.MeshStandardMaterial({ map: u.wear.signs, transparent: true, alphaTest: 0.3, roughness: 0.4, side: both, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    if (kind === "light") return u.light;                   // the stock car's own brake light material: replay3d.js sets it every frame, whatever the car is drawn as
    if (kind === "helmet" || kind === "head") return alt.plain = alt.plain || keep(alt, new THREE.MeshPhysicalMaterial({ map: u.wear.paint, roughness: 0.3, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08 }));
    if (kind === "torso") {                                 // a race suit is cloth
      if (alt.cloth) return alt.cloth;
      const m = alt.cloth = keep(alt, new THREE.MeshStandardMaterial({ map: u.wear.paint, roughness: 0.85, metalness: 0 }));
      // His shoulders and upper arms are under the cockpit's sides, as a driver's are (the opening is 36 cm wide), and
      // when a hand goes over the top of the wheel an arm lifts a little through that bodywork. So nothing of him is
      // drawn above the bodywork's own height where there is bodywork (F1_RIM, the car's measures; here in his own).
      m.onBeforeCompile = sh => {
        sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vSeat;").replace("#include <skinning_vertex>", "#include <skinning_vertex>\nvSeat = transformed;");
        sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vSeat;")
          .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>\nif (abs(vSeat.x) > ${F1_RIM.wide.toFixed(3)} && vSeat.y > ${(F1_RIM.top - F1_MAN[1]).toFixed(3)} && vSeat.z > ${(F1_RIM.from - F1_MAN[2]).toFixed(3)} && vSeat.z < ${(F1_RIM.to - F1_MAN[2]).toFixed(3)}) discard;`);
      };
      m.customProgramCacheKey = () => "seated";
      return m;
    }
    if (kind === "visor") return f1Visor;
    // (its two mirror panes: a car's own material, because the car being followed has what is behind it in them: replay3d_mirrors.js)
    if (kind === "body" && /mirror/i.test(part.material.name) && mirrorPanes(part.geometry)) return alt.mirror = alt.mirror || keep(alt, mirrorGlass());
    return null;
  };
  const wheelWear = (q, u, alt) => {                        // the tyres: one material a car, so that the markings on their walls can be that car's compound
    if (!/sidewall/.test(q.material.name)) return null;
    if (!alt.tyres) {
      alt.tyres = keep(alt, q.material.clone());
      alt.compound = { value: new THREE.Color(0.7, 0.7, 0.7) };
      alt.tyres.onBeforeCompile = sh => {
        sh.uniforms.compound = alt.compound;
        sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform vec3 compound;")
          .replace("#include <map_fragment>", "#include <map_fragment>\n{ float hi = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b)), lo = min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b)); if (hi - lo > 0.16) diffuseColor.rgb = compound * hi; }");
      };
      alt.tyres.customProgramCacheKey = () => "compound";
    }
    return alt.tyres;
  };
  const seen = /paint/, cockpit = /steeringwheel|cinture|chrome|LCD|clearled|kers|black_s|carbon1/;
  const bodies = [{ sculpt: { parts: [...A.paint, ...A.body, ...A.glass, ...(real || sheets ? A.decal || [] : []), ...signs, ...A.light, ...driver], mask: null }, at: [0, 0.03, 0], wear,      // (its tyres are drawn 3 cm into the road; ours stand on it, so the body is lifted to suit)
                    quiet: q => !(q.material && seen.test(q.material.name)), close: q => !!q.material && cockpit.test(q.material.name) }];
  if (A.steer) bodies.push({ sculpt: { parts: A.steer, mask: null }, at: [-F1_COLUMN[0], 0.03 - F1_COLUMN[1], -F1_COLUMN[2]], on: "steer", wear, quiet: () => true });
  if (man) bodies.push({ sculpt: { parts: man.torso || [], mask: null }, at: F1_MAN, wear, quiet: () => true, arms: rig ? rig.arms : null },
                       { sculpt: { parts: man.head || [], mask: null }, at: [F1_MAN[0] - F1_NECK[0], F1_MAN[1] - F1_NECK[1], F1_MAN[2] - F1_NECK[2]], on: "head", wear, quiet: () => true });
  return { lumps: {}, wear, wheelWear, bodies, movers: [...(man ? [["head", {}, F1_NECK]] : []), ...(A.steer ? [["steer", {}, F1_COLUMN]] : [])],
           wheel: order.map(q => W[q]), wheels: order.map((q, n) => [W[q].at.x, W[q].at.z, q[0] === "F", n]),
           tall: 0, pod: [0.12, 1.115, -0.07], blob: [1, 1], farStock: true,      // the camera: in the front of the left arm of the T on top of the airbox, where the broadcast's is
           step(alt, p, t) {
             const head = alt.m.head, was = head && pose(alt.i, t - 0.1), next = was && pose(alt.i, t + 0.1);
             if (next) {                 // his head goes where the car throws it: outward in a corner, forward under braking, back as it pulls away (about 2 degrees for each g), and shakes a little at speed
               const v = p.speed / 3.6, turn = Math.atan2(Math.sin(next.yaw - was.yaw), Math.cos(next.yaw - was.yaw)) / 0.2, across = v * turn / 9.81, along = (next.speed - was.speed) / 3.6 / 0.2 / 9.81, shake = 0.006 * Math.min(1, v / 60);
               head.rotation.z = clamp(across * 0.035, -0.2, 0.2) + shake * Math.sin(t * 37 + alt.i);
               head.rotation.x = clamp(-along * 0.035, -0.12, 0.2) + shake * Math.sin(t * 29 + alt.i * 2);
             }
             const steer = clamp(api.debug.steer ?? p.steer, -1, 1), turn = steer * F1_LOCK;      // (api.debug.steer: a steering angle to look at, whatever the car is doing)
             if (head) head.rotation.y = clamp(-steer * 0.6, -0.3, 0.3);                           // he looks into the corner
             if (alt.m.steer) { alt.m.steer.rotation.z = turn; alt.m.steer.visible = !alt.close || alt.close.visible; }      // (top of the wheel to the right for a right-hander; drawn only from as near as the rest of the cockpit is)
             if (alt.arms) {
               f1Turn.setFromAxisAngle(F1_ALONG, turn);
               for (const arm of alt.arms) armReach(arm, f1At.copy(arm.wrist).sub(f1Hub).applyQuaternion(f1Turn).add(f1Hub), f1Turn);
             }
             const tyre = S.tyreColor ? S.tyreColor(alt.i, t) : null;
             if (alt.compound && tyre !== alt.tyreNow) { alt.tyreNow = tyre; alt.compound.value.set(tyre || "#b4b4b4"); }
           } };
}
MAKE.f1.needs = ["f1!", "racer!", "f1_stickers!", ...F1_REAL.map(id => id + "!")];

// ---------------------------------------------------------------------------------------------------- mirrors
// Eric, 13 Oct 2026, looking out of the onboard camera: "can you add reflection of whats behind the car in the
// mirrors". The adopted F1 car has two mirror panes (one part of the model, a pane a side, 20 cm by 5), and they
// were a flat grey. Now the car being followed has what is behind it in them.
//
// It is done as a racing game does it and not as glass does. Each pane is a little screen, showing the picture of
// a camera that stands in the pane and looks back down the car's flank and a little outward. A true mirror shows
// a different thing to every eye, and to the onboard camera, which is up on the airbox looking down at the panes,
// a true one would show the car's own floor. What is wanted is what a driver has in his mirrors, wherever they
// are looked at from: his own rear tyre on the inner side, the car behind seen under his rear wing, the road and
// whoever is on it on the outer. (The picture is not turned over to make a mirror of it. A pane is looked at from
// behind the camera that took its picture, and that turns it over, lettering and all, as a mirror does.)
//
// What it costs is the circuit drawn again for each pane, and drawn whole that was more than the picture itself:
// from the onboard camera after the start, 12 ms a frame became 24 (each pane's slit of a view took in five million
// triangles: every grandstand's crowd, every tree, the pit building's fittings, a third of a mile off and smaller
// than a pixel). Eric, asked nothing, a minute later: "doesnt have to be crystal clear if that helps frames". So:
//  - only the car being followed has them, and only while a pane is big enough in the picture for anybody to tell
//    what is in it, and is seen from the side it shines on (MIRROR.least: from the chase camera they are specks);
//  - the shadows are not worked out again for them: the main picture's are used, a frame old;
//  - watched live, one pane is drawn again each frame, turn about, and it is drawn light (mirrorSpared): no crowd,
//    no plants, none of the pit building's fittings, nothing that is a great many triangles in one piece, and
//    nothing of any size that is further off than MIRROR.reach. The cars are never left out: they are what a
//    mirror is for;
//  - a film has both panes drawn for every frame, with everything in them: a film is off the clock, and the same
//    film made twice is to be the same film.
// The typed-in F1 car and the other vehicles have no panes, and nothing is drawn for them.
const MIRROR = {
  wide: 512, high: 128,                 // a pane's picture, in pixels (twice that for a film 1440 tall or more)
  out: 0.175, down: 0.03,               // which way a pane's camera looks: this far out from straight back, and down (radians)
  field: 40,                            // how much it takes in from side to side, in degrees (a flat mirror that size would show the driver 12: these are as a curved one)
  near: 0.3, far: 3000,
  least: 0.035,                         // how wide a pane must be in the picture, as a part of the picture's height, before it is drawn into (onboard it is 0.2 and more; from the chase camera 0.025)
  dim: 0.88,                            // how much of the light a pane gives back
  // what a pane watched live does without (by what a thing's material is called, by its size, by how far off it is):
  never: /^(People|Person|Tree_|bush_|bark_|leaf_|Suite|Workshop|Equipment|Car|Carbon rubber|LCD|Telephone|Pit markings|Oiled walnut|body_trolley|brake_tablet)/,
  most: 120000,                         // triangles in one piece (all its copies counted), over which it is left out
  some: 20000, reach: 150,              // and a piece of this many or more is left out when the nearest of it is further off than this (metres)
};
let mirrorShot = null, mirrorBlank = null, mirrorOn = null, mirrorFrame = 0, mirrorLast = -9, mirrorKnown = null;

// What a pane watched live does without, found out for it: the pieces of the circuit that are never drawn in one,
// and those that are not when they are far off (with where each is and how big). The circuit's props come over a
// few seconds after the page opens, so this is looked over again every four seconds or so.
function mirrorSpared() {
  if (mirrorKnown && mirrorFrame - mirrorKnown.at < 240) return mirrorKnown;
  const own = new Set(cars), never = [], far = [], ball = new THREE.Sphere();
  const walk = o => {
    if (own.has(o)) return;
    if (o.isMesh && o.geometry && o.geometry.attributes.position) {
      const g = o.geometry, m = Array.isArray(o.material) ? o.material[0] : o.material;
      const n = (g.index ? g.index.count : g.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1);
      if (n > MIRROR.most || MIRROR.never.test((m && m.name) || "")) never.push(o);
      else if (n >= MIRROR.some) {
        if (o.isInstancedMesh) { if (!o.boundingSphere) o.computeBoundingSphere(); ball.copy(o.boundingSphere); }
        else { if (!g.boundingSphere) g.computeBoundingSphere(); ball.copy(g.boundingSphere); }
        ball.applyMatrix4(o.matrixWorld);
        far.push({ o, at: ball.center.clone(), r: ball.radius });
      }
    }
    for (const ch of o.children) walk(ch);
  };
  walk(scene);
  return mirrorKnown = { at: mirrorFrame, never, far };
}

function mirrorPanes(g) {               // a mirror part's two panes found (one each side of the car), and its picture laid over each of them whole
  if (g.userData.panes !== undefined) return g.userData.panes;
  const P = g.attributes.position, N = g.attributes.normal, sides = [1, -1].map(side => ({ side, box: new THREE.Box3(), face: new THREE.Vector3() }));
  g.userData.panes = null;
  if (!P || !P.count) return null;
  for (let i = 0; i < P.count; i++) {
    const s = sides[P.getX(i) > 0 ? 0 : 1];
    s.box.expandByPoint(v1.fromBufferAttribute(P, i));
    if (N) s.face.add(v1.fromBufferAttribute(N, i));
  }
  if (sides.some(s => s.box.isEmpty())) return null;
  // The two pictures are kept side by side in one (the left pane's in the left half), and each pane shows the whole
  // of its own: across it by where a corner is across the pane, up it by how high. (The model's own picture places
  // for the panes are a sheet's worth each, for a game to do the same with.)
  const uv = new THREE.BufferAttribute(new Float32Array(P.count * 2), 2);
  for (let i = 0; i < P.count; i++) {
    const k = P.getX(i) > 0 ? 0 : 1, b = sides[k].box;
    uv.setXY(i, (k + (P.getX(i) - b.min.x) / (b.max.x - b.min.x)) / 2, (P.getY(i) - b.min.y) / (b.max.y - b.min.y));
  }
  g.setAttribute("uv", uv);
  const up = new THREE.Vector3(0, 1, 0), none = new THREE.Vector3(), turn = new THREE.Matrix4();
  return g.userData.panes = sides.map(({ side, box, face }) => {
    const across = Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z), tall = box.max.y - box.min.y;      // (a pane is set at an angle across the car: its width is along that)
    const eye = new THREE.PerspectiveCamera(2 * Math.atan(Math.tan(MIRROR.field * Math.PI / 360) * tall / across) * 180 / Math.PI, across / tall, MIRROR.near, MIRROR.far);
    const way = new THREE.Vector3(side * Math.sin(MIRROR.out), -Math.sin(MIRROR.down), -Math.cos(MIRROR.out) * Math.cos(MIRROR.down));
    return { side, at: box.getCenter(new THREE.Vector3()), across, eye,
             face: face.lengthSq() ? face.normalize() : new THREE.Vector3(0, 0, -1),
             look: new THREE.Quaternion().setFromRotationMatrix(turn.lookAt(none, way, up)) };
  });
}

function mirrorGlass() {                // a pane's material: its picture as it is, a little dimmed. Until it has one, the dark of nothing much
  if (!mirrorBlank) {
    const c = document.createElement("canvas");
    c.width = 4; c.height = 32;
    const g = c.getContext("2d"), fade = g.createLinearGradient(0, 0, 0, 32);
    for (const [at, colour] of [[0, "#0d1016"], [0.42, "#2f3540"], [0.5, "#3a3f47"], [0.58, "#26282c"], [1, "#131415"]]) fade.addColorStop(at, colour);
    g.fillStyle = fade; g.fillRect(0, 0, 4, 32);
    mirrorBlank = new THREE.CanvasTexture(c);
    mirrorBlank.colorSpace = THREE.SRGBColorSpace;
  }
  return new THREE.MeshBasicMaterial({ map: mirrorBlank, color: new THREE.Color().setScalar(MIRROR.dim), side: both, fog: false });
}

function mirrorsStep(car) {             // each frame, when the cars are where they are and before the picture is drawn: what is behind the followed car, into its panes
  const first = !mirrorFrame++, alt = car && car.visible ? car.userData.alt : null, glass = alt && !alt.far ? alt.mirror : null;
  const dark = () => { if (mirrorOn) { mirrorOn.map = mirrorBlank; mirrorOn = null; } };      // (a pane that is not being drawn into shows nothing much, sooner than something from a while ago)
  if (mirrorOn !== glass) dark();                                                             // (another car is followed now)
  if (first || !glass || !api.mirrors || quality < 1 || TOY.on) return dark();                // (first: the shadows these are drawn with are the main picture's, and there has not been one yet)
  if (!alt.panes) alt.root.traverse(o => { if (o.isMesh && o.material === glass) alt.panes = o; });
  const mesh = alt.panes, panes = mesh ? mirrorPanes(mesh.geometry) : null;
  if (!panes) return dark();
  mesh.updateWorldMatrix(true, false);
  const lens = Math.tan(camera.fov * Math.PI / 360);
  const seen = panes.filter(pane => {
    const at = pane.eye.position.copy(pane.at).applyMatrix4(mesh.matrixWorld);
    return v1.copy(camera.position).sub(at).dot(v2.copy(pane.face).transformDirection(mesh.matrixWorld)) > 0
        && pane.across / Math.max(0.05, at.distanceTo(camera.position)) / lens / 2 >= MIRROR.least;
  });
  if (!seen.length) return dark();
  const big = api.fixed && api.fixed[1] >= 1440 ? 2 : 1, w = MIRROR.wide * big, h = MIRROR.high * big;
  // (kept as the main picture is before it is finished: light as it is, with room above white, so that a headlamp
  // or a floodlight in a pane is as bright as one anywhere; and with smaller copies of itself, for a pane seen small)
  if (!mirrorShot) mirrorShot = new THREE.WebGLRenderTarget(w * 2, h, { type: THREE.HalfFloatType, samples: 4, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  let stale = mirrorOn !== glass || mirrorFrame - mirrorLast > 1;      // nothing of this car's in the panes yet, or not since a moment ago: both are drawn now
  if (mirrorShot.width !== w * 2) { mirrorShot.setSize(w * 2, h); stale = true; }
  if (glass.map !== mirrorShot.texture) glass.map = mirrorShot.texture;
  mirrorOn = glass; mirrorLast = mirrorFrame;
  const live = api.debug.mirrorsLive ?? !api.fixed;           // (api.debug.mirrorsLive: drawn as when watched live, or as for a film, whichever is being done: for looking at the difference)
  const now = !live || stale || seen.length < 2 ? (stale ? panes : seen) : [seen[mirrorFrame % 2]];
  const shadows = renderer.shadowMap.autoUpdate, tags = cars.map(c => c.userData.tag.visible), put = [];
  renderer.shadowMap.autoUpdate = false;
  for (const c of cars) c.userData.tag.visible = false;       // (nobody's name hangs over his car in a mirror)
  if (live) {                                                 // watched live: drawn light (see the top of this file)
    const spared = mirrorSpared();
    for (const o of spared.never) if (o.visible) { o.visible = false; put.push(o); }
    for (const q of spared.far) if (q.o.visible && q.at.distanceTo(car.position) - q.r > MIRROR.reach) { q.o.visible = false; put.push(q.o); }
  }
  mesh.getWorldQuaternion(q1);
  for (const pane of now) {
    pane.eye.position.copy(pane.at).applyMatrix4(mesh.matrixWorld);
    pane.eye.quaternion.copy(q1).multiply(pane.look);
    const x = pane.side > 0 ? 0 : w;
    mirrorShot.viewport.set(x, 0, w, h); mirrorShot.scissor.set(x, 0, w, h); mirrorShot.scissorTest = true;
    renderer.setRenderTarget(mirrorShot);
    renderer.render(scene, pane.eye);
  }
  renderer.setRenderTarget(null);
  renderer.shadowMap.autoUpdate = shadows;
  for (const o of put) o.visible = true;
  cars.forEach((c, i) => { c.userData.tag.visible = tags[i]; });
}

// What a camera does to the picture: part of the 3D view, joined on after replay3d_models.js (see replay3d.js); not
// a module on its own. Three things Eric asked for (11 Oct 2026):
//
//   heat      "very subtle heat coming from the exhaust ... that distortion effect watching it on tv": the air over
//             a hot exhaust bends what is seen through it.
//   focus     "depth of field for the race director camera angle so it looks more like watching it on tv, with the
//             focus locked to the car thats selected": the trackside cameras and the helicopter have long lenses,
//             and a long lens holds one distance sharp.
//   drone     "an fpv pov drone that does orbits and chase and flips and tornados over the car selected in a fun
//             stylistic way": a camera of its own (Drone, key 6).
//
// The first two are one pass over the finished picture, straight after the world is drawn and before the glow is
// added, and it needs to know how far away everything in the picture is: the world is drawn into a target that
// keeps its depth as a picture too (init() in replay3d.js). The pass is only run when it has something to do.

const LENS = {
  heat: 1,              // the shimmer over an exhaust: 1 as set, 0 none, 2 twice as strong
  dof: 1,               // the long lenses' shallow focus: 1 as set, 0 everything sharp
  glass: 0.03,          // how big those lenses are: the sensor's height over the f-number, in metres. Far bigger than a
                        // real broadcast camera's (whose pictures are sharp nearly all the way through at these distances):
                        // set by eye, so a background reads as a background
  most: 9,              // the softest anything gets: the blur's radius, in pixels of a picture 1080 high
  sharp: 4,             // metres either side of the car that stay quite sharp, so the whole car is
  tilt: 10,             // the model on a table (replay3d_toy.js): how soft the top and the bottom of its picture get, the same way
  band: 0.13,           // and how much of the picture's height, either side of the chosen car, stays sharp
};
const HEAT = 6;         // how many exhausts shimmer at once: the ones that are biggest in the picture
// where the heat comes out of each vehicle (metres to its left, up, forward; then how wide the plume is there)
const HEAT_AT = { f1: [0, 0.5, -2.5, 0.3], brick: [0, 0.5, -2.45, 0.3], delorean: [0, 0.95, -2.2, 0.5], warthog: [0, 0.62, -2.6, 0.42], wiener: [0, 0.42, -2.35, 0.4],
                  chariot: null, duck: null, saucer: null };      // horses, a bath toy, whatever a saucer runs on: nothing burns

const LensShader = {
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null }, px: { value: new THREE.Vector2(1, 1) }, aspect: { value: 1 }, near: { value: 0.4 }, far: { value: 9000 }, time: { value: 0 },
    heatN: { value: 0 }, heatA: { value: Array.from({ length: HEAT }, () => new THREE.Vector4()) }, heatB: { value: Array.from({ length: HEAT }, () => new THREE.Vector4()) },
    focus: { value: 50 }, blur: { value: 0 }, most: { value: 9 }, stride: { value: 1.15 }, sharp: { value: 0 }, fish: { value: 0 }, show: { value: 0 },
    tilt: { value: 0 }, tiltAt: { value: 0.5 }, tiltBand: { value: 0.13 },
  },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: `
    #include <packing>
    #define HEAT ${HEAT}
    uniform sampler2D tDiffuse; uniform sampler2D tDepth;
    uniform vec2 px; uniform float aspect; uniform float near; uniform float far; uniform float time;
    uniform int heatN; uniform vec4 heatA[HEAT]; uniform vec4 heatB[HEAT];
    uniform float focus; uniform float blur; uniform float most; uniform float stride; uniform float sharp; uniform float fish; uniform float show;
    uniform float tilt; uniform float tiltAt; uniform float tiltBand;
    varying vec2 vUv;
    // how far off what is drawn at a place in the picture is, in metres
    float away(vec2 uv) { return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, near, far); }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float boil(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y) - 0.5; }
    // Hot air: each plume is a line in the picture from the pipe (A) to where it has thinned to nothing (B), widening
    // as it goes. What is seen through it is moved about by a slow boil and a quick one, both streaming away from the
    // pipe; what stands nearer than the plume is not touched.
    vec2 shimmer(vec2 uv, float here) {
      vec2 off = vec2(0.0);
      for (int i = 0; i < HEAT; i++) {
        if (i >= heatN) break;
        vec2 p = (uv - heatA[i].xy) * vec2(aspect, 1.0), ab = (heatB[i].xy - heatA[i].xy) * vec2(aspect, 1.0);
        float len = max(length(ab), 1e-5), r = heatA[i].z;
        vec2 dir = ab / len, side = vec2(-dir.y, dir.x);
        float al = dot(p, dir), ac = dot(p, side), along = clamp(al / len, 0.0, 1.0);
        float d = length(vec2(al - along * len, ac)) / (r * mix(0.6, 1.7, along));
        if (d >= 1.0) continue;
        float w = 1.0 - d * d; w *= w * (1.0 - along * along);
        w *= smoothstep(-1.2, 0.4, here - mix(heatA[i].w, heatB[i].w, along));
        vec2 q = vec2(ac, al) / r; float t = time * 2.6 + float(i) * 7.3;
        vec2 n = vec2(boil(q * 1.9 + vec2(0.0, -t)), boil(q * 1.9 + vec2(5.2, -t * 1.17)))
               + 0.5 * vec2(boil(q * 4.3 + vec2(1.7, -t * 2.1)), boil(q * 4.3 + vec2(9.4, -t * 1.8)));
        off += (side * n.x + dir * n.y) * (w * heatB[i].z * r);
      }
      return off / vec2(aspect, 1.0);
    }
    // A lens: how big a disc a point at distance s is smeared into, in pixels (the radius), when the focus is on the car.
    float disc(float s) { return min(most, blur * max(0.0, abs(1.0 / focus - 1.0 / max(s, 0.05)) - sharp)); }
    void main() {
      vec2 uv = vUv;
      if (fish > 0.0) {           // an action camera's lens: the edges of the picture squeezed in, straight lines bowed
        vec2 c = (uv - 0.5) * vec2(aspect, 1.0);
        c *= (1.0 + fish * dot(c, c)) / (1.0 + fish * 0.25 * (aspect * aspect + 1.0));
        uv = c / vec2(aspect, 1.0) + 0.5;
      }
      float here = away(uv);
      vec2 moved = heatN > 0 ? shimmer(uv, here) : vec2(0.0);
      uv += moved;
      vec4 c = texture2D(tDiffuse, uv);
      float mine = 0.0;
      if (blur > 0.0) {
        // Each pixel gathers from a disc round itself, along a spiral turned differently at every pixel. A neighbour
        // counts if its own disc is big enough to reach here, and something sharp in front is not smeared by what is
        // soft behind it.
        here = away(uv); mine = disc(here);
        vec3 sum = c.rgb; float count = 1.0, radius = stride, ang = hash(gl_FragCoord.xy) * 6.2831853;
        for (int j = 0; j < 110; j++) {
          if (radius >= most) break;
          vec2 at = uv + vec2(cos(ang), sin(ang)) * px * radius;
          float s = away(at), theirs = disc(s);
          if (s > here) theirs = clamp(theirs, 0.0, mine * 2.0);
          sum += mix(sum / count, texture2D(tDiffuse, at).rgb, smoothstep(radius - 0.5, radius + 0.5, theirs));
          count += 1.0; radius += stride / radius; ang += 2.39996323;
        }
        c.rgb = sum / count;
      }
      if (tilt > 0.0) {
        // A lens tilted to its subject keeps one band across the picture sharp and lets what is above and below it
        // go: it is how a real place is made to look like a model of itself. How soft, by how far from the band.
        float soft = tilt * smoothstep(tiltBand, tiltBand + 0.4, abs(vUv.y - tiltAt));
        if (soft > 0.7) {
          vec3 sum = c.rgb; float count = 1.0, radius = stride, ang = hash(gl_FragCoord.xy) * 6.2831853;
          for (int j = 0; j < 110; j++) {
            if (radius >= soft) break;
            sum += texture2D(tDiffuse, uv + vec2(cos(ang), sin(ang)) * px * radius).rgb;
            count += 1.0; radius += stride / radius; ang += 2.39996323;
          }
          c.rgb = sum / count;
        }
      }
      if (show > 0.5) c.rgb = vec3(mine / most) * 0.6 + vec3(length(moved / px) * 0.4, 0.0, 0.0);      // (for looking at what it is doing: white where it is soft, red where the air moves)
      gl_FragColor = c;
    }`,
};
class LensPass extends ShaderPass {       // a pass that is also handed how far away everything in the picture is
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    this.uniforms.tDepth.value = readBuffer.depthTexture;
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
  }
}
let lens = null, lensFocus = 0, lensShot = null, lensStation = -1;
const lA = new THREE.Vector3(), lB = new THREE.Vector3(), heatSeen = [];
function lensInit() { lens = new LensPass(LensShader); lens.enabled = false; return lens; }

// The plumes in the picture: from each exhaust, straight up when the car stands (the heat rises), laid back along
// its path and longer as it goes faster (and weaker: the wind mixes it away), stronger with the throttle open.
function heatFind(t, tanHalf) {
  const spot = HEAT_AT[rideShown];
  if (!spot) return 0;
  const C = S.CH, f = Math.floor(S.frameAt(t)), u = lens.uniforms;
  heatSeen.length = 0;
  for (const car of cars) {
    if (!car.visible) continue;
    const size = spot[3] / (2 * car.position.distanceTo(camera.position) * tanHalf);      // how big its plume is in the picture (of the picture's height)
    if (size > 0.004) heatSeen.push([size, car]);
  }
  heatSeen.sort((a, b) => b[0] - a[0]);
  let count = 0;
  for (const [, car] of heatSeen) {
    if (count === HEAT) break;
    const i = car.userData.i, v = C.speed[i][f] / 3.6, yaw = car.rotation.y;
    if (C.rpm && C.rpm[i][f] * 64 < 900) continue;                                         // its engine is off
    car.updateMatrixWorld(true);
    lA.set(spot[0], spot[1], spot[2]).applyMatrix4(car.userData.body.matrixWorld);
    const back = v / (v + 7);
    lB.set(-Math.sin(yaw) * back, 0.3 + 0.7 * (1 - back), -Math.cos(yaw) * back).normalize().multiplyScalar(1.5 + 2.8 * Math.min(1, v / 45)).add(lA);
    lA.applyMatrix4(camera.matrixWorldInverse); lB.applyMatrix4(camera.matrixWorldInverse);
    const dA = -lA.z;
    let dB = -lB.z;
    if (dA < 0.3) continue;                                                                 // behind the camera
    if (dB < 0.3) { lB.lerpVectors(lA, lB, (dA - 0.3) / (dA - dB)); dB = 0.3; }            // (its far end is: cut it short there)
    const r = spot[3] / (2 * dA * tanHalf);
    lA.applyMatrix4(camera.projectionMatrix); lB.applyMatrix4(camera.projectionMatrix);
    if (Math.min(lA.x, lB.x) > 1.4 || Math.max(lA.x, lB.x) < -1.4 || Math.min(lA.y, lB.y) > 1.4 || Math.max(lA.y, lB.y) < -1.4) continue;      // out of the picture
    const strong = LENS.heat * 0.17 * (0.4 + 0.6 * C.throttle[i][f] / 100) * (1 - 0.5 * Math.min(1, v / 75));
    u.heatA.value[count].set(lA.x * 0.5 + 0.5, lA.y * 0.5 + 0.5, r, dA);
    u.heatB.value[count].set(lB.x * 0.5 + 0.5, lB.y * 0.5 + 0.5, strong, dB);
    count++;
  }
  return count;
}
function lensStep(t, dt, focusCar) {      // each frame, once the camera is where it will be
  const u = lens.uniforms, shot = follow.shot, W = renderer.domElement.width, H = renderer.domElement.height;
  if (quality < 2) { lens.enabled = false; return; }                // (a machine that is struggling goes without, as it does without the glow)
  camera.updateMatrixWorld();
  const tanHalf = Math.tan(camera.fov * Math.PI / 360), k = H / 1080;
  let blur = 0;
  if (LENS.dof > 0 && focusCar && (shot === "tv" || shot === "heli")) {
    // the focus is pulled to the chosen car and kept on it; at a cut it is there already
    const want = Math.max(1, -lA.copy(focusCar.position).applyMatrix4(camera.matrixWorldInverse).z);
    const cut = shot !== lensShot || (shot === "tv" && follow.station !== lensStation) || !(lensFocus > 0);
    lensFocus = cut ? want : lerp(lensFocus, want, 1 - Math.exp(-dt / 0.08));
    // A lens of focal length f and aperture f/N, on a sensor h high, smears a point at distance s into a disc
    // (f/N) * f * |1/focus - 1/s| across: in pixels of a picture H high, (h/N) * H / (4 tan^2(fov/2)) * |1/focus - 1/s|.
    // So a long lens (a small field of view) is far shallower than a wide one, as it is.
    blur = LENS.dof * LENS.glass * H / (4 * tanHalf * tanHalf);
    u.focus.value = lensFocus; u.sharp.value = LENS.sharp / (lensFocus * lensFocus);
  }
  lensShot = shot; lensStation = follow.station;
  u.blur.value = blur; u.most.value = LENS.most * k; u.stride.value = 1.15 * k * k;      // (the same number of looks whatever the picture's size)
  u.fish.value = shot === "drone" ? DRONE.fish : 0;
  u.tilt.value = shot === "iso" ? LENS.tilt * k : 0;
  if (shot === "iso") { u.tiltBand.value = LENS.band; u.tiltAt.value = focusCar ? clamp(lA.copy(focusCar.position).project(camera).y * 0.5 + 0.5, 0.25, 0.75) : 0.5; }
  u.px.value.set(1 / W, 1 / H); u.aspect.value = W / H; u.near.value = camera.near; u.far.value = camera.far; u.time.value = t % 100;
  u.heatN.value = LENS.heat > 0 ? heatFind(t, tanHalf) : 0;
  lens.enabled = blur > 0 || u.fish.value > 0 || u.heatN.value > 0 || u.tilt.value > 0;
}
api.lens = LENS;
Object.defineProperty(api.debug, "lens", { get: () => lens });

// ------------------------------------------------------------------ the drone
// A racing drone with a wide action camera, flown round the chosen car for show. Its flight is a programme 44
// seconds long that then begins again, and where it is is worked out from the replay's own time alone: scrub
// back and it is where it was, pause and it hangs there, and a video export films the same flight every time.
// It is flown in the car's own frame (so many metres to its left, above it, behind it), and that frame turns a
// moment after the car does, so through a corner the drone swings wide and banks, as a pilot chasing it would.
//
//    0  chase        low behind, weaving, coming in close over the rear wing and easing back
//    8  orbit        twice round the car, banked in, the car held off-centre
//   16  loop         up and over the car and down in front of it, on its back at the end (the picture turns over)
//   19  flip, lead   half a roll to come upright, flying backwards ahead of the car, looking back at it
//   23  pass         slides aside, lets the car by and swings round after it
//   26  tornado      a spiral that tightens and climbs to 11 m, spinning faster, banked hard, looking down
//   33  dive         back down out of it, the spin running out, to behind the car
//   36  skim         low and close, side to side, with a barrel roll in the middle
const DRONE = { fov: 84, fish: 0.22, lap: 44, back: 6.2, high: 2, float: 1 };      // its lens (degrees top to bottom, before the lens's own squeeze), how much that squeeze is, the programme's length, and where it sits when it is simply following: metres behind the car and above it
const droneNow = {};
let droneHint = null;
// It floats (Eric, 11 Oct 2026: "add a little bit of float to the fpv drone so its like real drones trying to hold
// position"). A drone holding its place is never still: it wanders a hand's breadth or two and keeps correcting,
// and every correction is a lean, because leaning is the only way it has to move. So its place beside the car
// drifts slowly, each way by its own slow sum of waves (worked out from the replay's time, like the rest of its
// flight), and it rolls and nods by exactly what that drift's push and pull would take; its aim wanders a
// little too. DRONE.float: 1 as set, 0 a camera on a rail.
const FLOAT = { s: [0.32, 0.83, 1.37, 2.9, 1.3], h: [0.2, 0.71, 1.61, 3.3, 4.1], b: [0.36, 0.57, 1.19, 2.3, 0.7],      // each: how far (m), three paces (radians a second), where in them it starts
                aim: [0.16, 0.47, 1.03, 2.1, 2.6] };
const WAVES = [0.56, 0.32, 0.12];         // how much of each pace: mostly the slowest
function floated(t, [far, a, b, c, from], push) {      // where the drift has it at time t; with `push`, how hard it is being pushed there (m/s2)
  const w = [a, b, c];
  let out = 0;
  for (let i = 0; i < 3; i++) out += WAVES[i] * (push ? -w[i] * w[i] : 1) * Math.sin(t * w[i] + from * (i + 1));
  return far * DRONE.float * out;
}
const eased = x => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };     // 0 to 1, starting and ending gently
const hump = u => Math.sin(Math.PI * clamp(u, 0, 1));                       // 0, up to 1 in the middle, 0
const edged = (x, lo, hi, w = 1.5) => (x > hi - w ? hi - w + w * Math.tanh((x - hi + w) / w) : x < lo + w ? lo + w - w * Math.tanh((lo + w - x) / w) : x);      // held between two walls, coming up to them gently
function droneFlight(tau, o) {
  // s, h, b: metres to the car's left, above it, behind it. ls, lh, lb: the same for the point it looks at.
  // roll: turned about its own line of sight (positive: left side down). loop: how far round the loop it is (its
  // top then points along the loop). bank: how much it leans with the car through a corner.
  const B = DRONE.back, H = DRONE.high;
  o.s = 0; o.h = H; o.b = B; o.ls = 0; o.lh = 0.55; o.lb = -1.5; o.roll = 0; o.loop = -1; o.bank = 0;
  if (tau < 8) {
    const u = tau / 8, e = hump(u);
    o.s = 2.2 * Math.sin(3 * Math.PI * u) * e; o.b = B - 2.6 * e * e; o.h = H - 0.6 * e;
    o.roll = 0.3 * Math.cos(3 * Math.PI * u) * e; o.bank = 1 - eased((u - 0.85) / 0.15);
  } else if (tau < 16) {
    const u = (tau - 8) / 8, e = hump(u), th = 4 * Math.PI * (u - Math.sin(2 * Math.PI * u) / (2 * Math.PI)), r = B + 0.8 * e, lead = 0.35 * r * e;
    o.s = r * Math.sin(th); o.b = r * Math.cos(th); o.h = H + 0.9 * e;
    o.ls = lead * Math.cos(th); o.lb = -1.5 * (1 - e) - lead * Math.sin(th); o.roll = -0.5 * e;
  } else if (tau < 19) {
    const u = (tau - 16) / 3, ph = Math.PI * eased(u);
    o.b = B * Math.cos(ph); o.h = H + 6.5 * Math.sin(ph); o.lb = -1.5 * (1 - eased(u)); o.loop = ph;
  } else if (tau < 23) {
    const e = eased((tau - 19) / 4);
    o.b = -B - 1.8 * e; o.h = H - 0.35 * e; o.lb = 0; o.roll = Math.PI * (1 - eased((tau - 19) / 0.8));
  } else if (tau < 26) {
    const u = (tau - 23) / 3, e = hump(u);
    o.b = lerp(-B - 1.8, B, eased(u)); o.s = 3 * e; o.h = H - 0.35 * (1 - u) + 0.5 * e; o.lb = -1.5 * eased(u); o.roll = -0.35 * e;
  } else if (tau < 33) {
    const w = (tau - 26) / 7, e = eased(w), th = 6 * Math.PI * Math.pow(w, 1.8), r = lerp(B, 3, e);
    o.s = -r * Math.sin(th); o.b = r * Math.cos(th); o.h = H + 9.5 * e; o.lb = -1.5 * (1 - e); o.roll = 0.9 * e;
  } else if (tau < 36) {
    const v = (tau - 33) / 3, e = eased(v), th = 2 * Math.PI * (1 - Math.pow(1 - v, 2.2)), r = lerp(3, B, e);
    o.s = -r * Math.sin(th); o.b = r * Math.cos(th); o.h = H + 9.5 * (1 - e); o.lb = -1.5 * e; o.roll = 0.9 * (1 - e);
  } else {
    const u = (tau - 36) / 8, e = hump(u);
    o.s = -2 * Math.sin(2 * Math.PI * u) * e; o.b = B - 2 * e; o.h = H - 0.8 * e;
    o.roll = -0.3 * Math.cos(2 * Math.PI * u) * e + 2 * Math.PI * eased((u - 0.44) / 0.13); o.bank = eased(u / 0.12);
  }
  return o;
}
function droneAim(car, p, t) {            // puts the camera where the drone is at replay time t; gives back its lens
  const i = car.userData.i, seg = S.seg, lap = DRONE.lap, tau = (((t - (seg ? seg.from : 0)) % lap) + lap) % lap, o = droneFlight(tau, droneNow);
  // which way the car has been going this last half second, or which way it points when it is standing
  const a = pose(i, t - 0.5) || p, b = pose(i, t + 0.2) || p, went = Math.hypot(b.x - a.x, b.z - a.z), w = went > 60 ? 0 : eased((went - 0.6) / 2.4);
  let fx = lerp(Math.sin(p.yaw), (b.x - a.x) / Math.max(went, 1e-6), w), fz = lerp(Math.cos(p.yaw), (b.z - a.z) / Math.max(went, 1e-6), w);
  const fl = Math.hypot(fx, fz) || 1;
  fx /= fl; fz /= fl;
  const lx = fz, lz = -fx, py = car.position.y;
  const fs = floated(t, FLOAT.s), fb = floated(t, FLOAT.b), fh = floated(t, FLOAT.h);
  let x = p.x + lx * (o.s + fs) - fx * (o.b + fb), z = p.z + lz * (o.s + fs) - fz * (o.b + fb), y = py + o.h + fh;
  // low down it keeps inside the walls and their fences; from a few metres up it is clear of them. Never into the ground.
  const g = groundAt(x, z, droneHint), free = eased((y - g.y - 4.5) / 2.5);
  droneHint = g.k;
  if (free < 1) {
    const push = (edged(g.off, 1.4 - WALL.L[g.k], WALL.R[g.k] - 1.4) - g.off) * (1 - free), nm = K.normal[g.k];
    x += nm[0] * push; z += nm[1] * push;
  }
  camera.position.set(x, Math.max(y, g.y + 0.9), z);
  if (o.loop >= 0) camera.up.set(fx * Math.sin(o.loop), Math.cos(o.loop), fz * Math.sin(o.loop)); else camera.up.set(0, 1, 0);
  // Its aim is a little off the car, and moving; and it leans the way it is being pushed: to its left to go left
  // (a roll), nose down to go forward (a nod, which shows as looking a little lower: the nod is put into where it
  // looks and not into a turn of its own, which would change sign where the loop hands over to the half roll).
  const as = floated(t + 31, FLOAT.aim), tx = p.x + lx * (o.ls + as) - fx * o.lb, tz = p.z + lz * (o.ls + as) - fz * o.lb;
  const nod = clamp(floated(t, FLOAT.b, true) / 9.81, -0.05, 0.05) * Math.hypot(tx - camera.position.x, tz - camera.position.z);
  camera.lookAt(tx, py + o.lh + 0.6 * floated(t + 67, FLOAT.aim) + nod, tz);
  let roll = o.roll + clamp(floated(t, FLOAT.s, true) / 9.81, -0.06, 0.06);
  if (o.bank) {                           // leaning into the corner with the car: its sideways pull, a fifth of it
    const y0 = pose(i, t - 0.25), y1 = pose(i, t + 0.25);
    if (y0 && y1) roll += o.bank * clamp(Math.atan(turn(y0.yaw, y1.yaw) / 0.5 * (p.speed / 3.6) / 9.8 * 0.2), -0.6, 0.6);
  }
  if (roll) camera.rotateZ(roll);
  return DRONE.fov;
}
api.drone = DRONE;

// The circuit as a model on a table: part of the 3D view, joined on after replay3d_lens.js (see replay3d.js); not a
// module on its own. Eric, 11 Oct 2026, with five pictures of circuits drawn as bright little dioramas: "can you make
// the 2.5D an option between 2d and 3d. make the map look like the circuit but make it look isometric and with tilt
// shift, needs to have the aesthetic like the pictures".
//
// It is the same circuit as the 3D view (the surveyed road, and for a circuit that has been looked up its own
// stands, buildings and paint), looked at the way a model is:
//   - from above and to one side, with no vanishing: the camera is a very long lens a long way off, which is what
//     an isometric drawing is (drag turns the table, the wheel brings it nearer or takes in the whole circuit);
//   - in daylight, on sand, with the night's things put away (the sky, the lamps' glows, the mist);
//   - with the cars several times life size, as a model's are, so they can be seen and told apart;
//   - and with the top and the bottom of the picture out of focus (replay3d_lens.js), which is what makes a real
//     place look like a model of itself.
// It follows the chosen car; from far enough out it looks at the middle of the circuit instead.

const TOY = {
  on: false,
  az: 0.72, el: 0.63,                 // which way it is looked at from: round the table, and how far above it (radians)
  tall: 300,                          // how much of the place the picture takes in, top to bottom, metres (along the lens's own up)
  fov: 1.6,                           // the lens: so long that nothing vanishes
  big: 1,                             // the cars' size on top of what the distance gives them (1 as set)
  ground: 0xe6d6ad, sunAt: [-0.5, 0.74, 0.45],      // the sand, and where the sun stands
  look: new THREE.Vector3(), set: false, near: 1, far: 9000, lit: null,
};
let toyNight = null;                  // how the night was lit, to go back to
let toyLand = null;                   // what is round the model: made the first time it is looked at
const toyMiddle = (() => {            // the middle of the circuit
  const c = K.centre, y = c.reduce((s, q) => s + q[1], 0) / c.length;
  if (K.venue && K.venue.centre) return [K.venue.centre[0], y, K.venue.centre[1]];
  return [c.reduce((s, q) => s + q[0], 0) / c.length, y, c.reduce((s, q) => s + q[2], 0) / c.length];
})();
function toyAim(car, p, dt) {         // puts the camera for the model; gives back its lens
  const wide = eased((TOY.tall - 520) / 900);
  v1.set(lerp(p.x, toyMiddle[0], wide), lerp(car.position.y, toyMiddle[1], wide), lerp(p.z, toyMiddle[2], wide));
  if (follow.cut || !TOY.set) { TOY.look.copy(v1); TOY.set = true; } else TOY.look.lerp(v1, 1 - Math.exp(-dt / 0.3));
  const far = TOY.tall / (2 * Math.tan(TOY.fov * Math.PI / 360)), flat = Math.cos(TOY.el);
  camera.position.set(TOY.look.x + far * flat * Math.sin(TOY.az), TOY.look.y + far * Math.sin(TOY.el), TOY.look.z + far * flat * Math.cos(TOY.az));
  camera.up.set(0, 1, 0); camera.lookAt(TOY.look);
  TOY.near = Math.max(10, far - 3200); TOY.far = far + 4800;
  return TOY.fov;
}
function toySet(on) {                 // the night put away and the daylight brought out, or back again
  if (TOY.on === on) return;
  TOY.on = on;
  if (!toyNight) toyNight = { fog: scene.fog, hemi: [hemi.color.getHex(), hemi.groundColor.getHex(), hemi.intensity], sun: [sun.color.getHex(), sun.intensity], fill: fillLight.intensity,
                              ground: farGround.material.color.getHex(), env: scene.environmentIntensity, edge: finish.uniforms.amount.value, grain: finish.uniforms.grain.value };
  const n = toyNight;
  skyRoot.visible = !on;
  for (const q of nightOnly) q.visible = !on;
  scene.fog = on ? null : n.fog;
  scene.background = on ? new THREE.Color(TOY.ground) : null;
  hemi.color.setHex(on ? 0xffffff : n.hemi[0]); hemi.groundColor.setHex(on ? 0xd9c39a : n.hemi[1]); hemi.intensity = on ? 1.45 : n.hemi[2];
  sun.color.setHex(on ? 0xfff5e2 : n.sun[0]); sun.intensity = on ? 3.3 : n.sun[1];
  fillLight.intensity = on ? 0.55 : n.fill;
  if (on) for (const lamp of lamps) lamp.intensity = 0;
  farGround.material.color.setHex(on ? TOY.ground : n.ground);
  scene.environmentIntensity = on ? 0.3 : n.env;
  renderer.toneMapping = on ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
  bloom.enabled = !on && quality > 1;
  finish.uniforms.amount.value = on ? 0.1 : n.edge; finish.uniforms.grain.value = on ? 0 : n.grain; finish.uniforms.rich.value = on ? 1.14 : 1;
  // what was painted for the night, in daylight colours: the ground beyond the walls, the car parks
  if (on) for (const [key, m] of Object.entries(vMats)) if (key.startsWith("lot") && !toySkin.some(q => q[0] === m)) toySkin.push([m, { map: toyLot() }]);
  for (const [mat, toy] of toySkin) {
    if (on) {
      mat.userData.night = {};
      for (const key in toy) {
        mat.userData.night[key] = mat[key] && mat[key].isColor ? mat[key].clone() : mat[key];
        if (toy[key] && toy[key].isColor) mat[key].copy(toy[key]); else mat[key] = toy[key];
      }
    } else if (mat.userData.night) {
      for (const key in mat.userData.night) { const was = mat.userData.night[key]; if (was && was.isColor) mat[key].copy(was); else mat[key] = was; }
      delete mat.userData.night;
    }
    mat.needsUpdate = true;
  }
  if (on && !toyLand) { toyLand = toyDress(); scene.add(toyLand); }
  if (toyLand) toyLand.visible = on;
  // Shadows: of everything in the picture, not only what is round the chosen car, and made again only when the
  // picture has moved on (the scenery stands still). The cars cast none here: each has the dark patch under it.
  sun.shadow.mapSize.setScalar(on ? 4096 : 2048);
  if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  if (!on) {
    Object.assign(sun.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55, near: 10, far: 420 }); sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.04;
    for (const car of cars) { car.scale.setScalar(1); car.traverse(q => { if (q.userData.cast !== undefined) { q.castShadow = q.userData.cast; delete q.userData.cast; } }); }
  }
  renderer.shadowMap.autoUpdate = !on; renderer.shadowMap.needsUpdate = true;
  TOY.lit = null; TOY.set = false; follow.cut = true;
}
// Round the circuit. The night shows nothing beyond the walls, and needs nothing there. A model on a table has to
// have a country round it, and this circuit's is desert: low terraces of rock in the sand, each a step or two
// high, scrub, and the highway that runs past. All of it is put where nothing else is: clear of the road and its
// walls and masts, and of everything the circuit's own file stands beside it (toyClear()).
function toyClear(x, z, r) {
  const g = groundAt(x, z, null), wall = g.off < 0 ? WALL.L[g.k] : WALL.R[g.k];
  if (Math.abs(g.off) < wall + 24 + r) return false;
  const V = K.venue;
  if (!V) return true;
  const lap = g.k * BIN, whole = n * BIN, within = (a, b, m) => { const d = ((lap - a) % whole + whole) % whole, len = ((b - a) % whole + whole) % whole; return d <= len + m || d >= whole - m; };
  const beside = [...(V.paddock || []), ...(V.tents || []), ...(V.stands || []), ...(V.trees || []).map(q => q.lap), ...((V.props || {}).palms || []).map(q => q.lap)];
  if (V.pit && lane) beside.push({ from: V.pit.from, to: V.pit.to, near: lane.side * 8, far: lane.side * 190 });
  for (const q of beside) if (q && within(q.from, q.to, 50) && g.off > Math.min(q.near, q.far) - 30 - r && g.off < Math.max(q.near, q.far) + 30 + r) return false;
  const boxes = [...(V.carParks || []), ...(V.blocks || []), ...(V.arena ? [V.arena] : [])];
  for (const q of boxes) {
    const dx = x - q.at[0], dz = z - q.at[1], way = q.way || [1, 0], along = dx * way[0] + dz * way[1], across = dx * way[1] - dz * way[0];
    if (Math.abs(along) < q.size[0] / 2 + 14 + r && Math.abs(across) < q.size[1] / 2 + 14 + r) return false;
  }
  for (const q of V.standsAt || []) { const [a, b] = q.front, mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2; if (Math.hypot(x - mx, z - mz) < Math.hypot(a[0] - b[0], a[1] - b[1]) / 2 + q.deep + 16 + r) return false; }
  if (V.vvip && Math.hypot(x - V.vvip.at[0], z - V.vvip.at[1]) < V.vvip.across + 12 + r) return false;
  for (const q of V.towers || []) if (Math.hypot(x - q[0], z - q[1]) < 30 + r) return false;
  const road = (V.road || {}).through || [];
  for (let i = 0; i + 1 < road.length; i++) {
    const [ax, az] = road[i], [bx, bz] = road[i + 1], t = clamp(((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2), 0, 1);
    if (Math.hypot(x - ax - (bx - ax) * t, z - az - (bz - az) * t) < 26 + r) return false;
  }
  return true;
}
function toyLot() {                   // a car park by day: pale tarmac, white bays, and cars of every colour in most of them
  const r = seeded(5);
  return tex(256, 256, (c, w, h) => {
    speckle(c, w, h, "#9a9da3", 5000, 0.06, 2);
    for (let row = 0; row < 4; row++) for (let i = 0; i < 16; i++) {
      c.fillStyle = "rgba(255,255,255,0.75)"; c.fillRect(i * 16, row * 64 + 8, 1, 22); c.fillRect(i * 16, row * 64 + 34, 1, 22);
      for (const y of [10, 36]) if (r() < 0.62) {
        const kind = r();
        c.fillStyle = kind < 0.36 ? "#f1f1ee" : kind < 0.58 ? "#3a3d44" : kind < 0.8 ? "#b9bcc2" : `hsl(${Math.floor(r() * 360)},${30 + Math.floor(r() * 25)}%,${42 + Math.floor(r() * 16)}%)`;      // (most cars are white, grey or black)
        c.fillRect(i * 16 + 3, row * 64 + y, 10, 18);
        c.fillStyle = "rgba(20,30,45,0.55)"; c.fillRect(i * 16 + 4, row * 64 + y + 5, 8, 4);      // its glass
      }
    }
  }, { aniso: 8 });
}
function toyGround(x, z) {            // how high the ground is there: it falls away from the walls to the plain
  const g = groundAt(x, z, null), sign = g.off < 0 ? -1 : 1, wall = sign < 0 ? WALL.L[g.k] : WALL.R[g.k], out = Math.abs(g.off) - wall, plain = farGround.position.y;
  if (out >= 60) return plain;
  const edge = verge(g.k, sign * wall) - 0.02;
  return out <= 14 ? edge : lerp(edge, plain + 0.05, (out - 14) / 46);
}
function toyDress() {
  const G = new THREE.Group(), r = seeded(77), pos = [], col = [], y0 = farGround.position.y;
  const tone = new THREE.Color(), face = (a, b, c, shade) => { for (const q of [a, b, c]) { pos.push(q[0], q[1], q[2]); col.push(tone.r * shade, tone.g * shade, tone.b * shade); } };
  // terraces: a ragged slab of rock, a smaller one on it, sometimes a third
  const span = Math.max(...K.centre.map(c => Math.hypot(c[0] - toyMiddle[0], c[2] - toyMiddle[2]))) + 520;
  let made = 0;
  for (let tries = 0; tries < 2600 && made < 150; tries++) {
    const a = r() * TAU, d = Math.sqrt(r()) * span, x = toyMiddle[0] + Math.sin(a) * d, z = toyMiddle[2] + Math.cos(a) * d, size = 16 + r() * 34;
    if (!toyClear(x, z, size)) continue;
    made++;
    const base = toyGround(x, z) - 0.3, sides = 7 + Math.floor(r() * 4), turn = r() * TAU, long = 0.75 + r() * 0.7, rag = Array.from({ length: sides }, () => 0.72 + r() * 0.5);
    let low = Math.max(y0, base - 2), top = base;
    for (let step = 0, steps = 2 + (r() < 0.45 ? 1 : 0); step < steps; step++) {
      const shrink = [1, 0.66, 0.38][step], lift = [0.9, 0.8, 0.7][step] * (0.8 + r() * 0.6), ox = (r() - 0.5) * size * 0.2 * step, oz = (r() - 0.5) * size * 0.2 * step;
      const ring = rag.map((q, i) => { const b = turn + i / sides * TAU, rad = size * shrink * q; return [x + ox + Math.sin(b) * rad * long, z + oz + Math.cos(b) * rad]; });
      top += lift;
      tone.setHex([0xdcc898, 0xe3d1a2, 0xecdcb2][step]);
      for (let i = 0; i < sides; i++) {
        const p = ring[i], q = ring[(i + 1) % sides];
        face([x + ox, top, z + oz], [p[0], top, p[1]], [q[0], top, q[1]], 1);                                      // its top
        const shade = 0.78 + 0.14 * Math.sin(turn + i);                                                             // its sides, each a little differently lit
        face([p[0], top, p[1]], [p[0], low, p[1]], [q[0], low, q[1]], shade); face([p[0], top, p[1]], [q[0], low, q[1]], [q[0], top, q[1]], shade);
      }
      low = top;
    }
  }
  // drifts: the sand itself is not one colour
  for (let i = 0; i < 260; i++) {
    const a = r() * TAU, d = Math.sqrt(r()) * (span + 700), x = toyMiddle[0] + Math.sin(a) * d, z = toyMiddle[2] + Math.cos(a) * d, size = 40 + r() * 130;
    if (!toyClear(x, z, size * 0.5)) continue;
    const sides = 9, turn = r() * TAU, long = 0.6 + r() * 1.2, y = y0 + 0.03 + r() * 0.03;
    tone.setHex(r() < 0.5 ? 0xead9b3 : 0xdfcc9e);
    const ring = Array.from({ length: sides }, (q, j) => { const b = turn + j / sides * TAU, rad = size * (0.7 + r() * 0.5); return [x + Math.sin(b) * rad * long, z + Math.cos(b) * rad]; });
    for (let j = 0; j < sides; j++) face([x, y, z], [ring[j][0], y, ring[j][1]], [ring[(j + 1) % sides][0], y, ring[(j + 1) % sides][1]], 1);
  }
  const rock = new THREE.BufferGeometry();
  rock.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); rock.setAttribute("color", new THREE.Float32BufferAttribute(col, 3)); rock.computeVertexNormals();
  const slabs = new THREE.Mesh(rock, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
  slabs.castShadow = slabs.receiveShadow = true; G.add(slabs);
  // scrub: low dry bushes, in drifts
  const spots = [];
  for (let tries = 0; tries < 5200 && spots.length < 620; tries++) {
    const a = r() * TAU, d = Math.sqrt(r()) * span, x = toyMiddle[0] + Math.sin(a) * d, z = toyMiddle[2] + Math.cos(a) * d;
    if (!toyClear(x, z, 3)) continue;
    for (let j = 0, more = 1 + Math.floor(r() * 4); j < more; j++) spots.push([x + (r() - 0.5) * 16, z + (r() - 0.5) * 16, 1 + r() * 1.5, r()]);
  }
  const bush = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }), spots.length), m4 = new THREE.Object3D();
  spots.forEach(([x, z, size, hue], i) => {
    m4.position.set(x, toyGround(x, z) + size * 0.3, z); m4.scale.set(size, size * 0.62, size); m4.rotation.set(0, hue * 6, 0); m4.updateMatrix();
    bush.setMatrixAt(i, m4.matrix); bush.setColorAt(i, tone.setHex(hue < 0.5 ? 0x7d8a4d : hue < 0.8 ? 0x95955a : 0x5f7a45));
  });
  bush.castShadow = true; G.add(bush);
  // the highway that passes the circuit
  const road = ((K.venue || {}).road || {}).through || [];
  if (road.length > 1) {
    const rp = [], line = [];
    for (let i = 0; i + 1 < road.length; i++) {
      const [ax, az] = road[i], [bx, bz] = road[i + 1], len = Math.hypot(bx - ax, bz - az), nx = (bz - az) / len, nz = -(bx - ax) / len, y = y0 + 0.12;
      const quad4 = (w, lift, into) => into.push(ax - nx * w, y + lift, az - nz * w, bx - nx * w, y + lift, bz - nz * w, bx + nx * w, y + lift, bz + nz * w, ax - nx * w, y + lift, az - nz * w, bx + nx * w, y + lift, bz + nz * w, ax + nx * w, y + lift, az + nz * w);
      quad4(13, 0, rp); quad4(0.5, 0.05, line);
    }
    for (const [list, colour] of [[rp, 0x6f747c], [line, 0xf2f2ee]]) {
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(list, 3)); g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: colour, roughness: 0.9, side: THREE.DoubleSide })); mesh.receiveShadow = true; G.add(mesh);
    }
  }
  return G;
}
function toyLight() {                 // each frame, in place of the night's lamps
  const reach = clamp(TOY.tall * 1.35, 260, 1900), texel = 2 * reach / 4096, grid = texel * 16;
  const x = Math.round(TOY.look.x / grid) * grid, z = Math.round(TOY.look.z / grid) * grid, lit = TOY.lit;
  if (lit && Math.abs(x - lit.x) + Math.abs(z - lit.z) < reach * 0.14 && Math.abs(reach - lit.reach) < reach * 0.06) return;
  TOY.lit = { x, z, reach };
  sun.target.position.set(x, TOY.look.y, z);
  sun.position.set(x + TOY.sunAt[0] * 2400, TOY.look.y + TOY.sunAt[1] * 2400, z + TOY.sunAt[2] * 2400);
  Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 200, far: 5200 }); sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = texel * 0.9;
  for (const car of cars) car.traverse(q => { if (q.isMesh && q.castShadow) { if (q.userData.cast === undefined) q.userData.cast = true; q.castShadow = false; } });
  renderer.shadowMap.needsUpdate = true;
}
function toyStep() {                  // each frame: the cars at a model's size
  const big = TOY.on ? clamp(TOY.tall / 110, 1, 7) * TOY.big : 1;
  for (const car of cars) if (car.scale.x !== big) car.scale.setScalar(big);
}
api.toy = TOY;

document.dispatchEvent(new CustomEvent("stage3d-ready"));
