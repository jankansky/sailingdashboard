#!/usr/bin/env python3
"""Downloads map tiles for the dashboard's 3D view, so it works offline on the boat.

Layers
  imagery  aerial photos: USGS National Map (public domain, zoom 10-16, ~1.7 m/px)
           plus state orthophotos for zoom 17 (~0.9 m/px) where available
  chart    NOAA Chart Display Service (ENC-derived), extracted from NOAA's official
           offline MBTiles packages. Not for navigation.

Usage (on a computer with internet; needs only Python 3):
  python3 tools/fetch_tiles.py                     # Casco Bay + Boston, both layers
  python3 tools/fetch_tiles.py --dry-run           # just count tiles
  python3 tools/fetch_tiles.py --area boston --layers chart
  python3 tools/fetch_tiles.py --bbox 43.0,-70.8,43.2,-70.6 --name portsmouth

Writes tiles/<layer>/<z>/<x>/<y>.<ext> and tiles/index.json. Re-running skips tiles
already downloaded, so an interrupted run can simply be restarted. Then copy the
project to the Pi and run deploy/install.sh, which installs the tiles.
"""

import argparse
import http.client
import json
import math
import os
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

USER_AGENT = "sailing-dashboard offline tile prefetch (personal use)"
R = 6378137.0

USGS = {
    "name": "USGS The National Map orthoimagery",
    "kind": "xyz",
    "url": "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
}
MASSGIS = {
    "name": "MassGIS 2021 orthoimagery",
    "kind": "xyz",
    "url": "https://tiles.arcgis.com/tiles/hGdibHYSPO59RG1h/arcgis/rest/services/orthos2021/MapServer/tile/{z}/{y}/{x}",
}
MAINE_CASCO = {
    "name": "Maine GeoLibrary Casco Bay 2022 orthoimagery",
    "kind": "export",  # ArcGIS ImageServer: rendered per tile on request
    "url": "https://gis.maine.gov/image/rest/services/Coastal/orthoCoastalCascoBay2022/ImageServer/exportImage",
    # Its bot protection stalls clients that send requests quickly or reuse connections.
    "workers": 1, "delay": 0.4, "keepalive": False, "backoff": 30,
}
# NOAA packages for New England, used if NOAA's region lookup service is down.
# (name, south, west, north, east); URLs follow NOAA's naming.
NOAA_FALLBACK = [
    ("ncds_01a", 42.8, -76.7, 45.5, -69.2), ("ncds_01b", 42.8, -69.2, 45.5, -67.3),
    ("ncds_01c", 42.8, -67.3, 45.5, -64.9), ("ncds_02a", 41.1, -76.7, 42.8, -71.1),
    ("ncds_02b", 41.1, -71.1, 42.8, -64.9), ("ncds_03", 39.7, -76.7, 41.1, -64.9),
]
NOAA_REGIONS = ("https://gis.charttools.noaa.gov/arcgis/rest/services/MarineChart_Services/"
                "ncds_tilecache_metadata/MapServer/0/query")

# Sources for zoom 17 and up, by the region they cover (south, west, north, east).
HIRES = [
    ((41.2, -73.6, 42.9, -69.8), MASSGIS),
    ((43.45, -70.45, 44.05, -69.65), MAINE_CASCO),
]

# bbox: south, west, north, east (degrees)
AREAS = {
    "casco": {"bbox": (43.55, -70.35, 43.90, -69.80)},
    "boston": {"bbox": (42.22, -71.09, 42.50, -70.75)},
    # ~4 km around Cousins and Littlejohn Islands, Yarmouth (inside "casco"; quick to fetch)
    "cousins": {"bbox": (43.725, -70.215, 43.795, -70.110)},
}


def hires_for(bbox):
    s, w, n, e = bbox
    for (rs, rw, rn, re), src in HIRES:
        if rs <= s and n <= rn and rw <= w and e <= re:
            return src
    return None

USGS_MAX_ZOOM = 16  # the USGS tile cache stops here
MIN_REAL_TILE = 2000  # bytes; smaller hi-res tiles are blank (outside the survey)


def tile_range(bbox, z):
    s, w, n, e = bbox
    count = 2 ** z

    def xy(lat, lon):
        x = int((lon + 180) / 360 * count)
        y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * count)
        return min(max(x, 0), count - 1), min(max(y, 0), count - 1)

    x0, y0 = xy(n, w)
    x1, y1 = xy(s, e)
    return x0, x1, y0, y1


def tiles_in(bbox, z):
    x0, x1, y0, y1 = tile_range(bbox, z)
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            yield x, y


def source_url(src, z, x, y):
    if src["kind"] == "xyz":
        return src["url"].format(z=z, x=x, y=y)
    size = 2 * math.pi * R / 2 ** z
    xmin = -math.pi * R + x * size
    ymax = math.pi * R - y * size
    return src["url"] + "?" + urllib.parse.urlencode({
        "bbox": f"{xmin},{ymax - size},{xmin + size},{ymax}", "bboxSR": 3857, "imageSR": 3857,
        "size": "256,256", "format": "jpg", "bandIds": "0,1,2", "f": "image",
    })


_local = threading.local()


def _connection(host):
    """One persistent HTTPS connection per thread and host. Opening a new TLS
    connection for every tile gets throttled by some servers' bot protection."""
    conns = _local.__dict__.setdefault("conns", {})
    if host not in conns:
        conns[host] = http.client.HTTPSConnection(host, timeout=20)
    return conns[host]


def http_get(url, attempts=4, keepalive=True, backoff=1):
    """Returns the body, None for 404, or raises after `attempts` failures."""
    u = urllib.parse.urlsplit(url)
    path = u.path + ("?" + u.query if u.query else "")
    for i in range(attempts):
        conn = _connection(u.netloc) if keepalive else http.client.HTTPSConnection(u.netloc, timeout=20)
        try:
            conn.request("GET", path, headers={"User-Agent": USER_AGENT})
            r = conn.getresponse()
            body = r.read()
            if not keepalive:
                conn.close()
            if r.status == 200:
                return body
            if r.status == 404:
                return None
            err = f"HTTP {r.status}"
        except (OSError, http.client.HTTPException) as e:
            err = str(e) or type(e).__name__
            conn.close()
            if keepalive:
                _local.conns.pop(u.netloc, None)
        if i == attempts - 1:
            raise RuntimeError(f"{err}: {url}")
        time.sleep(backoff * 2 ** i)


def complete_jpeg(data):
    # A truncated JPEG lacks its end-of-image marker (FF D9). Some servers append a
    # little metadata after it, so look near the end rather than at the last bytes.
    return data[:2] == b"\xff\xd8" and data.rfind(b"\xff\xd9") >= len(data) - 1024


def write_atomic(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


class Progress:
    def __init__(self, label, total):
        self.label, self.total, self.done, self.saved = label, total, 0, 0
        self.lock = threading.Lock()
        self.start = time.time()

    def tick(self, saved):
        with self.lock:
            self.done += 1
            self.saved += saved
            if self.done % 250 == 0 or self.done == self.total:
                rate = self.done / max(1e-6, time.time() - self.start)
                left = (self.total - self.done) / max(rate, 1e-6)
                print(f"  {self.label}: {self.done}/{self.total} tiles, "
                      f"{self.saved / 1e6:.1f} MB new, ~{left / 60:.0f} min left", flush=True)


def fetch_imagery(areas, out, zmin, zmax, workers, delay):
    jobs = []
    for name, area in areas.items():
        for z in range(zmin, zmax + 1):
            src = USGS if z <= USGS_MAX_ZOOM else hires_for(area["bbox"])
            if not src:
                continue
            for x, y in tiles_in(area["bbox"], z):
                jobs.append((src, z, x, y, z > USGS_MAX_ZOOM))
    jobs = list({(j[1], j[2], j[3]): j for j in jobs}.values())  # areas may overlap

    # Tiles a hi-res source had no imagery for, so re-runs don't ask again.
    blank_path = os.path.join(out, "imagery", "blank.txt")
    blank = set(open(blank_path).read().split()) if os.path.exists(blank_path) else set()
    lock = threading.Lock()
    todo = [j for j in jobs
            if f"{j[1]}/{j[2]}/{j[3]}" not in blank
            and not os.path.exists(os.path.join(out, "imagery", str(j[1]), str(j[2]), f"{j[3]}.jpg"))]
    print(f"imagery: {len(jobs)} tiles, {len(jobs) - len(todo)} already downloaded or known blank")
    progress = Progress("imagery", len(todo))
    failed = []

    def work(job):
        src, z, x, y, hires = job
        url = source_url(src, z, x, y)
        get = lambda: http_get(url, keepalive=src.get("keepalive", True), backoff=src.get("backoff", 1))
        try:
            data = get()
            for _ in range(3):  # servers occasionally return truncated images
                if data is None or complete_jpeg(data):
                    break
                time.sleep(2)
                data = get()
            if data is not None and not complete_jpeg(data):
                data = None  # leave it missing; the next run retries it
        except RuntimeError as e:
            failed.append(str(e))
            data = None
        saved = 0
        if data and hires and len(data) < MIN_REAL_TILE:
            with lock:
                blank.add(f"{z}/{x}/{y}")
                with open(blank_path, "a") as f:
                    f.write(f"{z}/{x}/{y}\n")
        elif data:
            write_atomic(os.path.join(out, "imagery", str(z), str(x), f"{y}.jpg"), data)
            saved = len(data)
        progress.tick(saved)
        time.sleep(src.get("delay", delay))

    os.makedirs(os.path.join(out, "imagery"), exist_ok=True)
    by_source = {}
    for j in todo:
        by_source.setdefault(j[0]["name"], []).append(j)
    for name, group in by_source.items():
        src = group[0][0]
        n = src.get("workers", workers)
        print(f"  {name}: {len(group)} tiles, {n} at a time", flush=True)
        with ThreadPoolExecutor(n) as pool:
            for _ in pool.map(work, group):
                pass
    if failed:
        print(f"  {len(failed)} tiles failed (e.g. {failed[0]}); run again to retry them")


def noaa_regions(bbox):
    s, w, n, e = bbox
    q = urllib.parse.urlencode({
        "geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects", "outFields": "name,size,baseline,date_creat",
        "returnGeometry": "false", "f": "json",
    })
    for attempt in range(3):
        data = json.loads(http_get(f"{NOAA_REGIONS}?{q}"))
        if "error" not in data:
            return [f["attributes"] for f in data.get("features", [])]
        time.sleep(5 * (attempt + 1))
    print("  NOAA region lookup is unavailable; using the built-in New England list")
    return [{"name": name, "size": 0, "date_creat": "latest",
             "baseline": f"https://distribution.charts.noaa.gov/ncds/mbtiles/{name}.mbtiles"}
            for name, rs, rw, rn, re in NOAA_FALLBACK if s < rn and n > rs and w < re and e > rw]


def download_file(url, path):
    """Downloads with resume; NOAA packages are several hundred MB."""
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as r:
        size = int(r.headers["Content-Length"])
    have = os.path.getsize(path) if os.path.exists(path) else 0
    if have == size:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    print(f"  downloading {url} ({size / 1e6:.0f} MB)", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Range": f"bytes={have}-"})
    with urllib.request.urlopen(req, timeout=120) as r, open(path, "ab" if have else "wb") as f:
        if have and r.status != 206:  # server ignored the range: start over
            f.seek(0)
            f.truncate()
            have = 0
        last = time.time()
        while chunk := r.read(1 << 20):
            f.write(chunk)
            have += len(chunk)
            if time.time() - last > 10:
                print(f"    {have / 1e6:.0f}/{size / 1e6:.0f} MB", flush=True)
                last = time.time()


def extract_mbtiles(path, areas, out, zmin, zmax):
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    fmt = dict(db.execute("SELECT name, value FROM metadata").fetchall()).get("format", "png")
    written = 0
    for area in areas.values():
        for z in range(zmin, zmax + 1):
            x0, x1, y0, y1 = tile_range(area["bbox"], z)
            flip = 2 ** z - 1  # MBTiles counts rows from the south
            rows = db.execute(
                "SELECT tile_column, tile_row, tile_data FROM tiles WHERE zoom_level = ? "
                "AND tile_column BETWEEN ? AND ? AND tile_row BETWEEN ? AND ?",
                (z, x0, x1, flip - y1, flip - y0))
            for x, row, data in rows:
                dest = os.path.join(out, "chart", str(z), str(x), f"{flip - row}.{fmt}")
                if not os.path.exists(dest):  # first package wins on region seams
                    write_atomic(dest, data)
                    written += 1
    db.close()
    return written, fmt


def fetch_charts(areas, out, cache, zmin, zmax):
    regions = {}
    for area in areas.values():
        for r in noaa_regions(area["bbox"]):
            regions[r["name"]] = r
    print("chart: NOAA packages needed: " +
          ", ".join(f"{r['name']} ({r['size']:.0f} MB, {r['date_creat']})" for r in regions.values()))
    fmt = "png"
    for r in regions.values():
        path = os.path.join(cache, r["name"] + ".mbtiles")
        download_file(r["baseline"], path)
        n, fmt = extract_mbtiles(path, areas, out, zmin, zmax)
        print(f"  {r['name']}: {n} new tiles")
    return fmt


def update_index(out, layer, ext, areas, zmin, zmax, attribution):
    path = os.path.join(out, "index.json")
    index = {"layers": {}}
    if os.path.exists(path):
        with open(path) as f:
            index = json.load(f)
    entry = index["layers"].setdefault(layer, {"ext": ext, "areas": []})
    entry.update(ext=ext, attribution=attribution)
    known = {a["name"]: a for a in entry["areas"]}
    for name, area in areas.items():
        top = zmax if layer == "chart" or hires_for(area["bbox"]) else min(zmax, USGS_MAX_ZOOM)
        known[name] = {"name": name, "bbox": list(area["bbox"]), "minzoom": zmin, "maxzoom": top}
    entry["areas"] = list(known.values())
    entry["minzoom"] = min(a["minzoom"] for a in entry["areas"])
    entry["maxzoom"] = max(a["maxzoom"] for a in entry["areas"])
    write_atomic(path, json.dumps(index, indent=2).encode())


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--area", action="append", choices=sorted(AREAS), help="preset area (default: all)")
    p.add_argument("--bbox", help="custom area: south,west,north,east")
    p.add_argument("--name", default="custom", help="name for --bbox")
    p.add_argument("--layers", default="imagery,chart")
    p.add_argument("--min-zoom", type=int, default=10)
    p.add_argument("--max-zoom", type=int, default=17)
    p.add_argument("--out", default="tiles")
    p.add_argument("--cache", default="tiles_cache", help="where NOAA packages are kept")
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--delay", type=float, default=0.1, help="seconds each worker waits between tiles")
    p.add_argument("--dry-run", action="store_true")
    a = p.parse_args()

    if a.bbox:
        bbox = tuple(float(v) for v in a.bbox.split(","))
        if len(bbox) != 4:
            p.error("--bbox needs south,west,north,east")
        areas = {a.name: {"bbox": bbox}}
    else:
        areas = {k: AREAS[k] for k in (a.area or AREAS)}
    layers = [layer.strip() for layer in a.layers.split(",") if layer.strip()]

    total = sum(1 for area in areas.values() for z in range(a.min_zoom, a.max_zoom + 1)
                for _ in tiles_in(area["bbox"], z))
    print(f"areas: {', '.join(areas)}; zoom {a.min_zoom}-{a.max_zoom}; about {total} tiles per layer")
    if a.dry_run:
        return

    if "imagery" in layers:
        fetch_imagery(areas, a.out, a.min_zoom, a.max_zoom, a.workers, a.delay)
        credits = sorted({USGS["name"]} | {hires_for(ar["bbox"])["name"] for ar in areas.values() if hires_for(ar["bbox"])})
        update_index(a.out, "imagery", "jpg", areas, a.min_zoom, a.max_zoom, "; ".join(credits))
    if "chart" in layers:
        ext = fetch_charts(areas, a.out, a.cache, a.min_zoom, a.max_zoom)
        update_index(a.out, "chart", ext, areas, a.min_zoom, a.max_zoom,
                     "NOAA Chart Display Service (not for navigation)")
    print(f"done. Tiles are in {a.out}/; deploy/install.sh copies them to the Pi.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("interrupted; run again to resume")
