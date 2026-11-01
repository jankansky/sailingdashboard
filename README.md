# Potter 19 Sailing Dashboard

A Raspberry Pi listens to the boat's NMEA 2000 bus through a PiCAN3 HAT (or an
SH-C30A USB-CAN adapter). It serves a live visualization of the West Wight Potter 19
to any tablet browser on the boat's Wi-Fi.

- **Wind**: gWind Wireless 2 → GNX Wind → PGN 130306 (apparent wind)
- **Heading and heel**: SteadyCast heading sensor → PGNs 127250, 127251, 127257
- **GPS** → PGNs 129025, 129026, 129029, 127258, 126992
- **True wind** (TWS/TWA/TWD) and VMG are computed on the Pi from apparent wind, heading and GPS
  course and speed, so they show *ground* wind.
- Speed through water (128259) and depth (128267) are decoded too, if you ever add those sensors.

The Pi only listens. It never transmits on the bus.

## Wiring

### PiCAN3 HAT (Raspberry Pi 4)

```
NMEA 2000 backbone ──T── drop cable ──► PiCAN3 screw terminal ── Raspberry Pi 4
boat 12 V (switched breaker) ─────────► PiCAN3 12 V input  (its supply powers the Pi)
```

| N2K drop wire     | PiCAN3 terminal |
|-------------------|-----------------|
| White (NET-H)     | CAN_H           |
| Blue  (NET-L)     | CAN_L           |
| Black (NET-C)     | GND             |
| Red   (NET-S 12V) | **not connected** (see below) |
| Bare  (shield)    | not connected   |

- **Leave the PiCAN3's 120 Ω terminator disabled.** The backbone already has its two
  terminators. Check the termination jumper or solder bridge against the board's user guide.
- **Power the Pi from a separate fused 12 V circuit, not the N2K red wire.** The board's
  supply accepts 6–20 V and gives the Pi 5 V at 3 A. A Pi drawing about 1 A at 12 V is far
  more than an NMEA 2000 drop is meant to supply.
- Fit a CR1225 coin cell so the board's real-time clock keeps time while the boat is off.
- Run `./deploy/install.sh --pican3` once, then reboot. After that, `dmesg | grep mcp251`
  should say "MCP2515 successfully initialized", and `can0` comes up at 250 kbit/s automatically.

### Waveshare 2-CH isolated CAN FD HAT (alternative)

- **Linux support:** it uses two MCP2518FD controllers, which Linux supports directly as `can0` and `can1`.
  NMEA 2000 is classic CAN; the controllers handle it and the dashboard runs them at 250 kbit/s, not in FD mode.
- **Wiring:** connect the N2K drop to **CAN0**: CAN_H to white, CAN_L to blue, GND to black. `can1` is spare.
- **Termination:** disable the 120 Ω terminator on CAN0. Check the board's jumper or switch against
  Waveshare's wiki.
- **Power:** it has no 12 V supply or real-time clock, unlike the PiCAN3. Power the Pi from a 12 V→5 V
  converter (3 A). The CAN side is isolated, which helps avoid ground loops on a boat.
- **Install:** run `./deploy/install.sh --canfd-hat` (it can be combined with `--imu`; not with `--pican3`),
  then reboot. Check with `dmesg | grep mcp251xfd` (expect "successfully initialized" for each channel)
  and `ip -details link show can0`.

### SH-C30A USB adapter (alternative)

Use the same wire colours on CAN-H, CAN-L and GND. **Switch its 120 Ω terminator OFF**.
Power the Pi from a 12 V→5 V USB converter (3 A). Most units ship with **candleLight
(gs_usb)** firmware and appear as `can0`. If yours appears as `/dev/ttyACM0`, it has
**slcan** firmware: set `--slcan /dev/ttyACM0` (see Configuration).

### BNO085 heel sensor (optional)

The SteadyCast may not send heel. An Adafruit BNO085 breakout (product 4754) wired to
the Pi supplies heel and pitch. A BNO086 board works the same way. If a heel sensor on
the bus is sending (PGN 127257), the dashboard uses it and ignores the BNO085. The heel
panel title shows which one is in use ("N2K" or "Pi IMU").

The chip runs in **UART-RVC mode**: it streams pitch and roll at 100 Hz on one wire,
with no setup and no magnetometer calibration.

| BNO085 pin | Raspberry Pi / PiCAN3 header pin |
|------------|----------------------------------|
| VIN        | 3.3 V (pin 1)                    |
| GND        | GND (pin 6)                      |
| SDA (TX in RVC mode) | GPIO15 / RXD (pin 10)  |
| P0         | 3.3 V (selects RVC mode)         |

The PiCAN3 passes the header pins through, and it uses SPI and GPIO25, so there's no conflict.

**Mounting matters more than anything else:**
- Screw the board (or the Pi's case with the board inside) solidly to the hull, roughly level.
- Point the board's **X arrow toward the bow**, parallel to the centreline.
- Once installed:
  - At the dock, zero any leftover tilt with `--roll-offset`.
  - Heel to starboard and confirm the gauge shows "S". If not, add `--invert-roll`.
  - If heel moves when the bow pitches instead, the board is rotated 90°. Turn it so X faces forward.

`./deploy/install.sh --imu` enables the Pi's serial port for the sensor (it turns off
Bluetooth and the serial login console) and adds `--imu /dev/serial0` to the settings.
Reboot afterwards.

## Install on the Pi

Start with Raspberry Pi OS (Bookworm or later). From the development machine, with the Pi
on the same network (replace `pi@sailboat.local` with your user and hostname):

```bash
ssh-copy-id pi@sailboat.local                            # once, so you aren't asked for a password
export PI=pi@sailboat.local
./deploy/push.sh --tiles --setup --pican3 --imu          # first time: copy, build, install
ssh $PI sudo reboot                                      # first time only
./deploy/push.sh                                         # after each change: sync, rebuild, restart
```

`push.sh` copies the project to `~/sailingdashboard` on the Pi with rsync (only changed
files) and runs the build there. Add `--tiles` when the map tiles change. Add
`--hotspot Potter19 mypassword` to the `--setup` options to have the Pi create its own Wi-Fi
network. Or copy the folder to the Pi any other way and run `./deploy/install.sh` there with
the same options.

The installer:

- builds the server
- installs it to `/opt/sailingdashboard`
- adds a udev rule that brings up `can0` at 250 kbit/s when the adapter is plugged in
- enables a systemd service that starts the dashboard on boot (port 80)

On the tablet, open **http://10.42.0.1/** (hotspot) or **http://&lt;pi-hostname&gt;.local/**.
Then use the browser's "Add to Home Screen" to run it full screen. Also set the tablet's
auto-lock to "never" while sailing. The browser can't keep the screen awake over plain http.

### Checking the bus

```bash
ip -details link show can0          # should say "state ERROR-ACTIVE", bitrate 250000
candump can0                        # raw traffic from the bus
journalctl -u sailingdashboard -f   # dashboard log
```

In the dashboard, tap **Bus**. It lists every device heard (model, maker, PGNs). You
should see the GNX Wind, the heading sensor and the GPS.

## Offline maps for the 3D view

The 3D view can lay aerial imagery or a NOAA chart under the boat. Switch layers with the
**Map** button. Download the tiles once, at home on any computer with internet and Python 3:

```bash
python3 tools/fetch_tiles.py --dry-run     # show what will be downloaded
python3 tools/fetch_tiles.py               # Casco Bay + Boston, imagery + charts
```

Run it again to resume if it's interrupted. Then `./deploy/push.sh --tiles` copies them to
the Pi.

| Layer | Source | Detail |
|---|---|---|
| Satellite | USGS The National Map orthoimagery (public domain), zoom 10–16 | ~1.7 m/pixel |
| | Maine GeoLibrary Casco Bay 2022 / MassGIS 2021 orthoimagery, zoom 17 | ~0.9 m/pixel (shore and islands) |
| Chart | NOAA Chart Display Service offline MBTiles (ENC-derived), zoom 10–17 | chart detail |

- **Download size:** NOAA's packages (about 1.1 GB) are kept in `tiles_cache/`, which you
  can delete afterwards.
- **Time:** the imagery download takes a few hours. It deliberately goes slowly so it
  doesn't overload the public servers.
- **Other areas:** `--bbox south,west,north,east --name somewhere`.
- **Dates:** the imagery dates from 2021–2024. NOAA's charts are a snapshot (currently
  May 2024); re-run the script to refresh them.
- **The chart layer is for orientation only. It is not for navigation.**

In 3D with a map shown, you can zoom out to about 6 km. An orange marker shows the boat
once it's too small to see.

## Configuration

Edit `/etc/default/sailingdashboard`, then `sudo systemctl restart sailingdashboard`:

| Option | Use |
|---|---|
| `--can can0` / `--slcan /dev/ttyACM0` | CAN source |
| `--port 80` | HTTP port |
| `--rate 5` | tablet updates per second |
| `--imu /dev/serial0` | BNO085 heel/pitch, used when no attitude sensor is on the bus |
| `--variation -14.3` | magnetic variation (east +). Only needed if nothing on the bus sends it; the GPS normally does |
| `--invert-roll` | heel shows on the wrong side (depends on how the SteadyCast is mounted) |
| `--roll-offset DEG` | heel reads non-zero at the dock |
| `--heading-offset DEG` | heading sensor alignment error |

## The display

- **Compass rose (heading up)**: the outer card rotates with heading.
  - **Blue solid triangle**: true wind direction.
  - **Hollow triangle**: 10-minute average wind direction. When the solid one moves away from it, that's a lift or a header.
  - **Purple dashed line**: course over ground. The gap between it and the bow shows leeway and current.
- **Inner ring**: wind angle relative to the bow. Red and green bands mark the port and starboard close-hauled zones.
- **Orange "A" arrow / blue "T" arrow**: apparent and true wind.
- **Sails**: drawn trimmed for the apparent wind. Dashed outlines mean you're head to wind.
- **Heel**: stern view of the hull, which rotates with heel.
  - Green: 0–15°
  - Amber: 15–25° (time to reef)
  - Red: above 25°
- **Wind chart**: last 20 minutes of TWD (line) and TWS (shaded). The Pi keeps 30 minutes of history, so a tablet that was asleep catches up when it wakes.
- **3D view**: tap **3D** at the bottom of the main panel.
  - The Potter 19 model heels, pitches and turns with the sensors, and its sails are trimmed for the apparent wind.
  - Orange and blue 3D arrows show apparent and true wind; a purple stripe on the water shows course over ground.
  - Drag to orbit, pinch or scroll to zoom, double-tap to reset.
  - **Follow** keeps the camera behind the boat; **North up** fixes the camera so you watch the boat turn.
  - The sky is a physically based daylight model. The sun and moon sit where they really are for the
    boat's GPS position and time, with the moon's correct phase. The boat's lighting follows them, from
    midday through sunset to moonlight.
  - **AIS targets** (needs an AIS receiver on the NMEA 2000 bus, e.g. a Garmin AIS unit, or a
    chartplotter/VHF that bridges AIS onto it): each vessel is drawn to scale with a label (name,
    speed, range, closest point of approach). It has a 10-minute predicted track in one-minute dashes,
    and your own predicted track is shown in orange. Targets turn amber when they'll pass within
    1 nm in the next 30 min, and red within 0.5 nm in the next 20 min. A red line joins both boats'
    positions at the closest approach. The simulator includes four fictional AIS vessels.
  - It runs on Three.js, saved in `web/vendor/` so it works without internet.
- **Header**: status pills turn amber or red when a sensor goes quiet. **Damp** sets the smoothing. **Day/Dusk/Night** switches themes (Night is red-only).
- **Screenshot** (camera button): saves a PNG of the whole dashboard, including the 3D view, to the
  tablet's downloads. It's named after the time shown, e.g. `potter19-2026-07-04-143210.png`.

## Recordings and replay

The Pi records everything on the bus, plus the BNO085 readings, to its SD card in
`/var/lib/sailingdashboard/recordings`. **REC** in the header lights red while it's writing.

- **Files:** one per outing. A new file starts when the Pi powers up, after the bus has been quiet for
  10 minutes, or every 12 hours.
- **Space:** about 15–40 MB per hour, depending on how busy the bus is. The oldest recordings are deleted
  beyond 8 GB, or when the card gets down to 1 GB free. Change the limit in `/etc/default/sailingdashboard`.
- **Format:** candump, so recordings also open in other NMEA 2000 tools (e.g. canboat's `analyzer`) and in
  `--replay`.
- **Power:** data reaches the card every 10 seconds, so switching the boat off loses at most the last few seconds.

Tap **Logs** to list the recordings, download one, or **Replay** it. A replay bar appears:

- **▶ / ❚❚** plays and pauses. The speed button cycles through 1×, 2×, 5×, 10×, 30× and 60×.
- **Drag the slider** to move through time. The shading behind it is boat speed across the whole
  recording, to help find the interesting parts. On a keyboard, Space plays or pauses, and ← / → step
  10 s (with Shift, 1 min).
- **Live** returns to the boat.

Everything follows the replay: instruments, wind chart, 3D view, sun and moon, and AIS targets.
Each tablet replays on its own, so the helm's tablet can stay live while someone else reviews.
The Pi's clock dates the files. With a PiCAN3, its battery-backed clock keeps time with the Pi
offline. Without one, recording dates may be off until the Pi next sees the internet, but
replay times come from the boat's GPS.

## Development (Mac or Linux, no hardware)

```bash
cmake -S . -B build && cmake --build build
./build/sailingdashboard --sim --port 8080        # simulated Potter 19 off Boston
./build/sailingdashboard --sim-at casco --port 8080  # or start it in Casco Bay (or --sim-at LAT,LON)
open http://localhost:8080/
```

Add `--record recordings` to record the simulator and try the Logs button. Use
`--recordings DIR` to replay recordings copied from the Pi without recording, e.g.
`scp -r pi@sailboat.local:/var/lib/sailingdashboard/recordings .`.

In CLion, set the run configuration's program arguments to `--sim --port 8080` and its
working directory to the project root, so `web/` is found.

To record real data on the boat and replay it at home:

```bash
candump -l can0                                   # on the Pi; writes candump-<date>.log
./build/sailingdashboard --replay candump-*.log --loop
```

`--verbose` prints every decoded message.

## Layout

```
src/n2k.*            CAN ID parsing, fast-packet reassembly, PGN decoders
src/boat_state.*     live data, true-wind calculation, JSON, 30-min history
src/frame_source.*   SocketCAN, SLCAN serial, candump replay
src/simulator.cpp    simulated boat producing real N2K frames
src/imu_rvc.*        BNO085 UART-RVC reader (heel/pitch)
src/http_server.*    static files + Server-Sent Events (/events) + /api/*
src/recorder.*       logs the bus to the SD card
src/playback.*       replays a recording at any speed and position, one session per tablet
src/json.hpp         small JSON writer
web/                 tablet UI (works offline; boat3d.js is the 3D view)
web/vendor/          Three.js r160 (MIT licence)
web/maptiles.js      offline map tiles in the 3D view
web/ais3d.js         AIS targets, predicted tracks and closest-approach warnings
web/sky.js, astro.js sky, sun and moon (skymodel.js: Three.js's Preetham sky shader, modified)
web/screenshot.js    redraws the page into an image for the screenshot button
tools/fetch_tiles.py downloads imagery and NOAA chart tiles for offline use
deploy/              installer, push-to-Pi script, udev rule, systemd service
```
