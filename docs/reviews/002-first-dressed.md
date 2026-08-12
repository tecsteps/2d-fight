# Review 002 — first dressed lineup

**Frame:** `shots/full-0000.png` — Kai costumed, hair on all four, ink rewritten,
cel shading rewritten, lighting rig rebuilt.
**Score: 15 / 50 (was 13). Verdict: no. Honest gap: ~82%.**

| # | Criterion | 001 | 002 |
| --- | --- | --- | --- |
| 1 | Silhouette legibility | 2 | 2 |
| 2 | Deliberate shadow shapes | 1 | **2** |
| 3 | Colour separation | 2 | 2 |
| 4 | Confident linework | 1 | **2** |
| 5 | Anatomical authority | 2 | 2 |
| 6 | Faces that act | 1 | 1 |
| 7 | Stage depth and life | 1 | 1 |
| 8 | Impact | 1 | 1 |
| 9 | Animation reads as drawn | 1 | 1 |
| 10 | Finish | 1 | 1 |

Two points from a wave that rewrote three systems. Both went to the two systems
rewritten; two other things went backwards.

## The headline finding: the ink fix was cancelled by the lighting fix

The ink agent was told to colour the contour as a dark tint of the local surface
rather than black — correct for a mid-value stage. The lighting agent
simultaneously took the stage to near-black. A dark tint of anything on a black
ground is invisible.

Median ink-to-background contrast: **Vera 6.6 L**, with 58.4% of her contour under
8 L. Vera's left torso edge at y=460 reads sky `27 27 30 31 30 32` → ink
`28 24 25` → body `147 160`. The ink is four luminance units darker than the sky.
The edge is carried entirely by the skin-to-sky value jump — a render artifact,
not a drawn contour.

Both agents passed their own metrics. This produced `docs/FRAME_BUDGET.md`.

## What did land

- **Dropout genuinely fixed**: Vera inner shin 29.5% → **1.0%**.
- **Line width scale-stable**: 3px at 490px figure height and at 917px.
- **Speculars gone.** No isolated bright mode above the lit plateau on anyone.
- **Terminator hard**: a 3px ramp where it was a 40-unit gradient.
- **Shadow temperature reversed and now correct**: Mali lit H28.9/S72.4 → shadow
  H333.8/S43.1, i.e. **dH −55.1**. Review 001's finding is fixed.
- **Channel clipping 2.41% → 0.00%.**

## What broke doing it

- **The midtone was deleted.** 48.5% of Mali and 56.0% of Davi sit in a *single*
  8-L bin, with a 70-unit void below. Davi is 88% one flat colour. The old frame
  had 12–13 bins above 3% per fighter.
- **Shadow value ratio collapsed to 0.14–0.27** (was 0.58–0.73; KOF XIII sits
  ~0.65–0.8). These are not shadows, they are holes.
- **Shadow colours converged**: Davi vs Vera lit distance 94.5, shadow distance
  **7.7**. 83% of the colour separation between characters dies the moment they
  turn away from the key.
- **The frame is too dark**: median L 27 → **21**, pixels below L=16 3.9% →
  **35.3%**, only 2.5% above L=128.
- **The dark halo became a warm bloom halo**: +60% background luminance over the
  last 30px approaching a figure. Absent on Davi, which proves it scales with
  figure brightness. Now the loudest 3D tell in the frame.
- **The floor pool bug was relocated, not removed.** Floor luminance at foot
  height runs 34 → 88 → 42 across x — a 2.6× swing with no compositional logic.
  It used to change how the *fighter* looked by position; now it changes what is
  *behind* them.
- **Contact occlusion inverted**: ground is 26–29% *brighter* under the sole than
  beside it on three of four fighters.

## Not fixed, third review running

- **Body-type divergence has still not been started.** Silhouette IoU 0.843
  (Mali/Davi 0.894), aspect spread 7.9%, body heights within 5px of review 001 —
  the entire height gain is Kai's hair bun. Vera is built as the **narrowest**
  figure when her design is the widest and heaviest.
- **Hands and feet remain unbuilt.** Feet are toeless wedges; Kai's hands are
  solid white mittens and are the brightest, largest bright shape on him, which
  inverts his value hierarchy.
- **Hair does not reproduce any reference silhouette.** Vera has no mohawk ridge,
  Davi has no separated locs, Kai's angular spike fan is a mushroom cap. Three of
  four are rounded blobs that break the outline nowhere — which is why IoU did not
  move.
- **Kai, the only finished character, is the least legible**: 43.2% of his
  silhouette sits within 12 L of its background, mean silhouette luminance 56 vs
  Mali/Vera's 106. His costume also deviates from the sheet in silhouette-costly
  ways: cap sleeves where the design is sleeveless, both pant legs fused into one
  trapezoid with no inner-leg contour, mittens where the design has fingers.

## The single highest-leverage change

**Put the bands back.** Two tones → four on skin; lift the shadow value ratio from
0.14–0.27 to ~0.65 while keeping the hue rotation just earned and the hard 3px
terminator. Concretely: base, shadow at ~0.65 of lit, deep/occlusion at ~0.40, and
a narrow bounce band at the shadow's lower edge carrying the character's accent
hue at high saturation.

It restores anatomical description (criteria 2, 5), restores per-character colour
identity in shadow (3), gives the ink a body-side value to sit against (4), and
lifts median luminance without touching the stage.

## What we were rationalising

- *"Dropout is 0.0%, the ink is fixed."* We measured whether a dark pixel exists,
  not whether a line reads. **The metric was chosen because it could be passed.**
- *"We hardened the terminator, that's the KOF XIII look."* KOF XIII is hard-edged
  **bands**, plural. Hardness without banding is flat fill with a crisp border.
- *"Shadow temperature verified."* We verified the one axis we targeted and did
  not check the two we broke — saturation and value. Same failure mode as 001: an
  agent reporting the property it optimised rather than the frame.
- *"Faces and costumes are queued, the score will jump."* Criteria 2,3,4,7,8,9,10
  are independent of that queue and total **10/35**.
