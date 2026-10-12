// The replay in three dimensions: the circuit rebuilt from where the cars' wheels went (track3d.py), every car
// placed and tilted as the game reported it, and cameras that stay on the car you pick.
// Inlined into replay.html by replay_build.py; talks to the page through window.__stage.
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

const S = window.__stage;
const K = S.D.track3d;
const n = K.centre.length, BIN = K.bin;
const LEFT = K.left, RIGHT = K.right;
const RIDE = 0.33;                    // the game's car position sits this far above the road
const TAU = Math.PI * 2;
const canvas = document.getElementById("map3d");
let renderer, composer, bloom, scene, camera, sun, cars = [], ready = false, startLights = [];
let mode = "auto", orbit = { az: 2.5, pol: 1.25, r: 9 }, follow = { yaw: null, cut: true };
let quality = 2;                      // 2 everything on, 1 no bloom and lighter shadows, 0 plain

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
const MASTS = [];                     // every floodlight mast: where its lamps are and where they point
const GRAVEL = { L: null, R: null };  // each side: how far beyond the road's edge the gravel begins and ends, by section
function buildCircuit() {
  const G = new THREE.Group();
  const lay = (geo, mat, o = {}) => { const m = new THREE.Mesh(geo, mat); m.receiveShadow = o.receive !== false; m.castShadow = !!o.cast; G.add(m); return m; };
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
  const mSand = new THREE.MeshStandardMaterial({ map: tex(256, 256, (c, w, h) => speckle(c, w, h, "#6b5c44", 9000, 0.3, 3)), vertexColors: true, roughness: 1, side: both });
  const mConcrete = new THREE.MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, map: tex(256, 256, (c, w, h) => speckle(c, w, h, "#5d5e60", 9000, 0.2, 2)), roughness: 0.75, side: both });

  // the far ground: dark, the circuit is the only thing lit out here
  const ground = lay(new THREE.PlaneGeometry(12000, 12000), new THREE.MeshStandardMaterial({ color: 0x0b0a08, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = floor;

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
  const mRubber = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.36, metalness: 0, envMapIntensity: 0.6, vertexColors: true, transparent: true, depthWrite: false,
                                                   side: both, polygonOffset: true, polygonOffsetFactor: -3.5, polygonOffsetUnits: -3.5 });
  lay(strip([-1, -0.55, 0, 0.55, 1].map(f => k => [clamp(f * (1.5 + K.rubber[k]), LEFT[k], RIGHT[k]), 0]),
            { tile: 6, alpha: (k, c) => [0, 0.7, 1, 0.7, 0][c] * (0.26 + 0.42 * (braking[k] || 0)) }), mRubber);
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
  for (const sign of [-1, 1]) {
    const E = k => (sign < 0 ? LEFT : RIGHT)[k], W = k => sign * (sign < 0 ? WALL.L : WALL.R)[k];
    const depth = k => Math.abs(W(k) - E(k));
    const pitSide = lane && lane.side === sign;
    const out = (k, d) => E(k) + sign * Math.min(d, depth(k));        // d metres beyond the edge, never past the wall
    const found = K.loose && K.loose[sign < 0 ? "left" : "right"] || [];
    // gravel: on the deep side of a bend, and anywhere a wheel found it; opening and closing gently
    const wants = new Float32Array(n);
    for (let k = 0; k < n; k++) wants[k] = (depth(k) > 21 && !(pitSide && lane.has(k))) || found[k] != null ? 1 : 0;
    const open = ease(wants, 6), from = new Float32Array(n);
    for (let k = 0; k < n; k++) from[k] = found[k] != null ? clamp(found[k] - Math.abs(E(k)) - 0.6, pitSide ? RAMP[1] : SLOPE_OUT, 7) : 7;
    const start = ease(from, 5);
    const g0 = k => lerp(depth(k) - 2.6, Math.min(start[k], depth(k) - 2.6), open[k]), g1 = k => depth(k) - 2.6;
    GRAVEL[sign < 0 ? "L" : "R"] = { from: Float32Array.from({ length: n }, (_, k) => g0(k)), to: Float32Array.from({ length: n }, (_, k) => g1(k)) };
    // (a column wherever the ground changes its slope, so the strip lies on the ground all the way across)
    lay(strip([k => [out(k, RAMP[0]), 0], k => [out(k, SLOPE_OUT), 0], k => [out(k, RAMP[1]), 0], k => [out(k, Math.max(6, depth(k) * 0.5)), 0], k => [W(k), 0]],
              { shade: (k, c) => [1, 1, 0.97, 0.92, 0.8][c] }), mRunoff);
    lay(strip([k => [E(k), 0], k => [out(k, RAMP[0]), 0]], { tile: 4 }), mAstro);
    lay(strip([k => [E(k) + sign * g0(k), 0], k => [E(k) + sign * (g0(k) + g1(k)) / 2, 0], k => [E(k) + sign * g1(k), 0]],
              { tile: 5, shade: (k, c) => [1, 0.95, 0.88][c] }), mGravel);
    // beyond the wall the light falls away into the dark
    lay(strip([k => [W(k), -0.02], k => [sign * within(k, sign, Math.abs(W(k)) + 14), -0.02], k => [sign * within(k, sign, Math.abs(W(k)) + 60), 0, floor + 0.05]],
              { tile: 10, shade: (k, c) => [0.5, 0.2, 0.02][c] }), mSand);
    // the wall: a face and a top, with a crisp edge between them
    lay(strip([k => [W(k), -0.05], k => [W(k), 1.05], k => [W(k), 1.05], k => [W(k) + sign * 0.45, 1.05]],
              { uv: (k, c, off, dist) => [-sign * dist / 32, c === 0 ? 0 : c === 1 ? 1 : 0.02] }), mWall, { cast: true });
    // a catch fence standing on it: posts every four metres and the mesh between
    lay(strip([k => [W(k) + sign * 0.2, 1.05], k => [W(k) + sign * 0.2, 4.3]], { uv: (k, c, off, dist) => [dist / 4, c] }), mFence);
    // red and white blocks in front of it on the outside of the bends
    let run = null;
    for (let k = 0; k <= n; k++) {
      const deep = k < n && open[k] > 0.6;
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

  // ---- floodlights: masts down both sides, each a glow in the night
  const masts = [];
  MASTS.length = 0;
  for (let k = 0, i = 0; k < n; k += 13, i++) {
    const sign = i % 2 ? -1 : 1, w = sign < 0 ? WALL.L[k] : WALL.R[k];
    if (lane && lane.has(k) && sign !== lane.side) continue;       // the grandstand has its own lights
    masts.push({ k, p: at(k, sign * within(k, sign, w + 5)), sign });
  }
  const steel = new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.5, metalness: 0.7 });
  const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.16, 0.3, 24, 6).translate(0, 12, 0), steel, masts.length);
  const head = new THREE.InstancedMesh(new THREE.BoxGeometry(4.6, 1.7, 0.4), steel, masts.length);
  const face = new THREE.InstancedMesh(new THREE.PlaneGeometry(4.3, 1.4).translate(0, 0, 0.21), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 5.5, 4.6) }), masts.length);
  const glow = [], dummy = new THREE.Object3D();
  masts.forEach((m, i) => {
    dummy.position.set(m.p[0], m.p[1], m.p[2]); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); pole.setMatrixAt(i, dummy.matrix);
    const c = K.centre[m.k];
    dummy.position.set(m.p[0], m.p[1] + 24.4, m.p[2]); dummy.lookAt(c[0], c[1], c[2]); dummy.updateMatrix(); head.setMatrixAt(i, dummy.matrix); face.setMatrixAt(i, dummy.matrix);
    glow.push(m.p[0], m.p[1] + 24.4, m.p[2]);
    MASTS.push({ x: m.p[0], y: m.p[1] + 24.4, z: m.p[2], tx: c[0], ty: c[1], tz: c[2] });
  });
  G.add(pole, head, face);
  const glowGeo = new THREE.BufferGeometry(); glowGeo.setAttribute("position", new THREE.Float32BufferAttribute(glow, 3));
  const halo = new THREE.Points(glowGeo, new THREE.PointsMaterial({ map: tex(64, 64, (c, w) => {
    const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStop(0, "rgba(255,246,225,1)"); g.addColorStop(0.18, "rgba(255,240,210,0.5)"); g.addColorStop(0.5, "rgba(255,230,190,0.1)"); g.addColorStop(1, "rgba(255,230,190,0)");
    c.fillStyle = g; c.fillRect(0, 0, w, w);
  }, { repeat: false }), size: 30, sizeAttenuation: true, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  G.add(halo);
  return G;
}
function wallTexture() {
  // 32 m of concrete wall with painted panels. The names are the event's own, never a real sponsor's.
  const words = [K.track.toUpperCase(), "PIT WALL", "GRAND PRIX", "NIGHT RACE"];
  return tex(2048, 64, (c, w, h) => {
    speckle(c, w, h, "#9a9a96", 5000, 0.15, 2);
    c.fillStyle = "#c2241f"; c.fillRect(0, h - 9, w, 5);
    const tones = ["#0c3b66", "#101214", "#7a1512", "#0f5a4c"];
    words.forEach((word, i) => {
      const x = i * w / 4 + 24, ww = w / 4 - 48;
      c.fillStyle = tones[i]; c.fillRect(x, 6, ww, h - 22);
      c.fillStyle = "#f2f2ee"; c.font = "800 30px system-ui, Segoe UI, Arial, sans-serif"; c.textAlign = "center"; c.textBaseline = "middle";
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
  const board = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.3).rotateY(Math.PI).translate(xm, H + 1.55, -0.02), new THREE.MeshBasicMaterial({
    map: tex(512, 74, (cx, w, h) => { cx.fillStyle = "#0b0c0e"; cx.fillRect(0, 0, w, h); cx.fillStyle = "#f4f4f0"; cx.font = "800 44px system-ui, Segoe UI, Arial, sans-serif"; cx.textAlign = "center"; cx.textBaseline = "middle"; cx.fillText(K.track.toUpperCase(), w / 2, h / 2 + 2, w - 30); }, { repeat: false }) }));
  g.add(board);
  const lampGeo = new THREE.CircleGeometry(0.17, 16).rotateY(Math.PI);
  for (let i = 0; i < 5; i++) {
    const x = xm + (2 - i) * 1.25;       // the first light is the one on the drivers' left: +x
    g.add(new THREE.Mesh(box(0.72, 1.1, 0.25, x, H - 0.35, -0.1), steel));
    const mat = new THREE.MeshBasicMaterial({ color: 0x1a0505 });
    for (const dy of [-0.08, -0.6]) { const lamp = new THREE.Mesh(lampGeo, mat); lamp.position.set(x, H + dy, -0.24); g.add(lamp); }
    startLights.push(mat);
  }
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
            { from: first + 10, count: lane.count - 20, uv: (k, c, o, dist) => [s * (c < 3 ? -1 : 1) * dist / 32, c === 0 || c === 5 ? 0 : c === 1 || c === 4 ? 1 : 0.02] }), M.mWall, { cast: true });
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
  lay(strip([k => [g0(k), 0], k => [g0(k), 3.0]], { from: sa, count: sc, uv: (k, c, o, dist) => [dist / 32, c] }), M.mWall, { cast: true });
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
function sky() {
  const dome = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: "varying vec3 p; void main(){ p = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: "varying vec3 p; void main(){ float h = clamp(normalize(p).y, 0.0, 1.0); vec3 low = vec3(0.060, 0.050, 0.075); vec3 high = vec3(0.004, 0.006, 0.016); gl_FragColor = vec4(mix(low, high, pow(h, 0.38)), 1.0); }" }));
  const stars = [], r = seeded(5);
  for (let i = 0; i < 420; i++) { const th = r() * TAU, ph = 0.05 + r() * 1.15; stars.push(4800 * Math.sin(ph) * Math.cos(th), 4800 * Math.cos(ph), 4800 * Math.sin(ph) * Math.sin(th)); }
  const sg = new THREE.BufferGeometry(); sg.setAttribute("position", new THREE.Float32BufferAttribute(stars, 3));
  dome.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xcfd8ff, size: 1.5, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.5 })));
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
  band.position.y = 100; dome.add(band);
  return dome;
}
function surroundings() {
  // what the paintwork reflects: a dark sky with two rows of floodlights, and the lit ground below
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x030408);
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
  mclaren: { colours: { main: "#ff8000", second: CARBON, flap: "#ff8000", plate: CARBON, rear: CARBON, rflap: "#ff8000", trim: "#ffd21f" },      // papaya, with a black stripe down the middle
    body(p) { p.all("#ff8000"); p.top("tub", 0.08, 0.62, 0.065, CARBON); p.top("cover", 0, 1, 0.11, CARBON);
      p.flank((tub, cover, pod) => { cover.shape([[0.45, 0.17], [1, 0.17], [1, 0.39]], CARBON); pod.shape([[0.55, 0.17], [1, 0.17], [1, 0.5], [0.8, 0.5]], CARBON); }); } },
  ferrari: { colours: { main: "#e00620", second: WHITE, flap: "#e00620", plate: CARBON, rear: CARBON, rflap: CARBON, trim: "#ffec40" },           // red, white round the cockpit and airbox, a black rear wing
    body(p) { p.all("#e00620"); p.top("tub", 0.6, 1, 0.16, WHITE); p.top("cover", 0, 0.5, 0.19, WHITE);
      p.flank((tub, cover) => { cover.shape([[0.5, 0.31], [0.74, 0.5], [0.5, 0.5]], WHITE); tub.band(0.1, 0.6, 0.3, 0.307, WHITE); }); } },
  redbull: { colours: { main: "#12235f", second: "#e0101f", flap: "#12235f", plate: "#e0101f", rear: "#12235f", rflap: "#e0101f", trim: "#ffc906" },   // deep blue, red down the flanks, yellow nose and airbox
    body(p) { p.all("#12235f"); p.top("tub", 0, 0.05, 0.5, "#ffc906"); p.top("cover", 0, 0.28, 0.09, "#ffc906");
      p.flank((tub, cover, pod) => { tub.shape([[0.05, 0.21], [0.05, 0.27], [1, 0.36], [1, 0.31]], "#e0101f"); cover.shape([[0, 0.31], [0, 0.36], [0.9, 0.2], [0.7, 0.2]], "#e0101f");
        pod.shape([[0, 0.22], [0, 0.3], [1, 0.24], [1, 0.2]], "#e0101f"); tub.band(0.05, 1, 0.197, 0.204, WHITE); pod.band(0, 1, 0.188, 0.195, WHITE); }); } },
  mercedes: { colours: { main: "#c9cdd0", second: "#00d2be", flap: CARBON, plate: "#00d2be", rear: CARBON, rflap: "#00d2be", trim: WHITE },        // silver at the nose going to black at the tail, a teal line
    body(p) { p.all([[2.8, "#c9cdd0"], [1.0, "#c9cdd0"], [-0.3, "#3a3d41"], [-1.1, CARBON], [-2.5, CARBON]]);
      p.flank((tub, cover, pod) => { tub.band(0.08, 1, 0.2, 0.212, "#00d2be"); cover.band(0, 1, 0.2, 0.212, "#00d2be"); pod.band(0, 1, 0.3, 0.312, "#00d2be");
        pod.shape([[0.05, 0.17], [0.16, 0.17], [0.36, 0.5], [0.25, 0.5]], "rgba(201,205,208,0.5)"); pod.shape([[0.3, 0.17], [0.36, 0.17], [0.56, 0.5], [0.5, 0.5]], "rgba(201,205,208,0.3)");
        cover.shape([[0.05, 0.17], [0.14, 0.17], [0.3, 0.42], [0.21, 0.42]], "rgba(201,205,208,0.35)"); }); } },
  williams: { colours: { main: "#1b3fd2", second: WHITE, flap: WHITE, plate: "#1b3fd2", rear: WHITE, rflap: "#1b3fd2", trim: WHITE },             // cobalt blue, a white engine cover, lighter blue sidepods
    body(p) { p.all("#1b3fd2"); p.top("cover", 0, 0.8, 0.17, WHITE);
      p.flank((tub, cover, pod) => { pod.band(0, 1, 0.17, 0.5, "#00a7e6"); pod.shape([[0.6, 0.17], [1, 0.17], [1, 0.5], [0.85, 0.5]], "#061a4d");
        tub.shape([[0.55, 0.11], [1, 0.11], [1, 0.3], [0.8, 0.22]], "#061a4d"); cover.band(0, 0.8, 0.322, 0.334, CARBON); }); } },
  aston: { colours: { main: "#00594f", second: "#cedc00", flap: "#00594f", plate: "#cedc00", rear: "#00594f", rflap: "#00594f", trim: "#cedc00" },    // racing green, darker to the tail, lime lines
    body(p) { p.all([[2.8, "#0f7a66"], [0.5, "#00594f"], [-2.5, "#00382f"]]);
      p.flank((tub, cover, pod) => { pod.band(0.04, 1, 0.3, 0.312, "#cedc00"); pod.band(0.12, 1, 0.262, 0.269, "#cedc00"); tub.band(0.3, 1, 0.2, 0.207, "#cedc00"); cover.band(0, 0.9, 0.2, 0.207, "#cedc00"); }); } },
  alpine: { colours: { main: "#1166d6", second: "#ff7fc1", flap: "#1166d6", plate: "#ff7fc1", rear: "#ff7fc1", rflap: "#1166d6", trim: WHITE },    // blue at the front, pink behind
    body(p) { p.all([[2.8, "#1166d6"], [0.9, "#1166d6"], [0.1, "#ff7fc1"], [-2.5, "#ff7fc1"]]);
      p.flank((tub, cover, pod) => { cover.shape([[0.62, 0.17], [1, 0.17], [1, 0.5], [0.86, 0.5]], "#1166d6"); pod.shape([[0, 0.17], [0.3, 0.17], [0.08, 0.5], [0, 0.5]], "#1166d6"); }); } },
  haas: { colours: { main: WHITE, second: "#e2001a", flap: CARBON, plate: "#e2001a", rear: CARBON, rflap: WHITE, trim: "#e2001a" },               // white over black, a red sweep between them
    body(p) { p.all(WHITE);
      p.flank((tub, cover, pod) => { tub.shape([[0.35, 0.11], [1, 0.11], [1, 0.25], [0.6, 0.2]], CARBON); cover.band(0, 1, 0.17, 0.27, CARBON);
        cover.shape([[0.55, 0.27], [1, 0.27], [1, 0.5], [0.82, 0.5]], CARBON); pod.band(0, 1, 0.17, 0.27, CARBON);
        tub.shape([[0.3, 0.2], [1, 0.25], [1, 0.285], [0.3, 0.215]], "#e2001a"); cover.shape([[0, 0.27], [0.55, 0.27], [0.82, 0.5], [0.76, 0.5], [0.5, 0.3], [0, 0.3]], "#e2001a"); pod.band(0, 1, 0.27, 0.295, "#e2001a"); }); } },
  rb: { colours: { main: WHITE, second: "#1b33c9", flap: "#1b33c9", plate: WHITE, rear: WHITE, rflap: "#1b33c9", trim: "#e8242c" }, numInk: "#e8242c",   // white, blue low on the flanks, red numbers
    body(p) { p.all(WHITE); p.top("tub", 0.04, 0.35, 0.028, "#1b33c9");
      p.flank((tub, cover, pod) => { pod.shape([[0, 0.17], [1, 0.17], [1, 0.3], [0, 0.44]], "#1b33c9"); cover.shape([[0.25, 0.17], [1, 0.17], [1, 0.4]], "#1b33c9");
        tub.shape([[0.55, 0.11], [1, 0.11], [1, 0.24]], "#1b33c9"); cover.band(0, 0.25, 0.17, 0.182, "#e8242c"); }); } },
  audi: { colours: { main: "#c3c7cb", second: "#ff2d00", flap: CARBON, plate: "#ff2d00", rear: "#ff2d00", rflap: CARBON, trim: WHITE },            // titanium going to black, blocks of red
    body(p) { p.all([[2.8, "#c6cacd"], [1.0, "#b0b5ba"], [0.0, "#868d94"], [-0.7, CARBON], [-2.5, CARBON]]); p.top("cover", 0, 0.3, 0.1, "#ff2d00");
      p.flank((tub, cover, pod) => { cover.shape([[0.5, 0.17], [1, 0.17], [1, 0.5], [0.78, 0.5]], "#ff2d00"); pod.shape([[0.62, 0.17], [1, 0.17], [1, 0.5], [0.86, 0.5]], "#ff2d00"); }); } },
  cadillac: { colours: { main: "#0a0c10", second: WHITE, flap: "#d7d9dc", plate: "#0a0c10", rear: "#0a0c10", rflap: WHITE, trim: WHITE }, outlined: true,     // one side black, the other white, chevrons down the seam
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
    flank((tub, cover, pod) => { tub.band(0, 1, 0, 0.11, CARBON); cover.band(0, 1, 0, 0.17, CARBON); pod.band(0, 1, 0, 0.17, CARBON); pod.band(0, 1, 0.56, 1, CARBON); });    // carbon below, and on the side of the pod nobody sees
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
  }, { repeat: false }), depthTest: false, transparent: true }));
  tag.position.set(0, 1.75, 0); tag.renderOrder = 6; car.add(tag);
  car.userData = { i: c.i, body, wheels, light, tag, front, rear, shards: wear.shards, hurt: undefined, spin: 0, tyre: undefined, hint: null, t: null, scrape: 0, sus: { y: null, v: 0, ground: 0 } };
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
//   TV pod     on top of the airbox, set a little to one side, fixed to the car: the world tilts and shakes as it does
//   Chase      behind and above, swinging round after the car a moment late
//   Orbit      anywhere on the half sphere over the car; drag to move, wheel or pinch to zoom
//   Trackside  television cameras on the walls round the lap, each panning and zooming with the car as it comes by
//   Director   cuts between them all, as a broadcast does
//   Cockpit    onboard, just over the driver's helmet, fixed to the body like the pod (key 6)
//   Overhead   the heli shot: a slow circle 62 m over the car (key 7)
const POD = { at: new THREE.Vector3(0.16, 1.11, -0.22), look: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.06, Math.PI, 0, "YXZ")) };
// The onboard camera, just over the driver's helmet, fixed to the body like the pod.
const COCKPIT = { at: new THREE.Vector3(0, 0.95, 0.10), look: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.09, Math.PI, 0, "YXZ")) };
const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), q1 = new THREE.Quaternion();
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
// The director: a new shot every nine seconds, counted from the start of the highlight being shown so each one
// opens on a trackside camera. While the hosts talk over a held picture, a slow circle overhead.
const SHOTS = ["tv", "chase", "tv", "pod", "tv", "heli", "tv", "cockpit", "chase"];
function directed(t) {
  const seg = S.seg;
  if (seg && seg.hold) return "heli";
  return SHOTS[((Math.floor((t - (seg ? seg.from : 0)) / 9) % SHOTS.length) + SHOTS.length) % SHOTS.length];
}
function aim(car, p, dt, t) {
  const shot = mode === "auto" ? directed(t) : mode, py = car.position.y;
  follow.clock = (follow.clock || 0) + dt;
  if (shot !== follow.shot) { follow.shot = shot; follow.cut = follow.fresh = true; }
  let fov = 55;
  if (follow.yaw === null || follow.cut) follow.yaw = p.yaw;
  follow.yaw = lerpAngle(follow.yaw, p.yaw, 1 - Math.exp(-dt / (shot === "orbit" ? 0.45 : 0.16)));
  if (shot === "pod" || shot === "cockpit") {
    const body = car.userData.body, rig = shot === "pod" ? POD : COCKPIT;
    car.updateMatrixWorld(true);
    camera.position.copy(rig.at).applyMatrix4(body.matrixWorld);
    camera.quaternion.copy(body.getWorldQuaternion(q1)).multiply(rig.look);
    fov = shot === "pod" ? 70 : 78;
  } else if (shot === "tv") {
    follow.k = sectionOf(p.x, p.z, follow.cut ? null : follow.k);
    const i = stationFor(follow.k), st = STATIONS[i], cut = follow.cut || follow.station !== i || !follow.look;
    follow.station = i;
    v1.set(p.x, py + 0.55, p.z);
    const want = clamp(2 * Math.atan(12 / st.pos.distanceTo(v1)) * 180 / Math.PI, 4.5, 46);
    if (cut) { follow.look = (follow.look || new THREE.Vector3()).copy(v1); follow.zoom = want; follow.fresh = true; }
    else { follow.look.lerp(v1, 1 - Math.exp(-dt / 0.06)); follow.zoom = lerp(follow.zoom, want, 1 - Math.exp(-dt / 0.35)); }   // an operator, a touch behind the car
    camera.position.copy(st.pos); camera.up.set(0, 1, 0); camera.lookAt(follow.look);
    fov = follow.zoom;
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
      fov = 46;
    }
    camera.up.set(0, 1, 0); camera.lookAt(v1);
  }
  const near = shot === "pod" ? 0.08 : shot === "cockpit" ? 0.05 : 0.4;
  if (Math.abs(camera.fov - fov) > 0.01 || camera.near !== near) {
    camera.fov = follow.fresh || shot === "tv" ? fov : lerp(camera.fov, fov, 0.15); camera.near = near; camera.updateProjectionMatrix();
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
    if (moved > 6 && mode !== "orbit") api.setCamera("orbit");
    if (down.size === 2) {              // two fingers: pinch to zoom
      const [a, b] = [...down.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) orbit.r = clamp(orbit.r * pinch / d, 3.2, 160);
      pinch = d;
    } else if (mode === "orbit") {
      orbit.az -= dx * 0.006;
      orbit.pol = clamp(orbit.pol - dy * 0.005, 0.1, Math.PI / 2 - 0.02);       // never under the road
    }
  });
  const up = e => { if (down.has(e.pointerId) && down.size === 1 && moved < 6) pick(e); down.delete(e.pointerId); pinch = 0; };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", e => { down.delete(e.pointerId); pinch = 0; });
  canvas.addEventListener("wheel", e => { e.preventDefault(); if (mode !== "orbit") api.setCamera("orbit"); orbit.r = clamp(orbit.r * (e.deltaY > 0 ? 1.12 : 0.89), 3.2, 160); }, { passive: false });
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
  if (best && best.i !== S.focus) { S.setFocus(best.i); follow.cut = true; }
}

// ------------------------------------------------------------------ the frame
const Finish = {        // what a camera adds: a darker edge to the picture, and a little grain (which also hides banding in the night sky)
  uniforms: { tDiffuse: { value: null }, amount: { value: 0.3 }, grain: { value: 0.022 }, time: { value: 0 } },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: "uniform sampler2D tDiffuse; uniform float amount; uniform float grain; uniform float time; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); float d = length(vUv - 0.5); float n = fract(sin(dot(gl_FragCoord.xy + time * 61.7, vec2(12.9898, 78.233))) * 43758.5453); gl_FragColor = vec4(c.rgb * (1.0 - amount * smoothstep(0.3, 0.8, d)) + (n - 0.5) * grain, c.a); }",
};
const LAMPS = 6, LAMP = 2400;         // how many masts shine at once, and how brightly (candela)
let lamps = [], order = null, reach = null, finish = null;
function relight(x, z) {
  for (let i = 0; i < MASTS.length; i++) { order[i] = i; reach[i] = Math.hypot(MASTS[i].x - x, MASTS[i].z - z); }
  order.sort((a, b) => reach[a] - reach[b]);
  lamps.forEach((lamp, i) => {
    const m = MASTS[order[i]], d = i < MASTS.length ? reach[order[i]] : 1e9;
    if (!m || d > 175) { lamp.intensity = 0; return; }
    lamp.position.set(m.x, m.y, m.z); lamp.target.position.set(m.tx, m.ty, m.tz);
    lamp.intensity = LAMP * (1 - clamp((d - 115) / 60, 0, 1) ** 2);          // fading out with distance, so none switches on or off in view
  });
}
function init() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05060a, 0.00042);
  scene.environment = surroundings(); scene.environmentIntensity = 0.9;
  camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.08, 9000);
  scene.add(sky());
  scene.add(new THREE.HemisphereLight(0x9fb0d0, 0x3a332a, 0.55));
  sun = new THREE.DirectionalLight(0xfff2dd, 2.2);        // the floodlights down one side, taken together
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.04;
  Object.assign(sun.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55, near: 10, far: 420 });
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.95); // and those down the other
  fill.position.set(-70, 110, -50); scene.add(fill);
  scene.add(buildCircuit());
  // The masts nearest the car being followed shine for real, so the road brightens under each one and the
  // highlights slide over the paint as a car goes by. The rest are only bright to look at.
  for (let i = 0; i < LAMPS; i++) { const lamp = new THREE.SpotLight(0xfff0d6, 0, 0, 1.08, 0.8, 2); scene.add(lamp, lamp.target); lamps.push(lamp); }
  order = new Uint16Array(MASTS.length); reach = new Float32Array(MASTS.length);
  for (const c of S.CARS) { const car = makeCar(c); scene.add(car); cars.push(car); }
  calibrate();
  effects();
  const target = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4 });
  composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.42, 0.55, 1.5);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  finish = new ShaderPass(Finish);
  composer.addPass(finish);
  controls();
  ready = true;
}
function resize() {                   // the size of its place on the page, or the size it has been told to film at
  const set = api.fixed, r = canvas.getBoundingClientRect();
  const w = set ? set[0] : Math.max(2, Math.floor(r.width)), h = set ? set[1] : Math.max(2, Math.floor(r.height));
  const pr = set ? 1 : quality > 1 ? Math.min(window.devicePixelRatio || 1, 2) : 1;
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
    relight(focusPose.x, focusPose.z);
    sun.target.position.copy(focusCar.position);
    sun.position.set(focusPose.x + 75, focusCar.position.y + 150, focusPose.z + 55);
  }
  stepEffects(t);
  const lens = Math.tan(camera.fov * Math.PI / 360);
  for (const car of cars) {             // name tags: readable from far off, small up close, gone from the car you sit on
    if (!car.visible) continue;
    const tag = car.userData.tag, d = camera.position.distanceTo(car.position);
    tag.visible = api.labels && !((follow.shot === "pod" || follow.shot === "cockpit" || follow.shot === "chase") && car === focusCar) && d * lens < 235;
    const s = Math.max(0.42, Math.min(d * lens, 75) * 0.056); tag.scale.set(2.86 * s, s, 1); tag.position.y = 1.35 + s * 0.75;
  }
  const on = lightsShowing(t);
  startLights.forEach((m, i) => m.color.setRGB(i < on ? 9 : 0.1, i < on ? 0.25 : 0.02, i < on ? 0.15 : 0.02));
  finish.uniforms.time.value = (performance.now() / 1000) % 97;
  if (quality > 0) composer.render(); else renderer.render(scene, camera);
}
const api = window.Stage3D = {
  labels: true,
  fixed: null,                        // [width, height] to draw at exactly that size (the video export), null to fit the page
  render,
  setCamera(m) { mode = m; follow.cut = follow.fresh = true; document.dispatchEvent(new CustomEvent("stage3d-camera", { detail: m })); },
  get camera() { return mode; },
  get shot() { return follow.shot; },
  get orbit() { return orbit; },
  suspension: SPRING,
  effects: FX,
  get quality() { return quality; },
  set quality(q) {
    quality = clamp(q | 0, 0, 2);
    if (ready) { bloom.enabled = quality > 1; renderer.shadowMap.enabled = quality > 0; sun.castShadow = quality > 0; renderer.setPixelRatio(quality > 1 ? Math.min(window.devicePixelRatio || 1, 2) : 1); }
  },
  debug: { K, WALL, bend, lane, STATIONS, groundAt, ground, verge, stand, pose, damageAt, wreck, LOOKS, TEAM_OF, get scene() { return scene; }, get renderer() { return renderer; }, get cars() { return cars; }, get view() { return camera; } },
};
document.dispatchEvent(new CustomEvent("stage3d-ready"));
