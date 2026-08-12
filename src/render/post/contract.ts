import * as THREE from 'three';

/**
 * Public surface of the post stack: the pass list, every tuning knob, and the
 * defaults that were dialled in against KOF XIII reference frames.
 *
 * Tuning lives here rather than inside the passes so the whole look can be
 * swapped per stage (a neon rooftop and a dusk temple want different grades)
 * and so the A/B harness can bisect a regression by diffing two plain objects.
 *
 * Anything measured in pixels is quoted **at 1080p** and scaled by the real
 * frame height at runtime — a 4K frame must look identical, not four times
 * grainier.
 */

/**
 * Chain order. `postDebugToggles()` returns exactly this array, so the debug UI
 * lists passes in the order light actually travels through them.
 */
export const PASS_NAMES = [
  'bloom',
  'streak',
  'tonemap',
  'grade',
  'aberration',
  'distortion',
  'speedlines',
  'vignette',
  'grain',
] as const;

export type PassName = (typeof PASS_NAMES)[number];

/** Creative grade baked into the 3D LUT. See `grade.ts` for the maths. */
export interface GradeSpec {
  /**
   * Steepness of the filmic S. 0 is a straight line; 0.34 is about one stop of
   * added mid contrast, which is where a game frame starts reading as "shot"
   * rather than "rendered".
   */
  contrast: number;
  /**
   * Display value the S-curve rotates about. Below 0.5 on purpose: a fighter
   * must stay legible against the stage, and a 0.5 pivot buries the lower half
   * of the costume.
   */
  pivot: number;
  /**
   * Fraction of the contrast that applies above the pivot. Below 1 so the toe
   * bites harder than the shoulder — blacks want crushing, highlights want
   * separation.
   */
  shoulder: number;
  /**
   * How much of the contrast is applied per channel rather than to luminance.
   * Per-channel is what makes film gain chroma as it contrasts; all of it turns
   * a saturated gi into a clipped primary.
   */
  perChannel: number;

  /** Colour the shadows are pulled toward — the teal half of the split tone. */
  shadowTint: number;
  shadowAmount: number;
  /** Colour the highlights are pulled toward — sodium/tungsten warmth. */
  highlightTint: number;
  highlightAmount: number;

  /** Global chroma multiplier. Above 1 because cel shading survives it. */
  saturation: number;
  /** How much chroma is pulled back out of the deepest shadows. */
  shadowDesat: number;

  /** Black level, tinted by `shadowTint`. Keeps crushed areas from going dead. */
  lift: number;
  /** Near-clip colours bleed toward white, mimicking a film shoulder. */
  highlightBleed: number;
  /** Channel cross-contamination. Tiny — it is felt, never seen. */
  crosstalk: number;

  /** Cube resolution per axis. 32 is the industry default and fits in 1024x32. */
  size: number;
}

export interface BloomSpec {
  /** Luminance where the glow starts, in tonemapped-linear terms. */
  threshold: number;
  /** Soft-knee width around the threshold. Hard knees make bloom pop on/off. */
  knee: number;
  /** Final additive strength. */
  intensity: number;
  /** Tent-filter spread on the way back up the mip chain, 0..1. */
  radius: number;
  /** Warm tint applied to the whole glow. */
  tint: number;
  /**
   * Chroma boost inside the glow. A blue super should bloom blue; the naive
   * chain bleaches every highlight to the same white haze.
   */
  saturation: number;
  /** Mip levels. Capped by resolution at runtime. */
  levels: number;
}

export interface StreakSpec {
  /** Additive strength. Barely-there by design — this is a lens tell, not an FX. */
  intensity: number;
  tint: number;
  /** Blur iterations; each one quadruples the reach. */
  iterations: number;
  /** Tap spacing of the first iteration, in 1/8-res pixels. */
  stride: number;
  /** Per-iteration energy falloff, so the streak tapers instead of smearing flat. */
  attenuation: number;
}

export interface PostTuning {
  /** Scene exposure applied before the tone curve. */
  exposure: number;
  /**
   * Blend between luminance-only and per-channel tone mapping. Per-channel
   * desaturates highlights (photographic); luminance-only holds chroma into the
   * clip (illustrative). KOF sits nearer the illustrative end.
   */
  tonemapHueShift: number;
  /** Uchimura GT curve: contrast, linear-section start, linear length, toe. */
  tonemapContrast: number;
  tonemapLinearStart: number;
  tonemapLinearLength: number;
  tonemapToe: number;

  bloom: BloomSpec;
  streak: StreakSpec;
  grade: GradeSpec;
  /** 0 bypasses the LUT, 1 is the full grade. Useful for A/B without a rebuild. */
  gradeStrength: number;

  /** Radial chromatic aberration at the frame edge, in 1080p pixels. */
  aberration: number;
  /** Extra aberration at `impact` = 1. */
  aberrationImpact: number;
  /** Radial smear length at `impact` = 1, in 1080p pixels. */
  impactDrag: number;
  /**
   * Flash strength at `impact` = 1, applied as impact squared. Mostly an
   * exposure kick — see the composite — so 1.0 is a blown frame, not a limit.
   */
  impactFlash: number;
  /** Default flash colour; overridden per hit with the attacker's energy hue. */
  impactColor: number;

  /** Lens distortion k1. Negative barrels the frame; keep it under the threshold
   * of conscious notice — it should only soften the "flat pane of glass" read. */
  distortion: number;

  /** Angular line density of the two speed-line layers. */
  speedLineCount: number;
  speedLineCountFine: number;
  /** HDR gain on the lines, so they clip to paper-white through the tone curve. */
  speedLineGain: number;
  speedLineColor: number;

  /** How dark and how drained the world goes at `dim` = 1. */
  dimFloor: number;
  dimColor: number;
  /** Cool cast the frame takes during hitstop. */
  timeStopColor: number;

  vignette: number;
  /** Radius where the vignette starts / is fully closed, in half-diagonals. */
  vignetteInner: number;
  vignetteOuter: number;
  /** 0 = elliptical (follows the 16:9 frame), 1 = circular. */
  vignetteRoundness: number;

  /** Grain amplitude in display units. */
  grain: number;
  /** Grain cell size in 1080p pixels. */
  grainSize: number;
}

export const DEFAULT_TUNING: PostTuning = {
  exposure: 1.06,
  tonemapHueShift: 0.45,
  tonemapContrast: 1.06,
  tonemapLinearStart: 0.2,
  tonemapLinearLength: 0.36,
  tonemapToe: 1.3,

  bloom: {
    threshold: 0.78,
    knee: 0.42,
    intensity: 0.62,
    radius: 0.85,
    tint: 0xfff0d6,
    saturation: 1.25,
    levels: 6,
  },
  streak: {
    intensity: 0.055,
    tint: 0x8cb8ff,
    iterations: 3,
    stride: 1,
    attenuation: 0.86,
  },
  grade: {
    contrast: 0.4,
    pivot: 0.42,
    shoulder: 0.6,
    perChannel: 0.35,
    shadowTint: 0x2f6f7a,
    shadowAmount: 0.2,
    highlightTint: 0xffd9a8,
    highlightAmount: 0.16,
    saturation: 1.15,
    shadowDesat: 0.22,
    lift: 0.012,
    highlightBleed: 0.1,
    crosstalk: 0.02,
    size: 32,
  },
  gradeStrength: 1,

  aberration: 0.55,
  aberrationImpact: 7.5,
  impactDrag: 6,
  impactFlash: 0.55,
  impactColor: 0xffe6c8,

  distortion: -0.014,

  speedLineCount: 84,
  speedLineCountFine: 41,
  speedLineGain: 1.8,
  speedLineColor: 0xfff7ec,

  dimFloor: 0.16,
  dimColor: 0x6b7ad9,
  timeStopColor: 0xb8d2ff,

  vignette: 0.34,
  vignetteInner: 0.34,
  vignetteOuter: 0.86,
  vignetteRoundness: 0.75,

  grain: 0.03,
  grainSize: 1.35,
};

export interface PostStackOptions {
  /** Overrides merged over `DEFAULT_TUNING`. Nested specs merge one level deep. */
  tuning?: DeepPartial<PostTuning>;
  /** MSAA samples on the scene target. The canvas' own AA never runs — post bypasses it. */
  samples?: number;
  /** Internal resolution multiplier. The perf dial of last resort. */
  renderScale?: number;
  /** Passes to start disabled, for A/B captures. */
  disabled?: PassName[];
  /**
   * Override how the world is drawn into the scene target. Defaults to a plain
   * `renderer.render(scene, camera)`; a multi-layer stage that needs its own
   * clear order passes its own function.
   */
  renderScene?: (renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget) => void;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K];
};

/** Merges an options override over the defaults without mutating either. */
export function resolveTuning(over?: DeepPartial<PostTuning>): PostTuning {
  const t: PostTuning = {
    ...DEFAULT_TUNING,
    bloom: { ...DEFAULT_TUNING.bloom },
    streak: { ...DEFAULT_TUNING.streak },
    grade: { ...DEFAULT_TUNING.grade },
  };
  if (!over) return t;
  for (const key of Object.keys(over) as (keyof PostTuning)[]) {
    const v = over[key];
    if (v === undefined) continue;
    if (key === 'bloom' || key === 'streak' || key === 'grade') {
      Object.assign(t[key], v);
    } else {
      (t as unknown as Record<string, unknown>)[key] = v;
    }
  }
  return t;
}
