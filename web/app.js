'use strict';

// Sailing dashboard front end. Receives the boat state from the Pi as
// Server-Sent Events and animates it at display frame rate.

const KN = 1.943844;  // knots per m/s
const SVGNS = 'http://www.w3.org/2000/svg';
const $ = id => document.getElementById(id);

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

const fin = v => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrap360 = a => ((a % 360) + 360) % 360;
const wrap180 = a => wrap360(a + 180) - 180;
const pad3 = a => String(Math.round(wrap360(a)) % 360).padStart(3, '0');

function svg(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

// Point on a circle; 0 deg is up, angles grow clockwise.
function polar(r, deg) {
  const a = deg * Math.PI / 180;
  return [r * Math.sin(a), -r * Math.cos(a)];
}

function arcPath(r, a0, a1) {
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  return `M${x0},${y0} A${r},${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 > a0 ? 1 : 0} ${x1},${y1}`;
}

function circularMean(degs) {
  let s = 0, c = 0;
  for (const d of degs) {
    s += Math.sin(d * Math.PI / 180);
    c += Math.cos(d * Math.PI / 180);
  }
  return degs.length ? wrap360(Math.atan2(s, c) * 180 / Math.PI) : null;
}

// ------------------------------------------------------------ static drawing

const cardLabels = [];

function buildRose() {
  const ticks = $('compass-ticks');
  for (let d = 0; d < 360; d += 5) {
    const len = d % 30 === 0 ? 22 : d % 10 === 0 ? 14 : 8;
    const [x0, y0] = polar(468, d);
    const [x1, y1] = polar(468 - len, d);
    svg('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: d % 30 === 0 ? 'tick major' : 'tick' }, ticks);
  }
  const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  const labels = $('compass-labels');
  for (let d = 0; d < 360; d += 30) {
    const [x, y] = polar(421, d);  // between the card's inner edge (398) and the ticks (446)
    const t = svg('text', { x, y, class: names[d] ? 'card-label cardinal' : 'card-label' }, labels);
    t.textContent = names[d] || String(d);
    cardLabels.push({ el: t, x, y });
  }

  const rel = $('rel-ticks');
  for (let d = 0; d < 360; d += 10) {
    const len = d % 30 === 0 ? 12 : 7;
    const [x0, y0] = polar(386, d);
    const [x1, y1] = polar(386 - len, d);
    svg('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: 'rel-tick' }, rel);
    if (d % 30 === 0 && d !== 0 && d !== 180) {
      const [x, y] = polar(354, d);
      svg('text', { x, y, class: 'rel-label' }, rel).textContent = String(d > 180 ? 360 - d : d);
    }
  }
  // Close-hauled sectors: red to port, green to starboard
  $('sector-port').setAttribute('d', arcPath(386, -60, -20));
  $('sector-stbd').setAttribute('d', arcPath(386, 20, 60));
}

function buildHeelScale() {
  const g = $('heel-scale');
  const zones = [[0, 15, 'good'], [15, 25, 'high'], [25, 45, 'danger']];
  for (const [a, b, cls] of zones) {
    svg('path', { d: arcPath(306, a, b), class: `heel-zone ${cls}` }, g);
    svg('path', { d: arcPath(306, -b, -a), class: `heel-zone ${cls}` }, g);
  }
  for (let d = -45; d <= 45; d += 5) {
    const major = d % 15 === 0;
    const [x0, y0] = polar(300, d);
    const [x1, y1] = polar(major ? 324 : 314, d);
    svg('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: major ? 'heel-tick major' : 'heel-tick' }, g);
    if (major && d !== 0) {
      const [x, y] = polar(296 - 22, d);
      svg('text', { x, y: y + 7, class: 'heel-label' }, g).textContent = String(Math.abs(d));
    }
  }
}

// ------------------------------------------------------------ settings

const DAMPING = [0.5, 1, 2, 4];  // seconds
let dampIdx = clamp(store.get('damp', 1), 0, DAMPING.length - 1);
const THEMES = [['day', 'Day'], ['dark', 'Dusk'], ['night', 'Night']];
let themeIdx = clamp(store.get('theme', 0), 0, THEMES.length - 1);

function applySettings() {
  $('btn-damp').textContent = `Damp ${DAMPING[dampIdx]}s`;
  document.documentElement.dataset.theme = THEMES[themeIdx][0];
  $('btn-theme').textContent = THEMES[themeIdx][1];
  drawHistory();
  drawSpark();
  themeView3d();
}

$('btn-damp').addEventListener('click', () => {
  dampIdx = (dampIdx + 1) % DAMPING.length;
  store.set('damp', dampIdx);
  applySettings();
});
$('btn-theme').addEventListener('click', () => {
  themeIdx = (themeIdx + 1) % THEMES.length;
  store.set('theme', themeIdx);
  applySettings();
});

// ------------------------------------------------------------ boat

// Which boat is drawn: a catalog entry from boats.js, with a length for the
// generic types. Saved on this tablet.
const boatUi = { lib: null, spec: null, plan: null, choice: store.get('boat', { id: 'potter19' }), timer: 0 };
const boatsReady = import('./boats.js').then(lib => {
  boatUi.lib = lib;
  applyBoat(boatUi.choice);
});

// rebuild3d: false while a length slider is being dragged; the 3D boat is rebuilt
// once it settles, since that takes longer than redrawing the 2D views.
function applyBoat(choice, rebuild3d = true) {
  const lib = boatUi.lib;
  const spec = lib.makeBoat(choice.id, choice.length);
  boatUi.choice = spec.generic ? { id: spec.id, length: spec.loa } : { id: spec.id };
  boatUi.spec = spec;
  store.set('boat', boatUi.choice);
  if (spec.generic) store.set('boatLengths', { ...store.get('boatLengths', {}), [spec.id]: spec.loa });
  boatUi.plan = lib.drawPlan(spec, $('boat'));
  lib.drawStern(spec, $('heel-boat'));
  setSails(sailTrim(sm.awa != null ? wrap180(sm.awa) : 0));
  $('btn-boat').textContent = spec.name;
  document.title = `${spec.name} · Sailing Dashboard`;
  for (const card of document.querySelectorAll('.boat-card')) card.classList.toggle('selected', card.dataset.id === spec.id);
  clearTimeout(boatUi.timer);
  boatUi.timer = setTimeout(() => view3d.view?.setBoat(boatUi.spec), rebuild3d ? 0 : 250);
}

function buildBoatDialog() {
  const { BOATS, GENERIC, makeBoat, fmtLength } = boatUi.lib;
  const card = (id, name, note) => {
    const c = document.createElement('div');
    c.className = 'boat-card';
    c.dataset.id = id;
    c.tabIndex = 0;
    const title = document.createElement('div');
    title.className = 'boat-name';
    title.textContent = name;
    const sub = document.createElement('div');
    sub.className = 'boat-note';
    sub.textContent = note;
    c.append(title, sub);
    return c;
  };
  const named = $('boat-named');
  named.replaceChildren();
  for (const b of BOATS) {
    const c = card(b.id, b.name, `${fmtLength(makeBoat(b.id).loa)} · ${b.note}`);
    c.addEventListener('click', () => applyBoat({ id: b.id }));
    named.appendChild(c);
  }
  const generic = $('boat-generic');
  generic.replaceChildren();
  for (const g of GENERIC) {
    const c = card(g.id, g.name, g.note);
    const lengths = store.get('boatLengths', {});
    const row = document.createElement('label');
    row.className = 'boat-length';
    const slider = document.createElement('input');
    Object.assign(slider, { type: 'range', min: g.min, max: g.max, step: 0.5, value: lengths[g.id] ?? g.length });
    slider.setAttribute('aria-label', `${g.name} length`);
    const out = document.createElement('span');
    out.textContent = fmtLength(Number(slider.value));
    row.append(slider, out);
    c.appendChild(row);
    const choose = settle => applyBoat({ id: g.id, length: Number(slider.value) }, settle);
    slider.addEventListener('input', () => {
      out.textContent = fmtLength(Number(slider.value));
      choose(false);
    });
    slider.addEventListener('change', () => choose(true));
    c.addEventListener('click', e => { if (e.target !== slider) choose(true); });
    generic.appendChild(c);
  }
  for (const c of document.querySelectorAll('.boat-card')) {
    c.classList.toggle('selected', c.dataset.id === boatUi.spec.id);
    c.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); c.click(); } });
  }
}

$('btn-boat').addEventListener('click', async () => {
  await boatsReady;
  buildBoatDialog();
  $('boat-dialog').showModal();
});

// ------------------------------------------------------------ 3D view

const view3d = {
  active: false, view: null, loading: false, follow: store.get('follow', true),
  layers: [], map: store.get('mapLayer', null),
};
const MAP_NAMES = { imagery: 'Satellite', chart: 'Chart' };
const MAP_CREDITS = {
  imagery: 'Imagery: USGS, Maine GeoLibrary, MassGIS',
  chart: 'NOAA chart data · NOT FOR NAVIGATION',
};

function themeView3d() {
  if (!view3d.view) return;
  const css = getComputedStyle(document.documentElement);
  const v = name => css.getPropertyValue(name).trim();
  view3d.view.setTheme({ background: v('--panel'), water: v('--water'), ink: v('--ink') });
}

async function setView(mode3d) {
  view3d.active = mode3d;
  store.set('view', mode3d ? '3d' : '2d');
  $('btn-2d').classList.toggle('active', !mode3d);
  $('btn-3d').classList.toggle('active', mode3d);
  show($('btn-follow'), mode3d);
  showMapControls();
  show($('rose'), !mode3d);
  show($('boat3d'), mode3d);
  if (!mode3d || view3d.view || view3d.loading) return;
  view3d.loading = true;
  try {
    const [{ createBoatView }] = await Promise.all([import('./boat3d.js'), boatsReady]);
    view3d.view = createBoatView($('boat3d'), boatUi.spec);
    view3d.view.setFollow(view3d.follow);
    themeView3d();
    view3d.layers = await view3d.view.mapLayers();
    setMapLayer(view3d.layers.includes(view3d.map) ? view3d.map : null);
  } catch (err) {
    const msg = document.createElement('div');
    msg.className = 'boat3d-msg';
    msg.textContent = `3D view unavailable on this device (${err.message})`;
    $('boat3d').appendChild(msg);
  } finally {
    view3d.loading = false;
  }
}

function setFollow(on) {
  view3d.follow = on;
  store.set('follow', on);
  $('btn-follow').textContent = on ? 'Follow' : 'North up';
  view3d.view?.setFollow(on);
}

function setMapLayer(name) {
  view3d.map = name;
  store.set('mapLayer', name);
  view3d.view?.setMapLayer(name);
  $('btn-map').textContent = `Map: ${name ? MAP_NAMES[name] || name : 'Off'}`;
  $('map-credit').textContent = name ? MAP_CREDITS[name] || '' : '';
  showMapControls();
}

function showMapControls() {
  show($('btn-map'), view3d.active && view3d.layers.length > 0);
  show($('map-credit'), view3d.active && Boolean(view3d.map));
}

$('btn-map').addEventListener('click', () => {
  const options = [null, ...view3d.layers];
  setMapLayer(options[(options.indexOf(view3d.map) + 1) % options.length]);
});
$('btn-2d').addEventListener('click', () => setView(false));
$('btn-3d').addEventListener('click', () => setView(true));
$('btn-follow').addEventListener('click', () => setFollow(!view3d.follow));

// ------------------------------------------------------------ data

// Testing aid: open the page as  ?time=2026-06-21T20:15  to show the sky at that
// local time (append Z for UTC), and add  &speed=60  to run the clock 60x faster.
const testClock = (() => {
  try {
    const q = new URLSearchParams(location.search);
    const start = Date.parse(q.get('time') ?? '');
    if (!Number.isFinite(start)) return null;
    const speed = Number(q.get('speed')) || 1;
    const t0 = performance.now();
    return () => start + (performance.now() - t0) * speed;
  } catch { return null; }
})();

let latest = null;
let latestAt = 0;
let history = [];  // [epoch ms, twd, tws, aws, sog, heel]
let lastHistoryPush = 0;
const gustBuf = [];  // {t, v} wind speed samples, m/s
const heelBuf = [];  // {t, v} abs heel, deg

// Replay of a recording: { session, name, start, end, t, playing, speed, overview }, or null when live.
let replay = null;
let aisEpoch = 0;  // bumped when the data jumps, so the 3D view refetches AIS targets

// Data seconds per real second.
function dataRate() { return replay ? (replay.playing ? replay.speed : 0) : 1; }
// Time of the data being shown (epoch ms): the boat's clock live, the recording's in a replay.
function dataNow() {
  return latest ? latest.t + (performance.now() - latestAt) * dataRate() : Date.now();
}
// Server URL, pointed at the replay session if there is one.
function api(path) {
  return replay ? `${path}${path.includes('?') ? '&' : '?'}session=${replay.session}` : path;
}

async function loadHistory() {
  try {
    const rows = await (await fetch(api('api/history'))).json();
    if (Array.isArray(rows)) history = rows;
    drawHistory();
  } catch { /* keep what we have */ }
}

function onData(d) {
  const now = d.t;
  const w = d.wind;
  const speed = fin(w.tws) ? w.tws : w.aws;
  if (fin(speed)) gustBuf.push({ t: now, v: speed });
  while (gustBuf.length && gustBuf[0].t < now - 120000) gustBuf.shift();
  if (fin(d.att.heel)) heelBuf.push({ t: now, v: Math.abs(d.att.heel) });
  while (heelBuf.length && heelBuf[0].t < now - 60000) heelBuf.shift();

  if (now - lastHistoryPush >= 1000 || now < lastHistoryPush) {
    lastHistoryPush = now;
    history.push([d.t, w.twd, w.tws, w.aws, d.nav.sog, d.att.heel]);
    while (history.length && history[0][0] < now - 30 * 60000) history.shift();
    drawHistory();
  }
}

// Forgets everything derived from earlier data, after switching between live and
// replay or jumping in a replay. A jump keeps showing the last state until the
// new one arrives: without it the 3D view would lose its position, heading and
// time for a moment, and flicker while the slider is dragged.
function resetData({ keepLatest = false } = {}) {
  if (!keepLatest) latest = null;
  history = [];
  lastHistoryPush = 0;
  gustBuf.length = 0;
  heelBuf.length = 0;
  for (const k of Object.keys(sm)) delete sm[k];  // no sweeping from the old values
  avgCache = { t: 0, v: null };
  aisEpoch++;
  drawHistory();
}

let events = null;
function connect() {
  events?.close();
  const es = events = new EventSource(api('events'));
  es.onopen = loadHistory;
  es.onmessage = e => {
    try {
      latest = JSON.parse(e.data);
      latestAt = performance.now();
      onData(latest);
    } catch { /* ignore a malformed message */ }
  };
  es.addEventListener('playback', e => {
    try { if (replay && es === events) Object.assign(replay, JSON.parse(e.data)); } catch { /* ignore */ }
  });
  es.addEventListener('gone', () => {  // the server ended the replay (restarted, or idle too long)
    if (replay && es === events) exitReplay(false);
  });
  // EventSource reconnects by itself after errors.
}

// ------------------------------------------------------------ smoothing

const sm = {};

function smooth(key, target, alpha) {
  if (!fin(target)) return (sm[key] = null);
  sm[key] = sm[key] == null ? target : sm[key] + (target - sm[key]) * alpha;
  return sm[key];
}

// Angles smooth along the shortest way round; result in 0..360.
function smoothAngle(key, target, alpha) {
  if (!fin(target)) return (sm[key] = null);
  sm[key] = sm[key] == null ? wrap360(target) : wrap360(sm[key] + wrap180(target - sm[key]) * alpha);
  return sm[key];
}

// ------------------------------------------------------------ rendering

const els = {
  compass: $('compass'), twdMark: $('twd-mark'), twdAvg: $('twd-avg'), cogMark: $('cog-mark'),
  aw: $('aw-arrow'), tw: $('tw-arrow'), awLetter: $('aw-letter'), twLetter: $('tw-letter'),
  heelBoat: $('heel-boat'), heelText: $('heel-text'), noData: $('no-data'),
};

function show(el, visible) { el.classList.toggle('hidden', !visible); }

// Rough sail trim for an apparent wind angle; shared by the 2D and 3D views.
function sailTrim(awa) {
  const abs = Math.abs(awa);
  const luffing = abs < 28;
  return {
    side: awa >= 0 ? 1 : -1,  // wind from starboard: sails out to port
    luffing,
    main: luffing ? 2 : clamp(4 + (abs - 30) * 0.55, 4, 85),
    jib: luffing ? 3 : clamp(9 + (abs - 30) * 0.4, 9, 60),
  };
}

function setSails(trim) {
  if (boatUi.plan) boatUi.lib.trimPlan(boatUi.plan, trim);
}

function setPill(id, age, warnIf = false) {
  const el = $(id);
  const state = !fin(age) || age >= 5 ? '' : age >= 2 || warnIf ? 'warn' : 'ok';
  el.className = `pill ${state}`;
}

function setTile(id, value, unit, cls = '') {
  const tile = $(id);
  const v = tile.querySelector('.value');
  v.textContent = value ?? '--';
  v.className = `value ${cls}`;
  if (unit !== undefined) {
    const u = tile.querySelector('.unit');
    u.textContent = unit;
    u.className = `unit ${cls}`;
  }
  tile.classList.toggle('stale', value == null);
}

function fmtLatLon(v, pos, neg) {
  if (!fin(v)) return '';
  const a = Math.abs(v);
  const deg = Math.floor(a);
  return `${deg}°${((a - deg) * 60).toFixed(3).padStart(6, '0')}′${v >= 0 ? pos : neg}`;
}

let lastText = 0;
let lastFrame = performance.now();

// Errors are shown in a banner instead of silently stopping the dashboard.
const reported = new Set();
function reportError(where, err) {
  const msg = `${where}: ${err?.message || err}`;
  if (reported.has(msg)) return;
  reported.add(msg);
  console.error(where, err);
  const banner = $('error-banner');
  banner.querySelector('span').textContent = [...reported].join(' | ');
  show(banner, true);
}
window.addEventListener('error', e => reportError('Page error', e.error || e.message));
window.addEventListener('unhandledrejection', e => reportError('Page error', e.reason));
window.addEventListener('dashboard-error', e => reportError(e.detail.where, e.detail.error));
$('error-close').addEventListener('click', () => show($('error-banner'), false));

// Animation loop: schedule the next frame first, so one bad frame can't stop it.
function frame(nowMs) {
  requestAnimationFrame(frame);
  try {
    drawFrame(nowMs);
  } catch (err) {
    reportError('Display', err);
  }
}

function drawFrame(nowMs) {
  const dt = Math.max(0, (nowMs - lastFrame) / 1000);
  lastFrame = nowMs;
  const alpha = 1 - Math.exp(-dt / DAMPING[dampIdx]);
  const d = latest;
  const link = d && nowMs - latestAt < 3000;
  const w = link ? d.wind : {};
  const n = link ? d.nav : {};
  const att = link ? d.att : {};

  const windOk = fin(w.age) && w.age < 5 && fin(w.awa);
  const hdg = smoothAngle('hdg', n.hdg, alpha);
  const awa = smoothAngle('awa', windOk ? w.awa : null, alpha);
  const twa = smoothAngle('twa', w.twa, alpha);
  const twd = smoothAngle('twd', w.twd, alpha);
  const cogOk = fin(n.cog) && fin(n.sog) && n.sog > 0.3;
  const cog = smoothAngle('cog', cogOk ? n.cog : null, alpha);
  const heel = smooth('heel', att.heel, alpha);
  const aws = smooth('aws', windOk ? w.aws : null, alpha);
  const tws = smooth('tws', w.tws, alpha);
  const sog = smooth('sog', n.sog, alpha);
  const vmg = smooth('vmg', n.vmg, alpha);

  // Rose: heading up
  const h = hdg ?? 0;
  els.compass.setAttribute('transform', `rotate(${-h})`);
  for (const l of cardLabels) l.el.setAttribute('transform', `rotate(${h} ${l.x} ${l.y})`);
  show(els.twdMark, twd != null);
  if (twd != null) els.twdMark.setAttribute('transform', `rotate(${twd})`);
  show(els.cogMark, cog != null);
  if (cog != null) els.cogMark.setAttribute('transform', `rotate(${cog})`);
  const avg = twdAverage();
  show(els.twdAvg, avg != null);
  if (avg != null) els.twdAvg.setAttribute('transform', `rotate(${avg})`);

  show(els.aw, awa != null);
  if (awa != null) {
    els.aw.setAttribute('transform', `rotate(${awa})`);
    els.awLetter.setAttribute('transform', `rotate(${-awa} 0 -332)`);
  }
  show(els.tw, twa != null);
  if (twa != null) {
    els.tw.setAttribute('transform', `rotate(${twa})`);
    els.twLetter.setAttribute('transform', `rotate(${-twa} 0 -330)`);
  }
  const trim = sailTrim(awa != null ? wrap180(awa) : 0);
  setSails(trim);
  if (view3d.active && view3d.view) {
    const pitch = smooth('pitch', att.pitch, alpha);
    try {  // a 3D failure must not freeze the instruments
      view3d.view.update({
        hdg, cog, heel, pitch, trim, lat: n.lat, lon: n.lon, sog: n.sog, cogTrue: n.cog,
        utc: testClock && !replay ? testClock()
          : fin(n.utc) ? n.utc + (performance.now() - latestAt) * dataRate() : replay ? dataNow() : null,
        awa: awa != null ? wrap180(awa) : null,
        twa: twa != null ? wrap180(twa) : null,
        ais: { url: api('api/ais'), rate: dataRate(), epoch: aisEpoch },
      });
    } catch (err) {
      reportError('3D view', err);
    }
  }
  if (shotWaiting) {  // the 3D canvas can only be copied straight after it renders
    const gl = view3d.active && view3d.view ? view3d.view.canvas : null;
    shotWaiting(gl ? copyCanvas(gl) : null);
    shotWaiting = null;
  }
  show(els.noData, !link || (awa == null && hdg == null));
  els.noData.textContent = !d ? 'Waiting for data…' : !link ? 'No connection to boat' : 'No sensor data';

  // Heel: positive is starboard side down
  els.heelBoat.setAttribute('transform', `rotate(${heel ?? 0})`);

  if (nowMs - lastText > 250) {
    lastText = nowMs;
    updateText({ d, link, w, n, att, windOk, hdg, awa, twa, twd, cog, heel, aws, tws, sog, vmg });
  }
}

function sideCls(a) { return a > 0.5 ? 'stbd' : a < -0.5 ? 'port' : ''; }

function updateText(v) {
  const { d, link, w, n, att } = v;

  setPill('pill-link', link ? (d.bus.connected ? 0 : 3) : null);
  setPill('pill-wind', w.age);
  setPill('pill-hdg', n.hdgSrc === 'sensor' ? n.hdgAge : n.hdgSrc === 'cog' ? 3 : null);
  setPill('pill-gps', n.gpsAge);
  setPill('pill-att', fin(att.heel) ? att.age : null);

  const awa = v.awa != null ? wrap180(v.awa) : null;
  const twa = v.twa != null ? wrap180(v.twa) : null;
  setTile('t-aws', v.aws != null ? (v.aws * KN).toFixed(1) : null);
  setTile('t-awa', awa != null ? `${Math.round(Math.abs(awa))}°` : null,
    awa == null ? ' ' : awa > 0.5 ? 'STBD' : awa < -0.5 ? 'PORT' : 'HEAD TO WIND', sideCls(awa));
  setTile('t-tws', v.tws != null ? (v.tws * KN).toFixed(1) : null);
  setTile('t-twa', twa != null ? `${Math.round(Math.abs(twa))}°` : null,
    twa == null ? ' ' : twa > 0.5 ? 'STBD' : twa < -0.5 ? 'PORT' : '', sideCls(twa));
  setTile('t-twd', v.twd != null ? `${pad3(v.twd)}°` : null);
  setTile('t-sog', v.sog != null ? (v.sog * KN).toFixed(1) : null);
  setTile('t-cog', v.cog != null ? `${pad3(v.cog)}°` : null);
  setTile('t-vmg', v.vmg != null ? (v.vmg * KN).toFixed(1) : null);
  const gust = gustBuf.length && link ? Math.max(...gustBuf.map(g => g.v)) : null;
  setTile('t-gust', gust != null ? (gust * KN).toFixed(1) : null,
    fin(w.tws) || gust == null ? 'kn · 2 min' : 'kn app · 2 min');

  $('hdg').textContent = v.hdg != null ? `${pad3(v.hdg)}°` : '---°';
  let sub = ' ';
  if (v.hdg != null) {
    const varTxt = n.varKnown ? `var ${Math.abs(n.var).toFixed(1)}°${n.var < 0 ? 'W' : 'E'}` : 'var unknown';
    sub = n.hdgSrc === 'cog' ? 'True · from COG' : `True · ${pad3(n.hdgMag)}°M · ${varTxt}`;
  }
  $('hdg-sub').textContent = sub;

  $('pos-lat').textContent = link ? fmtLatLon(n.lat, 'N', 'S') : '';
  $('pos-lon').textContent = link ? fmtLatLon(n.lon, 'E', 'W') : '';
  $('pos-sats').textContent = link && n.sats >= 0 ? `${n.sats} sats · HDOP ${fin(n.hdop) ? n.hdop.toFixed(1) : '--'}` : '';
  $('rot').textContent = fin(n.rot) && Math.abs(n.rot) >= 3
    ? `Turning ${Math.round(Math.abs(n.rot))}°/min ${n.rot > 0 ? 'stbd' : 'port'}` : '';

  const heel = v.heel;
  els.heelText.textContent = heel == null ? '--'
    : Math.abs(heel) < 0.5 ? '0°' : `${Math.round(Math.abs(heel))}° ${heel > 0 ? 'S' : 'P'}`;
  const heelSrc = att.src === 'imu' ? 'Pi IMU' : att.src === 'n2k' ? 'N2K' : '';
  $('heel-max').textContent = heelBuf.length && link
    ? `· max ${Math.round(Math.max(...heelBuf.map(x => x.v)))}° / 1 min · ${heelSrc}` : '';

  const t = replay ? new Date(dataNow())
    : testClock ? new Date(testClock())
    : link && fin(n.utc) ? new Date(n.utc + (performance.now() - latestAt)) : new Date();
  const time = fmtTime(t);
  const date = t.toLocaleDateString([], { month: 'short', day: 'numeric' });
  $('clock').textContent = replay ? `${date} ${time}` : testClock ? `TEST ${date} ${time}` : time;
  updatePlaybar();
}

function fmtTime(t) {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// Mean true wind direction over the last 10 minutes: the hollow marker on the
// compass card. The live TWD moving away from it shows a lift or header.
let avgCache = { t: 0, v: null };
function twdAverage() {
  const now = dataNow();
  if (now - avgCache.t < 2000) return avgCache.v;
  const recent = history.filter(r => r[0] > now - 600000 && fin(r[1])).map(r => r[1]);
  avgCache = { t: now, v: recent.length >= 60 ? circularMean(recent) : null };
  return avgCache.v;
}

// ------------------------------------------------------------ history chart

function drawHistory() {
  const canvas = $('hist');
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;
  const css = getComputedStyle(document.documentElement);
  const col = name => css.getPropertyValue(name).trim();
  ctx.font = '12px -apple-system, Roboto, sans-serif';

  const now = dataNow(), span = 20 * 60000;
  const pts = history.filter(r => r[0] > now - span);
  const dirs = pts.map(r => r[1]).filter(fin);
  if (dirs.length < 2) {
    ctx.fillStyle = col('--muted');
    ctx.textAlign = 'center';
    ctx.fillText('Collecting true wind…', W / 2, H / 2);
    return;
  }

  const padL = 38, padR = 34, padT = 6, padB = 18;
  const pw = W - padL - padR, ph = H - padT - padB;
  const x = t => padL + pw * (1 - (now - t) / span);
  const mean = circularMean(dirs);
  const range = Math.max(15, Math.ceil(Math.max(...dirs.map(d => Math.abs(wrap180(d - mean)))) * 1.15 / 5) * 5);
  const yDir = d => padT + ph * (0.5 - wrap180(d - mean) / (2 * range));
  const speeds = pts.map(r => r[2]).filter(fin);
  const maxKn = Math.max(10, Math.ceil((Math.max(0, ...speeds) * KN * 1.2) / 5) * 5);
  const ySpd = s => padT + ph * (1 - (s * KN) / maxKn);

  // grid + axes
  ctx.strokeStyle = col('--line');
  ctx.lineWidth = 1;
  ctx.fillStyle = col('--muted');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const k of [-1, 0, 1]) {
    const y = padT + ph * (0.5 - k / 2);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillText(`${pad3(mean + k * range)}°`, padL - 4, y);
  }
  ctx.textAlign = 'left';
  ctx.fillText(`${maxKn}`, W - padR + 4, padT + 6);
  ctx.fillText('0 kn', W - padR + 4, padT + ph - 4);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const m of [20, 15, 10, 5]) ctx.fillText(`-${m}m`, x(now - m * 60000), H - 3);

  // segments split at gaps
  const segments = [];
  let seg = [];
  for (const r of pts) {
    if (seg.length && r[0] - seg[seg.length - 1][0] > 5000) { segments.push(seg); seg = []; }
    seg.push(r);
  }
  segments.push(seg);

  // TWS area
  ctx.fillStyle = col('--tw');
  ctx.globalAlpha = 0.18;
  for (const s of segments) {
    const ok = s.filter(r => fin(r[2]));
    if (ok.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(x(ok[0][0]), ySpd(0));
    for (const r of ok) ctx.lineTo(x(r[0]), ySpd(r[2]));
    ctx.lineTo(x(ok[ok.length - 1][0]), ySpd(0));
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // TWD line
  ctx.strokeStyle = col('--tw');
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  for (const s of segments) {
    ctx.beginPath();
    let pen = false;
    for (const r of s) {
      if (!fin(r[1])) { pen = false; continue; }
      if (pen) ctx.lineTo(x(r[0]), yDir(r[1]));
      else ctx.moveTo(x(r[0]), yDir(r[1]));
      pen = true;
    }
    ctx.stroke();
  }
}

// ------------------------------------------------------------ bus dialog

const MAKERS = {
  229: 'Garmin', 135: 'Airmar', 1857: 'Simrad', 275: 'Navico', 1855: 'Furuno', 137: 'Maretron',
  381: 'B&G', 1851: 'Raymarine', 140: 'Lowrance', 358: 'Victron', 419: 'Fusion', 144: 'Mercury',
  1863: 'Faria', 504: 'Vesper', 1850: 'Teleflex', 273: 'Actisense', 862: 'Yacht Devices', 1858: 'Nobeltec',
};
const CLASSES = {
  10: 'System tools', 20: 'Safety', 25: 'Network', 30: 'Power distribution', 35: 'Power generation',
  40: 'Steering', 50: 'Propulsion', 60: 'Navigation', 70: 'Communication', 75: 'Sensor interface',
  80: 'Instrumentation', 85: 'External environment', 90: 'Internal environment', 100: 'Deck', 120: 'Display',
  125: 'Entertainment',
};
const PGNS = {
  59392: 'ISO ack', 59904: 'ISO request', 60928: 'Address claim', 126208: 'Group function', 126464: 'PGN list',
  126992: 'System time', 126993: 'Heartbeat', 126996: 'Product info', 126998: 'Config info',
  127250: 'Heading', 127251: 'Rate of turn', 127257: 'Attitude', 127258: 'Variation', 128259: 'Speed',
  128267: 'Depth', 129025: 'Position', 129026: 'COG/SOG', 129029: 'GNSS position', 129539: 'GNSS DOPs',
  129540: 'Satellites', 130306: 'Wind', 130310: 'Environment', 130311: 'Environment', 130312: 'Temperature',
  130313: 'Humidity', 130314: 'Pressure', 130316: 'Temperature',
};

let busTimer = null;

function td(text, cls) {
  const c = document.createElement('td');
  c.textContent = text;
  if (cls) c.className = cls;
  return c;
}

async function refreshBus() {
  try {
    const [devices, state] = await Promise.all([
      fetch(api('api/devices')).then(r => r.json()),
      fetch(api('api/state')).then(r => r.json()),
    ]);
    const b = state.bus;
    $('bus-summary').textContent =
      `${b.source} · ${b.connected ? 'connected' : 'NOT CONNECTED'} · ${b.fps} frames/s · ${b.frames} frames total`;
    const rows = $('bus-rows');
    rows.replaceChildren();
    for (const dev of devices) {
      const tr = document.createElement('tr');
      tr.append(
        td(String(dev.src)),
        td([dev.model || '(no product info yet)', dev.sw && `sw ${dev.sw}`].filter(Boolean).join(' · ')),
        td(dev.mfr >= 0 ? MAKERS[dev.mfr] || `#${dev.mfr}` : ''),
        td(dev.cls >= 0 ? CLASSES[dev.cls] || `class ${dev.cls}` : ''),
        td(dev.pgns.map(p => PGNS[p] ? `${p} ${PGNS[p]}` : p).join(', '), 'pgns'),
        td(dev.age < 1 ? 'now' : `${Math.round(dev.age)}s ago`),
      );
      rows.appendChild(tr);
    }
    if (!devices.length) {
      const tr = document.createElement('tr');
      const c = td(replay ? 'No devices in the recording up to this point.'
        : 'No devices heard yet. Check wiring, termination and bitrate (250 kbit/s).');
      c.colSpan = 6;
      tr.appendChild(c);
      rows.appendChild(tr);
    }
  } catch {
    $('bus-summary').textContent = 'Cannot reach the dashboard server.';
  }
}

$('btn-bus').addEventListener('click', () => {
  $('bus-dialog').showModal();
  refreshBus();
  busTimer = setInterval(refreshBus, 2000);
});
$('bus-dialog').addEventListener('close', () => clearInterval(busTimer));

// ------------------------------------------------------------ replay

const SPEEDS = [1, 2, 5, 10, 30, 60];
const scrub = { dragging: false, busy: false, want: null, last: null };

async function post(path) {
  const r = await fetch(path, { method: 'POST' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `server said ${r.status}`);
  return body;
}

async function startReplay(name) {
  const info = await post(`api/playback/open?file=${encodeURIComponent(name)}`);
  if (replay) post(`api/playback/close?session=${replay.session}`).catch(() => {});
  replay = info;
  scrub.last = null;
  store.set('replay', { session: info.session });
  resetData();
  connect();
  show($('playbar'), true);
  show($('pill-replay'), true);
  drawSpark();
  await control({ play: 1 });
}

// Back to the live boat. close: also tell the server (false if it already ended the session).
function exitReplay(close = true) {
  if (!replay) return;
  if (close) post(`api/playback/close?session=${replay.session}`).catch(() => {});
  replay = null;
  store.set('replay', null);
  resetData();
  connect();
  show($('playbar'), false);
  show($('pill-replay'), false);
}

async function control(params) {
  if (!replay) return;
  const q = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  try {
    Object.assign(replay, await post(`api/playback/control?session=${replay.session}&${q}`));
  } catch {
    exitReplay(false);  // the session is gone
    return;
  }
  if ('seek' in params) {  // show the new moment at once instead of at the next update
    resetData({ keepLatest: true });
    try {
      latest = await (await fetch(api('api/state'))).json();
      latestAt = performance.now();
      onData(latest);
    } catch { /* the next update will do */ }
    loadHistory();
  }
  updatePlaybar();
}

// Seeks while the slider is dragged, one request at a time, always to the latest position.
async function seekTo(ms) {
  ms = Math.round(ms);
  if (ms === scrub.last && scrub.want == null) return;  // e.g. the slider's change event after its last input
  scrub.want = ms;
  if (scrub.busy) return;
  scrub.busy = true;
  while (scrub.want != null) {
    const t = scrub.want;
    scrub.want = null;
    scrub.last = t;
    await control({ seek: t });
  }
  scrub.busy = false;
}

function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

function updatePlaybar() {
  if (!replay) return;
  const slider = $('play-slider');
  slider.min = replay.start;
  slider.max = replay.end;
  const t = scrub.dragging ? Number(slider.value) : clamp(latest ? dataNow() : replay.t, replay.start, replay.end);
  if (!scrub.dragging) slider.value = t;
  $('play-time').textContent = fmtTime(t);
  $('play-span').textContent = ` / ${fmtDuration(replay.end - replay.start)}`;
  $('play-toggle').textContent = replay.playing ? '❚❚' : '▶';
  $('play-toggle').setAttribute('aria-label', replay.playing ? 'Pause' : 'Play');
  $('play-speed').textContent = `${replay.speed}×`;
}

// Boat speed through the whole recording, drawn behind the slider to help find the action.
function drawSpark() {
  const canvas = $('play-spark');
  const rect = canvas.getBoundingClientRect();
  if (!replay || !rect.width) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const pts = (replay.overview || []).filter(p => fin(p[1]));
  if (pts.length < 2) return;
  const span = Math.max(1, replay.end - replay.start);
  const top = Math.max(1, ...pts.map(p => p[1]));
  const css = getComputedStyle(document.documentElement);
  ctx.fillStyle = css.getPropertyValue('--tw').trim();
  ctx.globalAlpha = 0.25;
  ctx.beginPath();
  ctx.moveTo(0, rect.height);
  for (const [t, sog] of pts) ctx.lineTo((t - replay.start) / span * rect.width, rect.height * (1 - 0.9 * sog / top));
  ctx.lineTo(rect.width, rect.height);
  ctx.fill();
}

$('play-toggle').addEventListener('click', () => control({ play: replay?.playing ? 0 : 1 }));
$('play-speed').addEventListener('click', () => {
  if (replay) control({ speed: SPEEDS[(SPEEDS.indexOf(replay.speed) + 1) % SPEEDS.length] });
});
$('play-live').addEventListener('click', () => exitReplay());
const slider = $('play-slider');
slider.addEventListener('pointerdown', () => { scrub.dragging = true; });
slider.addEventListener('input', () => {
  scrub.dragging = true;
  updatePlaybar();
  seekTo(Number(slider.value));
});
slider.addEventListener('change', () => {
  seekTo(Number(slider.value)).finally(() => { scrub.dragging = false; });
});
document.addEventListener('keydown', e => {
  if (!replay || e.target.closest?.('input, dialog')) return;
  if (e.key === ' ') {
    e.preventDefault();
    control({ play: replay.playing ? 0 : 1 });
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    const step = (e.shiftKey ? 60000 : 10000) * (e.key === 'ArrowLeft' ? -1 : 1);
    seekTo(clamp(dataNow() + step, replay.start, replay.end));
  }
});
window.addEventListener('resize', drawSpark);

// After a reload, pick the replay up where it was if the server still has it.
async function resumeReplay() {
  const saved = store.get('replay', null);
  if (!saved?.session) return;
  try {
    const r = await fetch(`api/playback/status?session=${saved.session}&overview=1`);
    if (!r.ok) throw new Error();
    replay = { ...(await r.json()), session: saved.session };
    show($('playbar'), true);
    show($('pill-replay'), true);
    drawSpark();
  } catch {
    store.set('replay', null);
  }
}

// ------------------------------------------------------------ recordings dialog

function fmtBytes(n) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} kB`;
}

async function refreshLogs() {
  const rows = $('logs-rows');
  try {
    const { recorder, files } = await (await fetch('api/recordings')).json();
    $('logs-summary').textContent = !recorder.enabled
      ? 'Recording is off. Start the server with --record DIR to log the bus.'
      : `${recorder.active ? `Recording now to ${recorder.file} (${fmtBytes(recorder.bytes)})` : 'Recording: waiting for bus traffic'}` +
        ` · ${fmtBytes(recorder.free)} free on the card`;
    rows.replaceChildren();
    for (const f of files) {
      const tr = document.createElement('tr');
      const start = new Date(f.start), end = new Date(f.end);
      const hm = t => t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      const live = recorder.active && f.name === recorder.file;
      tr.append(
        td(start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })),
        td(`${hm(start)}–${live ? 'now' : hm(end)}`),
        td(fmtDuration(f.end - f.start)),
        td(fmtBytes(f.bytes)),
      );
      const cell = document.createElement('td');
      const actions = document.createElement('div');
      actions.className = 'actions';
      cell.appendChild(actions);
      const play = document.createElement('button');
      play.type = 'button';
      play.textContent = 'Replay';
      play.addEventListener('click', async () => {
        play.disabled = true;
        play.textContent = 'Opening…';
        try {
          await startReplay(f.name);
          $('logs-dialog').close();
        } catch (err) {
          play.textContent = 'Failed';
          reportError('Replay', err);
        }
      });
      const save = document.createElement('a');
      save.href = `recordings/${encodeURIComponent(f.name)}`;
      save.download = f.name;
      save.textContent = 'Download';
      save.className = 'link-button';
      actions.append(play, save);
      tr.appendChild(cell);
      rows.appendChild(tr);
    }
    if (!files.length) {
      const tr = document.createElement('tr');
      const c = td('No recordings yet.');
      c.colSpan = 5;
      tr.appendChild(c);
      rows.appendChild(tr);
    }
  } catch {
    $('logs-summary').textContent = 'Cannot reach the dashboard server.';
  }
}

$('btn-logs').addEventListener('click', () => {
  $('logs-dialog').showModal();
  refreshLogs();
});

// REC pill: shown when the Pi is recording, lit while data is being written.
async function refreshRecorder() {
  try {
    const rec = await (await fetch('api/recorder')).json();
    show($('pill-rec'), rec.enabled);
    $('pill-rec').classList.toggle('on', Boolean(rec.active));
  } catch { /* keep the last state */ }
}
setInterval(refreshRecorder, 5000);

// ------------------------------------------------------------ screenshot

let shotWaiting = null;  // resolved by the next frame with a copy of the 3D canvas (or null)

function copyCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  show(el, true);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => show(el, false), 2500);
}

async function saveScreenshot() {
  const btn = $('btn-shot');
  btn.disabled = true;
  try {
    const gl = await new Promise(resolve => { shotWaiting = resolve; });
    const { capturePage } = await import('./screenshot.js');
    const canvas = await capturePage(document.body, { substitutes: gl ? new Map([[view3d.view.canvas, gl]]) : new Map() });
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('could not encode the image');
    const t = new Date(dataNow());
    const p2 = n => String(n).padStart(2, '0');
    const name = `${boatUi.choice.id}-${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}` +
      `-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}${replay ? '-replay' : ''}.png`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`Saved ${name}`);
  } catch (err) {
    reportError('Screenshot', err);
  } finally {
    btn.disabled = false;
  }
}
$('btn-shot').addEventListener('click', saveScreenshot);

// ------------------------------------------------------------ screen awake

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* needs https on most browsers; set the tablet's screen timeout instead */ }
}
document.addEventListener('click', keepAwake);
document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });

// ------------------------------------------------------------ start

buildRose();
buildHeelScale();
applySettings();
setFollow(view3d.follow);
setView(store.get('view', '2d') === '3d');
window.addEventListener('resize', drawHistory);
refreshRecorder();
resumeReplay().finally(() => {
  connect();
  requestAnimationFrame(frame);
});
