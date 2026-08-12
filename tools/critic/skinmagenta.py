#!/usr/bin/env python3
"""Magenta share of each fighter's bare skin.

Review 003's finding #2 in one number. Bare-skin boxes are hand-picked per
fighter because the whole-character mask is cloth-confounded — Kai's navy gi
(hue ~215 degrees) dominates any statistic taken over his whole silhouette, which
is how a previous wave measured a shadow hue of -148 on a fighter whose skin
rotates -53.

  python3 tools/critic/skinmagenta.py shots/fixed-0000.png
"""
import sys
import colorsys
import numpy as np
from PIL import Image

# Bare-skin regions in a 1920x1080 lineup capture. Chosen to avoid costume, ink
# and hair entirely; re-check them if the camera framing changes.
BOXES = {
    'kai  shin':    (444, 690, 470, 740),
    'mali thigh':   (772, 615, 840, 700),
    'davi torso':  (1096, 400, 1140, 470),
    'vera forearm':(1386, 505, 1420, 570),
}

def main(path):
    im = np.asarray(Image.open(path).convert('RGB')).astype(float)
    print(f'\n{path}\n')
    print(f"  {'region':<14}{'magenta%':>10}{'sh/lit':>9}{'dHue':>8}{'dSat':>8}{'topbin%':>9}")
    for name, (x0, y0, x1, y1) in BOXES.items():
        px = im[y0:y1, x0:x1].reshape(-1, 3)
        lum = px @ np.array([0.2126, 0.7152, 0.0722])
        px, lum = px[lum > 20], lum[lum > 20]
        if len(px) < 40:
            print(f'  {name:<14} (too few pixels — box may be off after a reframe)')
            continue
        hsv = np.array([colorsys.rgb_to_hsv(*(p / 255.0)) for p in px])
        hue = hsv[:, 0] * 360
        magenta = ((hue >= 300) & (hue <= 360)).mean() * 100
        mid = (np.percentile(lum, 5) + np.percentile(lum, 95)) / 2
        lit, sha = px[lum >= mid], px[lum < mid]
        lh = colorsys.rgb_to_hsv(*(lit.mean(0) / 255.0))
        sh = colorsys.rgb_to_hsv(*(sha.mean(0) / 255.0))
        dh = (sh[0] - lh[0]) * 360
        dh = dh - 360 if dh > 180 else dh + 360 if dh < -180 else dh
        hist, _ = np.histogram(lum, bins=32, range=(0, 256))
        top = hist.max() / max(1, hist.sum()) * 100
        print(f'  {name:<14}{magenta:>10.1f}{sh[2]/max(lh[2],1e-6):>9.2f}'
              f'{dh:>8.1f}{(lh[1]-sh[1])*100:>8.1f}{top:>9.1f}')
    print('\n  targets: magenta <8% | sh/lit 0.60-0.75 | dHue -25..-65 | dSat <15 | topbin <30\n')

main(sys.argv[1] if len(sys.argv) > 1 else 'shots/fixed-0000.png')
