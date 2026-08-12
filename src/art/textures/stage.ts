import * as THREE from 'three';
import { ColorField, Field, shiftedSrgb, srgb } from './field';
import { Noise, clamp01, mix, noise, smoothstep, smootherstep, stripeDistance, wrapIndex } from './noise';
import { weaveAt } from './fabric';
import { albedoTexture, cached, normalTexture, scalarTexture, texSize, TexSet } from './texture';

/**
 * Stage surfaces: concrete, worn wood, painted metal, brick, banner cloth,
 * asphalt.
 *
 * A fighting-game stage is read for about eight seconds before the player stops
 * looking at it, so every one of these is built around the same idea: **the
 * material is boring, the history is interesting**. Fresh concrete, clean paint
 * and new planking all read as untextured grey; what makes a stage feel like a
 * place is the record of what has happened to it — water tracking down a wall,
 * paint chipped off an edge that people brush past, boards worn pale where feet
 * land, dirt packed into every crevice.
 *
 * So each generator builds its material first and then weathers it through a
 * shared layering pass: a cavity term keyed off the material's own height (dirt
 * settles where it can), vertical run-off streaks, and broad blotching. Wear
 * that ignores the surface underneath it always reads as a decal.
 */

export interface StageBase {
  seed?: number;
  resolution?: number;
  /** Physical size of one tile in metres. Sets the caller's UV repeat. */
  tileMetres?: number;
  neutral?: boolean;
  /** Overall weathering, 0 = showroom, 1 = derelict. */
  wear?: number;
  /** Dirt colour. Warm grey-brown by default; soot for an industrial stage. */
  grimeColor?: THREE.ColorRepresentation;
}

function hexOf(c: THREE.ColorRepresentation): string {
  return `#${new THREE.Color(c).getHexString()}`;
}

export interface WeatherOptions {
  /** Dirt held in the crevices, driven by the material's own height. */
  cavity?: number;
  /** Run-off down the surface. Walls want this; a floor does not. */
  streaks?: number;
  /** Broad patchiness. */
  blotch?: number;
  layer?: number;
}

/**
 * Dirt distribution for a surface, 0..1.
 *
 * Three overlapping causes, because dirt has causes: it settles where the
 * geometry catches it, it runs downward from wherever water gets in, and it
 * accumulates unevenly across large areas. Any one of them alone looks
 * synthetic; the product of all three looks like a wall.
 */
export function weatherMask(size: number, n: Noise, height: Field | null, o: WeatherOptions = {}): Field {
  const cavity = o.cavity ?? 0.6;
  const streakAmt = o.streaks ?? 0.5;
  const blotchAmt = o.blotch ?? 0.6;
  const layer = o.layer ?? 200;

  const blotch = Field.lowRes(size, 64, (u, v) => clamp01(0.5 + 0.6 * n.fbm(u, v, { freq: 3, octaves: 4, kind: 'simplex', layer })));

  // Run-off: fine variation across the surface, smeared straight down, then
  // gated so it starts from discrete sources rather than raining everywhere.
  // Built and smeared at a quarter scale: the smear destroys the detail anyway,
  // and a blur is sixteen times cheaper on a quarter-size buffer.
  const small = Math.max(64, size >> 2);
  const streaks = Field.from(small, (u, v) => {
    const src = clamp01(n.fbm(u, v, { freq: 14, octaves: 2, kind: 'perlin', layer: layer + 3 }) * 1.6 + 0.15);
    return src * src;
  }).blurAxis(Math.max(2, small / 14), 'v', 2).upsampleTo(size).normalize(0, 1);

  const mask = new Field(size);
  // Cavity dirt tracks a *blurred* height: the settled dust in a groove is
  // wider than the groove, and following the raw height would just re-draw the
  // material's own detail in brown.
  const cav = height ? height.clone().blur(Math.max(1, size / 128), 2).normalize(0, 1) : null;
  for (let i = 0; i < mask.data.length; i++) {
    const b = blotch.data[i];
    const s = streaks.data[i] * (0.35 + 0.65 * b);
    const c = cav ? 1 - cav.data[i] : 0.5;
    mask.data[i] = clamp01(cavity * c * (0.4 + 0.6 * b) + streakAmt * s * 0.8 + blotchAmt * Math.max(0, b - 0.55) * 1.3);
  }
  return mask;
}

// ---------------------------------------------------------------------------

export interface ConcreteOptions extends StageBase {
  color?: THREE.ColorRepresentation;
  /** Exposed aggregate, 0..1. Polished floors low, broken kerbs high. */
  aggregate?: number;
  /** Air pockets left by a bad pour. */
  pits?: number;
  /** Cracking, 0..1. */
  cracks?: number;
  /** Horizontal form-board lines from the shuttering. */
  formLines?: boolean;
  streaks?: number;
}

/** Cast concrete: walls, kerbs, pillars, arena floor. */
export function concrete(opts: ConcreteOptions = {}): TexSet {
  const o = {
    color: hexOf(opts.color ?? 0x9c9890),
    seed: opts.seed ?? 401,
    resolution: opts.resolution ?? 512,
    tileMetres: opts.tileMetres ?? 2,
    neutral: opts.neutral ?? false,
    wear: opts.wear ?? 0.6,
    grimeColor: hexOf(opts.grimeColor ?? 0x4a4238),
    aggregate: opts.aggregate ?? 0.45,
    pits: opts.pits ?? 0.5,
    cracks: opts.cracks ?? 0.4,
    formLines: opts.formLines ?? true,
    streaks: opts.streaks ?? 0.6,
  };

  return cached('concrete', o, () => {
    const size = texSize(o.resolution);
    const n = noise(o.seed);
    const height = new Field(size);
    const rough = new Field(size);
    const color = new ColorField(size, o.color);
    const dark = shiftedSrgb(o.color, -0.13, 0.02, -0.01);
    const stoneWarm = shiftedSrgb(o.color, -0.05, 0.09, -0.03);
    const stoneCool = shiftedSrgb(o.color, 0.03, 0.03, 0.08);
    const pale = shiftedSrgb(o.color, 0.1, -0.04, 0);

    const aggFreq = Math.max(16, Math.round(size / 12));
    const cracked = new Field(size);

    const undulation = Field.lowRes(size, 128, (u, v) => n.fbm(u, v, { freq: 5, octaves: 4, kind: 'simplex', layer: 1 }));
    const exposureF = Field.lowRes(size, 64, (u, v) => smoothstep(0.45, 0.8, clamp01(0.5 + 0.6 * n.fbm(u, v, { freq: 4, octaves: 3, kind: 'simplex', layer: 3 }))));
    const crackF = Field.lowRes(size, size >> 1, (u, v) => clamp01(clamp01(n.fbm(u, v, { freq: 6, octaves: 4, ridged: true, kind: 'perlin', layer: 5 }) * 1.15 - 0.80) * 5));
    const formWob = o.formLines ? Field.lowRes(size, 64, (u, v) => n.fbm(u, v, { freq: 2, octaves: 2, layer: 6 })) : null;
    const toneF = Field.lowRes(size, 64, (u, v) => n.fbm(u, v, { freq: 2, octaves: 2, kind: 'simplex', layer: 8 }));
    const salts = Field.lowRes(size, 96, (u, v) => clamp01(n.fbm(u, v, { freq: 7, octaves: 3, kind: 'simplex', layer: 9 }) * 1.2 - 0.55));

    color.fill((u, v, x, y, out) => {
      // Float finish: the trowelled skin, gently undulating.
      let h = 0.5 + 0.14 * undulation.get(x, y);

      // Aggregate showing through where the skin has worn off.
      const agg = n.worley(u, v, aggFreq, { jitter: 1, aspect: 0.9, layer: 2 });
      const stoneR = 0.22 + 0.2 * agg.id;
      const stone = smoothstep(stoneR, stoneR * 0.45, agg.f1) * exposureF.get(x, y) * o.aggregate;
      h += stone * 0.09;
      const stoneId = agg.id;

      // Air pockets: round, sharp-edged, and always a surprise.
      const pw = n.worley(u, v, Math.round(aggFreq * 0.8), { jitter: 1, layer: 4 });
      const pit = smoothstep(0.36, 0.16, pw.f1) * smoothstep(0.72, 0.9, pw.id) * o.pits;
      h -= pit * 0.3;

      // Cracks: a ridged network, thresholded so only the deepest lines survive.
      const crack = crackF.get(x, y) * o.cracks;
      h -= crack * 0.5;
      cracked.set(x, y, crack);

      if (formWob) {
        // Shuttering leaves a slight ridge and a colour change every board.
        const d = stripeDistance(v + 0.02 * formWob.get(x, y), 0.25);
        h += 0.05 * Math.exp(-((d / 0.006) ** 2)) - 0.03 * Math.exp(-((d / 0.02) ** 2));
      }

      // Sand and cement grain, right at the texel floor.
      h += 0.03 * n.fbm(u, v, { freq: Math.round(size / 3), octaves: 2, kind: 'value', layer: 7 });
      height.set(x, y, h);

      const tone = 0.9 + 0.24 * clamp01(h) + 0.05 * toneF.get(x, y);
      out[0] *= tone;
      out[1] *= tone;
      out[2] *= tone;
      for (let c = 0; c < 3; c++) {
        // Aggregate is a mix of stone types — half warm flint, half cool granite.
        const sc = stoneId > 0.5 ? stoneWarm[c] : stoneCool[c];
        out[c] = mix(out[c], sc, stone * 0.75);
        out[c] = mix(out[c], dark[c], clamp01(pit * 0.9 + crack * 0.8));
        // Efflorescence: salts left behind where water evaporated.
        out[c] = mix(out[c], pale[c], salts.get(x, y) * 0.5);
      }

      rough.set(x, y, clamp01(0.78 + stone * 0.1 - clamp01(h - 0.5) * 0.25 + pit * 0.15));
    });

    const dirt = weatherMask(size, n, height, { cavity: 0.7, streaks: o.streaks, blotch: 0.5, layer: 210 });
    color.overlay(o.grimeColor, dirt, o.wear * 0.65);
    for (let i = 0; i < rough.data.length; i++) rough.data[i] = clamp01(rough.data[i] + dirt.data[i] * o.wear * 0.12);
    if (o.neutral) color.desaturateToward(0.66, 1);

    return {
      map: albedoTexture(color, 'concrete-albedo'),
      normalMap: normalTexture(height, { strength: 1.25, name: 'concrete-normal' }),
      roughnessMap: scalarTexture(rough, 0.35, 1, 'concrete-rough'),
      aux: {
        grimeMask: scalarTexture(dirt, 0, 1, 'concrete-grime'),
        crackMask: scalarTexture(cracked, 0, 1, 'concrete-cracks'),
      },
      size,
      tileMetres: o.tileMetres,
      seam: height.seamError(),
    };
  });
}

// ---------------------------------------------------------------------------

export interface WornWoodOptions extends StageBase {
  color?: THREE.ColorRepresentation;
  /** Boards across the tile. Rounded to even so the stagger wraps. */
  planks?: number;
  /** Butt joints along each board. */
  segments?: number;
  /** Grain rings per board. */
  rings?: number;
  /** Knots per board, 0..1. */
  knots?: number;
  /** Traffic polish: pale, smooth patches where feet land. */
  traffic?: number;
  /** Boards run across the tile (`u`) or down it (`v`). */
  direction?: 'u' | 'v';
}

/**
 * Worn planking: dojo floor, boardwalk, ring apron, crate sides.
 *
 * The grain is a warped ring pattern per board, with the rings *bunching around
 * knots* — that bunching is the thing that separates wood from stripes. Each
 * board gets its own dye lot, ring phase and slight cupping, because a floor
 * where every board matches reads as wallpaper.
 */
export function wornWood(opts: WornWoodOptions = {}): TexSet {
  const o = {
    color: hexOf(opts.color ?? 0x9a7145),
    seed: opts.seed ?? 503,
    resolution: opts.resolution ?? 512,
    tileMetres: opts.tileMetres ?? 2.4,
    neutral: opts.neutral ?? false,
    wear: opts.wear ?? 0.55,
    grimeColor: hexOf(opts.grimeColor ?? 0x3b2c1c),
    planks: Math.max(2, Math.round((opts.planks ?? 6) / 2) * 2),
    segments: Math.max(1, Math.round(opts.segments ?? 2)),
    rings: Math.max(2, Math.round(opts.rings ?? 9)),
    knots: opts.knots ?? 0.5,
    traffic: opts.traffic ?? 0.5,
    direction: opts.direction ?? 'u',
  };

  return cached('wornWood', o, () => {
    const size = texSize(o.resolution);
    const n = noise(o.seed);
    const height = new Field(size);
    const rough = new Field(size);
    const color = new ColorField(size, o.color);
    const darkGrain = shiftedSrgb(o.color, -0.12, 0.05, -0.012);
    const bleached = shiftedSrgb(o.color, 0.13, -0.1, 0.008);
    const gapC = shiftedSrgb(o.color, -0.24, 0.02, -0.02);

    const swirlF = Field.lowRes(size, 128, (u, v) => n.fbm(u, v, { freq: 4, octaves: 3, kind: 'simplex', layer: 11 }));
    const trafficF = Field.lowRes(size, 64, (u, v) => clamp01(0.5 + 0.6 * n.fbm(u, v, { freq: 3, octaves: 3, kind: 'simplex', layer: 15 })));

    color.fill((u, v, x, y, out) => {
      // Board frame: `a` runs along the board, `b` across it.
      const a = o.direction === 'u' ? u : v;
      const b = o.direction === 'u' ? v : u;

      const pb = b * o.planks;
      const ri = wrapIndex(Math.floor(pb), o.planks);
      const fb = pb - Math.floor(pb);
      // Stagger the butt joints by half a board on alternate rows; with an even
      // board count the alternation itself wraps.
      const pa = a * o.segments + (ri & 1) * 0.5;
      const si = wrapIndex(Math.floor(pa), o.segments);
      const fa = pa - Math.floor(pa);
      const board = ri * 7 + si;

      // Gaps: the long joint between boards is deeper than the butt joint.
      const edgeB = Math.min(fb, 1 - fb);
      const edgeA = Math.min(fa, 1 - fa);
      const gap = smoothstep(0.030, 0.006, edgeB) + 0.7 * smoothstep(0.012, 0.003, edgeA);

      // Rings: warped across the board, bunched around knots.
      const knotW = n.worley(a * 2, b * 2, Math.max(2, Math.round(o.segments * 2)), { jitter: 1, layer: 10 + (board & 15) });
      const hasKnot = smoothstep(1 - o.knots * 0.6, 1, knotW.id);
      const knot = hasKnot * Math.exp(-((knotW.f1 / 0.22) ** 2) * 2.2);
      const swirl = 0.35 * swirlF.get(x, y);
      const ringCoord = (fb + swirl * 0.25 + knot * 0.55 + n.rand(ri, si, 13)) * o.rings;
      const ringPhase = ringCoord - Math.floor(ringCoord);
      // Early wood is wide and pale, late wood a narrow dark line: the ring is
      // asymmetric, and making it a symmetric sine is why procedural wood so
      // often looks like a barcode.
      const ring = Math.pow(smoothstep(0.0, 0.22, ringPhase) * (1 - smoothstep(0.62, 0.95, ringPhase)), 0.7);
      const grain = 1 - ring;

      // Fibre along the board, plus cupping across it.
      const fibre = 0.5 + 0.5 * n.value(a * 3, b * 12, Math.max(16, Math.round(size / 8)), 14);
      const cup = -0.06 * Math.cos(Math.PI * 2 * fb);

      const worn = clamp01((trafficF.get(x, y) - 0.45) * 2) * o.traffic;

      let h = 0.5 - grain * 0.16 - knot * 0.12 + cup + fibre * 0.05;
      // Traffic sands the raised grain back down.
      h += worn * grain * 0.10;
      h -= gap * 0.55;
      h += 0.02 * n.fbm(u, v, { freq: Math.round(size / 4), octaves: 2, kind: 'value', layer: 16 });
      height.set(x, y, h);

      const lot = (n.rand(ri, si, 17) - 0.5) * 0.16;
      const tone = 0.92 + lot + 0.18 * clamp01(h);
      out[0] *= tone;
      out[1] *= tone;
      out[2] *= tone;
      for (let c = 0; c < 3; c++) {
        out[c] = mix(out[c], darkGrain[c], grain * 0.55 + knot * 0.5);
        out[c] = mix(out[c], bleached[c], worn * 0.45);
        out[c] = mix(out[c], gapC[c], clamp01(gap));
      }

      rough.set(x, y, clamp01(0.82 + grain * 0.1 - worn * 0.35 + gap * 0.1));
    });

    const dirt = weatherMask(size, n, height, { cavity: 0.85, streaks: 0.2, blotch: 0.45, layer: 220 });
    color.overlay(o.grimeColor, dirt, o.wear * 0.5);
    if (o.neutral) color.desaturateToward(0.66, 1);

    return {
      map: albedoTexture(color, 'wood-albedo'),
      normalMap: normalTexture(height, { strength: 1.2, name: 'wood-normal' }),
      roughnessMap: scalarTexture(rough, 0.28, 1, 'wood-rough'),
      aux: { grimeMask: scalarTexture(dirt, 0, 1, 'wood-grime') },
      size,
      tileMetres: o.tileMetres,
      seam: height.seamError(),
    };
  });
}

// ---------------------------------------------------------------------------

export interface PaintedMetalOptions extends StageBase {
  /** Paint colour. */
  color?: THREE.ColorRepresentation;
  /** Metal beneath — galvanised steel by default. */
  metalColor?: THREE.ColorRepresentation;
  rustColor?: THREE.ColorRepresentation;
  /** Paint loss, 0..1. */
  chipping?: number;
  /** Rust bleeding out of the chips, 0..1. */
  rust?: number;
  /** Panel lines / rivet rows. */
  rivets?: boolean;
  /** Brushed direction of the underlying metal. */
  brush?: 'u' | 'v';
}

/**
 * Painted sheet metal: shutters, railings, containers, signage.
 *
 * Paint fails at the *edges of things* and where something rubs it — so the
 * chips here are seeded from a scratch network and a cell diagram rather than
 * scattered at random, and every chip bleeds rust downward from its lower lip.
 * The paint film also has thickness: there is a real step in the normal map at
 * a chip's edge, which is what makes it read as a layer coming off rather than
 * as a brown stain.
 */
export function paintedMetal(opts: PaintedMetalOptions = {}): TexSet {
  const o = {
    color: hexOf(opts.color ?? 0x2f6b74),
    seed: opts.seed ?? 601,
    resolution: opts.resolution ?? 512,
    tileMetres: opts.tileMetres ?? 1.2,
    neutral: opts.neutral ?? false,
    wear: opts.wear ?? 0.55,
    grimeColor: hexOf(opts.grimeColor ?? 0x2b2622),
    metalColor: hexOf(opts.metalColor ?? 0x8d8f91),
    rustColor: hexOf(opts.rustColor ?? 0x7a4522),
    chipping: opts.chipping ?? 0.5,
    rust: opts.rust ?? 0.6,
    rivets: opts.rivets ?? true,
    brush: opts.brush ?? 'u',
  };

  return cached('paintedMetal', o, () => {
    const size = texSize(o.resolution);
    const n = noise(o.seed);
    const height = new Field(size);
    const rough = new Field(size);
    const chipField = new Field(size);
    const color = new ColorField(size, o.color);
    const metal = srgb(o.metalColor);
    const rustC = srgb(o.rustColor);
    const rustDark = shiftedSrgb(o.rustColor, -0.12, 0.06, -0.01);
    const paintPale = shiftedSrgb(o.color, 0.09, -0.14, 0);
    const paintDeep = shiftedSrgb(o.color, -0.09, 0.05, -0.01);

    // Brushed grain in the steel, under everything else.
    const brushed = Field.from(size, (u, v) => n.value(u, v, Math.max(32, Math.round(size / 2)), 21));
    brushed.blurAxis(Math.max(3, size / 40), o.brush, 2).normalize(-1, 1);

    // Chips: cells of failed paint, biased to a scratch network so they line up
    // along the direction things drag across the panel.
    const scratches = Field.from(size, (u, v) => {
      const s = n.fbm(u, v, { freq: 30, octaves: 2, ridged: true, kind: 'perlin', layer: 22 });
      return clamp01(s * 1.2 - 0.72) * 4;
    });
    scratches.blurAxis(Math.max(2, size / 90), o.brush, 1);

    const rustF = Field.lowRes(size, 96, (u, v) => clamp01(0.5 + 0.6 * n.fbm(u, v, { freq: 8, octaves: 3, kind: 'simplex', layer: 24 })));
    const dents = Field.lowRes(size, 64, (u, v) => n.fbm(u, v, { freq: 3, octaves: 2, kind: 'simplex', layer: 26 }));
    const bleachF = Field.lowRes(size, 64, (u, v) => clamp01(0.5 + 0.5 * n.fbm(u, v, { freq: 4, octaves: 2, kind: 'simplex', layer: 27 })));

    color.fill((u, v, x, y, out) => {
      const br = brushed.get(x, y);
      const scratch = clamp01(scratches.get(x, y));

      const cw = n.worley(u, v, Math.max(6, Math.round(size / 26)), { jitter: 1, aspect: 0.85, layer: 23 });
      const patchGate = smoothstep(0.62, 0.88, cw.id);
      const patch = patchGate * smoothstep(0.42, 0.18, cw.f1);
      const chip = clamp01((patch + scratch * 0.8) * o.chipping * 1.4);
      chipField.set(x, y, chip);

      // The paint film is thin but real: a step down into the bare metal.
      let h = 0.5 + br * 0.05;
      h += (1 - chip) * 0.06;
      // Rust lifts and flakes, so it stands slightly proud of the steel.
      const rustField = rustF.get(x, y);
      const bleed = clamp01(chip * 1.2 + Math.max(0, rustField - 0.62) * 1.5 * o.rust);
      const rust = clamp01(bleed * o.rust) * (0.5 + 0.5 * rustField);
      h += rust * 0.03 * n.value(u, v, Math.round(size / 6), 25);

      if (o.rivets) {
        // Rivet rows along the panel edges — the detail that gives sheet metal
        // its scale. Distances are measured in rivet-pitch units so the head
        // stays round whatever the tile resolution is.
        const rv = stripeDistance(v, 0.5);
        const rd = Math.hypot(stripeDistance(u, 1 / 16) * 16, rv * 4);
        h += smoothstep(0.5, 0.1, rd) * 0.16;
      }
      // Panel dents.
      h += 0.05 * dents.get(x, y);
      height.set(x, y, h);

      const shade = 0.94 + br * 0.06;
      out[0] *= shade;
      out[1] *= shade;
      out[2] *= shade;
      for (let c = 0; c < 3; c++) {
        // Sun-bleached film on top, deeper colour where it is protected.
        out[c] = mix(out[c], paintPale[c], bleachF.get(x, y) * 0.35 * o.wear);
        out[c] = mix(out[c], paintDeep[c], clamp01(1 - h) * 0.25);
        out[c] = mix(out[c], metal[c], clamp01(chip * 1.3) * (1 - rust * 0.8));
        out[c] = mix(out[c], rustC[c], rust * 0.85);
        out[c] = mix(out[c], rustDark[c], clamp01(rust - 0.6) * 0.8);
      }

      rough.set(x, y, clamp01(0.34 + chip * 0.18 + rust * 0.5 - Math.abs(br) * 0.06));
    });

    const dirt = weatherMask(size, n, height, { cavity: 0.5, streaks: 0.9, blotch: 0.4, layer: 230 });
    color.overlay(o.grimeColor, dirt, o.wear * 0.45);
    for (let i = 0; i < rough.data.length; i++) rough.data[i] = clamp01(rough.data[i] + dirt.data[i] * o.wear * 0.25);
    if (o.neutral) color.desaturateToward(0.6, 1);

    return {
      map: albedoTexture(color, 'metal-albedo'),
      normalMap: normalTexture(height, { strength: 1.05, name: 'metal-normal' }),
      roughnessMap: scalarTexture(rough, 0.12, 1, 'metal-rough'),
      aux: {
        chipMask: scalarTexture(chipField, 0, 1, 'metal-chips'),
        grimeMask: scalarTexture(dirt, 0, 1, 'metal-grime'),
      },
      size,
      tileMetres: o.tileMetres,
      seam: height.seamError(),
    };
  });
}

// ---------------------------------------------------------------------------

export interface BrickOptions extends StageBase {
  color?: THREE.ColorRepresentation;
  mortarColor?: THREE.ColorRepresentation;
  /** Courses down the tile. Rounded to even so the running bond wraps. */
  courses?: number;
  /** Bricks across the tile. */
  perCourse?: number;
  /** Tone spread between bricks, 0..1. A wall of identical bricks reads as tile. */
  variation?: number;
  /** Chipped corners and spalled faces, 0..1. */
  damage?: number;
}

/** Brickwork in running bond: alley walls, arena backdrops. */
export function brick(opts: BrickOptions = {}): TexSet {
  const o = {
    color: hexOf(opts.color ?? 0x8c4a35),
    seed: opts.seed ?? 701,
    resolution: opts.resolution ?? 512,
    tileMetres: opts.tileMetres ?? 1.8,
    neutral: opts.neutral ?? false,
    wear: opts.wear ?? 0.5,
    grimeColor: hexOf(opts.grimeColor ?? 0x35302a),
    mortarColor: hexOf(opts.mortarColor ?? 0x9e9a90),
    courses: Math.max(2, Math.round((opts.courses ?? 10) / 2) * 2),
    perCourse: Math.max(1, Math.round(opts.perCourse ?? 4)),
    variation: opts.variation ?? 0.6,
    damage: opts.damage ?? 0.45,
  };

  return cached('brick', o, () => {
    const size = texSize(o.resolution);
    const n = noise(o.seed);
    const height = new Field(size);
    const rough = new Field(size);
    const color = new ColorField(size, o.color);
    const mortar = srgb(o.mortarColor);
    const mortarDark = shiftedSrgb(o.mortarColor, -0.12, 0.01, -0.01);
    const brickDark = shiftedSrgb(o.color, -0.12, 0.05, -0.012);
    const brickPale = shiftedSrgb(o.color, 0.12, -0.12, 0.01);
    const core = shiftedSrgb(o.color, 0.06, -0.05, 0.006);

    // Mortar joints as a fraction of a brick, so they stay constant in world
    // units when the course count changes.
    const jv = 0.11;
    const ju = 0.045;

    const spallF = Field.lowRes(size, size >> 1, (u, v) => clamp01(n.fbm(u, v, { freq: 22, octaves: 3, kind: 'simplex', layer: 33 }) * 1.3 - 0.35));

    color.fill((u, v, x, y, out) => {
      const pv = v * o.courses;
      const ci = wrapIndex(Math.floor(pv), o.courses);
      const fv = pv - Math.floor(pv);
      const pu = u * o.perCourse + (ci & 1) * 0.5;
      const bi = wrapIndex(Math.floor(pu), o.perCourse);
      const fu = pu - Math.floor(pu);
      const id = n.rand(bi, ci, 31);
      const id2 = n.rand(bi, ci, 37);

      // Hand-laid bricks are not aligned to the millimetre.
      const jitterU = (id - 0.5) * 0.01;
      const jitterV = (id2 - 0.5) * 0.008;
      const dv = Math.min(fv + jitterV, 1 - fv - jitterV);
      const du = Math.min(fu + jitterU, 1 - fu - jitterU);
      const face = smoothstep(jv * 0.55, jv, dv) * smoothstep(ju * 0.55, ju, du);

      // Brick face: slightly domed, sanded, with the odd spalled corner.
      const dome = Math.sin(Math.PI * clamp01(fv)) * Math.sin(Math.PI * clamp01(fu));
      const grit = n.fbm(u, v, { freq: Math.round(size / 5), octaves: 2, kind: 'value', layer: 32 });
      const spall = smoothstep(0.62, 0.95, n.rand(bi, ci, 41)) * spallF.get(x, y) * (1 - dome * 0.6) * o.damage;

      const mortarSurface = 0.30 + 0.10 * n.fbm(u, v, { freq: Math.round(size / 6), octaves: 3, kind: 'value', layer: 34 });
      let h = mix(mortarSurface, 0.78 + dome * 0.06 + grit * 0.05, face);
      h -= spall * 0.22;
      height.set(x, y, h);

      // Every brick out of a different part of the kiln.
      const lot = (id - 0.5) * o.variation * 0.34;
      const tone = 1 + lot + (grit * 0.06) + (id2 - 0.5) * 0.08;
      out[0] *= tone;
      out[1] *= tone;
      out[2] *= tone;
      for (let c = 0; c < 3; c++) {
        // Flashed bricks come out of the kiln darker or paler than the batch.
        out[c] = mix(out[c], brickDark[c], smoothstep(0.75, 1, id2) * 0.7);
        out[c] = mix(out[c], brickPale[c], smoothstep(0.25, 0, id2) * 0.5);
        // Spalling exposes the unweathered core.
        out[c] = mix(out[c], core[c], spall * 0.8);
        out[c] = mix(out[c], mortar[c], 1 - face);
        out[c] = mix(out[c], mortarDark[c], (1 - face) * clamp01(0.6 - h) * 0.7);
      }

      rough.set(x, y, clamp01(0.86 - face * 0.08 + spall * 0.1));
    });

    const dirt = weatherMask(size, n, height, { cavity: 0.75, streaks: 0.85, blotch: 0.5, layer: 240 });
    color.overlay(o.grimeColor, dirt, o.wear * 0.6);
    if (o.neutral) color.desaturateToward(0.62, 1);

    return {
      map: albedoTexture(color, 'brick-albedo'),
      normalMap: normalTexture(height, { strength: 1.5, name: 'brick-normal' }),
      roughnessMap: scalarTexture(rough, 0.5, 1, 'brick-rough'),
      aux: { grimeMask: scalarTexture(dirt, 0, 1, 'brick-grime') },
      size,
      tileMetres: o.tileMetres,
      seam: height.seamError(),
    };
  });
}

// ---------------------------------------------------------------------------

export interface ClothBannerOptions extends StageBase {
  color?: THREE.ColorRepresentation;
  /** Stripe colour, if the banner carries one. */
  stripeColor?: THREE.ColorRepresentation;
  /** Stripes across the tile. 0 for plain cloth. */
  stripes?: number;
  /** Threads across the tile. */
  threads?: number;
  /** Hanging folds, 0..1. */
  drape?: number;
  /** Sun bleaching, 0..1. */
  fade?: number;
}

/**
 * Banner and awning cloth: hanging flags, ring skirts, tarpaulins.
 *
 * Heavier and coarser than anything the fighters wear, and read at distance, so
 * the weave is deliberately over-scaled — a true thread count would vanish by
 * the second mip. The drape folds are baked in because a banner in the
 * background is a flat quad most of the time, and the folds are doing the job
 * the geometry is not.
 */
export function clothBanner(opts: ClothBannerOptions = {}): TexSet {
  const o = {
    color: hexOf(opts.color ?? 0xa8332c),
    seed: opts.seed ?? 809,
    resolution: opts.resolution ?? 512,
    tileMetres: opts.tileMetres ?? 1,
    neutral: opts.neutral ?? false,
    wear: opts.wear ?? 0.45,
    grimeColor: hexOf(opts.grimeColor ?? 0x4a3a28),
    stripeColor: hexOf(opts.stripeColor ?? 0xe8d9b8),
    stripes: Math.max(0, Math.round(opts.stripes ?? 0)),
    threads: Math.max(8, Math.round(opts.threads ?? 40)),
    drape: opts.drape ?? 0.6,
    fade: opts.fade ?? 0.5,
  };

  return cached('clothBanner', o, () => {
    const size = texSize(o.resolution);
    const n = noise(o.seed);
    const height = new Field(size);
    const rough = new Field(size);
    const color = new ColorField(size, o.color);
    const stripeC = srgb(o.stripeColor);
    const faded = shiftedSrgb(o.color, 0.12, -0.28, 0.004);
    const weave = { threads: o.threads, kind: 'basket' as const, packing: 1.08, drift: 0.6 };

    const wobF = Field.lowRes(size, 64, (u, v) => n.fbm(u, v, { freq: 2, octaves: 2, kind: 'simplex', layer: 51 }));
    const foldNoise = Field.lowRes(size, 96, (u, v) => n.fbm(u, v, { freq: 4, octaves: 3, kind: 'simplex', layer: 52 }));
    // Slack and sun exposure vary across the cloth, but they cannot be a
    // gradient in V: a gradient does not wrap, and this texture has to.
    const slackF = Field.lowRes(size, 48, (u, v) => clamp01(0.45 + 0.6 * n.fbm(u, v, { freq: 2, octaves: 2, kind: 'simplex', layer: 53 })));

    color.fill((u, v, x, y, out) => {
      const w = weaveAt(n, u, v, weave);

      // Folds: a few soft vertical waves, wandering, deeper where the cloth
      // hangs slack.
      const wob = 0.06 * wobF.get(x, y);
      const fold = Math.sin(Math.PI * 2 * (u * 3 + wob)) * 0.5 + 0.5;
      const slack = slackF.get(x, y);
      const drape = o.drape * (fold * 0.6 + 0.4 * foldNoise.get(x, y)) * slack;

      const h = w.height * 0.35 + drape * 0.5;
      height.set(x, y, h);

      let stripe = 0;
      if (o.stripes > 0) {
        const d = stripeDistance(v + wob * 0.3, 1 / o.stripes);
        stripe = smootherstep(0.5 / o.stripes * 0.5, 0.5 / o.stripes * 0.34, d);
      }

      // Sun hits the high side of every fold hardest, so the bleaching follows
      // the drape rather than covering the cloth evenly.
      const sun = clamp01(drape * 0.9 + slack * 0.35) * o.fade;
      const shade = 0.84 + 0.3 * w.height + drape * 0.16;
      out[0] *= shade;
      out[1] *= shade;
      out[2] *= shade;
      for (let c = 0; c < 3; c++) {
        out[c] = mix(out[c], stripeC[c], stripe);
        out[c] = mix(out[c], faded[c], sun * 0.55);
      }

      rough.set(x, y, clamp01(0.86 - w.height * 0.12 + sun * 0.06));
    });

    const dirt = weatherMask(size, n, height, { cavity: 0.5, streaks: 0.7, blotch: 0.6, layer: 250 });
    color.overlay(o.grimeColor, dirt, o.wear * 0.4);
    if (o.neutral) color.desaturateToward(0.66, 1);

    return {
      map: albedoTexture(color, 'banner-albedo'),
      normalMap: normalTexture(height, { strength: 0.85, name: 'banner-normal' }),
      roughnessMap: scalarTexture(rough, 0.5, 1, 'banner-rough'),
      aux: { grimeMask: scalarTexture(dirt, 0, 1, 'banner-grime') },
      size,
      tileMetres: o.tileMetres,
      seam: height.seamError(),
    };
  });
}

// ---------------------------------------------------------------------------

export interface AsphaltOptions extends StageBase {
  color?: THREE.ColorRepresentation;
  /** Stone size, cells across the tile. */
  aggregate?: number;
  /** Crack network, 0..1. */
  cracks?: number;
  /** Polished bands where traffic has burnished the surface, 0..1. */
  polish?: number;
  /** Repair patches of newer, darker tarmac, 0..1. */
  patches?: number;
}

/** Asphalt and tarmac: rooftop stages, street fights, car parks. */
export function asphalt(opts: AsphaltOptions = {}): TexSet {
  const o = {
    color: hexOf(opts.color ?? 0x3a3a3c),
    seed: opts.seed ?? 907,
    resolution: opts.resolution ?? 512,
    tileMetres: opts.tileMetres ?? 2.5,
    neutral: opts.neutral ?? false,
    wear: opts.wear ?? 0.6,
    grimeColor: hexOf(opts.grimeColor ?? 0x2a2724),
    aggregate: Math.max(8, Math.round(opts.aggregate ?? 46)),
    cracks: opts.cracks ?? 0.5,
    polish: opts.polish ?? 0.5,
    patches: opts.patches ?? 0.4,
  };

  return cached('asphalt', o, () => {
    const size = texSize(o.resolution);
    const n = noise(o.seed);
    const height = new Field(size);
    const rough = new Field(size);
    const color = new ColorField(size, o.color);
    const stonePale = shiftedSrgb(o.color, 0.22, -0.04, 0.01);
    const stoneWarm = shiftedSrgb(o.color, 0.12, 0.06, -0.04);
    const binder = shiftedSrgb(o.color, -0.09, 0.01, 0);
    const patchC = shiftedSrgb(o.color, -0.06, 0.02, 0.01);
    const dust = shiftedSrgb(o.color, 0.14, -0.02, 0.02);

    const exposureF = Field.lowRes(size, 64, (u, v) => clamp01(0.5 + 0.6 * n.fbm(u, v, { freq: 5, octaves: 3, kind: 'simplex', layer: 62 })));
    const crackF = Field.lowRes(size, size >> 1, (u, v) => clamp01(n.fbm(u, v, { freq: 12, octaves: 3, ridged: true, layer: 65 }) * 1.1 - 0.6) * 2.5);
    const patchF = Field.lowRes(size, 48, (u, v) => smoothstep(0.55, 0.62, clamp01(0.5 + 0.6 * n.fbm(u, v, { freq: 2, octaves: 3, kind: 'simplex', layer: 66 }))));
    const polishF = Field.lowRes(size, 48, (u, v) => clamp01(0.5 + 0.6 * n.fbm(u, v, { freq: 3, octaves: 2, kind: 'simplex', layer: 67 })));
    const slumpF = Field.lowRes(size, 96, (u, v) => n.fbm(u, v, { freq: 4, octaves: 3, kind: 'simplex', layer: 68 }));

    color.fill((u, v, x, y, out) => {
      // Stones set in binder: the ones near the surface show, the rest are
      // buried, so exposure is gated by a second, larger-scale field.
      const st = n.worley(u, v, o.aggregate, { jitter: 1, aspect: 0.92, layer: 61 });
      const r = 0.24 + 0.2 * st.id;
      const stoneId = st.id;
      const stone = smoothstep(r, r * 0.4, st.f1) * smoothstep(0.35, 0.7, exposureF.get(x, y));

      const grit = n.fbm(u, v, { freq: Math.round(size / 3), octaves: 2, kind: 'value', layer: 63 });

      // Cracks follow a cell network — tarmac fails along polygon boundaries,
      // not along fractal lines.
      const cellEdge = n.worleyEdge(u, v, 7, { jitter: 0.9, layer: 64 });
      const crack = clamp01((smoothstep(0.86, 0.99, cellEdge) + crackF.get(x, y) * 0.5) * o.cracks);

      const patchMask = patchF.get(x, y) * o.patches;
      const polish = polishF.get(x, y) * o.polish;

      let h = 0.5 + stone * 0.16 + grit * 0.06;
      h -= crack * 0.5;
      h -= polish * stone * 0.08;
      h += 0.05 * slumpF.get(x, y);
      height.set(x, y, h);

      const tone = 0.92 + 0.2 * clamp01(h) + grit * 0.05;
      out[0] *= tone;
      out[1] *= tone;
      out[2] *= tone;
      for (let c = 0; c < 3; c++) {
        out[c] = mix(out[c], stoneId > 0.55 ? stonePale[c] : stoneWarm[c], stone * 0.8);
        out[c] = mix(out[c], binder[c], clamp01(crack * 1.2));
        out[c] = mix(out[c], patchC[c], patchMask * 0.7);
        // Tyres polish the surface and grind pale dust into everything else.
        out[c] = mix(out[c], dust[c], clamp01(polish - 0.45) * 0.5 * (1 - stone));
      }

      rough.set(x, y, clamp01(0.9 - polish * 0.4 + crack * 0.08 - stone * 0.05));
    });

    const dirt = weatherMask(size, n, height, { cavity: 0.8, streaks: 0.25, blotch: 0.55, layer: 260 });
    color.overlay(o.grimeColor, dirt, o.wear * 0.4);
    if (o.neutral) color.desaturateToward(0.6, 1);

    return {
      map: albedoTexture(color, 'asphalt-albedo'),
      normalMap: normalTexture(height, { strength: 1.3, name: 'asphalt-normal' }),
      roughnessMap: scalarTexture(rough, 0.4, 1, 'asphalt-rough'),
      aux: { grimeMask: scalarTexture(dirt, 0, 1, 'asphalt-grime') },
      size,
      tileMetres: o.tileMetres,
      seam: height.seamError(),
    };
  });
}
