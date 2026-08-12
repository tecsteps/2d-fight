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
 * The NPR shader divides accumulated diffuse by a reference luminance (see
 * `ToonMaterial`, `calibrateNpr`). One consequence: the fraction of that
 * reference held by the key is exactly the shade coordinate a fully key-lit
 * surface lands on. Below roughly 0.8 the lit side of a fighter stops reaching
 * its own albedo band and every skin tone reads a band too dark — pulled toward
 * its own shadow colour, which is precisely how four different skins converge.
 * So the builder does not take raw intensities. It takes *relative* luminance
 * weights and renormalises them to hit `keyShare`, so a stage author can
 * recolour the rig without silently re-solving skin legibility.
 *
 * ## 3. The rim is never the key's hue, and it is not in the denominator
 *
 * Silhouette separation is the rim's whole job, and two warm lights from
 * opposite sides produce a warm edge on a warm body: no separation, just a
 * brighter body. Presets are checked at build time for hue distance and the
 * preset table documents the pairing. Warm key / cool rim is the default because
 * it is what KOF XIII does.
 *
 * The rim is also almost entirely **excluded from the shade reference**, and that
 * is a correctness fix rather than a cheat. `calibrateNpr` sums every lamp, so a
 * strong backlight inflates the denominator and darkens the *front* of every
 * fighter — the front, which the backlight cannot reach by construction. Paying
 * for light that never arrives is what forces the choice between "the rim reads"
 * and "the roster reads". Accounting for the rim at `RIM_BACKFEED` of its
 * luminance — the fraction the shader's wrapped lambert actually carries around
 * onto a three-quarter-facing surface — lets a stage have both.
 *
 * What the rim must still respect is the terminator: once a rim-lit back is
 * brighter than the ramp's toe, the backlight has become a second key and the
 * fighter has two light shapes. That bound is `MAX_RIM_WEIGHT`, and it is derived
 * from the ramp, not chosen.
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
   * Fraction of the shade reference the key must hold.
   *
   * This is the number that decides whether the roster reads. It *is* the shade
   * coordinate a fully key-lit surface lands on, and the skin ramp's top band
   * starts around 0.8 — so at 0.85 a lit cheek reaches its own albedo and the
   * four authored skin tones are what the audience sees. Drop it to 0.7 and
   * every fighter's lit side falls into the form band below, which is 12% of the
   * way toward its shadow colour; four skins pulled 12% toward four different
   * plum shadows is measurably closer together than the palette intended, and
   * that is the whole "they all look the same" failure.
   *
   * Only the fill and the bounce are renormalised to satisfy it. The rim is a
   * free art dial — see the header.
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
   *
   * Pass the scene root to also have it audited for lights this rig does not
   * control — the positional-light trap in invariant 1.
   */
  apply(scene?: THREE.Object3D): void;
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
    rim: { color: 0x9fd6ff, weight: 0.56, azimuth: 158, elevation: 34 },
    bounce: { color: 0xc08a5c, weight: 0.13, azimuth: 8, elevation: -30 },
    ambient: { sky: 0x46648f, ground: 0x3d2a1c, intensity: 0.38 },
    keyShare: 0.85,
    keyLuminance: 2.1,
    nprSaturation: 1.02,
  },

  /** Interior night: hard practical overhead, cyan bounce off wet concrete. */
  noir: {
    name: 'noir',
    note: 'Near-white hard key almost overhead, steel rim, almost no fill.',
    key: { color: 0xfff4e8, weight: 1, azimuth: -26, elevation: 62 },
    fill: { color: 0x6f8cc4, weight: 0.07, azimuth: 74, elevation: 8 },
    rim: { color: 0xbfe4ff, weight: 0.58, azimuth: -168, elevation: 26 },
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
    rim: { color: 0xff7ad0, weight: 0.55, azimuth: -152, elevation: 30 },
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
    rim: { color: 0xdff0ff, weight: 0.44, azimuth: 166, elevation: 40 },
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

/**
 * Fraction of the rim's luminance that is charged to the shade reference.
 *
 * A backlight cannot light a front-facing surface: with the skin ramp's wrap of
 * 0.24, a normal pointing at the camera gets `(N·L + wrap)/(1 + wrap) < 0` from a
 * lamp behind it and contributes nothing. What it *does* reach is the shoulder,
 * the outer arm, the side of the jaw — three-quarter-facing surfaces where the
 * wrap carries roughly a third of it. Charging the reference for the full lamp
 * darkens the whole front of every fighter to pay for light that only lands on
 * the edges.
 */
const RIM_BACKFEED = 0.32;

/**
 * Largest rim weight, relative to the key, that still reads as a backlight.
 *
 * Derived rather than chosen: a rim-lit back lands at `rim²/reference` on the
 * shade coordinate, and once that passes the ramp's toe (0.34 on skin) the back
 * of the fighter is in a *lit* band. At that point the character has two light
 * shapes and no readable form — the exact mistake of turning the rim up until it
 * "pops".
 */
const MAX_RIM_WEIGHT = 0.6;

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
 * chosen so the key holds exactly `keyShare` of the shade reference. That means a
 * preset can be recoloured freely — including to a much darker rim colour, which
 * would otherwise quietly hand the key more share and blow out the lit side —
 * without re-deriving anything.
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

  let rimWeight = preset.rim.weight;
  if (rimWeight > MAX_RIM_WEIGHT) {
    console.warn(
      `[lighting] preset "${preset.name}": rim weight ${rimWeight.toFixed(2)} exceeds ` +
        `${MAX_RIM_WEIGHT}; a backlight this strong crosses the ramp's terminator and ` +
        `becomes a second key. Clamped.`,
    );
    rimWeight = MAX_RIM_WEIGHT;
  }

  // Renormalise fill and bounce so the key lands on `keyShare` of the reference.
  // Squared luminance, because that is the space the NPR shade coordinate lives
  // in; and the rim enters only at `RIM_BACKFEED` — see the header.
  const rimCharge = (rimWeight * RIM_BACKFEED) ** 2;
  const budget = 1 / THREE.MathUtils.clamp(preset.keyShare, 0.4, 0.98) - 1;
  const sumSq = preset.fill.weight ** 2 + preset.bounce.weight ** 2;
  const scale = sumSq > 1e-9 ? Math.sqrt(Math.max(budget - rimCharge, 0) / sumSq) : 0;

  const targetLuminance = {
    key: preset.keyLuminance,
    fill: preset.keyLuminance * preset.fill.weight * scale,
    rim: preset.keyLuminance * rimWeight,
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
    weights.key ** 2 +
    weights.fill ** 2 +
    (weights.rim * RIM_BACKFEED) ** 2 +
    weights.bounce ** 2;

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

    apply(scene?: THREE.Object3D): void {
      // The drawn rim highlight is a *painted* effect keyed off this direction,
      // not the rim lamp's diffuse. Forgetting it is why a stage sometimes has a
      // rim light shining from the left and rim highlights drawn on the right.
      setNprRimDirection(rimDirection);
      setNprSaturation(preset.nprSaturation);
      publishLightReference(reference);
      if (scene) auditScene(scene, preset.name);
    },
  };
}

/**
 * Installs this rig's shade reference across the NPR pipeline.
 *
 * `calibrateNpr` is not used, and that is the point: it sums every lamp in the
 * scene, which charges the front of every fighter for the backlight behind them.
 * The rig has already computed the reference it wants — key + fill + bounce, plus
 * the rim at `RIM_BACKFEED` — so it publishes that number instead and turns the
 * lazy auto-calibration off so nothing overwrites it on the first draw.
 *
 * Materials built *after* this call pick the value up from `NPR_TUNING`; ones
 * already alive need the uniform written directly.
 */
function publishLightReference(reference: number): void {
  NPR_TUNING.lightReference = reference;
  NPR_TUNING.autoCalibrate = false;
  for (const material of nprMaterials()) {
    // `NPRMaterial` is the narrow gameplay-facing contract and does not admit to
    // being a ShaderMaterial. Every implementation is one; the guard below covers
    // any future one that is not.
    const uniforms = (material as unknown as THREE.ShaderMaterial).uniforms;
    if (uniforms?.uLightReference) uniforms.uLightReference.value = reference;
  }
}

/**
 * Warns about lights in the scene that this rig does not control.
 *
 * Specifically point and spot lights, which are the invariant this whole file
 * exists to hold: they fall off with distance, Three cannot exclude the fighters
 * from them, and so they make a fighter's colour depend on where they are
 * standing. It is a very easy mistake to make — a warm pool light on the floor is
 * the obvious way to ground a stage, and it looks correct right up until you
 * measure two fighters and find the one nearer the middle is a different person.
 */
function auditScene(scene: THREE.Object3D, presetName: string): void {
  const offenders: string[] = [];
  scene.traverse((o) => {
    const l = o as THREE.PointLight & THREE.SpotLight;
    if (l.isPointLight || l.isSpotLight) offenders.push(l.name || l.type);
  });
  if (offenders.length) {
    console.warn(
      `[lighting] preset "${presetName}": positional lights in the fight plane ` +
        `(${offenders.join(', ')}). These light the fighters by distance, so the same ` +
        `fighter will be a different colour at midscreen and in the corner. Use ` +
        `additive geometry for stage pools instead — see bootstrap.ts.`,
    );
  }
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
