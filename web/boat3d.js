// 3D view of the boat (see boats.js for the boats). Loaded on demand by app.js.
//
// World axes: +X east, +Y up, -Z north; 1 unit = 1 metre; waterline at y = 0.
// Boat axes:  +X starboard, +Y up, -Z toward the bow.

import * as THREE from './vendor/three.module.min.js';
import { AisLayer } from './ais3d.js';
import { MapTiles, loadTileIndex } from './maptiles.js';
import { HAZE_DENSITY, SKY_EXPOSURE, SkyDome, smooth } from './sky.js';

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function geometry(positions) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  return g;
}

function quad(out, a, b, c, d) {
  out.push(...a, ...b, ...c, ...a, ...c, ...d);
}

const lerp3 = (a, b, f) => a.map((v, i) => v + (b[i] - v) * f);

// Fraction along an edge (top height -> bottom height) where it crosses `y`.
function crossing(yTop, yBot, y) {
  const d = yTop - yBot;
  if (Math.abs(d) < 1e-6) return y >= yTop ? 0 : 1;
  return clamp((yTop - y) / d, 0, 1);
}

// Paint bands down each strip of the hull: topsides, stripe, topsides, bottom paint.
const BANDS = ['hull', 'stripe', 'hull', 'bottom'];

// Band boundaries (0 = top edge .. 1 = bottom edge) on the strip between points
// k and k+1 of a section. The stripe is only on the topsides (k = 0).
function cuts(boat, sec, k) {
  const boot = crossing(sec.pts[k][1], sec.pts[k + 1][1], boat.bootTop ?? 0.06);
  const [s0, s1] = k === 0 && boat.stripe ? boat.stripe : [0, 0];
  const a = Math.min(s0, boot), b = Math.min(Math.max(s1, a), boot);
  return [0, a, b, boot, 1];
}

function buildHull(boat, hull, mats) {
  const bins = { hull: [], stripe: [], bottom: [] };
  const deck = [];
  const st = hull.sections, K = st[0].pts.length;
  const P = (sec, k, side) => [hull.x + side * sec.pts[k][0], sec.pts[k][1], sec.z];
  const band = (a0, a1, b0, b1, ca, cb) => {
    for (let j = 0; j < 4; j++) {
      if (ca[j + 1] - ca[j] < 1e-6 && cb[j + 1] - cb[j] < 1e-6) continue;
      quad(bins[BANDS[j]], lerp3(a0, a1, ca[j]), lerp3(a0, a1, ca[j + 1]), lerp3(b0, b1, cb[j + 1]), lerp3(b0, b1, cb[j]));
    }
  };
  for (const side of [1, -1]) {
    for (let k = 0; k < K - 1; k++) {
      for (let i = 0; i < st.length - 1; i++) {
        const a = st[i], b = st[i + 1];
        band(P(a, k, side), P(a, k + 1, side), P(b, k, side), P(b, k + 1, side), cuts(boat, a, k), cuts(boat, b, k));
      }
    }
  }
  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i], b = st[i + 1];
    quad(deck, P(a, 0, -1), P(a, 0, 1), P(b, 0, 1), P(b, 0, -1));
  }
  // Transom: the same bands straight across.
  const t = st.at(-1);
  for (let k = 0; k < K - 1; k++) {
    const c = cuts(boat, t, k);
    band(P(t, k, -1), P(t, k + 1, -1), P(t, k, 1), P(t, k + 1, 1), c, c);
  }

  const g = new THREE.Group();
  g.add(new THREE.Mesh(geometry(bins.hull), mats.hull));
  if (bins.stripe.length) g.add(new THREE.Mesh(geometry(bins.stripe), mats.stripe));
  if (bins.bottom.length) g.add(new THREE.Mesh(geometry(bins.bottom), mats.bottom));
  g.add(new THREE.Mesh(geometry(deck), mats.deck));
  return g;
}

// A deckhouse narrowing to its roof: base half-widths w0 (front) and w1 (back).
function trunk(z0, z1, y0, y1, top, w0, w1, inset, mat) {
  const fb = [w0, y0, z0], rb = [w1, y1, z1];
  const ft = [w0 - inset, top, z0 + 2 * inset], rt = [w1 - inset, top, z1];
  const p = (v, side) => [side * v[0], v[1], v[2]];
  const out = [];
  quad(out, p(ft, -1), p(ft, 1), p(rt, 1), p(rt, -1));  // roof
  quad(out, p(fb, -1), p(fb, 1), p(ft, 1), p(ft, -1));  // front
  quad(out, p(rb, -1), p(rb, 1), p(rt, 1), p(rt, -1));  // back
  for (const s of [1, -1]) quad(out, p(fb, s), p(rb, s), p(rt, s), p(ft, s));  // sides
  return new THREE.Mesh(geometry(out), mat);
}

function box(w, h, d, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

function cylinder(r0, r1, len, mat) {
  return new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, len, 12), mat);
}

// A spar or beam between two points.
function strut(a, b, r, mat) {
  const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
  const m = cylinder(r, r, from.distanceTo(to), mat);
  m.position.copy(from).add(to).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
  return m;
}

function line(points, mat) {
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), mat);
}

function buildDeck(boat, mats) {
  const g = new THREE.Group(), geo = boat.geo, L = boat.loa;
  const c = boat.cabin;
  if (c) {
    const inset = c.inset ?? clamp(0.35 * (c.top - geo.deckAt(c.z1)), 0.05, 0.25);
    g.add(trunk(c.z0, c.z1, geo.deckAt(c.z0) - 0.02, geo.deckAt(c.z1) - 0.02, c.top, c.w0, c.w1, inset, mats.cabin));
    if (c.popTop) g.add(box(c.popTop.w, 0.06, c.popTop.d, mats.deck, 0, c.top + 0.03, c.popTop.z));
  }
  const cp = boat.cockpit;
  if (cp && !cp.deck) {  // cockpit well, just above the deck surface
    const well = [];
    quad(well, [-cp.w, geo.deckAt(cp.z0) + 0.01, cp.z0], [cp.w, geo.deckAt(cp.z0) + 0.01, cp.z0],
      [cp.w, geo.deckAt(cp.z1) + 0.01, cp.z1], [-cp.w, geo.deckAt(cp.z1) + 0.01, cp.z1]);
    g.add(new THREE.Mesh(geometry(well), mats.cockpit));
  }
  // Multihulls: bridge deck and deckhouse, or trampolines on crossbeams.
  if (boat.bridge) {
    const b = boat.bridge, w = 2 * geo.sideX, d = b.z1 - b.z0;
    g.add(box(w, b.top - b.bottom, d, mats.hull, 0, (b.top + b.bottom) / 2, (b.z0 + b.z1) / 2));
    g.add(box(w * 0.98, 0.02, d * 0.99, mats.deck, 0, b.top + 0.01, (b.z0 + b.z1) / 2));
  }
  if (boat.house) {
    const h = boat.house;
    g.add(trunk(h.z0, h.z1, boat.bridge.top, boat.bridge.top, h.top, h.w, h.w, 0.12 * (h.top - boat.bridge.top), mats.cabin));
  }
  const beamR = 0.008 * L + 0.03;
  for (const b of boat.beams || []) g.add(strut([-geo.sideX, b.y, b.z], [geo.sideX, b.y, b.z], beamR, mats.spar));
  if (boat.tramp) {
    const t = boat.tramp, mid = (t.z0 + t.z1) / 2;
    const outer = geo.sideX - 0.6 * geo.sideHalfAt(mid);
    const spans = t.inner ? [[0.8 * geo.halfAt(mid), outer]] : [[-outer, outer]];
    for (const [x0, x1] of spans) {
      for (const side of t.inner ? [1, -1] : [1]) {
        const net = new THREE.Mesh(new THREE.PlaneGeometry(Math.abs(x1 - x0), t.z1 - t.z0), mats.tramp);
        net.rotation.x = -Math.PI / 2;
        net.position.set(side * (x0 + x1) / 2, t.y, mid);
        g.add(net);
      }
    }
  }
  return g;
}

// Keel, boards and rudders: a tapered slab from `top` to `bottom`, root chord
// z0..z1, tip chord `tip` set back by `sweep`, optional bulb at the bottom.
function buildFoil(f, mats) {
  const g = new THREE.Group();
  const x = f.x ?? 0, t = (f.thick ?? 0.03) / 2;
  const tip = f.tip ?? f.z1 - f.z0, sweep = f.sweep ?? 0;
  const r0 = f.z0, r1 = f.z1, t0 = f.z0 + sweep, t1 = t0 + tip;
  const v = (z, y, side) => [x + side * t, y, z];
  const out = [];
  for (const s of [1, -1]) quad(out, v(r0, f.top, s), v(r1, f.top, s), v(t1, f.bottom, s), v(t0, f.bottom, s));
  quad(out, v(r0, f.top, -1), v(r0, f.top, 1), v(t0, f.bottom, 1), v(t0, f.bottom, -1));  // leading edge
  quad(out, v(r1, f.top, -1), v(r1, f.top, 1), v(t1, f.bottom, 1), v(t1, f.bottom, -1));  // trailing edge
  quad(out, v(t0, f.bottom, -1), v(t0, f.bottom, 1), v(t1, f.bottom, 1), v(t1, f.bottom, -1));
  g.add(new THREE.Mesh(geometry(out), mats.foil));
  if (f.bulb) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), mats.foil);
    b.scale.set(f.bulb.r, f.bulb.r * 0.8, f.bulb.length / 2);
    b.position.set(x, f.bottom, (t0 + t1) / 2 + f.bulb.length * 0.12);
    g.add(b);
  }
  return g;
}

function buildFittings(boat, mats) {
  const g = new THREE.Group(), geo = boat.geo;
  for (const f of boat.foils || []) g.add(buildFoil(f, mats));
  const h = boat.helm;
  if (h?.type === 'tiller') g.add(box(0.05, 0.05, h.length, mats.foil, 0, h.y, h.z));
  if (h?.type === 'wheel') {
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(h.r, 0.025, 8, 32), mats.spar);
    wheel.position.set(0, h.y + h.r + 0.12, h.z);
    g.add(wheel, box(0.08, h.r + 0.12, 0.08, mats.spar, 0, h.y + (h.r + 0.12) / 2, h.z + 0.05));
  }
  if (boat.outboard) {  // on a transom bracket
    const o = boat.outboard, y = geo.deckAt(geo.stern);
    g.add(box(0.30, 0.42, 0.40, mats.outboard, o.x, y + 0.05, o.z));
    g.add(box(0.08, y + 0.3, 0.12, mats.outboard, o.x, (y - 0.3) / 2 - 0.13, o.z + 0.02));
  }
  return g;
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

// Sail cloth for one side of a sail, in the sail's plane (z aft, y up, metres).
//   style: { stripes: [colours], angle (degrees the bands rise aft), number, numberColor }
//   corners: [[z, y] tack, head, clew]; numberY: height of the number's centre
//   mirrored: drawn for the side seen through the back of the texture, so the
//   number reads correctly from there.
function sailTexture(zSpan, ySpan, base, style, corners, numberY, mirrored) {
  const W = 512, H = 1024, sx = W / zSpan, sy = H / ySpan;
  return canvasTexture(W, H, ctx => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);
    if (style?.stripes?.length) {
      const a = (style.angle ?? 0) * DEG, n = style.stripes.length;
      const across = (z, y) => y * Math.cos(a) - z * Math.sin(a);  // distance across the bands
      const values = corners.map(([z, y]) => across(z, y));
      const lo = Math.min(...values), hi = Math.max(...values);
      style.stripes.forEach((color, i) => {
        const s0 = lo + (hi - lo) * i / n - (i === 0 ? 1 : 0);
        const s1 = lo + (hi - lo) * (i + 1) / n + (i === n - 1 ? 1 : 0);
        const pt = (z, s) => [z * sx, H - ((s + z * Math.sin(a)) / Math.cos(a)) * sy];
        ctx.fillStyle = color;
        ctx.beginPath();
        [pt(-1, s0), pt(zSpan + 1, s0), pt(zSpan + 1, s1), pt(-1, s1)]
          .forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.fill();
      });
    }
    if (style?.number) {
      // Near the top of the leech, as on real sails.
      const [[, tackY], [, headY], [clewZ]] = corners;
      const h = 0.06 * (headY - tackY);  // number height, metres
      const top = numberY + h / 2;
      const leechZ = clewZ * (1 - (top - tackY) / (headY - tackY));
      ctx.save();
      ctx.translate((leechZ - 0.07) * sx, H - numberY * sy);
      ctx.scale((mirrored ? -1 : 1) * sx / sy, 1);  // undo the canvas's non-square metres
      ctx.font = `bold ${Math.round(h * sy)}px Helvetica, Arial, sans-serif`;
      ctx.textAlign = mirrored ? 'left' : 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = style.numberColor || '#1a1a1a';
      ctx.fillText(style.number, 0, 0);
      ctx.restore();
    }
  });
}

// A mast with its boom and sail (main or mizzen); the sail group pivots about the mast.
function buildMast(m, style, base, mats, rig) {
  const r = clamp(0.0075 * m.mastTop, 0.03, 0.16);
  rig.add(strut([0, m.mastBase, m.mastZ], [0, m.mastTop, m.mastZ], r, mats.spar));
  const sail = new THREE.Group();
  sail.position.set(0, m.gooseneck, m.mastZ);
  const boom = cylinder(r * 0.8, r * 0.8, m.boom, mats.spar);
  boom.rotation.x = Math.PI / 2;
  boom.position.z = m.boom / 2;
  sail.add(boom);
  const tack = new THREE.Vector3(0, 0.05, 0.03), clew = new THREE.Vector3(0, 0.05, m.boom - 0.05);
  const head = new THREE.Vector3(0, m.mastTop - m.gooseneck - 0.1, 0.03);
  const geo = sailGeometry(tack, head, clew, 0.10, clew.z, head.y);
  // Two layers sharing the shape: the front faces show the port side, the back
  // faces the starboard side, each with its own correctly-reading number.
  const corners = [[tack.z, tack.y], [head.z, head.y], [clew.z, clew.y]];
  const mat = (map, side) => new THREE.MeshStandardMaterial({ map, side, roughness: 0.8 });
  sail.add(new THREE.Mesh(geo, mat(sailTexture(clew.z, head.y, base, style, corners, head.y * 0.55, false), THREE.FrontSide)));
  sail.add(new THREE.Mesh(geo, mat(sailTexture(clew.z, head.y, base, style, corners, head.y * 0.63, true), THREE.BackSide)));
  rig.add(sail);
  return { sail, geo };
}

function buildRig(boat, mats) {
  const r = boat.rig, rig = new THREE.Group();
  const sails = boat.sails || {};
  const base = sails.color || '#fbfbf8';
  const V = a => new THREE.Vector3(...a);
  const hounds = V([0, r.hounds ?? r.mastTop, r.mastZ]);
  const out = { rig };

  ({ sail: out.main, geo: out.mainGeo } = buildMast(r, sails.main, base, mats, rig));
  for (const c of r.shrouds || []) rig.add(line([V(c), hounds], mats.wire));
  if (r.backstay) rig.add(line([V([0, r.mastTop, r.mastZ]), V(r.backstay)], mats.wire));
  if (r.mizzen) {
    const m = r.mizzen;
    ({ sail: out.mizzen, geo: out.mizzenGeo } = buildMast(m, sails.mizzen ?? { ...sails.main, number: null }, base, mats, rig));
    const top = V([0, m.mastTop, m.mastZ]);
    for (const c of m.shrouds || []) rig.add(line([V(c), top], mats.wire));
    if (m.backstay) rig.add(line([top, V(m.backstay)], mats.wire));
  }
  // Jib: pivots about the forestay.
  if (r.tack) {
    const T = V(r.tack);
    rig.add(line([T, hounds], mats.wire));
    const jib = new THREE.Group();
    jib.position.copy(T);
    const head = hounds.clone().sub(T).multiplyScalar(0.97);
    const jTack = new THREE.Vector3(0, 0.05, 0.02), jClew = new THREE.Vector3(0, r.jibClew[0], r.jibClew[1]);
    out.jibGeo = sailGeometry(jTack, head, jClew, 0.11, jClew.z, head.y);
    const cloth = sailTexture(jClew.z, head.y, base, sails.jib, [[jTack.z, jTack.y], [head.z, head.y], [jClew.z, jClew.y]], 0, false);
    jib.add(new THREE.Mesh(out.jibGeo, new THREE.MeshStandardMaterial({ map: cloth, side: THREE.DoubleSide, roughness: 0.8 })));
    rig.add(jib);
    out.jib = jib;
    out.forestay = head.clone().normalize();
  }
  return out;
}

// Everything that belongs to the boat, built from its description.
function buildBoat(boat) {
  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({
    color, roughness: 0.7, metalness: 0, flatShading: true, side: THREE.DoubleSide, ...extra,
  });
  const c = boat.colors;
  const mats = {
    hull: std(c.hull),
    stripe: std(c.stripe || c.hull),
    bottom: std(c.bottom),
    deck: std(c.deck),
    cabin: std(c.cabin),
    cockpit: std(c.cockpit),
    spar: std(c.spar, { metalness: 0.4, roughness: 0.4 }),
    foil: std(c.foil),
    outboard: std(0x3a3d42),
    tramp: std(c.tramp || '#22314f', { transparent: true, opacity: 0.85, flatShading: false }),
    wire: new THREE.LineBasicMaterial({ color: 0x606870 }),
  };
  const group = new THREE.Group();
  for (const h of boat.hulls) group.add(buildHull(boat, h, mats));
  group.add(buildDeck(boat, mats), buildFittings(boat, mats));
  const rig = buildRig(boat, mats);
  group.add(rig.rig);
  const lights = buildNavLights(boat.lights);
  group.add(lights.group);
  const dispose = () => group.traverse(o => {
    o.geometry?.dispose();
    for (const m of [o.material].flat()) {
      if (!m) continue;
      m.map?.dispose();
      m.dispose();
    }
  });
  return { group, rig, lights, dispose };
}

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

// Lights from the boat description: { name, color, pos, from, to } each.
function buildNavLights(defs) {
  const group = new THREE.Group();
  const glow = glowTexture();
  const lights = defs.map(def => {
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

// boatSpec: a boat from boats.js makeBoat().
export function createBoatView(container, boatSpec) {
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
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 150000);
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
    aw: std(0xff8a1f, { flatShading: false }),
    tw: std(0x2f7cf0, { flatShading: false }),
    cog: new THREE.MeshBasicMaterial({ color: 0x9a5bd6, transparent: true, opacity: 0.8 }),
  };

  // Water and compass ring are fixed to the world (north = -Z).
  const waterMat = new THREE.MeshBasicMaterial({ color: 0x8fb8d8, transparent: true, opacity: 0.78, depthWrite: false });
  const water = new THREE.Mesh(new THREE.CircleGeometry(90000, 96), waterMat);
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

  // Boat, rotated by heading, pitch and heel. The view was designed around the
  // 5.7 m Potter 19; `k` scales the camera, compass ring and arrows to other boats.
  const boat = new THREE.Group();
  boat.rotation.order = 'YXZ';
  scene.add(boat);
  const ais = new AisLayer(scene);
  let built = null, k = 1;
  const target = new THREE.Vector3(0, 1.6, 0);
  function setBoat(spec) {
    if (built) {
      boat.remove(built.group);
      built.dispose();
    }
    built = buildBoat(spec);
    boat.add(built.group);
    const old = k;
    k = clamp(spec.loa / 5.72, 0.5, 5);
    target.y = 0.24 * spec.rig.mastTop;
    cog.scale.setScalar(k);
    cam.distance *= k / old;
    zoomTo(cam.distance);
  }

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
  // Sizes are for the Potter 19 and scaled by k: `distance` is the camera's
  // distance divided by k.
  function placeArrow(arrow, angleDeg, liftClose, distance) {
    arrow.visible = Number.isFinite(angleDeg);
    if (!arrow.visible) return;
    const size = Math.max(1, (distance / 16) ** 0.8);
    const settle = Math.min(1, Math.max(0, (distance - 25) / 100));  // 0 close up, 1 from 125 m (Potter)
    const height = k * ((1 - settle) * liftClose + settle * 0.4 * size);
    const a = angleDeg * DEG;
    const radius = 6.2 * size * k;
    arrow.scale.setScalar(size * k);
    arrow.position.set(radius * Math.sin(a), height, -radius * Math.cos(a));
    arrow.rotation.y = -a;  // local +Z points back at the boat
  }

  // Camera: orbit by dragging, zoom by pinching or scrolling.
  const cam = { offset: -35, elevation: 20, distance: 16 };
  const maxDistance = () => (mapLayer ? 6000 : 45 * k);
  function zoomTo(d) { cam.distance = Math.min(maxDistance(), Math.max(7 * k, d)); }
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
  el.addEventListener('dblclick', () => Object.assign(cam, { offset: -35, elevation: 20, distance: 16 * k }));

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

  setBoat(boatSpec);

  return {
    // s: { hdg, awa, twa, cog, heel, pitch, lat, lon, utc, sog, cogTrue, trim: {main, jib, side, luffing}, ais };
    // (cog is smoothed for display; sog and cogTrue are the raw GPS values in m/s and degrees)
    // angles in degrees, utc in ms; ais: where to get targets (see AisLayer.update).
    // Renders before returning, so the canvas can be copied right after.
    update(s) {
      const hdg = Number.isFinite(s.hdg) ? s.hdg : 0;
      boat.rotation.set((s.pitch || 0) * DEG, -hdg * DEG, -(s.heel || 0) * DEG);
      windFrame.rotation.y = -hdg * DEG;
      const dn = cam.distance / k;  // distance as if this were the Potter 19
      placeArrow(aw, s.awa, 3.2, dn);
      placeArrow(tw, s.twa, 4.4, dn);
      cog.visible = Number.isFinite(s.cog);
      if (cog.visible) cog.rotation.y = -s.cog * DEG;

      const { main, jib, side, luffing } = s.trim;
      const flap = luffing ? Math.sin(performance.now() / 90) * 0.5 : 1;
      const rig = built.rig;
      rig.main.rotation.y = -side * main * DEG;
      setCamber(rig.mainGeo, -side * flap);
      if (rig.mizzen) {
        rig.mizzen.rotation.y = -side * main * 0.85 * DEG;
        setCamber(rig.mizzenGeo, -side * flap);
      }
      if (rig.jib) {
        rig.jib.quaternion.setFromAxisAngle(rig.forestay, -side * jib * DEG);
        setCamber(rig.jibGeo, -side * flap);
      }

      // Keep the wind arrows, compass ring and marker readable as the camera pulls back.
      const grow = Math.max(1, (dn / 16) ** 0.8);  // same growth as the wind arrows
      ring.scale.setScalar(grow * k);
      marker.visible = dn > 60;
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
      built.lights.update(1 - smooth(-1.5, 0, sunAltitude), camera, boat, cam.distance);

      renderer.clear();
      renderer.toneMapping = THREE.ACESFilmicToneMapping;  // the sky model needs it
      renderer.render(sky.scene, camera);
      renderer.toneMapping = THREE.NoToneMapping;  // the boat and map keep their colours
      renderer.clearDepth();
      renderer.render(scene, camera);
    },
    canvas: renderer.domElement,
    setBoat,
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
