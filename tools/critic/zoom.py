#!/usr/bin/env python3
"""Magnify regions of a capture with nearest-neighbour, for edge forensics.

Quality arguments about linework, terminator sharpness and aliasing cannot be
settled at fit-to-screen size — a 4px ink line and a 10px blurred halo look
identical when the frame is scaled to fit a review pane. This crops a region and
scales it with NEAREST so every pixel boundary stays a boundary.

  python3 tools/critic/zoom.py shots/lineup2-0000.png --box 1380,380,1560,620 --scale 4
  python3 tools/critic/zoom.py shots/lineup2-0000.png --preset vera-arm
"""
import argparse
from pathlib import Path

from PIL import Image

# Regions worth re-checking after any shading or outline change, in 1920x1080
# lineup-scene coordinates.
PRESETS = {
    'kai-torso': (390, 360, 580, 620),
    'kai-shin': (430, 640, 560, 800),
    'mali-torso': (730, 360, 900, 620),
    'davi-edge': (1050, 380, 1230, 620),
    'vera-arm': (1380, 380, 1560, 620),
    'vera-hand': (1370, 520, 1470, 620),
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('image')
    ap.add_argument('--box', default='', help='l,t,r,b')
    ap.add_argument('--preset', default='', help=f"one of: {', '.join(PRESETS)}, or 'all'")
    ap.add_argument('--scale', type=int, default=4)
    ap.add_argument('--out', default='shots/zoom')
    args = ap.parse_args()

    im = Image.open(args.image).convert('RGB')
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    stem = Path(args.image).stem

    if args.preset == 'all':
        boxes = PRESETS
    elif args.preset:
        boxes = {args.preset: PRESETS[args.preset]}
    elif args.box:
        boxes = {'box': tuple(int(v) for v in args.box.split(','))}
    else:
        raise SystemExit('pass --box or --preset')

    for name, box in boxes.items():
        c = im.crop(box)
        c = c.resize((c.width * args.scale, c.height * args.scale), Image.NEAREST)
        p = out / f'{stem}-{name}-x{args.scale}.png'
        c.save(p)
        print(f'wrote {p}  {c.size}')


if __name__ == '__main__':
    main()
