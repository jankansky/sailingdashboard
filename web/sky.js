// Daylight sky with the sun and moon where they really are for the boat's
// position and the GPS time. Rendered as a separate background pass with
// filmic tone mapping (which the scattering model needs), so the boat, water
// and map keep their own untouched colours.

import * as THREE from './vendor/three.module.min.js';
import { Sky } from './skymodel.js';
import { moonIllumination, moonPosition, sunPosition } from './astro.js';

const DEG = Math.PI / 180;

// Sky look, tuned by measuring the shader's output colours (hue, saturation and
// brightness after tone mapping) for clear blue days and red-orange sunsets.
// Day and sunset settings are blended by the sun's altitude.
const DAY = { turbidity: 2, rayleigh: 0.5, mieDirectionalG: 0.8, saturation: 1.8 };
const SUNSET = { turbidity: 3, rayleigh: 4, mieDirectionalG: 0.9, saturation: 2.6 };
const NIGHT_BLUE = [0.10, 0.25, 1.0];
const TWILIGHT_LEVEL = 0.6;  // blue hour, just after sunset
const NIGHT_LEVEL = 0.05;  // dark navy
// Pink-mauve band opposite the sun around sunset; without it that side turns olive-brown.
const BELT = [0.9, 0.4, 0.9];
const BELT_LEVEL = 7;
// Daytime haze: pales the sky near the horizon (0 = none, 1 = grey horizon) and
// fades distant water and land into the horizon colour.
const HAZE = 0.45;
const VISIBILITY_M = 30000;  // good, not perfect, visibility
// FogExp2 fades as exp(-(density * d)^2); this leaves 2% contrast at the visibility distance.
export const HAZE_DENSITY = Math.sqrt(3.912) / VISIBILITY_M;
export const SKY_EXPOSURE = 0.35;
const MOON_SIZE = 0.52 * 2.2 * DEG;  // twice its real size so it reads on a tablet
const MOON_DISTANCE = 20000;

// Unit vector toward a compass bearing and altitude (world: +X east, -Z north).
function direction(azimuth, altitude, out = new THREE.Vector3()) {
  const a = azimuth * DEG, h = altitude * DEG;
  return out.set(Math.cos(h) * Math.sin(a), Math.sin(h), -Math.cos(h) * Math.cos(a));
}

const smooth = (lo, hi, x) => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

// ---- JavaScript mirror of skymodel.js, used to colour the distance haze ----

const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const LUMA = [0.2126, 0.7152, 0.0722];

function acesFilmic(rgb, exposure) {
  const v = rgb.map(c => c * exposure / 0.6);
  const x = [
    0.59719 * v[0] + 0.35458 * v[1] + 0.04823 * v[2],
    0.07600 * v[0] + 0.90834 * v[1] + 0.01566 * v[2],
    0.02840 * v[0] + 0.13383 * v[1] + 0.83777 * v[2],
  ].map(c => (c * (c + 0.0245786) - 0.000090537) / (c * (0.983729 * c + 0.4329510) + 0.238081));
  return [
    1.60475 * x[0] - 0.53108 * x[1] - 0.07367 * x[2],
    -0.10208 * x[0] + 1.10813 * x[1] - 0.00605 * x[2],
    -0.00327 * x[0] - 0.07276 * x[1] + 1.07602 * x[2],
  ].map(c => Math.min(1, Math.max(0, c)));
}

// Displayed (linear) sky colour in direction `dir` for the shader's current uniforms.
function skyColor(dir, sunDir, u, exposure) {
  const g = u.mieDirectionalG.value;
  const sunE = 1000 * Math.max(0, 1 - Math.exp(-((1.6110731556870734 - Math.acos(Math.min(1, Math.max(-1, sunDir.y)))) / 1.5)));
  const betaR = TOTAL_RAYLEIGH.map(t => t * u.rayleigh.value);  // sun fade is 1 for a unit sun vector
  const betaM = MIE_CONST.map(k => 0.434 * (0.2 * u.turbidity.value * 10e-18) * k * u.mieCoefficient.value);
  const zenith = Math.acos(Math.max(0, dir.y));
  const inv = 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - zenith * 180 / Math.PI, -1.253));
  const cosT = dir.dot(sunDir);
  const rPhase = 0.05968310365946075 * (1 + (cosT * 0.5 + 0.5) ** 2);
  const mPhase = 0.07957747154594767 * (1 - g * g) / Math.pow(1 - 2 * g * cosT + g * g, 1.5);
  const sunsetMix = Math.min(1, Math.max(0, Math.pow(1 - sunDir.y, 5)));
  const elevation = Math.asin(Math.min(1, Math.max(-1, dir.y))) * 180 / Math.PI;
  const away = smooth(-0.6, 0.5, -cosT);
  const belt = away * Math.exp(-(((elevation - 8) / 12) ** 2));
  const night = [u.nightSky.value.x, u.nightSky.value.y, u.nightSky.value.z];
  const beltC = [u.beltColor.value.x, u.beltColor.value.y, u.beltColor.value.z];
  let rgb = [0, 1, 2].map(i => {
    const fex = Math.exp(-(betaR[i] * 8.4e3 * inv + betaM[i] * 1.25e3 * inv));
    const ratio = (betaR[i] * rPhase + betaM[i] * mPhase) / (betaR[i] + betaM[i]);
    let lin = Math.pow(sunE * ratio * (1 - fex), 1.5);
    lin *= 1 + (Math.pow(sunE * ratio * fex, 0.5) - 1) * sunsetMix;
    const tex = (lin + night[i]) * 0.04 + [0, 0.0003, 0.00075][i] + beltC[i] * belt * 0.04;
    return Math.pow(tex, 1 / 2.4);
  });
  const luma = c => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
  const l1 = luma(rgb);
  rgb = rgb.map(c => Math.max(0, l1 + (c - l1) * u.saturation.value));
  const hz = u.haze.value * Math.exp(-Math.max(elevation, 0) / 10);
  const l2 = luma(rgb) * 1.05;
  rgb = rgb.map(c => c + (l2 - c) * hz);
  return acesFilmic(rgb, exposure);
}

// Average horizon colour all the way round: the colour distant things fade into.
function horizonColor(sunDir, u, exposure, out) {
  const sum = [0, 0, 0], dir = new THREE.Vector3();
  const N = 16;
  for (let k = 0; k < N; k++) {
    const a = 2 * Math.PI * k / N;
    dir.set(Math.sin(a) * Math.cos(1.5 * DEG), Math.sin(1.5 * DEG), -Math.cos(a) * Math.cos(1.5 * DEG));
    skyColor(dir, sunDir, u, exposure).forEach((c, i) => { sum[i] += c / N; });
  }
  return out.setRGB(sum[0], sum[1], sum[2], THREE.LinearSRGBColorSpace);
}

export { skyColor, horizonColor };

// Moon disc with its lit side toward +X; the sprite is rotated toward the sun.
function drawMoon(ctx, size, fraction) {
  const r = size / 2 - 2;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.fillStyle = 'rgba(200, 205, 220, 0.10)';  // earthshine on the dark part
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, 2 * Math.PI);
  ctx.fill();
  // Lit part: the right half-disc, then back along the terminator ellipse.
  const k = 1 - 2 * fraction;  // terminator's x at the equator, in radii
  ctx.fillStyle = '#f6f2e4';
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
  ctx.ellipse(0, 0, Math.abs(k) * r + 0.01, r, 0, Math.PI / 2, -Math.PI / 2, k > 0);
  ctx.fill();
  ctx.restore();
}

export class SkyDome {
  constructor() {
    this.scene = new THREE.Scene();
    this.sky = new Sky();
    this.sky.scale.setScalar(50000);
    this.sky.material.uniforms.mieCoefficient.value = 0.005;
    this.scene.add(this.sky);

    this.moonCanvas = document.createElement('canvas');
    this.moonCanvas.width = this.moonCanvas.height = 128;
    this.moonTexture = new THREE.CanvasTexture(this.moonCanvas);
    this.moonTexture.colorSpace = THREE.SRGBColorSpace;
    this.moon = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.moonTexture, toneMapped: false, transparent: true, depthTest: false, depthWrite: false,
    }));
    this.moon.scale.setScalar(MOON_DISTANCE * MOON_SIZE);
    this.scene.add(this.moon);

    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.lastFraction = -1;
    this.lastAstro = 0;
    this.lastHaze = -1e15;
    this.hazeColor = new THREE.Color(0xc3ced3);  // distance haze, matched to the horizon
    this.state = { sunAltitude: 45, moonAltitude: -90, moonFraction: 0 };
    this.tmp = new THREE.Vector3();
  }

  // ms: UTC time; lat/lon: boat position. Returns light levels for the scene.
  update(ms, lat, lon, camera) {
    // The sky moves slowly; recompute positions twice a second.
    if (Math.abs(ms - this.lastAstro) > 500) {
      this.lastAstro = ms;
      const sun = sunPosition(ms, lat, lon);
      const moon = moonPosition(ms, lat, lon);
      const ill = moonIllumination(ms);
      direction(sun.azimuth, sun.altitude, this.sunDir);
      direction(moon.azimuth, moon.altitude, this.moonDir);
      this.state = { sunAltitude: sun.altitude, moonAltitude: moon.altitude, moonFraction: ill.fraction };
      if (Math.abs(ill.fraction - this.lastFraction) > 0.002) {
        this.lastFraction = ill.fraction;
        drawMoon(this.moonCanvas.getContext('2d'), this.moonCanvas.width, ill.fraction);
        this.moonTexture.needsUpdate = true;
      }
    }
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(this.sunDir);
    const day = smooth(2, 15, this.state.sunAltitude);
    for (const key of Object.keys(DAY)) u[key].value = SUNSET[key] + (DAY[key] - SUNSET[key]) * day;
    const glow = NIGHT_LEVEL + (TWILIGHT_LEVEL - NIGHT_LEVEL) *
      smooth(-14, -3, this.state.sunAltitude) * (1 - smooth(-1, 4, this.state.sunAltitude));
    u.nightSky.value.set(NIGHT_BLUE[0] * glow, NIGHT_BLUE[1] * glow, NIGHT_BLUE[2] * glow);
    const dusk = BELT_LEVEL * smooth(-5, 0, this.state.sunAltitude) * (1 - smooth(5, 14, this.state.sunAltitude));
    u.beltColor.value.set(BELT[0] * dusk, BELT[1] * dusk, BELT[2] * dusk);
    u.haze.value = HAZE * smooth(5, 20, this.state.sunAltitude);
    if (Math.abs(ms - this.lastHaze) > 1000) {
      this.lastHaze = ms;
      horizonColor(this.sunDir, u, SKY_EXPOSURE, this.hazeColor);
    }
    this.sky.position.copy(camera.position);

    // Moon: far away along its direction, faded by daylight, lit side toward the sun.
    const { sunAltitude, moonAltitude } = this.state;
    this.moon.visible = moonAltitude > -1;
    this.moon.position.copy(camera.position).addScaledVector(this.moonDir, MOON_DISTANCE);
    this.moon.material.opacity = 1 - 0.55 * smooth(-6, 10, sunAltitude);
    const towardSun = this.tmp.copy(this.sunDir).addScaledVector(this.moonDir, -this.sunDir.dot(this.moonDir))
      .transformDirection(camera.matrixWorldInverse);
    this.moon.material.rotation = Math.atan2(towardSun.y, towardSun.x);
    return this.state;
  }
}

export { smooth };
