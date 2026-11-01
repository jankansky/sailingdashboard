// 3D view of the West Wight Potter 19. Loaded on demand by app.js.
//
// World axes: +X east, +Y up, -Z north; 1 unit = 1 metre; waterline at y = 0.
// Boat axes:  +X starboard, +Y up, -Z toward the bow.

import * as THREE from './vendor/three.module.min.js';
import { AisLayer } from './ais3d.js';
import { MapTiles, loadTileIndex } from './maptiles.js';
import { HAZE_DENSITY, SKY_EXPOSURE, SkyDome, smooth } from './sky.js';

const DEG = Math.PI / 180;

// Hard-chine hull stations from stem to transom (approximate Potter 19 lines:
// LOA 5.72 m, beam 2.29 m). Each row: z, sheer half-breadth, sheer height,
// chine half-breadth, chine height, keel height.
const STATIONS = [
  [-2.86, 0.00, 0.86, 0.00, 0.50, 0.42],
  [-2.40, 0.48, 0.80, 0.30, 0.22, 0.02],
  [-1.70, 0.86, 0.73, 0.68, 0.06, -0.14],
  [-0.80, 1.08, 0.67, 0.92, 0.00, -0.21],
  [0.20, 1.14, 0.62, 1.00, -0.01, -0.22],
  [1.30, 1.10, 0.59, 0.99, 0.00, -0.17],
  [2.86, 0.98, 0.57, 0.90, 0.06, -0.02],
];

const MAST_Z = -0.86;
const CABIN_TOP = 0.98;
const GOOSENECK = 1.40;
const MAST_TOP = 6.60;
const HOUNDS = 5.85;  // fractional rig: forestay and shrouds meet the mast here
const TACK = new THREE.Vector3(0, 0.88, -2.80);

function deckY(z) {
  for (let i = 0; i < STATIONS.length - 1; i++) {
    const [z0, , y0] = STATIONS[i];
    const [z1, , y1] = STATIONS[i + 1];
    if (z >= z0 && z <= z1) return y0 + (y1 - y0) * (z - z0) / (z1 - z0);
  }
  return STATIONS.at(-1)[2];
}

function geometry(positions) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  return g;
}

function quad(out, a, b, c, d) {
  out.push(...a, ...b, ...c, ...a, ...c, ...d);
}

// Paint scheme: blue topsides with a white pinstripe below the sheer, black
// bottom paint up to just above the waterline.
const PINSTRIPE = [0.15, 0.20];  // fraction of the way from sheer down to chine
const BOOT_TOP = 0.06;  // bottom paint reaches this height (m above the waterline)

// Stations interpolated in between, so the paint lines follow the hull smoothly.
function fineStations(steps = 8) {
  const out = [];
  for (let i = 0; i < STATIONS.length - 1; i++) {
    for (let k = 0; k < steps; k++) {
      out.push(STATIONS[i].map((v, c) => v + (STATIONS[i + 1][c] - v) * k / steps));
    }
  }
  out.push(STATIONS.at(-1));
  return out;
}

// Fraction along a panel edge (top height -> bottom height) where it crosses `y`.
function crossing(yTop, yBot, y, lo) {
  return Math.min(1, Math.max(lo, (yTop - y) / (yTop - yBot)));
}

const lerp3 = (a, b, f) => a.map((v, i) => v + (b[i] - v) * f);

// Adds a panel between two edges, split into colour bands. levels(st) gives
// the band boundaries (0 = top edge, 1 = bottom edge) at a station.
function bandedPanel(bins, stations, top, bottom, levels, colors) {
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i], b = stations[i + 1];
    const la = levels(a), lb = levels(b);
    colors.forEach((color, k) => {
      quad(bins[color],
        lerp3(top(a), bottom(a), la[k]), lerp3(top(a), bottom(a), la[k + 1]),
        lerp3(top(b), bottom(b), lb[k + 1]), lerp3(top(b), bottom(b), lb[k]));
    });
  }
}

function buildHull(mats) {
  const bins = { blue: [], white: [], black: [] };
  const deck = [];
  const st = fineStations();
  const topsideLevels = s => {
    const boot = Math.max(PINSTRIPE[1], crossing(s[2], s[4], BOOT_TOP, PINSTRIPE[1]));
    return [0, PINSTRIPE[0], PINSTRIPE[1], boot, 1];
  };
  const topsideColors = ['blue', 'white', 'blue', 'black'];
  for (const side of [1, -1]) {
    const sheer = s => [side * s[1], s[2], s[0]];
    const chine = s => [side * s[3], s[4], s[0]];
    const keel = s => [0, s[5], s[0]];
    bandedPanel(bins, st, sheer, chine, topsideLevels, topsideColors);
    bandedPanel(bins, st, chine, keel, s => [0, crossing(s[4], s[5], BOOT_TOP, 0), 1], ['blue', 'black']);
  }
  for (let i = 0; i < STATIONS.length - 1; i++) {
    const s = STATIONS[i], t = STATIONS[i + 1];
    quad(deck, [-s[1], s[2], s[0]], [s[1], s[2], s[0]], [t[1], t[2], t[0]], [-t[1], t[2], t[0]]);
  }

  // Transom: the same bands across, then the bottom-painted vee below the chines.
  const tr = STATIONS.at(-1);
  const [z, sb, sy, cb, cy, ky] = tr;
  const lv = topsideLevels(tr);
  topsideColors.forEach((color, k) => {
    const at = (x, f) => lerp3([x * sb, sy, z], [x * cb, cy, z], f);
    quad(bins[color], at(-1, lv[k]), at(1, lv[k]), at(1, lv[k + 1]), at(-1, lv[k + 1]));
  });
  bins.black.push(-cb, cy, z, cb, cy, z, 0, ky, z);

  const g = new THREE.Group();
  g.add(new THREE.Mesh(geometry(bins.blue), mats.hullBlue));
  g.add(new THREE.Mesh(geometry(bins.white), mats.pinstripe));
  g.add(new THREE.Mesh(geometry(bins.black), mats.bottom));
  g.add(new THREE.Mesh(geometry(deck), mats.deck));
  return g;
}

function buildCabin(mats) {
  // Trunk cabin with a pop-top, narrower at the front.
  const fz = -1.75, rz = 0.35;
  const fb = [0.55, deckY(fz) - 0.02, fz], rb = [0.72, deckY(rz) - 0.02, rz];
  const ft = [0.46, CABIN_TOP, fz + 0.18], rt = [0.62, CABIN_TOP, rz];
  const p = (v, side) => [side * v[0], v[1], v[2]];
  const out = [];
  quad(out, p(ft, -1), p(ft, 1), p(rt, 1), p(rt, -1));  // roof
  quad(out, p(fb, -1), p(fb, 1), p(ft, 1), p(ft, -1));  // front
  quad(out, p(rb, -1), p(rb, 1), p(rt, 1), p(rt, -1));  // back
  for (const s of [1, -1]) quad(out, p(fb, s), p(rb, s), p(rt, s), p(ft, s));  // sides
  const g = new THREE.Group();
  g.add(new THREE.Mesh(geometry(out), mats.cabin));

  const popTop = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 0.95), mats.deck);
  popTop.position.set(0, CABIN_TOP + 0.03, -0.15);
  g.add(popTop);

  // Cockpit well, just above the deck surface.
  const cz0 = 0.45, cz1 = 2.70, cw = 0.78;
  const well = [];
  quad(well, [-cw, deckY(cz0) + 0.01, cz0], [cw, deckY(cz0) + 0.01, cz0],
    [cw, deckY(cz1) + 0.01, cz1], [-cw, deckY(cz1) + 0.01, cz1]);
  g.add(new THREE.Mesh(geometry(well), mats.cockpit));
  return g;
}

function box(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

function cylinder(r0, r1, len, mat) {
  return new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, len, 12), mat);
}

function line(points, mat) {
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), mat);
}

// Sail surface between luff (tack -> head) and foot (tack -> clew). Camber is
// applied with setCamber() (+1 bulges toward +X, -1 toward -X), so the sail can
// change tack without being mirrored, which would print its number backwards.
// UVs map the sail's plane: u = z / zSpan, v = y / ySpan.
function sailGeometry(tack, head, clew, depth, zSpan, ySpan) {
  const U = 8, V = 10;
  const pos = [], uv = [], camber = [], idx = [];
  const footLen = clew.clone().sub(tack).length();
  for (let j = 0; j <= V; j++) {
    const v = j / V;
    for (let i = 0; i <= U; i++) {
      const u = i / U;
      const p = tack.clone()
        .addScaledVector(head.clone().sub(tack), v)
        .addScaledVector(clew.clone().sub(tack), u * (1 - v));
      pos.push(p.x, p.y, p.z);
      uv.push(p.z / zSpan, p.y / ySpan);
      camber.push(depth * footLen * (1 - v) * Math.sin(Math.PI * u));
    }
  }
  for (let j = 0; j < V; j++) {
    for (let i = 0; i < U; i++) {
      const a = j * (U + 1) + i, b = a + 1, c = a + U + 1, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.userData = { flatX: pos.filter((_, i) => i % 3 === 0), camber };
  setCamber(g, 1);
  return g;
}

function setCamber(g, amount) {
  const x = g.attributes.position.array;
  const { flatX, camber } = g.userData;
  for (let i = 0; i < camber.length; i++) x[i * 3] = flatX[i] + camber[i] * amount;
  g.attributes.position.needsUpdate = true;
  g.computeVertexNormals();
}

function canvasTexture(width, height, draw) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  draw(c.getContext('2d'));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const SAIL_WHITE = '#fbfbf8';
const SAIL_NUMBER = '974';
const SAIL_NUMBER_GREEN = '#178a3c';
const JIB_BLUE = '#1f5fbf';

// Mainsail texture for one side. Numbers sit near the top of the leech,
// starboard slightly higher than port as on real sails. `mirrored` draws the
// glyphs reversed for the side seen through the back of the texture.
function mainTexture(zSpan, ySpan, clewZ, tackY, headY, centreY, mirrored) {
  const W = 512, H = 1024, sx = W / zSpan, sy = H / ySpan;
  return canvasTexture(W, H, ctx => {
    ctx.fillStyle = SAIL_WHITE;
    ctx.fillRect(0, 0, W, H);
    const h = 0.30;  // number height, metres
    const top = centreY + h / 2;
    const leechZ = clewZ * (1 - (top - tackY) / (headY - tackY));  // leech at the number's top
    ctx.save();
    ctx.translate((leechZ - 0.07) * sx, H - centreY * sy);
    ctx.scale((mirrored ? -1 : 1) * sx / sy, 1);  // undo the canvas's non-square metres
    ctx.font = `bold ${Math.round(h * sy)}px Helvetica, Arial, sans-serif`;
    ctx.textAlign = mirrored ? 'left' : 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = SAIL_NUMBER_GREEN;
    ctx.fillText(SAIL_NUMBER, 0, 0);
    ctx.restore();
  });
}

// Jib: three blue and two white bands, rising aft at 20 degrees to the hull.
function jibTexture(zSpan, ySpan, corners) {
  const W = 512, H = 1024, sx = W / zSpan, sy = H / ySpan;
  const a = 20 * DEG;
  const across = (z, y) => y * Math.cos(a) - z * Math.sin(a);  // distance across the stripes
  const values = corners.map(([z, y]) => across(z, y));
  const lo = Math.min(...values), hi = Math.max(...values);
  return canvasTexture(W, H, ctx => {
    ['blue', 'white', 'blue', 'white', 'blue'].forEach((band, i) => {
      const s0 = lo + (hi - lo) * i / 5 - (i === 0 ? 1 : 0);
      const s1 = lo + (hi - lo) * (i + 1) / 5 + (i === 4 ? 1 : 0);
      const pt = (z, s) => [z * sx, H - ((s + z * Math.sin(a)) / Math.cos(a)) * sy];
      ctx.fillStyle = band === 'blue' ? JIB_BLUE : SAIL_WHITE;
      ctx.beginPath();
      [pt(-1, s0), pt(zSpan + 1, s0), pt(zSpan + 1, s1), pt(-1, s1)]
        .forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.fill();
    });
  });
}

function buildRig(mats) {
  const rig = new THREE.Group();

  const mast = cylinder(0.045, 0.06, MAST_TOP - CABIN_TOP, mats.spar);
  mast.position.set(0, (MAST_TOP + CABIN_TOP) / 2, MAST_Z);
  rig.add(mast);

  const hounds = new THREE.Vector3(0, HOUNDS, MAST_Z);
  rig.add(line([TACK, hounds], mats.wire));
  rig.add(line([new THREE.Vector3(1.05, deckY(MAST_Z), MAST_Z), hounds], mats.wire));
  rig.add(line([new THREE.Vector3(-1.05, deckY(MAST_Z), MAST_Z), hounds], mats.wire));
  rig.add(line([new THREE.Vector3(0, MAST_TOP, MAST_Z), new THREE.Vector3(0, deckY(2.8), 2.8)], mats.wire));

  // Main: pivots about the mast.
  const main = new THREE.Group();
  main.position.set(0, GOOSENECK, MAST_Z);
  const boom = cylinder(0.04, 0.04, 2.25, mats.spar);
  boom.rotation.x = Math.PI / 2;
  boom.position.z = 1.125;
  main.add(boom);
  const mTack = new THREE.Vector3(0, 0.05, 0.03), mClew = new THREE.Vector3(0, 0.05, 2.2);
  const mHead = new THREE.Vector3(0, MAST_TOP - GOOSENECK - 0.1, 0.03);
  const mainGeo = sailGeometry(mTack, mHead, mClew, 0.10, 2.2, mHead.y);
  // Two layers sharing the shape: the front faces show the port side, the back
  // faces the starboard side, each with its own correctly-reading number.
  const sailMat = (map, side) => new THREE.MeshStandardMaterial({ map, side, roughness: 0.8 });
  const portNumberY = mHead.y * 0.55, stbdNumberY = mHead.y * 0.63;
  main.add(new THREE.Mesh(mainGeo,
    sailMat(mainTexture(2.2, mHead.y, mClew.z, mTack.y, mHead.y, portNumberY, false), THREE.FrontSide)));
  main.add(new THREE.Mesh(mainGeo,
    sailMat(mainTexture(2.2, mHead.y, mClew.z, mTack.y, mHead.y, stbdNumberY, true), THREE.BackSide)));
  rig.add(main);

  // Jib: pivots about the forestay.
  const jib = new THREE.Group();
  jib.position.copy(TACK);
  const head = hounds.clone().sub(TACK).multiplyScalar(0.97);
  const jTack = new THREE.Vector3(0, 0.05, 0.02), jClew = new THREE.Vector3(0, 0.35, 1.95);
  const jibGeo = sailGeometry(jTack, head, jClew, 0.11, jClew.z, head.y);
  const stripes = jibTexture(jClew.z, head.y, [[jTack.z, jTack.y], [head.z, head.y], [jClew.z, jClew.y]]);
  jib.add(new THREE.Mesh(jibGeo, sailMat(stripes, THREE.DoubleSide)));
  rig.add(jib);

  return { rig, main, mainGeo, jib, jibGeo, forestay: head.clone().normalize() };
}

function buildAppendages(mats) {
  const g = new THREE.Group();
  g.add(box(0.03, 0.95, 0.42, mats.foil, 0, -0.68, -0.50));  // centerboard, down
  g.add(box(0.03, 1.00, 0.34, mats.foil, 0, 0.07, 3.02));  // kick-up rudder
  g.add(box(0.05, 0.05, 1.30, mats.foil, 0, 0.72, 2.30));  // tiller
  // Outboard on a port-side transom bracket
  g.add(box(0.30, 0.42, 0.40, mats.outboard, -0.55, 0.62, 3.10));
  g.add(box(0.08, 0.85, 0.12, mats.outboard, -0.55, 0.0, 3.12));
  return g;
}

// Navigation lights for a sailboat under 12 m (COLREGS rule 25, plus a masthead
// steaming light): each is visible only within its arc, measured from dead ahead.
const NAV_LIGHTS = [
  { name: 'masthead', color: 0xfff4dc, pos: [0, MAST_TOP + 0.04, MAST_Z - 0.07], from: -112.5, to: 112.5 },
  { name: 'port', color: 0xff2a1a, pos: [-0.05, 0.96, -2.74], from: -112.5, to: 0 },
  { name: 'starboard', color: 0x14ff5a, pos: [0.05, 0.96, -2.74], from: 0, to: 112.5 },
  { name: 'stern', color: 0xfff4dc, pos: [0, 0.74, 2.88], from: 112.5, to: 247.5 },
];

function glowTexture() {
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.15, 'rgba(255,255,255,0.8)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// How much of a light is seen from `bearing` (degrees from the bow, + = starboard),
// with a 2-degree soft edge at each limit of its arc.
function arcWeight(bearing, from, to) {
  const span = to - from;
  let rel = ((bearing - from) % 360 + 360) % 360;  // degrees past the arc's start
  if (rel > 180 + span / 2) rel -= 360;  // just before the start counts as negative
  return smooth(-2, 2, rel) * (1 - smooth(span - 2, span + 2, rel));
}

function buildNavLights() {
  const group = new THREE.Group();
  const glow = glowTexture();
  const lights = NAV_LIGHTS.map(def => {
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x555555 }));
    bulb.position.set(...def.pos);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glow, color: def.color, blending: THREE.AdditiveBlending, transparent: true,
      depthWrite: false, fog: false,
    }));
    halo.position.copy(bulb.position);
    // Spills a little light onto the deck, sails and transom. Always in the scene
    // (intensity 0 by day) so switching on doesn't recompile every shader.
    const spill = new THREE.PointLight(def.color, 0, 6, 2);
    spill.position.copy(bulb.position);
    group.add(bulb, halo, spill);
    return { def, bulb, halo, spill, on: new THREE.Color(def.color) };
  });
  const camLocal = new THREE.Vector3();
  const off = new THREE.Color(0x555555);
  return {
    group,
    // on: 0..1; boat must have an up-to-date matrixWorld.
    update(on, camera, boat, cameraDistance) {
      camLocal.copy(camera.position);
      boat.worldToLocal(camLocal);
      const size = Math.max(0.5, cameraDistance * 0.018);
      for (const l of lights) {
        const dx = camLocal.x - l.def.pos[0], dz = camLocal.z - l.def.pos[2];
        const bearing = Math.atan2(dx, -dz) / DEG;  // where the camera is, seen from the light
        const seen = on * arcWeight(bearing, l.def.from, l.def.to);
        l.bulb.material.color.copy(off).lerp(l.on, on);
        l.halo.visible = seen > 0.01;
        l.halo.material.opacity = seen;
        l.halo.scale.setScalar(size);
        l.spill.intensity = 1.5 * on * (l.def.name === 'masthead' ? 2 : 1);
      }
    },
  };
}

function arrowMesh(mat) {
  // Points along +Z from the origin.
  const g = new THREE.Group();
  const shaft = cylinder(0.09, 0.09, 2.0, mat);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = 1.0;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.7, 16), mat);
  cone.rotation.x = Math.PI / 2;
  cone.position.z = 2.35;
  g.add(shaft, cone);
  return g;
}

function compassTexture(ink) {
  const S = 1024, c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const R = S / 2, inner = R * (6.6 / 8), band = R - inner;
  // Ticks hang inward from the outer edge; labels sit below the longest ones.
  const tickOuter = R - 4;
  const tickLen = d => band * (d % 30 === 0 ? 0.30 : d % 10 === 0 ? 0.20 : 0.11);
  const labelTop = tickOuter - band * 0.30 - 10;  // gap below the 30-degree ticks
  ctx.translate(R, R);
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.85;
  for (let d = 0; d < 360; d += 5) {
    const a = d * DEG;
    ctx.lineWidth = d % 30 === 0 ? 6 : 3;
    ctx.beginPath();
    ctx.moveTo(Math.sin(a) * tickOuter, -Math.cos(a) * tickOuter);
    ctx.lineTo(Math.sin(a) * (tickOuter - tickLen(d)), -Math.cos(a) * (tickOuter - tickLen(d)));
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let d = 0; d < 360; d += 30) {
    const size = names[d] ? 48 : 32;
    const cap = size * 0.72;  // height of capitals and digits
    const a = d * DEG, r = labelTop - cap / 2;  // label centre, top edge at labelTop
    ctx.save();
    ctx.translate(Math.sin(a) * r, -Math.cos(a) * r);
    ctx.rotate(a);
    ctx.font = `bold ${size}px sans-serif`;
    ctx.fillText(names[d] || String(d), 0, cap / 2);
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createBoatView(container) {
  // Log depth keeps the boat, water and map tiles apart when zoomed out kilometres.
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  // WebGL shader compile errors only reach the console; surface them on the page.
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)]
      .filter(Boolean).join(' ').trim();
    window.dispatchEvent(new CustomEvent('dashboard-error',
      { detail: { where: '3D shader', error: new Error(log.slice(0, 300) || 'compile failed') } }));
  };
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 80000);
  const ambient = new THREE.HemisphereLight(0xffffff, 0x50606f, 1.4);
  const sun = new THREE.DirectionalLight(0xffffff, 2.0);
  const moonLight = new THREE.DirectionalLight(0xb8c8ff, 0);
  scene.add(ambient, sun, moonLight);

  // Sky, sun and moon: drawn first as a background pass (see render below).
  const sky = new SkyDome();
  scene.fog = new THREE.FogExp2(sky.hazeColor, HAZE_DENSITY);  // distant water and land fade into the horizon
  renderer.autoClear = false;
  renderer.toneMappingExposure = SKY_EXPOSURE;
  const lowSun = new THREE.Color(0xffa860), highSun = new THREE.Color(0xffffff);
  let lastFix = { lat: 42.3601, lon: -71.0589 };  // until the GPS has a position

  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({
    color, roughness: 0.7, metalness: 0, flatShading: true, side: THREE.DoubleSide, ...extra,
  });
  const mats = {
    hullBlue: std(0x1d4c97),
    pinstripe: std(0xffffff),
    bottom: std(0x141414),
    deck: std(0xe2dccd),
    cabin: std(0xf7f6f1),
    cockpit: std(0xb3aa98),
    spar: std(0xb8c0c8, { metalness: 0.4, roughness: 0.4 }),
    foil: std(0x2b2b2b),
    outboard: std(0x3a3d42),
    wire: new THREE.LineBasicMaterial({ color: 0x606870 }),
    aw: std(0xff8a1f, { flatShading: false }),
    tw: std(0x2f7cf0, { flatShading: false }),
    cog: new THREE.MeshBasicMaterial({ color: 0x9a5bd6, transparent: true, opacity: 0.8 }),
  };

  // Water and compass ring are fixed to the world (north = -Z).
  const waterMat = new THREE.MeshBasicMaterial({ color: 0x8fb8d8, transparent: true, opacity: 0.78, depthWrite: false });
  const water = new THREE.Mesh(new THREE.CircleGeometry(40000, 96), waterMat);
  water.rotation.x = -Math.PI / 2;
  scene.add(water);
  let ringTex = compassTexture('#10283f');
  const ringMat = new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(6.6, 8, 128), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  scene.add(ring);

  // Course over ground: a stripe on the water.
  const cog = new THREE.Group();
  const cogStripe = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 3.4), mats.cog);
  cogStripe.rotation.x = -Math.PI / 2;
  cogStripe.position.set(0, 0.02, -4.8);
  cog.add(cogStripe);
  scene.add(cog);

  // Boat, rotated by heading, pitch and heel.
  const boat = new THREE.Group();
  boat.rotation.order = 'YXZ';
  boat.add(buildHull(mats), buildCabin(mats), buildAppendages(mats));
  const rig = buildRig(mats);
  boat.add(rig.rig);
  const navLights = buildNavLights();
  const ais = new AisLayer(scene);
  boat.add(navLights.group);
  scene.add(boat);

  // Wind arrows follow the heading but not heel, so they stay readable.
  const windFrame = new THREE.Group();
  const aw = arrowMesh(mats.aw), tw = arrowMesh(mats.tw);
  windFrame.add(aw, tw);
  scene.add(windFrame);

  // When zoomed far out the 6 m boat disappears; show a marker that keeps its size on screen.
  const marker = new THREE.Mesh(
    new THREE.ShapeGeometry(new THREE.Shape([
      new THREE.Vector2(0, 1), new THREE.Vector2(0.55, -0.8), new THREE.Vector2(0, -0.45), new THREE.Vector2(-0.55, -0.8),
    ])),
    new THREE.MeshBasicMaterial({ color: 0xff8a1f, depthWrite: false, side: THREE.DoubleSide }));
  marker.rotation.order = 'YXZ';
  marker.renderOrder = 1;
  scene.add(marker);

  // Offline map tiles, if tools/fetch_tiles.py has been run.
  let map = null;
  let mapLayer = null;
  const mapReady = loadTileIndex().then(index => {
    if (index?.layers) map = new MapTiles(scene, index, renderer.capabilities.getMaxAnisotropy());
    map?.setLayer(mapLayer);
    return index ? Object.keys(index.layers) : [];
  });

  // Close up the arrows float above the deck; zoomed out they shrink relative to
  // the view and settle just above the water around the boat.
  function placeArrow(arrow, angleDeg, liftClose, distance) {
    arrow.visible = Number.isFinite(angleDeg);
    if (!arrow.visible) return;
    const size = Math.max(1, (distance / 16) ** 0.8);
    const settle = Math.min(1, Math.max(0, (distance - 25) / 100));  // 0 close up, 1 from 125 m
    const height = (1 - settle) * liftClose + settle * 0.4 * size;
    const a = angleDeg * DEG;
    const radius = 6.2 * size;
    arrow.scale.setScalar(size);
    arrow.position.set(radius * Math.sin(a), height, -radius * Math.cos(a));
    arrow.rotation.y = -a;  // local +Z points back at the boat
  }

  // Camera: orbit by dragging, zoom by pinching or scrolling.
  const cam = { offset: -35, elevation: 20, distance: 16 };
  const maxDistance = () => (mapLayer ? 6000 : 45);
  const zoomTo = d => { cam.distance = Math.min(maxDistance(), Math.max(7, d)); };
  let follow = true;
  const pointers = new Map();
  let pinchStart = 0, pinchDist = 0;
  const el = renderer.domElement;
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
      pinchDist = cam.distance;
    }
  });
  el.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 1) {
      cam.offset -= (e.clientX - p.x) * 0.35;
      cam.elevation = Math.min(80, Math.max(3, cam.elevation + (e.clientY - p.y) * 0.25));
    }
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 2 && pinchStart > 0) {
      const [a, b] = [...pointers.values()];
      zoomTo(pinchDist * pinchStart / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)));
    }
  });
  const release = e => { pointers.delete(e.pointerId); pinchStart = 0; };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('wheel', e => {
    e.preventDefault();
    zoomTo(cam.distance * (1 + e.deltaY * 0.0015));
  }, { passive: false });
  el.addEventListener('dblclick', () => Object.assign(cam, { offset: -35, elevation: 20, distance: 16 }));

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  const target = new THREE.Vector3(0, 1.6, 0);
  const forestayAxis = rig.forestay;

  return {
    // s: { hdg, awa, twa, cog, heel, pitch, lat, lon, utc, sog, cogTrue, trim: {main, jib, side, luffing}, ais };
    // (cog is smoothed for display; sog and cogTrue are the raw GPS values in m/s and degrees)
    // angles in degrees, utc in ms; ais: where to get targets (see AisLayer.update).
    // Renders before returning, so the canvas can be copied right after.
    update(s) {
      const hdg = Number.isFinite(s.hdg) ? s.hdg : 0;
      boat.rotation.set((s.pitch || 0) * DEG, -hdg * DEG, -(s.heel || 0) * DEG);
      windFrame.rotation.y = -hdg * DEG;
      placeArrow(aw, s.awa, 3.2, cam.distance);
      placeArrow(tw, s.twa, 4.4, cam.distance);
      cog.visible = Number.isFinite(s.cog);
      if (cog.visible) cog.rotation.y = -s.cog * DEG;

      const { main, jib, side, luffing } = s.trim;
      const flap = luffing ? Math.sin(performance.now() / 90) * 0.5 : 1;
      rig.main.rotation.y = -side * main * DEG;
      setCamber(rig.mainGeo, -side * flap);
      rig.jib.quaternion.setFromAxisAngle(forestayAxis, -side * jib * DEG);
      setCamber(rig.jibGeo, -side * flap);

      // Keep the wind arrows, compass ring and marker readable as the camera pulls back.
      const grow = Math.max(1, (cam.distance / 16) ** 0.8);  // same growth as the wind arrows
      ring.scale.setScalar(grow);
      marker.visible = cam.distance > 60;
      marker.scale.setScalar(cam.distance / 22);
      marker.position.set(0, 0.05, 0);
      marker.rotation.set(-Math.PI / 2, -hdg * DEG, 0);

      const bearing = ((follow ? hdg : 0) + 180 + cam.offset) * DEG;
      const ce = Math.cos(cam.elevation * DEG);
      camera.position.set(
        target.x + cam.distance * ce * Math.sin(bearing),
        target.y + cam.distance * Math.sin(cam.elevation * DEG),
        target.z - cam.distance * ce * Math.cos(bearing));
      camera.lookAt(target);
      camera.updateMatrixWorld();
      map?.update(s.lat, s.lon, camera, renderer.domElement.height);
      ais.update({ lat: s.lat, lon: s.lon, sog: s.sog, cog: s.cogTrue }, cam.distance, s.ais);

      // Sun and moon for the GPS time (or this device's clock) at the boat.
      if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) lastFix = { lat: s.lat, lon: s.lon };
      const when = Number.isFinite(s.utc) ? s.utc : Date.now();
      const { sunAltitude, moonAltitude, moonFraction } = sky.update(when, lastFix.lat, lastFix.lon, camera);
      scene.fog.color.copy(sky.hazeColor);
      const daylight = smooth(-4, 8, sunAltitude);
      sun.position.copy(sky.sunDir).multiplyScalar(50);
      sun.intensity = 2.0 * daylight;
      sun.color.copy(lowSun).lerp(highSun, smooth(0, 25, sunAltitude));
      ambient.intensity = 0.35 + 1.05 * smooth(-10, 15, sunAltitude);
      moonLight.position.copy(sky.moonDir).multiplyScalar(50);
      moonLight.intensity = 0.4 * moonFraction * smooth(-2, 10, moonAltitude) * (1 - daylight);
      // Navigation lights: on from sunset to sunrise.
      boat.updateMatrixWorld(true);
      navLights.update(1 - smooth(-1.5, 0, sunAltitude), camera, boat, cam.distance);

      renderer.clear();
      renderer.toneMapping = THREE.ACESFilmicToneMapping;  // the sky model needs it
      renderer.render(sky.scene, camera);
      renderer.toneMapping = THREE.NoToneMapping;  // the boat and map keep their colours
      renderer.clearDepth();
      renderer.render(scene, camera);
    },
    canvas: renderer.domElement,
    setFollow(on) { follow = on; },
    // Resolves to the map layers available offline, e.g. ['imagery', 'chart'].
    mapLayers() { return mapReady; },
    setMapLayer(name) {
      mapLayer = name || null;
      map?.setLayer(mapLayer);
      waterMat.opacity = mapLayer ? 0.22 : 0.78;
      zoomTo(cam.distance);
    },
    setTheme({ background, water: waterColor, ink }) {
      renderer.setClearColor(new THREE.Color(background));
      waterMat.color.set(waterColor);
      ringTex.dispose();
      ringTex = compassTexture(ink);
      ringMat.map = ringTex;
      ringMat.needsUpdate = true;
    },
  };
}
