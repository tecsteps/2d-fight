#!/usr/bin/env python3
"""
Skin-separation meter for the `lineup` capture.

Why this exists: four fighters carry four *authored* skin tones, and the only way
to know whether the light rig and the grade are preserving that authorship or
quietly collapsing it into one orange is to measure the pixels. A globally warm
frame is exactly the case where a human eye says "fine" while every tone has
converged — the eye discounts the illuminant, the screenshot does not.

Sampling is by fixed rects rather than by segmentation. The lineup camera and the
fighter placement are deterministic, so the same patch of forearm is at the same
pixel in every capture; and a segmentation-based sampler kept mistaking a navy gi
for the backdrop. Rects are stored as frame fractions so a 4K capture measures
the same anatomy.

Three regions per fighter, all of them bare skin under every costume in the
roster: the lit forearm, the shadow-side forearm, and the cheek/jaw. Separation
has to survive in the lit *and* the shadow family, since a rig that separates
only the lit side reads as one skin tone the moment a fighter turns.

  python3 tools/lighting/measure-skin.py shots/lgt-base-0000.png --debug dbg.png
"""
import argparse
import json
import math
import sys

from PIL import Image, ImageDraw

# Order matches ROSTER in src/data/roster/index.ts, which is the order main.ts
# lays the lineup out in, left to right.
FIGHTERS = ['kai', 'mali', 'davi', 'vera']
AUTHORED = {'kai': 0xE09868, 'mali': 0xC2793F, 'davi': 0x7D4826, 'vera': 0xE2A17C}

# (x0, y0, x1, y1) in 1920x1080 pixels, converted to fractions below.
RECTS = {
    'kai':  {'lit': (415, 472, 433, 532), 'shade': (502, 486, 518, 532), 'face': (452, 350, 486, 378)},
    'mali': {'lit': (757, 492, 773, 548), 'shade': (841, 505, 857, 548), 'face': (782, 364, 812, 396)},
    'davi': {'lit': (1092, 486, 1112, 545), 'shade': (1175, 500, 1192, 545), 'face': (1110, 342, 1138, 370)},
    'vera': {'lit': (1402, 486, 1418, 540), 'shade': (1493, 505, 1513, 545), 'face': (1432, 362, 1462, 390)},
}
REGIONS = ('lit', 'shade', 'face')
SUMMARY = ('bandLit', 'bandDark', 'all')
REF_W, REF_H = 1920, 1080


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def to_lab(rgb):
    """sRGB 0..1 -> CIELAB (D65). Plain CIE76 space; only distances are used."""
    r, g, b = (srgb_to_linear(v) for v in rgb)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(t):
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116

    fx, fy, fz = f(x), f(y), f(z)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def to_hsv(rgb):
    r, g, b = rgb
    mx, mn = max(rgb), min(rgb)
    d = mx - mn
    if d < 1e-6:
        h = 0.0
    elif mx == r:
        h = (60 * ((g - b) / d)) % 360
    elif mx == g:
        h = 60 * ((b - r) / d) + 120
    else:
        h = 60 * ((r - g) / d) + 240
    return (h, 0.0 if mx < 1e-6 else d / mx, mx)


def stats(vals):
    m = tuple(sum(v[c] for v in vals) / len(vals) for c in range(3))
    return {
        'n': len(vals),
        'rgb255': [round(v * 255, 1) for v in m],
        'hex': '%02x%02x%02x' % tuple(min(255, int(v * 255 + 0.5)) for v in m),
        'hsv': [round(x, 2) for x in to_hsv(m)],
        'lab': [round(x, 1) for x in to_lab(m)],
    }


def analyse(path, debug_path=None):
    img = Image.open(path).convert('RGB')
    W, H = img.size
    px = img.load()
    sx, sy = W / REF_W, H / REF_H
    dbg = ImageDraw.Draw(img) if debug_path else None

    out = {}
    for fid in FIGHTERS:
        entry = {}
        pooled = []
        for region in REGIONS:
            x0, y0, x1, y1 = RECTS[fid][region]
            x0, x1 = int(x0 * sx), int(x1 * sx)
            y0, y1 = int(y0 * sy), int(y1 * sy)
            vals = []
            for y in range(y0, y1):
                for x in range(x0, x1):
                    r, g, b = px[x, y]
                    # Ink lines and cavities are not skin; a rect that clips the
                    # outline would otherwise drag the mean toward black.
                    if r + g + b < 75:
                        continue
                    vals.append((r / 255, g / 255, b / 255))
            entry[region] = stats(vals) if vals else None
            pooled += vals
            if dbg:
                colour = {'lit': (0, 255, 255), 'shade': (255, 0, 255), 'face': (255, 255, 0)}[region]
                dbg.rectangle([x0, y0, x1 - 1, y1 - 1], outline=colour)
        # The headline numbers. Cel shading puts skin in a handful of discrete
        # bands, so the honest question is not "what is the average pixel" — that
        # depends on how much of each rect happened to fall on the lit side — but
        # "what colour is this fighter's lit band, and what colour is the shadow
        # band". Percentiles over the pooled pixels answer that without needing
        # the sample rects to be perfectly matched across four body shapes.
        if pooled:
            ranked = sorted(pooled, key=lambda c: 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])
            k = max(len(ranked) // 4, 1)
            entry['bandLit'] = stats(ranked[-k:])
            entry['bandDark'] = stats(ranked[:k])
            entry['all'] = stats(pooled)
        else:
            entry['bandLit'] = entry['bandDark'] = entry['all'] = None
        out[fid] = entry

    if debug_path:
        img.save(debug_path)
    return out


def pairwise(entries, key):
    labs = {f: e[key]['lab'] for f, e in entries.items() if e.get(key)}
    pairs = {}
    for i, a in enumerate(FIGHTERS):
        for b in FIGHTERS[i + 1:]:
            if a in labs and b in labs:
                pairs[f'{a}-{b}'] = round(math.dist(labs[a], labs[b]), 1)
    return pairs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('png')
    ap.add_argument('--debug')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()

    entries = analyse(a.png, a.debug)

    authored_lab = {f: to_lab([((h >> s) & 255) / 255 for s in (16, 8, 0)]) for f, h in AUTHORED.items()}
    authored = {}
    for i, x in enumerate(FIGHTERS):
        for y in FIGHTERS[i + 1:]:
            authored[f'{x}-{y}'] = round(math.dist(authored_lab[x], authored_lab[y]), 1)

    if a.json:
        print(json.dumps({'entries': entries,
                          'pairs': {r: pairwise(entries, r) for r in REGIONS + SUMMARY},
                          'authored': authored}, indent=1))
        return 0

    print(a.png)
    for region in SUMMARY + REGIONS:
        print(f'\n-- {region} --')
        print(f'{"fighter":8} {"hex":8} {"R":>6}{"G":>6}{"B":>6}  {"H":>6} {"S":>6} {"V":>6} '
              f'{"L*":>6}{"a*":>6}{"b*":>6}   n')
        for f in FIGHTERS:
            d = entries[f].get(region)
            if not d:
                print(f'{f:8} --')
                continue
            r, g, b = d['rgb255']
            h, s, v = d['hsv']
            L, A, B = d['lab']
            print(f'{f:8} {d["hex"]:8} {r:6.1f}{g:6.1f}{b:6.1f}  {h:6.1f}{s:6.3f}{v:6.3f} '
                  f'{L:6.1f}{A:6.1f}{B:6.1f} {d["n"]:5d}')
        p = pairwise(entries, region)
        if p:
            hs = [entries[f][region]['hsv'][0] for f in FIGHTERS if entries[f].get(region)]
            vs = [entries[f][region]['hsv'][2] for f in FIGHTERS if entries[f].get(region)]
            print('  dE76: ' + '  '.join(f'{k}={v}' for k, v in p.items()))
            print(f'  MIN PAIR dE76 = {min(p.values()):.1f}   hue span = {max(hs) - min(hs):.1f} deg'
                  f'   value span = {max(vs) - min(vs):.3f}')

    print('\n-- authored palette (the separation the data asks for) --')
    print('  dE76: ' + '  '.join(f'{k}={v}' for k, v in authored.items()))
    print(f'  MIN PAIR dE76 = {min(authored.values())}   '
          f'hue span = {max(to_hsv([((h >> s) & 255) / 255 for s in (16, 8, 0)])[0] for h in AUTHORED.values()) - min(to_hsv([((h >> s) & 255) / 255 for s in (16, 8, 0)])[0] for h in AUTHORED.values()):.1f} deg')
    return 0


if __name__ == '__main__':
    sys.exit(main())
