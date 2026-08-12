#!/usr/bin/env python3
"""Build a blind A/B comparison sheet for the critic.

The point of this tool is to remove every cue that would let a critic know which
frame is ours. A critic told "yours is on the left" will find reasons to like the
left. So: both frames are normalised to the same height, composited on the same
neutral ground with identical padding, the side assignment is randomised from a
seed, and the answer key is written to a separate file that is NOT shown to the
critic until after it has committed to a verdict.

Two modes:

  blind   ours vs a real KOF XIII reference frame. Requires reference frames in
          reference/kof13/. This is the comparison the project is actually
          graded on.

  rubric  no reference available — emit our frame alone at presentation quality,
          for scoring against an explicit written rubric instead. Weaker, but it
          still catches the things that are obviously short of the bar.

Usage:
  python3 tools/critic/sheet.py --ours shots/lineup2-0000.png \
      [--ref reference/kof13/some-frame.jpg] [--seed 7] [--out shots/critic]
"""
import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image

GROUND = (14, 14, 18)
PAD = 26
GUTTER = 34
TARGET_H = 900


def load_fit(path: Path, h: int) -> Image.Image:
    im = Image.open(path).convert("RGB")
    w = round(im.width * h / im.height)
    return im.resize((w, h), Image.LANCZOS)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ours", required=True)
    ap.add_argument("--ref", default="")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default="shots/critic")
    ap.add_argument("--height", type=int, default=TARGET_H)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    ours = Path(args.ours)
    stem = ours.stem

    if not args.ref:
        # Rubric mode: present our frame alone, padded on the same neutral
        # ground so the critic is not reacting to a raw screenshot's edges.
        im = load_fit(ours, args.height)
        canvas = Image.new("RGB", (im.width + PAD * 2, im.height + PAD * 2), GROUND)
        canvas.paste(im, (PAD, PAD))
        sheet = out / f"{stem}-rubric.jpg"
        canvas.save(sheet, quality=94)
        (out / f"{stem}-rubric.key.json").write_text(
            json.dumps({"mode": "rubric", "ours": str(ours), "note": "no reference frame available"}, indent=2)
        )
        print(f"wrote {sheet}  (rubric mode — no reference)")
        return

    ref = Path(args.ref)
    a = load_fit(ours, args.height)
    b = load_fit(ref, args.height)

    # Deterministic side assignment: same seed and same inputs always produce the
    # same sheet, so a critic verdict can be re-checked later.
    digest = hashlib.sha256(f"{args.seed}:{ours}:{ref}".encode()).digest()
    ours_left = digest[0] % 2 == 0

    left, right = (a, b) if ours_left else (b, a)
    w = left.width + GUTTER + right.width + PAD * 2
    h = args.height + PAD * 2
    canvas = Image.new("RGB", (w, h), GROUND)
    canvas.paste(left, (PAD, PAD))
    canvas.paste(right, (PAD + left.width + GUTTER, PAD))

    sheet = out / f"{stem}-blind.jpg"
    canvas.save(sheet, quality=94)

    key = {
        "mode": "blind",
        "left": "ours" if ours_left else "reference",
        "right": "reference" if ours_left else "ours",
        "ours": str(ours),
        "reference": str(ref),
        "seed": args.seed,
    }
    (out / f"{stem}-blind.key.json").write_text(json.dumps(key, indent=2))
    print(f"wrote {sheet}")
    print(f"key   {out / f'{stem}-blind.key.json'}  (do NOT show the critic)")


if __name__ == "__main__":
    main()
