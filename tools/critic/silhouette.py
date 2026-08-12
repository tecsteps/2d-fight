#!/usr/bin/env python3
"""Body-type divergence, measured off a matte capture.

Reviews 001 and 002 both landed on the same finding — "one body, four albedos" —
and both times the reply was that hair and costume would fix it. They cannot:
they change the *outline*, and the outline is a small fraction of the area an
IoU integrates over. So this measures the thing the finding is actually about.

Method, and why each step:

* **Height-normalise before comparing.** Otherwise a taller fighter scores as a
  different *shape* purely for being taller, and the roster could pass by
  stretching one character. Height difference is reported separately, as the
  aspect spread.
* **Align on the feet and the vertical axis of mass**, not on the bounding-box
  centre. Bounding-box centring lets a wide hair silhouette drag the whole body
  sideways and manufactures a difference that is not there.
* **IoU over the filled silhouette**, so mass distribution — where the width
  *is* — is what moves the number, not just where the outline runs.

  python3 tools/critic/silhouette.py shots/tag-matte-0000.png
  python3 tools/critic/silhouette.py shots/tag-matte-0000.png --json
"""
import argparse
import itertools
import json
from pathlib import Path

import numpy as np
from PIL import Image

LUMA = np.array([0.2126, 0.7152, 0.0722])
# Everything above the ankle. Feet and hair are the two parts of a silhouette
# that are *not* body type, and both sit at an extreme of the y range, so the
# torso band is where the comparison has to live for the number to mean "build".
TORSO_LO, TORSO_HI = 0.18, 0.92


def masks(path: Path, min_w: int = 40):
    m = (np.asarray(Image.open(path).convert('RGB')).astype(np.float32) @ LUMA) > 128
    cols = m.any(axis=0)
    spans, x, w = [], 0, len(cols)
    while x < w:
        if cols[x]:
            x0 = x
            while x < w and cols[x]:
                x += 1
            if x - x0 >= min_w:
                spans.append((x0, x))
        else:
            x += 1
    out = []
    for x0, x1 in spans:
        sub = m[:, x0:x1]
        rows = np.where(sub.any(axis=1))[0]
        out.append(sub[rows[0]:rows[-1] + 1, :])
    return out


def normalise(mask: np.ndarray, size: int = 256) -> np.ndarray:
    """Height-normalised, foot-aligned, mass-centred silhouette on a square."""
    h, w = mask.shape
    scale = size / h
    im = Image.fromarray((mask * 255).astype(np.uint8)).resize(
        (max(1, int(round(w * scale))), size), Image.BILINEAR
    )
    a = np.asarray(im) > 127
    canvas = np.zeros((size, size), bool)
    # Horizontal centre of mass over the torso band, so a ponytail or a raised
    # arm cannot slide the body off-axis.
    band = a[int(size * (1 - TORSO_HI)):int(size * (1 - TORSO_LO)), :]
    xs = np.nonzero(band.any(axis=0))[0]
    cx = (band.sum(axis=0) * np.arange(a.shape[1])).sum() / max(1, band.sum()) if xs.size else a.shape[1] / 2
    off = int(round(size / 2 - cx))
    src0, src1 = max(0, -off), min(a.shape[1], size - off)
    if src1 > src0:
        canvas[:, src0 + off:src1 + off] = a[:, src0:src1]
    return canvas


def iou(a: np.ndarray, b: np.ndarray) -> float:
    u = (a | b).sum()
    return float((a & b).sum() / u) if u else 1.0


def measure(path: Path) -> dict:
    ms = masks(path)
    norms = [normalise(m) for m in ms]
    aspects = []
    for m in ms:
        h, w = m.shape
        lo, hi = int(h * (1 - TORSO_HI)), int(h * (1 - TORSO_LO))
        band = m[lo:hi, :]
        cols = np.nonzero(band.any(axis=0))[0]
        aspects.append((cols[-1] - cols[0] + 1) / h if cols.size else w / h)

    pairs = []
    for i, j in itertools.combinations(range(len(ms)), 2):
        pairs.append({'a': i, 'b': j, 'iou': round(iou(norms[i], norms[j]), 4)})
    vals = [p['iou'] for p in pairs]
    spread = (max(aspects) - min(aspects)) / (sum(aspects) / len(aspects)) if aspects else 0.0
    return {
        'file': str(path),
        'heights_px': [int(m.shape[0]) for m in ms],
        'torso_aspect_w_over_h': [round(a, 4) for a in aspects],
        'aspect_spread_pct': round(spread * 100, 2),
        'pairs': pairs,
        'mean_iou': round(sum(vals) / len(vals), 4) if vals else 0.0,
        'max_iou': round(max(vals), 4) if vals else 0.0,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('matte')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--names', default='kai,mali,davi,vera')
    args = ap.parse_args()
    r = measure(Path(args.matte))
    if args.json:
        print(json.dumps(r, indent=2))
        return
    names = args.names.split(',')
    nm = lambda i: names[i] if i < len(names) else str(i)
    print(f"\n{r['file']}")
    print('\n-- per figure ' + '-' * 40)
    print(f"  {'name':<8}{'height px':>10}{'torso W/H':>12}")
    for i, (h, a) in enumerate(zip(r['heights_px'], r['torso_aspect_w_over_h'])):
        print(f"  {nm(i):<8}{h:>10}{a:>12.3f}")
    print(f"\n  aspect spread          {r['aspect_spread_pct']:>7.2f}%   target > 18%   "
          f"{'OK' if r['aspect_spread_pct'] > 18 else 'FAIL'}")
    print('\n-- pairwise silhouette IoU (height-normalised) ' + '-' * 8)
    for p in r['pairs']:
        print(f"  {nm(p['a']):<6} vs {nm(p['b']):<6} {p['iou']:>8.3f}")
    print(f"\n  mean IoU               {r['mean_iou']:>7.3f}    target < 0.72   "
          f"{'OK' if r['mean_iou'] < 0.72 else 'FAIL'}")
    print(f"  worst (max) pair       {r['max_iou']:>7.3f}\n")


if __name__ == '__main__':
    main()
