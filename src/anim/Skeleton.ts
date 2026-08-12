import * as THREE from 'three';
import { BONES, type BoneName, type Pose } from './contract';
import type { FighterDef } from '../data/roster';

/**
 * The procedural skeleton.
 *
 * Every fighter shares one bone list (`BONES`), so a pose authored against Kai
 * plays on Vera. What differs is the *metrics*: bone lengths and joint offsets
 * are derived from `def.proportions` and nothing is hardcoded per fighter.
 *
 * ## Conventions the rest of the codebase relies on
 *
 * - **Rest rotation is identity on every bone.** The A-pose lives entirely in
 *   the joint offsets. This is the single most important decision in this file:
 *   it means a pose channel like `upperArmR.rot = [0, 0, 0.4]` means the same
 *   thing on every fighter *and* is expressed in world-aligned axes, so hand
 *   authoring a KOF-style pose in code is possible without a viewport. For any
 *   limb hanging down: **-X swings it forward, +X back**; **+Z abducts the
 *   character's left limb and adducts the right** (they mirror); Y is twist.
 *   So an elbow flexes with a negative X on the forearm and a knee with a
 *   positive X on the shin.
 * - **The character faces +Z at rest**, +X is the character's own left, +Y up,
 *   and the origin sits on the floor between the feet. Gameplay yaws the rig
 *   root by ±90° to face along the fight line; it never mirrors scale, because
 *   negative scale flips face winding and breaks the ink outline.
 * - The A-pose abduction is deliberately shallow (~19°). A wide A-pose skins
 *   better but makes every authored arm rotation carry a correction term; a
 *   shallow one keeps arm bones close to vertical so world-aligned rotation
 *   axes stay intuitive, and the mesh builder is ours so we can guarantee
 *   armpit clearance instead of buying it with pose angle.
 */

/**
 * Bounds on the rest arm spread, which is **derived per fighter**, not fixed.
 *
 * It used to be one constant, and that single number was the largest reason the
 * roster measured as one body: lateral hand position is `armJointX +
 * armLen·sin(spread)`, `armLen` is a fixed fraction of height and `armJointX`
 * is `shoulderHalf − 0.92·deltoidR`, in which a wider shoulder and the bigger
 * deltoid that comes with it cancel. Every fighter's hands therefore landed at
 * the same fraction of their own height and the widest measurement on the
 * figure — which is what a width/height ratio reads — was identical by
 * construction.
 *
 * Anatomically the angle is not free anyway: a fighter carries the arms as far
 * out as their own lat and thigh mass forces them to, so `rigMetrics` solves
 * for the spread that clears the thigh by a fixed margin. Vera ends up carrying
 * her arms visibly wider than Davi because she is visibly thicker, and the
 * "hands merged into the thighs" defect from review 001 cannot come back
 * without the clearance term being changed on purpose.
 *
 * The cost is that rest arm direction is no longer identical across fighters,
 * so an authored absolute arm rotation puts two fighters' fists in slightly
 * different places. That is the same trade already accepted for limb length,
 * and the identity-rest-rotation convention above is untouched.
 */
const A_POSE_ABDUCTION_MIN = 0.16;
const A_POSE_ABDUCTION_MAX = 0.46;
/** Forearm carries a touch less spread than the upper arm, as a real arm hangs. */
const A_POSE_FOREARM_RATIO = 0.88;
/** Elbows and knees are never dead straight at rest, or IK has no pole to pick. */
const ELBOW_PREBEND = 0.07;
const KNEE_PREBEND = 0.045;

export const BONE_PARENT: Record<BoneName, BoneName | null> = {
  root: null,
  hips: 'root',
  spine: 'hips',
  chest: 'spine',
  neck: 'chest',
  head: 'neck',
  shoulderL: 'chest',
  upperArmL: 'shoulderL',
  forearmL: 'upperArmL',
  handL: 'forearmL',
  shoulderR: 'chest',
  upperArmR: 'shoulderR',
  forearmR: 'upperArmR',
  handR: 'forearmR',
  thighL: 'hips',
  shinL: 'thighL',
  footL: 'shinL',
  toeL: 'footL',
  thighR: 'hips',
  shinR: 'thighR',
  footR: 'shinR',
  toeR: 'footR',
};

/** Bones whose children continue the chain, used for limb-aware skin weighting. */
export const BONE_CHILDREN: Record<BoneName, BoneName[]> = (() => {
  const out = {} as Record<BoneName, BoneName[]>;
  for (const b of BONES) out[b] = [];
  for (const b of BONES) {
    const p = BONE_PARENT[b];
    if (p) out[p].push(b);
  }
  return out;
})();

/**
 * Every measurement the body builder needs, in metres, derived once from the
 * fighter definition. Nothing downstream may re-derive proportions — if a number
 * is missing here, add it here.
 */
export interface RigMetrics {
  def: FighterDef;
  height: number;
  /** 0 = lean, 1 = heavily built. Straight from the data. */
  build: number;
  /**
   * 0 = male silhouette, 1 = female. Authored in `Proportions`, not inferred
   * from hip:shoulder — see the note there for why the inference had to go.
   */
  fem: number;
  /** Chin to crown. */
  headLen: number;
  neckLen: number;
  /** Floor to hip joint. */
  legLen: number;
  /** Hip joint to the base of the neck. */
  torsoLen: number;
  /** World Y of the top of the shoulders (C7). */
  neckBaseY: number;
  ankleY: number;
  footLen: number;
  /** Half the outer-deltoid silhouette width — what an artist means by shoulders. */
  shoulderHalf: number;
  /** Half the hip silhouette width, glutes included. */
  hipHalf: number;
  /** Half the ribcage width at the widest rib. */
  chestHalf: number;
  /** Half the waist width at the narrowest point. */
  waistHalf: number;
  /** How deep the torso is relative to its width. */
  torsoDepth: number;
  upperArmR: number;
  deltoidR: number;
  forearmR: number;
  wristR: number;
  thighR: number;
  kneeR: number;
  calfR: number;
  ankleR: number;
  neckR: number;
  skullR: number;
  handLen: number;
  upperArmLen: number;
  forearmLen: number;

  // --- Rest carriage, solved rather than authored -----------------------------
  /** Upper-arm abduction at rest, radians from vertical. See the bounds above. */
  armSpread: number;
  /** Forearm abduction at rest. */
  foreSpread: number;
  /** Half the distance between the two hip joints. */
  hipJointX: number;

  // --- Hand ------------------------------------------------------------------
  /**
   * Half the palm width across the knuckles.
   *
   * Hands are built ~15% over anatomical on purpose. A fighting-game camera
   * puts a fighter at 450–900 px and the hand is what the player's eye tracks;
   * at anatomical scale four fingers are 2 px each and the only honest choice
   * is a mitten. Oversized, the same four fingers are 4–5 px and separate.
   */
  palmHalf: number;
  /** Half the palm thickness, front to back. */
  palmThick: number;
  /** Radius of one finger at its knuckle. */
  fingerR: number;

  // --- Foot ------------------------------------------------------------------
  /** Half the foot width at the ball. */
  footHalf: number;
  /** Radius of the heel mass. */
  heelR: number;
  /** Toes, from the ball of the foot to the tip. */
  toeLen: number;
  /** Half the distance between the two ankles at rest. */
  ankleX: number;
}

export function rigMetrics(def: FighterDef): RigMetrics {
  const p = def.proportions;
  const H = p.height;
  const build = p.build;
  const fem = p.fem;

  const headLen = H * p.headRatio;
  // Heavy fighters have short necks, and the neck is a surprisingly loud read:
  // it is the only vertical gap between two big masses in the silhouette.
  const neckLen = H * (0.048 - 0.012 * build);
  const legLen = H * p.legRatio;
  const neckBaseY = H - headLen - neckLen;
  const torsoLen = neckBaseY - legLen;

  const shoulderHalf = H * p.shoulder * 0.5;
  const hipHalf = H * p.hip * 0.5;

  // Limb girths. These carry most of `build`, and the coefficients are roughly
  // double what they were: the old 0.0225 + 0.0185·build put Vera's arm 23%
  // thicker than Davi's, and the design sheets show more like 50%. The constant
  // term is the skeleton plus skin, the build term is the muscle.
  const upperArmR = H * (0.017 + 0.03 * build) * (1 - 0.06 * fem);
  const deltoidR = upperArmR * (1.3 + 0.3 * build);
  const forearmR = upperArmR * (0.86 + 0.1 * build);
  const wristR = upperArmR * (0.58 - 0.04 * fem);
  const thighR = H * (0.0335 + 0.0255 * build) * (1 + 0.05 * fem);
  const kneeR = thighR * (0.66 - 0.06 * build);
  const calfR = thighR * (0.62 + 0.05 * build);
  const ankleR = thighR * (0.38 - 0.04 * build);

  const armLen = H * p.armRatio;
  const upperArmLen = armLen * 0.556;
  const forearmLen = armLen * 0.444;

  // Hip joints track the authored hip width, so a wide-hipped fighter gets a
  // wide stance. Note what is deliberately *not* done here: forcing the thighs
  // apart so they clear each other. Vera's thigh radius is within a millimetre
  // of half her own hip width, and a one-millimetre gap under a 25 mm mesh grid
  // is worse than either touching or clearing — it pinches, and a pinch is a
  // non-manifold edge. The adductor mass in `buildLeg` closes the crotch
  // deliberately instead, which is also what the anatomy does.
  const hipJointX = hipHalf * 0.52;
  const armJointX = shoulderHalf - deltoidR * 0.92;

  const handLen = H * (0.112 + 0.02 * build) * (1 - 0.04 * fem);
  const palmHalf = handLen * 0.268;
  const footLen = H * (0.15 + 0.012 * build) * (1 - 0.02 * fem);

  // Rest arm spread, solved for clearance rather than authored: put the outer
  // edge of the palm one thigh-radius plus a fixed margin outside the hip
  // joint. `asin` of the required lateral travel over the reach that produces
  // it, since the forearm keeps `A_POSE_FOREARM_RATIO` of the upper arm's
  // angle.
  // 1.35 palm widths, not one: the thumb reaches medially past the palm edge,
  // and it is the thumb that would touch the thigh first.
  // The margin itself scales with build. A heavy fighter cannot bring the arms
  // in past their own lat and hip mass, and a lean one has no reason not to —
  // which is the difference between a blocky silhouette with daylight either
  // side of the torso and a single tall column.
  // What the arm has to clear is whichever is wider — the thigh or the hip
  // silhouette itself. Mali's glutes reach further out than her thigh does, and
  // measuring against the thigh alone laid her forearm straight onto her hip.
  const bodyOut = Math.max(hipJointX + thighR, hipHalf);
  const need = bodyOut + palmHalf * 1.35 + H * (0.01 + 0.026 * build) - armJointX;
  const reach = upperArmLen + forearmLen * A_POSE_FOREARM_RATIO;
  const armSpread = THREE.MathUtils.clamp(
    Math.asin(THREE.MathUtils.clamp(need / reach, 0, 0.75)),
    A_POSE_ABDUCTION_MIN,
    A_POSE_ABDUCTION_MAX,
  );

  return {
    def,
    height: H,
    build,
    fem,
    headLen,
    neckLen,
    legLen,
    torsoLen,
    neckBaseY,
    ankleY: H * (0.038 + 0.005 * build),
    footLen,
    shoulderHalf,
    hipHalf,
    chestHalf: shoulderHalf * (0.71 + 0.06 * build),
    // Waist is the V-taper, so it takes `fem` and `build` in the same
    // direction: both narrow it relative to the hip it is measured against.
    waistHalf: hipHalf * (0.72 - 0.1 * fem - 0.04 * build),
    torsoDepth: 0.6 + 0.16 * build + 0.05 * fem,
    upperArmR,
    deltoidR,
    forearmR,
    wristR,
    thighR,
    kneeR,
    calfR,
    ankleR,
    neckR: H * (0.024 + 0.014 * build) * (1 - 0.13 * fem),
    // Half-width of the cranium mass, so hair and headgear can be fitted to
    // the same number the skull was built from.
    skullR: headLen * 0.345,
    handLen,
    upperArmLen,
    forearmLen,
    armSpread,
    foreSpread: armSpread * A_POSE_FOREARM_RATIO,
    hipJointX,
    palmHalf,
    palmThick: handLen * 0.108,
    fingerR: palmHalf * 0.22,
    footHalf: footLen * 0.205,
    heelR: footLen * 0.15,
    toeLen: footLen * 0.245,
    // Authored stance, floored so the two feet cannot overlap across the
    // midline. Davi's narrow base put his feet through each other, and two
    // solids that intersect at the floor while their legs are already joined
    // at the pelvis close a ring — the body came out genus 1.
    ankleX: Math.max(hipJointX * p.stance, footLen * 0.205 * 1.35),
  };
}

export type JointMap = Record<BoneName, THREE.Vector3>;

/**
 * World-space rest position of every joint, in the A-pose.
 *
 * The body builder sweeps its volumes along these same points, so mesh and
 * skeleton cannot drift apart.
 */
export function restJoints(m: RigMetrics): JointMap {
  const H = m.height;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  const shoulderY = m.neckBaseY - H * 0.028;
  const armJointX = m.shoulderHalf - m.deltoidR * 0.92;
  const clavX = H * 0.019;
  const hipJointX = m.hipJointX;

  // Arms hang out and very slightly forward; the forearm straightens a touch
  // and pre-bends at the elbow so IK has a plane to solve in. The spread is
  // per-fighter and solved in `rigMetrics` — see A_POSE_ABDUCTION_MIN.
  const ua = m.armSpread;
  const fa = m.foreSpread;
  const upperDir = V(Math.sin(ua), -Math.cos(ua), 0.02);
  const foreDir = V(Math.sin(fa), -Math.cos(fa) * Math.cos(ELBOW_PREBEND), Math.sin(ELBOW_PREBEND));

  const elbowL = V(armJointX, shoulderY, 0).addScaledVector(upperDir, m.upperArmLen);
  const wristL = elbowL.clone().addScaledVector(foreDir, m.forearmLen);

  // Legs converge slightly toward the floor: a real stance has the knees inside
  // the hips and the ankles inside the knees, which also stops the thighs from
  // reading as two parallel columns.
  const kneeY = m.ankleY + (m.legLen - m.ankleY) * (0.465 + 0.01 * m.fem);
  const kneeX = hipJointX * 0.88;
  const ankleX = m.ankleX;
  const kneeZ = Math.sin(KNEE_PREBEND) * (m.legLen - m.ankleY) * 0.5;

  const j: Partial<JointMap> = {
    root: V(0, 0, 0),
    hips: V(0, m.legLen, 0),
    spine: V(0, m.legLen + m.torsoLen * 0.26, -H * 0.004),
    chest: V(0, m.legLen + m.torsoLen * 0.58, -H * 0.002),
    neck: V(0, m.neckBaseY - H * 0.008, -H * 0.012),
    head: V(0, m.height - m.headLen, -H * 0.006),

    thighL: V(hipJointX, m.legLen, 0),
    shinL: V(kneeX, kneeY, kneeZ),
    footL: V(ankleX, m.ankleY, -H * 0.014),
    // The toe joint is the ball of the foot, not the toe tip: it is the hinge a
    // fighter pivots and pushes off on. The ankle stands about a quarter of the
    // way along the foot from the heel, so the ball is at 0.45 of the length
    // ahead of it and the toes carry the last 0.185.
    toeL: V(ankleX + H * 0.005, m.ankleY * 0.36, -H * 0.014 + m.footLen * 0.45),

    shoulderL: V(clavX, shoulderY + H * 0.014, H * 0.012),
    upperArmL: V(armJointX, shoulderY, 0),
    forearmL: elbowL,
    handL: wristL,
  };

  // Right side is a straight mirror. Doing it by reflection rather than by hand
  // guarantees the rig is symmetric, which the retargeter assumes.
  for (const name of BONES) {
    if (!name.endsWith('L')) continue;
    const src = j[name as BoneName]!;
    const mirrored = (name.slice(0, -1) + 'R') as BoneName;
    j[mirrored] = V(-src.x, src.y, src.z);
  }

  return j as JointMap;
}

export interface BuiltSkeleton {
  root: THREE.Group;
  bones: Record<BoneName, THREE.Bone>;
  skeleton: THREE.Skeleton;
  joints: JointMap;
  metrics: RigMetrics;
  /** Rest local transforms, kept so `applyPose` can blend against them. */
  restLocal: Record<BoneName, THREE.Vector3>;
}

export function buildSkeleton(def: FighterDef): BuiltSkeleton {
  const metrics = rigMetrics(def);
  const joints = restJoints(metrics);

  const bones = {} as Record<BoneName, THREE.Bone>;
  const restLocal = {} as Record<BoneName, THREE.Vector3>;
  const root = new THREE.Group();
  root.name = `rig:${def.id}`;

  for (const name of BONES) {
    const bone = new THREE.Bone();
    bone.name = name;
    bones[name] = bone;
  }
  for (const name of BONES) {
    const parent = BONE_PARENT[name];
    // Rest rotations are identity, so a local offset is just the difference of
    // world positions — no inverse-parent composition anywhere in this rig.
    const local = joints[name].clone();
    if (parent) local.sub(joints[parent]);
    restLocal[name] = local;
    bones[name].position.copy(local);
    if (parent) bones[parent].add(bones[name]);
    else root.add(bones[name]);
  }

  root.updateMatrixWorld(true);
  const ordered = BONES.map((n) => bones[n]);
  const skeleton = new THREE.Skeleton(ordered);

  return { root, bones, skeleton, joints, metrics, restLocal };
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();

/**
 * Blend a pose onto the current bone state.
 *
 * Weight is a layer weight, not a strength dial: bones the pose does not mention
 * blend back toward rest, so `resetPose(); applyPose(a, 1); applyPose(b, 0.3)`
 * is a 70/30 crossfade and needs no special casing in the poser.
 */
export function applyPoseTo(
  bones: Record<BoneName, THREE.Bone>,
  restLocal: Record<BoneName, THREE.Vector3>,
  pose: Pose,
  weight = 1,
): void {
  const w = THREE.MathUtils.clamp(weight, 0, 1);
  if (w <= 0) return;

  for (const name of BONES) {
    const bone = bones[name];
    const rest = restLocal[name];
    const ch = pose[name];

    if (ch?.rot) _e.set(ch.rot[0], ch.rot[1], ch.rot[2], 'XYZ');
    else _e.set(0, 0, 0, 'XYZ');
    _q.setFromEuler(_e);
    if (w >= 1) bone.quaternion.copy(_q);
    else bone.quaternion.slerp(_q, w);

    if (ch?.pos) _v.set(rest.x + ch.pos[0], rest.y + ch.pos[1], rest.z + ch.pos[2]);
    else _v.copy(rest);
    if (w >= 1) bone.position.copy(_v);
    else bone.position.lerp(_v, w);

    const s = ch?.scale ?? 1;
    if (w >= 1) bone.scale.setScalar(s);
    else bone.scale.lerp(_v.set(s, s, s), w);
  }
}

export function resetPoseOf(
  bones: Record<BoneName, THREE.Bone>,
  restLocal: Record<BoneName, THREE.Vector3>,
): void {
  for (const name of BONES) {
    const bone = bones[name];
    bone.position.copy(restLocal[name]);
    bone.quaternion.identity();
    bone.scale.setScalar(1);
  }
}

/** Graph distance between two bones, used to gate skin-weight bleed. */
export function boneDistance(a: BoneName, b: BoneName): number {
  const chain = (n: BoneName): BoneName[] => {
    const out: BoneName[] = [];
    let cur: BoneName | null = n;
    while (cur) {
      out.push(cur);
      cur = BONE_PARENT[cur];
    }
    return out;
  };
  const ca = chain(a);
  const cb = chain(b);
  for (let i = 0; i < ca.length; i++) {
    const j = cb.indexOf(ca[i]);
    if (j >= 0) return i + j;
  }
  return 99;
}
