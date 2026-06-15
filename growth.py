#!/usr/bin/env python3
"""Per-cell canopy growth measurement from a tray photo.

For each grid cell, measures canopy coverage (share of plant pixels, the
primary metric) and the raw plant-pixel count, using the excess-green index.
Run as a subprocess so OpenCV's memory is released after each call, the same
pattern as detect_corners.py.

Usage:  growth.py <image.jpg> '<grid-json>'
  grid-json: {"corners": [[x,y] x4 as TL,TR,BR,BL fractions], "rows": R, "cols": C}
Prints:  {"ok": true, "readings": {"growth:A1": 12.3, "growth_px:A1": 4567, ...}}
    or:  {"ok": false, "error": "..."}

Coverage is resolution-independent. Pixel counts are taken at a fixed analysis
width so they stay comparable across photos even if the capture size changes.
"""
import json
import sys

# Plant detection uses the excess-green index (ExG = 2G - R - B), not hue.
# The magenta grow light makes leaves read as magenta, so hue-based detection
# zeros out real plants; ExG measures *relative* greenness and survives coloured
# light. Soil sits deeply negative, so a modest positive threshold rejects it
# cleanly. Raise EXG_MIN if soil/perlite trips it, lower it to catch fainter
# leaves. (Absolute coverage is understated under magenta light; for true
# coverage, capture under white light. Good for tracking and ranking either way.)
EXG_MIN = 15
ANALYSIS_W = 1000   # longest image side scaled to this before counting


def _col_letters(c):
    """0->A, 1->B, ... 25->Z, 26->AA (matches the dashboard's column labels)."""
    s = ""
    c += 1
    while c:
        c, r = divmod(c - 1, 26)
        s = chr(65 + r) + s
    return s


def cell_key(r, c):
    return _col_letters(c) + str(r + 1)


def _bil(C, u, v):
    """Bilinear interpolation of the four corners; mirrors bil() in app.js."""
    tx = (1 - u) * C[0][0] + u * C[1][0]
    ty = (1 - u) * C[0][1] + u * C[1][1]
    bx = (1 - u) * C[3][0] + u * C[2][0]
    by = (1 - u) * C[3][1] + u * C[2][1]
    return ((1 - v) * tx + v * bx, (1 - v) * ty + v * by)


def analyze(path, grid):
    try:
        import cv2
        import numpy as np
    except Exception:
        return {"ok": False, "error": "OpenCV not installed on the Pi."}

    img = cv2.imread(path)
    if img is None:
        return {"ok": False, "error": "Could not read the photo."}

    h, w = img.shape[:2]
    scale = ANALYSIS_W / float(max(h, w))
    if scale < 1.0:
        img = cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))))
        h, w = img.shape[:2]

    # plant mask via excess-green index (robust to the magenta grow light)
    b, g, r = (img[:, :, 0].astype(np.int32), img[:, :, 1].astype(np.int32),
               img[:, :, 2].astype(np.int32))
    exg = 2 * g - r - b
    green = (exg > EXG_MIN).astype(np.uint8) * 255   # 0/255 plant mask

    # Grayscale brightness is the wet/dry signal: wetter soil is darker. Use
    # brightness (not colour) because the magenta grow light wrecks hue. This is
    # only comparable across photos if capture brightness stays fixed.
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    SPECULAR = 240   # drop near-white glints off wet plastic / water

    try:
        C = grid["corners"]
        R = int(grid.get("rows", 4))
        K = int(grid.get("cols", 4))
        if len(C) != 4 or not (1 <= R <= 12 and 1 <= K <= 12):
            raise ValueError
    except (KeyError, TypeError, ValueError):
        return {"ok": False, "error": "Bad grid geometry."}

    readings = {}
    for r in range(R):
        for c in range(K):
            quad = [_bil(C, c / K, r / R), _bil(C, (c + 1) / K, r / R),
                    _bil(C, (c + 1) / K, (r + 1) / R), _bil(C, c / K, (r + 1) / R)]
            pts = np.array([[int(round(x * w)), int(round(y * h))] for x, y in quad],
                           dtype=np.int32)
            mask = np.zeros((h, w), dtype=np.uint8)
            cv2.fillPoly(mask, [pts], 255)
            cell_area = int(np.count_nonzero(mask))
            if cell_area == 0:
                continue
            green_px = int(np.count_nonzero(cv2.bitwise_and(green, mask)))
            k = cell_key(r, c)
            readings["growth:" + k] = round(100.0 * green_px / cell_area, 1)
            readings["growth_px:" + k] = green_px

            # soil = in-cell, not plant, not specular highlight
            soil = (mask > 0) & (green == 0) & (gray < SPECULAR)
            if int(np.count_nonzero(soil)) >= 50:
                # median brightness (0-255) -> 0-100 surface index; higher = drier
                dry = float(np.median(gray[soil]))
                readings["dry:" + k] = round(100.0 * dry / 255.0, 1)
    return {"ok": True, "readings": readings}


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: growth.py <image> <grid-json>"}))
        return
    try:
        grid = json.loads(sys.argv[2])
    except Exception:
        print(json.dumps({"ok": False, "error": "Bad grid JSON."}))
        return
    print(json.dumps(analyze(sys.argv[1], grid)))


if __name__ == "__main__":
    main()
