#!/usr/bin/env bash
# One-shot rebuild script for the grow light controller (Trixie-compatible).
# Usage: copy this single file to the Pi, then:  bash setup.sh
# Safe to re-run any time. Preserves existing config.json (dashboard settings).

set -euo pipefail

if [[ $EUID -eq 0 ]]; then
  echo "Run as your normal user, not root. The script uses sudo where needed."
  exit 1
fi

APP_DIR="$HOME/growlight"
RUN_USER="$(whoami)"
NEED_REBOOT=0

echo "==> [1/6] System packages"
sudo apt-get update
sudo apt-get install -y python3-venv python3-pip rpicam-apps ffmpeg

echo "==> [2/6] Hardware PWM overlay (GPIO18)"
CONFIG_TXT=/boot/firmware/config.txt
[[ -f "$CONFIG_TXT" ]] || CONFIG_TXT=/boot/config.txt
OVERLAY="dtoverlay=pwm,pin=18,func=2"
if grep -qxF "$OVERLAY" "$CONFIG_TXT"; then
  echo "    overlay already present in $CONFIG_TXT"
else
  echo "$OVERLAY" | sudo tee -a "$CONFIG_TXT" > /dev/null
  echo "    overlay added to $CONFIG_TXT (reboot required)"
  NEED_REBOOT=1
fi

echo "==> [3/6] Project directory and venv at $APP_DIR"
mkdir -p "$APP_DIR"
[[ -d "$APP_DIR/venv" ]] || python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install --quiet --upgrade pip
"$APP_DIR/venv/bin/pip" install --quiet astral rpi-hardware-pwm flask

echo "==> [4/6] Writing growlight.py"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SRC_DIR/growlight.py" && "$SRC_DIR/growlight.py" != "$APP_DIR/growlight.py" ]]; then
  echo "    using growlight.py from $SRC_DIR (repo checkout)"
  cp "$SRC_DIR/growlight.py" "$APP_DIR/growlight.py"
else
  echo "    using embedded copy"
  cat > "$APP_DIR/growlight.py" << 'GROWLIGHT_PY'
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
from flask import (Flask, jsonify, render_template_string, request,
                   send_file, send_from_directory)

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
render = {"state": "idle", "msg": "", "frames": 0}   # idle|running|done|error
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
    frames = sorted(TIMELAPSE_DIR.glob("*.jpg"))
    with render_lock:
        render.update(state="running", frames=len(frames),
                      msg=f"Rendering {len(frames)} frames...")
    try:
        r = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y",
             "-framerate", "24", "-pattern_type", "glob",
             "-i", str(TIMELAPSE_DIR / "*.jpg"),
             "-vf", "scale=1280:-2",
             "-c:v", "libx264", "-preset", "ultrafast",
             "-pix_fmt", "yuv420p", str(VIDEO_PATH)],
            capture_output=True, timeout=3600)
        if r.returncode == 0 and VIDEO_PATH.exists():
            mb = VIDEO_PATH.stat().st_size / 1e6
            with render_lock:
                render.update(state="done",
                              msg=f"{len(frames)} frames, {mb:.1f} MB")
        else:
            err = r.stderr.decode(errors="replace")[-200:]
            with render_lock:
                render.update(state="error", msg=err or "ffmpeg failed")
    except Exception as e:
        with render_lock:
            render.update(state="error", msg=str(e))


def start_render():
    with render_lock:
        if render["state"] == "running":
            return False
        render.update(state="running", msg="Starting...")
    threading.Thread(target=render_worker, daemon=True).start()
    return True


# ----------------------------- dashboard -----------------------------

app = Flask(__name__)

PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seedling Light</title>
<style>
  :root{
    --soil:#4a3826; --fir:#27432e; --leaf:#3f7d45; --sprout:#7fb069;
    --sun:#e8b04b; --mist:#f0f6ea; --glass:#fffefb; --line:#d8e6cd;
    --blush:#e9a17c;
  }
  *{box-sizing:border-box;margin:0}
  body{
    background:
      radial-gradient(circle at 8% 4%, #e2efd4 0 110px, transparent 130px),
      radial-gradient(circle at 94% 90%, #e6f0db 0 140px, transparent 160px),
      var(--mist);
    color:var(--fir);
    font:16px/1.5 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    padding:20px;max-width:680px;margin:0 auto;
  }
  header{display:flex;align-items:baseline;justify-content:space-between;
    padding-bottom:10px;margin-bottom:6px}
  h1{font-family:Georgia,'Times New Roman',serif;font-weight:600;font-size:27px}
  #clock{font-variant-numeric:tabular-nums;font-size:15px;color:var(--leaf)}
  .vine{height:14px;margin-bottom:14px;background:
    radial-gradient(circle 5px at 10px 7px, var(--sprout) 4px, transparent 5px) repeat-x;
    background-size:26px 14px;border-radius:7px;opacity:.7}
  .card{background:var(--glass);border:1.5px solid var(--line);border-radius:18px;
    padding:18px;margin-bottom:16px;box-shadow:0 2px 0 var(--line)}
  .phase{display:flex;align-items:center;gap:14px}
  .bulb{width:56px;height:56px;border-radius:50%;flex:none;position:relative;
    background:radial-gradient(circle at 35% 35%, #fff8e0, var(--sun) 72%);
    box-shadow:0 0 calc(var(--glow,0)*28px) calc(var(--glow,0)*9px) rgba(232,176,75,.55);
    border:2px solid var(--soil);opacity:calc(.3 + var(--glow,0)*.7);
    transition:box-shadow .8s,opacity .8s}
  .bulb::after{content:"\1F331 ";position:absolute;left:50%;top:54%;
    transform:translate(-50%,-50%) scale(calc(.55 + var(--glow,0)*.65));
    font-size:24px;transition:transform .8s}
  .phase b{font-size:20px;display:block}
  .phase span{color:var(--leaf);font-size:14px}
  .pct{margin-left:auto;text-align:right}
  .pct b{font-size:32px;font-family:Georgia,serif;font-weight:600}
  svg{width:100%;height:auto;display:block}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 18px;font-size:14px}
  .grid dt{color:var(--leaf)}
  .grid dd{font-variant-numeric:tabular-nums;font-weight:600}
  h2{font-family:Georgia,serif;font-size:18px;font-weight:600;margin-bottom:12px}
  summary{cursor:pointer;list-style:none}
  summary::-webkit-details-marker{display:none}
  summary h2{display:inline;margin:0}
  summary::after{content:" \25BE";color:var(--leaf);font-size:15px}
  details[open] summary::after{content:" \25B4"}
  details[open] summary{display:block;margin-bottom:12px}
  #photo,#vframe{width:100%;border-radius:12px;border:1.5px solid var(--line);
    display:block;background:#dfe9d4;min-height:120px}
  #photoinfo{font-size:13px;color:var(--leaf);margin-top:8px}
  .pctrl{display:flex;align-items:center;gap:12px;margin-top:12px}
  .pctrl button{margin-top:0;padding:8px 16px;white-space:nowrap}
  .pctrl input[type=range]{flex:1;width:auto;margin:0;padding:0;border:0;
    background:transparent;accent-color:var(--leaf)}
  #pframe{font-size:13px;color:var(--leaf);min-width:108px;text-align:right;
    font-variant-numeric:tabular-nums}
  form .frow{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px;margin-bottom:10px}
  label{font-size:13px;color:var(--leaf);display:block}
  input,select{width:100%;padding:8px 10px;margin-top:3px;font-size:15px;color:var(--fir);
    background:#fff;border:1.5px solid var(--line);border-radius:10px}
  input:focus,select:focus{outline:2px solid var(--sprout);border-color:var(--sprout)}
  input[type=checkbox]{width:auto;accent-color:var(--leaf);transform:scale(1.3)}
  .checkrow{display:flex;align-items:center;gap:10px;margin-top:18px;
    font-size:14px;color:var(--fir)}
  .tzrow{grid-column:1 / -1}
  button{margin-top:6px;padding:10px 22px;font-size:15px;font-weight:600;
    color:#fff;background:var(--leaf);border:0;border-radius:12px;cursor:pointer;
    box-shadow:0 2px 0 var(--fir)}
  button:hover{background:#346a3b}
  button:focus-visible{outline:3px solid var(--sun)}
  #msg{margin-left:12px;font-size:14px}
  #msg.ok{color:var(--leaf)} #msg.err{color:#a4452c}
  footer{text-align:center;color:var(--leaf);font-size:12px;margin-top:6px}
  @media (prefers-reduced-motion:no-preference){
    .nowdot{animation:pulse 2.4s ease-in-out infinite}
    @keyframes pulse{50%{opacity:.45}}
  }
  @media (max-width:480px){form .frow{grid-template-columns:1fr}}
  @media (min-width:1100px){
    body{max-width:1150px;padding:16px 24px}
    header{padding-bottom:6px;margin-bottom:4px}
    .vine{margin-bottom:12px}
    .glayout{display:grid;grid-template-columns:0.85fr 1.4fr;gap:14px;
      grid-template-areas:
        "phase media"
        "chart media"
        "facts media"
        "set   set";
      align-items:start}
    .glayout .card{margin-bottom:0}
    .aphase{grid-area:phase}.achart{grid-area:chart}.afacts{grid-area:facts}
    .amedia{grid-area:media;display:flex;flex-direction:column;gap:14px}
    .aset{grid-area:set}
    #photo,#vframe{max-height:44vh;object-fit:contain}
  }
</style>
</head>
<body>
<header>
  <h1>&#127793; Seedling Light</h1>
  <div id="clock">--:--:--</div>
</header>
<div class="vine" aria-hidden="true"></div>

<main class="glayout">

<div class="card phase aphase">
  <div class="bulb" id="bulb"></div>
  <div>
    <b id="phase">Loading</b>
    <span id="next">&nbsp;</span>
  </div>
  <div class="pct"><b id="pct">--%</b><br><span style="font-size:12px;color:var(--leaf)">brightness</span></div>
</div>

<div class="card achart">
  <svg id="chart" viewBox="0 0 640 240" role="img" aria-label="Today's light curve"></svg>
</div>

<div class="amedia">

<div class="card asnap" id="photocard" style="display:none">
  <h2>&#128247; Latest snapshot</h2>
  <img id="photo" alt="Latest seedling photo">
  <div id="photoinfo"></div>
</div>

<div class="card avideo" id="videocard" style="display:none">
  <h2>&#127916; Timelapse</h2>
  <img id="vframe" alt="Timelapse frame">
  <div class="pctrl">
    <button type="button" id="playbtn">&#9654; Grow</button>
    <input type="range" id="scrub" min="0" max="0" value="0" step="1"
           aria-label="Timelapse position">
    <span id="pframe"></span>
  </div>
  <div class="pctrl">
    <button type="button" id="renderbtn">&#127909; Render video</button>
    <span id="renderinfo" style="font-size:13px;color:var(--leaf)"></span>
    <a id="dlbtn" href="/video" download
       style="display:none;margin-left:auto;font-size:14px;font-weight:600;
       color:var(--leaf)">&#11015; Download MP4</a>
  </div>
</div>

</div>

<div class="card afacts">
  <dl class="grid" id="facts"></dl>
</div>

<details class="card aset">
  <summary><h2>&#127807; Settings</h2></summary>
  <form id="cfgform">
    <div class="frow">
      <div><label>Latitude <input name="latitude" type="number" step="0.0001" min="-90" max="90" required></label></div>
      <div><label>Longitude <input name="longitude" type="number" step="0.0001" min="-180" max="180" required></label></div>
      <div class="tzrow"><label>Timezone <select name="timezone" required>
        {% for z in tzs %}<option value="{{ z }}">{{ z }}</option>{% endfor %}
      </select></label></div>
      <div><label>Max brightness (%) <input name="max_bright" type="number" min="1" max="100" required></label></div>
      <div><label>Ramp length (min) <input name="ramp_min" type="number" min="0" max="240" required></label></div>
      <div><label>Sunrise offset (min) <input name="sunrise_offset_min" type="number" min="-360" max="360" required></label></div>
      <div><label>Sunset offset (min) <input name="sunset_offset_min" type="number" min="-360" max="360" required></label></div>
      <div class="checkrow"><input type="checkbox" name="capture_enabled" id="capen">
        <label for="capen" style="font-size:14px;color:var(--fir)">Timelapse camera</label></div>
      <div></div>
      <div><label>Photo interval (min) <input name="capture_interval_min" type="number" min="5" max="720" required></label></div>
      <div><label>Photo brightness (%) <input name="capture_brightness" type="number" min="1" max="100" required></label></div>
      <div class="tzrow"><label>Photo crop x,y,w,h (fractions, blank = full frame)
        <input name="roi" type="text" placeholder="0.22,0.08,0.57,0.82"></label></div>
    </div>
    <button type="submit">Save &amp; replant</button><span id="msg"></span>
  </form>
</details>

</main>

<footer id="cfg"></footer>

<script>
let S=null;

function fmt(d){return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});}
function mins(d){return d.getHours()*60+d.getMinutes()+d.getSeconds()/60;}

function curve(t,on,off,ramp,max){
  if(t<=on||t>=off)return 0;
  const fs=on+ramp, fe=off-ramp;
  if(fs>=fe){const mid=(on+off)/2;
    return t<=mid?max*(t-on)/(mid-on):max*(off-t)/(off-mid);}
  if(t<fs)return max*(t-on)/ramp;
  if(t>fe)return max*(off-t)/ramp;
  return max;
}

function draw(){
  if(!S)return;
  const W=640,H=240,L=34,R=12,T=20,B=34;
  const on=mins(S.on),off=mins(S.off),now=mins(S.now);
  const x=m=>L+(W-L-R)*m/1440, y=p=>H-B-(H-T-B)*p/100;
  let pts=[];
  for(let m=0;m<=1440;m+=4)pts.push([x(m),y(curve(m,on,off,S.ramp,S.max))]);
  const line=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join('');
  const area=line+`L${x(1440)} ${y(0)} L${x(0)} ${y(0)} Z`;
  const hours=[0,6,12,18,24].map(h=>
    `<text x="${x(h*60)}" y="${H-12}" text-anchor="middle" font-size="11" fill="#3f7d45">${String(h).padStart(2,'0')}:00</text>
     <line x1="${x(h*60)}" y1="${T}" x2="${x(h*60)}" y2="${H-B}" stroke="#d8e6cd" stroke-width="1"/>`).join('');
  const sunM=mins(S.sunrise),setM=mins(S.sunset);
  document.getElementById('chart').innerHTML=`
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e8b04b" stop-opacity=".85"/>
      <stop offset="55%" stop-color="#7fb069" stop-opacity=".75"/>
      <stop offset="100%" stop-color="#3f7d45" stop-opacity=".35"/>
    </linearGradient></defs>
    ${hours}
    <line x1="${L}" y1="${y(0)}" x2="${W-R}" y2="${y(0)}" stroke="#27432e" stroke-width="1.5"/>
    <path d="${area}" fill="url(#g)"/>
    <path d="${line}" fill="none" stroke="#27432e" stroke-width="2"/>
    <text x="${x(sunM)}" y="${T-5}" font-size="14" text-anchor="middle">&#127774;</text>
    <text x="${x(setM)}" y="${T-5}" font-size="14" text-anchor="middle">&#127771;</text>
    <line x1="${x(now)}" y1="${T}" x2="${x(now)}" y2="${y(0)}" stroke="#b3543a" stroke-width="2"/>
    <circle class="nowdot" cx="${x(now)}" cy="${y(curve(now,on,off,S.ramp,S.max))}" r="6"
            fill="#b3543a" stroke="#fff" stroke-width="2"/>
    <text x="${L}" y="${y(100)-4}" font-size="11" fill="#3f7d45">${S.max}%</text>`;
}

function phaseOf(){
  const on=mins(S.on),off=mins(S.off),now=mins(S.now);
  if(now<on)return['Night','Lights come on at '+fmt(S.on)];
  if(now<on+S.ramp)return['Morning ramp','Full brightness at '+fmt(new Date(S.on.getTime()+S.ramp*60000))];
  if(now<off-S.ramp)return['Full light','Evening ramp begins at '+fmt(new Date(S.off.getTime()-S.ramp*60000))];
  if(now<off)return['Evening ramp','Lights off at '+fmt(S.off)];
  return['Night','Lights come on tomorrow around '+fmt(S.on)];
}

function render(){
  if(!S)return;
  document.getElementById('pct').textContent=Math.round(S.brightness)+'%';
  document.getElementById('bulb').style.setProperty('--glow',S.brightness/100);
  const[p,n]=phaseOf();
  document.getElementById('phase').textContent=p;
  document.getElementById('next').textContent=n;
  const dayLen=(S.off-S.on)/60000;
  document.getElementById('facts').innerHTML=`
    <dt>&#127774; Sunrise</dt><dd>${fmt(S.sunrise)}</dd>
    <dt>&#127771; Sunset</dt><dd>${fmt(S.sunset)}</dd>
    <dt>&#128161; Lights on</dt><dd>${fmt(S.on)}</dd>
    <dt>&#128164; Lights off</dt><dd>${fmt(S.off)}</dd>
    <dt>&#127804; Photoperiod</dt><dd>${Math.floor(dayLen/60)}h ${Math.round(dayLen%60)}m</dd>
    <dt>&#9202; Ramp length</dt><dd>${S.ramp} min</dd>`;
  document.getElementById('cfg').textContent=
    `GPIO${S.gpio} \u00b7 ${S.freq} Hz PWM \u00b7 updates every ${S.loop}s`;
  draw();
}

function renderPhoto(j){
  const card=document.getElementById('photocard');
  if(!j.photo_count){card.style.display='none';return;}
  card.style.display='';
  document.getElementById('photo').src='/photo/latest?'+ (j.latest_photo_time||Date.now());
  const when=j.latest_photo_time?new Date(j.latest_photo_time):null;
  document.getElementById('photoinfo').textContent=
    (when?`Taken ${when.toLocaleString()}`:'')+` \u00b7 ${j.photo_count} photos so far`;
}

function fillForm(cfg){
  const f=document.getElementById('cfgform');
  for(const k of ['latitude','longitude','timezone','max_bright','ramp_min',
                  'sunrise_offset_min','sunset_offset_min',
                  'capture_interval_min','capture_brightness','roi'])
    if(f.elements[k] && document.activeElement!==f.elements[k])
      f.elements[k].value=cfg[k];
  if(document.activeElement!==f.elements['capture_enabled'])
    f.elements['capture_enabled'].checked=!!cfg['capture_enabled'];
}

let frames=[],fidx=0,ptimer=null;
function frameLabel(n){
  const m=n.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/);
  return m?`${m[2]}/${m[3]} ${m[4]}:${m[5]}`:n;
}
function showFrame(){
  if(!frames.length)return;
  document.getElementById('vframe').src='/thumb/'+frames[fidx];
  document.getElementById('scrub').value=fidx;
  document.getElementById('pframe').textContent=
    `${frameLabel(frames[fidx])} \u00b7 ${fidx+1}/${frames.length}`;
  (new Image()).src='/thumb/'+frames[(fidx+1)%frames.length];
}
function stopPlay(){
  if(ptimer){clearInterval(ptimer);ptimer=null;}
  document.getElementById('playbtn').innerHTML='&#9654; Grow';
}
function togglePlay(){
  if(ptimer){stopPlay();return;}
  if(fidx>=frames.length-1)fidx=0;
  document.getElementById('playbtn').innerHTML='&#9208; Pause';
  ptimer=setInterval(()=>{
    if(fidx>=frames.length-1){stopPlay();return;}
    fidx++;showFrame();
  },125);
}
async function loadFrames(){
  try{
    const r=await fetch('/api/photos');const j=await r.json();
    const had=frames.length;
    frames=j.names||[];
    const card=document.getElementById('videocard');
    if(frames.length<2){card.style.display='none';return;}
    card.style.display='';
    document.getElementById('scrub').max=frames.length-1;
    if(!had){fidx=frames.length-1;showFrame();}
  }catch(e){}
}
document.getElementById('playbtn').addEventListener('click',togglePlay);
document.getElementById('renderbtn').addEventListener('click',async()=>{
  const info=document.getElementById('renderinfo');
  info.textContent='Starting render...';
  try{
    const r=await fetch('/api/render',{method:'POST'});
    const j=await r.json();
    if(!r.ok)info.textContent=j.error||'Render failed to start';
  }catch(e){info.textContent='Render failed to start';}
});
function renderVideoState(j){
  const info=document.getElementById('renderinfo');
  const dl=document.getElementById('dlbtn');
  const btn=document.getElementById('renderbtn');
  const st=j.render||{};
  btn.disabled=(st.state==='running');
  if(st.state==='running'){info.textContent=st.msg+' (a few minutes on the Zero)';}
  else if(st.state==='error'){info.textContent='Render error: '+st.msg;}
  else if(j.video_time){
    const when=new Date(j.video_time);
    info.textContent='Video from '+when.toLocaleString()+
      (st.state==='done'?' \u00b7 '+st.msg:'');
  } else {info.textContent='No video rendered yet';}
  dl.style.display=j.video_time?'':'none';
}
document.getElementById('scrub').addEventListener('input',ev=>{
  stopPlay();fidx=+ev.target.value;showFrame();
});

async function refresh(){
  try{
    const r=await fetch('/api/status');const j=await r.json();
    S={...j,now:new Date(j.now),on:new Date(j.on),off:new Date(j.off),
       sunrise:new Date(j.sunrise),sunset:new Date(j.sunset)};
    fillForm(j.settings);
    renderPhoto(j);
    renderVideoState(j);
    loadFrames();
    render();
  }catch(e){document.getElementById('phase').textContent='Controller unreachable';}
}

document.getElementById('cfgform').addEventListener('submit',async ev=>{
  ev.preventDefault();
  const f=ev.target,msg=document.getElementById('msg');
  const body={};
  for(const k of ['latitude','longitude','max_bright','ramp_min',
                  'sunrise_offset_min','sunset_offset_min',
                  'capture_interval_min','capture_brightness'])
    body[k]=parseFloat(f.elements[k].value);
  body.timezone=f.elements['timezone'].value.trim();
  body.roi=f.elements['roi'].value.trim();
  body.capture_enabled=f.elements['capture_enabled'].checked;
  msg.textContent='Planting...';msg.className='';
  try{
    const r=await fetch('/api/settings',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json();
    if(r.ok){msg.textContent='Saved \u{1F331}';msg.className='ok';setTimeout(refresh,800);}
    else{msg.textContent=j.error||'Save failed';msg.className='err';}
  }catch(e){msg.textContent='Save failed';msg.className='err';}
});

setInterval(()=>{const d=new Date();
  document.getElementById('clock').textContent=d.toLocaleTimeString();
  if(S){S.now=d;}},1000);
setInterval(refresh,15000);
setInterval(render,60000);
refresh();
</script>
</body>
</html>"""


@app.route("/")
def index():
    return render_template_string(PAGE, tzs=TIMEZONES)


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
    )


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
    print(f"Dashboard at http://0.0.0.0:{HTTP_PORT}")
    app.run(host="0.0.0.0", port=HTTP_PORT, threaded=True)
GROWLIGHT_PY
fi

echo "==> [5/6] systemd service (user: $RUN_USER)"
sudo tee /etc/systemd/system/growlight.service > /dev/null << UNIT
[Unit]
Description=Grow light controller and dashboard
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$APP_DIR/venv/bin/python $APP_DIR/growlight.py
WorkingDirectory=$APP_DIR
Restart=always
RestartSec=5
User=$RUN_USER

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable growlight

echo "==> [6/6] Shell convenience (venv auto-activate)"
LINE="source $APP_DIR/venv/bin/activate"
grep -qxF "$LINE" "$HOME/.bashrc" || echo "$LINE" >> "$HOME/.bashrc"

echo
echo "=================================================="
if [[ "$NEED_REBOOT" -eq 1 ]]; then
  echo "PWM overlay was just added: REBOOT REQUIRED."
  echo "Run:  sudo reboot"
  echo "The growlight service is enabled and will start on boot."
else
  sudo systemctl restart growlight
  sleep 2
  IP="$(hostname -I | awk '{print $1}')"
  echo "Done. Dashboard:  http://$IP:5000"
  systemctl --no-pager --full status growlight || true
fi
[[ -f "$APP_DIR/config.json" ]] && echo "Existing config.json kept (your saved settings)." \
  || echo "No config.json yet: defaults are Thousand Oaks / America/Los_Angeles."
echo "Logs:  journalctl -u growlight -f"
echo "=================================================="
