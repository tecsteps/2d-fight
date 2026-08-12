# Review 003 — dressed roster

**Frame:** `shots/v3-0000.png`. All four costumed, faces, hair, hands/feet, body
divergence, stage rebuild.
**Score: 18 / 50** (001: 13, 002: 15). **Verdict: no. Gap ~73%.**

| # | Criterion | 001 | 002 | 003 |
| --- | --- | --- | --- | --- |
| 1 | Silhouette legibility | 2 | 2 | **3** |
| 2 | Deliberate shadow shapes | 1 | 2 | 2 |
| 3 | Colour separation | 2 | 2 | 2 |
| 4 | Confident linework | 1 | 2 | **3** |
| 5 | Anatomical authority | 2 | 2 | 2 |
| 6 | Faces that act | 1 | 1 | **2** |
| 7 | Stage depth and life | 1 | 1 | 1 |
| 8 | Impact | 1 | 1 | 1 |
| 9 | Animation reads as drawn | 1 | 1 | 1 |
| 10 | Finish | 1 | 1 | 1 |

> The seven criteria with no metric in `FRAME_BUDGET.md` total **11/35** and have
> moved 2 points in three reviews. The two that are measured moved 4.

## Two places we gamed our own budget

**1. `pct_above_128` was passed by brightening an empty plane.** 79.5% of those
pixels are floor below y=620; only 2.2% of the frame is bright *character*. That
is precisely what rule 1 of `FRAME_BUDGET.md` forbids — the same failure class as
the B2 ink/lighting collision, one wave later.

**2. `topbin` and `bands` were passed at a granularity where the defect
disappears.** Both are computed over the whole-character mask, averaging gi with
skin with sash with wraps. Measured on cloth alone: **Kai's gi is 61% in one 8-L
bin**, Mali's shorts 67%, Davi's vest 67%. Measured on bare skin, every fighter
is still **two clusters separated by a 48–96 L void**, with bins inside each
cluster 8 L apart — a smooth gradient sampled into bins, not cel banding.
Same move as measuring dropout instead of contrast in 002.

## What genuinely landed

- **Ink**: contrast 6.6–15.4 L → **37.9–45.5 L**. 002's headline finding fixed for
  Mali and Davi (dropout 0.5% / 1.7%).
- **Bloom halo gone** — background flat to ±1 L outward from every silhouette.
- **Inverted floor aerial perspective fixed**; far floor L60–73, near L113–133.
- **Figure–ground contrast fixed**: Weber 0.77–1.37, spread 1.78× (was 8×). Kai's
  silhouette-within-12L 43.2% → 12.4%.
- **Hands and feet built.** Fingers, thumbs, ankles, toe breaks.
- **Body width diverged**: heights 398–464px (16.6% spread), aspect spread 35.4%,
  mean IoU 0.843 → 0.716.
- Median luma 21 → 52.1, below-16 35.3% → 1.18%, clipping 0.00%.

## The magenta is real, on all four, and it is one global constant

14–36% of every fighter's *verified bare skin* sits in H300–360. The mechanism:
**the hue was rotated 45–55° at essentially unchanged chroma.** A shadow that
keeps the light side's saturation and moves 50° in hue is not a shadow, it is a
second colour — which is why it reads as bruising rather than form.

Every fighter's skin shadow lands in **H333–355, a 22° window**: the rotation is a
global constant, not per-character. Worst instances: all four faces (it follows
brow ridge, nasolabial fold and cheekbone, so it is a crease/AO term, not a light
terminator), Kai's bare shins, Mali's thighs, and Vera's forearm — 25 of 34 px in
one flat H335 slab, with her other arm 26px of flat lit. **Whole-limb assignment,
not a terminator on a form.**

Corrected skin-only numbers (the per-figure table is cloth-confounded):

| | tool dHue | real skin | tool sh/lit | real skin |
| --- | --- | --- | --- | --- |
| kai | −148 (navy gi) | −53 | 0.23 | 0.60 |
| mali | −20 | −42 | 0.29 | 0.50 |
| davi | −40 | −45 | 0.39 | 0.82 (nearly flat) |
| vera | −24 | −45 | 0.26 | 0.67 |

Minimum shadow-colour pair on skin is **18.4**, not the reported 7.7 — real at
half the reported magnitude. **Do not close it as a tooling bug.**

## New: the silhouettes are solid slabs

Separate runs across the silhouette per height fraction (2+ means air between a
limb and the body):

| | 0.35 | 0.42 | 0.50 | 0.58 | 0.66 | 0.74 | 0.82 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| kai render | 1 | 1 | 1 | 2 | 1 | 1 | 2 |
| kai ref | 4 | 3 | 7 | 6 | 2 | 2 | 2 |
| davi render | 2 | 1 | 2 | 2 | 1 | 1 | 1 |
| davi ref | 7 | 5 | 5 | 2 | 2 | 2 | 3 |

Kai is a single mass at five of seven rows. **Davi's legs never separate at all.**
Vera's arms are fused to her torso from 0.30H to 0.55H. A KOF XIII silhouette is
full of holes; ours are slabs — which is why costumes and hair bought so little
IoU.

## Vera's build — confirmed, but my diagnosis was wrong

`build` is **1.0**, the ceiling. But her **shoulders are correct** (ratio 1.00–1.08
vs reference at the deltoids). What is oversized is the trapezius (**1.73×** at
0.15H) and the hip/upper-thigh block (1.44–1.48×). The 1.73 is the tell: **she has
no neck** — the traps meet the jaw, so her head sits directly on her shoulders.
That, not shoulder width, is what reads as bodybuilder. The render also closes her
vest into a solid slab across the chest, deleting the waist the reference has.

Shoulder ordering is now **inverted against the sheets**: references give Davi 245
per-mille at 0.20H and Vera 190 — Davi is the broader. The render gives Davi 194,
Vera 295. `build` was pinned to 0.24 and 1.0 at the two ends without checking that
it made Davi a rail.

## Finish defects visible at gameplay size

- **Vera's vest right panel is a detached single-sided shell** — visible inner
  surface, black air gap at the shoulder, backfaces at the collar, a triangular
  flap protruding into the sky, and a self-intersection.
- **Davi has a black hole punched through his trousers** at the right hip, blue
  backface showing.
- Ink dropout **31.3% on Kai, 26.0% on Vera** (Mali 0.5%, Davi 1.7%). Width sd
  1.9–3.1px on a 3–4px line — ±100% variance, tracking luminance rather than
  occlusion depth, so it is still partly a lighting term.
- **Vera has no contact shadow** (+0.7%; others −10 to −15%).
- The cast-shadow system (L46) does not connect to the contact-pool system (L76)
  under the same foot — a soft radial pool ~60px per figure. The point-light pool
  again, sign-flipped.

## Composition

Figures are **7.0%** of the frame. Empty floor is **26.9% at mean L121** —
brighter than three of four fighters. The brightest quarter of the image is the
part with nothing in it. Horizon at y=586 puts the camera at **hip height**,
looking up at four figures whose heads are all pitched at the floor.

## The single highest-leverage change

**Pose the four fighters and raise the camera.** One art-directed standing pose
each with a weight shift and a line of action, arms carried away from the ribs so
there is air in the silhouette, heads up on the eyeline; camera to chest height,
fighters filling ~55% of frame height instead of 43%, dead foreground cropped.

It is the only available change that moves **four rubric rows at once** — 1
(negative space is what IoU actually measures), 5 (a weight shift describes mass
the geometry doesn't), 9 (there is no other way to score above 1), and 6 (the
faces are invisible because every head points at the floor). No renderer work, no
regression risk to the ink or value budget just earned.

## Also flagged

`silhouette.py` prints OK/FAIL against `mean IoU < 0.72` and `aspect spread > 18%`
— **neither target exists in `FRAME_BUDGET.md`**, and mean IoU clears by 0.004.
Targets authored alongside the work they grade are not targets.

Criteria 7, 8 and 9 total **3/15 and have not moved in three reviews.** That is
30% of the rubric being permanently deferred while the same two shading rows get
re-litigated each wave. Scheduled, or the ceiling here is 35/50.
