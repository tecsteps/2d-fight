import * as THREE from 'three';
import { ColorField, Field, shiftedSrgb, srgb } from './field';
import { clamp01, mix, noise, smoothstep, wrapIndex } from './noise';
import { albedoTexture, cached, flowTexture, normalTexture, scalarTexture, texSize, TexSet } from './texture';

/**
 * Hair.
 *
 * All four fighters wear their hair as a *shape* — Kai's topknot, Davi's locs,
 * Vera's braided mohawk, Mali's segmented braid — so the geometry gives the
 * silhouette and these maps give the surface: strand direction, strand
 * separation, and the tint variation between strands that stops a head of hair
 * from reading as a solid lacquered helmet.
 *
 * The important output is not the albedo, it is `aux.flowMap` plus
 * `aux.strandId`. Hair's specular is anisotropic: the highlight is a band
 * running *across* the strands, and its position shifts per strand. Flow tells
 * the shader which way the fibre runs at each texel; strand id lets it jitter
 * the band so the highlight breaks into the ribbon of light real hair has,
 * rather than the airbrushed stripe of every early-2000s hair shader.
 *
 * Three styles share the machinery:
 *
 * - `strand` — loose hair and topknots. Fine fibre, mild clumping.
 * - `locs` — thick twisted cords: fewer, fatter strands with the diagonal
 *   twist banding and a matte fibrous surface.
 * - `braid` — a real three-strand plait, modelled as three strands whose
 *   centres oscillate across the tile and whose depth alternates, so they pass
 *   over and under each other exactly the way a braid does.
 */

export type HairStyle = 'strand' | 'locs' | 'braid';

export interface HairOptions {
  color: THREE.ColorRepresentation;
  /** Highlight tint — the roster's `hairSheen`. Hair's sheen is never white. */
  sheenColor?: THREE.ColorRepresentation;
  style?: HairStyle;
  seed?: number;
  resolution?: number;
  tileMetres?: number;
  neutral?: boolean;
  /** Fibres across the tile. Locs want 8-14, loose hair 90-160. */
  strands?: number;
  /** How much strands gather into locks, 0..1. */
  clump?: number;
  /** Tone spread between strands, 0..1. Black hair still needs some. */
  variation?: number;
  /** Plait segments down the tile. Braid only. */
  segments?: number;
  /** Twists per tile along a cord. Locs only. */
  twist?: number;
  roughness?: number;
}

export function hairStrands(opts: HairOptions): TexSet {
  const style: HairStyle = opts.style ?? 'strand';
  const o = {
    color: `#${new THREE.Color(opts.color).getHexString()}`,
    sheenColor: `#${new THREE.Color(opts.sheenColor ?? 0x8a7a63).getHexString()}`,
    style,
    seed: opts.seed ?? 211,
    resolution: opts.resolution ?? 512,
    tileMetres: opts.tileMetres ?? (style === 'locs' ? 0.24 : 0.18),
    neutral: opts.neutral ?? false,
    strands: Math.max(3, Math.round(opts.strands ?? (style === 'locs' ? 10 : style === 'braid' ? 60 : 110))),
    clump: opts.clump ?? 0.55,
    variation: opts.variation ?? 0.5,
    segments: Math.max(1, Math.round(opts.segments ?? 5)),
    twist: Math.max(1, Math.round(opts.twist ?? 6)),
    roughness: opts.roughness ?? 0.36,
  };

  return cached('hairStrands', o, () => {
    const size = texSize(o.resolution);
    const n = noise(o.seed);
    const height = new Field(size);
    const rough = new Field(size);
    const strandId = new Field(size);
    const flowX = new Field(size);
    const flowY = new Field(size);
    const color = new ColorField(size, o.color);

    const sheenC = srgb(o.sheenColor);
    const darkC = shiftedSrgb(o.color, -0.07, 0.03, -0.01);
    const liftC = shiftedSrgb(o.color, 0.13, -0.03, 0.01);

    // Strand layers. Integer, mutually coprime counts: hair is not a comb, and
    // three offset layers crossing each other is what gives it depth.
    const layers = style === 'locs'
      ? [o.strands, Math.max(3, Math.round(o.strands * 1.7))]
      : [o.strands, Math.round(o.strands * 0.63) | 1, Math.round(o.strands * 1.41) | 1];

    const strand = { h: 0, id: 0 };
    // Locks drift together — neighbouring hairs share a path, which is the
    // difference between hair and a wire brush. One drift field per layer, all
    // coarse, because a lock is centimetres wide.
    const drifts = layers.map((_, li) => Field.lowRes(size, 64, (u, v) => n.fbm(u, v, { freq: 3, octaves: 3, kind: 'perlin', layer: 60 + li })));

    /** Height of one strand layer at a point, plus which strand it was. */
    const strandLayer = (u: number, x: number, y: number, count: number, li: number): void => {
      const drift = o.clump * 0.45 * drifts[li].get(x, y);
      const su = u * count + drift * count * 0.06;
      const idx = wrapIndex(Math.floor(su), count);
      const f = su - Math.floor(su);
      const id = n.rand(idx, li, 5);
      // Strand thickness and depth vary; some hairs lie under their neighbours.
      const width = 0.55 + 0.45 * id;
      const t = clamp01(Math.abs(f - 0.5) / (0.5 * width));
      const prof = Math.pow(1 - t * t, 0.65);
      const depth = 0.42 + 0.58 * n.rand(idx, li + 7, 9);
      strand.h = prof * depth;
      strand.id = id;
    };

    // Individual filaments: isotropic noise smeared along the strand direction.
    // Sampling stretched noise directly would need a non-integer scale on V,
    // which is exactly the thing that breaks the wrap.
    const fineFreq = Math.max(24, Math.round(size / 2));
    const fibre = Field.from(size, (u, v) => n.value(u, v, fineFreq, 14));
    fibre.blurAxis(Math.max(2, size / 64), 'v', 2).normalize(-1, 1);

    const sway = Field.lowRes(size, 48, (u, v) => n.fbm(u, v, { freq: 3, octaves: 2, layer: 71 }));
    const lobe = { h: 0, id: 0, dir: 0 };

    /** Three-strand plait: centres oscillate, depth alternates, strands cross. */
    const braidAt = (u: number, v: number): void => {
      const pv = v * o.segments;
      let best = -1;
      let bestId = 0;
      let bestDir = 0;
      for (let j = 0; j < 3; j++) {
        const phase = pv + j / 3;
        // Amplitude plus half-width stays under 0.5, so the outermost strand
        // never crosses the tile edge and the map still wraps in U.
        const cx = 0.5 + 0.24 * Math.sin(Math.PI * 2 * phase);
        const over = Math.cos(Math.PI * 2 * phase);
        const t = clamp01(Math.abs(u - cx) / 0.24);
        const prof = Math.pow(1 - t * t, 0.55);
        // The strand at the front is both taller and lit; the ones behind sink
        // into the crossing shadow.
        const h = prof * (0.45 + 0.55 * (0.5 + 0.5 * over));
        if (h > best) {
          best = h;
          bestId = j / 3 + 0.1;
          // Strand direction at the crossing: the plait runs diagonally.
          bestDir = Math.cos(Math.PI * 2 * phase) > 0 ? 1 : -1;
        }
      }
      lobe.h = Math.max(0, best);
      lobe.id = bestId;
      lobe.dir = bestDir;
    };

    color.fill((u, v, x, y, out) => {
      let h = 0;
      let id = 0;
      let dir = 0;

      if (style === 'braid') {
        braidAt(u, v);
        h = lobe.h;
        id = lobe.id;
        dir = lobe.dir;
        // Fibre inside a lobe runs along the plait, so the micro grooves are
        // sheared. An integer shear keeps the sine periodic, which keeps the
        // whole map tiling.
        const groove = 0.5 + 0.5 * Math.sin(Math.PI * 2 * (u * o.strands + dir * v * o.segments * 3));
        h *= 0.86 + 0.14 * groove;
        h -= 0.10 * (1 - lobe.h);
      } else {
        for (let li = 0; li < layers.length; li++) {
          strandLayer(u, x, y, layers[li], li);
          if (strand.h > h) {
            h = strand.h;
            id = strand.id;
          }
        }
        if (style === 'locs') {
          // A loc is a twisted rope: bands spiral around the cord, and the cord
          // itself is fuzzy where fibre escapes the twist.
          const band = 0.5 + 0.5 * Math.sin(Math.PI * 2 * (v * o.twist + u * o.strands));
          h *= 0.82 + 0.18 * band;
          h += 0.07 * n.value(u, v, fineFreq, 12) * h;
        }
        dir = 1;
      }

      h += fibre.get(x, y) * 0.05;
      height.set(x, y, h);
      strandId.set(x, y, id);

      const lit = clamp01(h);
      // Hair colour lives between two extremes: the near-black of the gaps and
      // the tinted lift of a strand facing the light. Averaging them is what
      // produces the "solid helmet" look.
      const tint = (id - 0.5) * o.variation;
      const shade = 0.62 + 0.58 * lit + tint * 0.22;
      out[0] *= shade;
      out[1] *= shade;
      out[2] *= shade;
      const gap = 1 - clamp01(h * 1.7);
      for (let c = 0; c < 3; c++) {
        out[c] = mix(out[c], darkC[c], gap * 0.7);
        out[c] = mix(out[c], liftC[c], clamp01(tint) * 0.5 * lit);
        out[c] = mix(out[c], sheenC[c], smoothstep(0.75, 1, lit) * 0.22 * (0.4 + 0.6 * id));
      }

      rough.set(x, y, clamp01(0.5 - lit * 0.3 + (1 - id) * 0.18));

      if (style === 'braid') {
        // Follow the lobe: mostly along the plait, angled by which way the
        // strand is crossing.
        flowX.set(x, y, dir * 0.55);
        flowY.set(x, y, 1);
      } else {
        flowX.set(x, y, 0.12 * sway.get(x, y));
        flowY.set(x, y, 1);
      }
    });

    if (o.neutral) color.desaturateToward(0.6, 1);

    return {
      map: albedoTexture(color, 'hair-albedo'),
      normalMap: normalTexture(height, { strength: style === 'locs' ? 1.4 : 0.9, name: 'hair-normal' }),
      roughnessMap: scalarTexture(rough, o.roughness - 0.12, o.roughness + 0.34, 'hair-rough'),
      aux: {
        flowMap: flowTexture(flowX, flowY, 'hair-flow'),
        strandId: scalarTexture(strandId, 0, 1, 'hair-strand-id'),
      },
      size,
      tileMetres: o.tileMetres,
      seam: height.seamError(),
    };
  });
}
