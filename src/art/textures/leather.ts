import * as THREE from 'three';
import { ColorField, Field, shiftedSrgb } from './field';
import { clamp01, mix, noise, smoothstep } from './noise';
import { albedoTexture, cached, normalTexture, scalarTexture, texSize, TexSet } from './texture';

/**
 * Leather — Vera's wrestling boots, Kai's shoes, belts and straps.
 *
 * Two things make leather read as leather rather than as brown plastic, and
 * both are about *history* rather than material:
 *
 * 1. **Grain** is a cell network — the pebbling of the hide — not noise. It is
 *    stretched, because a hide stretches, and it gets finer where the leather
 *    is pulled tight.
 * 2. **Wear lives on the creases.** A boot flexes in the same place a thousand
 *    times: the crease crowns get burnished (lighter, smoother, shinier) while
 *    the crease valleys stay dark and hold polish. Applying wear uniformly, the
 *    way a plain dirt mask does, gets you a boot that looks dusty instead of
 *    one that looks *worn*.
 *
 * `aux.wearMask` is the burnished amount, so the shading side can push the
 * specular up exactly where the fighter's own movement would have done it.
 */

export interface LeatherOptions {
  color: THREE.ColorRepresentation;
  seed?: number;
  resolution?: number;
  tileMetres?: number;
  neutral?: boolean;
  /** Grain cells across the tile. Fine kid leather is high, work boot low. */
  grain?: number;
  /** Grain depth, 0..1. */
  depth?: number;
  /** Flex creases, 0..1. A boot's instep is 1, a belt 0.2. */
  creases?: number;
  /** Which way the creases run. Boot flex creases cross the foot. */
  creaseDirection?: 'u' | 'v';
  /** Burnishing and scuffing, 0..1. */
  wear?: number;
  /** Base roughness of the finish. Patent is 0.15, oiled work leather 0.6. */
  roughness?: number;
}

export function leather(opts: LeatherOptions): TexSet {
  const o = {
    color: `#${new THREE.Color(opts.color).getHexString()}`,
    seed: opts.seed ?? 307,
    resolution: opts.resolution ?? 512,
    tileMetres: opts.tileMetres ?? 0.2,
    neutral: opts.neutral ?? false,
    grain: Math.max(8, Math.round(opts.grain ?? 60)),
    depth: opts.depth ?? 0.6,
    creases: opts.creases ?? 0.6,
    creaseDirection: opts.creaseDirection ?? 'u',
    wear: opts.wear ?? 0.5,
    roughness: opts.roughness ?? 0.5,
  };

  return cached('leather', o, () => {
    const size = texSize(o.resolution);
    const n = noise(o.seed);
    const height = new Field(size);
    const wearField = new Field(size);
    const rough = new Field(size);
    const color = new ColorField(size, o.color);

    const deep = shiftedSrgb(o.color, -0.11, 0.06, -0.015);
    const burnish = shiftedSrgb(o.color, 0.14, -0.12, 0.008);
    const scuffC = shiftedSrgb(o.color, 0.2, -0.3, 0.01);
    const warp: [number, number] = [0, 0];

    // Flex creases: long soft folds, laid out with a domain-warped stripe so
    // they meander and occasionally merge the way real folds do. Three per
    // tile, an integer count, or the fold pattern would not wrap.
    const creaseField = Field.lowRes(size, 128, (u, v) => {
      n.warp(u, v, 0.22, { freq: 2, octaves: 2, kind: 'simplex', layer: 40 }, warp);
      const t = o.creaseDirection === 'u' ? warp[0] : warp[1];
      const s = Math.abs(Math.sin(Math.PI * 2 * t * 3 + n.fbm(u, v, { freq: 3, octaves: 2, layer: 41 }) * 1.4));
      return Math.pow(1 - s, 2.4);
    });

    const slackF = Field.lowRes(size, 96, (u, v) => n.fbm(u, v, { freq: 4, octaves: 3, kind: 'simplex', layer: 3 }));
    const scatterF = Field.lowRes(size, 96, (u, v) => clamp01(0.5 + 0.5 * n.fbm(u, v, { freq: 7, octaves: 3, kind: 'simplex', layer: 4 })));
    const scuffF = Field.lowRes(size, size >> 1, (u, v) => clamp01(n.fbm(u, v, { freq: 26, octaves: 2, ridged: true, layer: 5 }) * 1.2 - 0.72) * 3);

    color.fill((u, v, x, y, out) => {
      const crease = creaseField.get(x, y) * o.creases;

      // Grain gets finer and shallower where the hide is pulled over a crease.
      const tight = 1 - crease * 0.5;
      const cell = n.worley(u, v, o.grain, { jitter: 0.9, aspect: 0.8, layer: 1 });
      // Wide furrows, not hairlines: hide grain is a visible valley between
      // pebbles, and squeezing it to a one-texel line loses it in the mips.
      const edge = 1 - Math.min(1, (cell.f2 - cell.f1) * 0.9);
      const pebble = smoothstep(0, 0.6, cell.f1) * 0.35;
      const fine = n.worleyEdge(u, v, o.grain * 2, { jitter: 1, aspect: 1.3, layer: 2 });

      const grain = (edge * edge * 0.85 + fine * fine * fine * 0.3) * tight;
      let h = pebble - grain * o.depth;
      h -= crease * 0.75;
      // Broad slack in the panel — leather is never flat.
      h += 0.12 * slackF.get(x, y);
      height.set(x, y, h);

      // Burnish: the shoulders of a crease, plus scattered high spots.
      const shoulder = smoothstep(0.25, 0.75, crease) * (1 - smoothstep(0.7, 1, crease));
      const scatter = scatterF.get(x, y);
      const worn = clamp01(o.wear * (shoulder * 1.5 + Math.max(0, scatter - 0.6) * 1.6 + pebble * 0.4));
      wearField.set(x, y, worn);

      // Scuffs: shallow, bright, short scratches where the finish has gone.
      const scuff = clamp01(scuffF.get(x, y) * scatter) * o.wear;

      const shade = 0.84 + 0.34 * clamp01(0.5 + h) - grain * 0.26;
      out[0] *= shade;
      out[1] *= shade;
      out[2] *= shade;
      for (let c = 0; c < 3; c++) {
        // Polish collects in the grain and along the crease bottoms.
        out[c] = mix(out[c], deep[c], clamp01(grain * 1.1 + crease * 0.9) * 0.75);
        out[c] = mix(out[c], burnish[c], worn * 0.5);
        out[c] = mix(out[c], scuffC[c], scuff * 0.35);
      }

      rough.set(x, y, clamp01(0.55 + grain * 0.3 + crease * 0.15 - worn * 0.5 + scuff * 0.35));
    });

    if (o.neutral) color.desaturateToward(0.7, 1);

    return {
      map: albedoTexture(color, 'leather-albedo'),
      normalMap: normalTexture(height, { strength: 1.15, name: 'leather-normal' }),
      roughnessMap: scalarTexture(rough, Math.max(0, o.roughness - 0.3), Math.min(1, o.roughness + 0.3), 'leather-rough'),
      aux: { wearMask: scalarTexture(wearField, 0, 1, 'leather-wear') },
      size,
      tileMetres: o.tileMetres,
      seam: height.seamError(),
    };
  });
}
