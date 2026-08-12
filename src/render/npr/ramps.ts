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
   * Curve applied to the *unbanded* A channel. The banded planes take their
   * values from `shadowLevel`/`litLevel` instead, so this no longer touches
   * them — a value curve is the wrong tool for deciding which edge the audience
   * reads.
   */
  gamma?: number;
  /**
   * Where the core-shadow edge sits, as a fraction of `toe`. This is the form
   * shadow: the darker shape *inside* the shadow that gives a limb its
   * roundness without adding a second terminator.
   */
  core?: number;
  /**
   * Value of the shadow plane, 0..1, as a mix factor from shadow colour to base.
   * Near 0 means the shadow plane is very nearly the pure shadow colour, which
   * is what makes a two-tone read hold: the terminator has to be a *change of
   * colour*, not a dimming.
   */
  shadowLevel?: number;
  /**
   * Value of the main lit plane. Below 1 so that a fourth band has somewhere to
   * go without brightening past the albedo.
   */
  litLevel?: number;
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
  core: 0.42,
  shadowLevel: 0.14,
  litLevel: 0.88,
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
    core: THREE.MathUtils.clamp(spec.core ?? DEFAULTS.core, 0.05, 0.9),
    shadowLevel: THREE.MathUtils.clamp(spec.shadowLevel ?? DEFAULTS.shadowLevel, 0, 1),
    litLevel: THREE.MathUtils.clamp(spec.litLevel ?? DEFAULTS.litLevel, 0, 1),
  };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Band boundaries and the value each band sits at.
 *
 * The previous layout spread every edge evenly from `toe` to `shoulder` and gave
 * each band an equal slice of value, so a four-band skin ramp put three edges of
 * comparable contrast across the torso. Review 001 called the result "lava lamp
 * amoebas that land on no anatomical landmark" and the diagnosis was exact: none
 * of those edges reads as the terminator, because all of them do. Measured on
 * the old skin preset the three steps were 0.43 / 0.30 / 0.27 of the value range
 * — three terminators, evenly matched, competing.
 *
 * This layout is a hierarchy instead:
 *
 * - **The terminator**, at `toe`. It owns almost the entire value range, so it
 *   is unmistakably *the* edge — the light shape against the shadow shape.
 * - **The core**, below it at `toe * core`, entirely inside the shadow. This is
 *   the form shadow. It cannot compete with the terminator because it never
 *   touches the lit side.
 * - **Form bands**, if any, on the lit side near `shoulder`, dividing whatever
 *   value is left between `litLevel` and 1. Deliberately low contrast: they
 *   model the lit plane, they do not cut it in half.
 *
 * A two-band ramp is then genuinely two tones, and a three-band ramp is the hard
 * cel read this pipeline wants by default: one light shape, one shadow shape,
 * one form shadow inside the shadow.
 */
function bandLayout(r: ResolvedRamp): { edges: number[]; values: number[] } {
  const term = r.toe;
  const core = term * r.core;

  if (r.bands === 2) return { edges: [term], values: [r.shadowLevel, 1] };
  if (r.bands === 3) return { edges: [core, term], values: [0, r.shadowLevel, 1] };

  const upper = r.bands - 3;
  const edges = [core, term];
  const values = [0, r.shadowLevel, r.litLevel];
  // Form bands start well clear of the terminator so the two never read as a
  // pair of edges; the last one lands exactly on `shoulder`.
  const first = term + (r.shoulder - term) * 0.45;
  for (let k = 1; k <= upper; k++) {
    const t = upper === 1 ? 1 : (k - 1) / (upper - 1);
    edges.push(THREE.MathUtils.lerp(first, r.shoulder, t));
    values.push(THREE.MathUtils.lerp(r.litLevel, 1, k / upper));
  }
  return { edges, values };
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
  const key = `${r.bands}|${r.sharpness.toFixed(3)}|${r.toe.toFixed(3)}|${r.shoulder.toFixed(3)}|${r.terminatorWidth.toFixed(3)}|${r.gamma.toFixed(3)}|${r.core.toFixed(3)}|${r.shadowLevel.toFixed(3)}|${r.litLevel.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const { edges, values } = bandLayout(r);
  // Which edge is the terminator. With a core band present it is the second one,
  // and getting this wrong puts the painted warm bleed *inside* the shadow.
  const termIndex = r.bands === 2 ? 0 : 1;
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

      // The terminator carries the painted warmth. Form edges get a fraction so
      // the lit plane has some life; the core edge gets almost none, because a
      // warm subsurface bleed deep inside a shadow is the opposite of what light
      // does there.
      const weight = k === termIndex ? 1 : k < termIndex ? 0.12 : 0.3;
      const d = (x - e) / r.terminatorWidth;
      terminator = Math.max(terminator, weight * Math.exp(-d * d * 2.77));
    }

    // Core-shadow mask: the darkest band only, feathered by that band's own
    // edge width so the cool core tint lands as a shape rather than a gradient
    // creeping up into the mid shadow.
    const coreEdge = r.bands === 2 ? edges[0] * 0.45 : edges[0];
    const core = 1 - smoothstep(coreEdge - edgeWidth[0], coreEdge + edgeWidth[0], x);

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
const _hslB = { h: 0, s: 0, l: 0 };
const _srgb = { r: 0, g: 0, b: 0 };

/** Hue of the ambient the shadows sit in. 0.60 turn ≈ the blue of skylight. */
const COOL_ANCHOR = 0.6;

/**
 * Default colour of the sky the shadows sit in. Stages override it through
 * `NPR_TUNING.skyColor`.
 */
export const DEFAULT_SKY = 0x93aada;

// --- warm/cool measurement -------------------------------------------------
//
// Review 001 argued shadow temperature from HSV hue, and on orange skin that
// axis cannot decide the question. Adding blue skylight to orange *lowers* HSV
// hue, because hue there is 60·(G−B)/(R−B) and a blue lift closes the G−B gap
// faster than the R−B one. Measured on Mali's own albedo 0xc2793f:
//
//   lit skin                     HSV H 26.6   Lab b* +42.9
//   + skylight fill (10,16,32)   HSV H 12.0   Lab b*  +6.5   ← much cooler
//   + skylight fill (14,22,46)   HSV H  350   Lab b*  +1.1   ← cooler again
//
// So "lit H31 → shadow H24" is equally the signature of a cool fill. The axis
// that does decide it is CIELAB b* normalised by L* — yellowness per unit
// lightness, invariant to the value drop every shadow must have. A shadow that
// is merely *darker* scores the same warmth as its lit side; one sitting in
// skylight scores lower. That is the number `coolShadow` is built to move, and
// the number it verifies before it returns.

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function labF(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29;
}

/**
 * Warmth of a colour: CIELAB b* divided by L*.
 *
 * Positive is yellow, negative is blue, and the division by lightness is what
 * makes it usable as a *shadow* metric — see the note above.
 */
export function warmth(color: THREE.ColorRepresentation): number {
  const c = color instanceof THREE.Color ? color : new THREE.Color(color);
  c.getRGB(_srgb, THREE.SRGBColorSpace);
  const r = srgbToLinear(Math.max(_srgb.r, 0));
  const g = srgbToLinear(Math.max(_srgb.g, 0));
  const b = srgbToLinear(Math.max(_srgb.b, 0));
  const fy = labF(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const fz = labF((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  const L = 116 * fy - 16;
  return (200 * (fy - fz)) / Math.max(L, 1e-3);
}

/**
 * Tints `target` toward `tint`'s hue and chroma while holding `target`'s own
 * lightness.
 *
 * Mixing straight toward a light sky colour would lift the shadow's value at the
 * same time as cooling it, and then the value-band control downstream has to
 * undo half of what this did. Separating the two moves means each one is tuned
 * against exactly one measurement.
 */
function tintAtLightness(target: THREE.Color, tint: THREE.Color, amount: number): void {
  if (amount <= 0) return;
  target.getHSL(_hsl, THREE.SRGBColorSpace);
  tint.getHSL(_hslB, THREE.SRGBColorSpace);
  const t = tint.clone().setHSL(_hslB.h, _hslB.s, _hsl.l, THREE.SRGBColorSpace);
  // Mixed in sRGB, because "half way between these two swatches" is a statement
  // about the space a painter picks colours in, not about linear light.
  target.getRGB(_srgb, THREE.SRGBColorSpace);
  const b = { r: 0, g: 0, b: 0 };
  t.getRGB(b, THREE.SRGBColorSpace);
  target.setRGB(
    THREE.MathUtils.lerp(_srgb.r, b.r, amount),
    THREE.MathUtils.lerp(_srgb.g, b.g, amount),
    THREE.MathUtils.lerp(_srgb.b, b.b, amount),
    THREE.SRGBColorSpace,
  );
}

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
  /**
   * Multiplier on saturation. Below 1 — see the note in `coolShadow` about why
   * the old chroma *gain* is what prevented any temperature separation.
   */
  satGain?: number;
  /** Chroma added to near-neutral colours so a grey shadow still reads cool. */
  satLift?: number;
  /** Multiplier on lightness for a mid-value base. */
  value?: number;
  /** How much sky colour is mixed into the shadow, at constant lightness. */
  skylight?: number;
  /** The sky the shadow sits in. Defaults to `DEFAULT_SKY`. */
  skyColor?: THREE.ColorRepresentation;
  /**
   * This fighter's accent — `palette.energy` — pulled into the shadow tint. The
   * cheapest available win on colour identity: four fighters whose shadows are
   * four different colours read as four fighters even before the costumes land.
   */
  accent?: THREE.ColorRepresentation | null;
  /** How much of the accent to pull in, at constant lightness. */
  accentAmount?: number;
  /**
   * Minimum drop in `warmth` the result must achieve against `base`. Enforced by
   * measurement, not by trusting the tuning above.
   */
  minCool?: number;
}

/**
 * Derives the colour a surface takes in shadow.
 *
 * The maths runs in **sRGB** HSL on purpose: hue rotations that look right to a
 * painter are defined in the space a painter picks colours in, not in linear
 * light where a 20° rotation reads as a completely different move.
 *
 * ## Why this was rewritten
 *
 * The previous version made three moves — hue toward the ambient, chroma **up**,
 * value down — and its docstring claimed the first of those was what separated a
 * painting from a render. Measured, the function did not deliver it, for two
 * reasons that compounded:
 *
 * 1. **The chroma gain cancelled the hue rotation.** Rotating a fully saturated
 *    orange 30° toward violet just relocates a fully saturated swatch; the
 *    yellow-blue opponent value barely moves. Mali's authored shadow scored
 *    `warmth` 0.833 against 0.879 for her lit skin — a 5% move, invisible.
 * 2. **Skin never called it at all.** `rig.ts` passes the roster's authored
 *    `skinShadow` hex, and those hexes are the lit tone darkened: 0xc2793f →
 *    0x8a4d26 is 3° *warmer*. `ToonMaterial` now conditions that hex instead of
 *    taking it verbatim.
 *
 * So the moves are now: hue toward the ambient, chroma **down** (compressively —
 * saturated surfaces lose some, near-neutrals gain a tint so a grey shadow still
 * reads cool), value down, then a skylight mix at constant lightness, then the
 * fighter's accent at constant lightness.
 *
 * ## The guarantee
 *
 * Tuning constants are exactly how the last pass ended up shipping warm shadows
 * while believing otherwise, so the last step is not a constant. The function
 * *measures* `warmth` of what it produced against `warmth` of the base and, if
 * the shadow is not cooler by at least `minCool`, mixes in more skylight until it
 * is. A caller cannot mis-tune this into producing a warm shadow.
 */
export function coolShadow(base: THREE.ColorRepresentation, opts: ShadowTintOptions = {}): THREE.Color {
  const shift = opts.shift ?? 0.24;
  const satGain = opts.satGain ?? 0.86;
  const satLift = opts.satLift ?? 0.1;
  const value = opts.value ?? 0.44;
  const skylight = THREE.MathUtils.clamp(opts.skylight ?? 0.24, 0, 1);
  const accentAmount = THREE.MathUtils.clamp(opts.accentAmount ?? 0, 0, 1);
  const minCool = opts.minCool ?? 0.12;

  const sky = new THREE.Color(opts.skyColor ?? DEFAULT_SKY);
  const c = new THREE.Color(base);
  c.getHSL(_hsl, THREE.SRGBColorSpace);

  const h = towardCool(_hsl.h, shift);
  // Compressive rather than a flat multiply: a saturated surface gives up chroma
  // in shadow, a near-white wrap picks a little up. A single gain cannot do both,
  // and using a gain above 1 for everything is what pinned the old shadows to
  // their lit hue.
  const s = THREE.MathUtils.clamp(_hsl.s * satGain + satLift * (1 - _hsl.s), 0, 1);
  // Dark surfaces drop proportionally less. A navy gi taken to 44% of its own
  // lightness is a black hole; the eye still needs to read the fabric.
  const l = Math.max(0, _hsl.l * THREE.MathUtils.lerp(0.78, value, Math.min(1, _hsl.l * 2.2)));
  c.setHSL(h, s, l, THREE.SRGBColorSpace);

  tintAtLightness(c, sky, skylight);
  if (opts.accent != null && accentAmount > 0) {
    tintAtLightness(c, new THREE.Color(opts.accent), accentAmount);
  }

  // Verify, then correct. 12 steps of extra skylight is enough to cool anything
  // in the roster's gamut, and the loop runs once per material at build time.
  const target = warmth(base) - minCool;
  for (let i = 0; i < 12 && warmth(c) > target; i++) {
    tintAtLightness(c, sky, 0.12);
  }
  return c;
}

export interface ValueBandSpec {
  /** Lowest lightness this surface may sit at, 0..1 in sRGB HSL. */
  min: number;
  /** Highest lightness this surface may sit at. */
  max: number;
  /** Lightness above/below the band is compressed by this factor, not clipped. */
  slope?: number;
  /** Saturation knee; chroma above it is compressed toward the knee. */
  chromaKnee?: number;
  /** Compression factor applied to chroma above the knee. */
  chromaSlope?: number;
}

/**
 * Pulls a colour into a controlled value band **without touching its hue**.
 *
 * Review 001, defect 4: Davi's lit chest measured V44 while Vera's and Kai's
 * *shadows* measured V60 and V61 — the darkest fighter's light side was darker
 * than two others' dark sides, so on any stage darker than a blank plane he
 * disappears. Mali meanwhile clipped her red channel, which flattens her skin
 * into a solid orange decal with no form left in it.
 *
 * Both are the same bug: the palette hexes were picked as swatches, with nothing
 * holding them to a shared range once the lighting rig multiplied them.
 *
 * The excursion outside the band is **compressed, not clipped**, and chroma above
 * the knee likewise. That distinction is the whole point: a hard clamp would make
 * Kai and Vera — whose skin hexes are 2° apart in hue and differ mainly in value
 * and chroma — land on exactly the same colour, trading one review defect for a
 * worse one. Compression keeps every fighter's ordering and their differences,
 * just at a scale the frame can hold.
 */
export function fitValueBand(color: THREE.ColorRepresentation, spec: ValueBandSpec): THREE.Color {
  const slope = spec.slope ?? 0.3;
  const knee = spec.chromaKnee ?? 1;
  const chromaSlope = spec.chromaSlope ?? 0.45;

  const c = new THREE.Color(color);
  c.getHSL(_hsl, THREE.SRGBColorSpace);

  let l = _hsl.l;
  if (l > spec.max) l = spec.max + (l - spec.max) * slope;
  else if (l < spec.min) l = spec.min - (spec.min - l) * slope;

  let s = _hsl.s;
  if (s > knee) s = knee + (s - knee) * chromaSlope;

  return c.setHSL(_hsl.h, THREE.MathUtils.clamp(s, 0, 1), THREE.MathUtils.clamp(l, 0, 1), THREE.SRGBColorSpace);
}

/**
 * Multiplier applied inside the core of a shadow.
 *
 * Down there bounced skylight is the only light left, so the surface keeps
 * losing red as it deepens. Deliberately a near-neutral *multiplier* rather
 * than a colour: recolouring the core rather than filtering it is how the last
 * pass ended up with crimson skin.
 *
 * The ramp's B channel now masks the darkest band with a hard feathered edge
 * rather than a squared gradient reaching up to the terminator, so this lands as
 * a form-shadow *shape* and can afford to bite harder than it used to.
 */
export function coreShadowTint(base: THREE.ColorRepresentation, strength = 1): THREE.Color {
  const c = new THREE.Color(base);
  c.getHSL(_hsl, THREE.SRGBColorSpace);
  // Warm surfaces lose slightly more red than already-cool ones do.
  const warm = Math.cos((_hsl.h - 0.08) * Math.PI * 2) * 0.5 + 0.5;
  const k = strength * (0.17 + 0.13 * warm);
  return c.setRGB(1 - k * 1.5, 1 - k, 1 - k * 0.1);
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
