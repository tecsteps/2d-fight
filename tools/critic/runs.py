#!/usr/bin/env python3
"""Negative space in the silhouette, counted as runs per height fraction.

Review 003's finding: our fighters are *slabs*. Silhouette IoU and outline work
both move the boundary of one solid blob, and a KOF XIII sprite is not a solid
blob — it is full of holes. Air between a forearm and the ribs, between the
thighs, under a raised elbow. That negative space is what makes a pose readable
at 40 px, and no outline pass can invent it.

So this counts, on a horizontal slice at a given fraction of the figure's own
height, how many separate solid runs the silhouette breaks into. One run at
0.42H means the arm is welded to the torso. Two or three means light passes
through.

Method:

* **Fraction is measured from the crown**, so 0.35–0.55H is the band where a
  hanging or guarding arm passes the ribs — the band review 003 flagged.
* **Runs and gaps below `--min-frac` of figure height are discarded** before
  counting, in that order. JPEG ringing on the reference sheets and the ink
  shell on ours both produce 1–2 px specks, and a metric that counts those would
  report holes where the eye sees none. The default 1% of height is ~9 px on a
  reference sheet and ~5 px on a 1080p lineup capture.
* Works on either input: our matte captures (white on black, threshold 128) and
  the reference sheets (art on black, threshold ~18), selected by `--thresh`.

  python3 tools/critic/runs.py shots/tag-matte-0000.png
  python3 tools/critic/runs.py reference/kai/06-fighting-guard.jpg --thresh 18
  python3 tools/critic/runs.py shots/a.png shots/b.png --json
"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

LUMA = np.array([0.2126, 0.7152, 0.0722])
# The ladder runs from just under the shoulders to just above the ankles. Review
# 003 quoted seven rows starting at 0.35; two more are added at the top because a
# raised guard puts the whole arm above 0.35H — on the reference sheets Kai's
# fists sit at 0.22–0.30H — and reporting only the lower rows would score an
# arms-up pose as a slab for a reason that has nothing to do with negative space.
FRACTIONS = (0.25, 0.30, 0.35, 0.42, 0.50, 0.58, 0.66, 0.74, 0.82, 0.90)


def figures(path: Path, thresh: float, min_w: int = 40):
    """Every figure in the frame, cropped to its own bounding box, left to right."""
    m = (np.asarray(Image.open(path).convert('RGB')).astype(np.float32) @ LUMA) > thresh
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


def runs_in_row(row: np.ndarray, min_len: int) -> int:
    """Solid runs left to right, after closing hairline gaps and dropping specks."""
    idx = np.flatnonzero(row)
    if idx.size == 0:
        return 0
    # Close first: a 2 px ink seam across a limb is not two limbs.
    segs = []
    start = idx[0]
    prev = idx[0]
    for i in idx[1:]:
        if i - prev > min_len:
            segs.append((start, prev))
            start = i
        prev = i
    segs.append((start, prev))
    return sum(1 for a, b in segs if b - a + 1 >= min_len)


def measure(path: Path, thresh: float, min_frac: float) -> dict:
    out = []
    for mask in figures(path, thresh):
        h = mask.shape[0]
        min_len = max(2, int(round(h * min_frac)))
        rows = {}
        for f in FRACTIONS:
            y = min(h - 1, int(round(f * h)))
            rows[f] = runs_in_row(mask[y], min_len)
        # The three rows review 003 called out: where a carried arm clears the
        # ribs. A pose passes only if every one of them has air in it.
        guard = [rows[f] for f in (0.35, 0.42, 0.50)]
        out.append({
            'height_px': int(h),
            'width_px': int(mask.shape[1]),
            'runs': rows,
            'guard_band_min': min(guard),
            'open_pct': round(100.0 * (1 - mask.mean()), 1),
        })
    return {'file': str(path), 'figures': out}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('images', nargs='+')
    ap.add_argument('--thresh', type=float, default=128.0,
                    help='luma cut; 128 for a matte, ~18 for a reference sheet')
    ap.add_argument('--min-frac', type=float, default=0.010,
                    help='shortest run or gap that counts, as a fraction of figure height')
    ap.add_argument('--names', default='kai,mali,davi,vera')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    results = [measure(Path(p), args.thresh, args.min_frac) for p in args.images]
    if args.json:
        print(json.dumps(results, indent=2))
        return

    names = args.names.split(',')
    head = '  '.join(f'{f:>4.2f}' for f in FRACTIONS)
    for r in results:
        print(f"\n{r['file']}")
        print(f"  {'figure':<8}{'h px':>6}  {head}   {'min(.35-.50)':>13}")
        for i, fig in enumerate(r['figures']):
            nm = names[i] if i < len(names) else str(i)
            cells = '  '.join(f"{fig['runs'][f]:>4d}" for f in FRACTIONS)
            flag = 'OK' if fig['guard_band_min'] >= 2 else 'SLAB'
            print(f"  {nm:<8}{fig['height_px']:>6}  {cells}   {fig['guard_band_min']:>9d} {flag}")
    print()


if __name__ == '__main__':
    main()
