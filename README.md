# Growlight

Sun-synced grow light controller, timelapse camera, and web dashboard for a
Raspberry Pi Zero W. Built to start seedlings; over-engineered with love.

The light follows real local sunrise and sunset (computed on-device with
`astral`), fading up and down with smooth ramps. A camera photographs the
tray on a schedule under identical lighting, and a Flask dashboard shows
the live state, plays the timelapse, renders a downloadable MP4, and lets
every setting be changed from the browser.

## Hardware

- Raspberry Pi Zero W (any 40-pin Pi works)
- 5V USB LED grow light head (the stock controller removed)
- D4184 MOSFET trigger module, low-side switching the LED ground
- USB-A screw-terminal adapters (one male for the supply brick, one female
  for the light head) — no cut cables
- 5V 3A USB brick for the light, separate brick for the Pi
- Raspberry Pi camera (v1 tested; any rpicam-supported module works)

GPIO18 (physical pin 12) drives the MOSFET's TRIG/PWM input at 1 kHz via
the kernel's hardware PWM. Pin 14 provides the shared ground reference.
Wiring diagrams are in `docs/` if present.

## Install

Flash Raspberry Pi OS (Bookworm or Trixie), get it on WiFi, then:

```
git clone https://gitlab.pilg0re.net/Ben/Growlight.git
cd Growlight
bash scripts/setup.sh
sudo reboot   # only needed the first time, for the PWM overlay
```

`setup.sh` is idempotent and safe to re-run for upgrades. It installs
system packages (pigpio-free: PWM comes from a device-tree overlay),
creates a venv, deploys `growlight.py`, and installs a systemd service
under the current user. Settings live in `config.json` next to the script
and survive upgrades. Run standalone (no checkout), setup.sh uses an
embedded copy of growlight.py instead.

Dashboard: `http://<pi-ip>:5000`

## Layout

```
growlight/
  growlight.py        app: controller + dashboard + timelapse
  db.py               app: SQLite logging/query layer (sensor history)
  detect_corners.py   app: tray-corner detection helper (subprocess)
  config.json         runtime settings (gitignored; defaults in code)
  growlight.db        SQLite history (gitignored)
  timelapse/          captured photos + thumbs + rendered mp4 (gitignored)
  venv/               virtualenv (gitignored)
  scripts/
    setup.sh          idempotent installer / updater
    test_ramp.py      manual 0->100->0 light test
```

The three app files locate everything relative to their own path, so they must
stay together in the project root. `scripts/setup.sh` deploys them there from the
repo (or from embedded copies if run standalone).

## Dashboard login (optional)

The dashboard is open by default. To make it read-only until you log in, set a
password (hidden prompt, written safely into config.json):

```
./venv/bin/python scripts/set_password.py
sudo systemctl restart growlight
```

A blank password disables login again. The login box appears top-right once a
password is set; editing controls are hidden until you log in. Enforcement is
server-side, so viewers cannot change anything regardless of the UI.

## Features

- Photoperiod synced to local sunrise/sunset with configurable ramps,
  brightness cap, and offsets to stretch the day
- All settings editable live from the dashboard (location, timezone
  dropdown, ramps, capture options, photo crop) — no SSH needed
- Timelapse capture during the photoperiod only, with the light forced to
  a fixed brightness per shot so every frame is identically exposed
- Sensor-level crop (rpicam ROI) configurable from the page
- In-browser timelapse player (thumbnail-based, kind to the Zero W) plus
  on-device MP4 rendering with a download link
- Greenhouse-green responsive UI: two-column desktop layout, single-column
  mobile, collapsible settings

## API

- `GET /api/status` — full state: brightness, sun times, settings, photos
- `POST /api/settings` — validated settings update, applied immediately
- `GET /api/photos` — timelapse frame list
- `GET /photo/latest`, `GET /thumb/<name>`, `GET /video`
- `POST /api/render` — background MP4 render

## Operational notes

- Reverse-proxy with nginx + basic auth + TLS before exposing it anywhere
  public. The app itself has no authentication by design (LAN appliance).
- Give the Pi a DHCP reservation. Ask me how I know.
- Manual hardware test: `scripts/test_ramp.py` fades the light 0→100→0 over 30s
  (stop the service first).

## Roadmap

Soil moisture (10× capacitive via 3× ADS1115), BME280 air temp/humidity,
BH1750 light verification, DS18B20 soil temperature, and bottom-watering
via a USB submersible pump with reservoir float-switch protection. The
box is already too full of bus bars.
