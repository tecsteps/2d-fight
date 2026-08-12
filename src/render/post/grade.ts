import * as THREE from 'three';
import type { GradeSpec } from './contract';

/**
 * The colour grade, baked into a 3D LUT on the CPU.
 *
 * No `.cube` file exists anywhere in this project — the cube is *evaluated*,
 * once, from the maths below and uploaded as a tiled 2D strip (`size*size` wide
 * by `size` tall, one slice of blue per tile). Two texture taps and a lerp in
 * the shader then replace the eight or nine operations a colourist would stack,
 * which is the only way this many moves survives a 1080p60 budget.
 *
 * ## Why the grade runs in display space
 *
 * Every operation below is applied to **sRGB-encoded** values, not scene-linear
 * ones. That is deliberate and it is how a colourist actually works: a hue push
 * of a given size in log/display space reads the same across the whole picture,
 * whereas the same push in linear light is invisible in the shadows and
 * catastrophic in the highlights. The tone curve upstream has already mapped
 * the HDR scene into 0..1; this is the creative pass on top of it.
 *
 * ## The moves, in order of how much they matter
 *
 * 1. **Filmic S** — mid contrast, pivoted low so a fighter's costume stays
 *    readable and only the true darks crush.
 * 2. **Split tone, weighted toward the neutrals** — teal into the shadows,
 *    sodium warmth into the highlights. This single move is most of what
 *    separates "looks AAA" from "looks like a WebGL demo": it manufactures the
 *    illusion that two differently coloured light sources lit the scene. The
 *    *weighting* is the fix documented below.
 * 3. **Saturation lift**, backed off in the deep shadows so crushed areas do not
 *    turn into coloured mud, and soft-clipped at the top so it cannot push a
 *    surface past the chroma a cel band can hold.
 * 4. **Black lift** onto the shadow tint, so the frame bottoms out at a dark
 *    teal rather than at zero. Absolute black is what makes digital look cheap.
 * 5. **Highlight bleed and crosstalk** — the two subliminal ones. Neither is
 *    visible on its own; together they take the last of the plastic off.
 *
 * ## Why the split tone is weighted by chroma
 *
 * A split tone applied flat is a sepia filter with extra steps, and this roster
 * is the worst case for it: four fighters whose authored skin tones differ by
 * about 5° of hue and a lot of value. Multiply all four by the same sodium
 * highlight tint and they converge — the tint contributes more hue than the
 * albedo difference does, so the frame ends up with one skin tone in four
 * brightnesses. That is exactly what the first lineup capture looked like.
 *
 * So both halves of the tone are weighted by `1 - chroma`: full strength on the
 * neutrals, which is where a colourist actually wants it (concrete, sky, smoke,
 * white wraps, and the greys that tell the eye what the light is doing), and
 * nearly nothing on surfaces that already carry their own hue. The grade still
 * reads as split-toned because most of any frame *is* fairly neutral; what it
 * stops doing is overwriting the art direction.
 *
 * The shadow half keeps far more of its reach than the highlight half. Cool
 * shadows are skylight and they genuinely land on everything, they are load
 * bearing for the painted look, and pushing a warm surface's shadow cooler
 * *increases* the distance between two similar skins instead of collapsing it.
 * The warm highlight is a print effect, it lands where the frame is already
 * warmest, and it is the half that was doing the damage.
 */

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

type RGB = [number, number, number];

function luma(c: RGB): number {
  return c[0] * LUMA_R + c[1] * LUMA_G + c[2] * LUMA_B;
}

/**
 * Unpacks a hex literal to its **encoded** components.
 *
 * Not `THREE.Color`, which decodes to linear working space on construction —
 * correct for a light, wrong for a grading tint that is authored the way it will
 * be seen. Used by anything that operates after the tone curve.
 */
export function displayRGB(hex: number): RGB {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/** Unit-luminance version of a tint, so pushing toward it does not change value. */
function normalizedTint(hex: number): RGB {
  const rgb = displayRGB(hex);
  const l = Math.max(luma(rgb), 1e-4);
  return [rgb[0] / l, rgb[1] / l, rgb[2] / l];
}

/**
 * Pivoted filmic S.
 *
 * Two segments meeting at `pivot` with matched slope: flat at black, steep
 * through the pivot, flat into white. Monotone for any strength, so it can never
 * invert a gradient — the failure mode of naive `smoothstep` contrast, which
 * flattens exactly the midtones you were trying to steepen.
 *
 * ## Why the toe is not a pure power curve
 *
 * It was, and that is a large part of how review 002's frame ended up with 35%
 * of its pixels under L=16. A pure `(x/pivot)^(1+strength)` toe has slope zero
 * at the origin, so the darker the input the harder it is compressed: at
 * `strength 0.4` an input of 13/255 came out at 5/255 and everything below it
 * arrived on top of it. That is not "deep blacks", it is the bottom decade of
 * the range collapsing into one value, and it takes the cast shadows, the ink
 * contours and the shadow side of every costume with it.
 *
 * `TOE_LINEARITY` blends a straight line back into that segment. The curve keeps
 * its shape and its contrast through the low midtones — which is where the toe
 * is actually earning its keep, and which is what an ink line needs in order to
 * sit darker than the surface it is drawn on — but it now has finite slope at
 * the origin, so two values a code apart down there stay two values apart.
 */
const TOE_LINEARITY = 0.35;

function sCurve(x: number, strength: number, pivot: number, shoulder: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x < pivot) {
    const u = x / pivot;
    return pivot * ((1 - TOE_LINEARITY) * Math.pow(u, 1 + strength) + TOE_LINEARITY * u);
  }
  // The shoulder is deliberately gentler than the toe. A symmetric S buys its
  // contrast by crushing both ends equally, and the top end is where a fighter's
  // lit side, the rim light and every specular live — losing separation there
  // is what makes a graded frame look like a compressed JPEG of a good frame.
  return pivot + (1 - pivot) * (1 - Math.pow(1 - (x - pivot) / (1 - pivot), 1 + strength * shoulder));
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/**
 * Shape constants — not creative dials.
 *
 * These are the *form* of the grade rather than its strength: how far into the
 * midtones each half of the split tone reaches, how much of it survives on an
 * already-coloured surface, and where chroma starts being compressed. The
 * strengths live in `GradeSpec` so a stage can push them; these hold the
 * behaviour that has to be true of every stage, so they are fixed here and
 * covered by `tools/lighting/check-grade.mjs`.
 */
const SHAPE = {
  /**
   * Falloff exponents on the two tone weights. Both are steeper than the naive
   * choice so that a mid-grey wall comes out neutral: the two halves used to
   * overlap through the whole midtone range, and a split tone that overlaps in
   * the middle is a colour cast.
   */
  shadowFalloff: 2.5,
  highlightFalloff: 3.1,
  /**
   * How much of each tone is withheld from a fully saturated surface. The
   * highlight half is held back hard because it is the half that flattens hue
   * separation; the shadow half keeps most of its reach because cool shadow is
   * what the painted look is made of.
   */
  shadowNeutralGuard: 0.4,
  highlightNeutralGuard: 0.82,
  /** Chroma range over which the guards ramp in. Below `lo` a pixel counts as neutral. */
  chromaLo: 0.1,
  chromaHi: 0.52,
  /**
   * HSV saturation above which chroma is compressed, and how hard. A cel band is
   * a flat colour: once it is this saturated, more chroma stops reading as a
   * richer surface and starts reading as a clipped channel — which is where hue
   * separation goes to die, because every over-saturated warm tone lands on the
   * same primary.
   */
  chromaKnee: 0.72,
  chromaCompression: 0.9,
} as const;

/** HSV saturation, i.e. chroma normalised by value. 0 on any grey. */
function hsvSaturation(c: RGB): number {
  const mx = Math.max(c[0], c[1], c[2]);
  if (mx <= 1e-5) return 0;
  return (mx - Math.min(c[0], c[1], c[2])) / mx;
}

/**
 * Soft-clips HSV saturation, holding hue and value exactly.
 *
 * Value is held by keeping the max channel and lifting the other two toward it,
 * rather than by mixing toward luminance — mixing toward luma would darken a
 * saturated red as it desaturates, which is visible as a dent in a fighter's
 * costume every time the grade bites.
 */
function compressChroma(c: RGB): RGB {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  if (mx <= 1e-5) return c;
  const sat = (mx - mn) / mx;
  if (sat <= SHAPE.chromaKnee) return c;

  const room = 1 - SHAPE.chromaKnee;
  const excess = (sat - SHAPE.chromaKnee) / room;
  const compressed = excess / (1 + excess * SHAPE.chromaCompression);
  const target = SHAPE.chromaKnee + room * compressed;

  // Rescale the distance of every channel from the max, so the mid channel keeps
  // its position between min and max and the hue does not rotate.
  const span = mx - mn;
  const newSpan = mx * target;
  const k = newSpan / Math.max(span, 1e-5);
  return [mx - (mx - c[0]) * k, mx - (mx - c[1]) * k, mx - (mx - c[2]) * k];
}

/** Evaluates the grade for one display-space colour. Exported for unit tests. */
export function gradeColor(input: RGB, spec: GradeSpec): RGB {
  const shadow = normalizedTint(spec.shadowTint);
  const highlight = normalizedTint(spec.highlightTint);

  let c: RGB = [clamp01(input[0]), clamp01(input[1]), clamp01(input[2])];

  // 1. Filmic S. The luminance-driven form holds hue exactly; the per-channel
  // form is where film's chroma gain comes from. Neither alone is right.
  const l0 = luma(c);
  const lc = sCurve(l0, spec.contrast, spec.pivot, spec.shoulder);
  const scale = lc / Math.max(l0, 1e-5);
  const byLuma: RGB = [c[0] * scale, c[1] * scale, c[2] * scale];
  const perCh: RGB = [
    sCurve(c[0], spec.contrast, spec.pivot, spec.shoulder),
    sCurve(c[1], spec.contrast, spec.pivot, spec.shoulder),
    sCurve(c[2], spec.contrast, spec.pivot, spec.shoulder),
  ];
  c = [
    mix(byLuma[0], perCh[0], spec.perChannel),
    mix(byLuma[1], perCh[1], spec.perChannel),
    mix(byLuma[2], perCh[2], spec.perChannel),
  ];

  // 2. Split tone. Weights are shaped so the two never fight over the midtones —
  // a mid-grey wall should come out neutral, only the ends get coloured — and
  // both are withheld from surfaces that already carry hue, so the grade tints
  // the light in the scene rather than repainting the art. See the header.
  const l1 = clamp01(luma(c));
  const ws = Math.pow(1 - l1, SHAPE.shadowFalloff);
  const wh = Math.pow(l1, SHAPE.highlightFalloff);
  const chroma = smoothstep(SHAPE.chromaLo, SHAPE.chromaHi, hsvSaturation(c));
  const gs = 1 - SHAPE.shadowNeutralGuard * chroma;
  const gh = 1 - SHAPE.highlightNeutralGuard * chroma;
  for (let i = 0; i < 3; i++) {
    const s = mix(1, shadow[i], spec.shadowAmount * ws * gs);
    const h = mix(1, highlight[i], spec.highlightAmount * wh * gh);
    c[i] = c[i] * s * h;
  }

  // 3. Saturation, pulled back where there is no light left to carry chroma,
  // then soft-clipped so the lift cannot drive a warm surface into a primary.
  const l2 = luma(c);
  const sat = spec.saturation * (1 - spec.shadowDesat * ws);
  c = [mix(l2, c[0], sat), mix(l2, c[1], sat), mix(l2, c[2], sat)];
  c = compressChroma([clamp01(c[0]), clamp01(c[1]), clamp01(c[2])]);

  // 4. Black lift onto the shadow hue. Deliberately tiny: KOF's blacks are deep,
  // they are just not *empty*.
  for (let i = 0; i < 3; i++) {
    c[i] += shadow[i] * spec.lift * ws;
  }

  // 5a. Highlight bleed — as a channel approaches clip, the other two are dragged
  // up with it. This is the film shoulder, and it is why a bright rim on skin
  // goes cream instead of going pure red.
  const peak = Math.max(c[0], c[1], c[2]);
  const bleed = spec.highlightBleed * Math.pow(clamp01(peak), 4);
  for (let i = 0; i < 3; i++) {
    c[i] = mix(c[i], peak, bleed);
  }

  // 5b. Crosstalk. Emulsion layers are not perfectly separated; a trace of each
  // channel lands in the others. Under 3% or it just reads as a desaturate.
  const mean = (c[0] + c[1] + c[2]) / 3;
  for (let i = 0; i < 3; i++) {
    c[i] = mix(c[i], mean, spec.crosstalk);
  }

  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}

/**
 * Bakes `spec` into a tiled LUT texture.
 *
 * Layout is the standard horizontal strip: blue slice `b` occupies texels
 * `[b*size, b*size + size)` on x, red runs along x within the slice, green along
 * y. Bilinear filtering then interpolates red and green for free and the shader
 * only has to lerp between two slices by hand. Clamped and unmipped — a mip
 * would smear slices into each other and turn a shadow into a highlight.
 *
 * 8-bit is enough: the output framebuffer is 8-bit anyway, the entries are
 * interpolated, and the composite's final dither erases what quantisation is
 * left.
 */
export function buildGradeLUT(spec: GradeSpec): THREE.DataTexture {
  const size = Math.max(8, Math.min(64, Math.round(spec.size)));
  const width = size * size;
  const data = new Uint8Array(width * size * 4);
  const inv = 1 / (size - 1);

  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = gradeColor([r * inv, g * inv, b * inv], spec);
        const x = b * size + r;
        const o = (g * width + x) * 4;
        data[o] = Math.round(out[0] * 255);
        data[o + 1] = Math.round(out[1] * 255);
        data[o + 2] = Math.round(out[2] * 255);
        data[o + 3] = 255;
      }
    }
  }

  const tex = new THREE.DataTexture(data, width, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  // The strip stores already-encoded display values. An sRGB decode on sampling
  // would apply the transfer function a second time and wash the grade out.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
