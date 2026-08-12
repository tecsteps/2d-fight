import * as THREE from 'three';

/**
 * Interface contract between the character/stage builders and the NPR pipeline.
 *
 * This file exists so those systems can be developed independently: the art side
 * codes against these signatures, the shading side implements them. Only the
 * types are fixed — implementations are free to change entirely as long as the
 * shape holds.
 */

/** Which shading treatment a surface wants. Drives ramp choice and outline weight. */
export type SurfaceKind =
  | 'skin'
  | 'hair'
  | 'cloth' // matte fabric: gi, abadá, shorts
  | 'quilted' // padded/puffer, strong self-shadow terms
  | 'satin' // muay thai shorts, anisotropic sheen
  | 'leather' // boots
  | 'wrap' // tape and bandage, slightly translucent
  | 'metal'
  | 'stage';

export interface ToonMaterialOptions {
  kind: SurfaceKind;
  /** Base albedo. */
  color: THREE.ColorRepresentation;
  /** Colour the shadow band trends toward. Defaults to a cooled `color`. */
  shadowColor?: THREE.ColorRepresentation;
  /** Subsurface tint for skin/wrap. */
  sssColor?: THREE.ColorRepresentation;
  /** Rim light colour; the character's `palette.rim` by default. */
  rimColor?: THREE.ColorRepresentation;
  /** Rim strength 0..2. */
  rimPower?: number;
  /** Number of quantised light bands. 2 = hard cel, 4 = soft painted. */
  bands?: number;
  /** How sharp the band transitions are, 0 = smooth gradient, 1 = hard step. */
  bandSharpness?: number;
  /** Specular highlight intensity 0..1. */
  specular?: number;
  /** Ink outline thickness multiplier for this surface, 0 disables. */
  outlineWidth?: number;
  /** Outline colour; defaults to a darkened albedo, which reads as hand-inked. */
  outlineColor?: THREE.ColorRepresentation;
  /** Optional generated albedo/detail map. */
  map?: THREE.Texture | null;
  /** Optional generated normal map. */
  normalMap?: THREE.Texture | null;
  normalScale?: number;
  /** Skinned meshes need morph/skinning defines. */
  skinned?: boolean;
  transparent?: boolean;
  side?: THREE.Side;
}

/** Every NPR material exposes these so gameplay can drive them per frame. */
export interface NPRMaterial extends THREE.Material {
  /** Flash the whole surface toward a colour — hit flash, super flash, burn. */
  setFlash(color: THREE.ColorRepresentation, amount: number): void;
  /** Global lighting override used when the stage dims for a super. */
  setLightingScale(scale: number): void;
  /** Silhouette fill 0..1, for the KOF-style "impact frame" white-out. */
  setSilhouette(color: THREE.ColorRepresentation, amount: number): void;
}

/**
 * Implemented by `src/render/npr/ToonMaterial.ts`.
 * Returns a material that is safe to share between meshes of the same kind.
 */
export type CreateToonMaterial = (opts: ToonMaterialOptions) => NPRMaterial;
