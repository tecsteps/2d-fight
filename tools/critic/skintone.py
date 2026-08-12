#!/usr/bin/env python3
"""Measure lit vs shadow skin temperature per fighter in a lineup capture.

Review 001's central factual claim was that shadows are *warmer* than lit skin
across the whole roster, which the NPR module's own documentation denied. That
argument can only be settled numerically, so this reports it numerically.

Per fighter it masks the skin pixels inside a hand-set body box (hue in the
flesh range, saturation above background), sorts them by value, and reports the
mean of a bright percentile band (the lit plane) and a dark percentile band (the
shadow plane). Percentile bands rather than the extremes, so a blown specular or
an ink pixel cannot move the number.

## Why there are two hue columns

Review 001 argued temperature from **HSV hue**, and on orange that axis is
actively misleading. Adding blue skylight to orange skin *lowers* HSV hue,
because hue there is 60*(G-B)/(R-B) and a blue lift closes the G-B gap faster
than the R-B one. Measured on Mali's own skin, 0xc2793f:

    lit                          HSV H 26.6   Lab b* +42.9
    + skylight fill (10,16,32)   HSV H 12.0   Lab b*  +6.5   <- much cooler
    + skylight fill (14,22,46)   HSV H  350    Lab b*  +1.1   <- cooler again

So "H31 lit -> H24 shadow" is the signature of a *cool* fill just as much as a
warm one, and cannot decide the question either way.

`warmth` is the metric that can: CIELAB **b\* normalised by L\***, i.e.
yellowness per unit lightness. It is invariant to the value drop a shadow must
have, so a shadow that is only *darker* scores the same warmth as its lit side,
while a shadow sitting in skylight scores lower. On the baseline frame the
authored skin shadows score *higher* warmth than the lit skin, which is what
makes review 001's conclusion correct even though its metric was not.

  python3 tools/critic/skintone.py shots/diag-0000.png
  python3 tools/critic/skintone.py shots/a.png shots/b.png --mask
"""
from __future__ import annotations

import argparse
import colorsys
import math
from pathlib import Path

from PIL import Image

_WHITE = (0.95047, 1.0, 1.08883)


def _lin(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lab(r: int, g: int, b: int) -> tuple[float, float, float]:
    """CIELAB L*, a*, b* from 8-bit sRGB."""
    rl, gl, bl = _lin(r / 255.0), _lin(g / 255.0), _lin(b / 255.0)
    x = (0.4124 * rl + 0.3576 * gl + 0.1805 * bl) / _WHITE[0]
    y = (0.2126 * rl + 0.7152 * gl + 0.0722 * bl) / _WHITE[1]
    z = (0.0193 * rl + 0.1192 * gl + 0.9505 * bl) / _WHITE[2]

    def f(t: float) -> float:
        return t ** (1 / 3) if t > 216 / 24389 else (841 / 108) * t + 4 / 29

    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)

# Skin sample boxes in 1920x1080 lineup coordinates, l,t,r,b. Kai is costumed by
# the time this runs, so he is sampled on the bare shoulders/arms instead of the
# torso; everyone else is sampled on the chest and abdomen, which is where the
# review found the amoeba shading.
BOXES: dict[str, list[tuple[int, int, int, int]]] = {
    'kai': [(408, 480, 452, 600), (518, 480, 572, 600), (444, 336, 500, 392)],
    'mali': [(752, 396, 872, 620)],
    'davi': [(1082, 386, 1198, 620)],
    'vera': [(1396, 386, 1516, 620)],
}

# Flesh hue window in degrees. Wide enough to catch a plum-shifted shadow and a
# cool-shifted one, narrow enough to reject navy cloth and the purple backdrop.
HUE_LO, HUE_HI = 340.0, 60.0
SAT_MIN = 0.10
VAL_MIN = 0.06

# Lit and shadow planes as percentile windows of the value distribution, used as
# a cross-check on the Otsu split below.
LIT_BAND = (0.70, 0.94)
SHADOW_BAND = (0.06, 0.30)

# Trim off each Otsu class before averaging, so the antialiased pixels straddling
# the terminator and any surviving rim pixels do not pull the two means together.
OTSU_TRIM = 0.12


def otsu_split(px) -> int:
    """Index in the value-sorted pixel list that best separates two classes.

    Percentile windows were the right tool against the baseline, whose shading was
    a continuous gradient with no two classes to find. They are the wrong tool now:
    once the terminator is a hard step the areas of the two planes differ per
    fighter, so a fixed window samples whichever plane happens to be large. Davi is
    the case that exposed it — his shadow shape is small, so a 6–30% window landed
    mostly inside his *lit* plane and reported his shadow 15 points below his light
    when the visible gap is far wider.

    Otsu finds the split that minimises intra-class variance, which is exactly the
    question "where is the terminator in this histogram".
    """
    n = len(px)
    vals = [p[0] for p in px]
    total = sum(vals)
    best, best_at, run = -1.0, n // 2, 0.0
    for i in range(1, n):
        run += vals[i - 1]
        w0, w1 = i / n, (n - i) / n
        m0, m1 = run / i, (total - run) / (n - i)
        between = w0 * w1 * (m0 - m1) ** 2
        if between > best:
            best, best_at = between, i
    return best_at


def in_hue_window(h_deg: float) -> bool:
    return h_deg >= HUE_LO or h_deg <= HUE_HI


def signed_hue(h_deg: float) -> float:
    """Hue as a signed offset from red, so a wrap past 0 averages correctly."""
    return h_deg - 360.0 if h_deg > 180.0 else h_deg


def sample(im: Image.Image, boxes: list[tuple[int, int, int, int]]):
    px = []
    for box in boxes:
        for r, g, b in im.crop(box).getdata():
            h, s, v = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
            hd = h * 360.0
            if v < VAL_MIN or s < SAT_MIN or not in_hue_window(hd):
                continue
            L, A, B = lab(r, g, b)
            px.append((v, signed_hue(hd), s, r, g, b, L, A, B))
    px.sort()
    return px


def band_stats(px, lo: float, hi: float):
    n = len(px)
    if n == 0:
        return None
    a, b = int(n * lo), max(int(n * hi), int(n * lo) + 1)
    sel = px[a:b]
    k = len(sel)
    mean_L = sum(p[6] for p in sel) / k
    mean_a = sum(p[7] for p in sel) / k
    mean_b = sum(p[8] for p in sel) / k
    return {
        'h': (sum(p[1] for p in sel) / k) % 360.0,
        'h_signed': sum(p[1] for p in sel) / k,
        's': 100.0 * sum(p[2] for p in sel) / k,
        'v': 100.0 * sum(p[0] for p in sel) / k,
        'L': mean_L,
        'a': mean_a,
        'b': mean_b,
        'chroma': math.hypot(mean_a, mean_b),
        # Yellowness per unit lightness: the axis a value drop cannot fake.
        'warmth': mean_b / max(mean_L, 1e-3),
        'n': k,
        'clipped': sum(1 for p in sel if max(p[3], p[4], p[5]) >= 255),
    }


def report(path: str, write_mask: bool) -> None:
    im = Image.open(path).convert('RGB')
    if im.size != (1920, 1080):
        print(f'# {path}: size {im.size}, boxes are authored for 1920x1080')

    print(f'\n=== {path} ===')
    print('           ---------- lit skin ----------   -------- shadow skin --------   '
          '------ delta ------')
    print(f'{"fighter":8} {"H":>6} {"S":>5} {"V":>5} {"C*":>5} {"warm":>6}   '
          f'{"H":>6} {"S":>5} {"V":>5} {"C*":>5} {"warm":>6}   '
          f'{"dH":>6} {"dV":>6} {"dwarm":>6}  {"clip%":>6} {"n":>7}')

    rows = {}
    for name, boxes in BOXES.items():
        px = sample(im, boxes)
        if len(px) < 100:
            print(f'{name:8} no skin pixels found')
            continue
        cut = otsu_split(px)
        n = len(px)
        # Fractions of the whole distribution, so band_stats can stay one code path.
        shd = band_stats(px, OTSU_TRIM * cut / n, (cut / n) * (1 - OTSU_TRIM))
        lit = band_stats(px, cut / n + OTSU_TRIM * (n - cut) / n, 1 - OTSU_TRIM * (n - cut) / n)
        if not lit or not shd:
            print(f'{name:8} Otsu split degenerate')
            continue
        # Negative dwarm = shadow is cooler than lit. This is the one that counts.
        dwarm = shd['warmth'] - lit['warmth']
        dh = shd['h_signed'] - lit['h_signed']
        clip = 100.0 * sum(1 for p in px if max(p[3], p[4], p[5]) >= 255) / len(px)
        rows[name] = {'lit': lit, 'shadow': shd, 'dh': dh, 'dwarm': dwarm, 'clip': clip}
        print(f'{name:8} {lit["h"]:6.1f} {lit["s"]:5.1f} {lit["v"]:5.1f} '
              f'{lit["chroma"]:5.1f} {lit["warmth"]:6.3f}   '
              f'{shd["h"]:6.1f} {shd["s"]:5.1f} {shd["v"]:5.1f} '
              f'{shd["chroma"]:5.1f} {shd["warmth"]:6.3f}   '
              f'{dh:+6.1f} {shd["v"] - lit["v"]:+6.1f} {dwarm:+6.3f}  '
              f'{clip:6.2f} {len(px):7d}')

    if not rows:
        return

    print()
    cool = sorted(n for n, r in rows.items() if r['dwarm'] < -0.02)
    print(f'shadow cooler than lit : {len(cool)}/{len(rows)}  {cool}'
          f'   -> {"PASS" if len(cool) == len(rows) else "FAIL"}')

    # Lab hue angle separates the roster the way an eye does; HSV hue does not.
    ident = sorted((math.degrees(math.atan2(r['lit']['b'], r['lit']['a'])), n)
                   for n, r in rows.items())
    gaps = [(round(ident[i + 1][0] - ident[i][0], 1), ident[i][1], ident[i + 1][1])
            for i in range(len(ident) - 1)]
    tight = min(gaps)
    print(f'lit Lab-hue spread     : {ident[-1][0] - ident[0][0]:.1f} deg,  '
          f'closest pair {tight[0]} deg ({tight[1]}/{tight[2]})')
    shd_ident = sorted((math.degrees(math.atan2(r['shadow']['b'], r['shadow']['a'])), n)
                       for n, r in rows.items())
    print(f'shadow Lab-hue spread  : {shd_ident[-1][0] - shd_ident[0][0]:.1f} deg')

    worst_clip = max(rows.items(), key=lambda kv: kv[1]['clip'])
    print(f'worst channel clipping : {worst_clip[0]} {worst_clip[1]["clip"]:.2f}% of skin px'
          f'   -> {"PASS" if worst_clip[1]["clip"] < 0.5 else "FAIL"}')

    lit_v = min((r['lit']['v'], n) for n, r in rows.items())
    shd_v = max((r['shadow']['v'], n) for n, r in rows.items())
    print(f'darkest lit V          : {lit_v[1]} {lit_v[0]:.1f}   '
          f'brightest shadow V: {shd_v[1]} {shd_v[0]:.1f}   '
          f'-> {"PASS" if lit_v[0] > shd_v[0] else "FAIL"}')

    lit_range = [r['lit']['v'] for r in rows.values()]
    shd_range = [r['shadow']['v'] for r in rows.values()]
    print(f'lit V band             : {min(lit_range):.1f}..{max(lit_range):.1f} '
          f'(spread {max(lit_range) - min(lit_range):.1f}, ratio '
          f'{max(lit_range) / max(min(lit_range), 1e-3):.2f})')
    print(f'shadow V band          : {min(shd_range):.1f}..{max(shd_range):.1f} '
          f'(spread {max(shd_range) - min(shd_range):.1f})')

    if write_mask:
        out = Path('shots/zoom') / f'{Path(path).stem}-skinmask.png'
        out.parent.mkdir(parents=True, exist_ok=True)
        m = im.copy()
        for boxes in BOXES.values():
            for box in boxes:
                crop = im.crop(box)
                data = []
                for r, g, b in crop.getdata():
                    h, s, v = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
                    ok = v >= VAL_MIN and s >= SAT_MIN and in_hue_window(h * 360.0)
                    data.append((r, g, b) if ok else (0, 255, 0))
                crop.putdata(data)
                m.paste(crop, box[:2])
        m.save(out)
        print(f'wrote {out}')


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('images', nargs='+')
    ap.add_argument('--mask', action='store_true', help='write a masked debug image')
    args = ap.parse_args()
    for p in args.images:
        report(p, args.mask)


if __name__ == '__main__':
    main()
