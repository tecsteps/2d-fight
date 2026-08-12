import * as THREE from 'three';
import { ColorField, Field } from './field';
import { clamp01 } from './noise';

/**
 * Field → GPU texture, plus the cache and quality knobs every generator shares.
 *
 * Colour space is not a detail here, it is the difference between cloth that
 * looks dyed and cloth that looks lit by a different sun: albedo carries
 * sRGB-encoded colour and must be flagged `SRGBColorSpace` so the renderer
 * decodes it, while normal, roughness and mask maps are *data* and must be
 * flagged `NoColorSpace` or every value in them is silently gamma-warped.
 */

export interface TexSet {
  /** Albedo. sRGB. */
  readonly map: THREE.Texture;
  /** Tangent-space normal, OpenGL convention (green points up). */
  readonly normalMap: THREE.Texture;
  /** Linear roughness, grey. */
  readonly roughnessMap?: THREE.Texture;
  /**
   * Extra data maps a shader may want: sheen breakup, seam/stitch masks, wear,
   * strand ids, anisotropy flow. Named per generator and documented there.
   */
  readonly aux?: Readonly<Record<string, THREE.Texture>>;
  /** Edge length of the albedo and normal in texels; scalar maps are half this. */
  readonly size: number;
  /**
   * Physical size of one tile in metres, so a caller can set UV repeat from a
   * real measurement: `repeat = surfaceMetres / tileMetres`. A texel budget is
   * meaningless without it — 512px of gi weave over 2 m is mush, over 20 cm it
   * is fabric.
   */
  readonly tileMetres: number;
  /** Wrap-seam ratio of the source height field; 1 is perfect. Dev diagnostic. */
  readonly seam?: number;
}

/**
 * Global resolution scale. 1 = authored resolution, 0.5 = half (four times
 * cheaper to generate *and* a quarter of the VRAM), 2 = for stills.
 *
 * Generation is synchronous and happens at load, so this is the dial that keeps
 * a low-end machine from staring at a black screen for three seconds.
 */
let quality = 1;
let cacheGeneration = 0;

export function setTextureQuality(scale: number): void {
  const q = THREE.MathUtils.clamp(scale, 0.25, 2);
  if (q === quality) return;
  quality = q;
  // Old entries stay valid for anyone still holding them, but new requests must
  // not be served a texture built at the previous resolution.
  cacheGeneration++;
}

export function textureQuality(): number {
  return quality;
}

/** Authored resolution → actual, snapped to a power of two. */
export function texSize(base: number): number {
  const want = base * quality;
  const pow = Math.round(Math.log2(Math.max(32, want)));
  return THREE.MathUtils.clamp(2 ** pow, 64, 2048);
}

const cache = new Map<string, unknown>();

/**
 * Memoises a generator. The same weave asked for twice returns the *same
 * texture instance*, which is what lets four fighters and a stage share one
 * upload and lets the renderer batch by material.
 */
export function cached<T>(name: string, opts: Record<string, unknown>, make: () => T): T {
  const key = `${cacheGeneration}|${quality}|${name}|${stableKey(opts)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;
  const made = make();
  cache.set(key, made);
  return made;
}

/** Stable, compact stringification of a resolved option set. */
export function stableKey(opts: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of Object.keys(opts).sort()) {
    const v = opts[k];
    if (v === undefined) continue;
    if (typeof v === 'number') parts.push(`${k}=${Number(v.toFixed(5))}`);
    else if (typeof v === 'boolean' || typeof v === 'string') parts.push(`${k}=${v}`);
    else if (v instanceof THREE.Color) parts.push(`${k}=${v.getHexString()}`);
    else parts.push(`${k}=${JSON.stringify(v)}`);
  }
  return parts.join(',');
}

const allTextures = new Set<THREE.Texture>();

function finish(tex: THREE.DataTexture, colorSpace: string, name: string): THREE.DataTexture {
  tex.name = name;
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  // Fabric and stage surfaces are almost always seen at a grazing angle; 8 is
  // where the return stops being visible on a 1080p fighting-game camera.
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  allTextures.add(tex);
  return tex;
}

/** sRGB albedo from a colour field. */
export function albedoTexture(color: ColorField, name = 'albedo'): THREE.DataTexture {
  const n = color.size;
  const data = new Uint8Array(n * n * 4);
  for (let i = 0, j = 0, k = 0; i < n * n; i++, j += 3, k += 4) {
    data[k] = clamp01(color.data[j]) * 255;
    data[k + 1] = clamp01(color.data[j + 1]) * 255;
    data[k + 2] = clamp01(color.data[j + 2]) * 255;
    data[k + 3] = 255;
  }
  return finish(new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType), THREE.SRGBColorSpace, name);
}

/** sRGB albedo with a mask driving alpha — cut-out edges on frayed cloth. */
export function albedoTextureAlpha(color: ColorField, alpha: Field, name = 'albedo'): THREE.DataTexture {
  const tex = albedoTexture(color, name);
  const data = tex.image.data as unknown as Uint8Array;
  for (let i = 0; i < alpha.data.length; i++) data[i * 4 + 3] = clamp01(alpha.data[i]) * 255;
  tex.needsUpdate = true;
  return tex;
}

export interface NormalOptions {
  /** Slope multiplier. Height is in arbitrary units, this sets how deep it reads. */
  strength?: number;
  /**
   * Sample distance for the derivative, in texels. 1 is sharpest; 2 tames the
   * per-texel sparkle a very fine weave otherwise throws under a sharp
   * specular, which on a moving fighter crawls.
   */
  step?: number;
  name?: string;
}

/**
 * Height field → tangent-space normal map.
 *
 * Central differences over a wrapped neighbourhood, so the map tiles as exactly
 * as the height did. Green points up (OpenGL convention) to match three's
 * `MeshStandardMaterial` and the toon material built on it.
 */
export function normalTexture(height: Field, opts: NormalOptions = {}): THREE.DataTexture {
  const strength = opts.strength ?? 1;
  const step = Math.max(1, Math.round(opts.step ?? 1));
  const n = height.size;
  const data = new Uint8Array(n * n * 4);
  // Scale by resolution so a given strength means the same physical slope at
  // any quality level; otherwise dropping to half res halves the relief.
  const k = strength * n * 0.0035 / step;
  let o = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++, o += 4) {
      const dx = (height.get(x + step, y) - height.get(x - step, y)) * k;
      const dy = (height.get(x, y + step) - height.get(x, y - step)) * k;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      data[o] = (-dx * inv * 0.5 + 0.5) * 255;
      data[o + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      data[o + 2] = (inv * 0.5 + 0.5) * 255;
      data[o + 3] = 255;
    }
  }
  return finish(new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType), THREE.NoColorSpace, opts.name ?? 'normal');
}

/**
 * Grey data map: roughness, and every mask a shader reads as a scalar.
 *
 * Emitted at **half** the source resolution above 256. A scalar map's job is to
 * modulate a lighting term, and by the time the eye could resolve the finest
 * detail in a roughness map the surface is already several mip levels down. The
 * albedo and normal keep full resolution because they carry the silhouette of
 * the detail; halving these instead is a third of the library's VRAM back for a
 * difference nobody has ever spotted in motion.
 */
export function scalarTexture(source: Field, lo = 0, hi = 1, name = 'scalar'): THREE.DataTexture {
  const field = source.size > 256 ? source.downsampleBy(2) : source;
  const n = field.size;
  const data = new Uint8Array(n * n * 4);
  for (let i = 0, o = 0; i < field.data.length; i++, o += 4) {
    const v = clamp01(lo + (hi - lo) * clamp01(field.data[i])) * 255;
    data[o] = v;
    data[o + 1] = v;
    data[o + 2] = v;
    data[o + 3] = 255;
  }
  return finish(new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType), THREE.NoColorSpace, name);
}

/**
 * Two-channel direction map, encoded like a normal map's XY.
 *
 * Anisotropic surfaces — satin, hair, brushed metal — need to know which way
 * the fibre runs at each texel, and it is not constant: a braid's strands curve.
 */
export function flowTexture(fx: Field, fy: Field, name = 'flow'): THREE.DataTexture {
  const n = fx.size;
  const data = new Uint8Array(n * n * 4);
  for (let i = 0, o = 0; i < fx.data.length; i++, o += 4) {
    const x = fx.data[i];
    const y = fy.data[i];
    const len = Math.hypot(x, y) || 1;
    data[o] = clamp01(x / len * 0.5 + 0.5) * 255;
    data[o + 1] = clamp01(y / len * 0.5 + 0.5) * 255;
    data[o + 2] = 0;
    data[o + 3] = 255;
  }
  return finish(new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType), THREE.NoColorSpace, name);
}

/**
 * Same maps at a different UV repeat.
 *
 * `repeat` lives on the texture, not the material, so a shared texture forces a
 * shared tiling. This hands back clones sharing the same CPU buffer, cached, so
 * asking twice still gets one instance. The GPU does keep a second copy — a
 * clone is a second upload — so this is for "the sleeve tiles twice and the
 * trouser leg four times", not for per-mesh bookkeeping.
 */
export function tiled(set: TexSet, repeatU: number, repeatV = repeatU): TexSet {
  if (repeatU === 1 && repeatV === 1) return set;
  return cached('tiled', { id: set.map.uuid, u: repeatU, v: repeatV }, () => {
    const re = (t: THREE.Texture): THREE.Texture => {
      const c = t.clone();
      c.repeat.set(repeatU, repeatV);
      c.needsUpdate = true;
      allTextures.add(c);
      return c;
    };
    const aux: Record<string, THREE.Texture> = {};
    if (set.aux) for (const k of Object.keys(set.aux)) aux[k] = re(set.aux[k]);
    return {
      map: re(set.map),
      normalMap: re(set.normalMap),
      roughnessMap: set.roughnessMap ? re(set.roughnessMap) : undefined,
      aux: set.aux ? aux : undefined,
      size: set.size,
      tileMetres: set.tileMetres,
      seam: set.seam,
    };
  });
}

export interface TextureStats {
  textures: number;
  /** Approximate VRAM, mipmaps included. */
  bytes: number;
}

export function textureStats(): TextureStats {
  let bytes = 0;
  for (const t of allTextures) {
    const img = t.image as { width?: number; height?: number } | null;
    if (img?.width && img?.height) bytes += img.width * img.height * 4 * 1.34;
  }
  return { textures: allTextures.size, bytes: Math.round(bytes) };
}

/** Frees everything this module ever handed out. Renderer teardown only. */
export function disposeGeneratedTextures(): void {
  for (const t of allTextures) t.dispose();
  allTextures.clear();
  cache.clear();
}
