#!/usr/bin/env python3
"""Sensor I/O for the grow dashboard.

The one job of this module: talk to hardware, hand back a flat dict of clean
readings. Nothing here knows about brightness, schedules, or the web app.

    import sensors
    sensors.read_all()
    # -> {"moisture:B2": 43.1, "temp:air": 22.4, "humidity": 58.0,
    #     "lux": 1840.0, "temp:soil_1": 21.7, ...}   (None values dropped)

Stub mode: until the real devices are wired (and their libraries installed),
read_all() returns plausible fake values so the whole pipeline -- sample loop,
SQLite logging, dashboard charts -- can be built and tested with no hardware.
As each sensor type is wired, fill in its _read_* function and flip its entry
in ENABLED. Build one type at a time and verify before moving on.

Hardware plan (all on the Pi's I2C bus, pins 3=SDA / 5=SCL, plus 1-Wire on
GPIO4 / pin 7):
  - 10x capacitive soil moisture  -> 3x ADS1115 ADC @ 0x48, 0x49, 0x4A
  - BME280 air temp + humidity    -> 0x76
  - BH1750 ambient lux            -> 0x23
  - 5x DS18B20 soil temp          -> 1-Wire, /sys/bus/w1/devices/28-*
"""

import random

# Flip these to True as each sensor type is wired and its _read_* filled in.
ENABLED = {
    "moisture": False,
    "air": False,      # BME280 temp + humidity
    "lux": False,      # BH1750
    "soil_temp": False,
}

# Which ADS board + channel each cell's moisture probe lands on, and that
# probe's calibration endpoints (raw counts in air vs in water). Filled in
# during wiring + calibration; until then stub mode ignores this.
#   "B2": {"addr": 0x48, "chan": 0, "dry": 26500, "wet": 12000}
MOISTURE_MAP = {}


# --------------------------- moisture (ADS1115) ---------------------------

def _moist_pct(raw, dry, wet):
    """Capacitive probes read HIGH (dry) to LOW (wet). Map to 0-100%."""
    if dry == wet:
        return None
    pct = (dry - raw) / (dry - wet) * 100.0
    return max(0.0, min(100.0, pct))


def _read_moisture():
    out = {}
    if not ENABLED["moisture"] or not MOISTURE_MAP:
        return out
    # TODO (wire-up): real read via adafruit_ads1x15.
    #   import board, busio
    #   from adafruit_ads1x15.ads1115 import ADS1115
    #   from adafruit_ads1x15.analog_in import AnalogIn
    #   i2c = busio.I2C(board.SCL, board.SDA)
    #   adcs = {a: ADS1115(i2c, address=a) for a in {0x48,0x49,0x4A}}
    #   for cell, m in MOISTURE_MAP.items():
    #       raw = AnalogIn(adcs[m["addr"]], m["chan"]).value
    #       out[f"moisture:{cell}"] = _moist_pct(raw, m["dry"], m["wet"])
    return out


# ----------------------------- air (BME280) -------------------------------

def _read_air():
    if not ENABLED["air"]:
        return {}
    # TODO (wire-up): real read via adafruit_bme280 @ 0x76.
    #   from adafruit_bme280 import basic as bme280
    #   sensor = bme280.Adafruit_BME280_I2C(i2c, address=0x76)
    #   return {"temp:air": sensor.temperature, "humidity": sensor.humidity}
    return {}


# ------------------------------ lux (BH1750) ------------------------------

def _read_lux():
    if not ENABLED["lux"]:
        return {}
    # TODO (wire-up): real read via adafruit_bh1750 @ 0x23.
    #   import adafruit_bh1750
    #   return {"lux": adafruit_bh1750.BH1750(i2c).lux}
    return {}


# -------------------------- soil temp (DS18B20) ---------------------------

def _read_soil_temps():
    if not ENABLED["soil_temp"]:
        return {}
    # TODO (wire-up): read each 1-Wire probe from sysfs.
    #   import glob
    #   for i, dev in enumerate(sorted(glob.glob('/sys/bus/w1/devices/28-*')), 1):
    #       raw = open(dev + '/w1_slave').read()
    #       if 't=' in raw:
    #           out[f"temp:soil_{i}"] = int(raw.split('t=')[1]) / 1000.0
    return {}


# --------------------------------- stubs ----------------------------------

def _stub():
    """Plausible fake values so the pipeline works before any wiring."""
    out = {}
    for cell in (MOISTURE_MAP or {"A1": 0, "B2": 0, "C3": 0, "D4": 0}):
        out[f"moisture:{cell}"] = round(random.uniform(35, 55), 1)
    out["temp:air"] = round(random.uniform(20, 25), 2)
    out["humidity"] = round(random.uniform(45, 65), 1)
    out["lux"] = round(random.uniform(0, 12000), 0)
    for i in range(1, 4):
        out[f"temp:soil_{i}"] = round(random.uniform(19, 24), 2)
    return out


def stub_mode():
    """True when no sensor type is enabled (i.e. nothing is wired yet)."""
    return not any(ENABLED.values())


# --------------------------------- public ---------------------------------

def read_all():
    """Return {sensor_key: value}. Each sensor type is read independently and
    wrapped so one failed device never aborts the rest; failures are dropped."""
    if stub_mode():
        return _stub()
    out = {}
    for fn in (_read_moisture, _read_air, _read_lux, _read_soil_temps):
        try:
            out.update(fn())
        except Exception as e:
            print(f"sensor read error in {fn.__name__}: {e}")
    return out


if __name__ == "__main__":
    print("stub_mode:", stub_mode())
    for k, v in sorted(read_all().items()):
        print(f"  {k:18s} {v}")
