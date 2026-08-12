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
 * 2. **Split tone** — teal into the shadows, sodium warmth into the highlights.
 *    This single move is most of what separates "looks AAA" from "looks like a
 *    WebGL demo": it manufactures the illusion that two differently coloured
 *    light sources lit the scene.
 * 3. **Saturation lift**, backed off in the deep shadows so crushed areas do not
 *    turn into coloured mud.
 * 4. **Black lift** onto the shadow tint, so the frame bottoms out at a dark
 *    teal rather than at zero. Absolute black is what makes digital look cheap.
 * 5. **Highlight bleed and crosstalk** — the two subliminal ones. Neither is
 *    visible on its own; together they take the last of the plastic off.
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
 * Two power segments meeting at `pivot` with matched slope: flat at black, steep
 * through the pivot, flat into white. Monotone for any strength, so it can never
 * invert a gradient — the failure mode of naive `smoothstep` contrast, which
 * flattens exactly the midtones you were trying to steepen.
 */
function sCurve(x: number, strength: number, pivot: number, shoulder: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x < pivot) return pivot * Math.pow(x / pivot, 1 + strength);
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
  // a mid-grey wall should come out neutral, only the ends get coloured.
  const l1 = clamp01(luma(c));
  const ws = Math.pow(1 - l1, 2.2);
  const wh = Math.pow(l1, 2.0);
  for (let i = 0; i < 3; i++) {
    const s = mix(1, shadow[i], spec.shadowAmount * ws);
    const h = mix(1, highlight[i], spec.highlightAmount * wh);
    c[i] = c[i] * s * h;
  }

  // 3. Saturation, pulled back where there is no light left to carry chroma.
  const l2 = luma(c);
  const sat = spec.saturation * (1 - spec.shadowDesat * ws);
  c = [mix(l2, c[0], sat), mix(l2, c[1], sat), mix(l2, c[2], sat)];

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
