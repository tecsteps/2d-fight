# Review 001 — baseline lineup

**Frame:** `shots/critic/lineup2-0000-rubric.jpg` (four fighters, nude/bald/faceless,
pre-wave-B1)
**Mode:** rubric (no KOF XIII reference frames available — egress blocked)
**Score: 13 / 50. Verdict: would not win a blind side-by-side. ~15% of the way there.**

The critic measured rather than eyeballed. Numbers below are its pixel samples and
are the reason this review is worth keeping.

## Scores

| # | Criterion | Score |
| --- | --- | --- |
| 1 | Silhouette legibility | 2 |
| 2 | Deliberate shadow shapes | 1 |
| 3 | Colour separation, unified palette | 2 |
| 4 | Confident linework | 1 |
| 5 | Anatomical authority | 2 |
| 6 | Faces that act | 1 |
| 7 | Stage depth and life | 1 |
| 8 | Impact | 1 |
| 9 | Animation reads as drawn | 1 |
| 10 | Finish | 1 |

## Findings that contradict wave A's self-reports

**This is the important part.** Two agents reported behaviour the pixels do not show.
Agent self-reports are not verification; measured frames are.

1. **Shadows are warmer than lit skin, not cooler.** The NPR agent reported hue-rotating
   shadow toward skylight "never through green". Measured: Mali lit H31/S78/V100 →
   shadow **H24**/S98/V45. Kai H29/S74 → **H24**/S88. Every fighter's shadow is the same
   hue as their lit side, only darker and more saturated. There is zero temperature
   separation anywhere in the frame — and that shift is most of why KOF XIII reads as
   painted.
2. **There is no ink line.** `outline.ts` implements inverted-hull, but what reaches the
   frame is a fresnel rim plus a blurred dark halo plus a dashed interior edge with ~50%
   dropout. Because it is lighting-driven it varies with background and light direction:
   Vera's right arm has **no contour separating it from her torso at all**, so at gameplay
   size the arm dissolves into the ribcage.

## Ranked defects

1. **No real ink contour** — the outline is a lighting term, so it appears and disappears.
   Fix: constant screen-space width, coloured as a dark tint of the local colour rather
   than black, weight modulated by depth discontinuity so it goes heavy where forms
   occlude. Kill the outer dark halo.
2. **Shadow is plain Lambert falloff** with perfectly round gaussian speculars. Mali reads
   as a wax figure, Davi as a chocolate figurine.
3. **One body, four albedos.** Total roster height spread is **6%** (375–397px). Shoulder
   slope, limb length, mass distribution and hand/foot shape are identical across all
   four. Arms hang inside the hip line on all four, merging hands into thighs.
4. **Value range uncontrolled across skin tones.** Davi's *lit* chest is V44 while Vera's
   and Kai's *shadows* are V60/V61 — the darkest character's light side is darker than two
   others' dark sides, and Mali's red channel is clipped (255,160,57). Davi will vanish on
   any stage darker than a blank plane.
5. **Hands and feet are unbuilt** — undivided paddles with no thumb break or knuckle mass;
   ski-wedge feet with no ankle, arch or toe break. Every foot floats: a visible gap
   between foot and the leading edge of its own cast shadow, no contact occlusion.

## Will bite us under motion

- The dashed inner-shin line is a depth-threshold edge pass failing on near-tangent
  surfaces. It will **crawl and shimmer** in motion — far more visible than the static
  artifact.
- The amoeba shadows will **slide across the body** as the mesh rotates. Sliding shadow is
  dramatically more visible than static wobble.
- Lighting is self-contradictory: cast shadows run long and hard right implying a low left
  key, while bodies are keyed frontally with a rim from behind.

## What we were rationalising

- *"It's a shading problem, the meshes are fine."* No — paddle hands and ankle-less feet
  are **topology**. No shader grows a thumb.
- *"Hair and costume will fix the silhouette."* They fix the outer outline only. Four
  identical mass distributions stay identical; Vera's vest on that body reads as a costume
  swap, not a different fighter. **Body-type divergence is a modelling task.**
- *"Nobody will see it at gameplay scale."* Backwards — it gets worse in motion.
- **The pose is not art-directed at all.** Four dead A-poses staring at their own feet,
  camera above eyeline. One deliberate weight shift and line of action costs no tech.
- **Camera FOV is too wide** — the outer figures are visibly keystoned toward centre, so a
  fighter changes apparent shape as they walk across the screen. KOF XIII has effectively
  no perspective divergence on fighters. Go long-lens or near-ortho.
- **The stage is not "not started", it is actively hurting**: inverted aerial perspective
  (floor gets *lighter* as it recedes), a hard 1px horizon seam, no contact shadows.
- **Colour identity is the cheapest win being deferred.** Push each fighter's accent into
  their shadow tint now, before costumes exist, and criterion 3 moves 2 → 3+ on its own.

## Actions

Covered by wave B1 (in flight): shadow temperature and value-band control (lighting
agent), silhouette outer break (hair), faces.

**Not yet covered — queue for B2/C:**

| Action | Target |
| --- | --- |
| Real ink contour, constant screen width, depth-weighted | `render/npr/outline.ts` |
| Delete gaussian speculars; hard two-tone terminator | `render/npr/ToonMaterial.ts` |
| Hands: thumb break, knuckle mass, finger separation | `art/characters/body.ts` |
| Feet: ankle, arch, toe break | `art/characters/body.ts` |
| Body-type divergence — widen height/mass spread well past 6% | `data/roster`, `body.ts` |
| Contact shadow / occlusion per foot | `render/vfx` or stage |
| Fix inverted floor aerial perspective + horizon seam | `art/stages` |
| Narrow camera FOV toward long-lens | `render/Camera.ts` |
| Art-directed standing pose with weight shift | `anim` |
