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
  torsoEnvelope,
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

export function buildKaiCostume(rig: BuiltCharacter, def: FighterDef): BuiltCostume {
  const body: GarmentBody = rig;
  const m = rig.metrics;
  const tex = fighterTextures(def);
  const p = def.palette;
  const out = emptyCostume();
  const env = torsoEnvelope(m);

  const Y = (l: Parameters<typeof landmarkY>[1]) => landmarkY(m, l);
  const armpit = Y('armpit');

  // ------------------------------------------------------------------ pants --
  // Two shells, one per leg, from the hip joint to the upper calf. The offset
  // profile is the whole character of the garment: nearly on the skin at the
  // hip so the gi can sit over it, ballooning through the thigh and past the
  // knee, then cinched hard into the cuff. That balloon-then-cinch is what
  // breaks the silhouette at the knee in the reference.
  const pantHemY = Y('knee') - (Y('knee') - Y('ankle')) * 0.34;
  const pantOffset = ramp([
    [0.0, 0.005],
    [0.12, 0.010],
    [0.32, 0.024],
    [0.5, 0.034],
    [0.63, 0.041],
    [0.72, 0.039],
    [0.8, 0.016],
    [1.0, 0.013],
  ]);

  for (const side of ['L', 'R'] as const) {
    const axis = chainAxis(body, [`thigh${side}`, `shin${side}`, `foot${side}`] as BoneName[], 0);
    const hemS = axis.sAtY(pantHemY);
    // The two legs share the pelvis, so each is clipped at the sagittal plane —
    // which is exactly a trouser inseam. They are given a hair's difference in
    // offset because the strip where they overlap would otherwise be two
    // coincident surfaces fighting for the same depth.
    const bias = side === 'L' ? 0 : 0.0006;
    const sign = side === 'L' ? 1 : -1;
    const shell = buildShell(body, {
      axis,
      from: 0.0,
      to: hemS,
      offset: (s) => pantOffset(s / hemS) + bias,
      cloth: CLOTH * 1.15,
      segments: 26,
      radial: 44,
      lining: 4,
      // The waist end is raw on purpose: it lives under the gi skirt, and a hem
      // there would be a bead pushing through the layer above it.
      fromEdge: undefined,
      toEdge: { fold: 0.026, roll: 0.0075, rings: 4 },
      drape: { folds: 7, amplitude: 0.0055, along: 2.4, seed: 11 + (side === 'R' ? 5 : 0), sag: 0.004 },
      keepSide: { normal: new THREE.Vector3(sign, 0, 0), d: -0.0015 },
      tileMetres: tex.garments.pants.tileMetres,
    });
    attachGarment(rig, {
      name: `pant${side}`,
      geometry: shell.geometry,
      kind: 'cloth',
      color: p.secondary,
      tex: tex.garments.pants,
      normalScale: 0.8,
    }, out);
  }

  // --------------------------------------------------------------------- gi --
  // Trunk axis runs from under the hem to over the shoulders so both boundary
  // curves land inside the axis' range with room for their folds.
  const giAxis = torsoAxis(body, Y('crotch') - 0.02, m.neckBaseY + 0.06);
  const giHemY = Y('hip') - 0.028;

  // The armhole rule, as one number. Zero below the armpit, so the gi lies on
  // the ribs rather than following the fused arm outward; opening to 12 cm above
  // it, so the shoulder rides over the deltoid and reads as a cap sleeve.
  const giBridge = (s: number): number => {
    const y = giAxis.pointAt(s).y;
    return 0.12 * THREE.MathUtils.smoothstep(y, armpit + 0.004, armpit + 0.062);
  };

  // Top edge of the main body of the gi. The lapel diagonal is the load-bearing
  // shape: it climbs to the character's right shoulder and falls away across the
  // chest to disappear under the obi on the left, which is what makes a wrap
  // front read as a wrap front and not as a T-shirt with a stripe painted on.
  const giTop = edgeAtHeight(giAxis, [
    [180, m.neckBaseY + 0.008],
    [148, m.neckBaseY - 0.002],
    [118, m.neckBaseY - 0.014],
    [100, armpit + 0.085],
    [88, armpit + 0.075],
    [76, armpit + 0.06],
    [66, Y('waist') + 0.012],
    [40, Y('waist') + 0.05],
    [14, Y('waist') + 0.115],
    [-12, Y('waist') + 0.175],
    [-38, Y('waist') + 0.255],
    [-58, m.neckBaseY - 0.02],
    [-76, m.neckBaseY - 0.012],
    [-90, armpit + 0.08],
    [-104, armpit + 0.09],
    [-124, m.neckBaseY - 0.014],
    [-152, m.neckBaseY - 0.002],
  ]);
  // Side vents: the hem lifts at the hips, the way a gi skirt is slit.
  const giHem = byAngle([
    [0, giHemY],
    [55, giHemY],
    [82, giHemY + 0.045],
    [98, giHemY + 0.045],
    [125, giHemY],
    [180, giHemY],
    [-125, giHemY],
    [-98, giHemY + 0.045],
    [-82, giHemY + 0.045],
    [-55, giHemY],
  ]);

  const gi = buildShell(body, {
    axis: giAxis,
    from: (_u, a) => giAxis.sAtY(giHem(a)),
    to: giTop,
    offset: LAYER.mid,
    cloth: CLOTH,
    segments: 30,
    radial: 72,
    lining: 5,
    follow: TORSO,
    bridge: giBridge,
    fromEdge: { fold: 0.018, roll: 0.005, rings: 3 },
    toEdge: { fold: 0.014, roll: 0.0045, rings: 3 },
    drape: { folds: 6, amplitude: 0.0035, along: 1.8, seed: 3, sag: 0.003 },
    tileMetres: tex.garments.gi.tileMetres,
  });
  attachGarment(rig, {
    name: 'gi',
    geometry: gi.geometry,
    kind: 'cloth',
    color: p.primary,
    tex: tex.garments.gi,
    normalScale: 0.9,
  }, out);

  // The under-lapel: the panel the crossing one covers, visible only as the
  // wedge of the V at the neck. It stops well below the over-panel's edge, so
  // its own bottom is hidden rather than finished.
  const underTop = edgeAtHeight(giAxis, [
    [22, Y('waist') + 0.145],
    [40, Y('waist') + 0.215],
    [58, m.neckBaseY - 0.028],
    [76, m.neckBaseY - 0.014],
    [96, armpit + 0.078],
    [112, m.neckBaseY - 0.016],
    [128, m.neckBaseY - 0.006],
  ]);
  const under = buildShell(body, {
    axis: giAxis,
    from: giAxis.sAtY(Y('waist') - 0.03),
    to: underTop,
    offset: LAYER.mid - 0.0022,
    segments: 8,
    radial: 26,
    lining: 3,
    arc: [22 * DEG, 128 * DEG],
    closed: false,
    follow: TORSO,
    bridge: giBridge,
    toEdge: { fold: 0.014, roll: 0.0045, rings: 3 },
    tileMetres: tex.garments.gi.tileMetres,
  });
  attachGarment(rig, {
    name: 'giUnder',
    geometry: under.geometry,
    kind: 'cloth',
    color: p.primary,
    tex: tex.garments.gi,
    normalScale: 0.9,
  }, out);

  // Collar band. Swept along the shells' own finished boundaries, so it cannot
  // drift off the edge it is trimming — the reason `buildShell` hands its
  // boundaries back at all.
  const collar = (curve: Boundary, name: string, width: number) => {
    if (curve.points.length < 3) return;
    attachGarment(rig, {
      name,
      geometry: buildBand(curve, {
        width,
        thickness: CLOTH * 1.1,
        lift: -CLOTH * 0.35,
        sides: 10,
        tileMetres: tex.garments.obi.tileMetres,
      }),
      kind: 'cloth',
      color: p.accent,
      tex: tex.garments.obi,
      specular: 0.35,
    }, out);
  };
  collar(sliceBoundary(gi.to, -62, 74), 'giLapel', 0.026);
  collar(sliceBoundary(gi.to, 106, 254), 'giCollarBack', 0.019);
  collar(sliceBoundary(under.to, 26, 84), 'giUnderLapel', 0.021);

  // -------------------------------------------------------------------- obi --
  // Wrapped twice: two shells, the upper one riding a little higher on the
  // character's left so the two passes read as one length of cloth spiralling
  // round rather than as two stacked rings.
  const obiAxis = torsoAxis(body, Y('navel') - 0.09, Y('waist') + 0.09);
  const obiLowY = Y('hip') + m.torsoLen * 0.13;
  const obiMidY = Y('hip') + m.torsoLen * 0.265;
  const obiTopY = Y('hip') + m.torsoLen * 0.395;

  const obiWraps: { name: string; from: (a: number) => number; to: (a: number) => number; offset: number }[] = [
    {
      name: 'obiLower',
      from: byAngle([[0, obiLowY], [90, obiLowY + 0.006], [180, obiLowY + 0.012], [-90, obiLowY + 0.004]]),
      to: byAngle([[0, obiMidY + 0.004], [90, obiMidY], [180, obiMidY - 0.006], [-90, obiMidY + 0.002]]),
      offset: LAYER.belt,
    },
    {
      name: 'obiUpper',
      from: byAngle([[0, obiMidY - 0.004], [90, obiMidY - 0.008], [180, obiMidY - 0.014], [-90, obiMidY - 0.006]]),
      to: byAngle([[0, obiTopY], [90, obiTopY + 0.008], [180, obiTopY - 0.004], [-90, obiTopY + 0.002]]),
      offset: over(LAYER.belt),
    },
  ];
  for (const w of obiWraps) {
    const shell = buildShell(body, {
      axis: obiAxis,
      from: (_u, a) => obiAxis.sAtY(w.from(a)),
      to: (_u, a) => obiAxis.sAtY(w.to(a)),
      offset: w.offset,
      cloth: CLOTH * 1.3,
      segments: 12,
      radial: 60,
      lining: 3,
      follow: TORSO,
      fromEdge: { fold: 0.012, roll: 0.0055, rings: 3 },
      toEdge: { fold: 0.012, roll: 0.0055, rings: 3 },
      drape: { folds: 9, amplitude: 0.0022, along: 1.2, seed: 7 },
      tileMetres: tex.garments.obi.tileMetres,
    });
    attachGarment(rig, {
      name: w.name,
      geometry: shell.geometry,
      kind: 'cloth',
      color: p.accent,
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

  const loop = (radiusX: number, radiusY: number, roll: number, width: number, name: string) => {
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
    attachGarment(rig, {
      name,
      geometry: buildBand({ points: pts, normals: nrm, u: pts.map((_, i) => i / n), angle: pts.map(() => 0) }, {
        width,
        thickness: CLOTH * 1.4,
        closed: true,
        sides: 8,
        tileMetres: tex.garments.obi.tileMetres,
      }),
      kind: 'cloth',
      color: p.accent,
      tex: tex.garments.obi,
      bind: 'hips',
      specular: 0.32,
    }, out);
  };
  loop(0.040, 0.026, 0.006, 0.030, 'obiKnot');
  loop(0.013, 0.030, 0.010, 0.020, 'obiCinch');

  // Two loose ends, relaxed under gravity against the hip. Different lengths,
  // opposite lateral bias and different flutter phase, because two tails baked
  // from the same parameters hang as mirror images and the eye catches it.
  const tails: { len: number; bias: number; width: number; seed: number; flutter: number }[] = [
    { len: 0.30, bias: -0.55, width: 0.072, seed: 21, flutter: 0.026 },
    { len: 0.205, bias: 0.7, width: 0.062, seed: 34, flutter: 0.02 },
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
      dir: new THREE.Vector3(t.bias * 0.22, -1, 0.34).normalize(),
      length: t.len,
      segments: 16,
      stiffness: 0.42,
      bias: new THREE.Vector3(t.bias * 0.35, 0, 0.12),
      flutter: t.flutter,
      waves: 1.25,
      clearance: over(LAYER.belt, 2),
      seed: t.seed,
    });
    attachGarment(rig, {
      name: `obiTail${i}`,
      geometry: buildBand(path, {
        // Tapered, and the taper is what makes it read as a cut end rather than
        // a strap: the tip is narrower and thinner than the root.
        width: (u) => t.width * (1 - 0.22 * u),
        thickness: CLOTH * 1.15,
        sides: 8,
        twist: (i === 0 ? 1 : -1) * 0.55,
        tileMetres: tex.garments.obi.tileMetres,
      }),
      kind: 'cloth',
      color: p.accent,
      tex: tex.garments.obi,
      bind: 'hips',
      specular: 0.32,
    }, out);
  }

  // -------------------------------------------------------------- hand wraps --
  for (const side of ['L', 'R'] as const) {
    const axis = chainAxis(body, [`forearm${side}`, `hand${side}`] as BoneName[], 0.72);
    const shell = buildShell(body, {
      axis,
      from: 0.5,
      to: 0.93,
      offset: ramp([[0, LAYER.skin], [0.4, LAYER.skin + 0.0018], [1, LAYER.skin]]),
      cloth: 0.0032,
      segments: 16,
      radial: 32,
      lining: 3,
      follow: armOf(side),
      fromEdge: { fold: 0.010, roll: 0.0038, rings: 3 },
      toEdge: { fold: 0.009, roll: 0.0038, rings: 3 },
      drape: { folds: 4, amplitude: 0.0009, along: 3.5, seed: 41 },
      tileMetres: tex.wrap.tileMetres,
    });
    attachGarment(rig, {
      name: `handWrap${side}`,
      geometry: shell.geometry,
      kind: 'wrap',
      color: p.wrap,
      tex: tex.wrap,
      normalScale: 1.2,
    }, out);

    // The extra turn at the wrist. One band is all it takes for the wrap to
    // stop looking like a white sock.
    const wristRing = surfaceCurve(body, {
      axis,
      samples: 34,
      s: (t) => 0.6 + Math.sin(t * Math.PI * 2) * 0.012,
      angle: (t) => t * Math.PI * 2,
      offset: LAYER.skin + 0.0032,
    });
    attachGarment(rig, {
      name: `wristWrap${side}`,
      geometry: buildBand(wristRing, {
        width: 0.019,
        thickness: 0.0032,
        closed: true,
        sides: 8,
        tileMetres: tex.wrap.tileMetres,
      }),
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
    for (const hand of [1, -1]) {
      const spiral = surfaceCurve(body, {
        axis,
        samples: 64,
        s: (t) => THREE.MathUtils.lerp(s0, s1, t),
        angle: (t) => FRONT + hand * (t * 1.55 * Math.PI * 2 - 0.5),
        offset: LAYER.skin + 0.0015,
      });
      attachGarment(rig, {
        name: `ankleWrap${side}${hand > 0 ? 'A' : 'B'}`,
        geometry: buildBand(spiral, {
          width: 0.0135,
          thickness: 0.0038,
          sides: 8,
          tileMetres: tex.garments.obi.tileMetres,
        }),
        kind: 'cloth',
        color: p.accent,
        tex: tex.garments.obi,
        specular: 0.3,
      }, out);
    }
    const topRing = surfaceCurve(body, {
      axis,
      samples: 32,
      s: () => s1,
      angle: (t) => t * Math.PI * 2,
      offset: LAYER.skin + 0.0022,
    });
    attachGarment(rig, {
      name: `ankleBand${side}`,
      geometry: buildBand(topRing, {
        width: 0.017,
        thickness: 0.004,
        closed: true,
        sides: 8,
        tileMetres: tex.garments.obi.tileMetres,
      }),
      kind: 'cloth',
      color: p.accent,
      tex: tex.garments.obi,
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
      segments: 22,
      radial: 40,
      lining: 4,
      front: UP,
      left: LEFT,
      // Without this the upward ray from the heel never leaves the body: the
      // ankle runs straight into the shin, and the shoe grows up the leg.
      follow: footOf(side),
      // Below the sole line the white midsole takes over, so the navy stops there.
      keepSide: { normal: UP, d: 0.0105 },
      fromEdge: { fold: 0.008, roll: 0.004, rings: 3 },
      toEdge: { fold: 0.008, roll: 0.004, rings: 3 },
      drape: { folds: 5, amplitude: 0.0012, along: 2, seed: 61 },
      tileMetres: tex.boots?.tileMetres ?? 0.2,
    });
    attachGarment(rig, {
      name: `shoe${side}`,
      geometry: upper.geometry,
      kind: 'leather',
      color: p.boots,
      tex: tex.boots,
      normalScale: 0.7,
      specular: 0.4,
    }, out);

    // Midsole: the lower arc of the same foot, one layer further out and pressed
    // flat onto the ground plane.
    const sole = buildShell(body, {
      axis,
      from: 0.015,
      to: 0.98,
      offset: 0.0115,
      cloth: 0.005,
      segments: 22,
      radial: 30,
      lining: 3,
      arc: [126 * Math.PI / 180, 234 * Math.PI / 180],
      closed: false,
      front: UP,
      left: LEFT,
      follow: footOf(side),
      keepSide: { normal: UP, d: 0.0006 },
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
    }, out);

    // Ankle collar, on the shin rather than the foot: a low-top's cuff rises
    // past the ankle bone and no ray from a horizontal foot axis reaches it.
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
    attachGarment(rig, {
      name: `shoeCollar${side}`,
      geometry: collar.geometry,
      kind: 'leather',
      color: p.boots,
      tex: tex.boots,
      normalScale: 0.7,
      specular: 0.4,
    }, out);

    // Two straps over the instep. Each is a curve at fixed station sweeping over
    // the top of the foot, which is the cheapest detail per pixel in the outfit.
    for (const [i, station] of [0.40, 0.55].entries()) {
      const strap = surfaceCurve(body, {
        axis,
        samples: 26,
        s: () => station,
        angle: (t) => (-115 + t * 230) * Math.PI / 180,
        offset: 0.0145,
        front: UP,
        left: LEFT,
        follow: footOf(side),
      });
      attachGarment(rig, {
        name: `shoeStrap${side}${i}`,
        geometry: buildBand(strap, {
          width: 0.0135,
          thickness: 0.004,
          sides: 8,
          tileMetres: tex.boots?.tileMetres ?? 0.2,
        }),
        kind: 'leather',
        color: p.boots,
        tex: tex.boots,
        specular: 0.45,
      }, out);
    }
  }
}
