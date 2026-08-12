import * as THREE from 'three';
import { ColorField, Field, shiftedSrgb, srgb } from './field';
import { Noise, clamp01, mix, noise, smoothstep, smootherstep, stripeDistance, tri, wrapIndex } from './noise';
import { albedoTexture, cached, flowTexture, normalTexture, scalarTexture, texSize, TexSet } from './texture';

/**
 * Woven, quilted, knitted and wrapped cloth.
 *
 * The fighters wear five kinds of fabric and each one is a different *lighting*
 * problem, which is why they get five generators rather than one with a dial:
 *
 * - **cotton canvas** is matte, so all its character is in the weave's normal —
 *   the albedo barely moves (Kai's gi, Davi's abadá).
 * - **quilted nylon** is about form, not fibre: the seam depressions and the
 *   loft between them are what a viewer reads, at a scale where they cast
 *   actual shadows (Vera's vest).
 * - **satin** is nothing but its specular: a nearly flat surface whose
 *   roughness is streaked along the float direction (Mali's shorts).
 * - **rib knit** has the deepest relief of the five and reads at silhouette
 *   distance (collars, cuffs).
 * - **bandage** is a stack of overlapping layers, so its story is the step at
 *   every band edge and the grime that collects in it (hand wraps).
 *
 * Cel shading gives a surface two or three lighting bands, which means texture
 * is doing far more work here than it would under a PBR key light: it is the
 * only thing separating "orange cloth" from "orange plastic". The amplitudes
 * below are tuned to read at fighting-camera distance — roughly a fighter at
 * 40% of frame height — and deliberately stop short of the crunchy microdetail
 * that looks great in a texture viewer and like sandpaper in motion.
 */

const TAU = Math.PI * 2;

export interface FabricBase {
  color: THREE.ColorRepresentation;
  seed?: number;
  /** Authored resolution, before the global quality scale. */
  resolution?: number;
  /** Physical size of one tile in metres; drives the caller's UV repeat. */
  tileMetres?: number;
  /**
   * Emit a multiplicative detail map centred on mid-grey instead of a finished
   * albedo. For materials that already carry the palette colour and only want
   * the surface's structure.
   */
  neutral?: boolean;
}

function hex(c: THREE.ColorRepresentation): string {
  return `#${new THREE.Color(c).getHexString()}`;
}

/**
 * A neighbour colour, moved in sRGB HSL.
 *
 * `Color.offsetHSL` works in the linear working space, where a "0.1 lighter"
 * move means something quite different in the darks than in the lights. Thread,
 * stitch and sheen colours are authored by eye, so they move in the space they
 * were picked in.
 */
function shifted(c: THREE.ColorRepresentation, dl: number, ds = 0, dh = 0): THREE.Color {
  const t = shiftedSrgb(c, dl, ds, dh);
  return new THREE.Color().setRGB(t[0], t[1], t[2], THREE.SRGBColorSpace);
}

/** Applies the `neutral` option and hands back the finished albedo texture. */
function finishAlbedo(color: ColorField, o: { neutral?: boolean }, name: string): THREE.DataTexture {
  if (o.neutral) color.desaturateToward(0.72, 1);
  return albedoTexture(color, name);
}

// ---------------------------------------------------------------------------
// Weave — shared by canvas, banner and the gauze inside a bandage wrap.
// ---------------------------------------------------------------------------

export type WeaveKind = 'plain' | 'twill' | 'basket';

export interface WeaveOptions {
  /** Threads per axis across the tile. */
  threads?: number;
  kind?: WeaveKind;
  /** >1 packs threads until they touch and squash; 1 leaves a visible hole. */
  packing?: number;
  /** How far groups of threads wander, in thread widths. Zero looks printed. */
  drift?: number;
}

/** A weave with every option resolved — what `weaveAt` evaluates. */
export interface WeaveSpec extends Required<WeaveOptions> {}

function resolveWeave(o: WeaveOptions): WeaveSpec {
  return {
    // Snapped to a multiple of four. The weave's over/under phase advances one
    // step per thread and repeats every two (plain), four (twill) or four
    // (basket, in pairs) — so a thread count that is not a multiple of four puts
    // a half-cycle jump at the wrap and the tile seams along its own weave.
    threads: Math.max(4, Math.round((o.threads ?? 64) / 4) * 4),
    kind: o.kind ?? 'plain',
    packing: o.packing ?? 1.12,
    drift: o.drift ?? 0.35,
  };
}

export interface WeaveSample {
  height: number;
  /** +1 where the warp is on top, -1 where the weft is. Drives thread tinting. */
  face: number;
  /** Stable 0..1 per warp / weft thread, for dye-lot variation. */
  idWarp: number;
  idWeft: number;
}

const _weave: WeaveSample = { height: 0, face: 0, idWarp: 0, idWeft: 0 };

/**
 * Analytic plain/twill/basket weave.
 *
 * Evaluated at arbitrary coordinates rather than baked into a field, because
 * the bandage wrap needs the weave rotated into its own band frame — cloth
 * threads run along the band, not along UV.
 *
 * The undulation is a cosine along each thread rather than a checkerboard
 * step: a real thread rises over its neighbour and dips under the next one
 * continuously, and that continuity is exactly what stops the normal map from
 * looking like a waffle.
 */
export function weaveAt(n: Noise, u: number, v: number, o: WeaveSpec): Readonly<WeaveSample> {
  const T = o.threads;
  const driftFreq = Math.max(2, Math.round(T / 10));
  const du = (o.drift / T) * n.perlin(u, v, driftFreq, 3);
  const dv = (o.drift / T) * n.perlin(u, v, driftFreq, 9);
  const pu = (u + du) * T;
  const pv = (v + dv) * T;
  const iu = Math.floor(pu);
  const iv = Math.floor(pv);

  // Thread identity is looked up on a wrapped index: thread T is thread 0.
  const idWarp = n.rand(wrapIndex(iu, T), 0, 17);
  const idWeft = n.rand(0, wrapIndex(iv, T), 29);

  // Slub: real yarn is not one diameter. A few threads per hundred run thick.
  const gaugeU = 1 + (idWarp - 0.5) * 0.22;
  const gaugeV = 1 + (idWeft - 0.5) * 0.22;
  const cu = ((pu - iu) - 0.5) * 2 / (o.packing * gaugeU);
  const cv = ((pv - iv) - 0.5) * 2 / (o.packing * gaugeV);
  const profU = Math.sqrt(Math.max(0, 1 - Math.min(1, cu * cu)));
  const profV = Math.sqrt(Math.max(0, 1 - Math.min(1, cv * cv)));

  const rep = o.kind === 'twill' ? 4 : 2;
  const group = o.kind === 'basket' ? 2 : 1;
  const phaseW = (Math.floor(iu / group) + pv / group - 0.5) * TAU / rep;
  const phaseF = (Math.floor(iv / group) + pu / group - 0.5) * TAU / rep;
  const cw = Math.cos(phaseW);
  const cf = Math.cos(phaseF);
  // Twill's float runs over two threads, so its crossing has to plateau rather
  // than peak. A rational sigmoid squares the cosine off for a tenth of what
  // `Math.tanh` costs, and this runs a quarter of a million times per texture.
  const sWarp = rep === 4 ? (cw * 2.2) / (1 + Math.abs(cw * 1.55)) : cw;
  const sWeft = rep === 4 ? -(cf * 2.2) / (1 + Math.abs(cf * 1.55)) : -cf;

  // An under-thread is behind its neighbour, not absent: it keeps 28% of its
  // height so it still shows in the interstices.
  const hWarp = profU * (0.28 + 0.72 * (0.5 + 0.5 * sWarp));
  const hWeft = profV * (0.28 + 0.72 * (0.5 + 0.5 * sWeft));

  _weave.height = Math.max(hWarp, hWeft);
  _weave.face = hWarp >= hWeft ? 1 : -1;
  _weave.idWarp = idWarp;
  _weave.idWeft = idWeft;
  return _weave;
}

export interface CanvasFabricOptions extends FabricBase, WeaveOptions {
  /** Loose surface fibre. Flannel and gi cotton have it; a banner does not. */
  fuzz?: number;
  /** Base roughness. Cotton sits high; a technical weave lower. */
  roughness?: number;
  /** Depth of the woven relief in the normal map. */
  relief?: number;
  /** Unevenness of the dye, low frequency. */
  mottle?: number;
}

/**
 * Matte woven cotton: gi, abadá, hoodie, crop top, compression shorts.
 *
 * Twill for a heavy gi (the diagonal catches the key light and reads as
 * *weight*), plain for shirting, basket for a coarse canvas duck.
 */
export function cottonCanvas(opts: CanvasFabricOptions): TexSet {
  const w = resolveWeave(opts);
  const o = {
    color: hex(opts.color),
    seed: opts.seed ?? 11,
    resolution: opts.resolution ?? 512,
    tileMetres: opts.tileMetres ?? 0.22,
    neutral: opts.neutral ?? false,
    fuzz: opts.fuzz ?? 0.5,
    roughness: opts.roughness ?? 0.86,
    relief: opts.relief ?? 1,
    mottle: opts.mottle ?? 0.5,
    ...w,
  };

  return cached('cottonCanvas', o, () => {
    const size = texSize(o.resolution);
    const n = noise(o.seed);
    const height = new Field(size);
    const rough = new Field(size);
    const color = new ColorField(size, opts.color);
    const warm = shiftedSrgb(opts.color, 0.035, 0.02, 0.004);
    const cool = shiftedSrgb(opts.color, -0.04, 0.01, -0.008);
    const fuzzC = shiftedSrgb(opts.color, 0.09, -0.05, 0);

    const microFreq = Math.max(16, Math.round(size / 3));
    // Dye unevenness is a broad field; evaluating simplex per texel for it is
    // most of what a naive weave generator spends its time on.
    const mottleF = Field.lowRes(size, 64, (u, v) => n.fbm(u, v, { freq: 3, octaves: 3, kind: 'simplex', layer: 2 }));

    color.fill((u, v, x, y, out) => {
      const s = weaveAt(n, u, v, o);
      // Surface nap: fibres standing off the weave. Scattered, not everywhere,
      // or it turns into film grain.
      const fuzz = o.fuzz * 0.5 * Math.max(0, n.value(u, v, microFreq, 5)) * Math.max(0, n.value(u, v, Math.round(microFreq / 3), 7));
      const h = s.height + fuzz * 0.35;
      height.set(x, y, h);

      // Warp and weft are spun and dyed separately; giving them different tone
      // is what makes a flat colour read as *cloth* rather than as paper.
      const t = s.face > 0 ? warm : cool;
      const id = s.face > 0 ? s.idWarp : s.idWeft;
      const lot = (id - 0.5) * 0.09;
      const mott = o.mottle * 0.055 * mottleF.get(x, y);
      const shade = 0.80 + 0.30 * h + lot + mott;
      out[0] = t[0] * shade;
      out[1] = t[1] * shade;
      out[2] = t[2] * shade;
      out[0] = mix(out[0], fuzzC[0], fuzz * 0.4);
      out[1] = mix(out[1], fuzzC[1], fuzz * 0.4);
      out[2] = mix(out[2], fuzzC[2], fuzz * 0.4);

      // Thread crowns are burnished by the loom and by wear; the sunk crossings
      // stay fuzzy. That difference is most of cotton's specular character.
      rough.set(x, y, clamp01(1 - h * 0.32 + fuzz * 0.3 + (id - 0.5) * 0.1));
    });

    return {
      map: finishAlbedo(color, o, 'canvas-albedo'),
      normalMap: normalTexture(height, { strength: 0.55 * o.relief, name: 'canvas-normal' }),
      roughnessMap: scalarTexture(rough, o.roughness - 0.16, Math.min(1, o.roughness + 0.1), 'canvas-rough'),
      size,
      tileMetres: o.tileMetres,
      seam: height.seamError(),
    };
  });
}

// ---------------------------------------------------------------------------
// Quilting
// ---------------------------------------------------------------------------

export type QuiltPattern = 'channel' | 'box' | 'diamond';

export interface QuiltedFabricOptions extends FabricBase {
  pattern?: QuiltPattern;
  /** Quilt lines across the tile. With tileMetres 0.5 and 6, channels are ~8 cm. */
  cells?: number;
  /** Loft between the seams, 0..1. A gilet is ~0.6, a heavy parka 1. */
  puff?: number;
  /** How hard the fabric is pinched at the stitch line. */
  seamDepth?: number;
  /** Visible stitching along the seam. */
  stitch?: boolean;
  stitchColor?: THREE.ColorRepresentation;
  /** Stitches per tile along a seam. */
  stitchPitch?: number;
  /** Ripstop grid in the shell — the giveaway that a puffer is nylon, not cotton. */
  ripstop?: boolean;
  /** Base roughness of the shell. Nylon is glossy; a cotton quilt is not. */
  roughness?: number;
}

/**
 * Quilted / puffer shell — Vera's vest.
 *
 * The whole read is the loft profile. Batting does not bulge like a balloon: it
 * is pinched to nothing at the stitch line, climbs fast over the first
 * centimetre, then flattens across the middle of the panel. So the height is a
 * fast-rising curve with a plateau, minus a narrow gaussian pinch on the seam
 * itself — the *pinch* is the part that sells it, because it is what puts a
 * dark line under the stitching in every lighting condition.
 *
 * Two details do most of the remaining work. Puckering: the fabric gathers
 * against the seam in short creases perpendicular to it, strongest right at the
 * seam and gone within a third of a panel. And the stitch thread itself, a
 * dashed bump lying *inside* the depression, so the highlight on the thread and
 * the shadow in the groove sit a texel apart and read as sewn.
 *
 * `aux.seamMask` is 1 along the quilt lines: the ink pass can draw them as
 * real linework, which is how they would be drawn by hand.
 */
export function quiltedFabric(opts: QuiltedFabricOptions): TexSet {
  const o = {
    color: hex(opts.color),
    seed: opts.seed ?? 23,
    resolution: opts.resolution ?? 512,
    tileMetres: opts.tileMetres ?? 0.5,
    neutral: opts.neutral ?? false,
    pattern: opts.pattern ?? 'channel',
    cells: Math.max(2, Math.round(opts.cells ?? 6)),
    puff: opts.puff ?? 0.72,
    seamDepth: opts.seamDepth ?? 0.5,
    stitch: opts.stitch ?? true,
    stitchColor: hex(opts.stitchColor ?? shifted(opts.color, 0.12, -0.1)),
    stitchPitch: opts.stitchPitch ?? 90,
    ripstop: opts.ripstop ?? true,
    roughness: opts.roughness ?? 0.44,
  };

  return cached('quiltedFabric', o, () => {
    const size = texSize(o.resolution);
    const n = noise(o.seed);
    const height = new Field(size);
    const seamMask = new Field(size);
    const rough = new Field(size);
    const color = new ColorField(size, opts.color);
    const seamCol = shiftedSrgb(opts.color, -0.09, 0.05, -0.01);
    const crownCol = shiftedSrgb(opts.color, 0.045, -0.02, 0.006);
    const stitchCol = srgb(o.stitchColor);

    const spacing = 1 / o.cells;
    const half = spacing * 0.5;
    const seamW = spacing * 0.055;

    const g = { d: 0, panel: 0, along: 0 };
    // A sewn line is never straight — the presser foot wanders a millimetre.
    const wobF = Field.lowRes(size, 64, (u, v) => n.fbm(u, v, { freq: 3, octaves: 2, kind: 'simplex', layer: 5 }));
    const slackF = Field.lowRes(size, 96, (u, v) => n.fbm(u, v, { freq: 6, octaves: 3, kind: 'simplex', layer: 12 }));

    /** Distance to the nearest quilt line, which panel we are in, and where along it. */
    const seamGeom = (u: number, v: number, x: number, y: number): void => {
      const wob = 0.16 * spacing * wobF.get(x, y);
      if (o.pattern === 'channel') {
        const vv = v + wob;
        g.d = stripeDistance(vv, spacing);
        g.panel = wrapIndex(Math.floor(vv / spacing), o.cells);
        g.along = u;
        return;
      }
      if (o.pattern === 'box') {
        const du = stripeDistance(u + wob, spacing);
        const dv = stripeDistance(v + wob, spacing);
        g.panel = wrapIndex(Math.floor((u + wob) / spacing), o.cells) * 31
          + wrapIndex(Math.floor((v + wob) / spacing), o.cells);
        g.d = Math.min(du, dv);
        g.along = du < dv ? v : u;
        return;
      }
      // Diagonal families. Both coordinates advance by an integer number of
      // panels under a unit step in u or v, so the lattice still wraps.
      const a = u + v + wob;
      const b = u - v + wob;
      const da = stripeDistance(a, spacing) * 0.7071;
      const db = stripeDistance(b, spacing) * 0.7071;
      g.panel = wrapIndex(Math.floor(a / spacing), o.cells) * 31 + wrapIndex(Math.floor(b / spacing), o.cells);
      g.d = Math.min(da, db);
      g.along = da < db ? b : a;
    };

    const microFreq = Math.max(24, Math.round(size / 4));
    const ripPitch = 1 / 40;

    color.fill((u, v, x, y, out) => {
      seamGeom(u, v, x, y);
      const d = g.d;

      // Loft: batting rises over the first third of the panel and then it is
      // simply full. Letting the dome run the whole half-width is what turns a
      // quilted vest into a row of sausages.
      const t = clamp01(d / (half * 0.42));
      let h = o.puff * smootherstep(0, 1, t);

      // Pinch. Narrow and deep — this is the line the eye actually reads.
      const pinch = Math.exp(-((d / seamW) * (d / seamW)) * 0.9);
      h -= o.puff * o.seamDepth * pinch;

      // Gathering: short creases running away from the seam, dying out fast.
      const puckFreq = Math.max(8, Math.round(o.cells * 9));
      const pucker = n.perlin(g.along, 0.37, puckFreq, 40 + (g.panel & 7));
      h += o.puff * 0.09 * pucker * Math.exp(-d / (half * 0.42));

      // Panel-scale slack — a quilted panel is never perfectly convex.
      h += o.puff * 0.05 * slackF.get(x, y);

      let stitchM = 0;
      if (o.stitch) {
        const s = g.along * o.stitchPitch;
        const phase = s - Math.floor(s);
        // Each stitch is a short bar of thread with a gap where it dives back
        // through the fabric.
        const along = smoothstep(0.06, 0.14, phase) * (1 - smoothstep(0.62, 0.72, phase));
        const across = Math.exp(-((d / (seamW * 0.72)) ** 2) * 2.2);
        stitchM = along * across;
        h += o.puff * 0.10 * stitchM;
      }

      if (o.ripstop) {
        // Reinforcement threads: a coarse grid woven into an otherwise smooth
        // shell, only a hair proud of it.
        const rg = Math.max(
          1 - Math.min(1, stripeDistance(u, ripPitch) / (ripPitch * 0.13)),
          1 - Math.min(1, stripeDistance(v, ripPitch) / (ripPitch * 0.13)),
        );
        h += 0.022 * o.puff * smootherstep(0, 1, rg);
      }

      // Shell micro-grain. Barely there; nylon is smooth.
      h += 0.012 * n.value(u, v, microFreq, 3);
      height.set(x, y, h);
      seamMask.set(x, y, clamp01(pinch * 1.15));

      // Shading gradient across the panel. Taken from the *distance to the
      // seam* rather than from the height, because the loft plateaus early and
      // a plateau paints as a flat slab of colour — while the light that
      // reaches the middle of a quilted panel keeps rising all the way across.
      const crown = smoothstep(0, half * 0.95, d);
      // Dye lot per panel: bought as a roll, cut and sewn, and it shows.
      const lot = (n.rand(g.panel & 255, 3, 71) - 0.5) * 0.045;
      const shade = 0.84 + 0.26 * crown + lot;
      out[0] *= shade;
      out[1] *= shade;
      out[2] *= shade;
      for (let c = 0; c < 3; c++) {
        // The seam's darkness belongs in the *normal*, where the light decides
        // how deep it looks. Painting it into the albedo as well gives every
        // channel a black outline and the vest reads as inflatable.
        out[c] = mix(out[c], seamCol[c], clamp01(pinch * 0.45));
        out[c] = mix(out[c], crownCol[c], crown * 0.28);
        out[c] = mix(out[c], stitchCol[c], stitchM * 0.85);
      }

      // The shell is glossiest where it is stretched taut over the loft and
      // dullest where it is compressed into the seam.
      rough.set(x, y, clamp01(0.55 - crown * 0.32 + pinch * 0.42 + stitchM * 0.3 + 0.05 * n.value(u, v, 64, 8)));
    });

    return {
      map: finishAlbedo(color, o, 'quilt-albedo'),
      normalMap: normalTexture(height, { strength: 1.5, step: 1, name: 'quilt-normal' }),
      roughnessMap: scalarTexture(rough, o.roughness - 0.14, Math.min(1, o.roughness + 0.4), 'quilt-rough'),
      aux: { seamMask: scalarTexture(seamMask, 0, 1, 'quilt-seam') },
      size,
      tileMetres: o.tileMetres,
      seam: height.seamError(),
    };
  });
}

// ---------------------------------------------------------------------------
// Satin
// ---------------------------------------------------------------------------

export interface SatinFabricOptions extends FabricBase {
  /** Which way the floats run. Muay thai shorts are cut with them horizontal. */
  direction?: 'u' | 'v';
  /** Sheen colour at the highlight. Satin's highlight is tinted, never white. */
  sheenColor?: THREE.ColorRepresentation;
  /** Base roughness; 0.18 is a hard shine, 0.35 a dull sateen. */
  roughness?: number;
  /** Soft fold lines pressed into the cloth, 0..1. */
  creases?: number;
}

/**
 * Satin — Mali's shorts.
 *
 * A satin weave floats long runs of yarn over the surface, so the geometry is
 * almost flat and every bit of its identity lives in the *specular*: a broad
 * highlight, smeared along the float direction, broken into fine silky streaks.
 *
 * That means the normal map here is nearly neutral by design (over-embossing
 * satin is the classic mistake — it turns silk into corduroy) and the work is
 * done by a streaked roughness map plus `aux.flowMap`, which tells an
 * anisotropic shader which way to stretch the highlight at each texel.
 */
export function satinFabric(opts: SatinFabricOptions): TexSet {
  const o = {
    color: hex(opts.color),
    seed: opts.seed ?? 37,
    resolution: opts.resolution ?? 512,
    tileMetres: opts.tileMetres ?? 0.3,
    neutral: opts.neutral ?? false,
    direction: opts.direction ?? 'u',
    sheenColor: hex(opts.sheenColor ?? shifted(opts.color, 0.28, -0.15)),
    roughness: opts.roughness ?? 0.22,
    creases: opts.creases ?? 0.35,
  };

  return cached('satinFabric', o, () => {
    const size = texSize(o.resolution);
    const n = noise(o.seed);
    const along = o.direction;

    // Fine floats: isotropic noise smeared along the yarn. Two scales, because
    // silk shows both individual filaments and the wider bands where a group of
    // them lies the same way.
    // The smear has to be long — a hundred texels, not ten. Satin's identity is
    // that its highlight is *stretched*; a mild blur just gives you clouds, and
    // clouds on black shorts read as smudges.
    const fine = Field.from(size, (u, v) => n.value(u, v, Math.max(32, Math.round(size / 2)), 4));
    fine.blurAxis(Math.max(3, size / 24), along, 2).normalize(-1, 1);
    const broad = Field.from(size, (u, v) => n.value(u, v, Math.max(16, Math.round(size / 12)), 6));
    broad.blurAxis(Math.max(8, size / 5), along, 2).normalize(-1, 1);

    // Pressed folds: long and soft, running across the floats, which is how a
    // pair of shorts comes out of the packet.
    const creaseWob = Field.lowRes(size, 48, (u, v) => n.fbm(u, v, { freq: 2, octaves: 2, kind: 'simplex', layer: 21 }));
    const crease = Field.from(size, (u, v, x, y) => {
      const t = along === 'u' ? u : v;
      const d = stripeDistance(t + 0.05 * creaseWob.get(x, y), 1 / 3);
      return Math.exp(-((d / 0.045) ** 2));
    });

    const height = new Field(size);
    const rough = new Field(size);
    const flowX = new Field(size);
    const flowY = new Field(size);
    const color = new ColorField(size, opts.color);
    const sheen = srgb(o.sheenColor);
    // Drape bend for the anisotropy direction. Curl is four fBm taps, so it is
    // sampled coarsely and resampled — the cloth does not change direction over
    // a texel.
    const flow: [number, number] = [0, 0];
    const bendX = Field.lowRes(size, 64, (u, v) => n.curl(u, v, { freq: 3, octaves: 2, layer: 33 }, flow)[0]);
    const bendY = Field.lowRes(size, 64, (u, v) => n.curl(u, v, { freq: 3, octaves: 2, layer: 33 }, flow)[1]);

    color.fill((u, v, x, y, out) => {
      const f = fine.get(x, y);
      const b = broad.get(x, y);
      const cr = crease.get(x, y) * o.creases;

      height.set(x, y, f * 0.35 + b * 0.5 + cr * 0.9);

      // Satin's albedo swings far more than cotton's: the same dye looks like
      // two colours depending on whether the floats face you.
      const v0 = 1 + b * 0.13 + f * 0.07 - cr * 0.10;
      out[0] *= v0;
      out[1] *= v0;
      out[2] *= v0;
      const hot = clamp01(b * 0.8 + f * 0.3) * 0.5;
      for (let c = 0; c < 3; c++) out[c] = mix(out[c], sheen[c], hot);

      // Streaked roughness is the entire trick: a highlight crossing this
      // surface breaks into filaments instead of sliding as a blob.
      rough.set(x, y, clamp01(0.5 - b * 0.30 - f * 0.16 + cr * 0.35));

      // Flow: nominally the float direction, bent slightly by the drape so the
      // anisotropy follows the cloth rather than the UV grid.
      const bend = 0.18;
      if (along === 'u') {
        flowX.set(x, y, 1);
        flowY.set(x, y, bendY.get(x, y) * bend);
      } else {
        flowX.set(x, y, bendX.get(x, y) * bend);
        flowY.set(x, y, 1);
      }
    });

    return {
      map: finishAlbedo(color, o, 'satin-albedo'),
      // Deliberately weak. Satin that shows its weave in the normal is velvet.
      normalMap: normalTexture(height, { strength: 0.22, step: 2, name: 'satin-normal' }),
      roughnessMap: scalarTexture(rough, o.roughness - 0.08, o.roughness + 0.26, 'satin-rough'),
      aux: {
        flowMap: flowTexture(flowX, flowY, 'satin-flow'),
        sheenMask: scalarTexture(broad.clone().normalize(0, 1), 0, 1, 'satin-sheen'),
      },
      size,
      tileMetres: o.tileMetres,
      seam: height.seamError(),
    };
  });
}

// ---------------------------------------------------------------------------
// Rib knit
// ---------------------------------------------------------------------------

export interface RibbedKnitOptions extends FabricBase {
  /** Wales (vertical ribs) across the tile. */
  ribs?: number;
  /** Courses (rows of stitches) down the tile. */
  courses?: number;
  /** 1 = 1x1 rib (collar), 2 = 2x2 (cuff). */
  ribWidth?: number;
  /** Halo of loose fibre around the yarn. */
  fuzz?: number;
  roughness?: number;
}

/**
 * Rib knit — collars, cuffs, waistbands, Davi's ankle bands.
 *
 * The deepest relief of any cloth on these characters: the wales stand proud
 * far enough that at fighting distance they read in the *silhouette*, so this
 * one is allowed a strong normal. The chevron of the loop legs is modelled too,
 * because without it a rib is just a set of tubes, and tubes are what a
 * corrugated roof is made of.
 */
export function ribbedKnit(opts: RibbedKnitOptions): TexSet {
  const o = {
    color: hex(opts.color),
    seed: opts.seed ?? 53,
    resolution: opts.resolution ?? 512,
    tileMetres: opts.tileMetres ?? 0.12,
    neutral: opts.neutral ?? false,
    ribs: Math.max(2, Math.round(opts.ribs ?? 16)),
    courses: Math.max(2, Math.round(opts.courses ?? 22)),
    ribWidth: Math.max(1, Math.round(opts.ribWidth ?? 1)),
    fuzz: opts.fuzz ?? 0.6,
    roughness: opts.roughness ?? 0.9,
  };

  return cached('ribbedKnit', o, () => {
    const size = texSize(o.resolution);
    const n = noise(o.seed);
    const height = new Field(size);
    const rough = new Field(size);
    const color = new ColorField(size, opts.color);
    const deep = shiftedSrgb(opts.color, -0.1, 0.04, -0.012);
    const fuzzC = shiftedSrgb(opts.color, 0.11, -0.06, 0);
    const microFreq = Math.max(24, Math.round(size / 3));
    // Knits distort constantly — they stretch over whatever is inside them.
    const stretch = Field.lowRes(size, 64, (u, v) => n.fbm(u, v, { freq: 4, octaves: 2, kind: 'simplex', layer: 3 }));

    color.fill((u, v, x, y, out) => {
      const pu = (u + 0.012 * stretch.get(x, y)) * o.ribs;
      const pv = v * o.courses;
      const iu = wrapIndex(Math.floor(pu), o.ribs);
      const fu = pu - Math.floor(pu);

      // Wale: a round-topped ridge with a narrow, deep valley between.
      const wale = Math.pow(Math.sin(Math.PI * clamp01(fu)), 0.75);
      const ribGauge = 1 + (n.rand(iu, 0, 5) - 0.5) * 0.16;

      // Loops: each course pinches the wale slightly, and the legs of the loop
      // cross it as a shallow chevron. Both stay small — pushed any harder the
      // courses read as a second set of ribs and the knit turns into mesh.
      const loop = 1 - 0.12 * Math.pow(Math.abs(Math.sin(Math.PI * pv)), 3);
      const chevron = 0.04 * Math.cos(TAU * (pv + 0.5 * tri(pu)));

      const fuzz = o.fuzz * 0.35 * Math.max(0, n.value(u, v, microFreq, 11));
      const h = wale * ribGauge * loop + chevron + fuzz * 0.25;
      height.set(x, y, h);

      const lit = clamp01(h);
      const shade = 0.72 + 0.5 * lit + (n.rand(iu, 0, 13) - 0.5) * 0.06;
      out[0] *= shade;
      out[1] *= shade;
      out[2] *= shade;
      const inValley = 1 - clamp01(h * 1.6);
      for (let c = 0; c < 3; c++) {
        out[c] = mix(out[c], deep[c], inValley * 0.55);
        out[c] = mix(out[c], fuzzC[c], fuzz * 0.5);
      }

      rough.set(x, y, clamp01(0.72 - lit * 0.22 + fuzz * 0.5));
    });

    return {
      map: finishAlbedo(color, o, 'knit-albedo'),
      normalMap: normalTexture(height, { strength: 1.35, name: 'knit-normal' }),
      roughnessMap: scalarTexture(rough, o.roughness - 0.18, Math.min(1, o.roughness + 0.06), 'knit-rough'),
      size,
      tileMetres: o.tileMetres,
      seam: height.seamError(),
    };
  });
}

// ---------------------------------------------------------------------------
// Bandage wrap
// ---------------------------------------------------------------------------

export interface BandageWrapOptions extends FabricBase {
  /** Band repeats along U and V. Integers, or the diagonal will not tile. */
  bandsU?: number;
  bandsV?: number;
  /** How proud the overlapping edge of each band sits. */
  overlap?: number;
  /** Loose fibre at the band edges, 0..1. */
  fray?: number;
  /** Gauze threads across one band's width. */
  threads?: number;
  /** Dirt collected in the creases. Fighters' wraps are not new. */
  grime?: number;
  grimeColor?: THREE.ColorRepresentation;
  roughness?: number;
}

/**
 * Hand wrap / bandage — Kai's and Vera's white tape, Mali's red, Davi's blue.
 *
 * A wrap is a spiral, so the texture is a family of parallel diagonal bands
 * where each band's leading edge lies *on top of* the one before. Three
 * features carry that:
 *
 * 1. a raised lip at the leading edge, decaying over a few millimetres;
 * 2. a hard crease groove where the next band buries the previous one — the
 *    dark line the eye reads as "layers";
 * 3. per-band tone, because each pass of the roll is stretched differently and
 *    catches the light differently.
 *
 * The gauze weave is evaluated in the band's own frame, so the threads run
 * along the wrap the way they actually do, and the fray is fibre pulled across
 * the edges rather than a noisy outline.
 *
 * `aux.edgeMask` marks the band boundaries for the ink pass.
 */
export function bandageWrap(opts: BandageWrapOptions): TexSet {
  const o = {
    color: hex(opts.color),
    seed: opts.seed ?? 71,
    resolution: opts.resolution ?? 512,
    tileMetres: opts.tileMetres ?? 0.16,
    neutral: opts.neutral ?? false,
    bandsU: Math.max(1, Math.round(opts.bandsU ?? 1)),
    bandsV: Math.max(1, Math.round(opts.bandsV ?? 4)),
    overlap: opts.overlap ?? 0.55,
    fray: opts.fray ?? 0.5,
    threads: Math.max(4, Math.round(opts.threads ?? 14)),
    grime: opts.grime ?? 0.35,
    grimeColor: hex(opts.grimeColor ?? 0x8a7458),
    roughness: opts.roughness ?? 0.92,
  };

  return cached('bandageWrap', o, () => {
    const size = texSize(o.resolution);
    const n = noise(o.seed);
    const height = new Field(size);
    const edgeMask = new Field(size);
    const rough = new Field(size);
    const color = new ColorField(size, opts.color);
    const grimeC = srgb(o.grimeColor);
    const fibreC = shiftedSrgb(opts.color, 0.1, -0.08, 0);
    const weave = resolveWeave({ threads: o.threads, kind: 'plain', packing: 1.05, drift: 0.5 });

    // Everything below is authored in the band frame, where one unit is one
    // band. Frequencies therefore have to be expressed per band, not per tile —
    // `perUnit` is roughly how many texels a band covers.
    const bands = o.bandsU + o.bandsV;
    const perUnit = size / bands;
    const wispFreq = Math.max(6, Math.round(perUnit / 3));

    const wanderF = Field.lowRes(size, 64, (u, v) => n.fbm(u, v, { freq: 3, octaves: 2, kind: 'simplex', layer: 4 }));
    const frayF = Field.lowRes(size, size >> 1, (u, v) => n.fbm(u, v, { freq: 26, octaves: 2, kind: 'perlin', layer: 8 }));
    const dirtF = Field.lowRes(size, 64, (u, v) => clamp01(0.5 + 0.5 * n.fbm(u, v, { freq: 5, octaves: 3, kind: 'simplex', layer: 27 })));
    /**
     * How tightly this part of the wrap is pulled.
     *
     * Per-*band* variation is impossible on a diagonal that wraps: crossing the
     * tile shifts the band index by `bandsU`, so anything keyed to that index
     * has to be constant unless the two counts share a factor. Tension is a
     * smooth 2D field instead, which is closer to the truth anyway — a wrap is
     * pulled harder over the knuckles than over the wrist.
     */
    const tensionF = Field.lowRes(size, 48, (u, v) => n.fbm(u, v, { freq: 4, octaves: 2, kind: 'simplex', layer: 19 }));

    color.fill((u, v, x, y, out) => {
      // Band frame: `s` runs across the bands, `t` along them. Both advance by
      // an integer under a unit step in u or v, so the diagonal wraps.
      const wander = 0.035 * wanderF.get(x, y);
      const frayEdge = o.fray * 0.045 * frayF.get(x, y);
      const s = o.bandsU * u + o.bandsV * v + wander + frayEdge;
      const t = o.bandsV * u - o.bandsU * v;
      const f = s - Math.floor(s);

      // Cross-band shape: gentle bulge, raised leading lip, buried trailing edge.
      const bulge = 0.55 * Math.pow(Math.sin(Math.PI * clamp01(f)), 0.6);
      const lip = o.overlap * Math.exp(-f / 0.10);
      const groove = 0.7 * Math.exp(-(((1 - f) / 0.055) ** 2));
      const tension = 1 + tensionF.get(x, y) * 0.22;

      const w = weaveAt(n, t, s, weave);
      let h = (bulge * tension + lip - groove) + w.height * 0.30;

      // Fray: fibres pulled out of the edge, bridging the groove.
      const wisp = Math.max(0, n.value(t, s, wispFreq, 15)) * Math.max(0, n.value(t, s, Math.max(3, Math.round(wispFreq / 2)), 17));
      const nearEdge = Math.exp(-(((1 - f) / 0.09) ** 2)) + Math.exp(-((f / 0.07) ** 2));
      const fray = o.fray * wisp * nearEdge;
      h += fray * 0.22;
      height.set(x, y, h);
      edgeMask.set(x, y, clamp01(groove * 1.2));

      // Gauze is nearly white and takes light on the weave, not on the tension:
      // keep the broad field out of the albedo or the wrap looks tie-dyed.
      const shade = 0.84 + 0.20 * clamp01(h) + w.height * 0.10 + (tension - 1) * 0.12;
      out[0] *= shade;
      out[1] *= shade;
      out[2] *= shade;

      // Dirt lives in the creases and on the knuckle side, never uniformly.
      const dirt = o.grime * clamp01(groove * 0.8 + dirtF.get(x, y) * 0.55 - 0.2);
      for (let c = 0; c < 3; c++) {
        out[c] = mix(out[c], grimeC[c], dirt * 0.55);
        out[c] = mix(out[c], fibreC[c], clamp01(fray) * 0.6);
      }

      rough.set(x, y, clamp01(0.6 + fray * 0.4 - clamp01(h) * 0.18 + dirt * 0.2));
    });

    return {
      map: finishAlbedo(color, o, 'wrap-albedo'),
      normalMap: normalTexture(height, { strength: 1.1, name: 'wrap-normal' }),
      roughnessMap: scalarTexture(rough, o.roughness - 0.22, Math.min(1, o.roughness + 0.05), 'wrap-rough'),
      aux: { edgeMask: scalarTexture(edgeMask, 0, 1, 'wrap-edge') },
      size,
      tileMetres: o.tileMetres,
      seam: height.seamError(),
    };
  });
}
