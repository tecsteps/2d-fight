import * as THREE from 'three';
import type { NPRMaterial, SurfaceKind, ToonMaterialOptions } from './contract';
import { bandRamp, coolShadow, coreShadowTint, inkColor } from './ramps';

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
}

const BASE: KindPreset = {
  bands: 3,
  sharpness: 0.88,
  toe: 0.34,
  shoulder: 0.78,
  terminatorWidth: 0.09,
  wrap: 0.1,
  shadeGain: 1.08,
  shadeBias: -0.02,
  specular: 0.14,
  specPower: 28,
  specThreshold: 0.26,
  specSoft: 0.05,
  sheen: 0.45,
  aniso: 0,
  anisoAxis: new THREE.Vector3(0, 1, 0),
  anisoShift: 0,
  anisoJitter: 0,
  rim: 1.15,
  rimSharp: 1.2,
  rimEdge: 0.33,
  rimSoft: 0.09,
  rimDirectional: 0.9,
  rimSpread: -0.25,
  sss: 0,
  translucency: 0,
  curvature: 0,
  terminatorNoise: 0.012,
  noiseScale: 22,
  ambient: 0.5,
  lightTint: 0.35,
  exposureResponse: 0.55,
  outlineWidth: 1,
  shadowShift: 1,
  shadowValue: 1,
  specTint: 0.35,
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
  // Flesh: soft terminator, warm bleed through it, no hard highlight except on
  // sweat. The wrap is high because a limb is a cylinder, and a hard N·L
  // terminator on a cylinder always looks like a rendered cylinder.
  skin: {
    // Four tones, because that is what a KOF character sheet actually uses on
    // flesh: highlight, base, shadow, and a narrow core under the form.
    bands: 4,
    sharpness: 0.86,
    toe: 0.34,
    shoulder: 0.74,
    terminatorWidth: 0.07,
    wrap: 0.24,
    specular: 0.17,
    specPower: 100,
    specThreshold: 0.2,
    specSoft: 0.035,
    sheen: 0.45,
    sss: 0.46,
    rim: 1.2,
    rimSharp: 1.15,
    terminatorNoise: 0.011,
    noiseScale: 26,
    lightTint: 0.3,
    outlineWidth: 0.9,
    shadowShift: 0.5, // flesh shadow goes plum, not blue — blood, not skylight
    specTint: 0.55,
  },

  // Hair reads as a solid shape with one banded highlight travelling round it.
  // Two bands only: anime hair has a light side and a dark side, full stop.
  hair: {
    bands: 2,
    sharpness: 0.97,
    toe: 0.44,
    wrap: 0.08,
    specular: 0.75,
    specPower: 58,
    specThreshold: 0.16,
    specSoft: 0.025,
    sheen: 0.3,
    aniso: 1,
    anisoShift: 0.06,
    anisoJitter: 0.1,
    rim: 1.3,
    rimSharp: 1.05,
    rimEdge: 0.3,
    terminatorNoise: 0.012,
    noiseScale: 52,
    ambient: 0.4,
    outlineWidth: 1.25,
    specTint: 0.34,
  },

  // Matte fabric. The whole read is the shadow *shape*, so the edges are crisp
  // and the highlight is a wash with no hard core at all.
  cloth: {
    bands: 3,
    sharpness: 0.91,
    wrap: 0.06,
    specular: 0.05,
    specPower: 22,
    specThreshold: 0.24,
    specSoft: 0.09,
    sheen: 0.6,
    rim: 0.85,
    terminatorNoise: 0.014,
    noiseScale: 30,
    outlineWidth: 1.1,
    specTint: 0.15,
  },

  // Padding. Four bands so each puff carries its own gradient, and real
  // self-shadowing at the seams — a quilted vest that does not shadow itself
  // reads as printed cloth rather than as something with air inside it.
  quilted: {
    bands: 4,
    sharpness: 0.82,
    toe: 0.3,
    shoulder: 0.82,
    wrap: 0.12,
    shadeGain: 1.16,
    specular: 0.09,
    specPower: 26,
    specThreshold: 0.24,
    specSoft: 0.06,
    sheen: 0.45,
    curvature: 0.6,
    rim: 0.95,
    terminatorNoise: 0.013,
    noiseScale: 16,
    outlineWidth: 1.2,
    specTint: 0.21,
  },

  // Muay thai shorts: a sharp anisotropic glint banded across the drape over a
  // near-black base. That glint is most of what makes satin read as satin.
  satin: {
    bands: 3,
    sharpness: 0.94,
    toe: 0.3,
    wrap: 0.03,
    specular: 0.95,
    specPower: 150,
    specThreshold: 0.12,
    specSoft: 0.02,
    sheen: 0.34,
    aniso: 0.9,
    anisoShift: 0.02,
    rim: 1.1,
    rimEdge: 0.3,
    ambient: 0.72,
    terminatorNoise: 0.008,
    specTint: 0.46,
  },

  leather: {
    bands: 3,
    sharpness: 0.91,
    wrap: 0.05,
    specular: 0.46,
    specPower: 90,
    specThreshold: 0.18,
    specSoft: 0.028,
    sheen: 0.32,
    rim: 0.95,
    terminatorNoise: 0.01,
    noiseScale: 34,
    outlineWidth: 1.15,
    specTint: 0.3,
  },

  // Tape over knuckles: thin enough that light comes through from behind, and
  // the weave scatters enough that the terminator is very soft.
  wrap: {
    bands: 3,
    sharpness: 0.84,
    toe: 0.4,
    wrap: 0.34,
    specular: 0.07,
    specPower: 24,
    specThreshold: 0.26,
    specSoft: 0.1,
    sheen: 0.5,
    sss: 0.24,
    translucency: 0.4,
    rim: 0.9,
    terminatorNoise: 0.013,
    noiseScale: 46,
    ambient: 0.6,
    outlineWidth: 0.85,
    specTint: 0.27,
  },

  metal: {
    bands: 2,
    sharpness: 0.98,
    toe: 0.42,
    wrap: 0,
    specular: 1,
    specPower: 190,
    specThreshold: 0.1,
    specSoft: 0.015,
    sheen: 0.18,
    rim: 1.4,
    rimSharp: 0.95,
    rimEdge: 0.3,
    ambient: 0.35,
    lightTint: 0.6,
    terminatorNoise: 0.004,
    specTint: 0.9,
  },

  // Stages are lit, not drawn: more bands, softer edges, weak rim, no ink. The
  // fighters must be the only things on screen with hard linework and hard
  // shadow shapes, or the eye stops finding them instantly.
  stage: {
    bands: 4,
    sharpness: 0.55,
    toe: 0.26,
    shoulder: 0.84,
    wrap: 0.08,
    specular: 0.08,
    specPower: 16,
    specThreshold: 0.34,
    specSoft: 0.2,
    sheen: 0.5,
    rim: 0.4,
    rimEdge: 0.42,
    ambient: 0.7,
    lightTint: 0.7,
    terminatorNoise: 0.005,
    noiseScale: 6,
    exposureResponse: 0.8,
    outlineWidth: 0,
    shadowValue: 1.15,
    specTint: 0.21,
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
uniform float opacity;

uniform sampler2D uRamp;

uniform float uWrap;
uniform float uShadeGain;
uniform float uShadeBias;
uniform float uSpecular;
uniform float uSpecPower;
uniform float uSpecThreshold;
uniform float uSpecSoft;
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
uniform vec3  uRimDir;

uniform float uSSS;
uniform float uTranslucency;
uniform float uCurvature;
uniform float uTerminatorNoise;
uniform float uNoiseScale;
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

  // Three taps a screen-pixel apart. MSAA cannot antialias an edge that exists
  // only inside the shader, and a stair-stepped terminator is the loudest
  // possible tell that this is a 3D render.
  float aa = min( fwidth( shade ) * 0.6, 0.12 );
  vec4 ramp = texture2D( uRamp, vec2( shade, 0.5 ) ) * 0.5
            + texture2D( uRamp, vec2( clamp( shade - aa, 0.0, 1.0 ), 0.5 ) ) * 0.25
            + texture2D( uRamp, vec2( clamp( shade + aa, 0.0, 1.0 ), 0.5 ) ) * 0.25;

  vec3 col = mix( shadowBase, base, ramp.r );

  // The core keeps losing red as it deepens, because down there bounced sky is
  // the only light left.
  col *= mix( vec3( 1.0 ), uCoreTint, ramp.b );

  // Subsurface: light that entered on the lit side and left through the
  // terminator — precisely where a painter lays the warm line on skin.
  col += uSSSColor * ramp.g * uSSS * ( 0.35 + 0.65 * nprLum( base ) );

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

  // Two hard steps, not a lobe. An anime highlight is drawn as a hot core
  // sitting inside a softer shape; one smooth Blinn falloff is a mirror, and a
  // single step on its own is a decal.
  float spec = nprLum( reflectedLight.directSpecular ) / reference;
  float core = smoothstep( uSpecThreshold, uSpecThreshold + uSpecSoft, spec );
  float halo = smoothstep( uSpecThreshold * 0.28, uSpecThreshold * 0.28 + uSpecSoft * 1.8, spec );
  col += uSpecColor * ( core + halo * uSheen ) * uSpecular * mix( 0.1, 1.0, ramp.a );

  // Rim, gated by where the rim light actually is and widened on the shadow
  // side. A uniform Fresnel halo is the cheapest-looking effect in real-time
  // NPR and reads instantly as a shortcut; this one terminates on the side the
  // light is not, the way a drawn highlight does.
  vec3 V = normalize( vViewPosition );
  float fres = pow( 1.0 - saturate( dot( normal, V ) ), uRimSharp );
  float dirMask = smoothstep( uRimSpread, 1.0, dot( normal, rimDirView ) );
  float rim = fres * mix( 1.0, dirMask, uRimDirectional ) * mix( 1.3, 0.7, ramp.a );
  rim = smoothstep( uRimEdge - uRimSoft, uRimEdge + uRimSoft, rim );
  col += uRimColor * rim * uRimPower;

  // A dark stage should dim the fighters, but only partway: losing them into
  // the backdrop during a super is worse than being physically wrong.
  col *= mix( 1.0, saturate( sqrt( totalLum / reference ) ), uExposureResponse );
  col *= uLightingScale;

  // Chroma is expanded ahead of tone mapping because ACES desaturates as it
  // rolls off, and this palette sits right where it would eat it.
  col = max( mix( vec3( nprLum( col ) ), col, uSaturation ), vec3( 0.0 ) );

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

  constructor(opts: ToonMaterialOptions) {
    const p = preset(opts.kind);

    const color = new THREE.Color(opts.color);
    const shadow = opts.shadowColor
      ? new THREE.Color(opts.shadowColor)
      : coolShadow(color, { shift: 0.17 * p.shadowShift, value: 0.42 * p.shadowValue });

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
          uCoreTint: { value: coreShadowTint(shadow) },
          uSSSColor: { value: sss },
          uRimColor: { value: new THREE.Color(opts.rimColor ?? 0xffd3a8) },
          uSpecColor: { value: spec },
          opacity: { value: 1 },

          uRamp: { value: null },

          uWrap: { value: p.wrap },
          uShadeGain: { value: p.shadeGain },
          uShadeBias: { value: p.shadeBias },
          uSpecular: { value: opts.specular ?? p.specular },
          uSpecPower: { value: p.specPower },
          uSpecThreshold: { value: p.specThreshold },
          uSpecSoft: { value: p.specSoft },
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
          uRimDir: { value: NPR_TUNING.rimDirection.clone() },

          uSSS: { value: p.sss },
          uTranslucency: { value: p.translucency },
          uCurvature: { value: p.curvature },
          uTerminatorNoise: { value: p.terminatorNoise },
          uNoiseScale: { value: p.noiseScale },
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

    // `UniformsUtils.merge` deep-copies, so textures have to be attached after
    // construction — a cloned sampler would point at nothing.
    this.uniforms.uRamp.value = bandRamp({
      bands: opts.bands ?? p.bands,
      sharpness: opts.bandSharpness ?? p.sharpness,
      toe: p.toe,
      shoulder: p.shoulder,
      terminatorWidth: p.terminatorWidth,
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
