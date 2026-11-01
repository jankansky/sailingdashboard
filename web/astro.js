// Sun and moon positions for a time and place, accurate to a fraction of a
// degree: plenty for drawing them in the sky. Low-precision formulas from
// Meeus, "Astronomical Algorithms", as popularised by the suncalc library.
//
// Azimuths are compass bearings in degrees (0 = north, 90 = east); altitudes
// are degrees above the horizon, including atmospheric refraction.

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;

const toDays = ms => ms / DAY_MS - 0.5 + J1970 - J2000;

const rightAscension = (l, b) =>
  Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY), Math.cos(l));
const declination = (l, b) =>
  Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l));
const siderealTime = (d, lw) => RAD * (280.16 + 360.9856235 * d) - lw;

function sunCoords(d) {
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

function moonCoords(d) {
  const L = RAD * (218.316 + 13.176396 * d);  // mean longitude
  const M = RAD * (134.963 + 13.064993 * d);  // mean anomaly
  const F = RAD * (93.272 + 13.229350 * d);  // mean distance from the ascending node
  const l = L + RAD * 6.289 * Math.sin(M);
  const b = RAD * 5.128 * Math.sin(F);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: 385001 - 20905 * Math.cos(M) };
}

// Bending of light near the horizon, so the sun sets when it should.
function refraction(h) {
  const a = Math.max(h, 0);
  return 0.0002967 / Math.tan(a + 0.00312536 / (a + 0.08901179));
}

function horizontal(ra, dec, d, lat, lon) {
  const phi = RAD * lat;
  const H = siderealTime(d, RAD * -lon) - ra;
  let alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  alt += refraction(alt);
  // Measured from south toward west, then turned into a compass bearing.
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return { azimuth: (az / RAD + 540) % 360, altitude: alt / RAD };
}

export function sunPosition(ms, lat, lon) {
  const d = toDays(ms);
  const s = sunCoords(d);
  return horizontal(s.ra, s.dec, d, lat, lon);
}

export function moonPosition(ms, lat, lon) {
  const d = toDays(ms);
  const m = moonCoords(d);
  return horizontal(m.ra, m.dec, d, lat, lon);
}

// fraction: 0 new .. 1 full. waxing: true between new and full moon.
export function moonIllumination(ms) {
  const d = toDays(ms);
  const s = sunCoords(d), m = moonCoords(d);
  const SUN_DIST = 149598000;  // km
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) +
    Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(SUN_DIST * Math.sin(phi), m.dist - SUN_DIST * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  return { fraction: (1 + Math.cos(inc)) / 2, waxing: angle < 0 };
}
