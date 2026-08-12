import * as THREE from 'three';

/**
 * Generated lighting ramps and the palette maths that feeds them.
 *
 * Everything a hand-painted fighter needs to separate "lit" from "shadow" is
 * decided here, on the CPU, once — the shader is then a single texture tap. Two
 * things matter more than anything else for making a 3D character read as a 2D
 * painting:
 *
 * 1. The transition between bands is a *decision*, not a gradient. A painter
 *    commits to an edge; a lighting equation smears one. `sharpness` controls
 *    how committed we are.
 * 2. The shadow is a different **hue**, not a darker copy of the base. Skin in
 *    shadow goes plum, orange cloth goes toward rust-violet, teal goes toward
 *    indigo. Darkening alone is what makes 3D toon shading look like plastic.
 *
 * No image files: the ramp is a `DataTexture` filled by the code below.
 */

/** How the bands are laid out along the 0..1 lighting coordinate. */
export interface RampSpec {
  /** Number of quantised steps. 2 = hard cel, 4 = soft painted. */
  bands: number;
  /** 0 = the bands blend into a gradient, 1 = razor-edged steps. */
  sharpness: number;
  /**
   * Where the light/shadow terminator sits. Below 0.5 because a fighter should
   * read as mostly lit with a decisive shadow *shape*; a 50/50 split makes the
   * form look like a sphere study rather than a character.
   */
  toe?: number;
  /** Where the last (fully lit) band begins. */
  shoulder?: number;
  /** Half-width of the terminator response that drives subsurface bleed. */
  terminatorWidth?: number;
  /**
   * Curve applied to the band *values*. Below 1 lifts the mid bands toward the
   * light, which is what keeps painted midtones from turning muddy.
   */
  gamma?: number;
}

interface ResolvedRamp extends Required<RampSpec> {}

/**
 * 512 texels. Wide enough that a razor edge baked at ~1.2 texels stays a razor
 * edge under linear filtering, narrow enough to be free.
 */
const RAMP_WIDTH = 512;

const DEFAULTS: Omit<ResolvedRamp, 'bands' | 'sharpness'> = {
  toe: 0.34,
  shoulder: 0.78,
  terminatorWidth: 0.09,
  gamma: 0.78,
};

const cache = new Map<string, THREE.DataTexture>();

function resolve(spec: RampSpec): ResolvedRamp {
  return {
    bands: Math.max(2, Math.min(8, Math.round(spec.bands))),
    sharpness: THREE.MathUtils.clamp(spec.sharpness, 0, 1),
    toe: spec.toe ?? DEFAULTS.toe,
    shoulder: spec.shoulder ?? DEFAULTS.shoulder,
    terminatorWidth: spec.terminatorWidth ?? DEFAULTS.terminatorWidth,
    gamma: spec.gamma ?? DEFAULTS.gamma,
  };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Positions of the band boundaries along the lighting coordinate.
 *
 * The first boundary is the terminator and is the only one an audience actually
 * reads; the rest exist to give the lit side some internal modelling, so they
 * are packed between `toe` and `shoulder` rather than spread evenly over 0..1.
 */
function bandEdges(r: ResolvedRamp): number[] {
  const edges: number[] = [];
  for (let k = 1; k < r.bands; k++) {
    const t = r.bands > 2 ? (k - 1) / (r.bands - 2) : 0;
    edges.push(r.toe + (r.shoulder - r.toe) * t);
  }
  return edges;
}

function bandValues(r: ResolvedRamp): number[] {
  const values: number[] = [];
  for (let k = 0; k < r.bands; k++) {
    values.push(Math.pow(k / (r.bands - 1), r.gamma));
  }
  return values;
}

/**
 * Builds the ramp texture for a band layout.
 *
 * Channels, all consumed by `ToonMaterial`'s fragment shader:
 * - **R** quantised shade, 0 = deepest shadow, 1 = full light.
 * - **G** terminator proximity — peaks on the band edges. Drives subsurface
 *   warmth on skin and the chroma push a painter puts on a shadow edge.
 * - **B** core-shadow mask — only the darkest band. Drives the extra cool tint
 *   and occlusion darkening that keeps deep shadow from going flat.
 * - **A** the same curve *unbanded*, for terms that must not step (rim
 *   modulation, specular gating) or they turn into visible staircases.
 *
 * Ramps are shared between every material with the same layout, so a whole
 * roster typically costs three or four textures.
 */
export function bandRamp(spec: RampSpec): THREE.DataTexture {
  const r = resolve(spec);
  const key = `${r.bands}|${r.sharpness.toFixed(3)}|${r.toe.toFixed(3)}|${r.shoulder.toFixed(3)}|${r.terminatorWidth.toFixed(3)}|${r.gamma.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const edges = bandEdges(r);
  const values = bandValues(r);
  const data = new Uint8Array(RAMP_WIDTH * 4);

  // Widest an edge may be: just under half the distance to its neighbour, so a
  // fully soft ramp still never bleeds two transitions into each other.
  const edgeWidth = edges.map((e, k) => {
    const prev = k === 0 ? 0 : edges[k - 1];
    const next = k === edges.length - 1 ? 1 : edges[k + 1];
    const span = Math.min(e - prev, next - e);
    return THREE.MathUtils.lerp(span * 0.45, 1.2 / RAMP_WIDTH, r.sharpness);
  });

  for (let i = 0; i < RAMP_WIDTH; i++) {
    const x = (i + 0.5) / RAMP_WIDTH;

    let shade = values[0];
    let terminator = 0;
    for (let k = 0; k < edges.length; k++) {
      const e = edges[k];
      const w = edgeWidth[k];
      shade += (values[k + 1] - values[k]) * smoothstep(e - w, e + w, x);

      // The main terminator carries the painted warmth; the interior edges get
      // a fraction of it so the lit side gets some life without competing.
      const weight = k === 0 ? 1 : 0.38;
      const d = (x - e) / r.terminatorWidth;
      terminator = Math.max(terminator, weight * Math.exp(-d * d * 2.77));
    }

    // Core shadow: tightest at zero light, gone by the terminator. Squared so
    // the tint stays out of the mid shadow and only bites in the darkest area.
    const core = Math.pow(1 - smoothstep(0, edges[0] * 0.95, x), 2);

    const smooth = Math.pow(smoothstep(0, 1, x), r.gamma);

    const o = i * 4;
    data[o] = Math.round(THREE.MathUtils.clamp(shade, 0, 1) * 255);
    data[o + 1] = Math.round(THREE.MathUtils.clamp(terminator, 0, 1) * 255);
    data[o + 2] = Math.round(THREE.MathUtils.clamp(core, 0, 1) * 255);
    data[o + 3] = Math.round(THREE.MathUtils.clamp(smooth, 0, 1) * 255);
  }

  const tex = new THREE.DataTexture(data, RAMP_WIDTH, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  // Control data, not colour — an sRGB decode here would warp the band values.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

/** Frees every cached ramp. Only needed when tearing the renderer down. */
export function disposeRamps(): void {
  for (const tex of cache.values()) tex.dispose();
  cache.clear();
}

const _hsl = { h: 0, s: 0, l: 0 };

/** Hue of the ambient the shadows sit in. 0.60 turn ≈ the blue of skylight. */
const COOL_ANCHOR = 0.6;

/**
 * Rotates a hue toward the cool anchor the way a painter does — **never through
 * green**.
 *
 * Taking the geometrically shortest path on the wheel sends orange and cream
 * shadows through yellow-green, which is the single most reliable way to make
 * skin look ill and white cloth look mouldy. Warm hues therefore travel the
 * long way round, through red and violet; only hues already past green take the
 * short route.
 */
function towardCool(h: number, shift: number): number {
  const viaViolet = h <= 0.25 || h >= COOL_ANCHOR;
  let d: number;
  if (viaViolet) {
    // Descending: yellow → orange → red → magenta → violet → blue.
    d = -((h - COOL_ANCHOR + 1) % 1);
  } else {
    d = COOL_ANCHOR - h;
  }
  return (h + d * shift + 1) % 1;
}

export interface ShadowTintOptions {
  /** How far to drag the hue toward blue, 0..1. */
  shift?: number;
  /** Multiplier on saturation. Painted shadows gain chroma, they do not grey out. */
  satGain?: number;
  /** Chroma added to near-neutral colours so a grey shadow still reads cool. */
  satLift?: number;
  /** Multiplier on lightness for a mid-value base. */
  value?: number;
}

/**
 * Derives the colour a surface takes in shadow.
 *
 * The maths runs in **sRGB** HSL on purpose: hue rotations that look right to a
 * painter are defined in the space a painter picks colours in, not in linear
 * light where a 20° rotation reads as a completely different move.
 *
 * Three moves, in order of how much they matter: hue toward the ambient, chroma
 * *up*, value down. Reaching only for the last one is what produces the grey,
 * plastic, unmistakably-3D toon shading this pipeline exists to avoid.
 */
export function coolShadow(base: THREE.ColorRepresentation, opts: ShadowTintOptions = {}): THREE.Color {
  const shift = opts.shift ?? 0.2;
  const satGain = opts.satGain ?? 1.18;
  const satLift = opts.satLift ?? 0.06;
  const value = opts.value ?? 0.44;

  const c = new THREE.Color(base);
  c.getHSL(_hsl, THREE.SRGBColorSpace);

  const h = towardCool(_hsl.h, shift);
  // Scaled by the original chroma: a full lift on a near-white wrap turns it
  // into a coloured object, which is not what a shadow does to white tape.
  const s = Math.min(1, _hsl.s * satGain + satLift * (0.25 + 0.75 * _hsl.s));
  // Dark surfaces drop proportionally less. A navy gi taken to 44% of its own
  // lightness is a black hole; the eye still needs to read the fabric.
  const l = Math.max(0, _hsl.l * THREE.MathUtils.lerp(0.78, value, Math.min(1, _hsl.l * 2.2)));
  return c.setHSL(h, s, l, THREE.SRGBColorSpace);
}

/**
 * Multiplier applied inside the core of a shadow.
 *
 * Down there bounced skylight is the only light left, so the surface keeps
 * losing red as it deepens. Deliberately a near-neutral *multiplier* rather
 * than a colour: recolouring the core rather than filtering it is how the last
 * pass ended up with crimson skin.
 */
export function coreShadowTint(base: THREE.ColorRepresentation, strength = 1): THREE.Color {
  const c = new THREE.Color(base);
  c.getHSL(_hsl, THREE.SRGBColorSpace);
  // Warm surfaces lose slightly more red than already-cool ones do.
  const warm = Math.cos((_hsl.h - 0.08) * Math.PI * 2) * 0.5 + 0.5;
  const k = strength * (0.14 + 0.1 * warm);
  return c.setRGB(1 - k * 1.4, 1 - k, 1 - k * 0.15);
}

/**
 * Ink colour for a surface's outline.
 *
 * KOF's linework is never black — it is a very dark, very saturated version of
 * the colour it encloses, which is why the lines feel drawn rather than
 * composited. Orange cloth gets an oxblood line, teal gets near-black indigo.
 */
export function inkColor(base: THREE.ColorRepresentation, strength = 1): THREE.Color {
  const c = new THREE.Color(base);
  c.getHSL(_hsl, THREE.SRGBColorSpace);
  let d = 0.98 - _hsl.h; // toward deep red-violet, the traditional ink bias
  if (d > 0.5) d -= 1;
  else if (d < -0.5) d += 1;
  const h = (_hsl.h + d * 0.1 + 1) % 1;
  const s = Math.min(1, _hsl.s * 1.35 + 0.12);
  const l = THREE.MathUtils.lerp(_hsl.l * 0.55, _hsl.l * 0.16 + 0.025, strength);
  return c.setHSL(h, s, l, THREE.SRGBColorSpace);
}
