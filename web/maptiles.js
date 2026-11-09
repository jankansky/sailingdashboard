// Offline map tiles (aerial imagery or NOAA chart) laid flat under the 3D boat.
//
// Tiles are standard web-mercator z/x/y tiles served by the Pi from
// tiles/<layer>/<z>/<x>/<y>.<ext>, described by tiles/index.json (written by
// tools/fetch_tiles.py). The boat stays at the scene origin; tiles are placed
// relative to its GPS position, in metres (world axes: +X east, -Z north).

import * as THREE from './vendor/three.module.min.js';

const DEG = Math.PI / 180;
const R = 6378137;
const CIRC = 2 * Math.PI * R;
const MAX_TILES = 420;  // GPU textures kept around
const MAX_LEAVES = 300;  // tiles drawn at once
const MAX_LOADS = 8;  // parallel requests
const QUALITY = 1.0;  // refine until a texel is no bigger than this many screen pixels

function mercator(lat, lon) {
  return [R * lon * DEG, R * Math.log(Math.tan(Math.PI / 4 + lat * DEG / 2))];
}

function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lat = t => Math.atan(Math.sinh(Math.PI * (1 - 2 * t / n))) / DEG;
  return { w: x / n * 360 - 180, e: (x + 1) / n * 360 - 180, n: lat(y), s: lat(y + 1) };
}

// Areas a source has no data for come as pure black (USGS imagery offshore) or
// fully transparent (NOAA charts outside their coverage). Drop those pixels so
// the water shows instead of black squares. Real imagery never gets that dark
// (its darkest water is about 24/255), so 0.005 linear (about 15/255) is safe.
function seeThroughNoData(shader) {
  shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
    if (diffuseColor.a < 0.5 || max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b)) < 0.005) discard;`);
}

export async function loadTileIndex() {
  try {
    const r = await fetch('tiles/index.json', { cache: 'no-cache' });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export class MapTiles {
  constructor(scene, index, maxAnisotropy = 4) {
    this.index = index;
    this.anisotropy = maxAnisotropy;
    this.frustum = new THREE.Frustum();
    this.box = new THREE.Box3();
    this.projScreen = new THREE.Matrix4();
    this.group = new THREE.Group();
    scene.add(this.group);
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.loader = new THREE.TextureLoader();
    this.tiles = new Map();  // "z/x/y" -> tile
    this.missing = new Set();  // URLs that 404'd
    this.queue = [];
    this.loading = 0;
    this.frame = 0;
    this.layer = null;
  }

  setLayer(name) {
    if (name === this.layer) return;
    this.clear();
    this.layer = name && this.index?.layers?.[name] ? name : null;
  }

  clear() {
    for (const t of this.tiles.values()) this.dispose(t);
    this.tiles.clear();
    this.queue.length = 0;
    this.missing.clear();
  }

  // Highest zoom available for a tile, or -1 if no downloaded area touches it.
  maxZoomFor(z, x, y) {
    const b = tileBounds(z, x, y);
    let best = -1;
    for (const a of this.index.layers[this.layer].areas) {
      const [s, w, n, e] = a.bbox;
      if (b.s < n && b.n > s && b.w < e && b.e > w) best = Math.max(best, a.maxzoom);
    }
    return best;
  }

  // Chooses tiles so that each one is drawn at about one texel per screen pixel:
  // full detail near the camera, coarser toward the horizon and off-screen.
  // camera: positioned and looking at the scene; viewportHeight in device pixels.
  update(lat, lon, camera, viewportHeight) {
    this.group.visible = Boolean(this.layer) && Number.isFinite(lat) && Number.isFinite(lon);
    if (!this.group.visible) return;
    const info = this.index.layers[this.layer];
    const frame = ++this.frame;
    const [mx0, my0] = mercator(lat, lon);
    const k = Math.cos(lat * DEG);  // mercator metres -> true metres here
    const cam = camera.position;
    const pixelAngle = camera.fov * DEG / Math.max(1, viewportHeight);
    this.frustum.setFromProjectionMatrix(
      this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));

    const place = (z, x, y) => {
      const size = CIRC / 2 ** z;
      const cx = (-CIRC / 2 + (x + 0.5) * size - mx0) * k;
      const cz = -(CIRC / 2 - (y + 0.5) * size - my0) * k;
      return { cx, cz, half: size * k / 2 };
    };
    const node = (z, x, y) => {
      const top = this.maxZoomFor(z, x, y);
      if (top < 0) return null;
      const p = place(z, x, y);
      // Angular size of one texel, seen from the camera at the tile's nearest point.
      const dx = Math.max(Math.abs(p.cx - cam.x) - p.half, 0);
      const dz = Math.max(Math.abs(p.cz - cam.z) - p.half, 0);
      const dist = Math.max(1, Math.hypot(dx, cam.y, dz));
      const error = (2 * p.half / 256) / dist / pixelAngle;
      this.box.min.set(p.cx - p.half, -1, p.cz - p.half);
      this.box.max.set(p.cx + p.half, 1, p.cz + p.half);
      const visible = this.frustum.intersectsBox(this.box);
      return { z, x, y, top, p, error: visible ? error : 0 };
    };

    // Roots: a coarse level reaching well past the horizon, also drawn underneath
    // everything as a placeholder while finer tiles load.
    const far = Math.min(60000, Math.max(3000, cam.y * 25));
    const rootZ = Math.max(info.minzoom, Math.min(info.maxzoom, Math.floor(Math.log2(CIRC * k / far * 2))));
    const rootSize = CIRC / 2 ** rootZ;
    const rx = Math.floor((mx0 + CIRC / 2) / rootSize), ry = Math.floor((CIRC / 2 - my0) / rootSize);
    const rr = Math.ceil(far / (rootSize * k));
    const roots = [];
    for (let x = rx - rr; x <= rx + rr; x++) {
      for (let y = ry - rr; y <= ry + rr; y++) {
        const n = node(rootZ, x, y);
        if (n) roots.push(n);
      }
    }

    // Refine the worst-looking tile until everything is sharp or the budget is spent.
    let leaves = roots.slice();
    while (leaves.length + 3 <= MAX_LEAVES) {
      let worst = -1;
      for (let i = 0; i < leaves.length; i++) {
        const n = leaves[i];
        if (n.z < n.top && n.error > QUALITY && (worst < 0 || n.error > leaves[worst].error)) worst = i;
      }
      if (worst < 0) break;
      const n = leaves[worst];
      leaves.splice(worst, 1);
      for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const c = node(n.z + 1, n.x * 2 + cx, n.y * 2 + cy);
        if (c) leaves.push(c);
      }
    }

    const draw = (n, order) => {
      const t = this.tile(n.z, n.x, n.y);
      if (!t) return;
      t.used = frame;
      t.mesh.position.set(n.p.cx, -0.02, n.p.cz);
      t.mesh.scale.set(n.p.half * 2, n.p.half * 2, 1);
      t.mesh.renderOrder = order;
    };
    for (const n of roots) draw(n, -40);
    for (const n of leaves) draw(n, -20 + n.z);  // finer tiles on top

    for (const t of this.tiles.values()) t.mesh.visible = t.used === frame && t.loaded;
    if (this.tiles.size > MAX_TILES) {
      const idle = [...this.tiles.values()].filter(t => t.used !== frame).sort((a, b) => a.used - b.used);
      for (const t of idle.slice(0, this.tiles.size - MAX_TILES)) {
        this.dispose(t);
        this.tiles.delete(t.key);
      }
    }
  }

  tile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (t) return t;
    const top = this.maxZoomFor(z, x, y);
    if (top < 0) return null;
    const material = new THREE.MeshBasicMaterial({ depthWrite: false });
    material.onBeforeCompile = seeThroughNoData;
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    this.group.add(mesh);
    t = { key, z, x, y, mesh, material, loaded: false, disposed: false, used: 0 };
    this.tiles.set(key, t);
    // Past the downloaded detail, stretch a lower-zoom tile instead.
    const zs = Math.min(z, top);
    this.load(t, zs, x >> (z - zs), y >> (z - zs));
    return t;
  }

  // Loads tile (z, x, y) into t, or falls back to its parent tiles if missing.
  load(t, z, x, y) {
    const info = this.index.layers[this.layer];
    if (z < info.minzoom || t.disposed) return;
    const url = `tiles/${this.layer}/${z}/${x}/${y}.${info.ext}`;
    const fallback = () => this.load(t, z - 1, x >> 1, y >> 1);
    if (this.missing.has(url)) return fallback();
    this.queue.push({
      t, url,
      ok: tex => {
        if (t.disposed) return tex.dispose();
        const span = 2 ** (t.z - z);  // this texture covers span x span of our tiles
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = this.anisotropy;  // keeps low-angle ground sharp
        tex.repeat.set(1 / span, 1 / span);
        tex.offset.set((t.x - x * span) / span, 1 - (t.y - y * span + 1) / span);
        t.material.map?.dispose();
        t.material.map = tex;
        t.material.needsUpdate = true;
        t.loaded = true;
      },
      fail: () => {
        this.missing.add(url);
        fallback();
      },
    });
    this.pump();
  }

  pump() {
    while (this.loading < MAX_LOADS && this.queue.length) {
      const job = this.queue.shift();
      if (job.t.disposed) continue;
      this.loading++;
      this.loader.load(job.url,
        tex => { this.loading--; job.ok(tex); this.pump(); },
        undefined,
        () => { this.loading--; job.fail(); this.pump(); });
    }
  }

  dispose(t) {
    t.disposed = true;
    t.material.map?.dispose();
    t.material.dispose();
    this.group.remove(t.mesh);
  }
}
