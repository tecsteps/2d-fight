import * as THREE from 'three';
import type { BoneName } from '../../../anim/contract';
import type { FighterDef } from '../../../data/roster';
import type { BuiltCharacter } from '../rig';
import { fighterTextures } from '../../textures';
import {
  attachGarment,
  axisFromPoints,
  bakeStrand,
  buildBand,
  buildShell,
  byAngle,
  mergeGeometry,
  chainAxis,
  CLOTH,
  edgeAtHeight,
  emptyCostume,
  landmarkY,
  LAYER,
  over,
  ramp,
  sliceBoundary,
  surfaceCurve,
  torsoAxis,
  type Boundary,
  type BuiltCostume,
  type GarmentBody,
} from './garment';

/**
 * Kai — "Sudden Stillness", full-contact karate.
 *
 * From `reference/kai/*.jpg`: navy sleeveless cross-front wrap gi with an orange
 * collar band, a wide orange obi wrapped twice and knotted at the front with two
 * hanging ends, loose charcoal calf-length pants gathered into a cuff, white
 * hand wraps, criss-crossed orange ankle wraps, navy shoes on white soles.
 *
 * Read this file as the worked example of `garment.ts`: every piece is one
 * offset-surface shell or one swept band, every edge is a boundary profile in
 * anatomical terms, and the whole outfit stacks up the `LAYER` ladder so nothing
 * can z-fight against anything else.
 *
 * Layer ladder used here, innermost first:
 *   LAYER.skin  0.0035  hand wraps, ankle wraps
 *   LAYER.base  0.0090  pants (grows to 0.042 at the knee for the balloon)
 *   LAYER.mid   0.0155  gi body
 *   +0.0045             gi over-lapel (the panel that crosses on top)
 *   LAYER.belt  0.0285  obi, lower wrap
 *   over(belt)          obi, upper wrap and the knot
 */

const DEG = Math.PI / 180;

/**
 * Weave tiling multiplier.
 *
 * `fighterTextures` authors its tiles generously — 56 threads over 25 cm is a
 * 4.5 mm thread, which at fighting-game distance reads as a chevron blanket
 * rather than as gi twill. Tiling at just over half that puts the thread near
 * 2 mm, which is what the cloth actually is.
 */
const WEAVE = 0.55;

/** Angles used often enough to be worth naming. 0 is the front, +90 the left. */
const FRONT = 0;

/** The trunk. Anything a torso garment should lie on, and nothing it should engulf. */
const TORSO = (b: BoneName): boolean =>
  b === 'hips' || b === 'spine' || b === 'chest' || b === 'neck' || b === 'shoulderL' || b === 'shoulderR';

const armOf = (side: 'L' | 'R') => (b: BoneName): boolean =>
  b === `upperArm${side}` || b === `forearm${side}` || b === `hand${side}`;

const footOf = (side: 'L' | 'R') => (b: BoneName): boolean => b === `foot${side}` || b === `toe${side}`;

const shinOf = (side: 'L' | 'R') => (b: BoneName): boolean =>
  b === `shin${side}` || b === `foot${side}` || b === `toe${side}`;

/**
 * What the gi lies on: the trunk *and* the thighs.
 *
 * The thighs matter at the hem. A skirt that follows the pelvis alone ends up
 * buried inside the thigh where the two masses cross at the hip, and the leg
 * pokes straight through it.
 */
const GI_FOLLOW = (b: BoneName): boolean => TORSO(b) || b === 'thighL' || b === 'thighR';

export function buildKaiCostume(rig: BuiltCharacter, def: FighterDef): BuiltCostume {
  const body: GarmentBody = rig;
  const m = rig.metrics;
  const tex = fighterTextures(def);
  const p = def.palette;
  const out = emptyCostume();

  const Y = (l: Parameters<typeof landmarkY>[1]) => landmarkY(m, l);
  const armpit = Y('armpit');

  // ------------------------------------------------------------------ pants --
  // Two shells, one per leg, from the hip joint to the upper calf. The offset
  // profile is the whole character of the garment: nearly on the skin at the
  // hip so the gi can sit over it, ballooning through the thigh and past the
  // knee, then cinched hard into the cuff. That balloon-then-cinch is what
  // breaks the silhouette at the knee in the reference.
  const pantHemY = Y('knee') - (Y('knee') - Y('ankle')) * 0.21;
  const pantWaistY = Y('hip') + m.torsoLen * 0.2;
  // Authored against world height, not the axis parameter, so the balloon lands
  // on the knee rather than wherever a proportion change moved that parameter to.
  const pantOffset = ramp([
    [pantWaistY, 0.006],
    [Y('hip') - 0.02, 0.010],
    [Y('midThigh'), 0.014],
    [Y('knee') + 0.055, 0.022],
    [Y('knee'), 0.029],
    [Y('knee') - 0.045, 0.033],
    [pantHemY + 0.030, 0.019],
    [pantHemY, 0.013],
  ]);

  for (const side of ['L', 'R'] as const) {
    const hip = rig.joints[`thigh${side}` as BoneName];
    // The axis starts *above* the hip joint so the trousers cover the pelvis and
    // their raw top edge can hide under the gi skirt. Started at the joint, the
    // hem of the gi and the top of the trousers meet exactly at the one height
    // where the thigh mass crosses the pelvis, and bare skin shows between them.
    const axis = axisFromPoints([
      new THREE.Vector3(hip.x * 0.55, pantWaistY, hip.z),
      hip.clone(),
      rig.joints[`shin${side}` as BoneName].clone(),
      rig.joints[`foot${side}` as BoneName].clone(),
    ]);
    const hemS = axis.sAtY(pantHemY);
    // The two legs share the pelvis, so each is clipped at the sagittal plane —
    // which is exactly a trouser inseam. They are given a hair's difference in
    // offset because the strip where they overlap would otherwise be two
    // coincident surfaces fighting for the same depth.
    const bias = side === 'L' ? 0 : 0.0006;
    const sign = side === 'L' ? 1 : -1;
    // The angle pointing away from the other leg, in this shell's own frame.
    const inner = sign > 0 ? Math.PI / 2 : -Math.PI / 2;
    const shell = buildShell(body, {
      axis,
      from: 0.0,
      to: hemS,
      // Trousers are not a tube of even slack: they hang off the outside of the
      // leg and are pressed flat between the thighs. Without this the two legs
      // inflate into each other and the pair reads as one skirt.
      offset: (s, _u, angle) => {
        const inward = Math.max(0, -Math.cos(angle - inner));
        return pantOffset(axis.pointAt(s).y) * (1 - 0.72 * inward ** 1.3) + bias;
      },
      cloth: CLOTH * 1.15,
      segments: 24,
      radial: 38,
      lining: 3,
      // The waist end is raw on purpose: it lives under the gi skirt, and a hem
      // there would be a bead pushing through the layer above it.
      fromEdge: undefined,
      toEdge: { fold: 0.015, roll: 0.0065, rings: 4 },
      drape: { folds: 8, amplitude: 0.0080, along: 3.0, seed: 11 + (side === 'R' ? 5 : 0), sag: 0.005 },
      keepSide: { normal: new THREE.Vector3(sign, 0, 0), d: -0.004, softness: 0.008 },
      tileMetres: tex.garments.pants.tileMetres * WEAVE,
    });
    attachGarment(rig, {
      name: `pant${side}`,
      geometry: shell.geometry,
      kind: 'cloth',
      // The authored charcoal is the ink value from the design sheet. Under a
      // four-band ramp it lands within a hair of the navy gi and the two garments
      // merge into one dark mass, so both ends of the ramp are lifted here.
      color: 0x3e414a,
      shadowColor: 0x252831,
      tex: tex.garments.pants,
      normalScale: 0.8,
      specular: 0.12,
    }, out);
  }

  // --------------------------------------------------------------------- gi --
  // Trunk axis runs from under the hem to over the shoulders so both boundary
  // curves land inside the axis' range with room for their folds.
  const giAxis = torsoAxis(body, Y('crotch') - 0.045, m.neckBaseY + 0.07);
  const giHemY = Y('hip') - 0.05;
  const neck = m.neckBaseY;
  const obiTop = Y('hip') + m.torsoLen * 0.38;

  // The armhole rule, as one number. Zero below the armpit, so the gi lies on
  // the ribs rather than following the fused arm outward; opening above it, so
  // the shoulder rides over the deltoid and reads as a cap sleeve. The armhole
  // is *this* transition, not a notch cut in the top edge — the top edge stays
  // up on the shoulder all the way round, exactly as in the reference.
  const giSlack = ramp([
    [giHemY, LAYER.mid + 0.011],
    [Y('hip') + 0.05, LAYER.mid + 0.007],
    [Y('waist'), LAYER.mid + 0.001],
    [Y('chest'), LAYER.mid],
  ]);

  const giBridge = (s: number): number => {
    const y = giAxis.pointAt(s).y;
    return 0.15 * THREE.MathUtils.smoothstep(y, armpit + 0.062, armpit + 0.158);
  };

  // Two panels cross at the front. This is the *over* panel, which carries the
  // whole garment: anchored on the character's right shoulder, its free edge
  // falls diagonally across the chest and vanishes into the obi on the left.
  // Behind and on the right it is the back of the gi, so the edge is up on the
  // shoulder there. The near-vertical step at +100 deg is where the panel ends
  // and the under panel takes over — it sits in the left armpit, behind the arm.
  const giTop = edgeAtHeight(giAxis, [
    // Over the shoulders the edge has to be carried *past* the crest of the
    // shoulder mass, not stopped at its side. A radial sweep from a vertical
    // axis is nearly tangent to the top of a shoulder, so an edge authored at
    // shoulder height lands out on the deltoid and the gi reads as off-the-
    // shoulder; five centimetres higher and the same rings wrap over the trap
    // and close on the neck, which is where a collar belongs.
    [180, neck + 0.068],
    [150, neck + 0.062],
    [124, neck + 0.055],
    [104, neck + 0.048],
    [96, neck + 0.040],
    // The step: forward of here the over panel's free edge takes over, and the
    // under panel is what covers the character's left shoulder.
    [88, obiTop + 0.028],
    [76, obiTop + 0.036],
    [58, obiTop + 0.082],
    [38, obiTop + 0.152],
    [18, obiTop + 0.236],
    [0, neck - 0.080],
    [-16, neck - 0.046],
    [-32, neck + 0.002],
    [-46, neck + 0.026],
    [-62, neck + 0.044],
    [-82, neck + 0.048],
    [-104, neck + 0.050],
    [-130, neck + 0.058],
    [-155, neck + 0.065],
  ]);
  // Side vents: the hem lifts a little at the hips, the way a gi skirt is slit.
  const giHem = byAngle([
    [0, giHemY],
    [62, giHemY],
    [86, giHemY + 0.022],
    [94, giHemY + 0.022],
    [118, giHemY],
    [180, giHemY],
    [-118, giHemY],
    [-94, giHemY + 0.022],
    [-86, giHemY + 0.022],
    [-62, giHemY],
  ]);

  const gi = buildShell(body, {
    axis: giAxis,
    from: (_u, a) => giAxis.sAtY(giHem(a)),
    to: giTop,
    // Slack grows toward the hem: a gi skirt hangs off the hip, and a constant
    // offset makes the whole top read as one clinging piece.
    offset: (sp) => giSlack(giAxis.pointAt(sp).y),
    cloth: CLOTH,
    segments: 26,
    radial: 68,
    lining: 4,
    follow: GI_FOLLOW,
    bridge: giBridge,
    fromEdge: { fold: 0.018, roll: 0.005, rings: 3 },
    toEdge: { fold: 0.013, roll: 0.0042, rings: 3 },
    drape: { folds: 7, amplitude: 0.0058, along: 2.6, seed: 3, sag: 0.004 },
    tileMetres: tex.garments.gi.tileMetres * WEAVE,
  });
  attachGarment(rig, {
    name: 'gi',
    geometry: gi.geometry,
    kind: 'cloth',
    color: p.primary,
    shadowColor: 0x141f31,
    tex: tex.garments.gi,
    normalScale: 0.9,
    specular: 0.16,
  }, out);

  // The under panel. Anchored on the character's left shoulder, its free edge
  // falls to the sternum where the over panel crosses it — from there down it is
  // hidden, so only the far side of the V is ever seen. Its bottom edge is
  // deliberately unfinished and parked well below the over panel's edge.
  const underTop = edgeAtHeight(giAxis, [
    [4, neck - 0.074],
    [20, neck - 0.044],
    [40, neck - 0.004],
    [56, neck + 0.026],
    [72, neck + 0.042],
    [92, neck + 0.044],
    [112, neck + 0.052],
    [132, neck + 0.058],
  ]);
  const under = buildShell(body, {
    axis: giAxis,
    from: giAxis.sAtY(obiTop - 0.05),
    to: underTop,
    offset: LAYER.mid - 0.0024,
    segments: 12,
    radial: 30,
    lining: 3,
    arc: [4 * DEG, 132 * DEG],
    closed: false,
    follow: GI_FOLLOW,
    bridge: giBridge,
    toEdge: { fold: 0.013, roll: 0.0042, rings: 3 },
    tileMetres: tex.garments.gi.tileMetres * WEAVE,
  });
  attachGarment(rig, {
    name: 'giUnder',
    geometry: under.geometry,
    kind: 'cloth',
    color: p.primary,
    shadowColor: 0x141f31,
    tex: tex.garments.gi,
    normalScale: 0.9,
    specular: 0.16,
  }, out);

  // Collar band. Swept along the shells' own finished boundaries, so it cannot
  // drift off the edge it is trimming — the reason `buildShell` hands its
  // boundaries back at all.
  const collarParts: THREE.BufferGeometry[] = [];
  const collar = (curve: Boundary, width: number) => {
    if (curve.points.length < 3) return;
    collarParts.push(
      buildBand(curve, {
        width,
        thickness: CLOTH * 1.1,
        lift: -CLOTH * 0.3,
        sides: 10,
        tileMetres: tex.garments.obi.tileMetres * WEAVE,
      }),
    );
  };
  collar(sliceBoundary(gi.to, -140, 86), 0.022);
  collar(sliceBoundary(gi.to, 98, 222), 0.017);
  collar(sliceBoundary(under.to, 6, 100), 0.021);
  attachGarment(rig, {
    name: 'giCollar',
    geometry: mergeGeometry(collarParts),
    kind: 'cloth',
    color: p.accent,
    shadowColor: 0x7c3210,
    tex: tex.garments.obi,
    specular: 0.35,
  }, out);

  // -------------------------------------------------------------------- obi --
  // Wrapped twice: two shells, the upper one riding a little higher on the
  // character's left so the two passes read as one length of cloth spiralling
  // round rather than as two stacked rings.
  const obiAxis = torsoAxis(body, Y('navel') - 0.11, Y('waist') + 0.10);
  const obiLowY = Y('hip') + m.torsoLen * 0.175;
  const obiMidY = Y('hip') + m.torsoLen * 0.285;
  const obiTopY = obiTop;

  // Each pass gets a bead only on the edge you can actually see. The lower
  // wrap's top edge runs underneath the upper wrap, and a hem bead there swells
  // straight into the layer above it — which is what a dark pinch at a belt
  // overlap always turns out to be.
  interface ObiWrap {
    name: string;
    from: (a: number) => number;
    to: (a: number) => number;
    offset: number;
    hemTop: boolean;
  }
  const obiWraps: ObiWrap[] = [
    {
      name: 'obiLower',
      from: byAngle([[0, obiLowY], [90, obiLowY + 0.006], [180, obiLowY + 0.012], [-90, obiLowY + 0.004]]),
      to: byAngle([[0, obiMidY + 0.006], [90, obiMidY + 0.002], [180, obiMidY - 0.004], [-90, obiMidY + 0.004]]),
      offset: LAYER.belt,
      hemTop: false,
    },
    {
      name: 'obiUpper',
      from: byAngle([[0, obiMidY - 0.004], [90, obiMidY - 0.008], [180, obiMidY - 0.014], [-90, obiMidY - 0.006]]),
      to: byAngle([[0, obiTopY], [90, obiTopY + 0.008], [180, obiTopY - 0.004], [-90, obiTopY + 0.002]]),
      offset: over(LAYER.belt),
      hemTop: true,
    },
  ];
  for (const w of obiWraps) {
    const shell = buildShell(body, {
      axis: obiAxis,
      from: (_u, a) => obiAxis.sAtY(w.from(a)),
      to: (_u, a) => obiAxis.sAtY(w.to(a)),
      offset: w.offset,
      cloth: CLOTH * 1.3,
      segments: 10,
      radial: 52,
      lining: 3,
      follow: TORSO,
      fromEdge: { fold: 0.012, roll: 0.0055, rings: 3 },
      toEdge: w.hemTop ? { fold: 0.012, roll: 0.0055, rings: 3 } : undefined,
      drape: { folds: 9, amplitude: 0.0022, along: 1.2, seed: 7 },
      tileMetres: tex.garments.obi.tileMetres * WEAVE,
    });
    attachGarment(rig, {
      name: w.name,
      geometry: shell.geometry,
      kind: 'cloth',
      color: p.accent,
      shadowColor: 0x7c3210,
      tex: tex.garments.obi,
      specular: 0.32,
      normalScale: 1.1,
    }, out);
  }

  // The knot, at the front and a little to the character's left, as drawn. Two
  // crossing loops of cloth: the flat one that lies against the obi and the
  // narrow one cinched over it. At stage distance that is what a knot is.
  const knotAngle = 16 * DEG;
  const knotY = (obiMidY + obiTopY) * 0.5 - 0.004;
  const knotS = obiAxis.sAtY(knotY);
  const knotAnchor = surfaceCurve(body, {
    axis: obiAxis,
    samples: 3,
    s: () => knotS,
    angle: () => knotAngle,
    offset: over(LAYER.belt, 2),
  });
  const knotP = knotAnchor.points[1];
  const knotN = knotAnchor.normals[1];
  const knotSide = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), knotN).normalize();

  // Knot, cinch and both loose ends are one mesh rigid-bound to the hips. They
  // have left the body surface, so the field weighting that is right for cloth
  // lying on a limb would bind the tails to the thigh they happen to hang in
  // front of and swing them with a step.
  const knotParts: THREE.BufferGeometry[] = [];

  const loop = (radiusX: number, radiusY: number, roll: number, width: number) => {
    const pts: THREE.Vector3[] = [];
    const nrm: THREE.Vector3[] = [];
    const n = 22;
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n;
      pts.push(
        knotP
          .clone()
          .addScaledVector(knotSide, Math.cos(a) * radiusX)
          .addScaledVector(new THREE.Vector3(0, 1, 0), Math.sin(a) * radiusY)
          .addScaledVector(knotN, Math.cos(a * 2) * roll),
      );
      nrm.push(knotN.clone());
    }
    knotParts.push(
      buildBand({ points: pts, normals: nrm, u: pts.map((_, i) => i / n), angle: pts.map(() => 0) }, {
        width,
        thickness: CLOTH * 1.4,
        closed: true,
        sides: 8,
        tileMetres: tex.garments.obi.tileMetres * WEAVE,
      }),
    );
  };
  loop(0.031, 0.021, 0.010, 0.030);
  loop(0.012, 0.027, 0.009, 0.019);

  // Two loose ends, relaxed under gravity against the hip. Different lengths,
  // different lateral bias and a different flutter phase, because two tails
  // baked from the same parameters hang as mirror images and the eye catches it.
  const tails: { len: number; bias: number; width: number; seed: number; flutter: number }[] = [
    { len: 0.315, bias: 0.28, width: 0.070, seed: 21, flutter: 0.028 },
    { len: 0.195, bias: 0.85, width: 0.058, seed: 34, flutter: 0.018 },
  ];
  for (let i = 0; i < tails.length; i++) {
    const t = tails[i];
    const start = knotP
      .clone()
      .addScaledVector(knotSide, t.bias * 0.026)
      .addScaledVector(new THREE.Vector3(0, 1, 0), -0.026)
      .addScaledVector(knotN, -0.004);
    const path = bakeStrand(body, {
      from: start,
      dir: new THREE.Vector3(t.bias * 0.2, -1, 0.14).normalize(),
      length: t.len,
      segments: 16,
      stiffness: 0.42,
      bias: new THREE.Vector3(t.bias * 0.3, 0, 0.02),
      flutter: t.flutter,
      waves: 1.25,
      clearance: 0.019,
      seed: t.seed,
    });
    knotParts.push(
      buildBand(path, {
        // Tapered, and the taper is what makes it read as a cut end rather than
        // a strap: the tip is narrower and thinner than the root.
        width: (u) => t.width * (1 - 0.22 * u),
        thickness: CLOTH * 1.15,
        sides: 8,
        twist: (i === 0 ? 1 : -1) * 0.55,
        tileMetres: tex.garments.obi.tileMetres * WEAVE,
      }),
    );
  }
  attachGarment(rig, {
    name: 'obiKnot',
    geometry: mergeGeometry(knotParts),
    kind: 'cloth',
    color: p.accent,
    shadowColor: 0x7c3210,
    tex: tex.garments.obi,
    bind: 'hips',
    specular: 0.32,
  }, out);

  // -------------------------------------------------------------- hand wraps --
  for (const side of ['L', 'R'] as const) {
    const axis = chainAxis(body, [`forearm${side}`, `hand${side}`] as BoneName[], 0.72);
    const shell = buildShell(body, {
      axis,
      from: 0.5,
      to: 0.93,
      offset: ramp([[0, LAYER.skin], [0.4, LAYER.skin + 0.0018], [1, LAYER.skin]]),
      cloth: 0.0032,
      segments: 13,
      radial: 28,
      lining: 3,
      follow: armOf(side),
      fromEdge: { fold: 0.010, roll: 0.0038, rings: 3 },
      toEdge: { fold: 0.009, roll: 0.0038, rings: 3 },
      drape: { folds: 4, amplitude: 0.0009, along: 3.5, seed: 41 },
      tileMetres: tex.wrap.tileMetres * WEAVE,
    });
    // The extra turn at the wrist. One band is all it takes for the wrap to stop
    // looking like a white sock.
    const wristRing = surfaceCurve(body, {
      axis,
      samples: 34,
      s: (t) => 0.6 + Math.sin(t * Math.PI * 2) * 0.012,
      angle: (t) => t * Math.PI * 2,
      offset: LAYER.skin + 0.0032,
      follow: armOf(side),
    });
    attachGarment(rig, {
      name: `handWrap${side}`,
      geometry: mergeGeometry([
        shell.geometry,
        buildBand(wristRing, {
          width: 0.019,
          thickness: 0.0032,
          closed: true,
          sides: 8,
          tileMetres: tex.wrap.tileMetres * WEAVE,
        }),
      ]),
      kind: 'wrap',
      color: p.wrap,
      tex: tex.wrap,
      normalScale: 1.2,
    }, out);
  }

  // ------------------------------------------------------------- ankle wraps --
  // Two helices of opposite handedness plus a finishing turn at the top. The
  // criss-cross is the whole point, so they are wound from the same start height
  // in opposite directions rather than offset in phase.
  for (const side of ['L', 'R'] as const) {
    const axis = chainAxis(body, [`shin${side}`, `foot${side}`] as BoneName[], 0);
    const lowY = m.ankleY + 0.042;
    const highY = m.ankleY + 0.175;
    const s0 = axis.sAtY(lowY);
    const s1 = axis.sAtY(highY);
    // Rigid to the shin: the whole cluster sits between the ankle and the calf,
    // and one bone's worth of motion is the truth for it. That also skips the
    // field-weight diffusion, which is the expensive half of a costume build.
    const parts: THREE.BufferGeometry[] = [];
    for (const hand of [1, -1]) {
      const spiral = surfaceCurve(body, {
        axis,
        samples: 64,
        s: (t) => THREE.MathUtils.lerp(s0, s1, t),
        angle: (t) => FRONT + hand * (t * 1.55 * Math.PI * 2 - 0.5),
        offset: LAYER.skin + 0.0015,
        follow: shinOf(side),
      });
      parts.push(buildBand(spiral, { width: 0.0135, thickness: 0.0038, sides: 8, tileMetres: tex.garments.obi.tileMetres }));
    }
    const topRing = surfaceCurve(body, {
      axis,
      samples: 32,
      s: () => s1,
      angle: (t) => t * Math.PI * 2,
      offset: LAYER.skin + 0.0022,
      follow: shinOf(side),
    });
    parts.push(buildBand(topRing, { width: 0.017, thickness: 0.004, closed: true, sides: 8, tileMetres: tex.garments.obi.tileMetres }));
    attachGarment(rig, {
      name: `ankleWrap${side}`,
      geometry: mergeGeometry(parts),
      kind: 'cloth',
      color: p.accent,
      shadowColor: 0x7c3210,
      tex: tex.garments.obi,
      bind: `shin${side}` as BoneName,
      specular: 0.3,
    }, out);
  }

  // ------------------------------------------------------------------ shoes --
  if (!def.barefoot) buildShoes(rig, def, out);

  return out;
}

/**
 * Low-top trainers.
 *
 * The foot is the one place where the body's own surface *is* the floor: the
 * sole sits on y = 0 exactly, so any offset would sink the shoe through the
 * stage. Both shells are therefore clipped to a half-space above the ground —
 * which is also what gives a shoe its flat bottom and hard sole line in
 * silhouette, where a bare foot has a soft curve.
 */
function buildShoes(rig: BuiltCharacter, def: FighterDef, out: BuiltCostume): void {
  const body: GarmentBody = rig;
  const m = rig.metrics;
  const p = def.palette;
  const tex = fighterTextures(def);
  const UP = new THREE.Vector3(0, 1, 0);
  const LEFT = new THREE.Vector3(1, 0, 0);

  for (const side of ['L', 'R'] as const) {
    const ankle = rig.joints[`foot${side}` as BoneName];
    const toe = rig.joints[`toe${side}` as BoneName];
    const FL = m.footLen;
    // Same station points the foot volume was swept along in `body.ts`, so the
    // shoe axis threads the middle of the foot instead of skewing to the heel.
    const axis = axisFromPoints([
      new THREE.Vector3(ankle.x, 0.033, ankle.z - FL * 0.17),
      new THREE.Vector3(ankle.x, 0.044, ankle.z - FL * 0.02),
      new THREE.Vector3((ankle.x + toe.x) * 0.5, 0.039, ankle.z + FL * 0.16),
      new THREE.Vector3(toe.x, 0.027, toe.z + FL * 0.02),
      new THREE.Vector3(toe.x, 0.016, toe.z + FL * 0.21),
    ]);

    // Upper. Angle 0 is up (the instep) because the axis runs horizontally, so
    // the anatomical-front hint would be degenerate.
    const upper = buildShell(body, {
      axis,
      from: 0.03,
      to: 0.965,
      offset: ramp([[0, 0.008], [0.25, 0.007], [0.75, 0.0065], [1, 0.006]]),
      cloth: 0.0045,
      segments: 18,
      radial: 32,
      lining: 3,
      front: UP,
      left: LEFT,
      // Without this the upward ray from the heel never leaves the body: the
      // ankle runs straight into the shin, and the shoe grows up the leg.
      follow: footOf(side),
      // Below the sole line the white midsole takes over, so the navy stops there.
      keepSide: { normal: UP, d: 0.0235, softness: 0.004 },
      fromEdge: { fold: 0.008, roll: 0.004, rings: 3 },
      toEdge: { fold: 0.008, roll: 0.004, rings: 3 },
      drape: { folds: 5, amplitude: 0.0012, along: 2, seed: 61 },
      tileMetres: tex.boots?.tileMetres ?? 0.2,
    });
    // Midsole: the lower arc of the same foot, one layer further out and pressed
    // flat onto the ground plane.
    const sole = buildShell(body, {
      axis,
      from: 0.015,
      to: 0.98,
      offset: 0.0135,
      cloth: 0.005,
      segments: 18,
      radial: 26,
      lining: 3,
      arc: [94 * Math.PI / 180, 266 * Math.PI / 180],
      closed: false,
      front: UP,
      left: LEFT,
      follow: footOf(side),
      keepSide: { normal: UP, d: 0.0016, softness: 0.003 },
      fromEdge: { fold: 0.008, roll: 0.0045, rings: 3 },
      toEdge: { fold: 0.008, roll: 0.0045, rings: 3 },
      tileMetres: 0.2,
    });
    attachGarment(rig, {
      name: `sole${side}`,
      geometry: sole.geometry,
      kind: 'leather',
      color: 0xefe9dd,
      shadowColor: 0xa89a86,
      specular: 0.25,
      outlineWidth: 0.85,
      bind: `foot${side}` as BoneName,
    }, out);

    // Ankle collar, on the shin rather than the foot: a low-top's cuff rises past
    // the ankle bone and no ray from a horizontal foot axis reaches it.
    const shinAxis = chainAxis(body, [`shin${side}`, `foot${side}`] as BoneName[], 0);
    const collar = buildShell(body, {
      axis: shinAxis,
      from: shinAxis.sAtY(m.ankleY + 0.036),
      to: shinAxis.sAtY(0.02),
      offset: 0.0105,
      cloth: 0.0045,
      segments: 10,
      radial: 30,
      lining: 3,
      follow: shinOf(side),
      fromEdge: { fold: 0.009, roll: 0.0045, rings: 3 },
      tileMetres: tex.boots?.tileMetres ?? 0.2,
    });

    // Two straps over the instep. Each is a curve at a fixed station sweeping over
    // the top of the foot, which is the cheapest detail per pixel in the outfit.
    const straps = [0.40, 0.55].map((station) =>
      buildBand(
        surfaceCurve(body, {
          axis,
          samples: 26,
          s: () => station,
          angle: (t) => (-115 + t * 230) * Math.PI / 180,
          offset: 0.0145,
          front: UP,
          left: LEFT,
          follow: footOf(side),
        }),
        { width: 0.0135, thickness: 0.004, sides: 8, tileMetres: tex.boots?.tileMetres ?? 0.2 },
      ),
    );

    // Upper, cuff and straps are one rigid-bound mesh. A shoe is a single solid
    // object that goes where the foot goes; nothing about it wants the body's
    // per-vertex weighting, and skipping it saves most of the build cost here.
    attachGarment(rig, {
      name: `shoe${side}`,
      geometry: mergeGeometry([upper.geometry, collar.geometry, ...straps]),
      kind: 'leather',
      color: p.boots,
      shadowColor: 0x141f33,
      tex: tex.boots,
      normalScale: 0.7,
      specular: 0.4,
      bind: `foot${side}` as BoneName,
    }, out);
  }
}
