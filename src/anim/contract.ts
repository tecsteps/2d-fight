import * as THREE from 'three';

/**
 * Interface contract between the character mesh builder, the animation system,
 * and gameplay.
 *
 * The bone names below are canonical. Every fighter rig must expose exactly
 * these, so a pose or clip authored for one fighter retargets onto any other.
 */

export const BONES = [
  'root',
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'shoulderL', 'upperArmL', 'forearmL', 'handL',
  'shoulderR', 'upperArmR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL', 'toeL',
  'thighR', 'shinR', 'footR', 'toeR',
] as const;

export type BoneName = (typeof BONES)[number];

/** A single bone's local transform in a pose. Missing channels inherit rest. */
export interface BonePose {
  /** Local rotation as euler XYZ in radians. */
  rot?: [number, number, number];
  /** Local position offset from rest, in metres. */
  pos?: [number, number, number];
  scale?: number;
}

/** A complete authored pose — the fighting-game equivalent of one drawn frame. */
export type Pose = Partial<Record<BoneName, BonePose>>;

/** One keyframe in a clip. */
export interface Keyframe {
  /** Frame index at 60 Hz, relative to clip start. */
  frame: number;
  pose: Pose;
  /**
   * Easing into this key. Hand-drawn animation is mostly `hold` and `step`;
   * `smooth` is for follow-through and settles.
   */
  ease?: 'step' | 'linear' | 'smooth' | 'snap';
}

export interface Clip {
  name: string;
  keys: Keyframe[];
  /** Total length in frames. */
  length: number;
  loop: boolean;
  /**
   * Quantise playback to this many updates per second to mimic hand-drawn
   * animation. KOF XIII reads at roughly 12-15 "drawings" per second even
   * though the game runs at 60. 0 = no quantisation.
   */
  drawRate?: number;
  /** Root motion applied per frame, in metres. */
  rootMotion?: { x: number; y: number }[];
}

/** The built character: mesh, skeleton, and the handles gameplay needs. */
export interface CharacterRig {
  /** Add this to the scene. */
  root: THREE.Group;
  skeleton: THREE.Skeleton;
  bones: Record<BoneName, THREE.Bone>;
  /** All skinned meshes, for material overrides (flash, silhouette). */
  meshes: THREE.SkinnedMesh[];
  /** Height in metres, from the FighterDef. */
  height: number;
  /** Apply a pose directly. Used by the poser and for editor scrubbing. */
  applyPose(pose: Pose, weight?: number): void;
  /** Reset every bone to rest. */
  resetPose(): void;
  dispose(): void;
}
