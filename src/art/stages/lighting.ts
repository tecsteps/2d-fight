import * as THREE from 'three';
import {
  NPR_TUNING,
  nprMaterials,
  setNprRimDirection,
  setNprSaturation,
} from '../../render/npr/ToonMaterial';

/**
 * The fight-plane light rig.
 *
 * Every stage lights its characters through this one builder, and the reason is
 * a bug this repo already shipped once: a stage that hand-places four lights
 * will, sooner or later, make two fighters with deliberately different skin
 * tones render as the same colour. The lineup capture that motivated this file
 * had Mali reading *brighter* than Kai even though Kai's authored skin is two
 * stops lighter, because a warm point light sat in the middle of the plane and
 * inverse-square did the rest.
 *
 * So this rig enforces four invariants that character legibility depends on, and
 * lets a stage choose freely inside them.
 *
 * ## 1. Character light is positionally invariant
 *
 * Key, fill, rim and bounce are **directional only**. Three.js has no
 * per-object light filtering, so any point or spot light placed for the *stage*
 * also lands on the fighters — with `1/d²` falloff, which means the same
 * fighter is a different colour at midscreen than in the corner. In a fighting
 * game that is not a look, it is a fairness bug: players read damage state and
 * character identity off colour. Stage-local pools belong in the stage's own
 * emissive geometry (see `bootstrap.ts`), never in a light.
 *
 * ## 2. The key owns the terminator
 *
 * The NPR shader divides accumulated diffuse by the rig's total *squared*
 * luminance (see `ToonMaterial`, `calibrateNpr`). One consequence: the fraction
 * of that total held by the key is exactly the shade coordinate a fully key-lit
 * surface lands on. Below roughly 0.7 the lit side of a fighter stops reaching
 * its own albedo band and every costume starts reading a band too dark. So the
 * builder does not take raw intensities — it takes *relative* luminance weights
 * and renormalises them to hit `keyShare`. A stage author can then push the rim
 * or recolour the fill without silently re-solving skin legibility.
 *
 * ## 3. The rim is never the key's hue
 *
 * Silhouette separation is the rim's whole job, and two warm lights from
 * opposite sides produce a warm edge on a warm body: no separation, just a
 * brighter body. Presets are checked at build time for hue distance and the
 * preset table documents the pairing. Warm key / cool rim is the default because
 * it is what KOF XIII does.
 *
 * ## 4. Mood lives in the preset, structure does not
 *
 * A preset carries hue, elevation and contrast ratio. It cannot carry a light
 * count, a light type, or an unbounded key share. That is the difference between
 * "this stage has its own mood" and "this stage broke the characters".
 */

/** Where a light sits, in stage-relative angles rather than raw coordinates. */
export interface LightPlacement {
  /**
   * Degrees around +Y from the camera axis (+Z), positive toward +X — which is
   * screen-right in the default fighting camera. So −40 is the classic
   * front-left key and 160 is a back-right rim.
   */
  azimuth: number;
  /** Degrees above the horizon. Negative puts the light under the fighter. */
  elevation: number;
}

export interface LampSpec extends LightPlacement {
  color: THREE.ColorRepresentation;
  /**
   * Luminance *relative to the key*, before normalisation. The key is 1 by
   * definition. These are ratios an artist can reason about — "the fill is a
   * fifth of the key" — and the builder converts them to Three intensities,
   * which are not comparable across colours because a deep blue at intensity 1
   * carries a quarter of the light of a warm white at intensity 1.
   */
  weight: number;
}

export interface AmbientSpec {
  sky: THREE.ColorRepresentation;
  ground: THREE.ColorRepresentation;
  intensity: number;
}

export interface LightPreset {
  /** Human name, for the debug UI and the capture tags. */
  name: string;
  /** One line on what mood this is for. */
  note: string;

  key: LampSpec;
  fill: LampSpec;
  rim: LampSpec;
  /** Light off the floor. Weak by definition; it exists to stop dead undersides. */
  bounce: LampSpec;
  ambient: AmbientSpec;

  /**
   * Fraction of the rig's squared-luminance total the key must hold.
   *
   * This is the number that decides whether the roster reads. It *is* the shade
   * coordinate a fully key-lit surface lands on, and the skin ramp's top band
   * starts around 0.8 — so at 0.85 a lit cheek reaches its own albedo and the
   * four authored skin tones are what the audience sees. Drop it to 0.7 and
   * every fighter's lit side falls into the form band below, which is 12% of the
   * way toward its shadow colour; four skins pulled 12% toward four different
   * plum shadows is measurably closer together than the palette intended, and
   * that is the whole "they all look the same" failure.
   */
  keyShare: number;
  /**
   * Absolute luminance of the key, in Three's units.
   *
   * Worth understanding what this does and does not do. The NPR shader divides
   * by a reference measured from this same rig, so scaling every lamp together
   * cancels out and the **fighters do not change at all**. What it moves is
   * everything shaded by a physical material — the floor, props, anything a
   * stage builds with `MeshStandardMaterial`. So this is the *stage* exposure
   * dial, and it is safe to swing it hard: a stage can go from noon to almost
   * black without touching character legibility by one band.
   */
  keyLuminance: number;
  /**
   * Chroma pre-compensation for the NPR surfaces. The tone curve desaturates as
   * it rolls off, so a bright stage needs more of this than a dark one — which
   * is exactly why it is a per-stage number and not a constant.
   */
  nprSaturation: number;
}

export interface FightRigOptions {
  /** Preset name from `LIGHT_PRESETS`, or a full spec. */
  preset?: LightPresetName | LightPreset;
  /** Per-field overrides merged over the preset. */
  override?: Partial<LightPreset>;
  /** Half-width of the fighting plane in metres. Sizes the shadow frustum. */
  planeHalfWidth?: number;
  /** Tallest thing that must cast a shadow, in metres. */
  planeHeight?: number;
  /** How far the lights are placed from the plane centre. Shadows only. */
  distance?: number;
  castShadow?: boolean;
  shadowMapSize?: number;
}

export interface FightRig {
  /** Add this to the stage's world group. Contains the lights and their targets. */
  group: THREE.Group;
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
  bounce: THREE.DirectionalLight;
  ambient: THREE.HemisphereLight;
  /** The resolved preset, after normalisation. Log it when a stage looks wrong. */
  preset: LightPreset;
  /** World-space direction *toward* the rim light, as the NPR shader wants it. */
  rimDirection: THREE.Vector3;
  /** Σ lum(colour·intensity)² over the four lamps — the NPR shade denominator. */
  reference: number;
  /** Realised key share. Compare against `preset.keyShare` when debugging. */
  keyShare: number;
  /**
   * Publishes the rig to the NPR pipeline: rim direction, chroma
   * pre-compensation and the shade-coordinate reference. Call once after the
   * stage is assembled, and again if a light is retuned at runtime.
   */
  apply(scene: THREE.Object3D): void;
}

const DEG = Math.PI / 180;

/** Unit vector pointing from the plane centre toward the light. */
function placementToDirection(p: LightPlacement): THREE.Vector3 {
  const az = p.azimuth * DEG;
  const el = p.elevation * DEG;
  const c = Math.cos(el);
  return new THREE.Vector3(Math.sin(az) * c, Math.sin(el), Math.cos(az) * c).normalize();
}

/** Rec.709 luminance of a colour in *linear* space, which is how lights live. */
function lightLuminance(c: THREE.Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** Hue distance in degrees, wrapped to 0..180. Used to police the rim/key pair. */
function hueDistance(a: THREE.Color, b: THREE.Color): number {
  const ha = { h: 0, s: 0, l: 0 };
  const hb = { h: 0, s: 0, l: 0 };
  a.getHSL(ha);
  b.getHSL(hb);
  const d = Math.abs(ha.h - hb.h) * 360;
  return d > 180 ? 360 - d : d;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * The stage moods.
 *
 * Read the `key`/`rim` colour pairs as a set: every one of them is a warm/cool
 * or cool/warm *opposition*, never two lamps of the same family. That opposition
 * is what a cel-shaded fighter needs to stay separated from the backdrop, and it
 * is the single easiest thing to get wrong — a "sunset stage" instinctively
 * wants a warm rim, and a warm rim on a warm-lit body is invisible.
 *
 * Key hues are deliberately close to white. The NPR shader tints albedo by the
 * rig's hue (`uLightTint`), so a strongly coloured key literally overwrites
 * every costume and skin tone in the roster with its own hue. Colour belongs on
 * the *secondary* lamps and in the backdrop, where it separates instead of
 * flattening.
 */
export const LIGHT_PRESETS = {
  /** Bootstrap / default: late dusk, warm sun off-frame, cold sky behind. */
  dusk: {
    name: 'dusk',
    note: 'Warm low sun from front-left, cold skylight rim from behind-right.',
    key: { color: 0xffeedc, weight: 1, azimuth: -38, elevation: 44 },
    fill: { color: 0x7fa0dc, weight: 0.16, azimuth: 62, elevation: 16 },
    rim: { color: 0x9fd6ff, weight: 0.47, azimuth: 158, elevation: 34 },
    bounce: { color: 0xc08a5c, weight: 0.13, azimuth: 8, elevation: -30 },
    ambient: { sky: 0x46648f, ground: 0x3d2a1c, intensity: 0.38 },
    keyShare: 0.85,
    keyLuminance: 1.75,
    nprSaturation: 1.12,
  },

  /** Interior night: hard practical overhead, cyan bounce off wet concrete. */
  noir: {
    name: 'noir',
    note: 'Near-white hard key almost overhead, steel rim, almost no fill.',
    key: { color: 0xfff4e8, weight: 1, azimuth: -26, elevation: 62 },
    fill: { color: 0x6f8cc4, weight: 0.07, azimuth: 74, elevation: 8 },
    rim: { color: 0xbfe4ff, weight: 0.5, azimuth: -168, elevation: 26 },
    bounce: { color: 0x6e7c8c, weight: 0.06, azimuth: -4, elevation: -34 },
    ambient: { sky: 0x39496b, ground: 0x1b1d24, intensity: 0.3 },
    keyShare: 0.86,
    keyLuminance: 1.6,
    nprSaturation: 1.14,
  },

  /** Neon alley: cool key, hot magenta rim. The one preset with a warm rim. */
  neon: {
    name: 'neon',
    note: 'Cold key from front-right, magenta sign rim from behind-left.',
    key: { color: 0xe8f2ff, weight: 1, azimuth: 34, elevation: 40 },
    fill: { color: 0x3fb9c4, weight: 0.14, azimuth: -66, elevation: 12 },
    rim: { color: 0xff7ad0, weight: 0.46, azimuth: -152, elevation: 30 },
    bounce: { color: 0x8a5ec8, weight: 0.1, azimuth: 0, elevation: -32 },
    ambient: { sky: 0x2f3f66, ground: 0x2a1830, intensity: 0.38 },
    keyShare: 0.84,
    keyLuminance: 1.8,
    nprSaturation: 1.1,
  },

  /** Daylight rooftop: the brightest rig, and the one that needs the least grade. */
  noon: {
    name: 'noon',
    note: 'High neutral sun, strong sky fill, pale rim. Flattest on purpose.',
    key: { color: 0xfffaf0, weight: 1, azimuth: -20, elevation: 58 },
    fill: { color: 0x9dbdf0, weight: 0.2, azimuth: 58, elevation: 22 },
    rim: { color: 0xdff0ff, weight: 0.4, azimuth: 166, elevation: 40 },
    bounce: { color: 0xb8ac96, weight: 0.14, azimuth: 6, elevation: -28 },
    ambient: { sky: 0x86a8dd, ground: 0x50412e, intensity: 0.6 },
    keyShare: 0.83,
    keyLuminance: 2.6,
    nprSaturation: 1.06,
  },
} satisfies Record<string, LightPreset>;

export type LightPresetName = keyof typeof LIGHT_PRESETS;

/** Minimum hue separation between key and rim, in degrees. Below this they muddy. */
const MIN_RIM_HUE_SEPARATION = 35;

function resolvePreset(opts: FightRigOptions): LightPreset {
  const base: LightPreset =
    typeof opts.preset === 'object' ? opts.preset : LIGHT_PRESETS[opts.preset ?? 'dusk'];
  // Shallow clone plus a one-level merge: lamps are replaced whole, because a
  // half-overridden lamp (new colour, inherited weight) is the kind of thing
  // that looks fine on the stage it was authored for and nowhere else.
  return {
    ...base,
    key: { ...base.key },
    fill: { ...base.fill },
    rim: { ...base.rim },
    bounce: { ...base.bounce },
    ambient: { ...base.ambient },
    ...opts.override,
  };
}

/**
 * Builds a key/fill/rim/bounce rig sized to the fighting plane.
 *
 * The weights in the preset are *relative*; what comes out is Three intensities
 * chosen so the key holds exactly `keyShare` of the rig's squared-luminance
 * total. That means a preset can be recoloured freely — including to a much
 * darker rim colour, which would otherwise quietly hand the key more share and
 * blow out the lit side — without re-deriving anything.
 */
export function buildFightRig(opts: FightRigOptions = {}): FightRig {
  const preset = resolvePreset(opts);
  const halfWidth = opts.planeHalfWidth ?? 11;
  const planeHeight = opts.planeHeight ?? 9;
  const distance = opts.distance ?? 16;

  const colours = {
    key: new THREE.Color(preset.key.color),
    fill: new THREE.Color(preset.fill.color),
    rim: new THREE.Color(preset.rim.color),
    bounce: new THREE.Color(preset.bounce.color),
  };

  if (hueDistance(colours.key, colours.rim) < MIN_RIM_HUE_SEPARATION) {
    // Loud, but not fatal: a stage in progress should still render.
    console.warn(
      `[lighting] preset "${preset.name}": rim hue is within ` +
        `${MIN_RIM_HUE_SEPARATION}° of the key. The rim will brighten the fighters ` +
        `instead of separating them from the backdrop.`,
    );
  }

  // Renormalise the secondary weights so the key lands on `keyShare`. The share
  // is over *squared* luminance because that is the space the NPR shade
  // coordinate lives in — see the header.
  const secondary = [preset.fill.weight, preset.rim.weight, preset.bounce.weight];
  const sumSq = secondary.reduce((a, w) => a + w * w, 0);
  const wanted = 1 / THREE.MathUtils.clamp(preset.keyShare, 0.4, 0.98) - 1;
  const scale = sumSq > 1e-9 ? Math.sqrt(wanted / sumSq) : 0;

  const targetLuminance = {
    key: preset.keyLuminance,
    fill: preset.keyLuminance * preset.fill.weight * scale,
    rim: preset.keyLuminance * preset.rim.weight * scale,
    bounce: preset.keyLuminance * preset.bounce.weight * scale,
  };

  const group = new THREE.Group();
  group.name = `rig:${preset.name}`;

  function lamp(id: 'key' | 'fill' | 'rim' | 'bounce'): THREE.DirectionalLight {
    const colour = colours[id];
    // Intensity is target luminance over the colour's own luminance, so two
    // lamps with the same weight and different hues carry the same light.
    const intensity = targetLuminance[id] / Math.max(lightLuminance(colour), 1e-4);
    // Built white and assigned after, because passing a hex here would run the
    // sRGB decode a second time over colours that are already in working space —
    // which darkens every lamp and silently invalidates the weights above.
    const light = new THREE.DirectionalLight(0xffffff, intensity);
    light.color.copy(colour);
    light.name = `${preset.name}:${id}`;
    light.position.copy(placementToDirection(preset[id]).multiplyScalar(distance));
    group.add(light, light.target);
    return light;
  }

  const key = lamp('key');
  const fill = lamp('fill');
  const rim = lamp('rim');
  const bounce = lamp('bounce');

  const ambient = new THREE.HemisphereLight(0xffffff, 0xffffff, preset.ambient.intensity);
  ambient.color.set(preset.ambient.sky);
  ambient.groundColor.set(preset.ambient.ground);
  ambient.name = `${preset.name}:ambient`;
  group.add(ambient);

  if (opts.castShadow ?? true) {
    key.castShadow = true;
    const size = opts.shadowMapSize ?? 2048;
    key.shadow.mapSize.set(size, size);
    // Framed on the fighting plane, not on the whole stage. A frustum wide
    // enough to include the backdrop spends most of its texels on geometry that
    // never shows a shadow, and the fighters get the aliased remainder.
    key.shadow.camera.left = -halfWidth;
    key.shadow.camera.right = halfWidth;
    key.shadow.camera.top = planeHeight;
    key.shadow.camera.bottom = -planeHeight * 0.35;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = distance * 2.6;
    key.shadow.bias = -0.0012;
    key.shadow.normalBias = 0.02;
    key.shadow.camera.updateProjectionMatrix();
  }

  const weights = {
    key: lightLuminance(key.color) * key.intensity,
    fill: lightLuminance(fill.color) * fill.intensity,
    rim: lightLuminance(rim.color) * rim.intensity,
    bounce: lightLuminance(bounce.color) * bounce.intensity,
  };
  const reference =
    weights.key ** 2 + weights.fill ** 2 + weights.rim ** 2 + weights.bounce ** 2;

  const rimDirection = placementToDirection(preset.rim);

  return {
    group,
    key,
    fill,
    rim,
    bounce,
    ambient,
    preset,
    rimDirection,
    reference,
    keyShare: weights.key ** 2 / Math.max(reference, 1e-9),

    apply(scene: THREE.Object3D): void {
      // The drawn rim highlight is a *painted* effect keyed off this direction,
      // not the rim lamp's diffuse. Forgetting it is why a stage sometimes has a
      // rim light shining from the left and rim highlights drawn on the right.
      setNprRimDirection(rimDirection);
      setNprSaturation(preset.nprSaturation);
      // Measured last, so it sees the final intensities including anything a
      // caller retuned after the build.
      calibrateNpr(scene);
    },
  };
}

/**
 * A rig's numbers as one line, for capture logs and the debug overlay.
 *
 * Worth printing whenever a stage looks off: `keyShare` drifting below ~0.7 and
 * a rim hue collapsing toward the key's are the two failures that look like
 * "the characters went muddy" rather than like a lighting bug.
 */
export function describeRig(rig: FightRig): string {
  const lum = (l: THREE.Light) => (lightLuminance(l.color) * l.intensity).toFixed(3);
  return (
    `${rig.preset.name}: key=${lum(rig.key)} fill=${lum(rig.fill)} rim=${lum(rig.rim)} ` +
    `bounce=${lum(rig.bounce)} | keyShare=${rig.keyShare.toFixed(3)} ` +
    `reference=${rig.reference.toFixed(2)} ` +
    `rimHueSep=${hueDistance(rig.key.color, rig.rim.color).toFixed(0)}°`
  );
}
