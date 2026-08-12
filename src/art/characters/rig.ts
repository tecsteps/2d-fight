import * as THREE from 'three';
import type { BoneName, CharacterRig, Pose } from '../../anim/contract';
import {
  applyPoseTo,
  buildSkeleton,
  resetPoseOf,
  type JointMap,
  type RigMetrics,
} from '../../anim/Skeleton';
import type { FighterDef } from '../../data/roster';
import { createToonMaterial } from '../../render/npr/ToonMaterial';
import { addOutlines } from '../../render/npr/outline';
import type { NPRMaterial } from '../../render/npr/contract';
import {
  buildBodyGeometry,
  buildBodyPlan,
  skinGeometry,
  type BodyMeshOptions,
  type BodyPlan,
} from './body';
import { buildCostume } from './costume';
import { buildHair } from './hair';

/**
 * Assembles a fighter: skeleton, skinned body, NPR materials, ink.
 *
 * The result is the only thing gameplay ever touches. Costume, hair and face
 * layers attach to the same skeleton through `attachSkinnedPart`, so a fighter
 * is one draw hierarchy under one root and one pose call moves all of it.
 */

export interface BuildCharacterOptions extends BodyMeshOptions {
  /** Build the inverted-hull ink shells. Off for previews that only want form. */
  outlines?: boolean;
  /** Dress the fighter. Off for anatomy checks and for costume authoring itself. */
  costume?: boolean;
  /** Give the fighter hair. Off for anatomy checks and for hair authoring itself. */
  hair?: boolean;
}

export interface BuiltCharacter extends CharacterRig {
  def: FighterDef;
  metrics: RigMetrics;
  joints: JointMap;
  /** The implicit body definition, kept so costume can be fitted to it. */
  plan: BodyPlan;
  /** Ink shells, parented to their source meshes. */
  outlines: THREE.Mesh[];
  triangles: number;
  /** Adds a skinned layer — costume, hair — bound to this fighter's skeleton. */
  attachSkinnedPart(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    name?: string,
  ): THREE.SkinnedMesh;
}

export function buildCharacter(def: FighterDef, opts: BuildCharacterOptions = {}): BuiltCharacter {
  const sk = buildSkeleton(def);
  const plan = buildBodyPlan(sk.metrics, sk.joints);
  const body = buildBodyGeometry(plan, opts);

  const p = def.palette;
  const skinMaterial = createToonMaterial({
    kind: 'skin',
    color: p.skin,
    shadowColor: p.skinShadow,
    sssColor: p.skinSSS,
    rimColor: p.rim,
    skinned: true,
  });

  const root = sk.root;
  root.name = `fighter:${def.id}`;

  const mesh = new THREE.SkinnedMesh(body.geometry, skinMaterial as THREE.Material);
  mesh.name = `${def.id}:body`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // A fighter's bind-pose bounds say nothing about where a jump kick puts them,
  // and there are only ever two on screen.
  mesh.frustumCulled = false;
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(sk.skeleton);

  const meshes: THREE.SkinnedMesh[] = [mesh];
  const materials: THREE.Material[] = [skinMaterial as THREE.Material];

  const rig: BuiltCharacter = {
    root,
    skeleton: sk.skeleton,
    bones: sk.bones,
    meshes,
    height: def.proportions.height,
    def,
    metrics: sk.metrics,
    joints: sk.joints,
    plan,
    outlines: [],
    triangles: body.triangles,

    applyPose(pose: Pose, weight = 1): void {
      applyPoseTo(sk.bones, sk.restLocal, pose, weight);
    },

    resetPose(): void {
      resetPoseOf(sk.bones, sk.restLocal);
    },

    attachSkinnedPart(geometry, material, name): THREE.SkinnedMesh {
      if (!geometry.getAttribute('skinWeight')) skinGeometry(plan, geometry);
      const part = new THREE.SkinnedMesh(geometry, material);
      part.name = name ?? `${def.id}:part`;
      part.castShadow = true;
      part.receiveShadow = true;
      part.frustumCulled = false;
      root.add(part);
      root.updateMatrixWorld(true);
      part.bind(sk.skeleton);
      meshes.push(part);
      materials.push(material);
      return part;
    },

    dispose(): void {
      for (const o of rig.outlines) {
        o.removeFromParent();
        (o.material as THREE.Material).dispose();
      }
      rig.outlines.length = 0;
      for (const m of meshes) m.geometry.dispose();
      for (const m of materials) m.dispose();
      sk.skeleton.dispose();
      root.removeFromParent();
    },
  };

  if (opts.outlines !== false) rig.outlines = addOutlines(root);
  // After the ink pass, not before: `buildCostume` and `buildHair` ink their own
  // meshes, and `addOutlines` skips anything already inked. Running them after
  // means each garment and each loc gets its own line and the body is not
  // double-shelled.
  if (opts.hair !== false) buildHair(rig, def);
  if (opts.costume !== false) buildCostume(rig, def);

  return rig;
}

/**
 * A relaxed standing stance for previews and turnarounds.
 *
 * Not a gameplay pose — the clip library owns those. This exists so a
 * screenshot of a fresh build shows a figure standing rather than a T-shape,
 * and so the weighting around every joint is exercised by *something* the
 * moment the mesh is built. Angles follow the rig's convention: negative X
 * carries a hanging limb forward, positive Z abducts the left side.
 */
export const NEUTRAL_STANCE: Pose = {
  hips: { rot: [0.015, 0.05, 0], pos: [0, -0.012, 0] },
  spine: { rot: [0.02, -0.02, 0] },
  chest: { rot: [-0.03, -0.06, 0] },
  neck: { rot: [0.035, 0.02, 0] },
  head: { rot: [-0.02, 0.04, 0.01] },

  shoulderL: { rot: [0, 0, -0.05] },
  upperArmL: { rot: [-0.06, 0.1, -0.07] },
  forearmL: { rot: [-0.3, 0.12, -0.03] },
  handL: { rot: [-0.12, 0, 0] },

  shoulderR: { rot: [0, 0, 0.05] },
  upperArmR: { rot: [-0.06, -0.1, 0.07] },
  forearmR: { rot: [-0.3, -0.12, 0.03] },
  handR: { rot: [-0.12, 0, 0] },

  thighL: { rot: [-0.02, 0.03, -0.02] },
  shinL: { rot: [0.05, 0, 0] },
  footL: { rot: [-0.03, 0.09, 0] },
  thighR: { rot: [-0.02, -0.03, 0.02] },
  shinR: { rot: [0.05, 0, 0] },
  footR: { rot: [-0.03, -0.09, 0] },
};

export interface PreviewOptions extends BuildCharacterOptions {
  /** Body yaw in radians. The default is the three-quarter modelling view. */
  yaw?: number;
  pose?: Pose;
}

/**
 * One fighter in a neutral stance, ready to drop into a scene and screenshot.
 *
 * Turned three-quarters by default because that is the view a character sheet
 * is judged on: a front view hides limb depth and a profile hides the shoulder
 * and hip relationship, and both are where the build parameter lives.
 */
export function buildCharacterPreview(def: FighterDef, opts: PreviewOptions = {}): THREE.Group {
  const rig = buildCharacter(def, opts);
  rig.resetPose();
  rig.applyPose(opts.pose ?? NEUTRAL_STANCE);

  const group = new THREE.Group();
  group.name = `preview:${def.id}`;
  rig.root.rotation.y = opts.yaw ?? 0.42;
  group.add(rig.root);
  group.userData.rig = rig;
  return group;
}

/** Frees a preview built by `buildCharacterPreview`. */
export function disposeCharacterPreview(group: THREE.Group): void {
  const rig = group.userData.rig as BuiltCharacter | undefined;
  rig?.dispose();
  group.removeFromParent();
}

/**
 * Every NPR material the fighter owns, ink shells included.
 *
 * The ink has to take the flash too: a hit frame that whitens the body but
 * leaves a dark outline around it reads as a sticker, not as an impact.
 */
function rigMaterials(rig: BuiltCharacter): NPRMaterial[] {
  const out: NPRMaterial[] = [];
  for (const mesh of rig.meshes) out.push(mesh.material as unknown as NPRMaterial);
  for (const ink of rig.outlines) out.push(ink.material as unknown as NPRMaterial);
  return out;
}

/** Convenience for gameplay: flash every surface a fighter owns. */
export function setRigFlash(
  rig: BuiltCharacter,
  color: THREE.ColorRepresentation,
  amount: number,
): void {
  for (const mat of rigMaterials(rig)) mat.setFlash?.(color, amount);
}

/** KOF-style impact frame: fill the whole fighter with one colour. */
export function setRigSilhouette(
  rig: BuiltCharacter,
  color: THREE.ColorRepresentation,
  amount: number,
): void {
  for (const mat of rigMaterials(rig)) mat.setSilhouette?.(color, amount);
}

/** World position of a bone, for VFX attachment and hitbox authoring. */
export function bonePosition(
  rig: BuiltCharacter,
  bone: BoneName,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  rig.root.updateMatrixWorld(true);
  return out.setFromMatrixPosition(rig.bones[bone].matrixWorld);
}
