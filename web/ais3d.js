// AIS targets in the 3D view: each vessel to scale (enlarged when zoomed out), a
// label, and its predicted track; plus our own predicted track and, for close
// encounters, a line joining both boats at the closest point of approach.
//
// World axes as in boat3d.js: +X east, -Z north, metres, our boat at the origin.

import * as THREE from './vendor/three.module.min.js';

const DEG = Math.PI / 180;
const R = 6378137;
const KN = 1.943844;
const NM = 1852;
const PREDICT_MIN = 10;  // length of the predicted tracks, minutes
const POLL_MS = 2000;
// Below this speed, or reporting at anchor (1), moored (5) or aground (6), a
// target is treated as stationary: no track, no dead reckoning, no motion in the
// CPA. Anchored boats swinging on their rode often report 0.5-1.5 kn of jitter.
const MIN_MOVING_KN = 1.0;
const STATIONARY_STATUS = new Set([1, 5, 6]);

// Closest-approach warning levels.
const DANGER = { cpa: 0.5 * NM, tcpa: 20 * 60 };
const CAUTION = { cpa: 1.0 * NM, tcpa: 30 * 60 };
const COLORS = { normal: 0x2fc46a, caution: 0xffb020, danger: 0xff3b30, own: 0xff8a1f };

function mercator(lat, lon) {
  return [R * lon * DEG, R * Math.log(Math.tan(Math.PI / 4 + lat * DEG / 2))];
}

// Vessel outline pointing toward -Z (bow), 1 unit long and 1 unit wide.
function hullGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, 0.5);
  s.lineTo(0.5, 0.15);
  s.lineTo(0.42, -0.5);
  s.lineTo(-0.42, -0.5);
  s.lineTo(-0.5, 0.15);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);  // shape's +Y (bow) -> -Z, extrusion -> +Y (up)
  return g;
}

function labelTexture(lines, color) {
  const W = 512, H = 40 + 44 * lines.length;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(10, 20, 35, 0.72)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(0, 0, W, H, 18);
  else ctx.rect(0, 0, W, H);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 10, H);
  ctx.textBaseline = 'top';
  lines.forEach((text, i) => {
    ctx.font = i === 0 ? 'bold 38px sans-serif' : '32px sans-serif';
    ctx.fillStyle = i === 0 ? '#ffffff' : '#d8e2ee';
    ctx.fillText(text, 26, 20 + 44 * i);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, aspect: W / H };
}

// Predicted track: one-minute dashes, alternating solid and faint, so the
// track also shows time.
class Track {
  constructor(parent, color) {
    this.group = new THREE.Group();
    this.solid = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, fog: false });
    this.faint = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false, fog: false });
    this.dashes = [];
    for (let i = 0; i < PREDICT_MIN; i++) {
      const m = new THREE.Mesh(Track.geometry, i % 2 ? this.faint : this.solid);
      m.renderOrder = 2;
      this.dashes.push(m);
      this.group.add(m);
    }
    parent.add(this.group);
  }

  // From (x, z) along compass course `cog` (deg) at `sog` (m/s).
  set(x, z, cog, sog, width) {
    this.group.visible = Number.isFinite(cog) && Number.isFinite(sog) && sog > 0.25;
    if (!this.group.visible) return;
    const step = sog * 60;
    const dx = Math.sin(cog * DEG), dz = -Math.cos(cog * DEG);
    this.dashes.forEach((m, i) => {
      m.position.set(x + dx * step * (i + 0.5), 0.15, z + dz * step * (i + 0.5));
      m.rotation.y = -cog * DEG;
      m.scale.set(width, 1, step);
    });
  }

  setColor(color) {
    this.solid.color.setHex(color);
    this.faint.color.setHex(color);
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.solid.dispose();
    this.faint.dispose();
  }
}
Track.geometry = new THREE.BoxGeometry(1, 0.05, 1);

export class AisLayer {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.hull = hullGeometry();
    this.targets = new Map();  // mmsi -> target
    this.own = new Track(this.group, COLORS.own);
    const cpaMat = new THREE.MeshBasicMaterial({ color: COLORS.danger, transparent: true, opacity: 0.85, fog: false });
    this.cpaLines = [];  // reused connector meshes
    this.cpaMat = cpaMat;
    this.lastPoll = -Infinity;
    this.polling = false;
    this.feed = { url: 'api/ais', rate: 1, epoch: 0 };
  }

  async poll() {
    this.polling = true;
    const epoch = this.feed.epoch;
    try {
      const list = await (await fetch(this.feed.url, { cache: 'no-store' })).json();
      if (epoch !== this.feed.epoch) return;  // the replay jumped meanwhile; this list is stale
      const fetched = performance.now();
      const seen = new Set();
      for (const d of list) {
        seen.add(d.mmsi);
        let t = this.targets.get(d.mmsi);
        if (!t) {
          t = this.createTarget();
          this.targets.set(d.mmsi, t);
        }
        t.data = d;
        t.fetched = fetched;
      }
      for (const [mmsi, t] of this.targets) {
        if (!seen.has(mmsi)) {
          this.removeTarget(t);
          this.targets.delete(mmsi);
        }
      }
    } catch {
      // Server unreachable: keep showing what we have.
    } finally {
      this.polling = false;
    }
  }

  createTarget() {
    const material = new THREE.MeshStandardMaterial({ color: COLORS.normal, roughness: 0.6, flatShading: true });
    const mesh = new THREE.Mesh(this.hull, material);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, fog: false }));
    label.renderOrder = 10;
    const t = { mesh, material, label, track: new Track(this.group, COLORS.normal), text: '', level: 'normal' };
    this.group.add(mesh, label);
    return t;
  }

  removeTarget(t) {
    this.group.remove(t.mesh, t.label);
    t.material.dispose();
    t.label.material.map?.dispose();
    t.label.material.dispose();
    t.track.dispose();
  }

  // own: { lat, lon, sog (m/s), cog (deg true) }
  // feed: { url, rate (data seconds per real second; 0 when a replay is paused),
  //         epoch (changes when a replay jumps, to fetch again at once) }
  update(own, cameraDistance, feed = this.feed) {
    const now = performance.now();
    if (feed.epoch !== this.feed.epoch || feed.url !== this.feed.url) this.lastPoll = -Infinity;
    if (feed.rate !== this.feed.rate) {  // keep dead reckoning continuous across a speed change
      for (const t of this.targets.values()) {
        t.data.age += (now - t.fetched) / 1000 * this.feed.rate;
        t.fetched = now;
      }
    }
    this.feed = feed;
    if (!this.polling && now - this.lastPoll > POLL_MS / Math.max(1, Math.min(feed.rate, 5))) {
      this.lastPoll = now;
      this.poll();
    }
    this.group.visible = Number.isFinite(own.lat) && Number.isFinite(own.lon);
    if (!this.group.visible) return;

    const [mx0, my0] = mercator(own.lat, own.lon);
    const k = Math.cos(own.lat * DEG);
    const width = Math.max(1, cameraDistance * 0.004);
    const ownSog = Number.isFinite(own.sog) ? own.sog : 0;
    const ownCog = Number.isFinite(own.cog) ? own.cog : 0;
    const ownV = [ownSog * Math.sin(ownCog * DEG), ownSog * Math.cos(ownCog * DEG)];  // east, north
    this.own.set(0, 0, own.cog, own.sog, width);
    let cpaUsed = 0;

    for (const t of this.targets.values()) {
      const d = t.data;
      // Dead-reckon from the last report so targets glide between updates.
      const dt = d.age + (now - t.fetched) / 1000 * this.feed.rate;
      const moving = Number.isFinite(d.sog) && d.sog * KN >= MIN_MOVING_KN && Number.isFinite(d.cog) &&
        !STATIONARY_STATUS.has(d.nav);
      const sog = moving ? d.sog : 0;
      const cog = moving ? d.cog : null;
      const v = cog == null ? [0, 0] : [sog * Math.sin(cog * DEG), sog * Math.cos(cog * DEG)];
      const [mx, my] = mercator(d.lat, d.lon);
      const east = (mx - mx0) * k + v[0] * dt;
      const north = (my - my0) * k + v[1] * dt;

      // Closest point of approach, from relative position and velocity.
      const rv = [v[0] - ownV[0], v[1] - ownV[1]];
      const rv2 = rv[0] ** 2 + rv[1] ** 2;
      const tcpa = rv2 > 1e-6 ? -(east * rv[0] + north * rv[1]) / rv2 : 0;
      const cpa = Math.hypot(east + rv[0] * Math.max(tcpa, 0), north + rv[1] * Math.max(tcpa, 0));
      const range = Math.hypot(east, north);
      // Warn only when the two boats are actually closing; two stationary boats
      // (an anchorage, a mooring field) are not a collision risk.
      const closing = rv2 > (0.5 / KN) ** 2 && tcpa > 0;
      const level = closing && cpa < DANGER.cpa && tcpa < DANGER.tcpa ? 'danger'
        : closing && cpa < CAUTION.cpa && tcpa < CAUTION.tcpa ? 'caution' : 'normal';

      // Vessel, to scale but never smaller than a readable marker.
      const length = Number.isFinite(d.len) && d.len > 0 ? d.len : d.cls === 'A' ? 30 : 10;
      const beam = Number.isFinite(d.beam) && d.beam > 0 ? d.beam : length / 3.5;
      const grow = Math.max(1, cameraDistance * 0.035 / length);
      const heading = Number.isFinite(d.hdg) ? d.hdg : Number.isFinite(d.cog) ? d.cog : 0;
      t.mesh.position.set(east, 0, -north);
      t.mesh.rotation.y = -heading * DEG;
      t.mesh.scale.set(beam * grow, Math.max(1.5, length * 0.12) * grow, length * grow);
      if (level !== t.level) {
        t.level = level;
        t.material.color.setHex(COLORS[level]);
        t.track.setColor(COLORS[level]);
      }
      t.track.set(east, -north, cog, sog, width);  // hidden when stationary (sog 0)

      // Label: name, speed and range, plus closest approach when it matters.
      const status = { 1: 'at anchor', 5: 'moored', 6: 'aground' }[d.nav];
      const speed = moving ? `${(sog * KN).toFixed(1)} kn` : status ?? 'stationary';
      const lines = [d.name || `MMSI ${d.mmsi}`, `${speed} · ${(range / NM).toFixed(2)} nm`];
      if (tcpa > 0 && tcpa < CAUTION.tcpa * 2) {
        lines.push(`CPA ${(cpa / NM).toFixed(2)} nm in ${Math.round(tcpa / 60)} min`);
      }
      const text = lines.join('|') + level;
      if (text !== t.text) {
        t.text = text;
        t.label.material.map?.dispose();
        const { tex, aspect } = labelTexture(lines, '#' + COLORS[level].toString(16).padStart(6, '0'));
        t.label.material.map = tex;
        t.label.material.needsUpdate = true;
        t.aspect = aspect;
      }
      // Constant size on screen: about 2% of the view height per line.
      const labelHeight = cameraDistance * 0.02 * lines.length;
      t.label.scale.set(labelHeight * t.aspect, labelHeight, 1);
      t.label.position.set(east, Math.max(1.5, length * 0.12) * grow + labelHeight * 0.75, -north);

      // Close encounter: join where both boats will be at the closest approach,
      // only when that's within the drawn tracks so the line meets their dashes.
      // (Further ahead, the red colour and the label give the warning.)
      if (level === 'danger' && tcpa > 0 && tcpa <= PREDICT_MIN * 60) {
        const line = this.cpaLines[cpaUsed] ?? this.makeCpaLine();
        cpaUsed++;
        const ax = ownV[0] * tcpa, az = -ownV[1] * tcpa;
        const bx = east + v[0] * tcpa, bz = -(north + v[1] * tcpa);
        const len = Math.hypot(bx - ax, bz - az);
        line.visible = true;
        line.position.set((ax + bx) / 2, 0.2, (az + bz) / 2);
        line.rotation.y = Math.atan2(bx - ax, bz - az);
        line.scale.set(width * 0.6, 1, Math.max(len, 0.1));
      }
    }
    for (let i = cpaUsed; i < this.cpaLines.length; i++) this.cpaLines[i].visible = false;
  }

  makeCpaLine() {
    const m = new THREE.Mesh(Track.geometry, this.cpaMat);
    m.renderOrder = 3;
    this.group.add(m);
    this.cpaLines.push(m);
    return m;
  }
}
