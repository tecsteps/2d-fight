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

/** Arm spread at rest, from vertical. Shallow on purpose — see above. */
const A_POSE_ABDUCTION = 0.34;
/** Forearm carries a touch less spread than the upper arm, as a real arm hangs. */
const A_POSE_FOREARM_ABDUCTION = 0.3;
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
   * 0 = male silhouette, 1 = female. Read off the hip:shoulder ratio rather than
   * a flag, because that ratio is the thing an artist actually draws: Vera and
   * Mali land at 1, Kai barely registers, Davi is 0.
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
}

export function rigMetrics(def: FighterDef): RigMetrics {
  const p = def.proportions;
  const H = p.height;
  const build = p.build;
  const fem = THREE.MathUtils.smoothstep(p.hip / p.shoulder, 0.755, 0.8);

  const headLen = H * p.headRatio;
  const neckLen = H * 0.042;
  const legLen = H * p.legRatio;
  const neckBaseY = H - headLen - neckLen;
  const torsoLen = neckBaseY - legLen;

  const shoulderHalf = H * p.shoulder * 0.5;
  const hipHalf = H * p.hip * 0.5;

  // Limb girths. Build moves them a long way — Vera's arm is ~40% thicker than
  // Davi's at the same height — and the female pass trims the upper body a
  // little without touching the legs, which is how the two silhouettes differ.
  const upperArmR = H * (0.0225 + 0.0185 * build) * (1 - 0.05 * fem);
  const deltoidR = upperArmR * 1.4 + H * 0.005 * build;
  const forearmR = upperArmR * (0.9 + 0.05 * build);
  const wristR = upperArmR * (0.55 - 0.03 * fem);
  // Thigh girth is tied to the authored hip width: the outer sweep of the thigh
  // must land just past the hip silhouette or the legs read as sticks under a
  // wide pelvis.
  const thighR = H * (0.039 + 0.02 * build) * (1 + 0.05 * fem);
  const kneeR = thighR * 0.63;
  // Kept clear of the other calf: two legs that fuse at rest share vertices,
  // and shared vertices tear into a sheet the moment a stance splits them.
  const calfR = thighR * (0.6 + 0.05 * build);
  const ankleR = thighR * 0.36;

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
    ankleY: H * 0.039,
    footLen: H * (0.152 - 0.006 * fem),
    shoulderHalf,
    hipHalf,
    chestHalf: shoulderHalf * (0.71 + 0.06 * build),
    waistHalf: hipHalf * (0.68 - 0.09 * fem + 0.05 * build),
    torsoDepth: 0.63 + 0.1 * build + 0.04 * fem,
    upperArmR,
    deltoidR,
    forearmR,
    wristR,
    thighR,
    kneeR,
    calfR,
    ankleR,
    neckR: H * (0.026 + 0.011 * build) * (1 - 0.13 * fem),
    // Half-width of the cranium mass, so hair and headgear can be fitted to
    // the same number the skull was built from.
    skullR: headLen * 0.345,
    handLen: H * (0.105 - 0.005 * fem),
    upperArmLen: H * 0.185,
    forearmLen: H * 0.148,
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
  const hipJointX = m.hipHalf * 0.5;

  // Arms hang out and very slightly forward; the forearm straightens a touch
  // and pre-bends at the elbow so IK has a plane to solve in.
  const ua = A_POSE_ABDUCTION;
  const fa = A_POSE_FOREARM_ABDUCTION;
  const upperDir = V(Math.sin(ua), -Math.cos(ua), 0.02);
  const foreDir = V(Math.sin(fa), -Math.cos(fa) * Math.cos(ELBOW_PREBEND), Math.sin(ELBOW_PREBEND));

  const elbowL = V(armJointX, shoulderY, 0).addScaledVector(upperDir, m.upperArmLen);
  const wristL = elbowL.clone().addScaledVector(foreDir, m.forearmLen);

  // Legs converge slightly toward the floor: a real stance has the knees inside
  // the hips and the ankles inside the knees, which also stops the thighs from
  // reading as two parallel columns.
  const kneeY = m.ankleY + (m.legLen - m.ankleY) * (0.465 + 0.01 * m.fem);
  const kneeX = hipJointX * 0.86;
  const ankleX = hipJointX * 0.78;
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
    // fighter pivots and pushes off on.
    toeL: V(ankleX + H * 0.006, m.ankleY * 0.34, m.footLen * 0.32),

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
