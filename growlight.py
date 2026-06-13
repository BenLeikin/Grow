#!/usr/bin/env python3
"""
Grow light controller + dashboard + timelapse for Raspberry Pi.

Drives a logic-level MOSFET on GPIO18 via the kernel's hardware PWM,
following local sunrise and sunset with smooth fade-in / fade-out ramps.
Serves a dashboard on http://<pi-ip>:5000 with live-editable settings.
Optionally captures timelapse photos at a fixed interval during the
photoperiod, holding the light at a fixed brightness for each shot so
every frame is identically exposed. Photos land in ./timelapse/.

Requires (handled by setup.sh):
  - 'dtoverlay=pwm,pin=18,func=2' in /boot/firmware/config.txt, then reboot
  - rpicam-apps (apt) for the camera
  - pip install astral rpi-hardware-pwm flask
"""

import json
import subprocess
import sys
import signal
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo, available_timezones

from rpi_hardware_pwm import HardwarePWM
from astral import LocationInfo
from astral.sun import sun
from flask import (Flask, jsonify, render_template, request,
                   send_file, send_from_directory)

import db
import sensors
import notify

# ------------------- defaults (overridden by config.json) -------------------
DEFAULTS = {
    "latitude": 34.17,
    "longitude": -118.84,
    "timezone": "America/Los_Angeles",
    "max_bright": 100,         # percent
    "ramp_min": 30,            # minutes
    "sunrise_offset_min": 0,   # negative starts before sunrise
    "sunset_offset_min": 0,    # positive runs past sunset
    "capture_enabled": False,
    "capture_interval_min": 30,
    "capture_brightness": 100,  # light level held during each photo
    "roi": "",                  # crop as "x,y,w,h" fractions, blank = full frame
    "sample_interval_min": 5,   # how often to read + log sensors
    "ntfy_topic": "",           # set to enable push notifications (see notify.py)
    "auto_water": False,        # master switch; keep OFF until moisture calibrated
    "moisture_threshold_pct": 30,  # CALIBRATION TODO: "dry" trigger, per-probe
    "pump_max_seconds": 20,     # hard cap on a single dose (anti-flood/dry-run)
    "pump_cooldown_min": 30,    # min wait between auto doses (soil wicks slowly)
    "pump_daily_max_seconds": 180,  # runaway backstop
    "grid": {                   # cell-mapping overlay
        "corners": [[0.12, 0.10], [0.88, 0.10], [0.88, 0.92], [0.12, 0.92]],
        "rows": 4, "cols": 4, "names": {}, "show": True,
    },
}

GPIO_PIN      = 18
PWM_FREQ      = 1000
LOOP_SECONDS  = 30
HTTP_PORT     = 5000
CONFIG_PATH   = Path(__file__).with_name("config.json")
TIMELAPSE_DIR = Path(__file__).with_name("timelapse")
TIMEZONES     = sorted(available_timezones())
THUMB_DIR     = TIMELAPSE_DIR / "thumbs"
# ----------------------------------------------------------------------------

TIMELAPSE_DIR.mkdir(exist_ok=True)
THUMB_DIR.mkdir(exist_ok=True)

# --- pump actuator (gpiozero, guarded so off-Pi / unwired stays safe) ---
PUMP_PIN = 24  # BCM; physical pin 18
try:
    from gpiozero import OutputDevice
    _pump = OutputDevice(PUMP_PIN, active_high=True, initial_value=False)
    PUMP_HW = True
except Exception as _e:
    _pump = None
    PUMP_HW = False
    print(f"pump GPIO unavailable ({_e}); pump control disabled")

pump_state = {"running": False, "last_run": 0.0,
              "today_seconds": 0.0, "day": "", "last_detail": ""}
pump_lock = threading.Lock()

settings = dict(DEFAULTS)
if CONFIG_PATH.exists():
    try:
        settings.update(json.loads(CONFIG_PATH.read_text()))
    except Exception as e:
        print(f"config.json unreadable ({e}), using defaults")

settings_lock = threading.Lock()
wake = threading.Event()

state = {"brightness": 0.0, "on": None, "off": None,
         "sunrise": None, "sunset": None}
state_lock = threading.Lock()
capturing = False   # capture thread holds the light; control loop defers
render = {"state": "idle", "msg": "", "frames": 0,
          "started": None, "elapsed": None}   # idle|running|done|error
render_lock = threading.Lock()
VIDEO_PATH = TIMELAPSE_DIR / "timelapse.mp4"

try:
    pwm = HardwarePWM(pwm_channel=0, hz=PWM_FREQ, chip=0)
    pwm.start(0)
except Exception as e:
    sys.exit(f"Hardware PWM unavailable ({e}). Check that "
             f"'dtoverlay=pwm,pin=18,func=2' is in /boot/firmware/config.txt "
             f"and reboot after adding it.")


def set_brightness(percent):
    percent = max(0.0, min(100.0, percent))
    pwm.change_duty_cycle(percent)


def sun_window(cfg, day, tz):
    loc = LocationInfo(latitude=cfg["latitude"], longitude=cfg["longitude"])
    s = sun(loc.observer, date=day, tzinfo=tz)
    on_time  = s["sunrise"] + timedelta(minutes=cfg["sunrise_offset_min"])
    off_time = s["sunset"]  + timedelta(minutes=cfg["sunset_offset_min"])
    return s["sunrise"], s["sunset"], on_time, off_time


def brightness_for(cfg, now, on_time, off_time):
    if now <= on_time or now >= off_time:
        return 0.0
    mx = cfg["max_bright"]
    ramp = timedelta(minutes=cfg["ramp_min"])
    full_start, full_end = on_time + ramp, off_time - ramp
    if full_start >= full_end:  # very short window: triangular peak
        mid = on_time + (off_time - on_time) / 2
        if now <= mid:
            return mx * (now - on_time) / (mid - on_time)
        return mx * (off_time - now) / (off_time - mid)
    if now < full_start:
        return mx * (now - on_time) / ramp
    if now > full_end:
        return mx * (off_time - now) / ramp
    return float(mx)


def parse_roi(s):
    """Validate 'x,y,w,h' fraction string. Returns tuple or None for blank."""
    s = (s or "").strip()
    if not s:
        return None
    parts = [float(p) for p in s.split(",")]
    if len(parts) != 4:
        raise ValueError("need four numbers")
    x, y, w, h = parts
    if not (0 <= x < 1 and 0 <= y < 1 and 0.05 <= w <= 1 and 0.05 <= h <= 1
            and x + w <= 1.001 and y + h <= 1.001):
        raise ValueError("out of range")
    return x, y, w, h


def make_thumb(photo_path):
    """640px thumbnail for the browser player. Cheap, one-time per photo."""
    dst = THUMB_DIR / photo_path.name
    if dst.exists():
        return
    try:
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-i", str(photo_path),
             "-vf", "scale=640:-2", "-q:v", "7", str(dst)],
            capture_output=True, timeout=120)
    except Exception as e:
        print(f"thumbnail error for {photo_path.name}: {e}")


def photo_inventory():
    photos = sorted(TIMELAPSE_DIR.glob("*.jpg"))
    if not photos:
        return 0, None, None
    latest = photos[-1]
    return len(photos), latest, datetime.fromtimestamp(latest.stat().st_mtime)


# --------------------------- control loop ---------------------------

def _today_str():
    return datetime.now(ZoneInfo(settings["timezone"])).date().isoformat()


def run_pump(seconds, reason="manual", force=False):
    """Run the pump for `seconds`, clamped to the hard cap. Safety: refuses if
    hardware is absent, if already running, or (unless forced) if the daily cap
    would be exceeded. Blocks for the duration, so call it in a thread.
    Returns (ok, message). Logs every run as a pump event."""
    with settings_lock:
        cap = float(settings.get("pump_max_seconds", 20))
        daily_cap = float(settings.get("pump_daily_max_seconds", 180))
    secs = max(0.0, min(float(seconds), cap))
    with pump_lock:
        if not PUMP_HW:
            return False, "pump hardware not available"
        if pump_state["running"]:
            return False, "pump already running"
        if pump_state["day"] != _today_str():
            pump_state["day"] = _today_str()
            pump_state["today_seconds"] = 0.0
        if not force and pump_state["today_seconds"] + secs > daily_cap:
            return False, "daily pump limit reached"
        pump_state["running"] = True
    elapsed = 0.0
    try:
        _pump.on()
        t0 = time.time()
        time.sleep(secs)
        elapsed = time.time() - t0
    finally:
        _pump.off()
        with pump_lock:
            pump_state["running"] = False
            pump_state["last_run"] = time.time()
            pump_state["today_seconds"] += elapsed
            pump_state["last_detail"] = f"{reason} {elapsed:.1f}s"
    try:
        db.log_event("pump", f"{reason} {elapsed:.1f}s")
    except Exception:
        pass
    return True, f"ran {elapsed:.1f}s"


def watering_loop():
    """Autonomous watering. DISABLED until auto_water is on AND moisture is
    calibrated. Scaffold only -- the dry-trigger and fill logic go here once
    real moisture data tells us what 'dry' means.
    Planned: if a cell reads below moisture_threshold_pct and cooldown has
    elapsed and the tray float says 'not full', dose via run_pump(reason="auto"),
    stopping early when the float trips. If a dose runs to the cap without the
    float tripping, treat it as source-empty/leak/stuck-float: log it, fire a
    notify alert, and flip auto_water off."""
    while True:
        time.sleep(60)
        with settings_lock:
            on = bool(settings.get("auto_water", False))
        if not on:
            continue
        # TODO (post-calibration): real dry detection + float-gated dosing.


def sample_loop():
    """Read all sensors on an interval, log them in one transaction, and run
    daily downsampling. Tolerant: a read failure logs nothing and tries again
    next tick rather than killing the thread."""
    db.init()
    last_prune = 0.0
    while True:
        with settings_lock:
            interval = max(1, int(settings.get("sample_interval_min", 5)))
        try:
            readings = sensors.read_all()
            if readings:
                db.log_many(list(readings.items()))
        except Exception as e:
            print(f"sample_loop error: {e}")
        # housekeeping once a day: roll raw -> hourly, prune old raw
        now = time.time()
        if now - last_prune > 86400:
            try:
                db.downsample_and_prune()
            except Exception as e:
                print(f"prune error: {e}")
            last_prune = now
        time.sleep(interval * 60)


def control_loop():
    seen = None
    sunrise = sunset = on_time = off_time = None
    while True:
        with settings_lock:
            cfg = dict(settings)
        tz = ZoneInfo(cfg["timezone"])
        now = datetime.now(tz)
        key = (now.date(), json.dumps(cfg, sort_keys=True))
        if key != seen:
            seen = key
            sunrise, sunset, on_time, off_time = sun_window(cfg, now.date(), tz)
            print(f"{now.date()}: on {on_time:%H:%M}, off {off_time:%H:%M} "
                  f"({cfg['latitude']}, {cfg['longitude']}, {cfg['timezone']})")
        b = brightness_for(cfg, now, on_time, off_time)
        if not capturing:
            set_brightness(b)
        with state_lock:
            state.update(brightness=b, on=on_time, off=off_time,
                         sunrise=sunrise, sunset=sunset)
        wake.wait(timeout=LOOP_SECONDS)
        wake.clear()


# --------------------------- capture loop ---------------------------

def take_photo(cfg, now):
    global capturing
    capturing = True
    try:
        set_brightness(cfg["capture_brightness"])
        time.sleep(2)  # let light and auto-exposure settle
        fname = TIMELAPSE_DIR / f"{now:%Y%m%d_%H%M%S}.jpg"
        cmd = ["rpicam-still", "-n", "-o", str(fname), "-t", "2000"]
        try:
            roi = parse_roi(cfg.get("roi", ""))
        except ValueError:
            roi = None
        if roi:
            x, y, w, h = roi
            cmd += ["--roi", f"{x},{y},{w},{h}",
                    "--width", str(int(2592 * w) // 2 * 2),
                    "--height", str(int(1944 * h) // 2 * 2)]
        else:
            cmd += ["--width", "2592", "--height", "1944"]
        r = subprocess.run(cmd, capture_output=True, timeout=90)
        if r.returncode != 0:
            print(f"capture failed: {r.stderr.decode(errors='replace')[-300:]}")
        else:
            make_thumb(fname)
    except Exception as e:
        print(f"capture error: {e}")
    finally:
        capturing = False
        wake.set()  # control loop restores scheduled brightness now


def capture_loop():
    last_shot = None
    while True:
        # opportunistic thumbnail backfill, at most one per tick
        missing = next((p for p in sorted(TIMELAPSE_DIR.glob("*.jpg"))
                        if not (THUMB_DIR / p.name).exists()), None)
        if missing:
            make_thumb(missing)
        with settings_lock:
            cfg = dict(settings)
        if cfg["capture_enabled"]:
            tz = ZoneInfo(cfg["timezone"])
            now = datetime.now(tz)
            with state_lock:
                on_time, off_time = state["on"], state["off"]
            in_day = on_time is not None and on_time <= now <= off_time
            due = (last_shot is None or
                   now - last_shot >= timedelta(minutes=cfg["capture_interval_min"]))
            if in_day and due:
                last_shot = now
                take_photo(cfg, now)
        time.sleep(15)


# ----------------------------- video render -----------------------------

def render_worker():
    import time as _t
    t0 = _t.monotonic()
    frames = sorted(TIMELAPSE_DIR.glob("*.jpg"))
    with render_lock:
        render.update(state="running", frames=len(frames),
                      started=datetime.now(ZoneInfo(settings["timezone"])).isoformat(),
                      elapsed=None, msg=f"Rendering {len(frames)} frames...")
    try:
        tmp = TIMELAPSE_DIR / "_render_tmp.mp4"
        # Encode pass: small footprint so the 512MB Zero never OOMs.
        # 1280-wide, ultrafast, single thread, no faststart here (the
        # +faststart second pass rewrites the whole file in memory and is
        # what tips the box over). We add faststart as a cheap remux after.
        r = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y",
             "-framerate", "24", "-pattern_type", "glob",
             "-i", str(TIMELAPSE_DIR / "*.jpg"),
             "-vf", "scale=1280:-2",
             "-c:v", "libx264", "-preset", "ultrafast",
             "-crf", "24", "-threads", "1",
             "-pix_fmt", "yuv420p",
             str(tmp)],
            capture_output=True, timeout=3600)
        # Faststart as a stream-copy remux: no re-encode, trivial memory.
        if r.returncode == 0 and tmp.exists():
            r2 = subprocess.run(
                ["ffmpeg", "-loglevel", "error", "-y", "-i", str(tmp),
                 "-c", "copy", "-movflags", "+faststart", str(VIDEO_PATH)],
                capture_output=True, timeout=600)
            tmp.unlink(missing_ok=True)
            if r2.returncode != 0:
                r = r2  # surface the remux error below
        dt = _t.monotonic() - t0
        if r.returncode == 0 and VIDEO_PATH.exists():
            mb = VIDEO_PATH.stat().st_size / 1e6
            with render_lock:
                render.update(state="done", elapsed=round(dt, 1),
                              msg=f"{len(frames)} frames, {mb:.1f} MB, {dt:.0f}s")
        else:
            err = r.stderr.decode(errors="replace")[-200:]
            with render_lock:
                render.update(state="error", elapsed=round(dt, 1),
                              msg=err or "ffmpeg failed")
    except Exception as e:
        with render_lock:
            render.update(state="error", elapsed=round(_t.monotonic() - t0, 1),
                          msg=str(e))


def start_render():
    with render_lock:
        if render["state"] == "running":
            return False
        render.update(state="running", msg="Starting...")
    threading.Thread(target=render_worker, daemon=True).start()
    return True


# ----------------------------- dashboard -----------------------------

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html", tzs=TIMEZONES)


@app.route("/photo/latest")
def latest_photo():
    count, latest, _ = photo_inventory()
    if not count:
        return "no photos yet", 404
    resp = send_file(latest, mimetype="image/jpeg")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.route("/api/photos")
def photo_list():
    return jsonify(names=[p.name for p in sorted(THUMB_DIR.glob("*.jpg"))])


@app.route("/thumb/<name>")
def thumb(name):
    resp = send_from_directory(THUMB_DIR, name, mimetype="image/jpeg")
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.route("/api/grid", methods=["POST"])
def update_grid():
    data = request.get_json(silent=True) or {}
    try:
        corners = data["corners"]
        if len(corners) != 4:
            raise ValueError
        corners = [[float(x), float(y)] for x, y in corners]
        for x, y in corners:
            if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
                raise ValueError
        rows = int(data.get("rows", 4))
        cols = int(data.get("cols", 4))
        if not (1 <= rows <= 12 and 1 <= cols <= 12):
            raise ValueError
        names = {str(k): str(v)[:40] for k, v in (data.get("names") or {}).items()}
        show = bool(data.get("show", True))
    except (KeyError, TypeError, ValueError):
        return jsonify(error="Invalid grid data."), 400
    with settings_lock:
        settings["grid"] = {"corners": corners, "rows": rows, "cols": cols,
                            "names": names, "show": show}
        CONFIG_PATH.write_text(json.dumps(settings, indent=2))
    return jsonify(ok=True)


@app.route("/api/detect_grid", methods=["POST"])
def detect_grid():
    count, latest, _ = photo_inventory()
    if not count or latest is None:
        return jsonify(ok=False, error="No photo to detect from yet."), 200
    helper = Path(__file__).with_name("detect_corners.py")
    if not helper.exists():
        return jsonify(ok=False, error="Detector not installed."), 200
    try:
        r = subprocess.run([sys.executable, str(helper), str(latest)],
                           capture_output=True, timeout=60)
        out = r.stdout.decode(errors="replace").strip()
        return jsonify(json.loads(out) if out else
                       {"ok": False, "error": "Detector returned nothing."}), 200
    except Exception as e:
        return jsonify(ok=False, error=f"Detector error: {e}"), 200


@app.route("/api/render", methods=["POST"])
def api_render():
    count, _, _ = photo_inventory()
    if count < 2:
        return jsonify(error="Need at least 2 photos to render."), 400
    start_render()
    return jsonify(ok=True)


@app.route("/video")
def video():
    if not VIDEO_PATH.exists():
        return "no video rendered yet", 404
    return send_file(VIDEO_PATH, mimetype="video/mp4", as_attachment=True,
                     download_name="grow_timelapse.mp4")


@app.route("/api/status")
def status():
    with state_lock:
        s = dict(state)
    with settings_lock:
        cfg = dict(settings)
    if s["on"] is None:
        return jsonify(error="warming up"), 503
    tz = ZoneInfo(cfg["timezone"])
    count, _, latest_time = photo_inventory()
    return jsonify(
        now=datetime.now(tz).isoformat(),
        brightness=s["brightness"],
        on=s["on"].isoformat(), off=s["off"].isoformat(),
        sunrise=s["sunrise"].isoformat(), sunset=s["sunset"].isoformat(),
        ramp=cfg["ramp_min"], max=cfg["max_bright"],
        gpio=GPIO_PIN, freq=PWM_FREQ, loop=LOOP_SECONDS,
        photo_count=count,
        latest_photo_time=latest_time.isoformat() if latest_time else None,
        capturing=capturing,
        render=dict(render),
        video_time=(datetime.fromtimestamp(VIDEO_PATH.stat().st_mtime)
                    .isoformat() if VIDEO_PATH.exists() else None),
        settings=cfg,
        sensors={k: {"ts": ts, "value": v}
                 for k, (ts, v) in db.latest().items()},
        sensor_stub=sensors.stub_mode(),
        water={
            "float": sensors.read_float(),
            "pump_hw": PUMP_HW,
            "pump_running": pump_state["running"],
            "pump_last": pump_state["last_detail"],
            "today_seconds": round(pump_state["today_seconds"], 1),
            "auto_water": cfg.get("auto_water", False),
        },
    )


@app.route("/api/pump", methods=["POST"])
def pump_test():
    if not PUMP_HW:
        return jsonify(ok=False, error="pump hardware not available"), 200
    data = request.get_json(silent=True) or {}
    try:
        secs = float(data.get("seconds", 3))
    except (TypeError, ValueError):
        secs = 3.0
    force = bool(data.get("force", False))
    threading.Thread(target=lambda: run_pump(secs, "manual", force),
                     daemon=True).start()
    return jsonify(ok=True, started=True)


@app.route("/api/series")
def series():
    sensor = request.args.get("sensor", "")
    try:
        hours = max(1, min(24 * 90, int(request.args.get("hours", 168))))
    except ValueError:
        hours = 168
    if not sensor:
        return jsonify(error="sensor required"), 400
    return jsonify(sensor=sensor, hours=hours, points=db.series(sensor, hours))


@app.route("/api/settings", methods=["POST"])
def update_settings():
    data = request.get_json(silent=True) or {}
    new = {}
    try:
        new["latitude"]  = float(data["latitude"])
        new["longitude"] = float(data["longitude"])
        new["timezone"]  = str(data["timezone"]).strip()
        new["max_bright"] = int(data["max_bright"])
        new["ramp_min"]   = int(data["ramp_min"])
        new["sunrise_offset_min"] = int(data["sunrise_offset_min"])
        new["sunset_offset_min"]  = int(data["sunset_offset_min"])
        new["capture_enabled"]      = bool(data["capture_enabled"])
        new["capture_interval_min"] = int(data["capture_interval_min"])
        new["capture_brightness"]   = int(data["capture_brightness"])
        new["roi"] = str(data.get("roi", "")).strip()
    except (KeyError, TypeError, ValueError):
        return jsonify(error="All fields are required and must be numbers "
                             "(timezone is text)."), 400
    if not -90 <= new["latitude"] <= 90:
        return jsonify(error="Latitude must be between -90 and 90."), 400
    if not -180 <= new["longitude"] <= 180:
        return jsonify(error="Longitude must be between -180 and 180."), 400
    if not 1 <= new["max_bright"] <= 100:
        return jsonify(error="Max brightness must be 1 to 100."), 400
    if not 0 <= new["ramp_min"] <= 240:
        return jsonify(error="Ramp must be 0 to 240 minutes."), 400
    if not 5 <= new["capture_interval_min"] <= 720:
        return jsonify(error="Photo interval must be 5 to 720 minutes."), 400
    if not 1 <= new["capture_brightness"] <= 100:
        return jsonify(error="Photo brightness must be 1 to 100."), 400
    try:
        parse_roi(new["roi"])
    except ValueError:
        return jsonify(error="Crop must be 'x,y,w,h' as fractions 0-1 "
                             "(e.g. 0.22,0.08,0.57,0.82), or blank for "
                             "full frame."), 400
    try:
        ZoneInfo(new["timezone"])
    except Exception:
        return jsonify(error=f"Unknown timezone '{new['timezone']}'. "
                             "Use an IANA name like America/Los_Angeles."), 400
    with settings_lock:
        settings.update(new)
        CONFIG_PATH.write_text(json.dumps(settings, indent=2))
    wake.set()
    return jsonify(ok=True)


def cleanup(*_):
    set_brightness(0)
    pwm.stop()
    sys.exit(0)


signal.signal(signal.SIGINT, cleanup)
signal.signal(signal.SIGTERM, cleanup)

if __name__ == "__main__":
    threading.Thread(target=control_loop, daemon=True).start()
    threading.Thread(target=capture_loop, daemon=True).start()
    threading.Thread(target=sample_loop, daemon=True).start()
    threading.Thread(target=watering_loop, daemon=True).start()
    print(f"Dashboard at http://0.0.0.0:{HTTP_PORT}")
    app.run(host="0.0.0.0", port=HTTP_PORT, threaded=True)
