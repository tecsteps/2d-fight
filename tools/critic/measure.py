#!/usr/bin/env python3
"""Measure a capture against docs/FRAME_BUDGET.md.

One shared implementation on purpose. When each agent writes its own sampler,
each one measures a slightly different thing, and "my numbers say it is fine"
stops being falsifiable. Every agent reports this tool's output, whole table.

  python3 tools/critic/measure.py shots/full-0000.png
  python3 tools/critic/measure.py shots/full-0000.png --json
"""
import argparse
import colorsys
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

# Luminance weights (Rec.709), on 0-255 sRGB without linearisation. The budget's
# thresholds were authored in this space, so do not "fix" this to be linear
# without restating every threshold.
LUMA = np.array([0.2126, 0.7152, 0.0722])


def luminance(rgb: np.ndarray) -> np.ndarray:
    return rgb.astype(np.float32) @ LUMA


def find_figures(lum: np.ndarray, bg_thresh: float = 0.15, min_w: int = 40):
    """Split the frame into figure column-bands by vertical contrast profile.

    Returns [(x0, x1), ...] left to right.

    This used to threshold absolute column brightness against the frame median,
    on the reasoning that "fighters are the only tall bright objects". That
    holds only while the stage is nearly black, and the budget this file
    measures explicitly requires the stage *not* to be — so the moment the
    median frame luminance reached its target band the detector returned zero
    figures and the whole per-figure table went silent. A tool that can only
    measure frames that fail is not a tool.

    What actually distinguishes a fighter from the stage is that the stage is
    smooth along x while a fighter is not: at any given row the backdrop and the
    floor are within a couple of luminance units of that row's median, and a
    fighter deviates from it in *either* direction — bright skin above it, dark
    costume and ink below it. So the profile is mean |luminance − row median|,
    which is blind to how bright the stage is and picks up dark-costumed
    fighters as readily as bright-skinned ones.

    `bg_thresh` is now a fraction of the profile's own range above its median
    rather than a brightness ratio. Verified to return the same spans as the
    previous implementation on `shots/full-0000.png` and the review-002 frames.
    """
    h, w = lum.shape
    resid = np.abs(lum - np.median(lum, axis=1, keepdims=True))
    band = resid[int(h * 0.28):int(h * 0.62), :]
    prof = band.mean(axis=0)
    base = np.median(prof)
    mask = prof > base + bg_thresh * (np.percentile(prof, 99) - base)

    spans = []
    x = 0
    while x < w:
        if mask[x]:
            x0 = x
            while x < w and mask[x]:
                x += 1
            if x - x0 >= min_w:
                spans.append((x0, x))
        else:
            x += 1
    return spans


def hsv_of(mean_rgb) -> tuple:
    r, g, b = [c / 255.0 for c in mean_rgb]
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    return h * 360.0, s * 100.0, v * 100.0


def analyse(path: Path) -> dict:
    im = Image.open(path).convert('RGB')
    rgb = np.asarray(im)
    lum = luminance(rgb)
    h, w = lum.shape

    out: dict = {'file': str(path), 'size': [w, h]}

    # --- global value structure ---------------------------------------------
    out['global'] = {
        'median_luma': float(np.median(lum)),
        'mean_luma': float(lum.mean()),
        'pct_below_16': float((lum < 16).mean() * 100),
        'pct_above_128': float((lum > 128).mean() * 100),
        'pct_clipped': float((rgb >= 255).any(axis=2).mean() * 100),
    }

    # --- per figure ----------------------------------------------------------
    spans = find_figures(lum)
    figs = []
    for i, (x0, x1) in enumerate(spans):
        col = rgb[:, x0:x1]
        cl = lum[:, x0:x1]
        # Figure pixels: brighter than the local background median. Crude, but
        # consistent across runs, which is what matters for tracking a delta.
        #
        # KNOWN BAD on a stage that meets the global budget, and deliberately
        # left alone rather than quietly redefined mid-wave. `median(cl)` over a
        # full-height column strip is a stand-in for "the background", and that
        # only holds while backdrop and floor are the same value — i.e. while the
        # stage is nearly black. On a stage whose floor sits at its budgeted
        # L≈110-150 the strip median lands between sky and floor, the near floor
        # passes this test, and every per-figure number below is then part
        # ground: shadow/lit ratios climb toward 0.9 on a roster whose ratio has
        # not moved. Nothing in the loop below can be trusted on such a frame.
        #
        # The fix is a real matte — one extra capture with the fighters rendered
        # to a mask — not another threshold. Every purely photometric rule tried
        # here (row-median reference, |deviation| from the row median, clipping
        # to the figure's rows) either admits the near-black ink and destroys the
        # hue statistics, or shifts the historical numbers so reviews 001/002 can
        # no longer be compared against.
        bg = np.median(cl)
        m = cl > bg * 1.25
        if m.sum() < 500:
            continue
        px = col[m]
        pl = cl[m]

        # Lit vs shadow split at the midpoint of the figure's own range.
        lo, hi = np.percentile(pl, [5, 95])
        mid = (lo + hi) / 2
        lit = px[pl >= mid]
        sha = px[pl < mid]

        lit_hsv = hsv_of(lit.mean(axis=0)) if len(lit) else (0, 0, 0)
        sha_hsv = hsv_of(sha.mean(axis=0)) if len(sha) else (0, 0, 0)

        # Histogram concentration in any single 8-L bin — the flat-fill tell.
        hist, _ = np.histogram(pl, bins=32, range=(0, 256))
        top_bin = float(hist.max() / max(1, hist.sum()) * 100)
        live_bins = int((hist / max(1, hist.sum()) > 0.03).sum())

        dh = sha_hsv[0] - lit_hsv[0]
        if dh > 180:
            dh -= 360
        if dh < -180:
            dh += 360

        figs.append({
            'index': i,
            'x': [int(x0), int(x1)],
            'mean_luma': float(pl.mean()),
            'lit_hsv': [round(v, 1) for v in lit_hsv],
            'shadow_hsv': [round(v, 1) for v in sha_hsv],
            'shadow_lit_value_ratio': round(sha_hsv[2] / lit_hsv[2], 3) if lit_hsv[2] else 0,
            'shadow_hue_delta': round(dh, 1),
            'shadow_sat_drop': round(lit_hsv[1] - sha_hsv[1], 1),
            'top_bin_pct': round(top_bin, 1),
            'live_bins': live_bins,
            'shadow_rgb': [int(v) for v in (sha.mean(axis=0) if len(sha) else [0, 0, 0])],
        })
    out['figures'] = figs

    # Pairwise shadow-colour distance — how much character identity survives
    # turning away from the key.
    dists = []
    for a in range(len(figs)):
        for b in range(a + 1, len(figs)):
            pa = np.array(figs[a]['shadow_rgb'], dtype=float)
            pb = np.array(figs[b]['shadow_rgb'], dtype=float)
            dists.append(round(float(np.linalg.norm(pa - pb)), 1))
    out['shadow_pair_distances'] = dists
    out['min_shadow_pair_distance'] = min(dists) if dists else None

    # --- figure-ground -------------------------------------------------------
    # Background lift near a figure: bloom bleed. Sample a horizontal run just
    # outside each figure's left edge, above the floor line.
    lifts = []
    for f in figs:
        x0 = f['x'][0]
        y = int(h * 0.45)
        far = lum[y, max(0, x0 - 90):max(1, x0 - 70)].mean()
        near = lum[y, max(0, x0 - 20):max(1, x0 - 4)].mean()
        if far > 0.5:
            lifts.append(round(float((near - far) / far * 100), 1))
    out['background_lift_pct'] = lifts

    # Floor variation at foot height across x.
    fy = int(h * 0.66)
    row = lum[fy, :]
    seg = [row[int(w * a):int(w * b)].mean() for a, b in [(0.05, 0.15), (0.45, 0.55), (0.85, 0.95)]]
    out['floor_at_foot_height'] = [round(float(v), 1) for v in seg]
    out['floor_variation_x'] = round(float(max(seg) / max(1e-3, min(seg))), 2)

    return out


BUDGET = [
    ('median_luma', 'global.median_luma', 48, 72),
    ('pct_below_16', 'global.pct_below_16', None, 8),
    ('pct_above_128', 'global.pct_above_128', 8, None),
    ('pct_clipped', 'global.pct_clipped', None, 0.01),
    ('floor_variation_x', 'floor_variation_x', None, 1.4),
]


def dig(d, path):
    for k in path.split('.'):
        d = d[k]
    return d


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('image')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    r = analyse(Path(args.image))
    if args.json:
        print(json.dumps(r, indent=2))
        return

    g = r['global']
    print(f"\n{r['file']}  {r['size'][0]}x{r['size'][1]}")
    print('\n-- global value structure ' + '-' * 42)
    for name, path, lo, hi in BUDGET:
        v = dig(r, path)
        ok = (lo is None or v >= lo) and (hi is None or v <= hi)
        tgt = f"{lo if lo is not None else ''}..{hi if hi is not None else ''}"
        print(f"  {name:<22} {v:>8.2f}   target {tgt:<12} {'OK' if ok else 'FAIL'}")

    print('\n-- per figure ' + '-' * 54)
    print(f"  {'#':<3}{'meanL':>7}{'sh/lit':>8}{'dHue':>7}{'dSat':>7}{'topbin%':>9}{'bands':>7}")
    for f in r['figures']:
        print(f"  {f['index']:<3}{f['mean_luma']:>7.1f}{f['shadow_lit_value_ratio']:>8.2f}"
              f"{f['shadow_hue_delta']:>7.1f}{f['shadow_sat_drop']:>7.1f}"
              f"{f['top_bin_pct']:>9.1f}{f['live_bins']:>7}")
    print('\n  targets: sh/lit 0.60-0.75 | dHue -25..-65 | dSat <15 | topbin <30 | bands >=4')

    print(f"\n  min shadow-colour distance between fighters: "
          f"{r['min_shadow_pair_distance']}  (target > 40)")
    print(f"  background lift near figures: {r['background_lift_pct']}  (target < 10%)")
    print(f"  floor at foot height across x: {r['floor_at_foot_height']}  "
          f"ratio {r['floor_variation_x']}  (target < 1.4)")
    print()


if __name__ == '__main__':
    main()
