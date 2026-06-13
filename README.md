# Growlight

Sun-synced grow light controller, timelapse camera, sensor logger, and web
dashboard for a Raspberry Pi Zero 2 W. Built to start seedlings;
over-engineered with love.

The light follows real local sunrise and sunset (computed on-device with
`astral`), fading up and down with smooth ramps. A camera photographs the
tray on a schedule under identical lighting. A Flask dashboard shows the live
state, plays the timelapse, renders a downloadable MP4, overlays a per-cell
grid with live moisture, charts sensor history, and lets every setting be
changed from the browser. Sensors and a watering pump are wired in behind a
sampling loop and a safety-capped pump controller.

## Hardware

- Raspberry Pi Zero 2 W (any 40-pin Pi works)
- 5V USB LED grow light head (stock controller removed)
- D4184 MOSFET modules, low-side switching: one for the LED ground, a spare
  for the pump
- USB-A screw-terminal adapters for the light head and supply brick
- Separate 5V bricks for the Pi, the light, and the pump (never share the
  Pi's 5V with motors)
- Raspberry Pi camera (v1 tested; any rpicam module works)

Planned / in progress sensor bus (all guarded in software, enable as wired):

- 10x capacitive soil moisture via 3x ADS1115 ADC (I2C 0x48/0x49/0x4A)
- BME280 air temp + humidity (I2C 0x76), BH1750 lux (I2C 0x23)
- 5x DS18B20 soil temperature (1-Wire, GPIO4)
- USB submersible pump via spare D4184 (GPIO24) + 1N5819 flyback
- Float switch (GPIO23, internal pull-up) for tray level / overfill

GPIO map: GPIO18 (pin 12) = light PWM (1 kHz, kernel hardware PWM);
GPIO23 (pin 16) = float switch; GPIO24 (pin 18) = pump trigger;
GPIO2/3 = I2C; GPIO4 = 1-Wire; pin 14 = shared ground.
Wiring diagrams (light, sensors, pump+float) are in the repo as SVGs.

## Install

Flash Raspberry Pi OS (Bookworm or Trixie), get it on WiFi, then:

```
git clone <repo-url> ~/growlight
cd ~/growlight
bash scripts/setup.sh
sudo reboot   # only needed the first time, for the PWM overlay
```

`setup.sh` is an environment provisioner: system packages, the PWM
device-tree overlay (no pigpio), a >=1GB swap file (so renders don't OOM on
512MB), a venv with dependencies (astral, flask, rpi-hardware-pwm, gpiozero +
lgpio, and opencv as a best-effort optional), and a systemd service under the
current user. It does NOT contain the app code; that comes from the repo
checkout. Idempotent and safe to re-run; it preserves config.json and
growlight.db. Update flow:

```
git pull && sudo systemctl restart growlight
```

Dashboard: `http://<pi-ip>:5000`

## Layout

```
growlight/
  growlight.py        app: controller, threads, Flask routes
  db.py               app: SQLite logging/query layer (sensor history)
  sensors.py          app: sensor I/O (stubbed until hardware is enabled)
  notify.py           app: push-notification transport (ntfy)
  detect_corners.py   app: tray-corner detection helper (subprocess)
  templates/index.html dashboard markup (Jinja only for the tz dropdown)
  static/style.css     all styling
  static/app.js        all dashboard JS
  config.json          runtime settings (gitignored; defaults in code)
  growlight.db         SQLite history (gitignored)
  timelapse/           photos + thumbs + rendered mp4 (gitignored)
  venv/                virtualenv (gitignored)
  .secret              session-signing key (gitignored, auto-generated)
  scripts/
    setup.sh           environment provisioner / updater
    set_password.py    set/change/disable the dashboard login
    test_ramp.py       manual 0->100->0 light test
```

The app files (growlight.py, db.py, sensors.py, notify.py, detect_corners.py)
locate everything relative to their own path, so they must stay together in
the project root. The frontend lives in `templates/` and `static/`, which
Flask serves automatically.

## Dashboard login (optional)

The dashboard is open by default. To make it read-only until you log in, set a
password (hidden prompt, written safely into config.json):

```
./venv/bin/python scripts/set_password.py
sudo systemctl restart growlight
```

A blank password disables login again. The login box appears top-right once a
password is set. In read-only mode the editing controls (settings, pump,
render, grid editing) are hidden, but viewing, timelapse playback, and MP4
download still work. Enforcement is server-side: mutating endpoints reject
unauthenticated requests regardless of the UI. The session cookie is Secure,
so over plain http (local testing) set `"cookie_secure": false` in config.

## Features

- Photoperiod synced to local sunrise/sunset with configurable ramps,
  brightness cap, and offsets to stretch the day
- All settings editable live from the dashboard (location, timezone, ramps,
  capture options, photo crop) with no SSH
- Timelapse capture during the photoperiod only, light forced to a fixed
  brightness per shot so every frame is identically exposed
- In-browser timelapse player (thumbnail-based, kind to the Zero) plus
  on-device MP4 rendering (1280-wide, split-pass to avoid OOM) with download
- Cell-mapping grid overlay on the snapshot: drag four corners, name cells,
  optional OpenCV auto-detect; shows per-cell moisture and a moisture heatmap
- Sensor readout, history charts (`/api/series`), and a "demo data" banner
  while sensors are stubbed
- Watering: float-switch status and a safety-capped manual pump test;
  autonomous dosing is scaffolded but off until moisture is calibrated
- Sensor sampling loop logging to SQLite with daily downsample/prune
- Read-only-until-login auth; soft animated sun whose size and rays track the
  live brightness; reduced-motion respected

## API

- `GET /api/status` — full state: brightness, sun times, settings, photos,
  latest sensor values, water/pump state, auth flags
- `GET /api/series?sensor=<key>&hours=<n>` — time-series for a sensor
- `POST /api/settings` — validated settings update (auth)
- `POST /api/grid`, `POST /api/detect_grid` — cell grid save / detect (auth)
- `POST /api/pump` — capped manual pump run (auth)
- `POST /api/render` — background MP4 render (auth)
- `POST /api/login`, `POST /api/logout`
- `GET /api/photos`, `GET /photo/latest`, `GET /thumb/<name>`, `GET /video`

## Operational notes

- Public exposure: front with nginx + TLS. App-level login protects editing;
  viewing is open once nginx allows it, so decide deliberately whether the
  read-only view should be internet-reachable.
- The pump has a hard per-dose cap, a daily cap, and refuses to run without
  hardware. With the float in the destination tray there is no dry-run
  protection for the source; the runtime cap is the only backstop there.
- Give the Pi a DHCP reservation. Ask me how I know.
- Manual light test: `scripts/test_ramp.py` fades 0->100->0 over 30s (stop the
  service first).
- Sensors default to stub mode; flip the `ENABLED` flags (and `FLOAT_ENABLED`)
  in sensors.py as each device is wired and verified.

## Roadmap

See `ROADMAP.md`. Next up: enable sensors as the hardware lands, calibrate
moisture, then build `alerts.py` (threshold logic) on top of `notify.py` for
reservoir/dry-run and light-verification alerts. Autonomous watering turns on
after moisture is calibrated. The box is already too full of bus bars.
