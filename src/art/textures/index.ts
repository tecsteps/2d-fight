/**
 * Procedural texture synthesis.
 *
 * Every surface in this game — cloth, skin, hair, leather, concrete — is
 * generated here at load time from a seed. Nothing is fetched, decoded or
 * bundled: the game ships with no image files, and the only reason a texture
 * exists is that this code ran.
 *
 * Using it:
 *
 * ```ts
 * const gi = cottonCanvas({ color: 0x1b2c44, kind: 'twill', threads: 56 });
 * mat.map = gi.map;               // sRGB albedo
 * mat.normalMap = gi.normalMap;   // OpenGL-convention tangent normal
 * mat.roughnessMap = gi.roughnessMap;
 * // Physical tiling: one sleeve is ~0.5 m of cloth, the tile is 0.25 m.
 * const sleeve = tiled(gi, 0.5 / gi.tileMetres);
 * ```
 *
 * Four rules the whole directory obeys:
 *
 * - **Everything tiles.** Every generator's height field is checked with
 *   `Field.seamError()` and reported by `textureSheetReport()`.
 * - **Everything is cached.** The same options return the same texture
 *   *instance*, so materials can be shared and batched.
 * - **Colour space is explicit.** Albedo is `SRGBColorSpace`; normal,
 *   roughness and every mask are `NoColorSpace`.
 * - **Nothing here is random at runtime.** `Math.random` is never called;
 *   two runs produce byte-identical maps.
 */

export { Noise, noise, clamp01, smoothstep, smootherstep, mix, stripeDistance, tri, wrapIndex } from './noise';
export type { FbmOptions, NoiseKind, WorleyMetric, WorleyOptions, WorleyResult } from './noise';

export { Field, ColorField, srgb, shiftedSrgb } from './field';

export {
  albedoTexture,
  albedoTextureAlpha,
  cached,
  disposeGeneratedTextures,
  flowTexture,
  normalTexture,
  scalarTexture,
  setTextureQuality,
  stableKey,
  texSize,
  textureQuality,
  textureStats,
  tiled,
} from './texture';
export type { NormalOptions, TexSet, TextureStats } from './texture';

export { bandageWrap, cottonCanvas, quiltedFabric, ribbedKnit, satinFabric, weaveAt } from './fabric';
export type {
  BandageWrapOptions,
  CanvasFabricOptions,
  FabricBase,
  QuiltedFabricOptions,
  QuiltPattern,
  RibbedKnitOptions,
  SatinFabricOptions,
  WeaveKind,
  WeaveOptions,
  WeaveSample,
  WeaveSpec,
} from './fabric';

export { skinDetail } from './skin';
export type { SkinDetailOptions } from './skin';

export { hairStrands } from './hair';
export type { HairOptions, HairStyle } from './hair';

export { leather } from './leather';
export type { LeatherOptions } from './leather';

export { asphalt, brick, clothBanner, concrete, paintedMetal, weatherMask, wornWood } from './stage';
export type {
  AsphaltOptions,
  BrickOptions,
  ClothBannerOptions,
  ConcreteOptions,
  PaintedMetalOptions,
  StageBase,
  WeatherOptions,
  WornWoodOptions,
} from './stage';

export { fighterTextures } from './suite';
export type { FighterTextures } from './suite';

export { defaultDebugSets, mountTextureSheet, textureDebugSheet, textureSheetReport, textureSwatchSheet } from './debug';
export type { DebugSheetEntry, DebugSheetOptions, MountedSheet, MountOptions } from './debug';
