#!/usr/bin/env bash
# Environment provisioner for the grow light controller.
#
# This sets up the BOX (packages, venv, PWM overlay, swap, systemd service,
# shell convenience). It does NOT contain the application code -- that lives
# in the repo next to this script. Run it from a checkout:
#
#   git clone <repo> ~/growlight && cd ~/growlight && bash scripts/setup.sh
#
# Safe to re-run any time (idempotent). Preserves config.json and growlight.db.

set -euo pipefail

if [[ $EUID -eq 0 ]]; then
  echo "Run as your normal user, not root. The script uses sudo where needed."
  exit 1
fi

# Repo root is one level up from scripts/. The app already lives there (checkout).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_ROOT"
RUN_USER="$(whoami)"
NEED_REBOOT=0

# Sanity: the app code must be present. This script no longer ships it.
if [[ ! -f "$APP_DIR/growlight.py" ]]; then
  echo "ERROR: growlight.py not found in $APP_DIR"
  echo "Run this from a repo checkout: git clone <repo> ~/growlight"
  exit 1
fi
echo "==> App directory: $APP_DIR  (user: $RUN_USER)"

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

echo "==> [3/6] Swap (>=1G so renders don't OOM on a 512MB board)"
SWAPFILE=/swapfile
cur_kb="$(awk '/SwapTotal/{print $2}' /proc/meminfo)"
if [[ "${cur_kb:-0}" -lt 1000000 && ! -f "$SWAPFILE" ]]; then
  sudo fallocate -l 2G "$SWAPFILE"
  sudo chmod 600 "$SWAPFILE"
  sudo mkswap "$SWAPFILE" >/dev/null
  sudo swapon "$SWAPFILE"
  grep -qxF "$SWAPFILE none swap sw 0 0" /etc/fstab \
    || echo "$SWAPFILE none swap sw 0 0" | sudo tee -a /etc/fstab > /dev/null
  echo "    created $SWAPFILE (2G) and added to /etc/fstab"
else
  echo "    swap already adequate; leaving it alone"
fi

echo "==> [4/6] Python venv and dependencies"
[[ -d "$APP_DIR/venv" ]] || python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install --quiet --upgrade pip
"$APP_DIR/venv/bin/pip" install --quiet astral rpi-hardware-pwm flask gpiozero lgpio
echo "    optional: grid auto-detect (opencv) ..."
"$APP_DIR/venv/bin/pip" install --quiet opencv-python-headless numpy \
  || echo "    opencv unavailable; grid auto-detect off, manual placement still works"

echo "==> [5/6] systemd service"
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
  echo "Run:  sudo reboot   (the service is enabled and starts on boot)"
else
  sudo systemctl restart growlight
  sleep 2
  IP="$(hostname -I | awk '{print $1}')"
  echo "Done. Dashboard:  http://$IP:5000"
  systemctl --no-pager --full status growlight || true
fi
echo "Logs:  journalctl -u growlight -f"
echo "Update flow:  git pull && sudo systemctl restart growlight"
echo "=================================================="
