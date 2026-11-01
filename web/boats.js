// The boats the dashboard can draw, and the 2D drawings of them. Each boat is
// described by its main dimensions; hull lines, deck layout, rig, foils and
// lights are worked out from those, and both the 2D views here and the 3D view
// (boat3d.js) are built from the same description.
//
// Units are metres. Boat axes: +x starboard, +y up from the waterline, -z toward
// the bow; the boat is centred on z = 0.
//
// The named boats use their published length, beam, draft and rig sizes; hull
// shapes and deck layouts are approximations, good for a picture, not a plan.

const FT = 0.3048;
const SVGNS = 'http://www.w3.org/2000/svg';

// ------------------------------------------------------------------ catalog

export const BOATS = [
  { id: 'ilca', name: 'ILCA 7 (Laser)', note: 'Single-handed dinghy', make: ilca },
  { id: 'hobie16', name: 'Hobie 16', note: 'Beach catamaran', make: hobie16 },
  { id: 'potter19', name: 'Potter 19', note: 'West Wight Potter trailer sailer', make: potter19 },
  { id: 'catalina22', name: 'Catalina 22', note: 'Swing-keel trailer sailer', make: catalina22 },
  { id: 'j24', name: 'J/24', note: 'One-design keelboat', make: j24 },
  { id: 'catalina30', name: 'Catalina 30', note: 'Masthead-rig cruiser', make: catalina30 },
  { id: 'oceanis38', name: 'Beneteau Oceanis 38.1', note: 'Modern cruiser', make: oceanis38 },
];

// Generic types whose length can be chosen (metres).
export const GENERIC = [
  { id: 'sloop', name: 'Sloop', note: 'Fin keel, one mast', min: 4, max: 25, length: 9, make: sloop },
  { id: 'ketch', name: 'Ketch', note: 'Main and mizzen masts', min: 8, max: 25, length: 13, make: ketch },
  { id: 'catamaran', name: 'Catamaran', note: 'Beach cat under 8 m, cruiser above', min: 4, max: 25, length: 12, make: catamaran },
  { id: 'trimaran', name: 'Trimaran', note: 'Main hull and two floats', min: 5, max: 25, length: 9, make: trimaran },
];

export const DEFAULT_BOAT = { id: 'potter19' };

// A finished boat description for a catalog id (and length, for generic types).
export function makeBoat(id, length) {
  const named = BOATS.find(b => b.id === id);
  if (named) return finish({ ...named.make(), id, name: named.name });
  const gen = GENERIC.find(b => b.id === id);
  if (!gen) return makeBoat(DEFAULT_BOAT.id);
  const L = Math.min(gen.max, Math.max(gen.min, Number(length) || gen.length));
  return finish({ ...gen.make(L), id, name: `${gen.name} ${fmtLength(L)}`, generic: true });
}

export function fmtLength(m) {
  return `${m.toFixed(m < 10 ? 1 : 0)} m (${Math.round(m / FT)} ft)`;
}

// ------------------------------------------------------------------ hull lines

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Cross-sections of one hull from stem to transom. Each section is
// { z, pts: [[x, y], ...] }: half a section, from the sheer down to the keel line.
//   fbBow, fbStern: sheer height above the waterline; draft: depth of the hull body
//   entry: where the hull is widest (0 bow .. 1 stern); transom: stern width / max width
//   stemRise: height of the forefoot above the waterline (bow overhang)
//   round: section fullness (2 = round, higher = flatter and boxier)
function hullSections(h, N = 32) {
  const { loa: L, beam, fbBow, fbStern, draft } = h;
  const entry = h.entry ?? 0.55, transom = h.transom ?? 0.8, bowPow = h.bowPow ?? 0.8;
  const stemRise = h.stemRise ?? 0, spring = h.spring ?? 0, sternDraft = h.sternDraft ?? 0.15;
  const n = h.round ?? 2.5, K = 6;
  const sections = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const plan = t < entry ? Math.sin(Math.PI / 2 * t / entry) ** bowPow
      : 1 - (1 - transom) * ((t - entry) / (1 - entry)) ** 2;
    const w = beam / 2 * plan;
    const ys = fbBow + (fbStern - fbBow) * t - spring * Math.sin(Math.PI * t);
    const deep = t < 0.45 ? Math.sin(Math.PI / 2 * t / 0.45) ** 0.6
      : 1 - (1 - sternDraft) * ((t - 0.45) / 0.55) ** 1.6;
    const yk = stemRise * (1 - smoothstep(0, 0.15, t)) - draft * deep;
    const pts = [[w, ys]];
    // Topsides down to the turn of the bilge, then a superellipse to the keel.
    const yTurn = yk + (ys - yk) * 0.45, wl = w * 0.97;
    for (let k = 0; k <= K; k++) {
      const a = k / K * Math.PI / 2;
      pts.push([wl * Math.cos(a) ** (2 / n), yTurn - (yTurn - yk) * Math.sin(a) ** (2 / n)]);
    }
    sections.push({ z: (h.shift ?? 0) - L / 2 + t * L, pts });
  }
  return sections;
}

// Paint: `stripe` is [top, bottom] as fractions of the way down the topsides
// (the first band of each section), in colors.stripe; below `bootTop` metres above
// the waterline is bottom paint.

// Linear interpolation of section rows (same point count) in between, so the
// coarse hand-drawn Potter lines become smooth.
function refine(sections, steps) {
  const out = [];
  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i], b = sections[i + 1];
    for (let k = 0; k < steps; k++) {
      const f = k / steps;
      out.push({ z: a.z + (b.z - a.z) * f, pts: a.pts.map((p, j) => [p[0] + (b.pts[j][0] - p[0]) * f, p[1] + (b.pts[j][1] - p[1]) * f]) });
    }
  }
  out.push(sections.at(-1));
  return out;
}

// Value of a section quantity at z, interpolated between stations.
function along(sections, z, get) {
  if (z <= sections[0].z) return get(sections[0]);
  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i], b = sections[i + 1];
    if (z <= b.z) return get(a) + (get(b) - get(a)) * (z - a.z) / (b.z - a.z);
  }
  return get(sections.at(-1));
}

// Fills in what every boat needs from its description: hull sections, helpers
// for deck height and width, layout, lights.
function finish(p) {
  const hulls = p.hulls.map(h => ({
    x: h.x ?? 0,
    sections: h.sections ?? hullSections(h),
  }));
  const main = hulls[0].sections;
  const geo = {
    L: p.loa,
    bow: main[0].z,
    stern: main.at(-1).z,
    deckAt: z => along(main, z, s => s.pts[0][1]),
    halfAt: z => along(main, z, s => s.pts[0][0]),
    keelAt: z => along(main, z, s => s.pts.at(-1)[1]),
  };
  // Side hulls (catamaran, trimaran floats).
  const side = hulls.find(h => h.x > 0);
  if (side) {
    geo.sideX = side.x;
    geo.sideDeckAt = z => along(side.sections, z, s => s.pts[0][1]);
    geo.sideHalfAt = z => along(side.sections, z, s => s.pts[0][0]);
    geo.sideKeelAt = z => along(side.sections, z, s => s.pts.at(-1)[1]);
    geo.sideBow = side.sections[0].z;
    geo.sideStern = side.sections.at(-1).z;
  }
  const boat = { ...p, hulls, geo, ...p.layout(geo) };
  delete boat.layout;
  boat.lights = boat.lights === false ? [] : navLights(boat);
  return boat;
}

// Navigation lights (COLREGS rule 25 for a small sailboat, plus the masthead
// light this dashboard has always shown): position and visible arc from the bow.
function navLights(b) {
  const g = b.geo, r = b.rig;
  const lights = [{ name: 'masthead', color: 0xfff4dc, pos: [0, r.mastTop + 0.04, r.mastZ - 0.07], from: -112.5, to: 112.5 }];
  if (b.kind === 'mono' || b.kind === 'tri') {
    const z = g.bow + 0.12, y = g.deckAt(z) + 0.12;
    lights.push(
      { name: 'port', color: 0xff2a1a, pos: [-0.05, y, z], from: -112.5, to: 0 },
      { name: 'starboard', color: 0x14ff5a, pos: [0.05, y, z], from: 0, to: 112.5 });
  } else {
    const z = g.sideBow + 0.25, y = g.sideDeckAt(z) + 0.12;
    lights.push(
      { name: 'port', color: 0xff2a1a, pos: [-g.sideX, y, z], from: -112.5, to: 0 },
      { name: 'starboard', color: 0x14ff5a, pos: [g.sideX, y, z], from: 0, to: 112.5 });
  }
  const sz = b.kind === 'cat' ? (b.bridge ? b.bridge.z1 : b.beams.at(-1).z) : g.stern;
  const sy = b.kind === 'cat' ? (b.bridge ? b.bridge.top : g.sideDeckAt(sz)) : g.deckAt(sz);
  lights.push({ name: 'stern', color: 0xfff4dc, pos: [0, sy + 0.17, sz + 0.02], from: 112.5, to: 247.5 });
  return lights;
}

// ------------------------------------------------------------------ colours

const WHITE_HULL = { hull: '#f6f6f2', stripe: '#1c3f78', bottom: '#1d2f5c', deck: '#e8e4da', cabin: '#f7f6f1', cockpit: '#c9c2b2', spar: '#b8c0c8', foil: '#2b2b2b' };
const PLAIN_SAILS = { color: '#fbfbf8' };

// ------------------------------------------------------------------ named boats

// West Wight Potter 19: hard-chine trailer sailer, LOA 5.72 m, beam 2.29 m.
// Stations from stem to transom: z, sheer half-breadth, sheer height, chine
// half-breadth, chine height, keel height.
const POTTER_STATIONS = [
  [-2.86, 0.00, 0.86, 0.00, 0.50, 0.42],
  [-2.40, 0.48, 0.80, 0.30, 0.22, 0.02],
  [-1.70, 0.86, 0.73, 0.68, 0.06, -0.14],
  [-0.80, 1.08, 0.67, 0.92, 0.00, -0.21],
  [0.20, 1.14, 0.62, 1.00, -0.01, -0.22],
  [1.30, 1.10, 0.59, 0.99, 0.00, -0.17],
  [2.86, 0.98, 0.57, 0.90, 0.06, -0.02],
];

function potter19() {
  const sections = refine(POTTER_STATIONS.map(([z, sb, sy, cb, cy, ky]) => ({ z, pts: [[sb, sy], [cb, cy], [0, ky]] })), 8);
  return {
    kind: 'mono', loa: 5.72, beam: 2.29,
    hulls: [{ sections }],
    // Blue topsides, white pinstripe, black bottom paint.
    colors: { hull: '#1d4c97', stripe: '#ffffff', bottom: '#141414', deck: '#e2dccd', cabin: '#f7f6f1', cockpit: '#b3aa98', spar: '#b8c0c8', foil: '#2b2b2b' },
    stripe: [0.15, 0.20],  // pinstripe 15-20% of the way from sheer to chine
    bootTop: 0.06,
    // White main with a green 974 high on the leech; jib with three blue and two white bands at 20 degrees.
    sails: {
      color: '#fbfbf8',
      main: { number: '974', numberColor: '#178a3c' },
      jib: { stripes: ['#1f5fbf', '#fbfbf8', '#1f5fbf', '#fbfbf8', '#1f5fbf'], angle: 20 },
    },
    layout: g => ({
      cabin: { z0: -1.75, z1: 0.35, w0: 0.55, w1: 0.72, top: 0.98, popTop: { z: -0.15, w: 1.0, d: 0.95 } },
      cockpit: { z0: 0.45, z1: 2.70, w: 0.78 },
      foils: [
        { type: 'board', z0: -0.71, z1: -0.29, top: -0.2, bottom: -1.155, thick: 0.03 },
        { type: 'rudder', z0: 2.85, z1: 3.19, top: 0.57, bottom: -0.43, thick: 0.03 },
      ],
      helm: { type: 'tiller', z: 2.3, y: 0.72, length: 1.3 },
      outboard: { x: -0.55, z: 3.10 },
      pulpit: true,
      rig: {
        type: 'sloop', mastZ: -0.86, mastBase: 0.98, mastTop: 6.60, hounds: 5.85, gooseneck: 1.40,
        boom: 2.25, tack: [0, 0.88, -2.80], jibClew: [0.35, 1.95],
        shrouds: [[1.05, g.deckAt(-0.86), -0.86], [-1.05, g.deckAt(-0.86), -0.86]],
        backstay: [0, g.deckAt(2.8), 2.8],
      },
    }),
  };
}

// ILCA 7 / Laser: 4.19 m una-rigged dinghy, unstayed mast, daggerboard.
function ilca() {
  return {
    kind: 'mono', loa: 4.19, beam: 1.37,
    hulls: [{ loa: 4.19, beam: 1.37, fbBow: 0.36, fbStern: 0.30, draft: 0.11, stemRise: 0.08, entry: 0.48, transom: 0.72, round: 3.5, spring: 0.03, bowPow: 0.7, sternDraft: 0.25 }],
    colors: { ...WHITE_HULL, stripe: null, bottom: '#f6f6f2', deck: '#f3f3ee', cockpit: '#e4e1d8' },
    lights: false,
    sails: PLAIN_SAILS,
    layout: g => ({
      cabin: null,
      cockpit: { z0: 0.35, z1: 1.95, w: 0.36 },
      foils: [
        { type: 'board', z0: -0.62, z1: -0.32, top: 0.25, bottom: -0.79, thick: 0.025 },
        { type: 'rudder', z0: 2.1, z1: 2.36, top: 0.30, bottom: -0.70, thick: 0.025 },
      ],
      helm: { type: 'tiller', z: 1.55, y: 0.42, length: 1.0 },
      rig: { type: 'cat', mastZ: -1.17, mastBase: g.deckAt(-1.17), mastTop: 6.35, gooseneck: 0.78, boom: 2.74 },
    }),
  };
}

// Hobie 16: 5.11 m beach catamaran, 2.41 m wide, no boards (asymmetric hulls).
function hobie16() {
  const hullBeam = 0.48, x = 2.41 / 2 - hullBeam / 2;
  const hull = { loa: 5.11, beam: hullBeam, fbBow: 0.60, fbStern: 0.42, draft: 0.25, stemRise: 0.05, entry: 0.55, transom: 0.4, round: 1.8, bowPow: 1, sternDraft: 0.35 };
  return {
    kind: 'cat', loa: 5.11, beam: 2.41,
    hulls: [{ ...hull, x: -x }, { ...hull, x }],
    colors: { ...WHITE_HULL, stripe: null, bottom: '#f6f6f2', deck: '#f3f3ee', tramp: '#22314f' },
    lights: false,
    // The classic rainbow sails.
    sails: {
      color: '#fbfbf8',
      main: { stripes: ['#d7263d', '#f46036', '#ffd23f', '#38b26a', '#2e86de', '#5b3fa8'], angle: 0 },
      jib: { stripes: ['#d7263d', '#f46036', '#ffd23f', '#38b26a', '#2e86de'], angle: 0 },
    },
    layout: g => {
      const deck = g.sideDeckAt(0) - 0.05;
      return {
        beams: [{ z: -0.65, y: deck }, { z: 1.75, y: deck }],
        tramp: { z0: -0.65, z1: 1.75, y: deck },
        foils: [-x, x].map(hx => ({ type: 'rudder', x: hx, z0: 2.56, z1: 2.82, top: 0.35, bottom: -0.55, thick: 0.03 })),
        rig: {
          type: 'sloop', mastZ: -0.65, mastBase: deck, mastTop: deck + 8.08, hounds: deck + 5.9, gooseneck: deck + 0.45,
          boom: 2.6, tack: [0, deck - 0.05, -2.25], jibClew: [0.25, 2.2],
          shrouds: [[x, g.sideDeckAt(-0.6), -0.6], [-x, g.sideDeckAt(-0.6), -0.6]],
        },
      };
    },
  };
}

// Catalina 22: 6.55 m (21' 6") swing-keel trailer sailer, masthead rig.
function catalina22() {
  return {
    kind: 'mono', loa: 6.55, beam: 2.34,
    hulls: [{ loa: 6.55, beam: 2.34, fbBow: 0.92, fbStern: 0.68, draft: 0.30, stemRise: 0.30, entry: 0.55, transom: 0.78, round: 2.6, spring: 0.05 }],
    colors: WHITE_HULL, stripe: [0.14, 0.22], bootTop: 0.07,
    sails: PLAIN_SAILS,
    layout: g => cruiserLayout(g, {
      cabin: [-2.15, 0.45, 0.45], cockpit: [0.65, 3.10], mastZ: -0.85, I: 24.0 * FT, mastAbove: 0.1, boom: 8.0 * FT,
      tackZ: -3.12, jibLP: 1.1, masthead: true,
      foils: [
        { type: 'board', z0: -0.45, z1: 0.30, top: -0.25, bottom: -1.52, thick: 0.05, tip: 0.6, sweep: 0.25 },
        { type: 'rudder', z0: 3.28, z1: 3.62, top: 0.58, bottom: -0.65, thick: 0.03 },
      ],
      helm: 'tiller', outboard: true,
    }),
  };
}

// J/24: 7.32 m one-design, fractional rig, fin keel 1.22 m.
function j24() {
  return {
    kind: 'mono', loa: 7.32, beam: 2.71,
    hulls: [{ loa: 7.32, beam: 2.71, fbBow: 0.95, fbStern: 0.62, draft: 0.38, stemRise: 0.32, entry: 0.52, transom: 0.70, round: 2.4, spring: 0.05 }],
    colors: { ...WHITE_HULL, stripe: '#b8202a', bottom: '#151515' }, stripe: [0.10, 0.15], bootTop: 0.07,
    sails: PLAIN_SAILS,
    layout: g => cruiserLayout(g, {
      cabin: [-2.45, -0.05, 0.32], cockpit: [0.20, 3.45], mastZ: -0.65, I: 28.0 * FT, mastAbove: 0.65, boom: 10.0 * FT,
      tackZ: -3.55, jibLP: 1.35,
      foils: [
        { type: 'keel', z0: -0.62, z1: 0.42, top: g.keelAt(-0.1) + 0.05, bottom: -1.22, thick: 0.10, tip: 0.72, sweep: 0.28 },
        { type: 'rudder', z0: 3.66, z1: 3.98, top: 0.52, bottom: -0.95, thick: 0.04 },
      ],
      helm: 'tiller',
    }),
  };
}

// Catalina 30: 9.12 m masthead cruiser, fin keel, spade rudder, wheel steering.
function catalina30() {
  return {
    kind: 'mono', loa: 9.12, beam: 3.33,
    hulls: [{ loa: 9.12, beam: 3.33, fbBow: 1.30, fbStern: 1.00, draft: 0.45, stemRise: 0.35, entry: 0.55, transom: 0.72, round: 2.5, spring: 0.06 }],
    colors: WHITE_HULL, stripe: [0.14, 0.22], bootTop: 0.09,
    sails: PLAIN_SAILS,
    layout: g => cruiserLayout(g, {
      cabin: [-2.95, 0.80, 0.55], cockpit: [1.05, 3.95], mastZ: -0.69, I: 35.5 * FT, mastAbove: 0.1, boom: 11.25 * FT,
      tackZ: -4.42, jibLP: 1.35, masthead: true,
      foils: [
        { type: 'keel', z0: -1.0, z1: 0.6, top: g.keelAt(-0.2) + 0.05, bottom: -1.60, thick: 0.16, tip: 1.05, sweep: 0.40 },
        { type: 'rudder', z0: 3.0, z1: 3.55, top: g.keelAt(3.3) + 0.05, bottom: -1.25, thick: 0.08, tip: 0.38, sweep: 0.12 },
      ],
      helm: 'wheel',
    }),
  };
}

// Beneteau Oceanis 38.1: 11.5 m modern cruiser, plumb bow, wide stern, bulb keel.
function oceanis38() {
  return {
    kind: 'mono', loa: 11.5, beam: 3.99,
    hulls: [{ loa: 11.5, beam: 3.99, fbBow: 1.45, fbStern: 1.12, draft: 0.50, stemRise: 0, entry: 0.50, transom: 0.92, round: 2.9, spring: 0.04, sternDraft: 0.05 }],
    colors: { ...WHITE_HULL, stripe: '#7c858d', bottom: '#2a2a2a', deck: '#cfc8bb', spar: '#2f3438' }, stripe: [0.16, 0.24], bootTop: 0.10,
    sails: { color: '#f2f3f4' },
    layout: g => cruiserLayout(g, {
      cabin: [-3.75, 1.30, 0.42], cockpit: [1.45, 5.45], mastZ: -1.55, I: 14.1, mastAbove: 1.3, boom: 4.9,
      tackZ: -5.62, jibLP: 0.95,
      foils: [
        { type: 'keel', z0: -1.45, z1: -0.2, top: g.keelAt(-0.8) + 0.05, bottom: -1.98, thick: 0.14, tip: 0.85, sweep: 0.45, bulb: { length: 1.7, r: 0.21 } },
        { type: 'rudder', z0: 4.1, z1: 4.7, top: g.keelAt(4.4) + 0.05, bottom: -1.45, thick: 0.09, tip: 0.4, sweep: 0.12 },
      ],
      helm: 'wheel',
    }),
  };
}

// Deck layout and rig of a monohull cruiser from a few published figures.
//   cabin: [front z, back z, height above the deck]; cockpit: [front z, back z]
//   I: forestay height above the deck; mastAbove: mast above the forestay (0 for masthead)
function cruiserLayout(g, o) {
  const L = g.L;
  const [c0, c1, rise] = o.cabin;
  const cabin = { z0: c0, z1: c1, w0: 0.58 * g.halfAt(c0), w1: 0.7 * g.halfAt(c1), top: Math.max(g.deckAt(c0), g.deckAt(c1)) + rise };
  const inCabin = o.mastZ > c0 && o.mastZ < c1;
  const mastBase = inCabin ? cabin.top : g.deckAt(o.mastZ);
  const hounds = g.deckAt(o.mastZ) + o.I;
  const mastTop = hounds + (o.mastAbove ?? 0);
  const tackZ = o.tackZ;
  const footLen = (o.mastZ - tackZ) * o.jibLP;
  const chain = 0.92 * g.halfAt(o.mastZ + 0.1);
  const cockpitW = 0.62 * g.halfAt((o.cockpit[0] + o.cockpit[1]) / 2);
  const helm = o.helm === 'wheel'
    ? { type: 'wheel', z: o.cockpit[1] - 0.06 * L, y: g.deckAt(o.cockpit[1]), r: clamp(0.045 * L, 0.3, 0.75) }
    : { type: 'tiller', z: g.stern - 0.11 * L, y: g.deckAt(g.stern) + 0.12, length: 0.2 * L };
  return {
    cabin,
    cockpit: { z0: o.cockpit[0], z1: o.cockpit[1], w: cockpitW },
    foils: o.foils,
    helm,
    outboard: o.outboard ? { x: -Math.min(0.55, 0.45 * g.halfAt(g.stern)), z: g.stern + 0.24 } : null,
    pulpit: true,
    rig: {
      type: o.rig ?? 'sloop', mastZ: o.mastZ, mastBase, mastTop, hounds,
      gooseneck: mastBase + 0.35 + 0.025 * L, boom: o.boom,
      tack: [0, g.deckAt(tackZ) + 0.04, tackZ], jibClew: [0.14 * footLen, footLen],
      shrouds: [[chain, g.deckAt(o.mastZ + 0.1), o.mastZ + 0.1], [-chain, g.deckAt(o.mastZ + 0.1), o.mastZ + 0.1]],
      backstay: [0, g.deckAt(g.stern - 0.05), g.stern - 0.05],
      mizzen: o.mizzen,
    },
  };
}

// ------------------------------------------------------------------ generic types

function sloop(L) {
  const beam = 0.55 * L ** 0.8;
  const fb = 0.35 + 0.09 * L;
  return {
    kind: 'mono', loa: L, beam,
    hulls: [{ loa: L, beam, fbBow: fb, fbStern: 0.78 * fb, draft: 0.08 + 0.04 * L, stemRise: 0.1 * fb, entry: 0.55, transom: 0.8, round: 2.6, spring: 0.012 * L }],
    colors: WHITE_HULL, stripe: [0.14, 0.21], bootTop: 0.04 + 0.006 * L,
    sails: PLAIN_SAILS,
    layout: g => cruiserLayout(g, {
      cabin: [-0.30 * L, 0.06 * L, 0.25 + 0.025 * L], cockpit: [0.10 * L, 0.44 * L],
      mastZ: -0.10 * L, I: 1.12 * L, mastAbove: 0.12 * L, boom: 0.36 * L, tackZ: g.bow + 0.03 * L, jibLP: 1.1,
      foils: [
        { type: 'keel', z0: -0.11 * L, z1: 0.03 * L, top: g.keelAt(-0.04 * L) + 0.05, bottom: -(0.17 * L + 0.1), thick: 0.015 * L, tip: 0.08 * L, sweep: 0.04 * L, bulb: L >= 7 ? { length: 0.12 * L, r: 0.022 * L } : null },
        L >= 8
          ? { type: 'rudder', z0: 0.34 * L, z1: 0.40 * L, top: g.keelAt(0.37 * L) + 0.05, bottom: -(0.12 * L + 0.1), thick: 0.009 * L, tip: 0.04 * L, sweep: 0.012 * L }
          : { type: 'rudder', z0: g.stern + 0.02, z1: g.stern + 0.02 + 0.055 * L, top: 0.6 * fb, bottom: -(0.12 * L), thick: 0.03 },
      ],
      helm: L >= 10 ? 'wheel' : 'tiller', outboard: L < 8,
    }),
  };
}

function ketch(L) {
  const beam = 0.55 * L ** 0.8;
  const fb = 0.35 + 0.09 * L;
  return {
    kind: 'mono', loa: L, beam,
    hulls: [{ loa: L, beam, fbBow: fb, fbStern: 0.8 * fb, draft: 0.12 + 0.05 * L, stemRise: 0.25 * fb, entry: 0.55, transom: 0.62, round: 2.3, spring: 0.025 * L, sternDraft: 0.2 }],
    colors: { ...WHITE_HULL, hull: '#f1ecdf', stripe: '#7a1f1f', bottom: '#5a1a12' }, stripe: [0.12, 0.18], bootTop: 0.04 + 0.006 * L,
    sails: { color: '#f4ecd8' },
    layout: g => {
      const mizZ = 0.30 * L, mizTop = g.deckAt(mizZ) + 0.62 * L;
      const lay = cruiserLayout(g, {
        cabin: [-0.30 * L, 0.04 * L, 0.3 + 0.025 * L], cockpit: [0.08 * L, 0.27 * L],
        mastZ: -0.13 * L, I: 1.1 * L, mastAbove: 0.02 * L, boom: 0.29 * L, tackZ: g.bow + 0.02 * L, jibLP: 1.15,
        foils: [
          { type: 'keel', z0: -0.22 * L, z1: 0.12 * L, top: g.keelAt(-0.05 * L) + 0.05, bottom: -(0.13 * L + 0.25), thick: 0.025 * L, tip: 0.24 * L, sweep: 0.06 * L },
          { type: 'rudder', z0: 0.37 * L, z1: 0.44 * L, top: g.keelAt(0.4 * L) + 0.05, bottom: -(0.12 * L + 0.2), thick: 0.012 * L, tip: 0.06 * L, sweep: 0.01 * L },
        ],
        helm: 'wheel',
        rig: 'ketch',
      });
      lay.rig.mizzen = {
        mastZ: mizZ, mastBase: g.deckAt(mizZ), mastTop: mizTop, gooseneck: g.deckAt(mizZ) + 0.6 + 0.02 * L, boom: 0.19 * L,
        shrouds: [[0.9 * g.halfAt(mizZ), g.deckAt(mizZ), mizZ], [-0.9 * g.halfAt(mizZ), g.deckAt(mizZ), mizZ]],
        backstay: [0, g.deckAt(g.stern - 0.05), g.stern - 0.05],
      };
      lay.rig.backstay = [0, mizTop, mizZ];  // triatic stay to the mizzen masthead
      lay.helm.z = 0.22 * L;
      return lay;
    },
  };
}

function catamaran(L) {
  const beach = L < 8;
  const beam = (beach ? 0.47 : 0.5) * L;
  const hb = (beach ? 0.09 : 0.13) * L, x = beam / 2 - hb / 2;
  const fb = beach ? 0.06 * L + 0.28 : 0.09 * L + 0.3;
  const hull = { loa: L, beam: hb, fbBow: fb, fbStern: 0.85 * fb, draft: beach ? 0.05 * L : 0.05 * L + 0.1, stemRise: 0, entry: 0.5, transom: beach ? 0.4 : 0.7, round: 2.0, bowPow: 1, sternDraft: 0.3 };
  return {
    kind: 'cat', loa: L, beam,
    hulls: [{ ...hull, x: -x }, { ...hull, x }],
    colors: { ...WHITE_HULL, stripe: beach ? null : '#1c3f78', bottom: beach ? '#f6f6f2' : '#1d2f5c', tramp: '#22314f' },
    stripe: [0.14, 0.20], bootTop: beach ? -1 : 0.08,
    lights: beach ? false : undefined,
    sails: PLAIN_SAILS,
    layout: g => {
      const deck = g.sideDeckAt(0);
      const sideRudder = (bottom, spade) => [-x, x].map(hx => spade
        ? { type: 'rudder', x: hx, z0: 0.38 * L, z1: 0.44 * L, top: g.sideKeelAt(0.41 * L) + 0.05, bottom, thick: 0.01 * L, tip: 0.04 * L, sweep: 0.01 * L }
        : { type: 'rudder', x: hx, z0: g.sideStern + 0.02, z1: g.sideStern + 0.02 + 0.05 * L, top: 0.6 * fb, bottom, thick: 0.03 });
      if (beach) {
        const z0 = -0.13 * L, z1 = 0.34 * L, y = deck - 0.05;
        return {
          beams: [{ z: z0, y }, { z: z1, y }],
          tramp: { z0, z1, y },
          foils: sideRudder(-0.11 * L, false),
          rig: {
            type: 'sloop', mastZ: z0, mastBase: y, mastTop: y + 1.58 * L, hounds: y + 1.15 * L, gooseneck: y + 0.45,
            boom: 0.5 * L, tack: [0, y - 0.05, -0.44 * L], jibClew: [0.05 * L, 0.43 * L],
            shrouds: [[x, g.sideDeckAt(z0 + 0.05 * L), z0 + 0.05 * L], [-x, g.sideDeckAt(z0 + 0.05 * L), z0 + 0.05 * L]],
          },
        };
      }
      // Cruising cat: bridge deck with a deckhouse between the hulls.
      const bridge = { z0: -0.30 * L, z1: 0.40 * L, bottom: 0.04 * L + 0.45, top: deck };
      const house = { z0: -0.22 * L, z1: 0.12 * L, top: deck + 0.07 * L + 0.55, w: x - hb * 0.1 };
      const mastZ = -0.15 * L;
      return {
        beams: [{ z: -0.37 * L, y: deck }],
        bridge, house,
        cockpit: { z0: house.z1, z1: bridge.z1, w: x - hb * 0.6, deck: true },
        foils: [
          ...[-x, x].map(hx => ({ type: 'keel', x: hx, z0: -0.06 * L, z1: 0.10 * L, top: g.sideKeelAt(0) + 0.05, bottom: -(0.1 * L + 0.2), thick: 0.012 * L, tip: 0.1 * L, sweep: 0.04 * L })),
          ...sideRudder(-(0.09 * L + 0.2), true),
        ],
        helm: { type: 'wheel', z: house.z1 + 0.03 * L, y: deck, r: clamp(0.035 * L, 0.3, 0.6) },
        rig: {
          type: 'sloop', mastZ, mastBase: house.top, mastTop: deck + 1.4 * L, hounds: deck + 1.25 * L,
          gooseneck: house.top + 0.5, boom: 0.36 * L, tack: [0, deck, -0.37 * L], jibClew: [0.04 * L, 0.24 * L],
          shrouds: [[x - hb * 0.3, deck, mastZ + 0.03 * L], [-(x - hb * 0.3), deck, mastZ + 0.03 * L]],
        },
      };
    },
  };
}

function trimaran(L) {
  const beam = 0.75 * L;
  const fb = 0.08 * L + 0.3;
  const amaBeam = 0.075 * L, amaX = beam / 2 - amaBeam / 2;
  const ama = { loa: 0.78 * L, beam: amaBeam, fbBow: 0.85 * fb, fbStern: 0.7 * fb, draft: 0.025 * L, shift: 0.03 * L, entry: 0.5, transom: 0.35, round: 2.0, bowPow: 1, sternDraft: 0.35 };
  return {
    kind: 'tri', loa: L, beam,
    hulls: [
      { loa: L, beam: 0.17 * L, fbBow: fb, fbStern: 0.8 * fb, draft: 0.05 * L + 0.05, stemRise: 0.02 * L, entry: 0.5, transom: 0.65, round: 2.2, bowPow: 0.9 },
      { ...ama, x: -amaX }, { ...ama, x: amaX },
    ],
    colors: { ...WHITE_HULL, stripe: '#c0392b', tramp: '#22314f' }, stripe: [0.14, 0.20], bootTop: 0.06,
    sails: PLAIN_SAILS,
    layout: g => {
      const z0 = -0.14 * L, z1 = 0.16 * L, y = g.deckAt(0) - 0.05;
      const lay = cruiserLayout(g, {
        cabin: [-0.32 * L, 0.04 * L, 0.2 + 0.03 * L], cockpit: [0.10 * L, 0.42 * L],
        mastZ: -0.12 * L, I: 1.15 * L, mastAbove: 0.1 * L, boom: 0.38 * L, tackZ: g.bow + 0.03 * L, jibLP: 1.0,
        foils: [
          { type: 'board', z0: -0.09 * L, z1: -0.03 * L, top: g.deckAt(-0.06 * L) - 0.1, bottom: -(0.17 * L), thick: 0.01 * L },
          { type: 'rudder', z0: g.stern + 0.02, z1: g.stern + 0.02 + 0.05 * L, top: 0.6 * fb, bottom: -(0.12 * L), thick: 0.03 },
        ],
        helm: L >= 11 ? 'wheel' : 'tiller', outboard: L < 9,
      });
      lay.beams = [{ z: z0, y }, { z: z1, y }];
      lay.tramp = { z0, z1, y, inner: true };  // between the main hull and each float
      lay.rig.shrouds = [[0.82 * amaX, y, lay.rig.mastZ + 0.02 * L], [-0.82 * amaX, y, lay.rig.mastZ + 0.02 * L]];
      lay.rig.backstay = null;
      return lay;
    },
  };
}

// ------------------------------------------------------------------ 2D drawings

function el(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}

const num = v => Math.round(v * 10) / 10;

// Smooth path through points (Catmull-Rom as cubic Béziers), starting with a moveTo
// unless `cont`.
function smoothPath(pts, cont = false) {
  let d = cont ? `L${num(pts[0][0])},${num(pts[0][1])}` : `M${num(pts[0][0])},${num(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${num(c1[0])},${num(c1[1])} ${num(c2[0])},${num(c2[1])} ${num(p2[0])},${num(p2[1])}`;
  }
  return d;
}

// Plan-view outline of one hull at the sheer, in drawing units.
function outline(h, s, inset = 1) {
  const right = h.sections.map(q => [(h.x + q.pts[0][0] * inset) * s, q.z * s]);
  const left = h.sections.map(q => [(h.x - q.pts[0][0] * inset) * s, q.z * s]).reverse();
  return `${smoothPath(right)} ${smoothPath(left, true)} Z`;
}

// Top view for the compass rose, drawn into `g` (heading up, bow at -y), sized
// to fit inside the wind arrows. Returns where the sails pivot, for trimming.
export function drawPlan(boat, g) {
  g.replaceChildren();
  const s = 290 / Math.hypot(boat.loa / 2, boat.beam / 2);  // drawing units per metre
  const P = (x, z) => [num(x * s), num(z * s)];
  const r = boat.rig;

  // Connecting structure of multihulls first, under the hulls.
  if (boat.tramp) {
    const t = boat.tramp;
    const inner = boat.hulls.filter(h => h.x > 0).map(h => h.x - 0.6 * boat.geo.sideHalfAt((t.z0 + t.z1) / 2))[0];
    if (t.inner) {
      const mainEdge = 0.8 * boat.geo.halfAt((t.z0 + t.z1) / 2);
      for (const side of [-1, 1]) {
        const xa = side * mainEdge, xb = side * inner;
        el('rect', { x: num(Math.min(xa, xb) * s), y: num(t.z0 * s), width: num(Math.abs(xb - xa) * s), height: num((t.z1 - t.z0) * s), class: 'tramp' }, g);
      }
    } else {
      el('rect', { x: num(-inner * s), y: num(t.z0 * s), width: num(2 * inner * s), height: num((t.z1 - t.z0) * s), class: 'tramp' }, g);
    }
  }
  if (boat.bridge) {  // tucks under the hulls
    const b = boat.bridge, w = boat.geo.sideX;
    el('rect', { x: num(-w * s), y: num(b.z0 * s), width: num(2 * w * s), height: num((b.z1 - b.z0) * s), class: 'cockpit' }, g);
  }
  for (const b of boat.beams || []) {
    const w = boat.geo.sideX ?? 0;
    el('line', { x1: num(-w * s), y1: num(b.z * s), x2: num(w * s), y2: num(b.z * s), class: 'beam' }, g);
  }

  // Rudders hung on a transom stick out behind it; spade rudders are hidden under the hull.
  const sternOf = f => (f.x ? boat.geo.sideStern : boat.geo.stern);
  for (const f of boat.foils.filter(f => f.type === 'rudder' && f.z0 >= sternOf(f) - 0.05)) {
    const x = f.x ?? 0;
    el('rect', { x: num(x * s - 5), y: num((f.z0 - 0.04) * s), width: 10, height: num((f.z1 - f.z0 + 0.04) * s + 8), rx: 3, class: 'fitting' }, g);
  }
  if (boat.outboard) {
    const o = boat.outboard;
    el('rect', { x: num((o.x - 0.18) * s), y: num((o.z - 0.14) * s), width: num(0.36 * s), height: num(0.4 * s), rx: 7, class: 'outboard' }, g);
  }
  for (const h of boat.hulls) {
    el('path', { d: outline(h, s), class: 'hull' }, g);
    if (boat.kind === 'mono' || h.x === 0) el('path', { d: outline(h, s, 0.9), class: 'deck-edge' }, g);
  }
  if (boat.house) {
    const hz = boat.house;
    el('rect', { x: num(-hz.w * s), y: num(hz.z0 * s), width: num(2 * hz.w * s), height: num((hz.z1 - hz.z0) * s), rx: 12, class: 'cabin' }, g);
  }
  if (boat.cabin) {
    const c = boat.cabin;
    const front = Math.min(c.w0 * 0.6, 0.35);
    el('path', { d: `M${P(-front, c.z0 - 0.02)} C${P(-front * 0.4, c.z0 - 0.08)} ${P(front * 0.4, c.z0 - 0.08)} ${P(front, c.z0 - 0.02)} L${P(c.w1, c.z1)} L${P(-c.w1, c.z1)} Z`, class: 'cabin' }, g);
    const hw = Math.min(c.w1 * 0.55, 0.5), hz = c.z1 - (c.z1 - c.z0) * 0.45;
    el('rect', { x: num(-hw * s), y: num(hz * s), width: num(2 * hw * s), height: num((c.z1 - c.z0) * 0.42 * s), rx: 8, class: 'hatch' }, g);
  }
  if (boat.cockpit && !boat.cockpit.deck) {
    const c = boat.cockpit;
    el('rect', { x: num(-c.w * s), y: num(c.z0 * s), width: num(2 * c.w * s), height: num((c.z1 - c.z0) * s), rx: 14, class: 'cockpit' }, g);
    if (c.w > 0.5) for (const side of [-1, 1]) el('line', { x1: num(side * c.w * 0.6 * s), y1: num(c.z0 * s + 8), x2: num(side * c.w * 0.6 * s), y2: num(c.z1 * s - 8), class: 'bench' }, g);
  }
  const helm = boat.helm;
  if (helm?.type === 'tiller') {
    const end = boat.foils.find(f => f.type === 'rudder' && !f.x);
    const z = end ? (end.z0 + end.z1) / 2 : boat.geo.stern;
    el('line', { x1: 0, y1: num(z * s), x2: 0, y2: num((z - helm.length) * s), class: 'tiller' }, g);
  } else if (helm?.type === 'wheel') {
    el('line', { x1: num(-helm.r * s), y1: num(helm.z * s), x2: num(helm.r * s), y2: num(helm.z * s), class: 'wheel' }, g);
  }
  if (boat.pulpit) {
    const z = boat.geo.bow + 0.06 * boat.loa, w = 0.6 * boat.geo.halfAt(z + 0.05 * boat.loa);
    el('path', { d: `M${P(-w, z + 0.05 * boat.loa)} Q${P(0, boat.geo.bow - 0.01 * boat.loa)} ${P(w, z + 0.05 * boat.loa)}`, class: 'pulpit' }, g);
  }

  // Standing rigging, then sails, then the masts on top.
  const stay = (a, b) => el('line', { x1: num(a[0] * s), y1: num(a[2] * s), x2: num(b[0] * s), y2: num(b[2] * s), class: 'rigging' }, g);
  if (r.tack) stay(r.tack, [0, 0, r.mastZ]);
  for (const c of r.shrouds || []) stay(c, [0, 0, r.mastZ]);
  for (const c of r.mizzen?.shrouds || []) stay(c, [0, 0, r.mizzen.mastZ]);

  const sail = (id, x, z, len) => {
    const grp = el('g', { id, transform: `translate(${num(x * s)},${num(z * s)})` }, g);
    const path = el('path', { class: 'sail', d: `M0,0 Q0,${num(len / 2)} 0,${num(len)} Z` }, grp);
    return { grp, path, x: num(x * s), y: num(z * s), len: num(len) };
  };
  const out = { s };
  if (r.tack) out.jib = sail('jib', 0, r.tack[2], r.jibClew[1] * s);
  if (r.mizzen) {
    out.mizzen = sail('mizzen', 0, r.mizzen.mastZ, r.mizzen.boom * s);
    el('line', { class: 'boom', x1: 0, y1: 0, x2: 0, y2: out.mizzen.len }, out.mizzen.grp);
  }
  out.main = sail('main', 0, r.mastZ, r.boom * s);
  el('line', { class: 'boom', x1: 0, y1: 0, x2: 0, y2: out.main.len }, out.main.grp);
  const mastR = clamp(r.mastTop * 1.4, 7, 12);
  el('circle', { class: 'mast', cx: 0, cy: num(r.mastZ * s), r: mastR }, g);
  if (r.mizzen) el('circle', { class: 'mast', cx: 0, cy: num(r.mizzen.mastZ * s), r: mastR * 0.8 }, g);
  return out;
}

// Stern view for the heel gauge, drawn into `g` (waterline at y = 0, about 230
// units wide; the mast is drawn short to fit).
export function drawStern(boat, g) {
  g.replaceChildren();
  const s = 232 / boat.beam;
  const P = (x, y) => `${num(x * s)},${num(-y * s)}`;
  const r = boat.rig;
  const widest = h => h.sections.reduce((a, b) => (b.pts[0][0] > a.pts[0][0] ? b : a));
  const deckY = boat.kind === 'cat' ? boat.geo.sideDeckAt(0) : boat.geo.deckAt(r.mastZ);

  // Rigging behind the hull, from the chainplates up the (shortened) mast.
  const top = -290;
  for (const c of r.shrouds || []) el('line', { x1: num(c[0] * s), y1: num(-c[1] * s), x2: 0, y2: top, class: 'rigging' }, g);
  // Foils: keel or boards below each hull, rudders behind.
  for (const f of boat.foils) {
    const x = f.x ?? 0, t = Math.max(0.03, f.thick ?? 0.03);
    const y0 = Math.min(f.top, 0.2), y1 = Math.max(f.bottom, -140 / s);
    el('rect', { x: num(x * s - Math.max(5, t * s / 2)), y: num(-y0 * s), width: num(Math.max(10, t * s)), height: num((y0 - y1) * s), rx: 3, class: 'fitting' }, g);
    if (f.bulb && -f.bottom * s < 140) {
      el('ellipse', { cx: num(x * s), cy: num(-f.bottom * s), rx: num(Math.max(8, f.bulb.r * s * 1.4)), ry: num(Math.max(6, f.bulb.r * s)), class: 'fitting' }, g);
    }
  }
  if (boat.bridge) {
    const b = boat.bridge, w = boat.geo.sideX;
    el('rect', { x: num(-w * s), y: num(-b.top * s), width: num(2 * w * s), height: num((b.top - b.bottom) * s), class: 'cabin' }, g);
  }
  if (boat.tramp || boat.beams) {
    const y = boat.tramp?.y ?? boat.beams[0].y;
    const w = boat.geo.sideX;
    el('line', { x1: num(-w * s), y1: num(-y * s), x2: num(w * s), y2: num(-y * s), class: 'beam' }, g);
  }
  for (const h of boat.hulls) {
    const q = widest(h);
    const right = q.pts.map(([x, y]) => P(h.x + x, y));
    const left = q.pts.map(([x, y]) => P(h.x - x, y)).reverse();
    el('path', { d: `M${right.join(' L')} L${left.join(' L')} Z`, class: 'hull' }, g);
  }
  if (boat.cabin) {
    const c = boat.cabin, base = boat.geo.deckAt((c.z0 + c.z1) / 2) - 0.02, w = (c.w0 + c.w1) / 2;
    el('path', { d: `M${P(-w, base)} L${P(-w * 0.86, c.top)} L${P(w * 0.86, c.top)} L${P(w, base)} Z`, class: 'cabin' }, g);
  }
  if (boat.house) {
    const hz = boat.house;
    el('path', { d: `M${P(-hz.w, boat.bridge.top)} L${P(-hz.w * 0.85, hz.top)} L${P(hz.w * 0.85, hz.top)} L${P(hz.w, boat.bridge.top)} Z`, class: 'cabin' }, g);
  }
  el('line', { x1: 0, y1: num(-Math.max(r.mastBase, deckY) * s), x2: 0, y2: top - 10, class: 'mast-line' }, g);
}

// Sets the 2D sails (from drawPlan) to a trim from app.js sailTrim():
// { side: +1 wind from starboard, luffing, main and jib angles in degrees }.
export function trimPlan(plan, { side, luffing, main, jib }) {
  const set = (sail, angle) => {
    if (!sail) return;
    const depth = (luffing ? 0.02 : 0.11) * sail.len;
    sail.grp.setAttribute('transform', `translate(${sail.x},${sail.y}) rotate(${num(angle * side)})`);
    sail.path.setAttribute('d', `M0,0 Q${num(-side * depth)},${num(sail.len / 2)} 0,${sail.len} Z`);
    sail.path.classList.toggle('luffing', luffing);
  };
  set(plan.main, main);
  set(plan.mizzen, main * 0.85);
  set(plan.jib, jib);
}
