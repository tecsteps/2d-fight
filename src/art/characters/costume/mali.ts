import * as THREE from 'three';
import type { BoneName } from '../../../anim/contract';
import type { FighterDef } from '../../../data/roster';
import type { BuiltCharacter } from '../rig';
import { fighterTextures, ribbedKnit, satinFabric } from '../../textures';
import {
  attachGarment,
  axisFromPoints,
  buildBand,
  buildShell,
  byAngle,
  chainAxis,
  CLOTH,
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
 * Mali — "Eight Limbs", Muay Thai.
 *
 * From her fourteen design sheets: a dark-green racerback sports bra edged in gold,
 * black satin Muay Thai shorts with red side panels, gold piping and the
 * characteristic flared side split, black compression shorts showing below the
 * hem, red hand wraps and red ankle wraps, barefoot.
 *
 * The two things that have to be right or the outfit is just clothes:
 *
 * 1. **The satin.** These shorts are the only anisotropic surface on the roster.
 *    `satinFabric` supplies the streaked roughness and `kind: 'satin'` the
 *    Kajiya-Kay band; the aniso axis is object-space +Y by default, so the glint
 *    lies *across* the leg the way a real pair of shorts catches a ring light.
 * 2. **The flare.** A Muay Thai short is cut with the outer leg opening far wider
 *    than the leg, so the hem stands off the thigh and swings. That is a radial
 *    bulge in the offset profile, not a silhouette drawn on the cloth.
 *
 * Layer ladder, innermost first:
 *   LAYER.skin  0.0035  hand wraps, ankle wraps
 *   0.0047              compression shorts
 *   LAYER.base  0.0090  satin shorts and the red side panels (side by side)
 *   +0.0040             gold piping, riding the seam between them
 *   +0.0048             ribbed waistband, over the black panel only
 *   0.0075              sports bra (fitted, so it sits inside LAYER.base)
 */

const DEG = Math.PI / 180;

/**
 * Weave tiling multiplier.
 *
 * The fabric library authors its tiles at a generous physical size; left alone
 * the thread reads as basketwork at fighting distance. Satin gets a gentler
 * squeeze than cotton because its tile carries the pressed fold lines too, and
 * folds every 7 cm on a pair of shorts is already one per hand's width.
 */
const WEAVE = 0.55;
const SATIN = 0.72;

/** The trunk. Anything a torso garment should lie on, and nothing it should engulf. */
const TORSO = (b: BoneName): boolean =>
  b === 'hips' || b === 'spine' || b === 'chest' || b === 'neck' || b === 'shoulderL' || b === 'shoulderR';

const armOf = (side: 'L' | 'R') => (b: BoneName): boolean =>
  b === `upperArm${side}` || b === `forearm${side}` || b === `hand${side}`;

const footOf = (side: 'L' | 'R') => (b: BoneName): boolean => b === `foot${side}` || b === `toe${side}`;

const shinOf = (side: 'L' | 'R') => (b: BoneName): boolean =>
  b === `shin${side}` || b === `foot${side}` || b === `toe${side}`;

/**
 * What the shorts lie on: the pelvis and both thighs.
 *
 * Both thighs, not just this leg's — the two shells share the pelvis, and one
 * that followed a single thigh would lose the surface halfway across the seat.
 */
const HIPS = (b: BoneName): boolean => b === 'hips' || b === 'spine' || b === 'thighL' || b === 'thighR';

/**
 * An angle profile that does not stair-step.
 *
 * `byAngle` smoothsteps from one stop to the next, and a smoothstep has zero
 * slope *at* its ends — so every authored stop is a flat spot. On a gentle
 * profile that is invisible. On this bra's neckline, which climbs eight
 * centimetres over fifty degrees, each stop becomes a tread and the finished
 * edge renders as a visible staircase with the gold piping dutifully following
 * every step. Resampling linearly every few degrees first makes each smoothstep
 * span too short to read, so the authored shape comes out as one curve.
 */
function smoothByAngle(stops: readonly [number, number][], stepDeg = 3): (angle: number) => number {
  const sorted = [...stops].sort((a, b) => a[0] - b[0]);
  const dense: [number, number][] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [a0, v0] = sorted[i];
    const [a1, v1] = sorted[i + 1];
    const n = Math.max(1, Math.round((a1 - a0) / stepDeg));
    for (let k = 0; k < n; k++) dense.push([a0 + ((a1 - a0) * k) / n, v0 + ((v1 - v0) * k) / n]);
  }
  dense.push(sorted[sorted.length - 1]);
  return byAngle(dense);
}

/** Angle stops authored for the character's left, mirrored onto the right. */
function mirrorAngles(stops: readonly [number, number][], sgn: number): (angle: number) => number {
  return smoothByAngle(stops.map(([d, v]) => [d * sgn, v] as [number, number]));
}

export function buildMaliCostume(rig: BuiltCharacter, def: FighterDef): BuiltCostume {
  const tex = fighterTextures(def);
  const out = emptyCostume();

  // Two dye lots the shared texture suite does not carry. Cut from the same
  // generators as the rest of the outfit so the side panel reads as satin next
  // to satin, and the waistband as the elastic webbing it is.
  const redSatin = satinFabric({ color: 0x9c2a22, seed: 91, direction: 'u', roughness: 0.24, creases: 0.3 });
  const bandKnit = ribbedKnit({ color: 0x17171b, seed: 71, ribs: 26, courses: 8, tileMetres: 0.13, fuzz: 0.3 });

  buildShorts(rig, def, out, tex, redSatin, bandKnit);
  buildBra(rig, def, out, tex);
  buildWraps(rig, def, out, tex);
  return out;
}

// ---------------------------------------------------------------------------
// Shorts
// ---------------------------------------------------------------------------

/**
 * Black satin shorts, red side panels, gold piping, ribbed waistband, and the
 * compression shorts underneath.
 *
 * Everything is built per leg on that leg's own axis. That matters for more than
 * skinning: the red panel, the gold seam that borders it and the waistband that
 * stops against it all have to agree on where "forty degrees round the leg" is, and
 * they only do if they were traced from the same axis. Built on a torso axis the
 * waistband would meet the panel at a different world angle at the hip and the
 * piping would drift off the seam.
 */
function buildShorts(
  rig: BuiltCharacter,
  def: FighterDef,
  out: BuiltCostume,
  tex: ReturnType<typeof fighterTextures>,
  redSatin: ReturnType<typeof satinFabric>,
  bandKnit: ReturnType<typeof ribbedKnit>,
): void {
  const body: GarmentBody = rig;
  const m = rig.metrics;
  const p = def.palette;
  const Y = (l: Parameters<typeof landmarkY>[1]) => landmarkY(m, l);

  const waistTopY = Y('navel') - 0.012;
  const waistBotY = waistTopY - 0.056;
  // Short: a hand's width below the crotch, which is where the reference puts
  // the front hem. Expressed against the thigh so it lands there on any build.
  const hemFrontY = Y('hip') - (Y('hip') - Y('knee')) * 0.26;
  const compHemY = hemFrontY - 0.046;

  // The seam angles the red panel occupies, measured on the leg axis with 0 at
  // the anatomical front and +90 at the character's left.
  const SEAM_FRONT = 41;
  const SEAM_BACK = 136;

  for (const side of ['L', 'R'] as const) {
    const sgn = side === 'L' ? 1 : -1;
    const hip = rig.joints[`thigh${side}` as BoneName];
    // Started above the hip joint so the waistband and the shorts' raw top edge
    // both have axis to sit on; a shell whose boundary lands at s = 0 has no
    // room for its fold and the hem bead collapses into the cap.
    //
    // The top segment is *vertical*, unlike the trouser axis Kai converges toward
    // the midline. Rays are fired perpendicular to the tangent, so a leaning axis
    // tips them, and a waistband traced from one comes out with its top edge
    // dipping into a V at the navel — every millimetre the ray crosses the belly
    // it also drops.
    const axis = axisFromPoints([
      new THREE.Vector3(hip.x, waistTopY + 0.05, hip.z),
      hip.clone(),
      rig.joints[`shin${side}` as BoneName].clone(),
      rig.joints[`foot${side}` as BoneName].clone(),
    ]);

    // The leg opening. Level across the front and back, dropping on the outside
    // where the split is cut, and lifted on the inside so the two legs' hems do
    // not meet in the crotch.
    const hemY = mirrorAngles(
      [
        [0, hemFrontY],
        [42, hemFrontY - 0.005],
        [78, hemFrontY - 0.019],
        [104, hemFrontY - 0.017],
        [140, hemFrontY - 0.002],
        [180, hemFrontY + 0.005],
        [-140, hemFrontY + 0.016],
        [-90, hemFrontY + 0.030],
        [-42, hemFrontY + 0.010],
      ],
      sgn,
    );
    const hemS = (a: number) => axis.sAtY(hemY(a));
    const topS = axis.sAtY(waistTopY);

    // The flare, and it is a *local* bulge, not a wide skirt: the reference
    // corner stands about two and a half centimetres clear of the thigh, and
    // since the cloth is already a centimetre off the skin there, the flare only
    // has to find the rest. Spread it up the leg or round the hip and the shorts
    // stop being shorts. Kept away from the seam angles so the gold piping that
    // runs down them is not lifted with it.
    const flare = (y: number, angle: number): number => {
      let d = angle * sgn - Math.PI / 2;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const across = 1 - THREE.MathUtils.smoothstep(Math.abs(d), 16 * DEG, 50 * DEG);
      const down = THREE.MathUtils.smoothstep(hemFrontY + 0.055 - y, 0, 0.055);
      return 0.015 * across * down;
    };

    // Slack down the leg, plus Kai's trouser trick: the offset is pulled in on
    // the side facing the other leg, or the two shells inflate into each other
    // and the pair reads as a skirt.
    const slack = ramp([
      [waistTopY, 0.0],
      [Y('hip') - 0.02, 0.0015],
      [hemFrontY + 0.05, 0.004],
      [hemFrontY, 0.009],
    ]);
    const inner = sgn > 0 ? Math.PI / 2 : -Math.PI / 2;
    const shortsOffset = (s: number, angle: number, bias: number): number => {
      const y = axis.pointAt(s).y;
      const inward = Math.max(0, -Math.cos(angle - inner));
      return (LAYER.base + slack(y)) * (1 - 0.55 * inward ** 1.4) + flare(y, angle) + bias;
    };

    const clip = { normal: new THREE.Vector3(sgn, 0, 0), d: -0.004, softness: 0.008 };

    // ------------------------------------------------------- compression short --
    // Pulled onto the skin, and longer than the satin so a band of it shows
    // under the hem. That band is most of what stops a Muay Thai short from
    // reading as a pair of gym trunks.
    const comp = buildShell(body, {
      axis,
      from: axis.sAtY(Y('hip') + 0.055),
      to: (_u, a) => axis.sAtY(compHemY - Math.max(0, -Math.cos(a - inner)) * 0.012),
      offset: (_s, _u, a) => 0.0047 * (1 - 0.4 * Math.max(0, -Math.cos(a - inner))),
      cloth: 0.0032,
      segments: 14,
      radial: 40,
      lining: 3,
      follow: HIPS,
      toEdge: { fold: 0.011, roll: 0.0038, rings: 3 },
      keepSide: clip,
      tileMetres: tex.garments.shorts.tileMetres * SATIN,
    });
    attachGarment(rig, {
      name: `compression${side}`,
      geometry: comp.geometry,
      kind: 'cloth',
      color: 0x131318,
      shadowColor: 0x08080c,
      tex: tex.garments.shorts,
      normalScale: 1.0,
      specular: 0.3,
    }, out);

    // ------------------------------------------------------------- side panel --
    // Red, on the outer third of the leg, butted against the black rather than
    // layered over it: a real short is cut from panels, and the gold piping is
    // the seam that joins them. Layering the two would have put a five-millimetre
    // step down the side of the leg with nothing to explain it.
    const redArc: [number, number] = sgn > 0
      ? [SEAM_FRONT * DEG, SEAM_BACK * DEG]
      : [-SEAM_BACK * DEG, -SEAM_FRONT * DEG];
    const red = buildShell(body, {
      axis,
      from: topS,
      to: (_u, a) => hemS(a),
      offset: (s, _u, a) => shortsOffset(s, a, 0),
      cloth: CLOTH,
      segments: 20,
      radial: 30,
      lining: 3,
      arc: redArc,
      closed: false,
      follow: HIPS,
      toEdge: { fold: 0.014, roll: 0.005, rings: 3 },
      drape: { folds: 4, amplitude: 0.0011, along: 1.1, seed: 9 },
      keepSide: clip,
      tileMetres: redSatin.tileMetres * SATIN,
    });
    attachGarment(rig, {
      name: `shortSide${side}`,
      geometry: red.geometry,
      kind: 'satin',
      color: 0xa8302a,
      shadowColor: 0x4a1210,
      tex: redSatin,
      normalScale: 1.4,
      specular: 0.7,
      outlineWidth: 0.8,
    }, out);

    // ----------------------------------------------------------- black panel --
    // The remaining 250-odd degrees: front, inseam and seat in one piece. Three
    // degrees of overlap at each seam so the two panels butt without a slit, and
    // a hair more offset so the overlap does not fight for the same depth.
    const blackArc: [number, number] = sgn > 0
      ? [(SEAM_BACK - 3) * DEG, (SEAM_FRONT + 363) * DEG]
      : [-(SEAM_FRONT + 363) * DEG, -(SEAM_BACK - 3) * DEG];
    const black = buildShell(body, {
      axis,
      from: topS,
      to: (_u, a) => hemS(a),
      offset: (s, _u, a) => shortsOffset(s, a, 0.0009),
      cloth: CLOTH,
      segments: 22,
      radial: 58,
      lining: 3,
      arc: blackArc,
      closed: false,
      follow: HIPS,
      toEdge: { fold: 0.016, roll: 0.0058, rings: 4 },
      // Satin is limp: it breaks into many shallow folds rather than a few deep
      // ones. Depth is capped by the cel ramp, not by taste — a fold steeper than
      // about 0.12 in slope swings the terminator far enough to drop a whole
      // shading band as a hard-edged blot.
      drape: { folds: 8, amplitude: 0.0013, along: 2.2, seed: 5 + (side === 'R' ? 4 : 0), sag: 0.003 },
      keepSide: clip,
      tileMetres: tex.garments.shorts.tileMetres * SATIN,
    });
    attachGarment(rig, {
      name: `short${side}`,
      geometry: black.geometry,
      kind: 'satin',
      color: p.secondary,
      shadowColor: 0x08080b,
      tex: tex.garments.shorts,
      normalScale: 1.7,
      specular: 0.95,
      outlineWidth: 0.9,
    }, out);

    // ------------------------------------------------------------- waistband --
    // Stops where the red panel starts, so the side of the waistband is red the
    // way the reference draws it. Its two cut ends are hidden under the piping.
    const waist = buildShell(body, {
      axis,
      from: topS,
      to: axis.sAtY(waistBotY),
      offset: (s, _u, a) => shortsOffset(s, a, 0.0009) + 0.0048,
      cloth: CLOTH * 1.5,
      segments: 8,
      radial: 54,
      lining: 3,
      arc: blackArc,
      closed: false,
      follow: HIPS,
      fromEdge: { fold: 0.010, roll: 0.0045, rings: 3 },
      toEdge: { fold: 0.010, roll: 0.0050, rings: 3 },
      // Elastic gathers: many shallow vertical creases, which is the one place on
      // this outfit where the fold count is allowed to be high.
      drape: { folds: 14, amplitude: 0.0009, along: 0.35, seed: 17 },
      keepSide: clip,
      tileMetres: bandKnit.tileMetres * 0.8,
    });
    attachGarment(rig, {
      name: `waistband${side}`,
      geometry: waist.geometry,
      kind: 'cloth',
      color: 0x17171b,
      shadowColor: 0x0a0a0d,
      tex: bandKnit,
      normalScale: 1.5,
      specular: 0.18,
      outlineWidth: 0.9,
    }, out);

    // ------------------------------------------------------------ gold piping --
    // One curve, not three: down the front seam, all the way round the hem of the
    // black panel, and back up the rear seam. Authored as a single sweep in angle
    // with the descent and the climb folded into a weight, so the corners come
    // out rounded — two bands meeting at a right angle pinch into a dark knot.
    const sweep = (t: number) => (SEAM_FRONT - t * (360 - (SEAM_BACK - SEAM_FRONT))) * DEG * sgn;
    const drop = (t: number) =>
      Math.min(THREE.MathUtils.smoothstep(t, 0, 0.075), THREE.MathUtils.smoothstep(1 - t, 0, 0.075));
    const piping = surfaceCurve(body, {
      axis,
      samples: 150,
      angle: sweep,
      s: (t) => THREE.MathUtils.lerp(topS, hemS(sweep(t)), drop(t)),
      offset: (s, _u, a) => shortsOffset(s, a, 0.0009) + 0.0040,
      follow: HIPS,
    });
    attachGarment(rig, {
      name: `shortTrim${side}`,
      geometry: buildBand(piping, {
        width: 0.0086,
        thickness: 0.0031,
        sides: 8,
        tileMetres: tex.garments.trim.tileMetres * SATIN,
      }),
      kind: 'satin',
      color: 0xa17c18,
      shadowColor: 0x4e3a09,
      tex: tex.garments.trim,
      specular: 0.38,
      normalScale: 0.8,
      outlineWidth: 0.5,
    }, out);
  }
}

// ---------------------------------------------------------------------------
// Sports bra
// ---------------------------------------------------------------------------

/**
 * Dark-green racerback sports bra with gold piping.
 *
 * One closed shell. The garment's whole shape lives in its two boundary curves:
 * `from` is the elastic underbust band, `to` is the single continuous edge that
 * is the scoop neckline at the front, the armhole where it climbs the shoulder,
 * and the racerback yoke behind. Piping swept along both boundaries then traces
 * exactly that outline, which is how the reference draws it too.
 *
 * The armhole is the *bridge transition*, not a notch: below the armpit the
 * cloth follows the trunk alone and disappears behind the hanging arm, above it
 * the cloth is allowed out onto the deltoid. The step between the two is the
 * finished edge a viewer reads as an armhole.
 */
function buildBra(
  rig: BuiltCharacter,
  def: FighterDef,
  out: BuiltCostume,
  tex: ReturnType<typeof fighterTextures>,
): void {
  const body: GarmentBody = rig;
  const m = rig.metrics;
  const p = def.palette;
  const Y = (l: Parameters<typeof landmarkY>[1]) => landmarkY(m, l);

  const axis = torsoAxis(body, Y('waist') - 0.06, m.neckBaseY + 0.12);
  const armpit = Y('armpit');
  const shoulderY = Y('shoulder');
  const chest = Y('chest');
  const hem = Y('hip') + m.torsoLen * 0.45;
  // Where a strap actually crosses this body's shoulder.
  //
  // Traced, not guessed. The deltoid, trapezius and neck are blended with a
  // three-centimetre smooth-min, so the shoulder is not a ball with a notch
  // beside it: the surface climbs continuously from the deltoid point at
  // y = shoulderY out to the neck at y = neckBase + 0.08. A radial ray reaches
  // the *top* of that slope only above the neck base — fired at shoulder height
  // it hits the side of the deltoid, and cloth authored there lands as a patch
  // stuck on the outside of the arm rather than a strap over the top of it.
  const crest = m.neckBaseY + m.height * 0.032;

  // The top edge, and every decision in the garment is in it: the scoop
  // neckline, the armhole, the strap over the shoulder and the racerback yoke
  // are one continuous curve, exactly as the reference draws the gold piping
  // that trims them.
  const stops: [number, number][] = [
    // Scoop: nearly flat across the sternum, so it reads as a U and not a V.
    [0, chest + 0.036],
    [12, chest + 0.040],
    [24, chest + 0.057],
    [36, chest + 0.092],
    [46, chest + 0.130],
    [56, crest - 0.068],
    [68, crest - 0.032],
    [80, crest - 0.006],
    [90, crest],
    [102, crest - 0.010],
    [116, crest - 0.046],
    // The racerback: a deep armhole scooped out of the back panel, then a yoke
    // that climbs almost to C7 between the shoulder blades.
    [134, chest + 0.055],
    [150, chest + 0.100],
    [166, m.neckBaseY - 0.038],
    [180, m.neckBaseY - 0.022],
  ];
  const top = smoothByAngle(
    stops.flatMap(([d, v]) => (d === 0 ? [[d, v]] : [[d, v], [-d, v]]) as [number, number][]),
  );
  const band = smoothByAngle([
    [0, hem - 0.005],
    [45, hem + 0.004],
    [90, hem + 0.009],
    [135, hem + 0.013],
    [180, hem + 0.015],
    [-135, hem + 0.013],
    [-90, hem + 0.009],
    [-45, hem + 0.004],
  ]);

  // The bridge follows the garment's own edge instead of a fixed height, and that
  // is the whole reason the straps join the cups.
  //
  // Kai's gi can open its bridge at one height because its edge is at one height.
  // This edge is not: it is on the sternum at the front and eight centimetres
  // higher over the shoulder. Opened at a fixed height, the cloth near the edge
  // rides the deltoid at the shoulder and stays on the ribs across the front of
  // it — so the strap and the cup come out as two separate patches of green with
  // the bare deltoid between them, which is what the fixed version rendered.
  //
  // Tying it to `top` states the real rule: the *finished edge* of a sleeveless
  // garment lies on the outside of whatever it crosses, and the body of the
  // garment lies on the ribs. Clamped above the armpit so it can never open low
  // enough to swallow the hanging arm.
  const bridge = (s: number, _u: number, angle: number): number => {
    const y = axis.pointAt(s).y;
    const edge = top(angle);
    // Completed a good four centimetres *below* the edge, not at it. The lift is
    // an either/or per vertex — take the real surface or stay on the ribs — so
    // wherever the changeover lands it leaves a step, and a step that lands on
    // the finished edge itself comes out as a sawtooth along the strap.
    const lo = Math.max(armpit + 0.015, edge - 0.076);
    return 0.18 * THREE.MathUtils.smoothstep(y, lo, Math.max(lo + 0.015, edge - 0.030));
  };

  const shell = buildShell(body, {
    axis,
    from: (_u, a) => axis.sAtY(band(a)),
    to: (_u, a) => axis.sAtY(top(a)),
    // Compression knit: it flattens the bust rather than draping over it, so the
    // offset is thin and even and sits inside the ladder's first garment rung.
    offset: 0.0075,
    cloth: 0.0032,
    segments: 26,
    radial: 100,
    lining: 4,
    follow: TORSO,
    bridge,
    // A backstop, not a shape. Past the crown of the shoulder a radial ray finds
    // nothing and runs to the trace limit; this bounds the damage to a couple of
    // centimetres of overhang instead of a spike halfway to the camera.
    maxRadius: m.shoulderHalf + 0.022,
    fromEdge: { fold: 0.014, roll: 0.0052, rings: 4 },
    toEdge: { fold: 0.010, roll: 0.0040, rings: 3 },
    drape: { folds: 5, amplitude: 0.0004, along: 1.2, seed: 29 },
    tileMetres: tex.garments.bra.tileMetres * WEAVE,
  });
  attachGarment(rig, {
    name: 'bra',
    geometry: shell.geometry,
    kind: 'cloth',
    // Lifted off the authored dye. Under a four-band ramp the roster's teal lands
    // close enough to the black shorts that the two merge into one dark mass at
    // stage distance, and a bra that vanishes into the shorts loses the midriff.
    color: 0x235037,
    shadowColor: 0x0e2418,
    tex: tex.garments.bra,
    normalScale: 0.55,
    specular: 0.3,
  }, out);

  // Gold piping on both finished edges, plus the two princess seams the
  // reference draws down the back panel. Swept along the shell's own boundaries,
  // so they cannot drift off the edge they are trimming.
  const trimParts: THREE.BufferGeometry[] = [
    buildBand(shell.to, {
      width: 0.0074,
      thickness: 0.0028,
      lift: -0.0004,
      closed: true,
      sides: 8,
      tileMetres: tex.garments.trim.tileMetres * SATIN,
    }),
    buildBand(shell.from, {
      width: 0.0098,
      thickness: 0.0030,
      lift: -0.0004,
      closed: true,
      sides: 8,
      tileMetres: tex.garments.trim.tileMetres * SATIN,
    }),
  ];
  for (const seamDeg of [152, -152]) {
    const a = seamDeg * DEG;
    trimParts.push(
      buildBand(
        surfaceCurve(body, {
          axis,
          samples: 20,
          s: (t) => THREE.MathUtils.lerp(axis.sAtY(band(a) + 0.012), axis.sAtY(chest + 0.098), t),
          angle: () => a,
          offset: 0.0078,
          follow: TORSO,
        }),
        { width: 0.0042, thickness: 0.0022, sides: 6, tileMetres: tex.garments.trim.tileMetres * SATIN },
      ),
    );
  }
  attachGarment(rig, {
    name: 'braTrim',
    geometry: mergeGeometry(trimParts),
    kind: 'satin',
    color: 0xa17c18,
    shadowColor: 0x4e3a09,
    tex: tex.garments.trim,
    specular: 0.38,
    normalScale: 0.8,
    outlineWidth: 0.5,
  }, out);
}

// ---------------------------------------------------------------------------
// Hand and ankle wraps
// ---------------------------------------------------------------------------

/**
 * Red hand wraps and ankle wraps.
 *
 * A wrap is not a sleeve: what identifies it is that you can see where one turn
 * crosses the last. The shell supplies the mass, and every visible band on top
 * of it is a real swept ribbon at a slightly larger radius, so the overlap has a
 * lit edge and a shadow under it rather than being a stripe in a texture.
 */
function buildWraps(
  rig: BuiltCharacter,
  def: FighterDef,
  out: BuiltCostume,
  tex: ReturnType<typeof fighterTextures>,
): void {
  const body: GarmentBody = rig;
  const m = rig.metrics;
  const p = def.palette;
  const UP = new THREE.Vector3(0, 1, 0);
  const LEFT = new THREE.Vector3(1, 0, 0);

  const wrapPiece = (name: string, parts: THREE.BufferGeometry[], bind?: BoneName) => {
    attachGarment(rig, {
      name,
      geometry: mergeGeometry(parts),
      kind: 'wrap',
      color: p.wrap,
      shadowColor: 0x4a1009,
      tex: tex.wrap,
      normalScale: 1.25,
      specular: 0.16,
      outlineWidth: 0.9,
      bind,
    }, out);
  };

  // -------------------------------------------------------------- hand wraps --
  for (const side of ['L', 'R'] as const) {
    const axis = chainAxis(body, [`forearm${side}`, `hand${side}`] as BoneName[], 0.66);
    const follow = armOf(side);
    // Thick at the knuckles, thinner up the forearm — a wrap is built up in
    // layers over the striking surface and tapers out to a single turn at the top.
    const bulk = ramp([[0.5, 0.0], [0.62, 0.0009], [0.78, 0.0020], [0.9, 0.0026], [1, 0.0018]]);
    const shell = buildShell(body, {
      axis,
      from: 0.5,
      to: 0.95,
      offset: (s) => LAYER.skin + bulk(s),
      cloth: 0.0034,
      segments: 16,
      radial: 30,
      lining: 3,
      follow,
      fromEdge: { fold: 0.010, roll: 0.0040, rings: 3 },
      toEdge: { fold: 0.009, roll: 0.0042, rings: 3 },
      drape: { folds: 4, amplitude: 0.0008, along: 3.2, seed: 47 },
      tileMetres: tex.wrap.tileMetres * WEAVE,
    });

    const parts = [shell.geometry];
    // Two turns of opposite handedness across the back of the hand and the wrist:
    // the X they make is the single clearest read that this is tape and not a glove.
    for (const hand of [1, -1]) {
      parts.push(
        buildBand(
          surfaceCurve(body, {
            axis,
            samples: 56,
            s: (t) => THREE.MathUtils.lerp(0.6, 0.905, t),
            angle: (t) => hand * (t * 1.3 * Math.PI * 2 - 0.6),
            offset: (s) => LAYER.skin + bulk(s) + 0.0022,
            follow,
          }),
          { width: 0.012, thickness: 0.0032, sides: 8, tileMetres: tex.wrap.tileMetres * WEAVE },
        ),
      );
    }
    // The finishing turns: one at the wrist, one across the knuckles.
    for (const [station, width] of [[0.635, 0.017], [0.905, 0.015]] as [number, number][]) {
      parts.push(
        buildBand(
          surfaceCurve(body, {
            axis,
            samples: 30,
            s: () => station,
            angle: (t) => t * Math.PI * 2,
            offset: (s) => LAYER.skin + bulk(s) + 0.0026,
            follow,
          }),
          { width, thickness: 0.0034, closed: true, sides: 8, tileMetres: tex.wrap.tileMetres * WEAVE },
        ),
      );
    }
    wrapPiece(`handWrap${side}`, parts);
  }

  // ------------------------------------------------------------- ankle wraps --
  for (const side of ['L', 'R'] as const) {
    const shinAxis = chainAxis(body, [`shin${side}`, `foot${side}`] as BoneName[], 0);
    const follow = shinOf(side);
    const topY = m.ankleY + 0.098;
    const s0 = shinAxis.sAtY(topY);

    const shin = buildShell(body, {
      axis: shinAxis,
      from: s0,
      to: 1,
      offset: ramp([[s0, LAYER.skin], [(s0 + 1) * 0.5, LAYER.skin + 0.0026], [1, LAYER.skin + 0.0034]]),
      cloth: 0.0036,
      segments: 12,
      radial: 28,
      lining: 3,
      follow,
      fromEdge: { fold: 0.010, roll: 0.0044, rings: 3 },
      tileMetres: tex.wrap.tileMetres * WEAVE,
    });
    const shinParts = [shin.geometry];
    // Layered turns up the ankle. Wound from the same start in both directions so
    // they cross, rather than being one helix offset in phase.
    for (const hand of [1, -1]) {
      shinParts.push(
        buildBand(
          surfaceCurve(body, {
            axis: shinAxis,
            samples: 56,
            s: (t) => THREE.MathUtils.lerp(0.985, s0 + 0.012, t),
            angle: (t) => hand * (t * 1.25 * Math.PI * 2 + 0.4),
            offset: LAYER.skin + 0.0038,
            follow,
          }),
          { width: 0.014, thickness: 0.0038, sides: 8, tileMetres: tex.wrap.tileMetres * WEAVE },
        ),
      );
    }
    wrapPiece(`ankleWrap${side}`, shinParts, `shin${side}` as BoneName);

    // The instep. No ray from the shin axis reaches the top of the foot, so this
    // half of the wrap is traced from the foot's own axis with the angular frame
    // tipped on its side — up is "front" when the axis runs horizontally.
    const ankle = rig.joints[`foot${side}` as BoneName];
    const toe = rig.joints[`toe${side}` as BoneName];
    const FL = m.footLen;
    const footAxis = axisFromPoints([
      new THREE.Vector3(ankle.x, m.ankleY * 0.5, ankle.z - FL * 0.19),
      new THREE.Vector3(ankle.x, m.ankleY * 0.66, ankle.z - FL * 0.02),
      new THREE.Vector3((ankle.x + toe.x) * 0.5, m.ankleY * 0.58, ankle.z + FL * 0.16),
      new THREE.Vector3(toe.x, m.ankleY * 0.4, toe.z + FL * 0.02),
    ]);
    // Heel, arch and instep as one solid piece rather than a stack of straps: two
    // ribbons across the foot read as a sandal, which is exactly the wrong thing
    // to suggest about a barefoot fighter. The arc stops short of the sole, so
    // nothing shows the moment a kick turns the underside to camera.
    const instep = buildShell(body, {
      axis: footAxis,
      from: 0.0,
      to: 0.37,
      offset: LAYER.skin + 0.0018,
      cloth: 0.0036,
      segments: 12,
      radial: 26,
      lining: 3,
      arc: [-124 * DEG, 124 * DEG],
      closed: false,
      front: UP,
      left: LEFT,
      follow: footOf(side),
      keepSide: { normal: UP, d: 0.0015, softness: 0.0025 },
      toEdge: { fold: 0.010, roll: 0.0042, rings: 3 },
      tileMetres: tex.wrap.tileMetres * WEAVE,
    });
    const footParts: THREE.BufferGeometry[] = [
      instep.geometry,
      buildBand(
        surfaceCurve(body, {
          axis: footAxis,
          samples: 34,
          s: () => 0.27,
          angle: (t) => (-114 + t * 228) * DEG,
          offset: LAYER.skin + 0.0044,
          front: UP,
          left: LEFT,
          follow: footOf(side),
        }),
        { width: 0.018, thickness: 0.0038, sides: 8, tileMetres: tex.wrap.tileMetres * WEAVE },
      ),
    ];
    wrapPiece(`footWrap${side}`, footParts, `foot${side}` as BoneName);
  }
}
