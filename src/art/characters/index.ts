/**
 * Procedural fighters.
 *
 * `buildCharacter(def)` is the whole public surface: hand it a roster entry and
 * it returns a posable `CharacterRig` whose skeleton, mesh, weights and
 * materials were all generated from `def.proportions` and `def.palette`. No
 * asset is loaded at any point.
 */

export { buildCharacter, buildCharacterPreview, disposeCharacterPreview } from './rig';
export { NEUTRAL_STANCE, setRigFlash, setRigSilhouette, bonePosition } from './rig';
export type { BuildCharacterOptions, BuiltCharacter, PreviewOptions } from './rig';

export { buildBodyPlan, buildBodyGeometry, skinGeometry, computeSkinWeights, sampleField } from './body';
export type { BodyPlan, BodyMeshOptions, BuiltBody, Prim, SkinData } from './body';

export {
  buildSkeleton,
  rigMetrics,
  restJoints,
  applyPoseTo,
  resetPoseOf,
  boneDistance,
  BONE_PARENT,
  BONE_CHILDREN,
} from '../../anim/Skeleton';
export type { RigMetrics, JointMap, BuiltSkeleton } from '../../anim/Skeleton';
