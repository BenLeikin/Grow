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
import secrets
import subprocess
import sys
import signal
import threading
import time
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path
from zoneinfo import ZoneInfo, available_timezones

from rpi_hardware_pwm import HardwarePWM
from astral import LocationInfo
from astral.sun import sun
from flask import (Flask, jsonify, render_template, request, session,
                   send_file, send_from_directory)
from werkzeug.security import check_password_hash

import db
import sensors
import notify
import ai_report
import discord_alert

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
    "discord_webhook": "",      # set to enable Discord alerts (see discord_alert.py)
    "password_hash": "",        # set to enable login (see README); blank = open
    "cookie_secure": True,      # True for HTTPS; set False only for local http testing
    "auto_water": False,        # master switch; keep OFF until moisture calibrated
    "moisture_threshold_pct": 30,  # CALIBRATION TODO: "dry" trigger, per-probe
    "pump_max_seconds": 20,     # hard cap on a single dose (anti-flood/dry-run)
    "pump_cooldown_min": 30,    # min wait between auto doses (soil wicks slowly)
    "pump_daily_max_seconds": 180,  # runaway backstop
    "fill_max_seconds": 60,     # hard cap on a fill-to-float run (if float never trips)
    "dryness_cal": {},          # per-cell {wet,dry} brightness anchors -> camera moisture %
    "ai_enabled": False,        # daily Claude vision report (needs an API key, see ai_report.py)
    "ai_model": "claude-opus-4-8",
    "ai_report_hour": 8,        # local hour (0-23) to run the daily report
    "ai_report_minute": 0,      # minute (0-59) within that hour
    "ai_notify": True,          # push the report summary via ntfy
    "ai_notes": "Peat/vermiculite/perlite seed starter in a cell tray, bottom-watered. "
                "Mixed germination: some cells sprouted, some still germinating.",
    "grid": {                   # cell-mapping overlay
        "corners": [[0.12, 0.10], [0.88, 0.10], [0.88, 0.92], [0.12, 0.92]],
        "rows": 4, "cols": 4, "names": {}, "show": True, "locked": False,
    },
}

GPIO_PIN      = 18
PWM_FREQ      = 1000
LOOP_SECONDS  = 30
HTTP_PORT     = 5000
CONFIG_PATH   = Path(__file__).with_name("config.json")
TIMELAPSE_DIR = Path(__file__).with_name("timelapse")
AI_REPORT_PATH = Path(__file__).with_name("ai_report.json")
report_lock = threading.Lock()
report_state = {"generating": False}
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
GROWTH_SCRIPT = Path(__file__).with_name("growth.py")

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


def run_pump_until_full(reason="fill", force=False):
    """Run the pump until the float reads full, then stop. A hard time cap is
    the backstop: if the float never trips within fill_max_seconds the pump
    stops anyway and the run is flagged, because that means the source is empty,
    the tube is off, or the float failed. Float reading None (sensor lost) is
    treated as 'stop' (fail-safe). Blocks; call in a thread. Logs the run."""
    with settings_lock:
        cap = float(settings.get("fill_max_seconds", 60))
        daily_cap = float(settings.get("pump_daily_max_seconds", 180))
    with pump_lock:
        if not PUMP_HW:
            return False, "pump hardware not available"
        if pump_state["running"]:
            return False, "pump already running"
        if pump_state["day"] != _today_str():
            pump_state["day"] = _today_str()
            pump_state["today_seconds"] = 0.0
        f0 = sensors.read_float()
        if f0 is None and not force:
            return False, "no float sensor; refusing to fill blind"
        if f0 is not None and f0 < 1:
            return False, "tray already full"
        remaining = daily_cap - pump_state["today_seconds"]
        if not force and remaining <= 0:
            return False, "daily pump limit reached"
        run_cap = cap if force else min(cap, remaining)
        pump_state["running"] = True
    elapsed = 0.0
    tripped = False
    confirm = 0                              # consecutive "full" reads needed
    CONFIRM_NEEDED = 4                        # ~0.4s steady, rejects slosh/bobble
    try:
        _pump.on()
        t0 = time.time()
        while True:
            elapsed = time.time() - t0
            if elapsed >= run_cap:
                break                        # cap hit, float never stayed full
            fv = sensors.read_float()
            if fv is None or fv < 1:         # full (open) or sensor lost
                confirm += 1
                if confirm >= CONFIRM_NEEDED:
                    tripped = (fv is not None and fv < 1)
                    break                    # full held steady -> stop
            else:
                confirm = 0                  # a not-full read resets the count
            time.sleep(0.1)                  # poll the float ~10x/sec
    finally:
        _pump.off()
        with pump_lock:
            pump_state["running"] = False
            pump_state["last_run"] = time.time()
            pump_state["today_seconds"] += elapsed
            detail = (f"{reason}: full at {elapsed:.1f}s" if tripped
                      else f"{reason}: STOPPED at {elapsed:.1f}s cap, no float trip")
            pump_state["last_detail"] = detail
    try:
        db.log_event("pump", detail)
    except Exception:
        pass
    if tripped:
        return True, f"filled in {elapsed:.1f}s"
    return False, f"ran to {elapsed:.1f}s cap without float trip (source empty?)"


def _cam_moisture(cell, b, cal):
    c = cal.get(cell) or {}
    wet = c.get("wet")
    if wet is None:
        return None
    dry = c.get("dry", wet + 15)
    if dry <= wet:
        return None
    return round(max(0.0, min(100.0, 100.0 * (dry - b) / (dry - wet))))


def gather_report_data():
    """Assemble the controller snapshot the AI report is built from."""
    with settings_lock:
        cfg = dict(settings)
    with state_lock:
        st = dict(state)
    tz = ZoneInfo(cfg["timezone"])
    now = datetime.now(tz)
    cal = cfg.get("dryness_cal") or {}
    cam, raw, growth = {}, {}, {}
    for k, (ts, v) in db.latest().items():
        if k.startswith("dry:"):
            cell = k[4:]
            m = _cam_moisture(cell, v, cal)
            (cam if m is not None else raw)[cell] = m if m is not None else round(v, 1)
        elif k.startswith("growth:"):
            growth[k[7:]] = round(v, 1)
    fv = sensors.read_float()
    flabel = "no sensor" if fv is None else ("not full" if fv >= 1 else "full")
    grid = cfg.get("grid") or {}
    bright = round(st.get("brightness") or 0)
    return {
        "date": now.strftime("%Y-%m-%d %H:%M"),
        "days_running": None,
        "location": f"lat {cfg['latitude']}, lon {cfg['longitude']} ({cfg['timezone']})",
        "light": {"phase": "day" if bright > 0 else "night", "brightness": bright,
                  "on": st["on"].strftime("%H:%M") if st.get("on") else "?",
                  "off": st["off"].strftime("%H:%M") if st.get("off") else "?",
                  "capture_brightness": cfg.get("capture_brightness")},
        "grid": {"rows": grid.get("rows"), "cols": grid.get("cols"),
                 "names": grid.get("names") or {}},
        "camera_moisture": cam, "dryness_raw": raw, "growth": growth,
        "float": flabel,
        "pump_today_s": round(pump_state.get("today_seconds", 0.0), 1),
        "pump_last": pump_state.get("last_detail") or "none",
        "notes": cfg.get("ai_notes", ""),
    }


def run_report(reason="daily"):
    """Generate one AI report: gather data + latest photo, call the API, store
    the result, and push the summary. Serialized via report_lock."""
    with report_lock:
        if report_state["generating"]:
            return {"ok": False, "error": "a report is already being generated"}
        report_state["generating"] = True
    try:
        with settings_lock:
            cfg = dict(settings)
        if not ai_report.have_key():
            return {"ok": False, "error": "no API key on the controller"}
        photos = sorted(TIMELAPSE_DIR.glob("*.jpg"))
        photo = photos[-1] if photos else None
        result = ai_report.generate(photo, gather_report_data(),
                                    model=cfg.get("ai_model"))
        result["reason"] = reason
        try:
            AI_REPORT_PATH.write_text(json.dumps(result, indent=2))
        except Exception as e:
            print(f"report save error: {e}")
        if result.get("ok") and cfg.get("ai_notify", True):
            rep = result.get("report") or {}
            summary = rep.get("summary") or "Daily report ready."
            health = rep.get("overall_health")
            tag = {"good": "seedling", "watch": "eyes",
                   "problem": "warning"}.get(health, "seedling")
            notify.send("Garden report", summary, tags=tag)
            # Discord: same summary as a colour-coded embed with key details
            fields = []
            g = rep.get("germination") or {}
            if g.get("sprouted") is not None and g.get("total_cells") is not None:
                fields.append({"name": "Germination",
                               "value": f"{g['sprouted']}/{g['total_cells']}",
                               "inline": True})
            if rep.get("growth_stage"):
                fields.append({"name": "Stage", "value": rep["growth_stage"],
                               "inline": True})
            if (rep.get("light") or {}).get("assessment"):
                fields.append({"name": "Light", "value": rep["light"]["assessment"],
                               "inline": True})
            if (rep.get("water") or {}).get("assessment"):
                fields.append({"name": "Water", "value": rep["water"]["assessment"],
                               "inline": True})
            recs = rep.get("recommendations") or []
            if recs:
                fields.append({"name": "Recommendations",
                               "value": "\n".join("\u2022 " + str(r) for r in recs[:4]),
                               "inline": False})
            sp = rep.get("species") or []
            named = [f"{s.get('cell', '?')}: {s.get('guess')}"
                     + (f" ({s.get('confidence')})" if s.get('confidence') else "")
                     for s in sp if s.get('guess') and s.get('guess') != 'unsure']
            if named:
                fields.append({"name": "Species (guesses)",
                               "value": "\n".join(named[:10]), "inline": False})
            discord_alert.send("\U0001F331 Garden report", summary,
                               level=(health or "info"), fields=fields)
        try:
            db.log_event("ai_report",
                         reason + (": ok" if result.get("ok")
                                   else ": " + str(result.get("error"))[:80]))
        except Exception:
            pass
        return result
    finally:
        with report_lock:
            report_state["generating"] = False


def report_loop():
    """Run the AI report once a day when the clock crosses ai_report_hour:minute.

    A restart does NOT trigger a report: if the service starts up already past
    today's scheduled time, today is marked done and the last stored report is
    kept as-is. New reports come only from crossing the time while running, or
    from the manual button."""
    last_day = None
    primed = False
    while True:
        try:
            with settings_lock:
                cfg = dict(settings)
            if cfg.get("ai_enabled") and ai_report.have_key():
                tz = ZoneInfo(cfg["timezone"])
                now = datetime.now(tz)
                target = (int(cfg.get("ai_report_hour", 8)) * 60
                          + int(cfg.get("ai_report_minute", 0)))
                nowmin = now.hour * 60 + now.minute
                if not primed:
                    # first pass: if we're already past today's time, treat
                    # today as handled so a restart doesn't fire a fresh report
                    if nowmin >= target:
                        last_day = now.date()
                    primed = True
                if nowmin >= target and last_day != now.date():
                    print("running daily AI report")
                    run_report("daily")
                    last_day = now.date()
        except Exception as e:
            print(f"report_loop error: {e}")
        time.sleep(60)


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
    saved = None
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
            saved = fname
    except Exception as e:
        print(f"capture error: {e}")
    finally:
        capturing = False
        wake.set()  # control loop restores scheduled brightness now
    return saved


def record_growth(path, cfg, now):
    """Measure per-cell canopy coverage from a just-captured photo and log it.
    Runs growth.py as a subprocess so OpenCV memory is freed afterwards."""
    grid = cfg.get("grid") or {}
    if not grid.get("corners"):
        return
    payload = {"corners": grid["corners"],
               "rows": grid.get("rows", 4), "cols": grid.get("cols", 4)}
    try:
        r = subprocess.run([sys.executable, str(GROWTH_SCRIPT), str(path),
                            json.dumps(payload)],
                           capture_output=True, timeout=120)
        out = json.loads((r.stdout or b"{}").decode(errors="replace") or "{}")
    except Exception as e:
        print(f"growth analyze error: {e}")
        return
    if not out.get("ok"):
        if out.get("error"):
            print(f"growth: {out['error']}")
        return
    readings = out.get("readings") or {}
    if readings:
        db.log_many(list(readings.items()), ts=int(now.timestamp()))


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
                path = take_photo(cfg, now)
                if path:
                    record_growth(path, cfg, now)
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
             # JPEG stills are full-range (yuvj420p/pc); browsers render that as
             # black. Remap to limited-range yuv420p and tag it. Height is forced
             # to a multiple of 16 (-16, not -2): a non-mod16 height makes the
             # encoder signal a crop that some hardware decoders render as black.
             "-vf", "scale=1280:-16:in_range=full:out_range=tv",
             "-c:v", "libx264", "-preset", "ultrafast",
             "-crf", "24", "-threads", "1",
             "-pix_fmt", "yuv420p", "-color_range", "tv",
             # Fully specify the colour metadata (BT.601, matching the JPEG
             # source). An unspecified matrix makes some hardware decoders
             # (VLC's, browsers') render the video as black.
             "-colorspace", "smpte170m", "-color_primaries", "smpte170m",
             "-color_trc", "smpte170m",
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

SECRET_PATH = Path(__file__).with_name(".secret")
def _load_secret():
    try:
        s = SECRET_PATH.read_text().strip()
        if s:
            return s
    except Exception:
        pass
    s = secrets.token_hex(32)
    try:
        SECRET_PATH.write_text(s)
        SECRET_PATH.chmod(0o600)
    except Exception:
        pass
    return s

app.secret_key = _load_secret()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(settings.get("cookie_secure", True)),
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)


def auth_enabled():
    with settings_lock:
        return bool(settings.get("password_hash"))


def is_authed():
    # If no password is configured, the dashboard is open (legacy behaviour).
    return (not auth_enabled()) or bool(session.get("authed"))


def require_auth(fn):
    @wraps(fn)
    def wrapper(*a, **k):
        if not is_authed():
            return jsonify(error="login required"), 401
        return fn(*a, **k)
    return wrapper


@app.route("/api/dryness_cal", methods=["POST"])
@require_auth
def dryness_cal_set():
    """Capture the current per-cell camera brightness as the 'wet' (100%) or
    'dry' (0%) anchor, so the dashboard can show a camera-moisture percentage."""
    data = request.get_json(silent=True) or {}
    point = data.get("point")
    if point not in ("wet", "dry"):
        return jsonify(ok=False, error="point must be 'wet' or 'dry'"), 200
    cells = {k[4:]: v for k, (ts, v) in db.latest().items() if k.startswith("dry:")}
    if not cells:
        return jsonify(ok=False, error="no camera readings yet; wait for a capture"), 200
    with settings_lock:
        cal = settings.setdefault("dryness_cal", {})
        for cell, v in cells.items():
            cal.setdefault(cell, {})[point] = v
        CONFIG_PATH.write_text(json.dumps(settings, indent=2))
    return jsonify(ok=True, point=point, cells=len(cells))


@app.route("/api/report")
def api_report_get():
    """Latest stored AI report (or nulls if none yet), plus generating flag."""
    try:
        data = json.loads(AI_REPORT_PATH.read_text())
    except Exception:
        data = {"ok": None, "report": None, "ts": None}
    data["generating"] = report_state["generating"]
    data["have_key"] = ai_report.have_key()
    return jsonify(data)


@app.route("/api/ai_settings", methods=["POST"])
@require_auth
def update_ai_settings():
    data = request.get_json(silent=True) or {}
    with settings_lock:
        if "ai_enabled" in data:
            settings["ai_enabled"] = bool(data["ai_enabled"])
        if "ai_notify" in data:
            settings["ai_notify"] = bool(data["ai_notify"])
        if "ai_report_hour" in data:
            try:
                settings["ai_report_hour"] = max(0, min(23, int(data["ai_report_hour"])))
            except (TypeError, ValueError):
                pass
        if "ai_report_minute" in data:
            try:
                settings["ai_report_minute"] = max(0, min(59, int(data["ai_report_minute"])))
            except (TypeError, ValueError):
                pass
        if "ai_notes" in data:
            settings["ai_notes"] = str(data["ai_notes"])[:1000]
        CONFIG_PATH.write_text(json.dumps(settings, indent=2))
        out = {k: settings[k] for k in
               ("ai_enabled", "ai_notify", "ai_report_hour", "ai_report_minute", "ai_notes")}
    return jsonify(ok=True, **out)


@app.route("/api/report", methods=["POST"])
@require_auth
def api_report_run():
    if not ai_report.have_key():
        return jsonify(ok=False, error="no API key set on the controller"), 200
    return jsonify(run_report("manual"))


@app.route("/api/float")
def api_float():
    return jsonify(float=sensors.read_float())


@app.route("/api/login", methods=["POST"])
def login():
    with settings_lock:
        h = settings.get("password_hash", "")
    if not h:
        return jsonify(ok=True, authed=True)  # no password set -> open
    pw = (request.get_json(silent=True) or {}).get("password", "")
    time.sleep(0.5)  # crude throttle against rapid guessing
    if check_password_hash(h, pw):
        session["authed"] = True
        session.permanent = True
        return jsonify(ok=True, authed=True)
    return jsonify(ok=False, error="wrong password"), 401


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify(ok=True, authed=False)


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
@require_auth
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
        locked = bool(data.get("locked", False))
    except (KeyError, TypeError, ValueError):
        return jsonify(error="Invalid grid data."), 400
    with settings_lock:
        cur = settings.get("grid") or {}
        cur_locked = bool(cur.get("locked", False))
        # Server-side lock: while locked, the geometry cannot be changed. A
        # stale tab or stray save can't move a locked grid; you must unlock
        # first (which leaves the geometry untouched).
        if cur_locked:
            def _same(a, b):
                try:
                    return all(abs(p[i] - q[i]) < 1e-9
                               for p, q in zip(a, b) for i in (0, 1))
                except Exception:
                    return False
            geom_changed = (not _same(corners, cur.get("corners", [])) or
                            rows != cur.get("rows") or cols != cur.get("cols"))
            if geom_changed:
                return jsonify(error="grid is locked; unlock before editing"), 409
        settings["grid"] = {"corners": corners, "rows": rows, "cols": cols,
                            "names": names, "show": show, "locked": locked}
        CONFIG_PATH.write_text(json.dumps(settings, indent=2))
    # audit trail so a future revert can be traced to who/when/what
    try:
        db.log_event("grid", f"saved corners[0]={corners[0]} "
                             f"rows={rows} cols={cols} locked={locked}")
    except Exception:
        pass
    print(f"grid saved: corners[0]={corners[0]} rows={rows} cols={cols} locked={locked}")
    return jsonify(ok=True)


@app.route("/api/detect_grid", methods=["POST"])
@require_auth
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
@require_auth
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
        authed=is_authed(),
        auth_enabled=auth_enabled(),
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
@require_auth
def pump_test():
    if not PUMP_HW:
        return jsonify(ok=False, error="pump hardware not available"), 200
    data = request.get_json(silent=True) or {}
    try:
        secs = float(data.get("seconds", 3))
    except (TypeError, ValueError):
        secs = 3.0
    force = bool(data.get("force", False))
    if data.get("until_full"):
        threading.Thread(target=lambda: run_pump_until_full("fill", force),
                         daemon=True).start()
        return jsonify(ok=True, started=True, mode="fill")
    threading.Thread(target=lambda: run_pump(secs, "manual", force),
                     daemon=True).start()
    return jsonify(ok=True, started=True, mode="timed")


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
@require_auth
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
    threading.Thread(target=report_loop, daemon=True).start()
    print(f"Dashboard at http://0.0.0.0:{HTTP_PORT}")
    app.run(host="0.0.0.0", port=HTTP_PORT, threaded=True)
