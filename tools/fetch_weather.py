#!/usr/bin/env python3
"""Fetches weather around the boat for the dashboard's Weather view.

The dashboard server runs this every 15 minutes (see --weather in main.cpp). It
needs internet only while it runs: everything is saved, so the last fetch can
still be viewed offline on the water.

Past 12 hours, as images rather than analyses (NOAA nowCOAST, 5-minute steps):
  vis    GOES-East visible
  ir     GOES-East longwave infrared
  radar  NEXRAD base reflectivity mosaic (quality-controlled)
nowCOAST keeps about 8 hours, so the full 12 builds up as the Pi stays online.

Forecasts, as grids around the boat (Open-Meteo, free for non-commercial use):
  hrrr, gfs, ecmwf  10 m wind and gusts, precipitation, cloud cover, sea-level pressure
  waves             significant wave height, direction and period (Open-Meteo marine)
Forecasts are refreshed every 3 hours, to stay well inside Open-Meteo's free limits.

Usage (needs only Python 3):
  python3 tools/fetch_weather.py --out weather --at 43.76,-70.16
  python3 tools/fetch_weather.py --out weather --state http://127.0.0.1:8080/api/state
Writes OUT/index.json, which names the image and forecast files written beside it.
"""

import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

USER_AGENT = "sailing-dashboard weather fetch (personal use)"
HALF_WIDTH_DEG = 1.4  # region: 2.8 degrees of longitude (about 220 km) centred on the boat
IMAGE_PX = 720
GRID = 16  # forecast points per side
HISTORY_S = 12 * 3600
STEP_S = 15 * 60  # one frame per 15 minutes
FORECAST_EVERY_S = 3 * 3600
RECENTRE = 0.3  # move the region when the boat is this far (of the half width) from its centre

NOWCOAST = "https://nowcoast.noaa.gov/geoserver"
OBS = {
    # key: (workspace, layer, format)
    "vis": ("satellite", "goes_visible_imagery", "jpg"),
    "ir": ("satellite", "goes_longwave_imagery", "jpg"),
    "radar": ("weather_radar", "conus_base_reflectivity_mosaic", "png"),
}
GIBS = "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi"
MODELS = {
    # key: (name, Open-Meteo model, days, model whose run time is shown)
    "hrrr": ("HRRR", "ncep_hrrr_conus", 3, "ncep_hrrr_conus"),
    "gfs": ("GFS", "gfs_seamless", 7, "ncep_gfs013"),
    "ecmwf": ("ECMWF", "ecmwf_ifs025", 7, "ecmwf_ifs025"),
}
MODEL_VARS = {
    "wind": "wind_speed_10m", "dir": "wind_direction_10m", "gust": "wind_gusts_10m",
    "precip": "precipitation", "cloud": "cloud_cover", "pmsl": "pressure_msl",
}
WAVE_VARS = {"wave": "wave_height", "wdir": "wave_direction", "period": "wave_period"}
CREDITS = "GOES-East and NEXRAD via NOAA nowCOAST · forecasts: Open-Meteo · basemap: NASA GIBS, OpenStreetMap"


def log(*a):
    print("weather:", *a, flush=True)


RETRY_WAITS = (5, 20)  # seconds before the 2nd and 3rd tries


def get(url, timeout=60, waits=RETRY_WAITS):
    """Downloads url. Retries server hiccups: nowCOAST answers 502 Bad Gateway
    now and then for a few seconds."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for wait in (*waits, None):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if wait is None or not (e.code == 429 or e.code >= 500):
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if wait is None:
                raise
        time.sleep(wait)


def write_atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def merc(lat, lon):
    x = math.radians(lon) * 6378137
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * 6378137
    return x, y


def unmerc(x, y):
    return math.degrees(2 * math.atan(math.exp(y / 6378137)) - math.pi / 2), math.degrees(x / 6378137)


def make_region(lat, lon):
    x0, _ = merc(lat, lon - HALF_WIDTH_DEG)
    x1, yc = merc(lat, lon + HALF_WIDTH_DEG)
    half = (x1 - x0) / 2
    bbox = [x0, yc - half, x1, yc + half]
    s, w = unmerc(bbox[0], bbox[1])
    n, e = unmerc(bbox[2], bbox[3])
    rid = hashlib.sha1(("%.4f,%.4f" % (lat, lon)).encode()).hexdigest()[:8]
    return {"id": rid, "center": [round(lat, 4), round(lon, 4)], "bbox": [round(v, 1) for v in bbox],
            "ll": [round(s, 4), round(w, 4), round(n, 4), round(e, 4)], "size": IMAGE_PX}


def boat_position(args, previous):
    if args.at:
        lat, lon = (float(v) for v in args.at.split(","))
        return lat, lon
    if args.state:
        try:
            nav = json.loads(get(args.state, timeout=5, waits=())).get("nav", {})
            if nav.get("lat") is not None and nav.get("lon") is not None:
                return nav["lat"], nav["lon"]
        except Exception as e:
            log("no position from", args.state, e)
    if previous:
        return tuple(previous["center"])
    if args.home:
        lat, lon = (float(v) for v in args.home.split(","))
        return lat, lon
    return None


def far_from(region, lat, lon):
    x, y = merc(lat, lon)
    b = region["bbox"]
    half = (b[2] - b[0]) / 2
    return max(abs(x - (b[0] + b[2]) / 2), abs(y - (b[1] + b[3]) / 2)) > RECENTRE * half


def wms_url(base, layer, bbox, fmt, time_iso=None, transparent=False, version="1.3.0"):
    q = {
        "SERVICE": "WMS", "REQUEST": "GetMap", "VERSION": version, "LAYERS": layer, "STYLES": "",
        ("CRS" if version == "1.3.0" else "SRS"): "EPSG:3857",
        "BBOX": ",".join("%.1f" % v for v in bbox), "WIDTH": IMAGE_PX, "HEIGHT": IMAGE_PX,
        "FORMAT": "image/jpeg" if fmt == "jpg" else "image/png",
    }
    if transparent:
        q["TRANSPARENT"] = "true"
    if time_iso:
        q["TIME"] = time_iso
    return base + "?" + urllib.parse.urlencode(q)


_capabilities = {}


def layer_times(workspace, layer):
    """Times nowCOAST has for a layer, as unix seconds."""
    if workspace not in _capabilities:  # vis and ir share one
        _capabilities[workspace] = get("%s/%s/wms?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0" % (NOWCOAST, workspace))
    xml = _capabilities[workspace]
    ns = {"w": "http://www.opengis.net/wms"}
    for el in ET.fromstring(xml).iter("{http://www.opengis.net/wms}Layer"):
        name = el.find("w:Name", ns)
        if name is None or name.text not in (layer, "%s:%s" % (workspace, layer)):
            continue
        dim = el.find("w:Dimension[@name='time']", ns)
        if dim is None or not dim.text:
            return []
        out = []
        for t in dim.text.split(","):
            try:
                out.append(int(datetime.fromisoformat(t.strip().replace("Z", "+00:00")).timestamp()))
            except ValueError:
                pass
        return sorted(out)
    return []


def pick_frames(times, now):
    """The available time nearest each 15-minute mark of the last 12 hours."""
    picked = []
    mark = (now - HISTORY_S) // STEP_S * STEP_S + STEP_S
    while mark <= now:
        near = min(times, key=lambda t: abs(t - mark), default=None)
        if near is not None and abs(near - mark) <= 5 * 60 and near not in picked:
            picked.append(near)
        mark += STEP_S
    if times and times[-1] > now - 30 * 60 and times[-1] not in picked:
        picked.append(times[-1])  # the newest image, whenever it is
    return picked


def fetch_obs(out, region, old, now, errors):
    result = {}
    jobs = []
    for key, (ws, layer, fmt) in OBS.items():
        kept = [f for f in old.get(key, []) if f["t"] > now - HISTORY_S and os.path.exists(os.path.join(out, f["f"]))]
        try:
            times = layer_times(ws, layer)
        except Exception as e:
            errors.append("%s: %s" % (key, e))
            times = []
        have = {f["t"] for f in kept}
        for t in pick_frames(times, now):
            if t in have:
                continue
            name = "%s-%s-%s.%s" % (region["id"], key, time.strftime("%Y%m%d%H%M", time.gmtime(t)), fmt)
            iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
            url = wms_url("%s/%s/wms" % (NOWCOAST, ws), layer, region["bbox"], fmt, iso, transparent=fmt == "png")
            jobs.append((key, t, name, url))
        result[key] = kept

    def run(job):
        key, t, name, url = job
        data = get(url)
        if not (data.startswith(b"\x89PNG") or data.startswith(b"\xff\xd8")):
            raise RuntimeError("not an image: %r" % data[:120])
        write_atomic(os.path.join(out, name), data)
        return job

    with ThreadPoolExecutor(4) as pool:
        for job, fut in [(j, pool.submit(run, j)) for j in jobs]:
            try:
                fut.result()
                result[job[0]].append({"t": job[1], "f": job[2]})
            except Exception as e:
                errors.append("%s %s: %s" % (job[0], job[2], e))
    for key in result:
        result[key].sort(key=lambda f: f["t"])
    log("images:", ", ".join("%s %d" % (k, len(v)) for k, v in result.items()), "(%d new)" % len(jobs))
    return result


def fetch_base(out, region, errors):
    base = {}
    for key, layer in (("land", "OSM_Land_Water_Map"), ("coast", "Coastlines_15m")):
        name = "%s-%s.png" % (region["id"], key)
        if not os.path.exists(os.path.join(out, name)):
            try:
                url = wms_url(GIBS, layer, region["bbox"], "png", transparent=key == "coast", version="1.1.1")
                write_atomic(os.path.join(out, name), get(url))
            except Exception as e:
                errors.append("%s: %s" % (key, e))
                continue
        base[key] = name
    return base


def grid_points(region):
    s, w, n, e = region["ll"]
    lats = [round(s + (n - s) * i / (GRID - 1), 4) for i in range(GRID)]
    lons = [round(w + (e - w) * j / (GRID - 1), 4) for j in range(GRID)]
    return lats, lons


def open_meteo(url, region, variables, now):
    """Fetches a grid of points; returns times and {key: [[value per point] per time]}."""
    lats, lons = grid_points(region)
    pts = [(la, lo) for la in lats for lo in lons]  # row by row from the south
    q = url + "&latitude=" + ",".join(str(p[0]) for p in pts) + "&longitude=" + ",".join(str(p[1]) for p in pts)
    q += "&hourly=" + ",".join(variables.values()) + "&timeformat=unixtime"
    data = json.loads(get(q, timeout=120))
    if isinstance(data, dict):
        data = [data]
    times = data[0]["hourly"]["time"]
    first = next((i for i, t in enumerate(times) if t >= now - 3600), 0)
    out = {}
    for key, var in variables.items():
        rows = []
        for i in range(first, len(times)):
            row = []
            for p in data:
                v = p["hourly"][var][i]
                row.append(None if v is None else round(v, 1 if key not in ("dir", "wdir", "cloud") else 0))
            rows.append(row)
        out[key] = rows
    times = times[first:]
    # Drop trailing hours with no data (HRRR ends after 48 hours).
    last = max((i for i in range(len(times)) if any(v is not None for k in out for v in out[k][i])), default=-1)
    return times[:last + 1], {k: v[:last + 1] for k, v in out.items()}, lats, lons


def run_time(model):
    try:
        meta = json.loads(get("https://api.open-meteo.com/data/%s/static/meta.json" % model, timeout=20))
        return meta.get("last_run_initialisation_time")
    except Exception:
        return None


def fetch_forecasts(out, region, old, now, errors, force):
    result = {}
    todo = []
    for key in list(MODELS) + ["waves"]:
        prev = old.get(key)
        fresh = prev and now - prev.get("fetched", 0) < FORECAST_EVERY_S and os.path.exists(os.path.join(out, prev["f"]))
        if fresh and not force:
            result[key] = prev
        else:
            todo.append(key)
    for key in todo:
        try:
            if key == "waves":
                name, url, variables, run = "Open-Meteo marine", "https://marine-api.open-meteo.com/v1/marine?forecast_days=7", WAVE_VARS, None
            else:
                name, model, days, meta = MODELS[key]
                url = ("https://api.open-meteo.com/v1/forecast?models=%s&forecast_days=%d&wind_speed_unit=kn"
                       % (model, days))
                variables, run = MODEL_VARS, run_time(meta)
            times, values, lats, lons = open_meteo(url, region, variables, now)
            if not times:
                raise RuntimeError("no forecast data for this area")
            fname = "%s-%s-%d.json" % (region["id"], key, now)
            body = {"name": name, "run": run, "fetched": now, "lat": lats, "lon": lons, "t": times, "v": values}
            write_atomic(os.path.join(out, fname), json.dumps(body, separators=(",", ":")).encode())
            result[key] = {"name": name, "f": fname, "run": run, "fetched": now, "start": times[0], "end": times[-1]}
            log("forecast %s: %d hours" % (key, len(times)))
        except Exception as e:
            errors.append("%s forecast: %s" % (key, e))
            if old.get(key) and os.path.exists(os.path.join(out, old[key]["f"])):
                result[key] = old[key]  # keep the last good one
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", required=True, help="directory for index.json and the files it names")
    p.add_argument("--at", help="LAT,LON to centre on (default: the boat, from --state)")
    p.add_argument("--state", help="dashboard /api/state URL, for the boat's position")
    p.add_argument("--home", help="LAT,LON to use before the boat's position is first known")
    p.add_argument("--force", action="store_true", help="fetch forecasts even if recent")
    args = p.parse_args()

    os.makedirs(args.out, exist_ok=True)
    index_path = os.path.join(args.out, "index.json")
    try:
        with open(index_path) as f:
            old = json.load(f)
    except (OSError, ValueError):
        old = {}

    pos = boat_position(args, old.get("region"))
    if not pos:
        log("no boat position yet (no GPS, and no --home); nothing to fetch")
        return 1
    region = old.get("region")
    if not region or far_from(region, *pos):
        region = make_region(*pos)
        old = {}
        log("area: %.3f, %.3f" % pos)

    now = int(time.time())
    errors = []
    index = {
        "version": 1,
        "region": region,
        "base": fetch_base(args.out, region, errors),
        "obs": fetch_obs(args.out, region, old.get("obs", {}), now, errors),
        "forecast": fetch_forecasts(args.out, region, old.get("forecast", {}), now, errors, args.force),
        "credits": CREDITS,
    }
    got_any = any(index["obs"].values()) or index["forecast"]
    index["updated"] = now if got_any else old.get("updated")
    index["checked"] = now
    index["errors"] = errors[:20]
    for e in errors[:5]:
        log(e)
    write_atomic(index_path, json.dumps(index, separators=(",", ":")).encode())

    # Remove files the index no longer names.
    keep = {"index.json"} | set(index["base"].values())
    keep |= {f["f"] for frames in index["obs"].values() for f in frames}
    keep |= {fc["f"] for fc in index["forecast"].values()}
    for name in os.listdir(args.out):
        if name not in keep and re.match(r"[0-9a-f]{8}-.*\.(jpg|png|json)$", name):
            try:
                os.remove(os.path.join(args.out, name))
            except OSError:
                pass
    return 0 if got_any else 2


if __name__ == "__main__":
    sys.exit(main())
