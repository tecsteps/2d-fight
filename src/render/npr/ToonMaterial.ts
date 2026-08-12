import * as THREE from 'three';
import type { NPRMaterial, SurfaceKind, ToonMaterialOptions } from './contract';
import type { ValueBandSpec } from './ramps';
import { DEFAULT_SKY, bandRamp, coolShadow, coreShadowTint, fitValueBand, inkColor, warmth } from './ramps';

/**
 * The NPR surface shader.
 *
 * A custom `ShaderMaterial` with `lights: true`, so it runs through Three's real
 * light and shadow uniforms — every light type, directional shadow maps,
 * skinning, morph targets — but replaces the reflectance model wholesale.
 *
 * ## How the shading model works
 *
 * Three's light loop is used as an **accumulator**, not as a lighting solution.
 * `RE_Direct` fills three of `ReflectedLight`'s slots, each contribution
 * weighted by that light's own luminance:
 *
 * - `directDiffuse`    Σ Lc · lum(Lc) · wrapped N·L    the lit energy
 * - `indirectSpecular` Σ Lc · lum(Lc)                  the light present here
 * - `directSpecular`   Σ Lc · lum(Lc) · highlight lobe
 *
 * Dividing the first by a **calibrated reference** for the rig gives one scalar
 * `shade` in 0..1 that drives a single banded ramp. Two consequences, both
 * deliberate:
 *
 * - Squaring by luminance makes the brightest light own the shadow *shape*. A
 *   three-point rig then produces one terminator instead of three overlapping
 *   ones, which is the difference between a drawn frame and mud.
 * - Normalising against the un-shadowed rig reference (rather than against the
 *   sum actually arriving) means a shadow map that kills the key really does
 *   drop the surface into its shadow band, instead of the fill and rim quietly
 *   taking over and erasing the cast shadow.
 *
 * Everything after the ramp lookup is painting: hue-shifted shadow, chroma at
 * the terminator, subsurface warmth, a quantised highlight, and a rim that only
 * appears where the rim light actually is.
 *
 * Nothing here loads: the ramp is generated in `ramps.ts`, the surface breakup
 * is value noise evaluated in the shader.
 *
 * ## What the temperature separation is made of
 *
 * Review 001 measured this module producing shadows *warmer* than the lit skin on
 * every fighter, against a docstring claiming the opposite. The reason was that
 * four separate warm terms were each stronger on the shadow side than the cool
 * ones, and nothing anywhere named the colour of the light filling a shadow:
 *
 * 1. `shadowColor` was taken verbatim from the roster's authored hexes, which are
 *    the lit tone darkened — so `coolShadow` never ran on skin at all.
 * 2. The rim was weighted **1.3 in shadow against 0.7 in light**, so a warm rim
 *    lamp was nearly twice as bright where the light was not.
 * 3. Subsurface — a hot red — was gated on terminator proximity only, so it
 *    washed straight across the shadow band.
 * 4. `coolShadow` itself *gained* chroma, which cancels a hue rotation: rotating a
 *    fully saturated orange 30° toward violet just relocates a saturated swatch.
 *
 * All four are fixed below, and the cooling is no longer a tuning constant that
 * can silently stop working: `coolShadow` measures CIELAB b-star over L-star of what it
 * produced and mixes in more skylight until the shadow is provably cooler than
 * the surface it belongs to.
 */

/** Global tuning shared by every NPR surface. Safe to poke at runtime. */
export const NPR_TUNING = {
  /**
   * Σ lum(lightColour)² for the stage's rig with nothing shadowed. Set by
   * `calibrateNpr`; the default matches a typical three-point fighting rig so
   * an uncalibrated scene still looks right.
   */
  lightReference: 4.6,
  /**
   * Chroma boost applied before tone mapping. ACES desaturates as it rolls off
   * and this palette lives exactly where it would quietly eat it.
   */
  saturation: 1.16,
  /** World-space direction *toward* the rim light. Stages override this. */
  rimDirection: new THREE.Vector3(0.16, 0.48, -0.86).normalize(),
  /**
   * Colour of the sky the shadows sit in.
   *
   * This is the term the shading model was missing entirely. Three's light loop
   * has no concept of "the light on the dark side": what arrives there is
   * whatever the rig's non-key lamps happen to be, and on the bootstrap stage
   * that is a 1.9-intensity *warm* rim (0xff9f5a) beating the cool fill by 4.5:1
   * on luminance². So every fighter's shadow came out the same temperature as
   * their light. Naming the sky explicitly lets the shadow band be cooled on
   * purpose instead of inheriting whatever lamp happens to be pointed at it.
   */
  skyColor: new THREE.Color(DEFAULT_SKY),
  /** Distance at which point/spot lights are sampled during calibration. */
  calibrationDistance: 4,
  /** Re-derive `lightReference` the first time each scene is drawn. */
  autoCalibrate: true,
};

interface KindPreset {
  bands: number;
  sharpness: number;
  toe: number;
  shoulder: number;
  terminatorWidth: number;
  /** Where the core (form) shadow edge sits, as a fraction of `toe`. */
  coreDepth: number;
  /** Value of the shadow plane. Near 0 = the terminator is a colour change. */
  shadowLevel: number;
  /** Value of the main lit plane; the headroom above it belongs to form bands. */
  litLevel: number;
  /** Half-lambert wrap: how far past the geometric terminator light carries. */
  wrap: number;
  /** Contrast trim on the ramp coordinate, applied before the lookup. */
  shadeGain: number;
  shadeBias: number;
  specular: number;
  specPower: number;
  specThreshold: number;
  specSoft: number;
  /** Soft halo around the quantised highlight, 0..1. Fabric needs it, metal doesn't. */
  sheen: number;
  /** 0 = round Blinn lobe, 1 = full Kajiya-Kay band across the strand. */
  aniso: number;
  /** Object-space strand / weave direction. */
  anisoAxis: THREE.Vector3;
  anisoShift: number;
  /** Per-strand jitter on the sheen band, so hair reads as clumps not chrome. */
  anisoJitter: number;
  rim: number;
  rimSharp: number;
  rimEdge: number;
  rimSoft: number;
  rimDirectional: number;
  rimSpread: number;
  sss: number;
  translucency: number;
  /** Self-shadow strength driven by normal-map creases. */
  curvature: number;
  terminatorNoise: number;
  noiseScale: number;
  ambient: number;
  /** How much the stage light's hue tints the costume. Low keeps it on-model. */
  lightTint: number;
  exposureResponse: number;
  outlineWidth: number;
  /** Multipliers on the default shadow hue rotation and value for this surface. */
  shadowShift: number;
  shadowValue: number;
  /** How far the highlight colour is pulled to white. Pure white reads as vinyl. */
  specTint: number;

  // --- temperature -------------------------------------------------------
  /** Sky mixed into the derived shadow colour, at constant lightness. */
  skylight: number;
  /** How much of the surface's accent goes into its shadow tint. */
  accentShadow: number;
  /** Minimum measured drop in `warmth` the shadow must achieve. */
  minCool: number;
  /**
   * Sky tint applied to the shadow *band* at shading time, on top of the derived
   * shadow colour. The CPU term sets the shadow's own colour; this one keeps it
   * cool once the rig's warm lamps have added themselves back on.
   */
  shadowLift: number;
  /**
   * Strength of the core-shadow multiplier. Turned down for surfaces whose
   * darkest band covers a large area — see `coreShadowTint`.
   */
  coreTint: number;

  // --- value control -----------------------------------------------------
  /** Band the lit albedo is compressed into. Null leaves the albedo alone. */
  litBand: ValueBandSpec | null;
  /** Band the derived shadow colour is compressed into. */
  shadowBand: ValueBandSpec | null;

  // --- highlight / rim shaping -------------------------------------------
  /**
   * Where the highlight's outer step sits, as a fraction of `specThreshold`. The
   * old hard-coded 0.28 put it so far below the core that the two steps merged
   * into one smooth lobe — a round gaussian blob, which review 001 measured as
   * two white circles on Mali's pec. Near 0.6 the two steps stay distinct and
   * read as a drawn highlight with a hot core.
   */
  specHalo: number;
  /**
   * Rim multiplier on the shadow side. Was hard-coded at 1.3 — the rim was
   * *brightest* where the light was not, which is most of why the shadows
   * measured warmer than the lit skin.
   */
  rimShadow: number;
  /**
   * Widest the terminator's antialiasing may spread, in ramp coordinate. The old
   * clamp of 0.12 was fifty times the baked edge width, so the three-tap filter
   * turned every band boundary into a box blur.
   */
  aaClamp: number;
}

const BASE: KindPreset = {
  bands: 3,
  sharpness: 0.95,
  toe: 0.34,
  shoulder: 0.78,
  terminatorWidth: 0.055,
  coreDepth: 0.42,
  shadowLevel: 0.14,
  litLevel: 0.88,
  wrap: 0.08,
  shadeGain: 1.08,
  shadeBias: -0.02,
  specular: 0.14,
  specPower: 28,
  specThreshold: 0.26,
  specSoft: 0.05,
  sheen: 0.22,
  aniso: 0,
  anisoAxis: new THREE.Vector3(0, 1, 0),
  anisoShift: 0,
  anisoJitter: 0,
  rim: 0.7,
  rimSharp: 1.2,
  rimEdge: 0.52,
  rimSoft: 0.06,
  rimDirectional: 0.9,
  rimSpread: -0.25,
  sss: 0,
  translucency: 0,
  curvature: 0,
  terminatorNoise: 0.01,
  noiseScale: 22,
  ambient: 0.5,
  lightTint: 0.35,
  exposureResponse: 0.55,
  outlineWidth: 1,
  shadowShift: 1,
  shadowValue: 1,
  specTint: 0.35,

  skylight: 0.12,
  accentShadow: 0.1,
  minCool: 0.12,
  shadowLift: 0.18,
  coreTint: 1,

  litBand: null,
  shadowBand: null,

  specHalo: 0.62,
  rimShadow: 0.85,
  aaClamp: 0.018,
};

/**
 * Per-surface treatment.
 *
 * These numbers are the art direction. They were pushed until every material
 * reads as its own substance in `nprDebugScene` *without any texture* — if skin
 * and cloth are still distinguishable on two identical spheres, the shading
 * model is carrying its weight and the texture work is free to stay subtle.
 */
const KINDS: Record<SurfaceKind, Partial<KindPreset>> = {
  // Flesh: a hard two-tone read with a form shadow inside the shadow, and no
  // highlight at all.
  //
  // The previous preset argued for the opposite — four evenly-weighted bands, a
  // 0.24 half-lambert wrap, and a specular lobe — on the grounds that "a hard N·L
  // terminator on a cylinder always looks like a rendered cylinder". Review 001
  // measured what that actually produced: "soft irregular lava lamp amoebas that
  // land on no anatomical landmark", plus two round white circles on Mali's pec
  // and a wet gloss down Davi's forearm. The argument was sound and the
  // conclusion was backwards. What stops a cylinder reading as a cylinder is a
  // shadow *shape* with a committed edge; the wrap was smearing the one edge that
  // could have provided it, and three bands of comparable contrast meant there
  // was no single edge to commit to in the first place.
  //
  // So: three bands (light plane, shadow plane, form shadow), razor sharpness,
  // wrap down from 0.24 to 0.07, and `specular: 0`.
  skin: {
    bands: 3,
    sharpness: 1,
    // Dropping `wrap` from 0.24 to 0.07 moves the terminator round the form:
    // with the key carrying 74% of the rig's reference, the old 0.34 toe landed
    // at N·L 0.33 while an unchanged toe would have put it at 0.45 — measured on
    // the first pass as a shadow covering roughly half of every torso. A fighter
    // reads as *mostly lit with a decisive shadow shape*, so the toe comes down
    // to put the edge back at N·L 0.30.
    toe: 0.27,
    coreDepth: 0.46,
    // Almost pure shadow colour on the dark side. The terminator has to be a
    // change of colour and temperature, not a dimming, or it reads as a render.
    shadowLevel: 0.1,
    terminatorWidth: 0.042,
    wrap: 0.07,
    // Deleted. A round soft gaussian on skin is the loudest "3D render" tell
    // after the halo — it turned Mali into a wax figure and Davi into a
    // chocolate figurine. Sweat sheen, when it exists, belongs in a VFX pass
    // keyed to exertion, not in the base flesh shader.
    specular: 0,
    sheen: 0,
    specPower: 100,
    specThreshold: 0.2,
    specSoft: 0.035,
    // Halved, and now multiplied by the smooth ramp so the warm bleed can only
    // land on the light's side of the terminator. Letting a hot red subsurface
    // term wash across the shadow band was one of the four warm pushes that
    // erased the frame's temperature separation.
    sss: 0.22,
    // Was 1.2 over a 0.33 edge — that is a 51°-wide Fresnel wash, not a rim, and
    // it was the single largest warm additive sitting on the shadow side.
    //
    // Cut to 0.4 on the first pass, and measuring that showed the rim had been
    // doing identity work as well as damage: Kai is the only fighter with a cool
    // rim colour, and losing it collapsed the roster's lit Lab-hue spread from 16°
    // to 7.4° with Kai and Vera 0.5° apart. The strength comes back most of the
    // way; what does not come back is the width — a 0.6 edge is a line near the
    // silhouette rather than a 51° wash across the form.
    rim: 0.45,
    rimSharp: 1.15,
    rimEdge: 0.6,
    rimSoft: 0.045,
    rimShadow: 0.75,
    terminatorNoise: 0.007,
    noiseScale: 26,
    // Trimmed because the ambient lift is multiplicative on the hemisphere's
    // *ground* colour, which on this rig is a warm 0x3d2a1c pointing up into every
    // downward-facing surface — i.e. into the shadow band. Davi's shadow measured
    // V48.7 against a lit V63.8 with the old value: a 15-point terminator, which
    // is not a two-tone read.
    ambient: 0.38,
    lightTint: 0.24,
    outlineWidth: 0.9,
    // Flesh shadow goes plum rather than straight to blue — blood under the
    // skin, not skylight on top of it. The old 0.5 multiplier on an already
    // modest 0.17 rotation came to 30°, which measured as no rotation at all.
    shadowShift: 0.78,
    skylight: 0.11,
    accentShadow: 0.11,
    minCool: 0.16,
    // The load-bearing term, and the reason it is this high. A stage rig is not
    // this module's to control: the bootstrap rig gained a warm bounce lamp
    // (0xc08a5c from below) and a warm ground ambient while this work was in
    // flight, and both feed straight into the shadow band. Measured against that
    // rig, the pre-change shader still failed the cooler-in-shadow test on 3 of 4
    // fighters even though the same rig change had turned the *rim* cool — a warm
    // term anywhere in the rig will find the shadow. This tint is applied after
    // the ramp and keyed to the shadow band, so it is the one cooling term no
    // lamp can outvote.
    shadowLift: 0.38,
    coreTint: 1.15,
    aaClamp: 0.012,
    specTint: 0.55,
    // Defect 4. Davi's lit chest measured V44 against Vera's and Kai's shadows
    // at V60/V61, and Mali clipped her red channel outright. Compressed rather
    // than clamped, so Kai and Vera — whose skin hexes are 2° apart in hue and
    // separate mainly on value and chroma — do not collapse onto each other.
    litBand: { min: 0.42, max: 0.55, slope: 0.3, chromaKnee: 0.52, chromaSlope: 0.45 },
    shadowBand: { min: 0.15, max: 0.26, slope: 0.35, chromaKnee: 0.44, chromaSlope: 0.4 },
  },

  // Hair reads as a solid shape with one banded highlight travelling round it.
  // Two bands only: anime hair has a light side and a dark side, full stop.
  hair: {
    bands: 2,
    sharpness: 1,
    toe: 0.44,
    shadowLevel: 0.08,
    wrap: 0.06,
    // Kept, because Kajiya-Kay is already a *band* across the strand rather than
    // a round lobe — the thing the review objected to. The sheen halo comes down
    // so the band has a hard outer edge instead of fading into chrome.
    specular: 0.75,
    specPower: 58,
    specThreshold: 0.16,
    specSoft: 0.025,
    sheen: 0.18,
    aniso: 1,
    anisoShift: 0.06,
    anisoJitter: 0.1,
    rim: 0.75,
    rimSharp: 1.05,
    rimEdge: 0.5,
    terminatorNoise: 0.01,
    noiseScale: 52,
    ambient: 0.4,
    outlineWidth: 1.25,
    specTint: 0.34,
    skylight: 0.14,
    shadowLift: 0.22,
    aaClamp: 0.012,
  },

  // Matte fabric. The whole read is the shadow *shape*, so the edges are crisp
  // and the highlight is a wash with no hard core at all.
  cloth: {
    bands: 3,
    sharpness: 0.97,
    wrap: 0.05,
    shadowLevel: 0.13,
    specular: 0.05,
    specPower: 22,
    specThreshold: 0.24,
    specSoft: 0.09,
    sheen: 0.3,
    rim: 0.55,
    terminatorNoise: 0.012,
    noiseScale: 30,
    outlineWidth: 1.1,
    specTint: 0.15,
    skylight: 0.14,
    shadowLift: 0.2,
    aaClamp: 0.014,
  },

  // Padding. Four bands so each puff carries its own gradient, and real
  // self-shadowing at the seams — a quilted vest that does not shadow itself
  // reads as printed cloth rather than as something with air inside it.
  quilted: {
    bands: 4,
    sharpness: 0.9,
    toe: 0.3,
    shoulder: 0.82,
    wrap: 0.1,
    // Padding is the one surface that genuinely wants its bands closer together:
    // each puff carries its own small gradient over a dominant terminator.
    shadowLevel: 0.2,
    litLevel: 0.78,
    shadeGain: 1.16,
    specular: 0.09,
    specPower: 26,
    specThreshold: 0.24,
    specSoft: 0.06,
    sheen: 0.25,
    curvature: 0.6,
    rim: 0.6,
    terminatorNoise: 0.012,
    noiseScale: 16,
    outlineWidth: 1.2,
    specTint: 0.21,
    skylight: 0.14,
    shadowLift: 0.2,
  },

  // Muay thai shorts: a sharp anisotropic glint banded across the drape over a
  // near-black base. That glint is most of what makes satin read as satin.
  satin: {
    bands: 3,
    sharpness: 0.98,
    toe: 0.3,
    wrap: 0.03,
    shadowLevel: 0.1,
    specular: 0.95,
    specPower: 150,
    specThreshold: 0.12,
    specSoft: 0.02,
    sheen: 0.2,
    aniso: 0.9,
    anisoShift: 0.02,
    rim: 0.7,
    rimEdge: 0.48,
    ambient: 0.72,
    terminatorNoise: 0.007,
    specTint: 0.46,
    skylight: 0.14,
    shadowLift: 0.2,
    aaClamp: 0.012,
  },

  leather: {
    bands: 3,
    sharpness: 0.95,
    wrap: 0.05,
    shadowLevel: 0.12,
    specular: 0.46,
    specPower: 90,
    specThreshold: 0.18,
    specSoft: 0.028,
    sheen: 0.18,
    rim: 0.6,
    terminatorNoise: 0.009,
    noiseScale: 34,
    outlineWidth: 1.15,
    specTint: 0.3,
    skylight: 0.14,
    shadowLift: 0.2,
    aaClamp: 0.013,
  },

  // Tape over knuckles: thin enough that light comes through from behind, and
  // the weave scatters enough that the terminator is very soft.
  // Tape stays the softest terminator in the set — the weave really does scatter
  // that much — but 0.34 of wrap was enough to erase the edge entirely.
  wrap: {
    bands: 3,
    sharpness: 0.9,
    toe: 0.4,
    wrap: 0.22,
    shadowLevel: 0.22,
    specular: 0.07,
    specPower: 24,
    specThreshold: 0.26,
    specSoft: 0.1,
    sheen: 0.28,
    sss: 0.18,
    translucency: 0.4,
    rim: 0.55,
    terminatorNoise: 0.012,
    noiseScale: 46,
    ambient: 0.6,
    outlineWidth: 0.85,
    specTint: 0.27,
    skylight: 0.16,
    shadowLift: 0.22,
  },

  metal: {
    bands: 2,
    sharpness: 1,
    toe: 0.42,
    wrap: 0,
    shadowLevel: 0.06,
    specular: 1,
    specPower: 190,
    specThreshold: 0.1,
    specSoft: 0.015,
    sheen: 0.12,
    specHalo: 0.72,
    rim: 0.9,
    rimSharp: 0.95,
    rimEdge: 0.48,
    ambient: 0.35,
    lightTint: 0.6,
    terminatorNoise: 0.004,
    specTint: 0.9,
    skylight: 0.2,
    shadowLift: 0.24,
    aaClamp: 0.01,
  },

  // Stages are lit, not drawn: more bands, softer edges, weak rim, no ink. The
  // fighters must be the only things on screen with hard linework and hard
  // shadow shapes, or the eye stops finding them instantly.
  // Stages are pinned to their previous look on purpose.
  //
  // These numbers reproduce the old even-band ramp exactly — edges at 0.26 / 0.55
  // / 0.84 carrying values 0 / 0.428 / 0.727 / 1 — because everything the hard
  // terminator buys a fighter, it costs a stage. A backdrop with a committed
  // shadow shape competes with the roster for the eye, and the fighters have to
  // be the only things on screen carrying drawn linework and drawn shadow.
  //
  // A first pass here used the new hierarchy with `shadowLevel: 0.32` and
  // measured the cost: the mid floor lifted V32→42 but the receding floor
  // collapsed from S66/V29 to **S5/V15** — grey mud. Stage look belongs to
  // `art/stages` anyway, so this preset's job is to stay out of its way.
  stage: {
    bands: 4,
    sharpness: 0.55,
    toe: 0.55,
    coreDepth: 0.4727, // core edge lands on 0.26, the old terminator
    shadowLevel: 0.428,
    litLevel: 0.727,
    shoulder: 0.84,
    wrap: 0.08,
    specular: 0.08,
    specPower: 16,
    specThreshold: 0.34,
    specSoft: 0.2,
    sheen: 0.5,
    rim: 0.4,
    rimEdge: 0.42,
    rimShadow: 1,
    ambient: 0.7,
    lightTint: 0.7,
    terminatorNoise: 0.005,
    noiseScale: 6,
    exposureResponse: 0.8,
    outlineWidth: 0,
    shadowValue: 1.15,
    specTint: 0.21,
    // Barely any temperature work: a cool cast over the whole backdrop would
    // fight the stage's own art direction, and the guarantee only has to hold
    // strongly enough that the stage does not read *warmer* in shadow.
    skylight: 0.06,
    accentShadow: 0,
    minCool: 0.03,
    shadowLift: 0.06,
    // The stage's darkest band covers half the frame; at full strength the core
    // multiplier turned the receding floor into grey mud (S66/V29 -> S10/V16).
    coreTint: 0.3,
    aaClamp: 0.05,
  },
};

function preset(kind: SurfaceKind): KindPreset {
  return { ...BASE, ...KINDS[kind] };
}

/**
 * Every live NPR material — surfaces and ink alike — so stage-wide properties
 * can be pushed in one call. `outline.ts` registers into the same set, which is
 * why it holds the interface type rather than the class.
 */
const live = new Set<NPRMaterial>();

const vertexShader = /* glsl */ `
#define NPR

varying vec3 vViewPosition;
varying vec3 vObjPos;
varying vec2 vNprUv;
varying vec3 vAnisoT;

uniform vec3 uAnisoAxis;

#include <common>
#include <batching_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>

void main() {

  vNprUv = uv;
  // Rest-pose position. The brush breakup keys off it so the grain stays welded
  // to the body instead of swimming across it as the fighter moves.
  vObjPos = position;

  #include <morphinstance_vertex>
  #include <batching_vertex>

  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <normal_vertex>

  // The anisotropy axis rides the skeleton, or the sheen band on a braid slides
  // off it the moment the head turns.
  vec3 anisoAxis = uAnisoAxis;
  #ifdef USE_SKINNING
    anisoAxis = ( skinMatrix * vec4( anisoAxis, 0.0 ) ).xyz;
  #endif
  vAnisoT = normalMatrix * anisoAxis;

  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>

  vViewPosition = - mvPosition.xyz;

  #include <worldpos_vertex>
  #include <shadowmap_vertex>
  #include <fog_vertex>

}
`;

const fragmentShader = /* glsl */ `
#define NPR

uniform vec3 uColor;
uniform vec3 uShadowColor;
uniform vec3 uCoreTint;
uniform vec3 uSSSColor;
uniform vec3 uRimColor;
uniform vec3 uSpecColor;
uniform vec3 uSkyColor;
uniform float opacity;

uniform sampler2D uRamp;

uniform float uWrap;
uniform float uShadeGain;
uniform float uShadeBias;
uniform float uSpecular;
uniform float uSpecPower;
uniform float uSpecThreshold;
uniform float uSpecSoft;
uniform float uSpecHalo;
uniform float uSheen;
uniform float uAniso;
uniform float uAnisoShift;
uniform float uAnisoJitter;

uniform float uRimPower;
uniform float uRimSharp;
uniform float uRimEdge;
uniform float uRimSoft;
uniform float uRimDirectional;
uniform float uRimSpread;
uniform float uRimShadow;
uniform vec3  uRimDir;

uniform float uSSS;
uniform float uTranslucency;
uniform float uCurvature;
uniform float uTerminatorNoise;
uniform float uNoiseScale;
uniform float uAaClamp;
uniform float uShadowLift;
uniform float uAmbient;
uniform float uLightTint;
uniform float uLightReference;
uniform float uExposureResponse;
uniform float uSaturation;

uniform float uLightingScale;
uniform vec3  uFlashColor;
uniform float uFlash;
uniform vec3  uSilhouetteColor;
uniform float uSilhouette;

uniform vec2 uMapScale;
#ifdef NPR_MAP
  uniform sampler2D uMap;
#endif
#ifdef NPR_NORMALMAP
  uniform sampler2D uNormalMap;
  uniform float uNormalScale;
#endif

varying vec3 vViewPosition;
varying vec3 vObjPos;
varying vec2 vNprUv;
varying vec3 vAnisoT;

#include <common>
#include <dithering_pars_fragment>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <normal_pars_fragment>
#include <shadowmap_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>

float nprLum( const in vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

float nprHash( vec3 p ) {
  p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}

float nprNoise( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( mix( nprHash( i ), nprHash( i + vec3( 1, 0, 0 ) ), f.x ),
         mix( nprHash( i + vec3( 0, 1, 0 ) ), nprHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
    mix( mix( nprHash( i + vec3( 0, 0, 1 ) ), nprHash( i + vec3( 1, 0, 1 ) ), f.x ),
         mix( nprHash( i + vec3( 0, 1, 1 ) ), nprHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ),
    f.z );
}

#ifdef NPR_NORMALMAP
// Derivative tangent frame. Procedural meshes ship without tangent attributes
// and a detail normal map is not worth requiring them for.
mat3 nprTangentFrame( vec3 eyePos, vec3 n, vec2 uv ) {
  vec3 q0 = dFdx( eyePos );
  vec3 q1 = dFdy( eyePos );
  vec2 st0 = dFdx( uv );
  vec2 st1 = dFdy( uv );
  vec3 q1perp = cross( q1, n );
  vec3 q0perp = cross( n, q0 );
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max( dot( T, T ), dot( B, B ) );
  float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
  return mat3( T * scale, B * scale, n );
}
#endif

struct NPRSurface {
  float wrap;
  float specPower;
  float aniso;
  float anisoShift;
  vec3  anisoT;
};

void RE_Direct_NPR( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in NPRSurface material, inout ReflectedLight reflectedLight ) {

  // Every term is weighted by the light's own luminance so the brightest lamp
  // owns the shadow shape. Without this a fill and a rim each carve their own
  // terminator and the form dissolves into three competing edges.
  float w = nprLum( directLight.color );
  vec3 Lw = directLight.color * w;

  float ndl = dot( geometryNormal, directLight.direction );

  // Wrapped lambert. Carrying light past the geometric terminator is how an
  // artist keeps a shadow reading as a drawn shape rather than a hemisphere cut.
  float lit = saturate( ( ndl + material.wrap ) / ( 1.0 + material.wrap ) );

  reflectedLight.directDiffuse += Lw * lit;

  // Borrowed slot: the light actually arriving here, already attenuated by
  // shadow maps and falloff. Used for hue and for the exposure response.
  reflectedLight.indirectSpecular += Lw;

  vec3 H = normalize( directLight.direction + geometryViewDir );
  float ndh = saturate( dot( geometryNormal, H ) );
  float front = step( 0.0, ndl );

  float iso = pow( ndh, material.specPower );

  // Kajiya-Kay. A highlight banded across the strand direction rather than a
  // round lobe is the whole difference between hair and a balloon, and between
  // satin and plastic. Gated by N·H so the band cannot wrap onto the dark side.
  vec3 T = normalize( material.anisoT + geometryNormal * material.anisoShift );
  float tdh = dot( T, H );
  float sinTH = sqrt( max( 1.0 - tdh * tdh, 0.0 ) );
  float band = pow( sinTH, material.specPower * 2.0 ) * pow( ndh, 3.0 );

  reflectedLight.directSpecular += Lw * mix( iso, band, material.aniso ) * front;

}

void RE_IndirectDiffuse_NPR( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in NPRSurface material, inout ReflectedLight reflectedLight ) {

  reflectedLight.indirectDiffuse += irradiance;

}

#define RE_Direct           RE_Direct_NPR
#define RE_IndirectDiffuse  RE_IndirectDiffuse_NPR

void main() {

  #include <clipping_planes_fragment>
  #include <logdepthbuf_fragment>

  vec2 uv = vNprUv * uMapScale;
  float grain = nprNoise( vObjPos * uNoiseScale );

  vec3 base = uColor;
  vec3 shadowBase = uShadowColor;

  #ifdef NPR_MAP
    vec3 detail = texture2D( uMap, uv ).rgb;
    base *= detail;
    // Pattern simplifies in shadow. A painter does not carry weave contrast into
    // the dark side; carrying it there flattens the form.
    shadowBase *= mix( vec3( 1.0 ), detail, 0.7 );
  #endif

  #include <normal_fragment_begin>

  #ifdef NPR_NORMALMAP
    mat3 tbn = nprTangentFrame( - vViewPosition, normal, uv );
    vec3 mapN = texture2D( uNormalMap, uv ).xyz * 2.0 - 1.0;
    mapN.xy *= uNormalScale;
    normal = normalize( tbn * mapN );
  #endif

  ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );

  NPRSurface material;
  material.wrap = uWrap;
  material.specPower = uSpecPower;
  material.aniso = uAniso;
  material.anisoShift = uAnisoShift + ( grain - 0.5 ) * uAnisoJitter;
  material.anisoT = normalize( vAnisoT );

  #include <lights_fragment_begin>
  #include <lights_fragment_maps>
  #include <lights_fragment_end>

  vec3 totalLight = reflectedLight.indirectSpecular;
  float totalLum = nprLum( totalLight );
  float reference = max( uLightReference, 1e-4 );

  // Normalising against the *un-shadowed* rig, not against what happens to
  // arrive, is what makes a cast shadow actually land in the shadow band
  // instead of the fill and rim silently filling it back in.
  float shade = nprLum( reflectedLight.directDiffuse ) / reference;
  // Faded out when there is barely any direct light, or an ambient-only stage
  // would tint every costume toward a hue derived from nothing.
  float hueTrust = uLightTint * smoothstep( 0.0, 0.02, totalLum );
  vec3 lightHue = mix( vec3( 1.0 ), totalLight / max( totalLum, 1e-4 ), hueTrust );

  // Creases carry their own occlusion. A quilted panel that does not shadow
  // itself at the seams reads as a printed pattern, not as padding.
  float crease = saturate( ( 1.0 - dot( normal, nonPerturbedNormal ) ) * 3.5 );
  shade -= crease * uCurvature;

  // Nobody draws a mathematically smooth terminator. A little breakup on the
  // ramp coordinate is the cheapest brush in the box.
  shade += ( grain - 0.5 ) * uTerminatorNoise;
  shade = clamp( ( shade + uShadeBias ) * uShadeGain, 0.0, 1.0 );

  // Three taps, spanning exactly one screen pixel of the ramp coordinate. MSAA
  // cannot antialias an edge that exists only inside the shader, and a
  // stair-stepped terminator is the loudest possible tell that this is a 3D
  // render — but the clamp matters as much as the filter. It used to be 0.12,
  // roughly fifty times the width of the baked razor edge, so wherever the
  // derivative was large (normal-map creases, near-tangent surfaces, the noise on
  // the ramp coordinate) the three taps became a box blur and the terminator came
  // out as a gradient. uAaClamp is now a per-surface budget of a hundredth of
  // the ramp, which is a couple of pixels of softness and no more.
  float aa = min( fwidth( shade ) * 0.5, uAaClamp );
  vec4 ramp = texture2D( uRamp, vec2( shade, 0.5 ) ) * 0.5
            + texture2D( uRamp, vec2( clamp( shade - aa, 0.0, 1.0 ), 0.5 ) ) * 0.25
            + texture2D( uRamp, vec2( clamp( shade + aa, 0.0, 1.0 ), 0.5 ) ) * 0.25;

  vec3 col = mix( shadowBase, base, ramp.r );

  // The shadow band sits in skylight, and until now nothing in this shader said
  // so. Three's light loop has no "light on the dark side" concept — what arrives
  // there is whatever non-key lamps exist, and on this rig that is a warm rim
  // beating the cool fill 4.5:1 on luminance². So the terminator was a step in
  // value only, and the measured shadow came out the same temperature as the lit
  // side on all four fighters.
  //
  // Applied at constant luminance so it rotates temperature without touching the
  // value band, and gated on the *banded* shade so it lands as part of the shadow
  // shape rather than as a smooth gradient of its own.
  float skyLum = max( nprLum( uSkyColor ), 1e-4 );
  vec3 skyAtValue = uSkyColor * ( nprLum( col ) / skyLum );
  col = mix( col, skyAtValue, ( 1.0 - ramp.r ) * uShadowLift );

  // The core keeps losing red as it deepens, because down there bounced sky is
  // the only light left.
  col *= mix( vec3( 1.0 ), uCoreTint, ramp.b );

  // Subsurface: light that entered on the lit side and left through the
  // terminator — precisely where a painter lays the warm line on skin.
  //
  // Gated by the *unbanded* curve as well as by terminator proximity, so the warm
  // bleed can only sit on the light's side of the edge. Without that gate this
  // term is a hot red wash across the whole shadow band, and it was one of the
  // four warm pushes that cancelled the intended cooling.
  col += uSSSColor * ramp.g * ramp.a * uSSS * ( 0.35 + 0.65 * nprLum( base ) );

  vec3 rimDirView = normalize( ( viewMatrix * vec4( uRimDir, 0.0 ) ).xyz );

  // Tape and thin fabric glow where the backlight passes through them.
  float thru = saturate( dot( normal, rimDirView ) ) * ( 1.0 - ramp.a ) * uTranslucency;
  col += uSSSColor * thru;

  // Ambient as a multiplicative lift, so the hemisphere's sky and ground
  // colours tint the shadow without dissolving the band structure — and
  // stepped on the same ramp, because a smooth sky-to-ground gradient sitting
  // on top of hard bands is the last continuous shading left in the frame and
  // the eye reads it immediately as "3D render".
  vec3 viewUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  float ambBand = texture2D( uRamp, vec2( saturate( dot( normal, viewUp ) * 0.5 + 0.5 ), 0.5 ) ).r;
  col *= vec3( 1.0 ) + reflectedLight.indirectDiffuse * uAmbient * ( 0.45 + 1.15 * ambBand );
  col *= lightHue;

  // Two hard steps, not a lobe.
  //
  // The intent here was always "a hot core sitting inside a softer shape", but
  // the numbers did not deliver it: the outer step sat at 0.28 of the core's
  // threshold and was smoothed over 1.8x the core's width, so the two merged into
  // one broad falloff. Round soft gaussian, in other words — the two white
  // circles the review found on Mali's pec, the gloss down Davi's forearm.
  //
  // Now both steps are hard and antialiased against their own screen derivative,
  // and uSpecHalo keeps the outer one close enough to the core to stay a
  // distinct concentric shape. Skin passes uSpecular = 0 and skips it entirely.
  float spec = nprLum( reflectedLight.directSpecular ) / reference;
  float specAa = min( fwidth( spec ) * 0.5, uSpecSoft );
  float core = smoothstep( uSpecThreshold - specAa, uSpecThreshold + specAa, spec );
  float haloEdge = uSpecThreshold * uSpecHalo;
  float halo = smoothstep( haloEdge - specAa, haloEdge + specAa, spec );
  col += uSpecColor * ( core + halo * uSheen ) * uSpecular * mix( 0.1, 1.0, ramp.a );

  // Rim, gated by where the rim light actually is. A uniform Fresnel halo is the
  // cheapest-looking effect in real-time NPR and reads instantly as a shortcut;
  // this one terminates on the side the light is not, the way a drawn highlight
  // does.
  //
  // The shadow-side weight was 1.3 against 0.7 on the lit side — the rim was
  // nearly twice as bright where the light was *not*. Combined with a warm rim
  // colour that is 1.86x brighter in shadow, and that single line accounted for
  // most of the frame's missing temperature separation. It is now below 1: a rim
  // is a light, and it cannot be brighter where the light is not reaching.
  vec3 V = normalize( vViewPosition );
  float fres = pow( 1.0 - saturate( dot( normal, V ) ), uRimSharp );
  float dirMask = smoothstep( uRimSpread, 1.0, dot( normal, rimDirView ) );
  float rim = fres * mix( 1.0, dirMask, uRimDirectional ) * mix( uRimShadow, 1.0, ramp.a );
  rim = smoothstep( uRimEdge - uRimSoft, uRimEdge + uRimSoft, rim );
  col += uRimColor * rim * uRimPower;

  // A dark stage should dim the fighters, but only partway: losing them into
  // the backdrop during a super is worse than being physically wrong.
  col *= mix( 1.0, saturate( sqrt( totalLum / reference ) ), uExposureResponse );
  col *= uLightingScale;

  // Chroma is expanded ahead of tone mapping because ACES desaturates as it
  // rolls off, and this palette sits right where it would eat it.
  col = max( mix( vec3( nprLum( col ) ), col, uSaturation ), vec3( 0.0 ) );

  // Per-channel soft shoulder, applied to the *peak* channel and scaled into the
  // other two so the hue survives.
  //
  // ACES rolls luminance off gracefully, but a single channel can still pin long
  // before the luminance does, and the bloom chain downstream then amplifies
  // whatever it is handed. Measured on the shipping frame, Mali clipped 6.84% of
  // her skin pixels to (255,160,57) — flat orange with the form gone out of it —
  // while the same scene captured with ?post=0 clipped 0.00%. So the material
  // was delivering a channel close enough to 1.0 that post could finish the job.
  // Rolling the peak asymptotically toward 1.0 here means it cannot, at any
  // exposure, for any palette.
  float peak = max( max( col.r, col.g ), col.b );
  float knee = 0.86;
  if ( peak > knee ) {
    float over = peak - knee;
    float rolled = knee + over / ( 1.0 + over / max( 1.0 - knee, 1e-3 ) );
    col *= rolled / peak;
  }

  gl_FragColor = vec4( col, opacity );

  #include <tonemapping_fragment>

  // Hit flash and the impact-frame white-out land *after* tone mapping. They are
  // absolute screen values, not light: ACES rolls 1.0 back to about 0.85, and an
  // impact frame that whites out to grey is not an impact frame.
  gl_FragColor.rgb = mix( gl_FragColor.rgb, uFlashColor, uFlash );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, uSilhouetteColor, uSilhouette );

  #include <colorspace_fragment>
  #include <fog_fragment>
  #include <dithering_fragment>

}
`;

/** Scene most recently measured by `calibrateNpr`, for the auto path. */
let calibratedScene: THREE.Object3D | null = null;

const _hslA = { h: 0, s: 0, l: 0 };
const _hslB = { h: 0, s: 0, l: 0 };

/**
 * Rewrites `seed`'s lightness to `ref`'s, keeping its hue and chroma.
 *
 * Used so an authored shadow hex can act as a *hue seed* without also dictating
 * value. The roster's shadow hexes are already darkened, and letting them keep
 * that darkening means `coolShadow`'s value drop applies twice — which is how
 * Davi's shadow ended up at V18 while Vera's sat at V39.
 */
function matchLightness(seed: THREE.Color, ref: THREE.Color): THREE.Color {
  ref.getHSL(_hslA, THREE.SRGBColorSpace);
  seed.getHSL(_hslB, THREE.SRGBColorSpace);
  return seed.setHSL(_hslB.h, _hslB.s, _hslA.l, THREE.SRGBColorSpace);
}

/**
 * The whole shadow-colour pipeline in one place, so `setShadowAccent` re-derives
 * through exactly the same path the constructor used.
 */
function deriveShadow(
  lit: THREE.Color,
  seed: THREE.Color,
  p: KindPreset,
  accent: THREE.Color | null,
  accentAmount: number,
): THREE.Color {
  const shadow = coolShadow(seed, {
    shift: 0.24 * p.shadowShift,
    value: 0.44 * p.shadowValue,
    skylight: p.skylight,
    skyColor: NPR_TUNING.skyColor,
    accent,
    accentAmount,
    minCool: p.minCool,
  });
  // `coolShadow` already guarantees the temperature drop against `seed`, which
  // shares `lit`'s lightness by construction. The band clamp only moves value and
  // compresses chroma, so it cannot reintroduce warmth — but assert it anyway,
  // because "the documentation says it cools" is exactly what review 001 caught.
  const banded = p.shadowBand ? fitValueBand(shadow, p.shadowBand) : shadow;
  return warmth(banded) <= warmth(lit) - p.minCool * 0.5 ? banded : shadow;
}

export class ToonMaterial extends THREE.ShaderMaterial implements NPRMaterial {
  readonly kind: SurfaceKind;
  /** Suggested ink weight for this surface, consumed by `createOutlineMesh`. */
  readonly outlineWidth: number;
  /** Suggested ink colour for this surface. */
  readonly outlineColor: THREE.Color;
  /**
   * Whether this material was authored for a `SkinnedMesh`. Three derives the
   * skinning defines from the mesh itself, so this is a declaration of intent
   * that the outline builder and tooling read back rather than a switch.
   */
  readonly skinned: boolean;

  /** Preset this surface was built from, so the shadow can be re-derived later. */
  private readonly p: KindPreset;
  /** Lit albedo after value-band compression — the input to every re-derivation. */
  private readonly litColor: THREE.Color;
  /** Hue seed for the shadow: the caller's `shadowColor`, or the albedo. */
  private readonly shadowSeed: THREE.Color;
  private accent: THREE.Color | null = null;
  private accentAmount: number;

  constructor(opts: ToonMaterialOptions) {
    const p = preset(opts.kind);

    // Value-band control, defect 4. Compressive, so a fighter whose albedo sits
    // outside the band keeps its ordering against the others rather than being
    // flattened onto the band edge.
    const color = p.litBand ? fitValueBand(opts.color, p.litBand) : new THREE.Color(opts.color);

    // `shadowColor` is documented as the colour the shadow band *trends toward*,
    // and it is now treated that way rather than used verbatim.
    //
    // This is the fix for review 001's first finding. `rig.ts` passes the
    // roster's authored `skinShadow` hex, and every one of those hexes is the lit
    // tone darkened: 0xc2793f -> 0x8a4d26 measures 3° *warmer*, and all four
    // authored pairs score higher `warmth` in shadow than in light (+0.153,
    // +0.108, +0.108, +0.096). Passing one straight through meant `coolShadow`
    // never ran on skin at all, which is why the module's documented hue rotation
    // was nowhere in the pixels.
    //
    // The hex still decides the shadow's hue identity — that is per-fighter data
    // worth keeping — but it is first matched back to the lit albedo's lightness
    // so `coolShadow` applies its value drop once rather than on top of an
    // already-darkened swatch, and then conditioned for temperature.
    const seed = opts.shadowColor ? matchLightness(new THREE.Color(opts.shadowColor), color) : color.clone();
    const accentAmount = p.accentShadow;
    const shadow = deriveShadow(color, seed, p, null, accentAmount);

    // The highlight takes its colour from the surface it sits on, pulled toward
    // white by the surface's glossiness. A white highlight on everything is what
    // makes a toon render look like moulded vinyl.
    const spec = color.clone().lerp(new THREE.Color(0xffffff), 0.18 + p.specTint * 0.8);
    const sss = opts.sssColor ? new THREE.Color(opts.sssColor) : color.clone().offsetHSL(-0.02, 0.25, -0.06);

    super({
      lights: true,
      fog: true,
      vertexShader,
      fragmentShader,
      transparent: opts.transparent ?? false,
      side: opts.side ?? THREE.FrontSide,
      defines: {
        ...(opts.map ? { NPR_MAP: '' } : {}),
        ...(opts.normalMap ? { NPR_NORMALMAP: '' } : {}),
      },
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.lights,
        THREE.UniformsLib.fog,
        {
          uColor: { value: color },
          uShadowColor: { value: shadow },
          uCoreTint: { value: coreShadowTint(shadow, p.coreTint) },
          uSSSColor: { value: sss },
          uRimColor: { value: new THREE.Color(opts.rimColor ?? 0xffd3a8) },
          uSpecColor: { value: spec },
          uSkyColor: { value: NPR_TUNING.skyColor.clone() },
          opacity: { value: 1 },

          uRamp: { value: null },

          uWrap: { value: p.wrap },
          uShadeGain: { value: p.shadeGain },
          uShadeBias: { value: p.shadeBias },
          uSpecular: { value: opts.specular ?? p.specular },
          uSpecPower: { value: p.specPower },
          uSpecThreshold: { value: p.specThreshold },
          uSpecSoft: { value: p.specSoft },
          uSpecHalo: { value: p.specHalo },
          uSheen: { value: p.sheen },
          uAniso: { value: p.aniso },
          uAnisoAxis: { value: p.anisoAxis.clone() },
          uAnisoShift: { value: p.anisoShift },
          uAnisoJitter: { value: p.anisoJitter },

          uRimPower: { value: (opts.rimPower ?? 1) * p.rim },
          uRimSharp: { value: p.rimSharp },
          uRimEdge: { value: p.rimEdge },
          uRimSoft: { value: p.rimSoft },
          uRimDirectional: { value: p.rimDirectional },
          uRimSpread: { value: p.rimSpread },
          uRimShadow: { value: p.rimShadow },
          uRimDir: { value: NPR_TUNING.rimDirection.clone() },

          uSSS: { value: p.sss },
          uTranslucency: { value: p.translucency },
          uCurvature: { value: p.curvature },
          uTerminatorNoise: { value: p.terminatorNoise },
          uNoiseScale: { value: p.noiseScale },
          uAaClamp: { value: p.aaClamp },
          uShadowLift: { value: p.shadowLift },
          uAmbient: { value: p.ambient },
          uLightTint: { value: p.lightTint },
          uLightReference: { value: NPR_TUNING.lightReference },
          uExposureResponse: { value: p.exposureResponse },
          uSaturation: { value: NPR_TUNING.saturation },

          uLightingScale: { value: 1 },
          uFlashColor: { value: new THREE.Color(0xffffff) },
          uFlash: { value: 0 },
          uSilhouetteColor: { value: new THREE.Color(0xffffff) },
          uSilhouette: { value: 0 },

          uMapScale: { value: new THREE.Vector2(1, 1) },
          uMap: { value: null },
          uNormalMap: { value: null },
          uNormalScale: { value: opts.normalScale ?? 1 },
        },
      ]),
    });

    this.type = 'ToonMaterial';
    this.kind = opts.kind;
    this.skinned = opts.skinned ?? false;
    this.p = p;
    this.litColor = color;
    this.shadowSeed = seed;
    this.accentAmount = accentAmount;

    // `UniformsUtils.merge` deep-copies, so textures have to be attached after
    // construction — a cloned sampler would point at nothing.
    this.uniforms.uRamp.value = bandRamp({
      bands: opts.bands ?? p.bands,
      sharpness: opts.bandSharpness ?? p.sharpness,
      toe: p.toe,
      shoulder: p.shoulder,
      terminatorWidth: p.terminatorWidth,
      core: p.coreDepth,
      shadowLevel: p.shadowLevel,
      litLevel: p.litLevel,
    });
    this.uniforms.uMap.value = opts.map ?? null;
    this.uniforms.uNormalMap.value = opts.normalMap ?? null;

    this.outlineWidth = (opts.outlineWidth ?? 1) * p.outlineWidth;
    this.outlineColor = opts.outlineColor ? new THREE.Color(opts.outlineColor) : inkColor(color);

    live.add(this);
  }

  // --- per-frame gameplay hooks -------------------------------------------
  // All three are single uniform writes. They run on every fighter every frame
  // during hitstop and super flashes, so they must never touch a define or the
  // whole roster stalls on a shader recompile mid-combo.

  setFlash(color: THREE.ColorRepresentation, amount: number): void {
    (this.uniforms.uFlashColor.value as THREE.Color).set(color);
    this.uniforms.uFlash.value = amount;
  }

  setLightingScale(scale: number): void {
    this.uniforms.uLightingScale.value = scale;
  }

  setSilhouette(color: THREE.ColorRepresentation, amount: number): void {
    (this.uniforms.uSilhouetteColor.value as THREE.Color).set(color);
    this.uniforms.uSilhouette.value = amount;
  }

  /** World-space direction *toward* the rim light. Owned by the stage. */
  setRimDirection(dir: THREE.Vector3): void {
    (this.uniforms.uRimDir.value as THREE.Vector3).copy(dir).normalize();
  }

  /**
   * Pushes a fighter's accent colour into their shadow tint.
   *
   * Review 001 calls this "the cheapest win being deferred" on colour identity,
   * and the measurements back it: the roster's four skin albedos span 16° of Lab
   * hue with Kai and Vera only 4° apart, so the *lit* side cannot carry four
   * distinguishable identities no matter what this shader does. The shadow can —
   * it is a third of the body area and nothing else is competing for it.
   *
   * Pass `palette.energy`, which is the one genuinely distinctive per-fighter
   * colour in the roster data (Vera orange, Mali red, Davi and Kai two blues).
   * The accent is mixed at constant lightness, and `coolShadow`'s measured
   * guarantee still runs afterwards, so pushing a *warm* accent in cannot make a
   * shadow warmer than its lit side — it lands as hue identity within a shadow
   * that is still cooler.
   *
   * Wiring is one line in the character builder, next to the `createToonMaterial`
   * call that already passes the palette:
   *
   *     (skinMaterial as ToonMaterial).setShadowAccent(p.energy);
   *
   * A uniform write plus a little colour maths — no recompile, so it is also safe
   * to call per round for a palette swap.
   */
  setShadowAccent(color: THREE.ColorRepresentation | null, amount?: number): void {
    this.accent = color == null ? null : new THREE.Color(color);
    if (amount !== undefined) this.accentAmount = THREE.MathUtils.clamp(amount, 0, 1);
    const shadow = deriveShadow(this.litColor, this.shadowSeed.clone(), this.p, this.accent, this.accentAmount);
    (this.uniforms.uShadowColor.value as THREE.Color).copy(shadow);
    (this.uniforms.uCoreTint.value as THREE.Color).copy(coreShadowTint(shadow, this.p.coreTint));
  }

  /** Colour of the sky this surface's shadow band is tinted toward. */
  setSkyColor(color: THREE.ColorRepresentation): void {
    (this.uniforms.uSkyColor.value as THREE.Color).set(color);
  }

  /** Swap the generated albedo/detail map. Recompiles only if the slot changes. */
  setMap(map: THREE.Texture | null): void {
    const had = this.defines.NPR_MAP !== undefined;
    this.uniforms.uMap.value = map;
    if (!!map === had) return;
    if (map) this.defines.NPR_MAP = '';
    else delete this.defines.NPR_MAP;
    this.needsUpdate = true;
  }

  setNormalMap(map: THREE.Texture | null, scale?: number): void {
    const had = this.defines.NPR_NORMALMAP !== undefined;
    this.uniforms.uNormalMap.value = map;
    if (scale !== undefined) this.uniforms.uNormalScale.value = scale;
    if (!!map === had) return;
    if (map) this.defines.NPR_NORMALMAP = '';
    else delete this.defines.NPR_NORMALMAP;
    this.needsUpdate = true;
  }

  /** Tiling for the generated maps, in UV repeats. */
  setMapScale(x: number, y: number): void {
    (this.uniforms.uMapScale.value as THREE.Vector2).set(x, y);
  }

  setOpacity(value: number): void {
    this.opacity = value;
    this.uniforms.opacity.value = value;
  }

  /** Live base colour — mutate in place for palette swaps and damage tinting. */
  get baseColor(): THREE.Color {
    return this.uniforms.uColor.value as THREE.Color;
  }

  get shadowColor(): THREE.Color {
    return this.uniforms.uShadowColor.value as THREE.Color;
  }

  override onBeforeRender(
    _renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    _camera: THREE.Camera,
    _geometry: THREE.BufferGeometry,
    _object: THREE.Object3D,
    _group: THREE.Group,
  ): void {
    // The shading model needs to know how bright the rig is with nothing
    // shadowed. Measuring it once per scene keeps stages that never call
    // `calibrateNpr` looking correct anyway.
    if (NPR_TUNING.autoCalibrate && scene !== calibratedScene) calibrateNpr(scene);
  }

  override dispose(): void {
    live.delete(this);
    super.dispose();
  }
}

/** Implements `CreateToonMaterial` from the contract. */
export function createToonMaterial(opts: ToonMaterialOptions): NPRMaterial {
  return new ToonMaterial(opts);
}

const _lum = new THREE.Color();

function lightWeight(light: THREE.Light): number {
  const c = _lum.copy(light.color).multiplyScalar(light.intensity);
  let lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  // Point and spot lights are measured at a nominal fighting distance, since
  // their contribution to the shading coordinate is dominated by falloff.
  const anyLight = light as THREE.PointLight & THREE.SpotLight;
  if ((light as THREE.PointLight).isPointLight || (light as THREE.SpotLight).isSpotLight) {
    const d = NPR_TUNING.calibrationDistance;
    lum /= Math.max(Math.pow(d, anyLight.decay ?? 2), 0.01);
    if (anyLight.distance > 0) {
      const t = Math.max(1 - Math.pow(d / anyLight.distance, 4), 0);
      lum *= t * t;
    }
  }
  return lum;
}

/**
 * Measures a light rig and stores the reference the shading coordinate divides
 * by. Call after building or re-lighting a stage; `onBeforeRender` also runs it
 * automatically the first time a scene is drawn.
 *
 * The sum is of *squared* luminances because `RE_Direct` weights each light by
 * its own luminance — the reference has to be in the same units as the
 * accumulator or shadows land in the wrong band.
 */
export function calibrateNpr(root: THREE.Object3D): number {
  let total = 0;
  root.traverse((o) => {
    const l = o as THREE.Light;
    if (!l.isLight) return;
    // Ambient and hemisphere feed the indirect term, not the ramp coordinate.
    if ((l as THREE.AmbientLight).isAmbientLight || (l as THREE.HemisphereLight).isHemisphereLight) return;
    const w = lightWeight(l);
    total += w * w;
  });

  if (total > 1e-5) {
    NPR_TUNING.lightReference = total;
    for (const m of live) {
      if (m instanceof ToonMaterial) m.uniforms.uLightReference.value = total;
    }
  }
  calibratedScene = root;
  return NPR_TUNING.lightReference;
}

/**
 * Points every live surface at a new rim light.
 *
 * The rim is a *stage* property — it is the light that separates the fighters
 * from the backdrop, and it moves when the stage does.
 */
export function setNprRimDirection(dir: THREE.Vector3): void {
  NPR_TUNING.rimDirection.copy(dir).normalize();
  for (const m of live) {
    if (m instanceof ToonMaterial) m.setRimDirection(NPR_TUNING.rimDirection);
  }
}

/**
 * Points every live surface at a new sky colour — the colour its shadow band is
 * tinted toward.
 *
 * Like the rim, this is a *stage* property: it is the ambient the shadows sit in,
 * and a sunset stage and a strip-lit gym owe their fighters different shadows.
 * Only the in-shader tint follows; each material's own shadow colour was derived
 * at construction, so a stage that wants the CPU term too should set
 * `NPR_TUNING.skyColor` before building its characters.
 */
export function setNprSkyColor(color: THREE.ColorRepresentation): void {
  NPR_TUNING.skyColor.set(color);
  for (const m of live) {
    if (m instanceof ToonMaterial) m.setSkyColor(NPR_TUNING.skyColor);
  }
}

/**
 * Chroma expansion applied before tone mapping, across every surface.
 *
 * Exposed because it is the one knob a critic loop reaches for first: ACES eats
 * saturation as it rolls off, and how much to pre-compensate depends on the
 * stage's exposure.
 */
export function setNprSaturation(value: number): void {
  NPR_TUNING.saturation = value;
  for (const m of live) {
    if (m instanceof ToonMaterial) m.uniforms.uSaturation.value = value;
  }
}

/** Dims or lifts every NPR surface at once — super freezes, round fades. */
export function setNprLightingScale(scale: number): void {
  for (const m of live) m.setLightingScale(scale);
}

/** All materials currently alive. Iterate to drive roster-wide effects. */
export function nprMaterials(): ReadonlySet<NPRMaterial> {
  return live;
}

/** Join the roster-wide registry. Used by `outline.ts`; surfaces self-register. */
export function registerNprMaterial(material: NPRMaterial): void {
  live.add(material);
}

export function unregisterNprMaterial(material: NPRMaterial): void {
  live.delete(material);
}
