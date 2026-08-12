#!/usr/bin/env python3
"""
Before/after report for a lighting or grade change.

Two numbers decide whether a rig is doing its job, and they are not the same
number:

  **fidelity** — how far each fighter's lit skin band is from the tone the roster
  authored for them. This is the one that catches "the illuminant is repainting
  the characters", which is the failure that produced four orange fighters.

  **separation** — the smallest CIELAB distance between any two fighters. This is
  the one that catches "the characters are individually plausible but nobody can
  tell them apart". Judged against the separation the *palette* asks for, because
  a rig cannot be blamed for two skins that were authored 8 dE apart, and a rig
  that reports more than the palette contains is inventing it.

  python3 tools/lighting/compare.py shots/before.png shots/after.png
"""
import math
import sys

import importlib.util
import pathlib

# Loaded by path because the sibling module's name has a hyphen in it, which is
# the right name for a CLI tool and an impossible one for `import`.
_spec = importlib.util.spec_from_file_location(
    'measure_skin', pathlib.Path(__file__).with_name('measure-skin.py')
)
_m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m)
analyse, to_lab, FIGHTERS, AUTHORED = _m.analyse, _m.to_lab, _m.FIGHTERS, _m.AUTHORED


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    before, after = sys.argv[1], sys.argv[2]
    # Two spaces, because they answer different questions. The delivered frame is
    # what a viewer sees, vignette included. Dividing the vignette back out is
    # what isolates the *light rig*: the lineup puts two fighters at the frame
    # edge, and comparing them to the two in the middle through a lens falloff
    # measures the lens, not the lighting.
    raw = '--raw' in sys.argv
    print(f'space: {"delivered frame (vignette included)" if raw else "vignette-compensated (rig only)"}')

    authored = {f: to_lab([((h >> s) & 255) / 255 for s in (16, 8, 0)]) for f, h in AUTHORED.items()}
    pairs = [(a, b) for i, a in enumerate(FIGHTERS) for b in FIGHTERS[i + 1:]]

    print(f'{"":10} {"authored":>26} | {"before":>26} | {"after":>26}')
    print(f'{"fighter":10} {"L*":>8}{"a*":>8}{"b*":>8}   {"L*":>8}{"a*":>8}{"b*":>8}  '
          f'{"dE":>5} {"L*":>8}{"a*":>8}{"b*":>8}  {"dE":>5}')

    rows = {}
    for label, path in (('before', before), ('after', after)):
        rows[label] = analyse(path, compensate_vignette=not raw)

    fid = {'before': [], 'after': []}
    for f in FIGHTERS:
        line = f'{f:10}' + ''.join(f'{v:8.1f}' for v in authored[f])
        for label in ('before', 'after'):
            lab = rows[label][f]['bandLit']['lab']
            d = math.dist(lab, authored[f])
            fid[label].append(d)
            line += '   ' + ''.join(f'{v:8.1f}' for v in lab) + f' {d:5.1f}'
        print(line)
    print(f'{"mean fidelity error":30}' +
          f'{"":26}{sum(fid["before"]) / 4:6.1f}{"":26}{sum(fid["after"]) / 4:6.1f}')

    print(f'\n{"pair":12} {"authored":>9} {"before":>9} {"after":>9}   verdict')
    worst = {'authored': 1e9, 'before': 1e9, 'after': 1e9}
    for a, b in pairs:
        da = math.dist(authored[a], authored[b])
        db = math.dist(rows['before'][a]['bandLit']['lab'], rows['before'][b]['bandLit']['lab'])
        dc = math.dist(rows['after'][a]['bandLit']['lab'], rows['after'][b]['bandLit']['lab'])
        worst['authored'] = min(worst['authored'], da)
        worst['before'] = min(worst['before'], db)
        worst['after'] = min(worst['after'], dc)
        print(f'{a + "-" + b:12} {da:9.1f} {db:9.1f} {dc:9.1f}   '
              f'{"holds" if dc >= da else "BELOW PALETTE"}')
    print(f'{"MIN":12} {worst["authored"]:9.1f} {worst["before"]:9.1f} {worst["after"]:9.1f}')

    # Ordering: the audience reads identity off relative lightness, so a rig that
    # swaps two fighters' brightness has broken the roster even if every pairwise
    # distance is healthy.
    order = lambda d: sorted(FIGHTERS, key=lambda x: -d[x][0])
    ideal = order(authored)
    print(f'\nlightness order   authored {" > ".join(ideal)}')
    for label in ('before', 'after'):
        got = order({f: rows[label][f]['bandLit']['lab'] for f in FIGHTERS})
        print(f'{"":18}{label:9} {" > ".join(got)}   '
              f'{"MATCHES" if got == ideal else "INVERTED"}')

    # Clipping: a channel pinned at 255 has thrown away both hue and form, and it
    # is the mechanism by which two different warm skins become the same orange.
    # Only meaningful on the delivered frame — the vignette compensation divides
    # values up and would report clipping that no viewer ever sees.
    print()
    if not raw:
        print('clipping   (only measured on the delivered frame; pass --raw)')
        return 0
    for label in ('before', 'after'):
        pinned = {f: rows[label][f]['bandLit']['rgb255'][0] for f in FIGHTERS}
        hot = max(pinned.values())
        print(f'{label:9} brightest red channel in a lit band = {hot:.1f}/255'
              f'  {"CLIPPING" if hot > 250 else "ok"}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
