// Weather view: the last 12 hours of satellite and radar images, and model
// forecasts of wind, weather and waves, for the area around the boat. The Pi
// fetches them (tools/fetch_weather.py) whenever it has internet; this shows
// whatever it has, so the last fetch can still be viewed offline.
//
// One time slider covers both: its left part is the past 12 hours (images),
// the rest is the forecast.

const PAST = [['vis', 'Visible'], ['ir', 'IR'], ['radar', 'Radar']];
const FUTURE = [['wind', 'Wind'], ['gust', 'Gusts'], ['wx', 'Weather'], ['waves', 'Waves']];
const MODELS = [['hrrr', 'HRRR'], ['gfs', 'GFS'], ['ecmwf', 'ECMWF']];
const PAST_MS = 12 * 3600e3;
const SLIDER_MAX = 1000;
const SPLIT = 300;  // slider units for the past; the rest is the forecast
const FIELD_PX = 200;  // forecast fields are interpolated at this size, then scaled up

const KN_STOPS = [[0, '#dceefa'], [5, '#9fd3f5'], [10, '#4fbf6f'], [15, '#b5dd3c'], [20, '#ffd23f'],
  [25, '#ff9a3c'], [30, '#f2453d'], [35, '#c7287f'], [45, '#7b2bb5'], [60, '#3b1670']];
const FT_STOPS = [[0, '#dceefa'], [1, '#9fd3f5'], [2, '#4fbfa0'], [3, '#b5dd3c'], [4, '#ffd23f'],
  [6, '#ff9a3c'], [8, '#f2453d'], [12, '#c7287f'], [16, '#7b2bb5']];
const RAIN_STOPS = [[0.005, '#a6eba0'], [0.02, '#3cc43c'], [0.05, '#1f8f1f'], [0.1, '#f2e13a'],
  [0.25, '#ff9a3c'], [0.5, '#f2453d'], [1, '#c7287f']];
const FT = 3.28084;
const MM_IN = 1 / 25.4;

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};

const R = 6378137;
const merc = (lat, lon) => [lon * Math.PI / 180 * R, Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R];
const unmerc = (x, y) => [(2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI, x / R * 180 / Math.PI];

function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }

// value -> [r, g, b] between colour stops
function colorScale(stops) {
  const s = stops.map(([v, c]) => [v, hexRgb(c)]);
  return v => {
    if (v <= s[0][0]) return s[0][1];
    for (let i = 1; i < s.length; i++) {
      if (v <= s[i][0]) {
        const f = (v - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
        return s[i - 1][1].map((a, k) => a + (s[i][1][k] - a) * f);
      }
    }
    return s[s.length - 1][1];
  };
}
const SCALES = { kn: colorScale(KN_STOPS), ft: colorScale(FT_STOPS), rain: colorScale(RAIN_STOPS) };

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function fmtTime(ms) {
  return new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtAgo(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  const h = Math.floor(m / 60);
  const s = h ? (m % 60 ? `${h} h ${m % 60} min` : `${h} h`) : `${m} min`;
  return ms >= 0 ? `${s} ago` : `in ${s}`;
}

function fmtRun(unix) {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}Z ${d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
}

// opts.boat(): {lat, lon, hdg} or null
export function createWeatherView(container, opts) {
  const root = el('div', 'wx', container);
  const canvas = el('canvas', 'wx-map', root);
  const ctx = canvas.getContext('2d');

  const top = el('div', 'wx-top', root);
  const pastSeg = el('div', 'wx-seg', top);
  const futureSeg = el('div', 'wx-seg', top);
  const modelBtn = el('button', 'wx-model', top);
  modelBtn.type = 'button';
  const info = el('div', 'wx-info', root);
  const timeEl = el('div', 'wx-time', info);
  const subEl = el('div', 'wx-sub', info);
  const legend = el('div', 'wx-legend', root);
  const msg = el('div', 'wx-msg hidden', root);
  const bar = el('div', 'wx-bar', root);
  const playBtn = el('button', 'icon wx-play', bar, '▶');
  playBtn.type = 'button';
  playBtn.setAttribute('aria-label', 'Play');
  const track = el('div', 'wx-track', bar);
  const slider = el('input', 'wx-slider', track);
  Object.assign(slider, { type: 'range', min: 0, max: SLIDER_MAX, step: 1 });
  slider.setAttribute('aria-label', 'Time');
  const ticks = el('div', 'wx-ticks', track);
  const refreshBtn = el('button', 'icon wx-refresh', bar, '↻');
  Object.assign(refreshBtn, { type: 'button', title: 'Fetch new weather now (needs internet on the Pi)' });
  const status = el('div', 'wx-status', root);

  const state = {
    active: false,
    index: null,
    past: store.get('wxPast', 'ir'),
    future: store.get('wxFuture', 'wind'),
    model: store.get('wxModel', 'hrrr'),
    t: null,  // shown time (ms)
    isPast: true,
    playing: false,
    playTimer: 0,
    images: new Map(),  // file -> Image
    forecasts: new Map(),  // file -> data or a promise
    base: null,  // {key, land, coastLight, coastDark}
    theme: { background: '#fff', water: '#cfe2f2', land: '#ece8dc', ink: '#0d1b2a' },
    interp: null,  // per-pixel interpolation of the forecast grid
    fetching: false,
    lastChecked: null,
  };
  const scratch = document.createElement('canvas');
  const field = document.createElement('canvas');
  field.width = field.height = FIELD_PX;

  function buttons(parent, list, current, onPick) {
    parent.replaceChildren();
    for (const [key, label] of list) {
      const b = el('button', key === current ? 'active' : '', parent, label);
      b.type = 'button';
      b.addEventListener('click', () => onPick(key));
    }
  }

  function renderControls() {
    buttons(pastSeg, PAST, state.isPast ? state.past : null, key => {
      state.past = key;
      store.set('wxPast', key);
      showLatestPast();
    });
    buttons(futureSeg, FUTURE, state.isPast ? null : state.future, key => {
      state.future = key;
      store.set('wxFuture', key);
      if (state.isPast) state.t = Date.now();
      showTime(state.isPast ? futureTimes()[0] ?? Date.now() : state.t, false);
    });
    const waves = state.future === 'waves';
    modelBtn.textContent = waves ? 'Wave model' : MODELS.find(m => m[0] === state.model)?.[1] ?? 'HRRR';
    modelBtn.disabled = waves;
    modelBtn.classList.toggle('dim', state.isPast);
  }

  modelBtn.addEventListener('click', () => {
    const i = MODELS.findIndex(m => m[0] === state.model);
    state.model = MODELS[(i + 1) % MODELS.length][0];
    store.set('wxModel', state.model);
    if (state.isPast) showTime(futureTimes()[0] ?? Date.now(), false);
    else showTime(state.t, false);
  });

  // ---------------------------------------------------------------- time

  const pastFrames = () => state.index?.obs?.[state.past] ?? [];
  const dataset = () => (state.future === 'waves' ? 'waves' : state.model);
  const forecastInfo = () => state.index?.forecast?.[dataset()] ?? null;

  function futureTimes() {
    const fc = forecastInfo();
    const data = fc && state.forecasts.get(fc.f);
    if (!data || data instanceof Promise) {
      if (!fc) return [];
      const out = [];
      for (let t = fc.start; t <= fc.end; t += 3600) out.push(t * 1000);
      return out.filter(t => t >= Date.now() - 3600e3);
    }
    return data.t.map(t => t * 1000).filter(t => t >= Date.now() - 3600e3);
  }

  function futureEnd() {
    const fc = forecastInfo();
    return Math.max(Date.now() + 6 * 3600e3, fc ? fc.end * 1000 : 0);
  }

  function valueToTime(v) {
    const now = Date.now();
    if (v <= SPLIT) return now - PAST_MS * (1 - v / SPLIT);
    return now + (v - SPLIT) / (SLIDER_MAX - SPLIT) * (futureEnd() - now);
  }

  function timeToValue(t) {
    const now = Date.now();
    if (t <= now) return Math.max(0, SPLIT * (1 - (now - t) / PAST_MS));
    return SPLIT + (SLIDER_MAX - SPLIT) * Math.min(1, (t - now) / (futureEnd() - now));
  }

  function nearest(list, t) {
    let best = null;
    for (const x of list) if (best == null || Math.abs(x - t) < Math.abs(best - t)) best = x;
    return best;
  }

  function showTime(t, isPast, fromSlider = false) {
    state.isPast = isPast;
    if (isPast) {
      const times = pastFrames().map(f => f.t * 1000);
      state.t = nearest(times, t) ?? t;
    } else {
      state.t = nearest(futureTimes(), t) ?? t;
    }
    if (!fromSlider) slider.value = timeToValue(state.t);
    renderControls();
    draw();
  }

  function showLatestPast() {
    const frames = pastFrames();
    showTime(frames.length ? frames[frames.length - 1].t * 1000 : Date.now() - 60000, true);
  }

  slider.addEventListener('input', () => {
    const v = Number(slider.value);
    stopPlay();
    showTime(valueToTime(v), v <= SPLIT, true);
  });

  function renderTicks() {
    ticks.replaceChildren();
    const now = Date.now();
    const marks = [[now - PAST_MS, '−12h'], [now, 'Now']];
    const end = futureEnd();
    const span = end - now;
    const step = span > 4 * 86400e3 ? 86400e3 : span > 36 * 3600e3 ? 12 * 3600e3 : 6 * 3600e3;
    for (let t = now + step; t < end - step / 3; t += step) {
      const h = Math.round((t - now) / 3600e3);
      marks.push([t, h % 24 === 0 ? `+${h / 24}d` : `+${h}h`]);
    }
    for (const [t, label] of marks) {
      const s = el('span', label === 'Now' ? 'now' : '', ticks, label);
      s.style.left = `${timeToValue(t) / SLIDER_MAX * 100}%`;
    }
  }

  // ---------------------------------------------------------------- play

  function stopPlay() {
    state.playing = false;
    clearInterval(state.playTimer);
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Play');
  }

  function step() {
    if (state.isPast) {
      const times = pastFrames().map(f => f.t * 1000);
      if (!times.length) return;
      const i = times.indexOf(state.t);
      showTime(times[(i + 1) % times.length], true);
    } else {
      const times = futureTimes();
      if (!times.length) return;
      const now = Date.now();
      // Hourly for two days, then every 3 hours.
      let i = times.indexOf(state.t);
      do i = (i + 1) % times.length; while (i > 0 && times[i] - now > 48 * 3600e3 && Math.round((times[i] - now) / 3600e3) % 3);
      showTime(times[i], false);
    }
  }

  playBtn.addEventListener('click', () => {
    if (state.playing) return stopPlay();
    state.playing = true;
    playBtn.textContent = '❚❚';
    playBtn.setAttribute('aria-label', 'Pause');
    state.playTimer = setInterval(step, state.isPast ? 250 : 450);
  });

  // ---------------------------------------------------------------- data

  async function loadIndex() {
    try {
      const r = await fetch('weather/index.json', { cache: 'no-cache' });
      if (r.status === 404) {
        const s = await (await fetch('api/weather')).json().catch(() => ({}));
        state.index = null;
        setMessage(s.enabled ? 'No weather yet. The Pi fetches it when it has internet.'
          : 'Weather is off on the Pi (start it with --weather).');
        return;
      }
      const index = await r.json();
      const changed = JSON.stringify(index) !== JSON.stringify(state.index);
      const frames = pastFrames();
      const atLatest = state.isPast && frames.length && state.t === frames[frames.length - 1].t * 1000;
      state.index = index;
      setMessage(null);
      if (changed) {
        preload();
        if (state.t == null || atLatest) showLatestPast();  // keep showing the newest image
        else showTime(state.t, state.isPast);
      }
      renderStatus();
    } catch {
      setMessage('Weather unavailable (lost the connection to the Pi).');
    }
  }

  function setMessage(text) {
    msg.textContent = text || '';
    msg.classList.toggle('hidden', !text);
    if (text) draw();
  }

  function image(file) {
    let img = state.images.get(file);
    if (!img) {
      img = new Image();
      img.onload = () => { if (state.active) draw(); };
      img.src = `weather/${file}`;
      state.images.set(file, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  function preload() {
    const keep = new Set();
    const ix = state.index;
    for (const f of Object.values(ix.base || {})) keep.add(f);
    for (const f of pastFrames()) keep.add(f.f);
    for (const f of keep) image(f);
    for (const k of state.images.keys()) {
      const live = Object.values(ix.obs || {}).some(list => list.some(f => f.f === k)) || Object.values(ix.base || {}).includes(k);
      if (!live) state.images.delete(k);
    }
    for (const k of state.forecasts.keys()) {
      if (!Object.values(ix.forecast || {}).some(fc => fc.f === k)) state.forecasts.delete(k);
    }
  }

  function forecast() {
    const fc = forecastInfo();
    if (!fc) return null;
    const got = state.forecasts.get(fc.f);
    if (got && !(got instanceof Promise)) return got;
    if (!got) {
      const p = fetch(`weather/${fc.f}`).then(r => r.json()).then(data => {
        state.forecasts.set(fc.f, data);
        if (!state.isPast) showTime(state.t, false);
        renderTicks();
      }).catch(() => state.forecasts.delete(fc.f));
      state.forecasts.set(fc.f, p);
    }
    return null;
  }

  async function refresh() {
    if (state.fetching) return;
    state.fetching = true;
    state.lastChecked = state.index?.checked;
    renderStatus();
    try {
      await fetch('api/weather/refresh', { method: 'POST' });
      for (let i = 0; i < 36 && state.fetching; i++) {
        await new Promise(r => setTimeout(r, 5000));
        await loadIndex();
        if (state.index?.checked !== state.lastChecked) break;
      }
    } finally {
      state.fetching = false;
      renderStatus();
    }
  }
  refreshBtn.addEventListener('click', refresh);

  function renderStatus() {
    const ix = state.index;
    status.classList.remove('stale');
    if (state.fetching) {
      status.textContent = 'Fetching weather…';
      return;
    }
    if (!ix) {
      status.textContent = '';
      return;
    }
    const age = ix.updated ? Date.now() - ix.updated * 1000 : Infinity;
    let text = ix.updated ? `Updated ${fmtAgo(age)}` : 'Never updated';
    if (ix.checked && ix.checked !== ix.updated) text += ` · last try ${fmtAgo(Date.now() - ix.checked * 1000)} failed`;
    if (age > 2 * 3600e3) {
      text += ' · the Pi needs internet for new weather';
      status.classList.add('stale');
    }
    status.textContent = `${text} · ${ix.credits || ''}`;
  }

  // ---------------------------------------------------------------- drawing

  function layout() {
    const w = canvas.width, h = canvas.height;
    const s = Math.min(w, h);
    return { left: (w - s) / 2, top: (h - s) / 2, size: s };
  }

  function toPx(lat, lon, L) {
    const [x0, y0, x1, y1] = state.index.region.bbox;
    const [x, y] = merc(lat, lon);
    return [L.left + (x - x0) / (x1 - x0) * L.size, L.top + (y1 - y) / (y1 - y0) * L.size];
  }

  // Land and water from the basemap, recoloured for the theme; coastline in two colours.
  function base() {
    const ix = state.index;
    const key = `${ix.region.id}|${state.theme.water}|${state.theme.land}`;
    if (state.base?.key === key) return state.base;
    const land = ix.base?.land && image(ix.base.land);
    const coast = ix.base?.coast && image(ix.base.coast);
    if (!land || !coast) return null;
    const recolor = (img, fn) => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < d.data.length; i += 4) fn(d.data, i);
      g.putImageData(d, 0, 0);
      return c;
    };
    const water = hexRgb(state.theme.water), ground = hexRgb(state.theme.land);
    const mask = new Uint8Array(land.naturalWidth * land.naturalHeight);
    const landC = recolor(land, (p, i) => {
      const c = p[i] + p[i + 1] + p[i + 2] < 300 ? ground : water;  // the basemap's land is the darker grey
      p[i] = c[0]; p[i + 1] = c[1]; p[i + 2] = c[2]; p[i + 3] = 255;
    });
    const line = rgb => (p, i) => { p[i] = rgb[0]; p[i + 1] = rgb[1]; p[i + 2] = rgb[2]; };
    state.base = {
      key, land: landC,
      // Land only, to cover the wave model's coarse cells that reach ashore.
      landOnly: recolor(land, (p, i) => {
        const isLand = p[i] + p[i + 1] + p[i + 2] < 300;
        mask[i / 4] = isLand;
        p[i] = ground[0]; p[i + 1] = ground[1]; p[i + 2] = ground[2]; p[i + 3] = isLand ? 255 : 0;
      }),
      isLand(x, y, L) {  // canvas pixel
        const c = Math.floor((x - L.left) / L.size * land.naturalWidth), r = Math.floor((y - L.top) / L.size * land.naturalHeight);
        return mask[r * land.naturalWidth + c] === 1;
      },
      coastLight: recolor(coast, line([255, 214, 0])),
      coastDark: recolor(coast, line(hexRgb(state.theme.ink))),
    };
    return state.base;
  }

  // Satellite IR is dim straight from the server: stretch its contrast, the same for every frame.
  function stretched(img) {
    scratch.width = img.naturalWidth;
    scratch.height = img.naturalHeight;
    const g = scratch.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, scratch.width, scratch.height);
    if (!state.irRange) {
      const hist = new Uint32Array(256);
      for (let i = 0; i < d.data.length; i += 4) hist[d.data[i]]++;
      const n = d.data.length / 4;
      let acc = 0, lo = 0, hi = 255;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc < n * 0.01) lo = v; if (acc < n * 0.995) hi = v; }
      state.irRange = [lo, Math.max(lo + 40, hi)];
    }
    const [lo, hi] = state.irRange;
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = (v - lo) / (hi - lo) * 255;
    for (let i = 0; i < d.data.length; i += 4) {
      d.data[i] = lut[d.data[i]]; d.data[i + 1] = lut[d.data[i + 1]]; d.data[i + 2] = lut[d.data[i + 2]];
    }
    g.putImageData(d, 0, 0);
    return scratch;
  }

  // For each pixel of the field canvas, the four grid points around it and their weights.
  function interp(data) {
    const key = `${state.index.region.id}|${data.lat.length}`;
    if (state.interp?.key === key) return state.interp;
    const [x0, y0, x1, y1] = state.index.region.bbox;
    const nLat = data.lat.length, nLon = data.lon.length;
    const la0 = data.lat[0], la1 = data.lat[nLat - 1], lo0 = data.lon[0], lo1 = data.lon[nLon - 1];
    const n = FIELD_PX * FIELD_PX;
    const idx = new Int32Array(n * 4), w = new Float32Array(n * 4);
    for (let r = 0; r < FIELD_PX; r++) {
      for (let c = 0; c < FIELD_PX; c++) {
        const [lat, lon] = unmerc(x0 + (c + 0.5) / FIELD_PX * (x1 - x0), y1 - (r + 0.5) / FIELD_PX * (y1 - y0));
        const fi = Math.min(nLat - 1.0001, Math.max(0, (lat - la0) / (la1 - la0) * (nLat - 1)));
        const fj = Math.min(nLon - 1.0001, Math.max(0, (lon - lo0) / (lo1 - lo0) * (nLon - 1)));
        const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j;
        const k = (r * FIELD_PX + c) * 4;
        idx[k] = i * nLon + j; idx[k + 1] = i * nLon + j + 1; idx[k + 2] = (i + 1) * nLon + j; idx[k + 3] = (i + 1) * nLon + j + 1;
        w[k] = (1 - a) * (1 - b); w[k + 1] = (1 - a) * b; w[k + 2] = a * (1 - b); w[k + 3] = a * b;
      }
    }
    state.interp = { key, idx, w };
    return state.interp;
  }

  // Interpolated value of row at field pixel p, ignoring missing grid points (land, for waves).
  function sample(row, I, p) {
    let s = 0, ws = 0;
    for (let q = p * 4; q < p * 4 + 4; q++) {
      const v = row[I.idx[q]];
      if (v != null) { s += v * I.w[q]; ws += I.w[q]; }
    }
    return ws > 0.25 ? s / ws : null;
  }

  // Paints a forecast field: color(value) -> [r,g,b] or null, alpha 0..1.
  function paintField(row, I, scaleBy, color, alpha, L) {
    const g = field.getContext('2d');
    const img = g.createImageData(FIELD_PX, FIELD_PX);
    for (let p = 0; p < FIELD_PX * FIELD_PX; p++) {
      const v = sample(row, I, p);
      const c = v == null ? null : color(v * scaleBy);
      if (!c) continue;
      img.data[p * 4] = c[0]; img.data[p * 4 + 1] = c[1]; img.data[p * 4 + 2] = c[2];
      img.data[p * 4 + 3] = (c[3] ?? alpha) * 255;
    }
    g.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(field, L.left, L.top, L.size, L.size);
  }

  function barb(x, y, kn, from, scale) {
    ctx.save();
    ctx.translate(x, y);
    if (kn < 2.5) {
      ctx.beginPath();
      ctx.arc(0, 0, 3 * scale, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.rotate(from * Math.PI / 180);  // staff points up, toward where the wind comes from
    const len = 24 * scale, gap = 4.5 * scale, fl = 9 * scale;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -len);
    let y0 = -len, v = Math.round(kn / 5) * 5;
    while (v >= 50) {  // pennants, on the clockwise side (northern hemisphere)
      ctx.moveTo(0, y0); ctx.lineTo(fl, y0 + gap / 2); ctx.lineTo(0, y0 + gap);
      ctx.fill();
      y0 += gap * 1.3; v -= 50;
    }
    while (v >= 10) { ctx.moveTo(0, y0); ctx.lineTo(fl, y0 - gap); y0 += gap; v -= 10; }
    if (v >= 5) { if (y0 === -len) y0 += gap; ctx.moveTo(0, y0); ctx.lineTo(fl / 2, y0 - gap / 2); }
    ctx.stroke();
    ctx.restore();
  }

  function arrow(x, y, toward, len) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(toward * Math.PI / 180);
    ctx.beginPath();
    ctx.moveTo(0, len / 2); ctx.lineTo(0, -len / 2);
    ctx.moveTo(-len / 4, -len / 4); ctx.lineTo(0, -len / 2); ctx.lineTo(len / 4, -len / 4);
    ctx.stroke();
    ctx.restore();
  }

  // Isobars: marching squares on a finer grid interpolated from the forecast grid.
  function isobars(row, data, L, every = 2) {
    const nLat = data.lat.length, nLon = data.lon.length, k = 4;
    const N = (nLat - 1) * k + 1, M = (nLon - 1) * k + 1;
    const fine = new Float64Array(N * M);
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < M; j++) {
        const fi = Math.min(nLat - 1.0001, i / k), fj = Math.min(nLon - 1.0001, j / k);
        const a = Math.floor(fi), b = Math.floor(fj), u = fi - a, v = fj - b;
        const g = (r, c) => row[r * nLon + c] ?? NaN;
        fine[i * M + j] = g(a, b) * (1 - u) * (1 - v) + g(a, b + 1) * (1 - u) * v + g(a + 1, b) * u * (1 - v) + g(a + 1, b + 1) * u * v;
      }
    }
    let lo = Infinity, hi = -Infinity;
    for (const v of fine) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!Number.isFinite(lo)) return;
    const pt = (i, j) => toPx(data.lat[0] + (data.lat[nLat - 1] - data.lat[0]) * i / (N - 1),
      data.lon[0] + (data.lon[nLon - 1] - data.lon[0]) * j / (M - 1), L);
    ctx.save();
    ctx.strokeStyle = state.theme.ink;
    ctx.fillStyle = state.theme.ink;
    ctx.lineWidth = 1.2 * (devicePixelRatio || 1);
    ctx.font = `${11 * (devicePixelRatio || 1)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let level = Math.ceil(lo / every) * every; level <= hi; level += every) {
      ctx.beginPath();
      let label = null;
      for (let i = 0; i < N - 1; i++) {
        for (let j = 0; j < M - 1; j++) {
          const c = [fine[i * M + j], fine[i * M + j + 1], fine[(i + 1) * M + j + 1], fine[(i + 1) * M + j]];
          if (c.some(v => !Number.isFinite(v))) continue;
          const corners = [[i, j], [i, j + 1], [i + 1, j + 1], [i + 1, j]];
          const cross = [];
          for (let e = 0; e < 4; e++) {
            const a = c[e], b = c[(e + 1) % 4];
            if ((a < level) !== (b < level)) {
              const f = (level - a) / (b - a);
              const [ai, aj] = corners[e], [bi, bj] = corners[(e + 1) % 4];
              cross.push(pt(ai + (bi - ai) * f, aj + (bj - aj) * f));
            }
          }
          for (let q = 0; q + 1 < cross.length; q += 2) {
            ctx.moveTo(...cross[q]);
            ctx.lineTo(...cross[q + 1]);
            if (!label && i > N / 4 && j > M / 4) label = cross[q];
          }
        }
      }
      ctx.stroke();
      if (label) {
        const text = String(level);
        const w = ctx.measureText(text).width + 6;
        ctx.save();
        ctx.fillStyle = state.theme.background;
        ctx.globalAlpha = 0.8;
        ctx.fillRect(label[0] - w / 2, label[1] - 8 * (devicePixelRatio || 1), w, 16 * (devicePixelRatio || 1));
        ctx.restore();
        ctx.fillText(text, label[0], label[1]);
      }
    }
    ctx.restore();
  }

  function drawBoat(L) {
    const b = opts.boat?.();
    if (!b || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return;
    const [x, y] = toPx(b.lat, b.lon, L);
    const s = devicePixelRatio || 1;
    ctx.save();
    ctx.translate(x, y);
    ctx.lineWidth = 2 * s;
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#e07000';
    if (Number.isFinite(b.hdg)) {
      ctx.rotate(b.hdg * Math.PI / 180);
      ctx.beginPath();
      ctx.moveTo(0, -11 * s); ctx.lineTo(7 * s, 8 * s); ctx.lineTo(0, 4 * s); ctx.lineTo(-7 * s, 8 * s);
      ctx.closePath();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, 6 * s, 0, 2 * Math.PI);
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function setLegend(title, stops, unit) {
    legend.replaceChildren();
    if (!title) return legend.classList.add('hidden');
    legend.classList.remove('hidden');
    el('div', 'wx-legend-title', legend, title);
    if (!stops) return;
    // Each stop gets an equal share of the bar; the scales aren't linear (rain spans 0.005 to 1).
    const pos = i => `${i / (stops.length - 1) * 100}%`;
    const barEl = el('div', 'wx-legend-bar', legend);
    barEl.style.background = `linear-gradient(to right, ${stops.map(([, c], i) => `${c} ${pos(i)}`).join(', ')})`;
    const labels = el('div', 'wx-legend-labels', legend);
    stops.forEach(([v], i) => {
      el('span', i === 0 ? 'first' : i === stops.length - 1 ? 'last' : '', labels, String(v).replace(/^0\./, '.'))
        .style.left = pos(i);
    });
    el('span', 'wx-legend-unit', labels, unit);
  }

  function draw() {
    if (!state.active) return;
    const dpr = devicePixelRatio || 1;
    const w = Math.round(root.clientWidth * dpr), h = Math.round(root.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.fillStyle = state.theme.background;
    ctx.fillRect(0, 0, w, h);
    if (!state.index) {
      timeEl.textContent = '';
      subEl.textContent = '';
      setLegend(null);
      return;
    }
    const L = layout();
    const B = base();
    if (B) ctx.drawImage(B.land, L.left, L.top, L.size, L.size);
    let coast = B?.coastDark;

    if (state.isPast) {
      const frame = pastFrames().find(f => f.t * 1000 === state.t);
      const img = frame && image(frame.f);
      const names = { vis: 'GOES-East visible', ir: 'GOES-East infrared (10.3 µm)', radar: 'NEXRAD reflectivity mosaic' };
      if (img) {
        if (state.past === 'radar') ctx.drawImage(img, L.left, L.top, L.size, L.size);
        else {
          ctx.drawImage(state.past === 'ir' ? stretched(img) : img, L.left, L.top, L.size, L.size);
          coast = B?.coastLight;
        }
      }
      timeEl.textContent = frame ? fmtTime(state.t) : 'No images';
      subEl.textContent = frame ? `${fmtAgo(Date.now() - state.t)} · ${names[state.past]}` : 'The Pi has none for this yet';
      setLegend(state.past === 'ir' ? 'Brighter = colder (higher) cloud tops' : state.past === 'vis' ? 'Sunlight reflected; dark at night' : 'Rain and snow echoes');
    } else {
      const fc = forecastInfo();
      const data = forecast();
      const name = fc?.name ?? '';
      timeEl.textContent = fmtTime(state.t);
      subEl.textContent = !fc ? 'No forecast fetched yet'
        : `${state.t > Date.now() + 1800e3 ? `+${Math.round((state.t - Date.now()) / 3600e3)} h` : 'now'} · ${name}${fc.run ? ` ${fmtRun(fc.run)} run` : ''}`;
      const ti = data ? data.t.indexOf(Math.round(state.t / 1000)) : -1;
      if (data && ti >= 0) {
        const I = interp(data);
        const s = dpr;
        const v = data.v;
        if (state.future === 'wind' || state.future === 'gust') {
          const key = state.future === 'wind' ? 'wind' : 'gust';
          paintField(v[key][ti], I, 1, SCALES.kn, 0.85, L);
          ctx.strokeStyle = ctx.fillStyle = state.theme.ink;
          ctx.lineWidth = 1.3 * s;
          data.lat.forEach((lat, i) => data.lon.forEach((lon, j) => {
            const p = i * data.lon.length + j;
            const kn = v[key][ti][p], from = v.dir[ti][p];
            if (kn == null || from == null) return;
            const [x, y] = toPx(lat, lon, L);
            barb(x, y, kn, from, s * Math.min(1, L.size / (data.lon.length * 34 * s)));
          }));
          setLegend(state.future === 'wind' ? '10 m wind (barbs: kn)' : '10 m gusts', KN_STOPS, 'kn');
        } else if (state.future === 'wx') {
          paintField(v.cloud[ti], I, 1, c => (c < 5 ? null : [235, 238, 242, c / 100 * 0.6]), 0.6, L);
          paintField(v.precip[ti], I, MM_IN, r => (r < 0.005 ? null : SCALES.rain(r)), 0.85, L);
          isobars(v.pmsl[ti], data, L);
          setLegend('Precipitation · clouds (white) · isobars every 2 mb', RAIN_STOPS, 'in/h');
        } else {
          paintField(v.wave[ti], I, FT, SCALES.ft, 0.85, L);
          if (B) ctx.drawImage(B.landOnly, L.left, L.top, L.size, L.size);
          ctx.strokeStyle = state.theme.ink;
          ctx.lineWidth = 1.5 * s;
          data.lat.forEach((lat, i) => data.lon.forEach((lon, j) => {
            const p = i * data.lon.length + j;
            if (v.wave[ti][p] == null || v.wdir[ti][p] == null) return;
            const [x, y] = toPx(lat, lon, L);
            if (B?.isLand(x, y, L)) return;
            arrow(x, y, v.wdir[ti][p] + 180, Math.min(18 * s, L.size / data.lon.length * 0.6));
          }));
          setLegend('Significant wave height (arrows: direction of travel)', FT_STOPS, 'ft');
        }
      } else {
        setLegend(null);
      }
    }
    if (coast) ctx.drawImage(coast, L.left, L.top, L.size, L.size);
    drawBoat(L);
  }

  // ---------------------------------------------------------------- lifecycle

  let pollTimer = 0;
  const resize = new ResizeObserver(() => draw());
  resize.observe(root);

  renderControls();

  return {
    setActive(on) {
      state.active = on;
      clearInterval(pollTimer);
      if (!on) return stopPlay();
      loadIndex().then(renderTicks);
      pollTimer = setInterval(() => {
        loadIndex();
        renderTicks();
        renderStatus();
        if (!state.playing) draw();  // the boat moves; "ago" changes
      }, 30000);
      draw();
    },
    setTheme(theme) {
      Object.assign(state.theme, theme);
      draw();
    },
    dispose() {
      stopPlay();
      clearInterval(pollTimer);
      resize.disconnect();
      root.remove();
    },
  };
}
