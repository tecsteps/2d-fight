import * as THREE from 'three';
import { BONES, type BoneName } from '../../../anim/contract';
import type { JointMap, RigMetrics } from '../../../anim/Skeleton';
import { fieldAt, sampleField, type BodyPlan } from '../body';
import type { BuiltCharacter } from '../rig';
import { createToonMaterial } from '../../../render/npr';
import type { SurfaceKind } from '../../../render/npr';
import type { TexSet } from '../../textures';

/**
 * The garment toolkit.
 *
 * Clothing here is never modelled "near" the body — it is **extracted from it**.
 * The body is an implicit field (`src/art/characters/body.ts`), so every shell,
 * band and trim in this file is a patch of a true offset surface of that body:
 * rays are fired outward from an anatomical axis to find the skin exactly, and
 * the cloth is then lifted off it along the surface normal by the layer's
 * thickness. There is no fitting pass, and nothing is authored per fighter.
 *
 * Three consequences are worth stating up front, because they are what make the
 * approach worth its cost:
 *
 * 1. **Layering is guaranteed, not tuned.** Two garments over the same skin at
 *    offsets `a < b` are strictly nested, whichever axis or arc found them,
 *    because both are lifted along the same surface normal. So they cannot
 *    z-fight as long as their offsets differ — see `LAYER` and `over()`.
 * 2. **Topology is a grid.** One quad per (angle, position-along-axis) cell,
 *    which means clean UVs (in *metres*, so a weave tiles at its real physical
 *    size), clean skinning, and a boundary that is a curve you can hand to
 *    `buildBand` to get a collar or a cuff trim that follows it exactly.
 * 3. **Edges are authored as curves, not as cuts.** The top and bottom of a
 *    shell are functions of angle (`from` / `to`), so an armhole, a V-neck, a
 *    diagonal wrap lapel and a side vent are all the same feature: a boundary
 *    profile. Nothing is ever trimmed after the fact, so every edge is a real,
 *    finished, rolled hem rather than a raw cut that reads as paint.
 *
 * Ordering: build shells inner-layer-first and attach each with `attachGarment`;
 * `buildCostume` in `./index.ts` re-runs the ink pass once at the end so the
 * outline shells see every garment that was added.
 */

// ---------------------------------------------------------------------------
// Layering
// ---------------------------------------------------------------------------

/** Nominal thickness of one layer of cloth, in metres. */
export const CLOTH = 0.004;

/**
 * Minimum radial separation between two surfaces that overlap in space.
 *
 * Below this the depth buffer starts to lose them against each other at stage
 * distance; above about 3 mm the gap itself becomes visible at a hem.
 */
export const LAYER_GAP = 0.0015;

/**
 * The radial offsets a costume is built from, in metres from the skin.
 *
 * These are *not* arbitrary constants — each is the previous one plus a cloth
 * thickness and a gap, which is exactly how real layers stack. Use `over()` to
 * continue the ladder rather than inventing a number.
 */
export const LAYER = {
  /** Tape, hand wraps, compression — pulled tight onto the skin. */
  skin: 0.0035,
  /** First garment layer: shirt, pants, shorts. */
  base: 0.009,
  /** A second layer over the base: gi top, vest lining. */
  mid: 0.0155,
  /** Outerwear: jacket, hoodie, quilted vest. */
  outer: 0.022,
  /** A sash or belt cinched over whatever is beneath it. */
  belt: 0.0285,
  /** Knots, hanging ends, anything that has left the body surface. */
  hanging: 0.035,
} as const;

/** The next offset that clears `layer` by one cloth thickness plus the gap. */
export function over(layer: number, times = 1): number {
  return layer + times * (CLOTH + LAYER_GAP);
}

// ---------------------------------------------------------------------------
// Anatomy: landmarks and axes
// ---------------------------------------------------------------------------

/** What a garment builder needs to know about the wearer. `BuiltCharacter` satisfies it. */
export interface GarmentBody {
  plan: BodyPlan;
  metrics: RigMetrics;
  joints: JointMap;
}

/**
 * Named heights on the figure, in world metres.
 *
 * Every garment edge should be expressed against one of these rather than a
 * literal, so that a hem that sits on Kai's hip also sits on Vera's.
 */
export type Landmark =
  | 'floor'
  | 'ankle'
  | 'calf'
  | 'knee'
  | 'midThigh'
  | 'crotch'
  | 'hip'
  | 'navel'
  | 'waist'
  | 'lowRib'
  | 'chest'
  | 'armpit'
  | 'shoulder'
  | 'neckBase'
  | 'chin'
  | 'crown';

export function landmarkY(m: RigMetrics, l: Landmark): number {
  const Y0 = m.legLen;
  const T = m.torsoLen;
  const shoulderY = m.neckBaseY - m.height * 0.028;
  switch (l) {
    case 'floor': return 0;
    case 'ankle': return m.ankleY;
    case 'calf': return m.ankleY + (kneeY(m) - m.ankleY) * 0.46;
    case 'knee': return kneeY(m);
    case 'midThigh': return Y0 - (Y0 - kneeY(m)) * 0.5;
    // The lowest point on the sagittal axis that is still inside the pelvis;
    // below it a torso-axis ray starts in open air and cannot be traced.
    case 'crotch': return Y0 - 0.085 * T;
    case 'hip': return Y0;
    case 'navel': return Y0 + 0.28 * T;
    case 'waist': return Y0 + 0.36 * T;
    case 'lowRib': return Y0 + 0.52 * T;
    case 'chest': return Y0 + 0.7 * T;
    // The underside of the deltoid: below this a torso ray reaches the hanging
    // arm instead of the ribs, which is what `torsoEnvelope` exists to stop.
    case 'armpit': return shoulderY - m.deltoidR * 1.05;
    case 'shoulder': return shoulderY;
    case 'neckBase': return m.neckBaseY;
    case 'chin': return m.height - m.headLen;
    case 'crown': return m.height;
  }
}

function kneeY(m: RigMetrics): number {
  return m.ankleY + (m.legLen - m.ankleY) * (0.465 + 0.01 * m.fem);
}

/**
 * A sweep path with an arclength parameter.
 *
 * `s` is always normalised arclength along the polyline, so a profile authored
 * as "0.3 of the way down the leg" means the same thing on every fighter.
 */
export interface Axis {
  pts: THREE.Vector3[];
  length: number;
  pointAt(s: number, out?: THREE.Vector3): THREE.Vector3;
  tangentAt(s: number, out?: THREE.Vector3): THREE.Vector3;
  /** Inverse of `pointAt().y`. Only meaningful for axes monotone in height. */
  sAtY(y: number): number;
}

export function axisFromPoints(input: THREE.Vector3[], samples = 64): Axis {
  // Coincident control points make the centripetal parametrisation divide by
  // zero, and a chain whose terminal bone has no length produces exactly that.
  const clean: THREE.Vector3[] = [];
  for (const p of input) if (!clean.length || clean[clean.length - 1].distanceTo(p) > 1e-5) clean.push(p.clone());
  if (clean.length < 2) clean.push(clean[0].clone().add(new THREE.Vector3(0, 1e-3, 0)));
  // Resampled onto a Catmull-Rom so a four-point authored path still yields a
  // smooth tangent — a kinked axis puts a visible crease ring in the cloth.
  const curve = new THREE.CatmullRomCurve3(clean, false, 'centripetal', 0.5);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < samples; i++) pts.push(curve.getPoint(i / (samples - 1)));

  const cum = new Float32Array(samples);
  for (let i = 1; i < samples; i++) cum[i] = cum[i - 1] + pts[i].distanceTo(pts[i - 1]);
  const length = cum[samples - 1];
  for (let i = 0; i < samples; i++) cum[i] /= length || 1;

  const locate = (s: number): [number, number] => {
    const t = THREE.MathUtils.clamp(s, 0, 1);
    let i = 0;
    while (i < samples - 2 && cum[i + 1] < t) i++;
    const span = cum[i + 1] - cum[i];
    return [i, span > 1e-9 ? (t - cum[i]) / span : 0];
  };

  return {
    pts,
    length,
    pointAt(s, out = new THREE.Vector3()) {
      const [i, f] = locate(s);
      return out.copy(pts[i]).lerp(pts[i + 1], f);
    },
    tangentAt(s, out = new THREE.Vector3()) {
      const [i] = locate(s);
      const a = Math.max(0, i - 1);
      const b = Math.min(samples - 1, i + 2);
      return out.subVectors(pts[b], pts[a]).normalize();
    },
    sAtY(y: number) {
      const up = pts[samples - 1].y >= pts[0].y;
      for (let i = 0; i < samples - 1; i++) {
        const y0 = pts[i].y;
        const y1 = pts[i + 1].y;
        const hit = up ? y >= y0 && y <= y1 : y <= y0 && y >= y1;
        if (!hit) continue;
        const f = Math.abs(y1 - y0) > 1e-9 ? (y - y0) / (y1 - y0) : 0;
        return cum[i] + (cum[i + 1] - cum[i]) * f;
      }
      return up === y > pts[0].y ? 1 : 0;
    },
  };
}

/**
 * The sagittal axis through the trunk, following the spine's own curve.
 *
 * Rays fired from a straight vertical line would strike the chest and the small
 * of the back at very different angles and the cloth would read as a cylinder;
 * riding the spine keeps them near-normal to the body all the way up.
 */
export function torsoAxis(body: GarmentBody, fromY: number, toY: number): Axis {
  const j = body.joints;
  const spine: [number, number][] = [
    [j.hips.y - body.metrics.torsoLen * 0.3, j.hips.z],
    [j.hips.y, j.hips.z],
    [j.spine.y, j.spine.z],
    [j.chest.y, j.chest.z],
    [j.neck.y, j.neck.z],
    [j.head.y, j.head.z],
  ];
  const zAt = (y: number): number => {
    if (y <= spine[0][0]) return spine[0][1];
    for (let i = 0; i < spine.length - 1; i++) {
      if (y > spine[i + 1][0]) continue;
      const f = (y - spine[i][0]) / (spine[i + 1][0] - spine[i][0]);
      return THREE.MathUtils.lerp(spine[i][1], spine[i + 1][1], f);
    }
    return spine[spine.length - 1][1];
  };
  const n = 10;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const y = THREE.MathUtils.lerp(fromY, toY, i / (n - 1));
    pts.push(new THREE.Vector3(0, y, zAt(y)));
  }
  return axisFromPoints(pts);
}

/** The bone chains a limb garment is normally swept along. */
export const CHAIN = {
  armL: ['upperArmL', 'forearmL', 'handL'] as BoneName[],
  armR: ['upperArmR', 'forearmR', 'handR'] as BoneName[],
  foreArmL: ['forearmL', 'handL'] as BoneName[],
  foreArmR: ['forearmR', 'handR'] as BoneName[],
  legL: ['thighL', 'shinL', 'footL'] as BoneName[],
  legR: ['thighR', 'shinR', 'footR'] as BoneName[],
} as const;

/**
 * An axis down a bone chain, from the first joint to the last.
 *
 * The chain's terminal bone contributes its own length by extending along the
 * previous segment's direction, so `['forearmL','handL']` reaches the knuckles
 * rather than stopping dead at the wrist.
 */
export function chainAxis(body: GarmentBody, chain: readonly BoneName[], tip = 0.8): Axis {
  const j = body.joints;
  const pts = chain.map((b) => j[b].clone());
  if (tip > 0) {
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2] ?? last;
    const dir = last.clone().sub(prev).normalize();
    const leaf = chain[chain.length - 1];
    const tipLen = leaf.startsWith('hand')
      ? body.metrics.handLen * tip
      : leaf.startsWith('foot')
        ? body.metrics.footLen * tip
        : last.distanceTo(prev) * tip;
    pts.push(last.clone().addScaledVector(dir, tipLen));
  }
  return axisFromPoints(pts);
}

/**
 * Maximum radius the trunk should ever be inflated to, per height and angle.
 *
 * The hanging arm merges with the ribcage in the implicit field — there is no
 * gap between them to trace into — so a ray fired sideways from the spine exits
 * on the *outside of the arm*, and a shirt built from it swallows the biceps.
 * This is the analytic trunk silhouette, derived from the same measurements the
 * body was built from, used as a ceiling on the traced radius.
 */
export function torsoEnvelope(m: RigMetrics): (y: number, angle: number) => number {
  const Y0 = m.legLen;
  const T = m.torsoLen;
  const depth = m.torsoDepth / 0.72;
  const slices: [number, number, number][] = [
    [Y0 - 0.16 * T, m.hipHalf * 0.64, 0.6],
    [Y0 + 0.05 * T, m.hipHalf, 0.58],
    [Y0 + 0.2 * T, m.hipHalf * 0.82, 0.64],
    [Y0 + 0.36 * T, m.waistHalf, 0.76],
    [Y0 + 0.52 * T, m.waistHalf + (m.chestHalf - m.waistHalf) * 0.7, 0.78],
    [Y0 + 0.7 * T, m.chestHalf, 0.72],
    [Y0 + 0.86 * T, m.chestHalf * 0.93, 0.74],
    [m.neckBaseY, m.chestHalf * 0.7, 0.8],
  ];
  return (y, angle) => {
    let w = slices[0][1];
    let d = slices[0][2];
    if (y >= slices[slices.length - 1][0]) {
      w = slices[slices.length - 1][1];
      d = slices[slices.length - 1][2];
    } else {
      for (let i = 0; i < slices.length - 1; i++) {
        if (y > slices[i + 1][0]) continue;
        const f = THREE.MathUtils.clamp((y - slices[i][0]) / (slices[i + 1][0] - slices[i][0]), 0, 1);
        w = THREE.MathUtils.lerp(slices[i][1], slices[i + 1][1], f);
        d = THREE.MathUtils.lerp(slices[i][2], slices[i + 1][2], f);
        break;
      }
    }
    const dz = w * d * depth;
    // Super-elliptical, matching the torso's own n≈2.6 section: a plain ellipse
    // cuts the flank in too far and the cloth pinches at the waist.
    const c = Math.abs(Math.cos(angle));
    const s = Math.abs(Math.sin(angle));
    const k = (c / dz) ** 2.6 + (s / w) ** 2.6;
    return k > 0 ? k ** (-1 / 2.6) : w;
  };
}

// ---------------------------------------------------------------------------
// Offset-surface tracing
// ---------------------------------------------------------------------------

/** Prim indices whose bone passes the filter, for garments that follow only part of the body. */
function primSubset(plan: BodyPlan, allow: (bone: BoneName) => boolean): Int32Array {
  const out: number[] = [];
  for (let i = 0; i < plan.prims.length; i++) {
    const p = plan.prims[i];
    const ramp = p.boneRamp;
    const ok = ramp ? ramp.some(allow) : allow(p.bone);
    if (ok) out.push(i);
  }
  return Int32Array.from(out);
}

/**
 * Distance from `origin` along `dir` to the surface `field === offset`.
 *
 * Sphere-traced outward (the field is 1-Lipschitz, so `offset - f` never
 * overshoots), then bisected once a bracket is in hand. The bisection is what
 * makes it robust where the trace would otherwise crawl: a grazing ray, or one
 * that leaves the field's grid entirely and jumps straight to the far value.
 */
export function traceOffset(
  plan: BodyPlan,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  offset: number,
  maxR: number,
  subset: Int32Array | null = null,
): number {
  const sample = (r: number): number => {
    const x = origin.x + dir.x * r;
    const y = origin.y + dir.y * r;
    const z = origin.z + dir.z * r;
    return subset ? sampleField(plan.prims, x, y, z, subset) : fieldAt(plan, x, y, z);
  };
  const minStep = maxR / 48;
  let rIn = 0;
  let rOut = -1;
  let r = 0;
  for (let i = 0; i < 64 && r <= maxR; i++) {
    const f = sample(r);
    if (f >= offset) {
      rOut = r;
      break;
    }
    rIn = r;
    r += Math.max(offset - f, minStep);
  }
  if (rOut < 0) return maxR;
  // Ten halvings of a bracket that is at most `minStep` wide lands inside 30
  // microns, which is two orders of magnitude finer than a cloth thickness.
  for (let i = 0; i < 10; i++) {
    const mid = (rIn + rOut) * 0.5;
    if (sample(mid) >= offset) rOut = mid;
    else rIn = mid;
  }
  return (rIn + rOut) * 0.5;
}

/**
 * Outward unit normal of the body surface at `p`.
 *
 * This is why garments are lifted along the normal rather than along the ray
 * that found the surface: the body's field is **not** a Euclidean distance
 * field. Each primitive scales its distance by the smallest of its
 * cross-section factors, so a squashed volume — the foot is 0.34 — reports a
 * third of the true distance, and a garment traced to `field === 0.008` there
 * would sit 24 mm off the skin instead of 8. Tracing to the *zero* level set is
 * exact regardless, and one gradient turns "8 mm of cloth" back into 8 mm.
 */
function surfaceNormal(
  plan: BodyPlan,
  p: THREE.Vector3,
  subset: Int32Array | null,
  out: THREE.Vector3,
): boolean {
  const h = 0.0022;
  const f = (x: number, y: number, z: number) =>
    subset ? sampleField(plan.prims, x, y, z, subset) : fieldAt(plan, x, y, z);
  out.set(
    f(p.x + h, p.y, p.z) - f(p.x - h, p.y, p.z),
    f(p.x, p.y + h, p.z) - f(p.x, p.y - h, p.z),
    f(p.x, p.y, p.z + h) - f(p.x, p.y, p.z - h),
  );
  const len = out.length();
  if (len < 1e-9) return false;
  out.multiplyScalar(1 / len);
  return true;
}

/**
 * Orthonormal angular frame at a point on an axis.
 *
 * `front` and `left` are world hints, each projected perpendicular to the
 * tangent, so **angle 0 is always the anatomical front and angle increases
 * toward the character's left**, whichever way the axis runs. Getting this
 * wrong on a downward-pointing limb axis is the classic mirrored-costume bug.
 */
function angularFrame(
  tangent: THREE.Vector3,
  front: THREE.Vector3,
  left: THREE.Vector3,
  ef: THREE.Vector3,
  el: THREE.Vector3,
): void {
  ef.copy(front).addScaledVector(tangent, -front.dot(tangent));
  if (ef.lengthSq() < 1e-6) ef.copy(left).addScaledVector(tangent, -left.dot(tangent));
  ef.normalize();
  el.copy(left).addScaledVector(tangent, -left.dot(tangent));
  el.addScaledVector(ef, -el.dot(ef));
  if (el.lengthSq() < 1e-6) el.crossVectors(tangent, ef);
  el.normalize();
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** Boundary height, as a function of position around the garment. */
export type EdgeProfile = number | ((u: number, angle: number) => number);
/** Radial quantity, as a function of position along and around the garment. */
export type RadialProfile = number | ((s: number, u: number, angle: number) => number);

function edgeAt(p: EdgeProfile, u: number, a: number): number {
  return typeof p === 'number' ? p : p(u, a);
}
function radialAt(p: RadialProfile, s: number, u: number, a: number): number {
  return typeof p === 'number' ? p : p(s, u, a);
}

/**
 * Smooth interpolation through authored stops, clamped at both ends.
 *
 * Smoothstep between knots rather than a spline: an offset profile that
 * overshoots puts the cloth *inside* the layer beneath it, and a costume that
 * looks right until one fighter's proportions change is not a costume system.
 */
export function ramp(stops: readonly [number, number][]): (x: number) => number {
  const s = [...stops].sort((a, b) => a[0] - b[0]);
  return (x) => {
    if (x <= s[0][0]) return s[0][1];
    const last = s[s.length - 1];
    if (x >= last[0]) return last[1];
    for (let i = 0; i < s.length - 1; i++) {
      if (x > s[i + 1][0]) continue;
      const f = THREE.MathUtils.smoothstep(x, s[i][0], s[i + 1][0]);
      return THREE.MathUtils.lerp(s[i][1], s[i + 1][1], f);
    }
    return last[1];
  };
}

/**
 * A profile authored as `[degrees, value]` stops around the body.
 *
 * 0° is the front, +90° the character's left, 180° the back. Wraps, so a stop
 * at -150° and one at 170° interpolate the short way across the back seam.
 */
export function byAngle(stops: readonly [number, number][]): (angle: number) => number {
  const s = [...stops].map(([d, v]) => [THREE.MathUtils.degToRad(d), v] as [number, number]);
  s.sort((a, b) => a[0] - b[0]);
  const wrapped: [number, number][] = [
    [s[s.length - 1][0] - Math.PI * 2, s[s.length - 1][1]],
    ...s,
    [s[0][0] + Math.PI * 2, s[0][1]],
  ];
  const f = ramp(wrapped);
  return (angle) => {
    let a = angle;
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return f(a);
  };
}

/** Turns an angle profile of world heights into a boundary profile in axis params. */
export function edgeAtHeight(axis: Axis, stops: readonly [number, number][]): EdgeProfile {
  const f = byAngle(stops);
  return (_u, angle) => axis.sAtY(f(angle));
}

// ---------------------------------------------------------------------------
// Finished edges
// ---------------------------------------------------------------------------

/**
 * A finished garment border.
 *
 * A shell that simply stops mid-limb reads as paint on skin — the giveaway is
 * that the edge has no thickness and no shadow of its own. A real hem is folded
 * back on itself, which makes it *thicker* than the cloth it finishes and puts
 * a highlight along the fold and a dark line under it. That bead is the whole
 * reason this exists.
 */
export interface EdgeStyle {
  /** How far the fold turns back under the shell, in metres. */
  fold?: number;
  /** Radial swell of the bead. Should exceed the cloth thickness to read. */
  roll?: number;
  /** Rings across the bead. 3 is the minimum that shades as a roll. */
  rings?: number;
}

const RAW: Required<EdgeStyle> = { fold: 0.0, roll: 0.0, rings: 1 };

function edgeStyle(e: EdgeStyle | undefined, cloth: number): Required<EdgeStyle> {
  if (!e) return RAW;
  return {
    fold: e.fold ?? cloth * 3,
    roll: e.roll ?? cloth * 1.1,
    rings: Math.max(1, e.rings ?? 3),
  };
}

// ---------------------------------------------------------------------------
// Drape
// ---------------------------------------------------------------------------

export interface DrapeOptions {
  /** Number of folds around the garment. Loose cloth: 6–9. Fitted: 0. */
  folds?: number;
  /** Fold depth in metres. */
  amplitude?: number;
  /** Fold repeats along the axis; >1 makes the folds break rather than run straight. */
  along?: number;
  seed?: number;
  /** Extra radius toward the ground-facing side, so cloth hangs rather than floats. */
  sag?: number;
}

/**
 * Seamless fold field.
 *
 * Built from cosines with integer angular frequencies so it is exactly periodic
 * around the garment — a noise texture would leave a seam down the back, which
 * on a closed shell is a visible crease that never goes away.
 */
function drapeField(o: Required<Omit<DrapeOptions, 'sag'>>): (u: number, s: number) => number {
  const h = (n: number) => {
    const x = Math.sin(n * 127.1 + o.seed * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const oct = [
    { k: Math.max(1, Math.round(o.folds)), m: o.along, a: 1.0, p: h(1), q: h(2) },
    { k: Math.max(2, Math.round(o.folds * 1.7)), m: o.along * 1.9, a: 0.45, p: h(3), q: h(4) },
    { k: Math.max(3, Math.round(o.folds * 2.9)), m: o.along * 3.3, a: 0.22, p: h(5), q: h(6) },
  ];
  const norm = 1 / (1 + 0.45 + 0.22);
  return (u, s) => {
    let v = 0;
    for (const c of oct) {
      v +=
        c.a *
        Math.cos(Math.PI * 2 * (c.k * u + c.p) + Math.sin(Math.PI * 2 * (c.m * s + c.q)) * 0.8) *
        (0.65 + 0.35 * Math.cos(Math.PI * 2 * (c.m * s + c.q)));
    }
    return v * norm * o.amplitude;
  };
}

// ---------------------------------------------------------------------------
// Shells
// ---------------------------------------------------------------------------

export interface ShellOptions {
  axis: Axis;
  /** Boundary at the low end of the axis, in axis params. */
  from: EdgeProfile;
  /** Boundary at the high end of the axis, in axis params. */
  to: EdgeProfile;
  /** Radial thickness of the *layer* — how far off the skin the cloth sits. */
  offset: RadialProfile;
  /** Thickness of the cloth itself. Defaults to `CLOTH`. */
  cloth?: number;
  /** Angular span in radians. 0 is the front, +π/2 the character's left. */
  arc?: [number, number];
  /** False leaves the arc open and caps both ends. Defaults to a full wrap. */
  closed?: boolean;
  /** Rings along the outer surface. */
  segments?: number;
  /** Samples around the arc. */
  radial?: number;
  /** Rings along the (never-seen) inner surface. Kept low on purpose. */
  lining?: number;
  fromEdge?: EdgeStyle;
  toEdge?: EdgeStyle;
  drape?: DrapeOptions;
  /**
   * Which body volumes the surface follows. Default: all of them.
   *
   * This is the answer to the field's one structural inconvenience: a hanging
   * arm is *fused* to the ribcage in the implicit body, so a ray fired sideways
   * from the spine exits on the outside of the biceps and a shirt built from it
   * swallows the arm. Following the trunk alone puts the cloth back on the ribs.
   */
  follow?: (bone: BoneName) => boolean;
  /**
   * How far the cloth may be lifted past the followed surface to ride over a
   * volume that is not followed, in metres.
   *
   * The shoulder of a sleeveless top has to cap the deltoid, which belongs to
   * the arm; below the armpit the same cloth must stay on the ribs. So this is
   * normally a profile that opens up above the armpit and closes below it. It
   * never lifts past the *real* body surface, so it cannot float.
   */
  bridge?: RadialProfile;
  /** Hard ceiling on the traced radius — see `torsoEnvelope`. */
  maxRadius?: RadialProfile;
  /**
   * Half-space the finished cloth is pressed into: a trouser inseam, or the
   * ground plane under a shoe.
   *
   * Compressed rather than projected. Projecting stacks every offending vertex
   * onto one plane, and a row of coincident vertices has no surface normal — it
   * renders as a torn black sliver. `softness` is the width of the squeeze, so
   * the surface flattens against the plane and stays a surface.
   */
  keepSide?: { normal: THREE.Vector3; d: number; softness?: number };
  front?: THREE.Vector3;
  left?: THREE.Vector3;
  /** Metres of cloth per texture tile, so the weave lands at physical scale. */
  tileMetres?: number;
}

/** A finished boundary of a shell, ready to hand to `buildBand` as a collar or trim. */
export interface Boundary {
  points: THREE.Vector3[];
  /** Outward radial direction at each point. */
  normals: THREE.Vector3[];
  /** Arc parameter of each point, for slicing out one lapel or one cuff. */
  u: number[];
  angle: number[];
}

export interface ShellResult {
  geometry: THREE.BufferGeometry;
  from: Boundary;
  to: Boundary;
}

const WORLD_FRONT = new THREE.Vector3(0, 0, 1);
const WORLD_LEFT = new THREE.Vector3(1, 0, 0);

export function buildShell(body: GarmentBody, o: ShellOptions): ShellResult {
  const axis = o.axis;
  const arc = o.arc ?? [0, Math.PI * 2];
  const closed = o.closed ?? Math.abs(arc[1] - arc[0]) >= Math.PI * 2 - 1e-6;
  const N = Math.max(6, o.radial ?? 48);
  const Ro = Math.max(3, o.segments ?? 20);
  const Ri = Math.max(2, o.lining ?? 5);
  const cloth = o.cloth ?? CLOTH;
  const lo = edgeStyle(o.fromEdge, cloth);
  const hi = edgeStyle(o.toEdge, cloth);
  const front = o.front ?? WORLD_FRONT;
  const left = o.left ?? WORLD_LEFT;
  const tile = o.tileMetres ?? 0.25;
  const maxR = body.metrics.height * 0.42;
  const subset = o.follow ? primSubset(body.plan, o.follow) : null;

  const drape = o.drape
    ? drapeField({
        folds: o.drape.folds ?? 6,
        amplitude: o.drape.amplitude ?? 0.004,
        along: o.drape.along ?? 2,
        seed: o.drape.seed ?? 1,
      })
    : null;
  const sag = o.drape?.sag ?? 0;

  // --- cross-section loop --------------------------------------------------
  // One closed polygon in (axis-param, radial-offset), swept around the arc.
  // Because it closes, the shell is a solid with its hems built in rather than
  // a sheet that needs a separate backface pass.
  interface Node { mix: number; abs: number; dr: number; outer: boolean }
  const nodes: Node[] = [];
  const dsLo = lo.fold / axis.length;
  const dsHi = hi.fold / axis.length;

  for (let i = 0; i < Ro; i++) nodes.push({ mix: i / (Ro - 1), abs: 0, dr: 0, outer: true });
  for (let j = 1; j <= hi.rings; j++) {
    const phi = (Math.PI * j) / hi.rings;
    nodes.push({
      mix: 1,
      abs: (-dsHi * (1 - Math.cos(phi))) / 2,
      dr: hi.roll * Math.sin(phi) - (cloth * (1 - Math.cos(phi))) / 2,
      outer: false,
    });
  }
  for (let k = 1; k <= Ri; k++) {
    const a = k / Ri;
    nodes.push({ mix: 1 - a, abs: -dsHi * (1 - a) + dsLo * a, dr: -cloth, outer: false });
  }
  for (let mIdx = 1; mIdx < lo.rings; mIdx++) {
    const phi = Math.PI * (1 - mIdx / lo.rings);
    nodes.push({
      mix: 0,
      abs: (dsLo * (1 - Math.cos(phi))) / 2,
      dr: lo.roll * Math.sin(phi) - (cloth * (1 - Math.cos(phi))) / 2,
      outer: false,
    });
  }
  const M = nodes.length;

  // --- sweep ---------------------------------------------------------------
  const pos = new Float32Array(M * N * 3);
  const uv = new Float32Array(M * N * 2);
  const radial = new Float32Array(M * N * 3);
  const P = new THREE.Vector3();
  const T = new THREE.Vector3();
  const ef = new THREE.Vector3();
  const el = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const vtx = new THREE.Vector3();
  const skin = new THREE.Vector3();
  const nrm = new THREE.Vector3();

  const fromB: Boundary = { points: [], normals: [], u: [], angle: [] };
  const toB: Boundary = { points: [], normals: [], u: [], angle: [] };

  // Arc length around, measured on the outer surface at mid-height, so the
  // weave is the same size on a wrist wrap and on a trouser leg.
  const around = new Float32Array(N);
  const ringMid = new THREE.Vector3();
  const ringPrev = new THREE.Vector3();

  for (let jj = 0; jj < N; jj++) {
    // A closed shell must not repeat its first column, so the last sample stops
    // one step short of the full turn and the wrap quad closes the gap.
    const u = closed ? jj / N : jj / (N - 1);
    const angle = THREE.MathUtils.lerp(arc[0], arc[1], u);
    const s0 = THREE.MathUtils.clamp(edgeAt(o.from, u, angle), 0, 1);
    const s1 = THREE.MathUtils.clamp(edgeAt(o.to, u, angle), 0, 1);

    for (let i = 0; i < M; i++) {
      const nd = nodes[i];
      const s = THREE.MathUtils.clamp(THREE.MathUtils.lerp(s0, s1, nd.mix) + nd.abs, 0, 1);
      axis.pointAt(s, P);
      axis.tangentAt(s, T);
      angularFrame(T, front, left, ef, el);
      dir.copy(ef).multiplyScalar(Math.cos(angle)).addScaledVector(el, Math.sin(angle));

      let r = traceOffset(body.plan, P, dir, 0, maxR, subset);
      let grad = subset;
      if (subset && o.bridge !== undefined) {
        const bridge = radialAt(o.bridge, s, u, angle);
        if (bridge > 0) {
          const rFull = traceOffset(body.plan, P, dir, 0, maxR, null);
          // Either the real body surface is within reach, in which case the cloth
          // lies on it, or it is not and the cloth spans the gap at the limit of
          // what the garment allows.
          if (rFull <= r + bridge) {
            r = rFull;
            grad = null;
          } else r += bridge;
        }
      }
      if (o.maxRadius !== undefined) r = Math.min(r, radialAt(o.maxRadius, s, u, angle));
      skin.copy(P).addScaledVector(dir, Math.max(r, 0.001));
      if (!surfaceNormal(body.plan, skin, grad, nrm)) nrm.copy(dir);

      let lift = radialAt(o.offset, s, u, angle) + nd.dr;
      if (drape) lift += drape(u, nd.mix);
      // Cloth is heavier than it is stiff: it stands off the body a little more
      // where gravity pulls it away from the form than where it lies on it.
      if (sag > 0) lift += sag * Math.max(0, -nrm.y) * nd.mix;
      vtx.copy(skin).addScaledVector(nrm, lift);
      if (o.keepSide) {
        const k = o.keepSide.softness ?? 0.005;
        const t = vtx.dot(o.keepSide.normal) - o.keepSide.d;
        // Softplus: flattens toward the plane, never onto it.
        const soft = t > 6 * k ? t : k * Math.log(1 + Math.exp(t / k));
        vtx.addScaledVector(o.keepSide.normal, soft - t);
      }

      const b = (i * N + jj) * 3;
      pos[b] = vtx.x; pos[b + 1] = vtx.y; pos[b + 2] = vtx.z;
      radial[b] = nrm.x; radial[b + 1] = nrm.y; radial[b + 2] = nrm.z;
      uv[(i * N + jj) * 2 + 1] = (s * axis.length) / tile;

      if (i === 0) {
        fromB.points.push(vtx.clone());
        fromB.normals.push(nrm.clone());
        fromB.u.push(u);
        fromB.angle.push(angle);
        ringMid.copy(vtx);
      }
      if (i === Ro - 1) {
        toB.points.push(vtx.clone());
        toB.normals.push(nrm.clone());
        toB.u.push(u);
        toB.angle.push(angle);
      }
    }
    around[jj] = jj === 0 ? 0 : around[jj - 1] + ringMid.distanceTo(ringPrev);
    ringPrev.copy(ringMid);
  }
  for (let jj = 0; jj < N; jj++)
    for (let i = 0; i < M; i++) uv[(i * N + jj) * 2] = around[jj] / tile;

  // --- faces ---------------------------------------------------------------
  const tris: number[] = [];
  const cols = closed ? N : N - 1;
  for (let jj = 0; jj < cols; jj++) {
    const j0 = jj;
    const j1 = (jj + 1) % N;
    for (let i = 0; i < M; i++) {
      const i1 = (i + 1) % M;
      const a = i * N + j0;
      const b = i1 * N + j0;
      const c = i1 * N + j1;
      const d = i * N + j1;
      tris.push(a, b, c, a, c, d);
    }
  }

  const verts = M * N;
  const posList = Array.from(pos);
  const uvList = Array.from(uv);

  // Open arcs need their two cut ends closed or the ink pass finds a hole. A
  // centroid fan is exact enough: the cross-section is a long thin loop, so the
  // cap is a few millimetres of geometry seen almost edge-on.
  if (!closed) {
    for (const [jj, flip] of [[0, true], [N - 1, false]] as [number, boolean][]) {
      const cx = new THREE.Vector3();
      for (let i = 0; i < M; i++) cx.add(new THREE.Vector3(pos[(i * N + jj) * 3], pos[(i * N + jj) * 3 + 1], pos[(i * N + jj) * 3 + 2]));
      cx.multiplyScalar(1 / M);
      const centre = posList.length / 3;
      posList.push(cx.x, cx.y, cx.z);
      uvList.push(uvList[(0 * N + jj) * 2], uvList[(0 * N + jj) * 2 + 1]);
      for (let i = 0; i < M; i++) {
        const a = i * N + jj;
        const b = ((i + 1) % M) * N + jj;
        if (flip) tris.push(centre, b, a);
        else tris.push(centre, a, b);
      }
    }
  }

  // The winding of a swept grid depends on the sign of the cross-section's
  // traversal, which is easy to reason about wrongly and impossible to see
  // until the ink outline inverts. Settle it by measuring against the radial
  // direction on the outer run instead.
  let agree = 0;
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const fn = new THREE.Vector3();
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t];
    if (a >= verts || Math.floor(a / N) >= Ro - 1) continue;
    const b = tris[t + 1];
    const c = tris[t + 2];
    if (b >= verts || c >= verts) continue;
    ab.set(posList[b * 3] - posList[a * 3], posList[b * 3 + 1] - posList[a * 3 + 1], posList[b * 3 + 2] - posList[a * 3 + 2]);
    ac.set(posList[c * 3] - posList[a * 3], posList[c * 3 + 1] - posList[a * 3 + 1], posList[c * 3 + 2] - posList[a * 3 + 2]);
    fn.crossVectors(ab, ac);
    agree += fn.dot(new THREE.Vector3(radial[a * 3], radial[a * 3 + 1], radial[a * 3 + 2])) > 0 ? 1 : -1;
  }
  if (agree < 0) for (let t = 0; t < tris.length; t += 3) {
    const tmp = tris[t + 1];
    tris[t + 1] = tris[t + 2];
    tris[t + 2] = tmp;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(posList, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvList, 2));
  geometry.setIndex(tris);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return { geometry, from: fromB, to: toB };
}

/**
 * One angular stretch of a boundary, for a trim that runs along part of an edge.
 *
 * Sorted by the unwrapped angle: a slice that straddles the front seam of a
 * closed shell (`-62°` to `+75°`, say) arrives out of order otherwise, and a
 * band swept along it doubles back on itself.
 */
export function sliceBoundary(b: Boundary, fromDeg: number, toDeg: number): Boundary {
  const a0 = THREE.MathUtils.degToRad(fromDeg);
  const a1 = THREE.MathUtils.degToRad(toDeg);
  const keep: number[] = [];
  const adj: number[] = [];
  for (let i = 0; i < b.angle.length; i++) {
    let a = b.angle[i];
    while (a < a0 - 1e-6) a += Math.PI * 2;
    while (a > a0 + Math.PI * 2 - 1e-6) a -= Math.PI * 2;
    if (a < a0 - 1e-6 || a > a1 + 1e-6) continue;
    keep.push(i);
    adj.push(a);
  }
  const order = keep.map((_, k) => k).sort((x, y) => adj[x] - adj[y]);
  return {
    points: order.map((k) => b.points[keep[k]]),
    normals: order.map((k) => b.normals[keep[k]]),
    u: order.map((k) => b.u[keep[k]]),
    angle: order.map((k) => adj[k]),
  };
}

/**
 * A curve lying on an offset surface: collar edges, spiral wraps, straps.
 *
 * Parametrised by an arbitrary path through (axis position, angle), which is
 * what makes one function cover a horizontal waistband, a helix up a calf and a
 * strap across an instep.
 */
export function surfaceCurve(
  body: GarmentBody,
  o: {
    axis: Axis;
    samples: number;
    /** Axis parameter at path position t. */
    s: (t: number) => number;
    /** Angle in radians at path position t. */
    angle: (t: number) => number;
    offset: RadialProfile;
    front?: THREE.Vector3;
    left?: THREE.Vector3;
    follow?: (bone: BoneName) => boolean;
    maxRadius?: RadialProfile;
  },
): Boundary {
  const front = o.front ?? WORLD_FRONT;
  const left = o.left ?? WORLD_LEFT;
  const maxR = body.metrics.height * 0.42;
  const subset = o.follow ? primSubset(body.plan, o.follow) : null;
  const out: Boundary = { points: [], normals: [], u: [], angle: [] };
  const P = new THREE.Vector3();
  const T = new THREE.Vector3();
  const ef = new THREE.Vector3();
  const el = new THREE.Vector3();
  for (let i = 0; i < o.samples; i++) {
    const t = i / (o.samples - 1);
    const s = THREE.MathUtils.clamp(o.s(t), 0, 1);
    const angle = o.angle(t);
    o.axis.pointAt(s, P);
    o.axis.tangentAt(s, T);
    angularFrame(T, front, left, ef, el);
    const dir = ef.clone().multiplyScalar(Math.cos(angle)).addScaledVector(el, Math.sin(angle));
    let r = traceOffset(body.plan, P, dir, 0, maxR, subset);
    if (o.maxRadius !== undefined) r = Math.min(r, radialAt(o.maxRadius, s, t, angle));
    const skin = P.clone().addScaledVector(dir, Math.max(r, 0.001));
    const nrm = new THREE.Vector3();
    if (!surfaceNormal(body.plan, skin, subset, nrm)) nrm.copy(dir);
    out.points.push(skin.addScaledVector(nrm, radialAt(o.offset, s, t, angle)));
    out.normals.push(nrm);
    out.u.push(t);
    out.angle.push(angle);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bands: collars, cuffs, trims, sashes, ties
// ---------------------------------------------------------------------------

export interface BandOptions {
  /** Ribbon width in metres, or a profile along it for a tapered tie. */
  width: number | ((t: number) => number);
  /** Ribbon thickness. */
  thickness?: number;
  /** How far the band stands off the curve it follows. */
  lift?: number;
  /** Samples around the cross-section. 10 gives a readable rolled edge. */
  sides?: number;
  closed?: boolean;
  /** Radians of twist accumulated from one end to the other. */
  twist?: number;
  tileMetres?: number;
}

/**
 * A solid ribbon swept along a curve, with rounded (finished) long edges.
 *
 * Every trim in a costume is this: a collar band, a cuff, a criss-cross ankle
 * wrap, an obi tail. The cross-section is a superellipse rather than a
 * rectangle so the long edges catch a highlight — a flat strip with square
 * corners reads as a decal even when it has real thickness.
 */
export function buildBand(curve: Boundary, o: BandOptions): THREE.BufferGeometry {
  const n = curve.points.length;
  if (n < 2) return new THREE.BufferGeometry();
  const K = Math.max(6, o.sides ?? 10);
  const th = o.thickness ?? CLOTH * 1.2;
  const lift = o.lift ?? 0;
  const closed = o.closed ?? false;
  const tile = o.tileMetres ?? 0.18;
  const widthAt = typeof o.width === 'number' ? () => o.width as number : o.width;

  // Superelliptic cross-section: |x|^4 + |y|^4 = 1 in normalised coordinates.
  const secX: number[] = [];
  const secY: number[] = [];
  for (let k = 0; k < K; k++) {
    const a = (Math.PI * 2 * k) / K;
    const c = Math.cos(a);
    const s = Math.sin(a);
    secX.push(Math.sign(c) * Math.abs(c) ** 0.5);
    secY.push(Math.sign(s) * Math.abs(s) ** 0.5);
  }

  const pos: number[] = [];
  const uv: number[] = [];
  const T = new THREE.Vector3();
  const Nv = new THREE.Vector3();
  const B = new THREE.Vector3();
  let run = 0;

  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = curve.points[Math.max(0, i - 1)];
    const b = curve.points[Math.min(n - 1, i + 1)];
    T.subVectors(b, a);
    if (T.lengthSq() < 1e-12) T.set(0, 1, 0);
    T.normalize();
    Nv.copy(curve.normals[i]).addScaledVector(T, -curve.normals[i].dot(T));
    if (Nv.lengthSq() < 1e-9) Nv.set(0, 0, 1).addScaledVector(T, -T.z);
    Nv.normalize();
    B.crossVectors(T, Nv).normalize();

    const tw = (o.twist ?? 0) * t;
    const ct = Math.cos(tw);
    const st = Math.sin(tw);
    const halfW = widthAt(t) * 0.5;
    const centre = curve.points[i].clone().addScaledVector(Nv, lift + th * 0.5);
    if (i > 0) run += curve.points[i].distanceTo(curve.points[i - 1]);

    for (let k = 0; k < K; k++) {
      // Cross-section axes rotate with the twist, which is what stops two
      // hanging ends from reading as identical planks.
      const wx = secX[k] * halfW;
      const wy = secY[k] * th * 0.5;
      const bx = wx * ct - wy * st;
      const ny = wx * st + wy * ct;
      const p = centre.clone().addScaledVector(B, bx).addScaledVector(Nv, ny);
      pos.push(p.x, p.y, p.z);
      uv.push((k / K) * ((halfW * 2 + th * 2) / tile), run / tile);
    }
  }

  const tris: number[] = [];
  const rows = closed ? n : n - 1;
  for (let i = 0; i < rows; i++) {
    const r0 = i * K;
    const r1 = ((i + 1) % n) * K;
    for (let k = 0; k < K; k++) {
      const k1 = (k + 1) % K;
      tris.push(r0 + k, r1 + k, r1 + k1, r0 + k, r1 + k1, r0 + k1);
    }
  }
  if (!closed) {
    for (const [row, flip] of [[0, true], [n - 1, false]] as [number, boolean][]) {
      const cx = new THREE.Vector3();
      for (let k = 0; k < K; k++) cx.add(new THREE.Vector3(pos[(row * K + k) * 3], pos[(row * K + k) * 3 + 1], pos[(row * K + k) * 3 + 2]));
      cx.multiplyScalar(1 / K);
      const c = pos.length / 3;
      pos.push(cx.x, cx.y, cx.z);
      uv.push(uv[(row * K) * 2], uv[(row * K) * 2 + 1]);
      for (let k = 0; k < K; k++) {
        const a = row * K + k;
        const b = row * K + ((k + 1) % K);
        if (flip) tris.push(c, b, a);
        else tris.push(c, a, b);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(tris);
  g.computeVertexNormals();
  // Sweeping around a curve can wind either way depending on the handedness of
  // the transported frame; measure once against the surface normal we were
  // handed rather than trusting it.
  const nrm = g.getAttribute('normal');
  let agree = 0;
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 8))) {
    const k = i * K;
    agree += nrm.getX(k) * curve.normals[i].x + nrm.getY(k) * curve.normals[i].y + nrm.getZ(k) * curve.normals[i].z > 0 ? 1 : -1;
  }
  if (agree < 0) {
    const idx = g.getIndex()!;
    const arr = idx.array as Uint32Array | Uint16Array;
    for (let t = 0; t < arr.length; t += 3) {
      const tmp = arr[t + 1];
      arr[t + 1] = arr[t + 2];
      arr[t + 2] = tmp;
    }
    g.computeVertexNormals();
  }
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------
// Free-hanging cloth
// ---------------------------------------------------------------------------

export interface StrandOptions {
  /** Where the strand leaves the garment, in rest world space. */
  from: THREE.Vector3;
  /** Direction it leaves in. Gravity takes over from there. */
  dir: THREE.Vector3;
  length: number;
  segments?: number;
  /** 0 hangs dead vertical, 1 keeps the launch direction all the way down. */
  stiffness?: number;
  /** Constant sideways push — what keeps two tails of one knot from being clones. */
  bias?: THREE.Vector3;
  /** Amplitude of the standing wave baked into the tail, in metres. */
  flutter?: number;
  /** Waves along the tail. */
  waves?: number;
  /** Keep this far clear of the body surface. */
  clearance?: number;
  seed?: number;
}

/**
 * A hanging tie, sash end or hood fold, relaxed to rest.
 *
 * A verlet strand solved to convergence and then baked. Simulating it at
 * runtime is a later problem; what matters now is that the *static* drape is
 * plausible, because a tail modelled as a straight tapered box is the single
 * most obvious sign that a costume was built rather than worn. Gravity, a
 * stiffness term and body collision do that work; `flutter` then adds the
 * out-of-plane wave that makes cloth read as cloth in silhouette.
 *
 * Deterministic: the seed drives a hash, never `Math.random`, so the same
 * costume is byte-identical between runs.
 */
export function bakeStrand(body: GarmentBody, o: StrandOptions): Boundary {
  const n = Math.max(4, o.segments ?? 18);
  const seg = o.length / (n - 1);
  const stiff = THREE.MathUtils.clamp(o.stiffness ?? 0.35, 0, 1);
  const clearance = o.clearance ?? 0.006;
  const bias = o.bias ?? new THREE.Vector3();
  const dir = o.dir.clone().normalize();

  const p: THREE.Vector3[] = [];
  const prev: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    p.push(o.from.clone().addScaledVector(dir, seg * i));
    prev.push(p[i].clone());
  }

  const g = new THREE.Vector3();
  const step = 0.0016;
  for (let iter = 0; iter < 260; iter++) {
    for (let i = 1; i < n; i++) {
      const vx = (p[i].x - prev[i].x) * 0.92;
      const vy = (p[i].y - prev[i].y) * 0.92;
      const vz = (p[i].z - prev[i].z) * 0.92;
      prev[i].copy(p[i]);
      p[i].x += vx + bias.x * step;
      p[i].y += vy - step;
      p[i].z += vz + bias.z * step;
    }
    for (let k = 0; k < 6; k++) {
      p[0].copy(o.from);
      for (let i = 1; i < n; i++) {
        const d = p[i].clone().sub(p[i - 1]);
        const len = d.length() || 1e-9;
        d.multiplyScalar((len - seg) / len);
        // The anchor cannot move, so the first link's whole correction goes into
        // the free end; sharing it there would let the strand stretch.
        if (i === 1) {
          p[i].sub(d);
        } else {
          p[i].addScaledVector(d, -0.5);
          p[i - 1].addScaledVector(d, 0.5);
        }
      }
      if (stiff > 0) {
        for (let i = 2; i < n; i++) {
          const t = p[i - 1].clone().sub(p[i - 2]).normalize().multiplyScalar(seg).add(p[i - 1]);
          p[i].lerp(t, stiff * 0.35);
        }
      }
    }
    if (iter % 3 === 0) {
      for (let i = 1; i < n; i++) {
        const f = fieldAt(body.plan, p[i].x, p[i].y, p[i].z);
        if (f >= clearance) continue;
        const h = 0.004;
        g.set(
          fieldAt(body.plan, p[i].x + h, p[i].y, p[i].z) - fieldAt(body.plan, p[i].x - h, p[i].y, p[i].z),
          fieldAt(body.plan, p[i].x, p[i].y + h, p[i].z) - fieldAt(body.plan, p[i].x, p[i].y - h, p[i].z),
          fieldAt(body.plan, p[i].x, p[i].y, p[i].z + h) - fieldAt(body.plan, p[i].x, p[i].y, p[i].z - h),
        );
        const gl = g.length();
        if (gl < 1e-9) continue;
        p[i].addScaledVector(g, (clearance - f) / gl);
      }
    }
  }

  // Out-of-plane wave. Applied after relaxation because the solver would just
  // pull it straight again — this is the shape a moving tail settles into, not
  // one gravity produces.
  const hash = (x: number) => {
    const v = Math.sin(x * 78.233 + (o.seed ?? 0) * 12.9898) * 43758.5453;
    return v - Math.floor(v);
  };
  const amp = o.flutter ?? 0;
  const waves = o.waves ?? 1.4;
  const phase = hash(3) * Math.PI * 2;
  const normals: THREE.Vector3[] = [];
  const T = new THREE.Vector3();
  const ref = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < n; i++) {
    T.subVectors(p[Math.min(n - 1, i + 1)], p[Math.max(0, i - 1)]);
    if (T.lengthSq() < 1e-12) T.set(0, -1, 0);
    T.normalize();
    const nrm = ref.clone().addScaledVector(T, -ref.dot(T));
    if (nrm.lengthSq() < 1e-9) nrm.set(1, 0, 0).addScaledVector(T, -T.x);
    nrm.normalize();
    normals.push(nrm);
    if (amp > 0) {
      const t = i / (n - 1);
      const side = new THREE.Vector3().crossVectors(T, nrm);
      p[i].addScaledVector(side, amp * t * t * Math.sin(t * Math.PI * 2 * waves + phase));
    }
  }
  return { points: p, normals, u: p.map((_, i) => i / (n - 1)), angle: p.map(() => 0) };
}

// ---------------------------------------------------------------------------
// Attachment
// ---------------------------------------------------------------------------

/**
 * Bind every vertex to one bone.
 *
 * The body's field weighting is right for cloth that lies on a limb and wrong
 * for cloth that has left it: a sash end hanging in front of a thigh is nearest
 * to that thigh and would be skinned to it, so a step forward would swing the
 * knot with the leg. Anything free-hanging binds rigidly to what it is tied to.
 */
export function bindRigid(geometry: THREE.BufferGeometry, bone: BoneName): void {
  const idx = BONES.indexOf(bone);
  if (idx < 0) throw new Error(`bindRigid: unknown bone ${bone}`);
  const n = geometry.getAttribute('position').count;
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    si[i * 4] = idx;
    sw[i * 4] = 1;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
}

/**
 * Concatenates garment parts that share a material into one mesh.
 *
 * Worth doing for two separate reasons. Draw calls: every attached part is also
 * an inverted-hull ink shell, so a costume of thirty pieces is sixty draws per
 * fighter and there are two fighters. And skin weights: `computeSkinWeights`
 * diffuses over the surface graph for fourteen passes, which is the single most
 * expensive thing in a costume build, so a pass over one merged buffer beats six
 * passes over six small ones.
 *
 * Requires the same attribute set on every part, which everything in this file
 * produces: position, normal, uv, and an index.
 */
export function mergeGeometry(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const live = parts.filter((g) => g.getAttribute('position')?.count);
  if (live.length === 1) return live[0];
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let base = 0;
  for (const g of live) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const t = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      uv.push(t.getX(i), t.getY(i));
    }
    const ix = g.getIndex()!;
    for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + base);
    base += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}

export interface GarmentPiece {
  name: string;
  geometry: THREE.BufferGeometry;
  kind: SurfaceKind;
  color: THREE.ColorRepresentation;
  /**
   * Generated maps. Its `tileMetres` must match the shell's or the weave lies
   * about its own scale.
   *
   * Only the **normal** half is wired up. `ToonMaterial.uMap` is a
   * *multiplicative* detail slot (`base *= detail`), and the fabric library's
   * albedo already carries the palette colour — feeding it in would square the
   * dye and turn navy into black. Under a two-to-four band cel ramp the weave
   * reads through the shading break anyway, which is the normal's job; pass
   * `detail` explicitly if you have a map centred on white.
   */
  tex?: TexSet;
  /** A multiplicative detail map centred on white, if you have one. */
  detail?: THREE.Texture | null;
  /** Rigid-bind to this bone instead of using the body's field weighting. */
  bind?: BoneName;
  shadowColor?: THREE.ColorRepresentation;
  rimColor?: THREE.ColorRepresentation;
  outlineWidth?: number;
  specular?: number;
  normalScale?: number;
}

export interface BuiltCostume {
  meshes: THREE.SkinnedMesh[];
  materials: THREE.Material[];
  triangles: number;
}

export function emptyCostume(): BuiltCostume {
  return { meshes: [], materials: [], triangles: 0 };
}

/** Builds the material, skins the geometry and hangs it off the fighter's skeleton. */
export function attachGarment(
  rig: BuiltCharacter,
  piece: GarmentPiece,
  into: BuiltCostume,
): THREE.SkinnedMesh {
  const mat = createToonMaterial({
    kind: piece.kind,
    color: piece.color,
    shadowColor: piece.shadowColor,
    rimColor: piece.rimColor ?? rig.def.palette.rim,
    map: piece.detail ?? null,
    normalMap: piece.tex?.normalMap ?? null,
    normalScale: piece.normalScale ?? 1,
    outlineWidth: piece.outlineWidth,
    specular: piece.specular,
    skinned: true,
  });
  if (piece.bind) bindRigid(piece.geometry, piece.bind);
  const mesh = rig.attachSkinnedPart(piece.geometry, mat as THREE.Material, `${rig.def.id}:${piece.name}`);
  into.meshes.push(mesh);
  into.materials.push(mat as THREE.Material);
  const idx = piece.geometry.getIndex();
  into.triangles += idx ? idx.count / 3 : 0;
  return mesh;
}
