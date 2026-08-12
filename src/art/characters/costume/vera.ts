import * as THREE from 'three';
import type { BoneName } from '../../../anim/contract';
import type { FighterDef } from '../../../data/roster';
import type { BuiltCharacter } from '../rig';
import { fighterTextures } from '../../textures';
import {
  attachGarment,
  axisFromPoints,
  buildBand,
  buildShell,
  byAngle,
  chainAxis,
  edgeAtHeight,
  emptyCostume,
  landmarkY,
  LAYER,
  mergeGeometry,
  ramp,
  surfaceCurve,
  torsoAxis,
  type BuiltCostume,
  type GarmentBody,
} from './garment';

/**
 * Vera — "The Iron Clinch", catch wrestling.
 *
 * From `reference/vera/*.jpg`: a burnt-orange quilted puffer vest, sleeveless,
 * cropped under the ribs and worn open over a plum crop top, with a tall stand
 * collar; charcoal compression shorts cut high on the waist and ending
 * mid-thigh; black knee caps; white hand wraps; maroon-and-grey laced wrestling
 * boots.
 *
 * She is the heaviest build on the roster (0.82) and the vest is the costume's
 * one job: it has to make her read *broader* than the body underneath, which is
 * why almost none of its thickness is authored as a constant. The loft is a
 * profile that swells through the ribcage and is squeezed to a seam at the
 * shoulder and the neckline, exactly the way batting behaves between two
 * stitched edges.
 *
 * Layer ladder used here, innermost first:
 *   LAYER.skin  0.0035  hand wraps
 *   0.0040              crop top, which has to fit inside the vest's lining
 *   0.0055              knee caps (neoprene, pulled onto the skin)
 *   LAYER.base  0.0090  compression shorts
 *   0.0180-0.0320       vest body — a profile, not a layer; see `vestLoft`
 *   0.0320-0.0500       stand collar, which must clear the vest's own neckline
 *
 * One number that is not what it looks like: the `cloth` given to every fitted
 * piece here is far thicker than the fabric it stands for. See `WALL`.
 */

/**
 * Minimum wall thickness for a garment pulled tight onto the body, in metres.
 *
 * Not a statement about the fabric — compression jersey is under a millimetre.
 * It is the depth budget the ink pass needs. The hull is the shell redrawn
 * back-faced, so its fragments carry the depth of the piece's *lining*; where a
 * surface runs near-tangent to the view — the crown of a glute, the top of a
 * thigh, the swell of a ribcage — a few pixels of screen-space expansion move
 * that lining far enough along the depth slope to beat the outer face, and the
 * hull floods a hand-sized region of the garment solid black. Measured on Vera's
 * shorts at a 3.8 mm wall: two blots per cheek. At 14 mm: one small one. At 20:
 * none. The lining is never seen, so burying it inside the body costs nothing.
 */
const WALL = 0.020;

const DEG = Math.PI / 180;

/** See `kai.ts`: the fabric tiles are authored coarse and want tightening. */
const WEAVE = 0.55;

/**
 * How much of the quilt texture's authored tile the vest actually spans.
 *
 * `quiltedFabric` is asked for six cells over half a metre, which is an 8 cm
 * channel — a duvet, not a gilet. Tiling at 0.58 puts the channel near 4.8 cm,
 * which is what the design sheets draw.
 */
const QUILT_TILE = 0.58;

/** Channels per quilt tile. Must match the `cells` the texture suite asks for. */
const QUILT_CELLS = 6;

/**
 * Geometric loft between two quilt seams, in metres.
 *
 * Deliberately small next to the 18-32 mm the whole vest stands off the body:
 * the *thickness* is the offset profile's job, and this is only the corrugation
 * on top of it. A cel ramp breaks on the slope of a ripple rather than on its
 * depth, and at a 5 cm channel pitch anything past ~2 mm swings the terminator
 * far enough to drop a whole band as a hard-edged blot.
 */
const QUILT_LOFT = 0.0010;

/** The trunk. Anything a torso garment should lie on, and nothing it should engulf. */
const TORSO = (b: BoneName): boolean =>
  b === 'hips' || b === 'spine' || b === 'chest' || b === 'neck' || b === 'shoulderL' || b === 'shoulderR';

const armOf = (side: 'L' | 'R') => (b: BoneName): boolean =>
  b === `upperArm${side}` || b === `forearm${side}` || b === `hand${side}`;

const legOf = (side: 'L' | 'R') => (b: BoneName): boolean =>
  b === `thigh${side}` || b === `shin${side}` || b === `foot${side}` || b === `toe${side}`;

const footOf = (side: 'L' | 'R') => (b: BoneName): boolean => b === `foot${side}` || b === `toe${side}`;

const shinOf = (side: 'L' | 'R') => (b: BoneName): boolean =>
  b === `shin${side}` || b === `foot${side}` || b === `toe${side}`;

/**
 * Triangle wave on [-1, 1] with unit period, used for lacing.
 *
 * Two copies of opposite sign cross each other twice per period, which is a
 * cross-lace; a sine would give two curves that kiss instead of crossing.
 */
function zigzag(x: number): number {
  const f = x - Math.floor(x);
  return 1 - 4 * Math.abs(f - 0.5);
}

export function buildVeraCostume(rig: BuiltCharacter, def: FighterDef): BuiltCostume {
  const body: GarmentBody = rig;
  const m = rig.metrics;
  const tex = fighterTextures(def);
  const p = def.palette;
  const out = emptyCostume();

  const Y = (l: Parameters<typeof landmarkY>[1]) => landmarkY(m, l);
  const hipY = Y('hip');
  const waistY = Y('waist');
  const lowRibY = Y('lowRib');
  const chestY = Y('chest');
  const armpitY = Y('armpit');
  const shoulderY = Y('shoulder');
  const neckY = m.neckBaseY;
  const kneeY = Y('knee');
  const midThighY = Y('midThigh');

  // The crest of the deltoid mass. Every sleeveless top on this fighter has to
  // carry its top edge just past it: stop short and the shell terminates on the
  // side of the shoulder, which reads as off-the-shoulder rather than as an
  // armhole seam.
  const deltoidCrest = shoulderY + m.height * 0.002 + m.deltoidR;

  /**
   * How far the vest may be lifted off the ribs to ride over the arm.
   *
   * Zero for most of the deltoid's height — there the cloth belongs on the
   * ribcage, and the hanging arm is fused to it in the implicit field — opening
   * only in the last few centimetres below the crest, so the shoulder finishes
   * as a narrow cap. Opened as early as the armpit instead, the same bridge
   * wraps thirteen centimetres of deltoid and the vest grows a puffed sleeve.
   */
  const shoulderBridge = (y: number): number =>
    0.15 * THREE.MathUtils.smoothstep(y, deltoidCrest - 0.105, deltoidCrest - 0.004);

  // ---------------------------------------------------------------- crop top --
  // A plum bra-cut top: scooped at the sternum, up over the shoulder as a strap,
  // dropping away under the arm, and squared off across the back. Almost all of
  // it lives under the vest — what has to survive is the wedge visible through
  // the open front, the strap on the shoulder, and the band below the vest's
  // back hem.
  const topAxis = torsoAxis(body, lowRibY - 0.10, neckY + 0.06);
  const topHemY = lowRibY;
  const topShell = buildShell(body, {
    axis: topAxis,
    from: (_u, a) =>
      topAxis.sAtY(
        byAngle([
          [0, topHemY],
          [90, topHemY + 0.004],
          [180, topHemY + 0.012],
          [-90, topHemY + 0.004],
        ])(a),
      ),
    to: edgeAtHeight(topAxis, [
      [0, chestY + 0.068],
      [22, chestY + 0.104],
      [38, chestY + 0.140],
      [55, chestY + 0.158],
      [72, chestY + 0.120],
      [88, chestY + 0.052],
      [105, chestY + 0.026],
      [140, chestY + 0.016],
      [180, chestY + 0.020],
      [-140, chestY + 0.016],
      [-105, chestY + 0.026],
      [-88, chestY + 0.052],
      [-72, chestY + 0.120],
      [-55, chestY + 0.158],
      [-38, chestY + 0.140],
      [-22, chestY + 0.092],
    ]),
    // Well under `LAYER.base`: the crop top's outer face has to clear the vest's
    // lining by more than a `LAYER_GAP` at the one place the vest is thinnest,
    // which is the neckline seam.
    offset: 0.004,
    cloth: WALL * 0.7,
    segments: 18,
    radial: 54,
    lining: 3,
    follow: TORSO,
    // The *same* bridge the vest uses, and it has to be. Two shells at offsets
    // a < b are guaranteed to nest only while they are lifted off the same
    // surface; give the inner one an earlier bridge and it climbs onto the
    // deltoid while the outer one is still on the ribs, and the crop top's strap
    // erupts through the vest's shoulder as a plum wedge.
    bridge: (s) => shoulderBridge(topAxis.pointAt(s).y),
    fromEdge: { fold: 0.010, roll: 0.0038, rings: 3 },
    toEdge: { fold: 0.009, roll: 0.0036, rings: 3 },
    drape: { folds: 5, amplitude: 0.0012, along: 1.6, seed: 17 },
    tileMetres: tex.garments.top.tileMetres,
  });
  attachGarment(rig, {
    name: 'cropTop',
    geometry: topShell.geometry,
    kind: 'cloth',
    color: p.secondary,
    shadowColor: 0x2a1826,
    tex: tex.garments.top,
    normalScale: 0.9,
    specular: 0.2,
  }, out);

  // -------------------------------------------------------------------- vest --
  const vestAxis = torsoAxis(body, waistY - 0.03, neckY + 0.13);
  const vestHemY = lowRibY - 0.023;

  /**
   * Loft, in metres off the skin, as a function of height.
   *
   * This is the whole silhouette. Batting is squeezed to nothing wherever it is
   * sewn down — the knit hem, the armhole, the neckline — and is at full
   * thickness in the middle of a panel, so the vest is fattest across the
   * ribcage and tapers to a seam at both ends. The minimum is chosen so that the
   * vest's lining still clears the crop top's outer face by more than a
   * `LAYER_GAP`, everywhere.
   */
  const vestLoft = ramp([
    [vestHemY, 0.020],
    [lowRibY + 0.020, 0.030],
    [chestY, 0.032],
    [armpitY, 0.031],
    [shoulderY - 0.020, 0.025],
    [shoulderY + 0.030, 0.020],
    [neckY + 0.030, 0.018],
    [neckY + 0.080, 0.018],
  ]);

  /**
   * Loft, narrowed toward the flanks.
   *
   * The arm hangs against the side seam of a vest, and at full loft the padding
   * would be modelled several centimetres inside the biceps. A real gilet is
   * also its thinnest there, so this costs nothing and buys the arm its space
   * back — the broadening the vest is for happens across the chest and over the
   * shoulder, which is where the eye reads width anyway.
   */
  const vestSide = byAngle([
    [0, 1],
    [45, 1],
    [90, 0.80],
    [135, 0.96],
    [180, 1],
    [-135, 0.96],
    [-90, 0.80],
    [-45, 1],
  ]);

  /**
   * Corrugation between quilt seams, phase-locked to the texture.
   *
   * The shell's V coordinate is metres along the axis over the tile size, and
   * `quiltedFabric`'s channel pattern puts a seam wherever that lands on a
   * multiple of `1/cells`. Deriving the geometry from the same expression is the
   * only way the modelled crown and the painted stitch line agree; a puff at any
   * other pitch beats against the map and reads as two overlaid quilts.
   */
  const quiltTile = tex.garments.vest.tileMetres * QUILT_TILE;
  const quiltPuff = (s: number): number => {
    const cell = ((s * vestAxis.length) / quiltTile) * QUILT_CELLS;
    const d = Math.abs(cell - Math.round(cell));
    return QUILT_LOFT * THREE.MathUtils.smoothstep(d, 0, 0.5);
  };

  const vestOffset = (s: number, _u: number, angle: number): number =>
    vestLoft(vestAxis.pointAt(s).y) * vestSide(angle) + quiltPuff(s);

  // Worn open. The gap is authored as an angular span rather than as a cut, so
  // both front edges are real finished ends with the padding's full thickness
  // showing — which is what a puffer's open front actually looks like.
  const VEST_GAP = 22 * DEG;

  const vestHem = byAngle([
    [0, vestHemY],
    [45, vestHemY + 0.010],
    [75, vestHemY + 0.032],
    [105, vestHemY + 0.050],
    [140, vestHemY + 0.078],
    [180, vestHemY + 0.086],
    [-140, vestHemY + 0.078],
    [-105, vestHemY + 0.050],
    [-75, vestHemY + 0.032],
    [-45, vestHemY + 0.010],
  ]);
  // The armhole is this transition, not a notch: over the deltoid — which
  // subtends roughly 55 to 125 degrees from the spine — the edge is carried past
  // the crest so the rings wrap the shoulder, and everywhere else it stops at
  // the neckline seam.
  //
  // Where it stops matters more than it looks. Carried on up past the base of
  // the neck at the front and back too, the shell's last rings sweep inward from
  // the shoulder to the throat and the vest grows a horizontal flange all the
  // way round the neck, which then hides the entire collar. Kept level with the
  // top of the ribcage instead, the same rings finish as a neckline seam — which
  // is the only thing a stand collar can rise out of.
  const vestTopStops: [number, number][] = [
    [22, neckY + 0.004],
    [40, neckY + 0.018],
    [55, neckY + 0.036],
    [70, deltoidCrest - 0.020],
    [88, deltoidCrest + 0.012],
    [106, deltoidCrest + 0.008],
    [122, deltoidCrest - 0.026],
    [140, neckY + 0.030],
    [160, neckY + 0.014],
    [180, neckY + 0.008],
  ];
  const vestTop = edgeAtHeight(
    vestAxis,
    vestTopStops.flatMap(([a, y]) => (a === 180 ? [[a, y]] : [[a, y], [-a, y]]) as [number, number][]),
  );

  const vest = buildShell(body, {
    axis: vestAxis,
    from: (_u, a) => vestAxis.sAtY(vestHem(a)),
    to: vestTop,
    offset: vestOffset,
    // A padded shell is genuinely thick at its edges, and this is also what
    // gives the open front its fat rolled border instead of a paper edge. Held
    // below `WALL` because the vest's lining has the crop top underneath it and
    // cannot be buried in the body the way a fitted piece's can.
    cloth: 0.011,
    segments: 36,
    radial: 66,
    lining: 4,
    arc: [VEST_GAP, Math.PI * 2 - VEST_GAP],
    closed: false,
    follow: TORSO,
    bridge: (s) => shoulderBridge(vestAxis.pointAt(s).y),
    fromEdge: { fold: 0.014, roll: 0.006, rings: 4 },
    toEdge: { fold: 0.011, roll: 0.005, rings: 4 },
    // No drape. Quilting is what a puffer does instead of folding, and a fold
    // field on top of the corrugation would just beat against it.
    tileMetres: quiltTile,
  });
  attachGarment(rig, {
    name: 'vest',
    geometry: vest.geometry,
    kind: 'quilted',
    color: p.primary,
    shadowColor: 0x6b2a0e,
    tex: tex.garments.vest,
    // Held well under 1. `quiltedFabric` authors its normal at strength 1.5 for
    // a flat swatch; laid over a shell that is already corrugated at the same
    // pitch, anything near full strength turns the channels into a row of
    // inflated sausages and the vest reads as a life jacket.
    normalScale: 0.65,
    specular: 0.22,
  }, out);

  // Knit hem band. Swept along the shell's own finished boundary and pulled
  // slightly inward, because the whole point of a rib hem is that it is the one
  // place the padding is cinched tighter than the body under it.
  const hemBand = buildBand(vest.from, {
    width: 0.036,
    thickness: 0.009,
    lift: -0.010,
    sides: 10,
    tileMetres: tex.garments.collar.tileMetres,
  });
  attachGarment(rig, {
    name: 'vestHem',
    geometry: hemBand,
    kind: 'cloth',
    color: 0x92390f,
    shadowColor: 0x4c1d08,
    tex: tex.garments.collar,
    normalScale: 1.1,
    specular: 0.16,
  }, out);

  // Zip plackets, one per front edge. Traced along the same offset surface the
  // vest was built from plus a hair, so they ride the padding's crown rather
  // than sinking into a quilt channel.
  const placketParts: THREE.BufferGeometry[] = [];
  for (const sgn of [1, -1] as const) {
    const angle = VEST_GAP * sgn;
    const s0 = vestAxis.sAtY(vestHem(angle));
    const s1 = vestAxis.sAtY(vestTopStops[0][1] + 0.004);
    placketParts.push(
      buildBand(
        surfaceCurve(body, {
          axis: vestAxis,
          samples: 30,
          s: (t) => THREE.MathUtils.lerp(s0, s1, t),
          angle: () => angle,
          offset: (s, u, a) => vestOffset(s, u, a) + 0.004,
          follow: TORSO,
        }),
        { width: 0.012, thickness: 0.006, sides: 8, tileMetres: tex.garments.top.tileMetres },
      ),
    );
  }
  attachGarment(rig, {
    name: 'vestPlacket',
    geometry: mergeGeometry(placketParts),
    kind: 'leather',
    color: 0x7a3413,
    shadowColor: 0x3c1a09,
    specular: 0.5,
    outlineWidth: 0.7,
  }, out);

  // Stand collar, on its own axis.
  //
  // Traced against the whole body and then *capped*, rather than followed onto
  // the neck bone. Following the neck alone is the obvious move and it silently
  // produces nothing — the trace comes back at zero and the collar collapses
  // onto the axis inside the throat — while an uncapped trace hands back the
  // trapezius radius and the collar comes out as a funnel wider than the head.
  // The cap says the same thing the subset was meant to say: a stand collar's
  // radius is set by the neck it is buttoned around, whatever else is nearby.
  const collarAxis = torsoAxis(body, neckY - 0.05, neckY + 0.14);
  const collarBaseY = neckY - 0.012;
  const collarNeck = ramp([
    [collarBaseY, m.neckR + 0.012],
    [collarBaseY + 0.100, m.neckR + 0.002],
  ]);
  const collarLift = ramp([
    [collarBaseY, 0.032],
    [collarBaseY + 0.050, 0.042],
    [collarBaseY + 0.100, 0.050],
  ]);
  const collar = buildShell(body, {
    axis: collarAxis,
    from: (_u, a) =>
      collarAxis.sAtY(byAngle([[0, collarBaseY], [90, collarBaseY - 0.003], [180, collarBaseY - 0.006], [-90, collarBaseY - 0.003]])(a)),
    to: (_u, a) =>
      collarAxis.sAtY(
        byAngle([
          [0, collarBaseY + 0.092],
          [60, collarBaseY + 0.100],
          [90, collarBaseY + 0.106],
          [140, collarBaseY + 0.112],
          [180, collarBaseY + 0.114],
          [-140, collarBaseY + 0.112],
          [-90, collarBaseY + 0.106],
          [-60, collarBaseY + 0.100],
        ])(a),
      ),
    offset: (s) => collarLift(collarAxis.pointAt(s).y),
    cloth: 0.010,
    segments: 14,
    radial: 44,
    lining: 3,
    arc: [26 * DEG, Math.PI * 2 - 26 * DEG],
    closed: false,
    maxRadius: (s) => collarNeck(collarAxis.pointAt(s).y),
    toEdge: { fold: 0.014, roll: 0.0065, rings: 4 },
    tileMetres: quiltTile,
  });
  attachGarment(rig, {
    name: 'vestCollar',
    geometry: collar.geometry,
    kind: 'quilted',
    color: p.primary,
    shadowColor: 0x6b2a0e,
    tex: tex.garments.vest,
    normalScale: 0.8,
    specular: 0.24,
  }, out);

  // ------------------------------------------------------- compression shorts --
  // Fitted, not draped: the offset barely leaves the skin and the fold field is
  // an order of magnitude smaller than a cotton garment's. What sells technical
  // fabric instead is panelling, which arrives below as seams.
  const shortHemY = midThighY + 0.008;
  const shortWaistY = waistY + 0.018;
  const shortOffset = ramp([
    [shortHemY - 0.02, 0.0065],
    [hipY - 0.09, 0.0075],
    [hipY, 0.0090],
    [Y('navel'), 0.0085],
    [shortWaistY, 0.0080],
  ]);

  for (const side of ['L', 'R'] as const) {
    const hip = rig.joints[`thigh${side}` as BoneName];
    // Started well above the hip joint so the high waist is real geometry and
    // not a band floating over bare skin.
    const axis = axisFromPoints([
      new THREE.Vector3(hip.x * 0.32, shortWaistY + 0.012, hip.z),
      new THREE.Vector3(hip.x * 0.72, hipY + 0.06, hip.z),
      hip.clone(),
      rig.joints[`shin${side}` as BoneName].clone(),
    ]);
    const sign = side === 'L' ? 1 : -1;
    const inner = sign > 0 ? Math.PI / 2 : -Math.PI / 2;
    const bias = side === 'L' ? 0 : 0.0006;
    const shell = buildShell(body, {
      axis,
      // Cut at the waistband rather than at the top of the axis: the axis is
      // started higher only so the sweep has room, and a raw ring left up there
      // is a hole in the small of the back.
      from: axis.sAtY(shortWaistY),
      to: axis.sAtY(shortHemY),
      offset: (s, _u, angle) => {
        // Pressed flat between the thighs, as any close-fitting short is.
        const inward = Math.max(0, -Math.cos(angle - inner));
        return shortOffset(axis.pointAt(s).y) * (1 - 0.35 * inward ** 1.4) + bias;
      },
      cloth: WALL,
      segments: 26,
      radial: 40,
      lining: 3,
      fromEdge: { fold: 0.009, roll: 0.0032, rings: 3 },
      toEdge: { fold: 0.010, roll: 0.0035, rings: 3 },
      drape: { folds: 5, amplitude: 0.0009, along: 2.4, seed: 23 + (side === 'R' ? 6 : 0) },
      keepSide: { normal: new THREE.Vector3(sign, 0, 0), d: -0.004, softness: 0.008 },
      tileMetres: tex.garments.shorts.tileMetres,
    });
    attachGarment(rig, {
      name: `short${side}`,
      geometry: shell.geometry,
      kind: 'cloth',
      // Lifted off the authored charcoal so the shorts stay a value apart from
      // the knee caps: under a three-band ramp the two collapse into one mass
      // and the leg loses its silhouette break.
      color: 0x3a3e46,
      shadowColor: 0x21242a,
      tex: tex.garments.shorts,
      normalScale: 0.55,
      specular: 0.06,
    }, out);
  }

  // Panel seams and the waistband. One mesh: they are the same welt in the same
  // thread, and the whole point of them is to be cheap.
  const shortTrim: THREE.BufferGeometry[] = [];
  const waistAxis = torsoAxis(body, hipY, shortWaistY + 0.10);
  shortTrim.push(
    buildBand(
      surfaceCurve(body, {
        axis: waistAxis,
        samples: 46,
        s: () => waistAxis.sAtY(shortWaistY - 0.013),
        angle: (t) => t * Math.PI * 2,
        offset: LAYER.base + 0.0022,
        follow: TORSO,
      }),
      { width: 0.026, thickness: 0.009, lift: -0.004, closed: true, sides: 8, tileMetres: tex.garments.shorts.tileMetres },
    ),
  );
  for (const side of ['L', 'R'] as const) {
    const legAxis = chainAxis(body, [`thigh${side}`, `shin${side}`] as BoneName[], 0);
    const sHem = legAxis.sAtY(shortHemY);
    const sTop = legAxis.sAtY(hipY - 0.01);
    shortTrim.push(
      buildBand(
        surfaceCurve(body, {
          axis: legAxis,
          samples: 40,
          s: () => sHem,
          angle: (t) => t * Math.PI * 2,
          offset: LAYER.base + 0.0022,
          follow: legOf(side),
        }),
        { width: 0.016, thickness: 0.007, lift: -0.003, closed: true, sides: 8, tileMetres: tex.garments.shorts.tileMetres },
      ),
    );
    // Outer side seam and the front panel seam, both running the length of the
    // leg — the two lines the reference sheets draw on the shorts.
    for (const deg of [side === 'L' ? 96 : -96, side === 'L' ? 34 : -34]) {
      shortTrim.push(
        buildBand(
          surfaceCurve(body, {
            axis: legAxis,
            samples: 28,
            s: (t) => THREE.MathUtils.lerp(sTop, sHem, t),
            angle: () => deg * DEG,
            offset: LAYER.base + 0.0018,
            follow: legOf(side),
          }),
          { width: 0.0045, thickness: 0.005, lift: -0.002, sides: 6, tileMetres: tex.garments.shorts.tileMetres },
        ),
      );
    }
  }
  attachGarment(rig, {
    name: 'shortTrim',
    geometry: mergeGeometry(shortTrim),
    kind: 'cloth',
    // Barely off the shorts' own value. A panel seam that contrasts reads as
    // piping on a tracksuit; what technical fabric actually shows is the same
    // cloth folded, which is a line of shading, not a line of colour.
    color: 0x32363e,
    shadowColor: 0x1c1f24,
    tex: tex.garments.shorts,
    normalScale: 0.55,
    specular: 0.12,
    outlineWidth: 0.45,
  }, out);

  // --------------------------------------------------------------- knee caps --
  // A distinct silhouette element, so it is modelled as a cap with a padded
  // front rather than as a sleeve: the bulge is centred on the patella and dies
  // out toward both elastic bands.
  for (const side of ['L', 'R'] as const) {
    const axis = chainAxis(body, [`thigh${side}`, `shin${side}`, `foot${side}`] as BoneName[], 0);
    const sTop = axis.sAtY(kneeY + 0.078);
    const sBot = axis.sAtY(kneeY - 0.072);
    const pad = buildShell(body, {
      axis,
      from: sTop,
      to: sBot,
      offset: (s, _u, angle) => {
        const t = THREE.MathUtils.clamp((s - sTop) / (sBot - sTop), 0, 1);
        const front = Math.max(0, Math.cos(angle));
        return 0.0055 + 0.006 * Math.sin(Math.PI * t) * front ** 1.6;
      },
      cloth: WALL * 0.8,
      segments: 16,
      radial: 30,
      lining: 3,
      follow: legOf(side),
      fromEdge: { fold: 0.010, roll: 0.004, rings: 3 },
      toEdge: { fold: 0.010, roll: 0.004, rings: 3 },
      drape: { folds: 4, amplitude: 0.0008, along: 1.4, seed: 51 },
      tileMetres: tex.garments.shorts.tileMetres,
    });
    // Elastic bands top and bottom. They are what stops the cap reading as paint
    // on the leg: the pad has to be gripped somewhere.
    const cuff = (s: number, width: number) =>
      buildBand(
        surfaceCurve(body, {
          axis,
          samples: 28,
          s: () => s,
          angle: (t) => t * Math.PI * 2,
          offset: 0.0062,
          follow: legOf(side),
        }),
        { width, thickness: 0.007, lift: -0.003, closed: true, sides: 8, tileMetres: tex.garments.collar.tileMetres },
      );
    attachGarment(rig, {
      name: `kneePad${side}`,
      geometry: mergeGeometry([pad.geometry, cuff(sTop + 0.008, 0.017), cuff(sBot - 0.008, 0.014)]),
      kind: 'cloth',
      color: 0x22242a,
      shadowColor: 0x121317,
      tex: tex.garments.shorts,
      normalScale: 0.8,
      specular: 0.18,
      outlineWidth: 1.1,
    }, out);
  }

  // -------------------------------------------------------------- hand wraps --
  // Longer up the forearm than a karateka's — a catch wrestler tapes for grip
  // fighting, not for punching, and the sheets carry the wrap a third of the way
  // to the elbow.
  for (const side of ['L', 'R'] as const) {
    const axis = chainAxis(body, [`forearm${side}`, `hand${side}`] as BoneName[], 0.72);
    const shell = buildShell(body, {
      axis,
      from: 0.4,
      to: 0.95,
      offset: ramp([[0, LAYER.skin], [0.45, LAYER.skin + 0.0016], [1, LAYER.skin]]),
      cloth: WALL * 0.6,
      segments: 15,
      radial: 28,
      lining: 3,
      follow: armOf(side),
      fromEdge: { fold: 0.010, roll: 0.0038, rings: 3 },
      toEdge: { fold: 0.009, roll: 0.0038, rings: 3 },
      drape: { folds: 4, amplitude: 0.0009, along: 3.5, seed: 41 },
      tileMetres: tex.wrap.tileMetres * WEAVE,
    });
    const turn = (s: number, wobble: number, width: number): THREE.BufferGeometry =>
      buildBand(
        surfaceCurve(body, {
          axis,
          samples: 32,
          s: (t) => s + Math.sin(t * Math.PI * 2) * wobble,
          angle: (t) => t * Math.PI * 2,
          offset: LAYER.skin + 0.0032,
          follow: armOf(side),
        }),
        { width, thickness: 0.006, lift: -0.0022, closed: true, sides: 8, tileMetres: tex.wrap.tileMetres * WEAVE },
      );
    attachGarment(rig, {
      name: `handWrap${side}`,
      geometry: mergeGeometry([
        shell.geometry,
        // Two turns at the wrist and one across the knuckles: without them a
        // wrap is a white sock.
        turn(0.60, 0.012, 0.020),
        turn(0.66, 0.010, 0.017),
        turn(0.90, 0.008, 0.016),
      ]),
      kind: 'wrap',
      color: p.wrap,
      tex: tex.wrap,
      normalScale: 1.2,
    }, out);
  }

  buildBoots(rig, def, out);

  return out;
}

/**
 * Mid-shaft laced wrestling boots.
 *
 * The only fighter on the roster in real footwear, so the boots carry a lot of
 * her silhouette and are built in four parts rather than as one shape: the
 * maroon upper and shaft, a grey saddle and toe bumper, a sole clipped flat onto
 * the stage, and the lacing. The shaft crosses the ankle, so unlike Kai's
 * trainers it cannot be rigid-bound to the foot — it takes the body's own
 * weighting and flexes where the joint does.
 */
function buildBoots(rig: BuiltCharacter, def: FighterDef, out: BuiltCostume): void {
  const body: GarmentBody = rig;
  const m = rig.metrics;
  const p = def.palette;
  const tex = fighterTextures(def);
  const UP = new THREE.Vector3(0, 1, 0);
  const LEFT = new THREE.Vector3(1, 0, 0);
  const hide = (tex.boots?.tileMetres ?? 0.2) * 0.75;

  for (const side of ['L', 'R'] as const) {
    const ankle = rig.joints[`foot${side}` as BoneName];
    const toe = rig.joints[`toe${side}` as BoneName];
    const FL = m.footLen;
    // Threads the middle of the foot along the stations the foot volume was
    // swept from in `body.ts`, and then runs on past the heel and the toe at
    // both ends. That overhang is what lets the shells close: a sweep that stops
    // inside the foot can only ever end in a ring the foot pokes out of.
    const footAxis = axisFromPoints([
      new THREE.Vector3(ankle.x, 0.030, ankle.z - FL * 0.32),
      new THREE.Vector3(ankle.x, 0.038, ankle.z - FL * 0.16),
      new THREE.Vector3(ankle.x, 0.044, ankle.z - FL * 0.02),
      new THREE.Vector3((ankle.x + toe.x) * 0.5, 0.039, ankle.z + FL * 0.16),
      new THREE.Vector3(toe.x, 0.027, toe.z + FL * 0.02),
      new THREE.Vector3(toe.x, 0.014, toe.z + FL * 0.24),
      new THREE.Vector3(toe.x, 0.010, toe.z + FL * 0.42),
    ]);
    const shinAxis = chainAxis(body, [`shin${side}`, `foot${side}`] as BoneName[], 0);
    const shaftTopY = m.ankleY + 0.152;

    /**
     * Radius ceiling that pinches every foot shell shut at both ends.
     *
     * A full-wrap shell is an annulus, not a bag: its two boundaries are rolled
     * openings, and on a horizontal foot axis those openings face backward out
     * of the heel and forward out of the toe. Left at their traced radius they
     * are holes you can see the foot through — which is how a wrestling boot
     * ends up rendering as an open-toed sandal. Squeezing the ceiling to a few
     * millimetres over the first and last tenth of the axis draws both openings
     * back onto the axis, where they sit inside the foot and close the form.
     */
    const bootCap = (s: number): number =>
      0.004 + 0.36 * Math.min(1, (Math.min(s, 1 - s) / 0.14) ** 2);

    // Upper. Angle 0 is up (the instep) because the axis runs horizontally, so
    // the anatomical-front hint would be degenerate.
    const upper = buildShell(body, {
      axis: footAxis,
      from: 0.02,
      to: 0.98,
      offset: ramp([[0, 0.0095], [0.35, 0.0085], [0.85, 0.008], [1, 0.0075]]),
      maxRadius: bootCap,
      cloth: WALL * 0.75,
      segments: 20,
      radial: 32,
      lining: 3,
      front: UP,
      left: LEFT,
      // Without this the upward ray from the heel never leaves the body: the
      // ankle runs straight into the shin, and the boot grows up the leg.
      follow: footOf(side),
      keepSide: { normal: UP, d: 0.0215, softness: 0.004 },
      fromEdge: { fold: 0.008, roll: 0.004, rings: 3 },
      toEdge: { fold: 0.008, roll: 0.004, rings: 3 },
      drape: { folds: 5, amplitude: 0.0013, along: 2, seed: 61 },
      tileMetres: hide,
    });
    // Shaft, on the shin. A boxing-cut boot's collar rises well past the ankle
    // bone and no ray from a horizontal foot axis reaches it.
    const shaft = buildShell(body, {
      axis: shinAxis,
      from: shinAxis.sAtY(shaftTopY),
      to: shinAxis.sAtY(0.035),
      offset: ramp([[0.035, 0.010], [m.ankleY + 0.05, 0.0125], [shaftTopY, 0.0145]]),
      cloth: WALL * 0.8,
      segments: 16,
      radial: 32,
      lining: 3,
      follow: shinOf(side),
      fromEdge: { fold: 0.012, roll: 0.0055, rings: 4 },
      drape: { folds: 5, amplitude: 0.0011, along: 1.6, seed: 67 },
      tileMetres: hide,
    });
    attachGarment(rig, {
      name: `boot${side}`,
      geometry: mergeGeometry([upper.geometry, shaft.geometry]),
      kind: 'leather',
      color: p.boots,
      shadowColor: 0x35101a,
      tex: tex.boots,
      normalScale: 0.85,
      specular: 0.42,
    }, out);

    // Grey saddle over the heel and midfoot, and a bumper over the toe box.
    // Both sit one layer proud of the upper, which is exactly how an overlay is
    // stitched onto a boot.
    const panel = (from: number, to: number) =>
      buildShell(body, {
        axis: footAxis,
        from,
        to,
        offset: 0.0168,
        cloth: 0.0055,
        maxRadius: (s) => bootCap(s) + 0.004,
        segments: 12,
        radial: 30,
        lining: 3,
        front: UP,
        left: LEFT,
        follow: footOf(side),
        keepSide: { normal: UP, d: 0.0215, softness: 0.004 },
        fromEdge: { fold: 0.008, roll: 0.004, rings: 3 },
        toEdge: { fold: 0.008, roll: 0.004, rings: 3 },
        tileMetres: hide,
      }).geometry;
    attachGarment(rig, {
      name: `bootPanel${side}`,
      geometry: mergeGeometry([panel(0.14, 0.36), panel(0.72, 0.965)]),
      kind: 'leather',
      color: 0x4a4d56,
      shadowColor: 0x24262c,
      tex: tex.boots,
      normalScale: 0.85,
      specular: 0.38,
      bind: `foot${side}` as BoneName,
    }, out);

    // Sole: the lower arc of the same foot, pressed flat onto the ground plane.
    // The foot is the one place the body's surface *is* the floor, so anything
    // with an offset here sinks through the stage unless it is clipped.
    const sole = buildShell(body, {
      axis: footAxis,
      from: 0.02,
      to: 0.975,
      offset: 0.0175,
      maxRadius: (s) => bootCap(s) + 0.008,
      cloth: 0.009,
      segments: 20,
      radial: 26,
      lining: 3,
      arc: [96 * DEG, 264 * DEG],
      closed: false,
      front: UP,
      left: LEFT,
      follow: footOf(side),
      keepSide: { normal: UP, d: 0.0018, softness: 0.003 },
      fromEdge: { fold: 0.009, roll: 0.005, rings: 3 },
      toEdge: { fold: 0.009, roll: 0.005, rings: 3 },
      tileMetres: 0.2,
    });
    attachGarment(rig, {
      name: `bootSole${side}`,
      geometry: sole.geometry,
      kind: 'leather',
      color: 0x23252b,
      shadowColor: 0x101115,
      specular: 0.3,
      outlineWidth: 1.0,
      bind: `foot${side}` as BoneName,
    }, out);

    // Lacing: two triangle waves of opposite sign, which cross rather than
    // merely touch. One pair over the instep, one up the shaft.
    const laces: THREE.BufferGeometry[] = [];
    for (const hand of [1, -1]) {
      laces.push(
        buildBand(
          surfaceCurve(body, {
            axis: footAxis,
            samples: 44,
            s: (t) => THREE.MathUtils.lerp(0.40, 0.60, t),
            angle: (t) => hand * 0.52 * zigzag(t * 2.5 + 0.25),
            offset: 0.0162,
            front: UP,
            left: LEFT,
            follow: footOf(side),
          }),
          { width: 0.0052, thickness: 0.006, lift: -0.0024, sides: 6, tileMetres: 0.12 },
        ),
      );
      laces.push(
        buildBand(
          surfaceCurve(body, {
            axis: shinAxis,
            samples: 52,
            s: (t) => THREE.MathUtils.lerp(shinAxis.sAtY(shaftTopY - 0.012), shinAxis.sAtY(m.ankleY - 0.006), t),
            angle: (t) => hand * 0.5 * zigzag(t * 3 + 0.25),
            offset: 0.0225,
            follow: shinOf(side),
          }),
          { width: 0.0052, thickness: 0.006, lift: -0.0024, sides: 6, tileMetres: 0.12 },
        ),
      );
    }
    attachGarment(rig, {
      name: `bootLace${side}`,
      geometry: mergeGeometry(laces),
      kind: 'wrap',
      color: 0xd6cfbe,
      shadowColor: 0x7d7566,
      tex: tex.wrap,
      normalScale: 0.9,
      outlineWidth: 0.7,
    }, out);
  }
}
