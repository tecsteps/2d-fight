# The frame value budget

**Every agent that touches shading, lighting, post or stage must hit these
numbers.** They exist because of a specific failure in wave B2.

## The failure this prevents

Two agents optimised independently and cancelled each other out.

- The **ink agent** was told (correctly) to colour the contour as a *dark tint of
  the local surface colour* rather than black. That is right for a mid-value
  stage.
- The **lighting agent**, at the same time, took the stage to near-black — 35.3%
  of the frame below L=16.

A dark tint of anything, on a black ground, is invisible. The ink pass measured
0.0% dropout and was, in the critic's words, "a correct ink pass shipped onto a
stage that cannot show it." Median ink-to-background contrast on Vera was **6.6
luminance units**. Both agents hit their own targets. The frame got worse.

The lesson is not "coordinate better". It is that **per-system targets must be
expressed as shared frame-level invariants**, so an agent cannot pass its own
metric by pushing the cost onto someone else's.

## Invariants

Measure on the `lineup` scene at 1920×1080 with post on, using the helper in
`tools/critic/measure.py`.

### Global value structure

| Quantity | Target | Why |
| --- | --- | --- |
| Median frame luminance | **48–72** | 21 currently. KOF XIII stages sit mid-range so fighters can own both ends. |
| Pixels below L=16 | **< 8%** | 35.3% currently. A third of the frame crushed to black is not mood, it is an absent value structure. |
| Pixels above L=128, **within the matte** | **> 8% of character pixels** | Measured on characters only since review 003 — the frame-wide version was passed by brightening empty floor. |
| Channel clipping | **0.00%** | Already met — keep it. |

### Characters

| Quantity | Target | Why |
| --- | --- | --- |
| Skin shadow / lit value ratio | **0.60–0.75** | 0.14–0.27 currently. Below ~0.5 a shadow stops being shadow and becomes a hole. |
| Distinct value bands on skin | **≥ 4** | 2 currently. Hard-edged is not the KOF XIII property — *banded* is. |
| Largest single 8-L histogram bin, per fighter | **< 30%** | Mali 48.5%, Davi 56% currently — flat fill. |
| Shadow hue rotation vs lit | **−25° to −65°** | Already met at −33° to −61°. Keep it. |
| Shadow saturation drop | **< 15 points** | 18–36 currently, which erases character colour in shadow. |
| Pairwise shadow-colour distance between fighters | **> 40 RGB** | 7.7–16.4 currently. 83% of character colour separation dies the moment they turn from the key. |

### Figure–ground

| Quantity | Target | Why |
| --- | --- | --- |
| Median ink-to-background contrast | **> 40 L** | 6.6–15.4 currently. This is the metric that replaces "dropout %", which could be passed by a dark pixel that reads as nothing. |
| Silhouette pixels within 12 L of their background | **< 10%** per fighter | Kai 43.2% currently — the only finished character is the least legible. |
| Weber figure–ground contrast, per fighter | **> 0.45**, spread across roster **< 2×** | Davi 0.12 vs Mali 0.94 currently — an 8× spread. Davi's lit shin is darker than the floor behind it. |
| Background luminance lift within 60px of a figure | **< 10%** | +60% currently. A hand-drawn sprite has zero bleed into the background; this is bloom and it is the loudest 3D tell in the frame. |
| Floor luminance variation at foot height, across x | **< 1.4×** | 2.6× currently. The point-light pool was replaced by additive geometry that varies the *ground* instead of the fighter — the same bug relocated. |
| Ground luminance under a sole vs beside it | **darker by 15–40%** | Currently 26–29% **brighter** on three of four fighters, so they read as hovering over a glowing floor. |

## Anti-gaming amendments (after review 003)

Review 003 found two budget rows passed by moving the defect somewhere the metric
could not see it. Both are now closed.

### Measure characters on characters

`pct_above_128` was passed by brightening an **empty floor plane**: 79.5% of those
bright pixels were floor, and only 2.2% of the frame was bright character. That is
rule 1 violated by the very row meant to enforce it.

> **`pct_above_128` is now measured inside the matte only**, and the target is
> that **>8% of *character* pixels** exceed L=128. A bright stage cannot pay for
> a dim cast.

### Measure skin on skin, cloth on cloth

`topbin` and `bands` were passed at whole-character granularity, which averages a
navy gi with bare skin with a sash. Broken out, the defect reappears: Kai's gi is
**61% in one 8-L bin**, Mali's shorts 67%, Davi's vest 67%, and every fighter's
skin is still two clusters with a 48–96 L void between them.

> **Band statistics are now reported per material class** — skin, cloth, wraps —
> never pooled. Each class carries the same target independently.

Likewise the per-figure `dHue`, `sh/lit` and shadow-pair-distance rows are
**cloth-confounded and must not be quoted**: Kai's navy gi (hue ~215°) dominates
his measured shadow hue. Corrected skin-only figures live in review 003.

### One more standing rule

> **A target authored alongside the work it grades is not a target.**
> `silhouette.py` shipped with `mean IoU < 0.72` and `aspect spread > 18%`,
> neither of which appears here, and cleared its own IoU bar by 0.004. Any
> threshold that decides whether work is done belongs in this file, written down
> before the work starts.

## Rules

1. **Do not pass your metric by pushing cost onto another system.** If hitting
   your target requires the stage to go darker or the bloom to go wider, that is
   not a win — check the table above and say so in your report.
2. **Report the whole table, not just your rows.** An agent that reports only the
   property it optimised is how both previous regressions shipped.
3. **A metric you can pass with a technically-present-but-invisible result is the
   wrong metric.** Prefer contrast-against-context over presence-of-pixel.
