import * as THREE from 'three';
import { ColorField, Field, shiftedSrgb, srgb } from './field';
import { clamp01, mix, noise, smoothstep } from './noise';
import { albedoTexture, cached, normalTexture, scalarTexture, texSize, TexSet } from './texture';

/**
 * Skin detail.
 *
 * The failure mode this exists to prevent is *noise*. Bump-mapping skin with
 * fBm gives you a lit orange peel that shimmers when the fighter moves, because
 * fBm has no structure at any scale and the eye is exceptionally good at
 * spotting that a face is made of static.
 *
 * Real skin micro-relief is a **network**, not a field: shallow furrows meeting
 * at three-way junctions and enclosing slightly domed lozenges, with pores
 * pitted inside them. That is a Worley cell diagram, stretched — so the height
 * here is built from two Worley scales with the pores placed in the cells, and
 * the only fBm in the map is at an amplitude you cannot see directly.
 *
 * Three maps come out, because they do three different jobs under cel shading:
 *
 * - **albedo** carries subdermal colour — skin is not one colour, it is a warm
 *   red layer showing through a cooler surface, and losing that is what makes
 *   toon-shaded skin look like painted vinyl;
 * - **normal** carries the furrow network, at an amplitude that only really
 *   shows on the terminator, which is where a painter would draw it;
 * - **`aux.sheenMask`** breaks up the specular. A single unbroken highlight
 *   sliding across a shoulder is the single most CG-looking thing a fighter can
 *   do; sweat sits in patches, and the highlight has to patch with it.
 */

export interface SkinDetailOptions {
  /** Base tone, normally the roster palette's `skin`. */
  tone: THREE.ColorRepresentation;
  /** Subsurface tint bleeding through — the palette's `skinSSS`. */
  sss?: THREE.ColorRepresentation;
  seed?: number;
  resolution?: number;
  /** Physical tile size. 0.35 m ≈ a shoulder-to-elbow span. */
  tileMetres?: number;
  neutral?: boolean;
  /** Furrow network depth, 0..1. Older/harder skin runs higher. */
  micro?: number;
  /** Pore visibility, 0..1. */
  pores?: number;
  /** Freckle density, 0..1. Vera is the only one with any. */
  freckles?: number;
  freckleColor?: THREE.ColorRepresentation;
  /** How strongly the subdermal red shows, 0..1. */
  subdermal?: number;
  /** Sweat coverage, 0..1. Round 3 should be higher than round 1. */
  sweat?: number;
  roughness?: number;
}

export function skinDetail(opts: SkinDetailOptions): TexSet {
  const o = {
    tone: `#${new THREE.Color(opts.tone).getHexString()}`,
    sss: `#${new THREE.Color(opts.sss ?? 0xc4553a).getHexString()}`,
    seed: opts.seed ?? 101,
    // 512 over a 35 cm tile is about three times the texel density the fighter
    // ever occupies on a 1080p screen; 1024 only pays off in a close-up.
    resolution: opts.resolution ?? 512,
    tileMetres: opts.tileMetres ?? 0.35,
    neutral: opts.neutral ?? false,
    micro: opts.micro ?? 0.6,
    pores: opts.pores ?? 0.55,
    freckles: opts.freckles ?? 0,
    freckleColor: `#${new THREE.Color(opts.freckleColor ?? 0x8a4a2a).getHexString()}`,
    subdermal: opts.subdermal ?? 0.6,
    sweat: opts.sweat ?? 0.45,
    roughness: opts.roughness ?? 0.58,
  };

  return cached('skinDetail', o, () => {
    const size = texSize(o.resolution);
    const n = noise(o.seed);
    const height = new Field(size);
    const rough = new Field(size);
    const sheen = new Field(size);
    const color = new ColorField(size, o.tone);

    const sssC = srgb(o.sss);
    // Skin's cool component is not grey — it is the olive-to-violet cast of the
    // outer layer over the blood beneath.
    const coolC = shiftedSrgb(o.tone, -0.05, -0.06, 0.02);
    const freckC = srgb(o.freckleColor);

    // Furrow network. Cells stretched along V because skin lines follow the
    // limb, and pores are a third the size of the lozenges they sit in.
    const netFreq = Math.max(8, Math.round(size / 22));
    const fineFreq = netFreq * 2;
    const poreFreq = Math.max(16, Math.round(size / 9));

    // Subdermal colour and sweat coverage are broad by nature: evaluated at a
    // fraction of the resolution and resampled, which is the difference between
    // this generator taking 300 ms and taking seven seconds.
    const lo = Math.max(32, size >> 3);
    const warmF = Field.lowRes(size, lo, (u, v) => clamp01(0.5 + 0.5 * n.fbm(u, v, { freq: 3, octaves: 3, kind: 'simplex', layer: 5 })));
    const coolF = Field.lowRes(size, lo, (u, v) => clamp01(0.5 + 0.5 * n.fbm(u, v, { freq: 5, octaves: 3, kind: 'simplex', layer: 6 })));
    const capF = Field.lowRes(size, size >> 2, (u, v) => n.fbm(u, v, { freq: 18, octaves: 2, kind: 'simplex', layer: 7 }));
    // Sweat: patches with a spray of droplets inside them, never a wash. Half
    // resolution — a specular breakup mask has no business being crisp.
    const wetF = Field.lowRes(size, size >> 1, (u, v) => {
      const patch = clamp01(0.5 + 0.6 * n.fbm(u, v, { freq: 6, octaves: 3, kind: 'simplex', layer: 10 }));
      const drops = Math.max(0, n.worleyEdge(u, v, Math.round(poreFreq * 0.75), { jitter: 1, layer: 11 }) - 0.55) * 2.2;
      return clamp01((patch - (1 - o.sweat)) * 2.4) * clamp01(0.55 + drops);
    });
    const clusterF = o.freckles > 0
      ? Field.lowRes(size, lo, (u, v) => clamp01(0.5 + 0.5 * n.fbm(u, v, { freq: 4, octaves: 2, kind: 'simplex', layer: 8 })))
      : null;

    color.fill((u, v, x, y, out) => {
      const coarse = n.worleyEdge(u, v, netFreq, { jitter: 0.85, aspect: 0.72, layer: 1 });
      const fine = n.worleyEdge(u, v, fineFreq, { jitter: 0.95, aspect: 1.25, layer: 2 });
      // Furrows cut down; the lozenges between them dome up very slightly.
      const network = Math.pow(coarse, 2.2) * 0.75 + Math.pow(fine, 2.6) * 0.35;

      const pw = n.worley(u, v, poreFreq, { jitter: 1, layer: 3 });
      // Only about half the cells carry a visible pore, and they vary in size.
      const poreGate = smoothstep(0.42, 0.62, pw.id);
      const pore = poreGate * Math.exp(-((pw.f1 / (0.20 + 0.16 * pw.id)) ** 2) * 3);

      const micro = 0.35 * n.fbm(u, v, { freq: Math.round(size / 5), octaves: 2, kind: 'value', layer: 4 });
      const h = -o.micro * network - o.pores * 0.55 * pore + micro * 0.12;
      height.set(x, y, h);

      // Subdermal: a broad warm field (blood) under a broad cool one (surface),
      // plus a finer capillary mottle. All low contrast — the moment this is
      // legible as a pattern it reads as dirt.
      const warm = warmF.get(x, y);
      const cool = coolF.get(x, y);
      const capillary = capF.get(x, y);
      for (let c = 0; c < 3; c++) {
        out[c] = mix(out[c], sssC[c], o.subdermal * 0.22 * warm);
        out[c] = mix(out[c], coolC[c], o.subdermal * 0.16 * cool);
      }
      const tone = 1 + capillary * 0.028 - network * 0.10 - pore * 0.16;
      out[0] *= tone;
      out[1] *= tone;
      out[2] *= tone;

      if (clusterF) {
        // Freckles cluster across the nose and shoulders rather than scattering
        // evenly, so a broad mask gates the per-cell dots.
        const cluster = clusterF.get(x, y);
        const fw = n.worley(u, v, Math.round(poreFreq * 0.6), { jitter: 1, layer: 9 });
        const dot = smoothstep(1 - o.freckles * 0.55, 1, fw.id) * Math.exp(-((fw.f1 / 0.26) ** 2) * 2.6);
        const amt = clamp01(dot * cluster * 1.4) * 0.55;
        for (let c = 0; c < 3; c++) out[c] = mix(out[c], freckC[c], amt);
      }

      const wet = wetF.get(x, y);
      sheen.set(x, y, wet);

      // Wet skin is smoother; furrows and pores stay matte whatever happens.
      rough.set(x, y, clamp01(0.55 - wet * 0.42 + network * 0.22 + pore * 0.2));
    });

    if (o.neutral) color.desaturateToward(0.74, 1);

    return {
      map: albedoTexture(color, 'skin-albedo'),
      // Deliberately shallow. Skin relief should only appear near the
      // terminator; if it reads across the lit side the fighter looks reptilian.
      normalMap: normalTexture(height, { strength: 0.42, step: 1, name: 'skin-normal' }),
      roughnessMap: scalarTexture(rough, o.roughness - 0.28, Math.min(1, o.roughness + 0.22), 'skin-rough'),
      aux: { sheenMask: scalarTexture(sheen, 0, 1, 'skin-sheen') },
      size,
      tileMetres: o.tileMetres,
      seam: height.seamError(),
    };
  });
}
