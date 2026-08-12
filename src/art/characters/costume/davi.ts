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
  mergeGeometry,
  ramp,
  surfaceCurve,
  torsoAxis,
  type Axis,
  type Boundary,
  type BuiltCostume,
  type GarmentBody,
} from './garment';

/**
 * Davi — "Ginga Unbroken", capoeira regional.
 *
 * From `reference/davi/*.jpg`: a gold sleeveless cropped hoodie worn open over a
 * bare chest, its hood crushed flat against the upper back; loose cream abadá
 * trousers with a wide blue stripe down each outseam and blue knit ankle cuffs;
 * a braided blue cord belt knotted at the front with two tasselled ends; blue
 * hand wraps; barefoot.
 *
 * Two things here are not in Kai's outfit and are worth reading for:
 *
 * 1. **The open front is a boundary, not a cut.** The hoodie is one shell whose
 *    arc stops short of the sternum, and the diagonal lapel line is carved by
 *    the *hem* profile climbing to the collarbone over the last 35° of arc — so
 *    the whole front opening is a rolled hem rather than a raw edge, and it is
 *    finished on both panels for free.
 * 2. **The abadá's folds are keyed on the anatomical angle, not on `u`.** The
 *    blue stripe is a second shell over a 60° slice of the same leg, so its own
 *    arc parameter runs over a different interval; a fold field keyed on `u`
 *    would put the two surfaces out of phase and the stripe would sink into the
 *    trouser's valleys. Keyed on the angle both shells see the same
 *    displacement, stay exactly parallel, and the stripe can ride 3 mm proud
 *    instead of having to clear the fold depth.
 *
 * Layer ladder used here, innermost first:
 *   LAYER.skin  0.0035  hand wraps
 *   0.006–0.050         abadá (the ramp *is* the garment — see `legSlack`)
 *   +0.0030             leg stripe, sewn onto the abadá
 *   0.0195              ankle cuff, over the gathered trouser hem
 *   0.012–0.019         hoodie body
 *   0.023–0.063         hood, lying on the hoodie's back
 *   0.022               waistband
 *   0.031               cord belt
 */

const DEG = Math.PI / 180;

/** See `kai.ts`: the fabric library's tiles are authored coarse for their size. */
const WEAVE = 0.55;

const UP = new THREE.Vector3(0, 1, 0);

/** The trunk. Anything a torso garment should lie on, and nothing it should engulf. */
const TORSO = (b: BoneName): boolean =>
  b === 'hips' || b === 'spine' || b === 'chest' || b === 'neck' || b === 'shoulderL' || b === 'shoulderR';

const armOf = (side: 'L' | 'R') => (b: BoneName): boolean =>
  b === `upperArm${side}` || b === `forearm${side}` || b === `hand${side}`;

const shinOf = (side: 'L' | 'R') => (b: BoneName): boolean =>
  b === `shin${side}` || b === `foot${side}` || b === `toe${side}`;

/**
 * The abadá's fold field, in metres of radial displacement.
 *
 * Integer angular frequencies so it is exactly periodic around the leg — a
 * noise field would leave a crease down the outseam that never goes away, which
 * is precisely where the stripe has to lie flat. The phase drifts along the leg
 * (`t` inside the cosine) so the folds wander and break instead of running as
 * straight flutes from hip to ankle.
 *
 * The frequencies are kept low on purpose. Fold *slope* is what breaks a cel
 * ramp — a band drops out as a hard-edged blot once `2*PI*amplitude/wavelength`
 * gets large — and slope is amplitude over wavelength, so depth is cheap at k=3
 * and ruinous at k=12.
 */
function abadaFolds(seed: number): (t: number, angle: number) => number {
  const h = (n: number): number => {
    const x = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453;
    return (x - Math.floor(x)) * Math.PI * 2;
  };
  const p1 = h(1);
  const p2 = h(2);
  const p3 = h(3);
  const norm = 1 / 1.72;
  return (t, angle) =>
    norm *
    (Math.cos(3 * angle + p1 + Math.sin(t * 4.7 + p2) * 0.85) +
      0.5 * Math.cos(5 * angle + p2 - t * 3.1) +
      0.22 * Math.cos(9 * angle + p3 + Math.sin(t * 7.3) * 0.6));
}

/**
 * A cord's plies, as curves ready for `buildBand`.
 *
 * A belt cord drawn as one smooth tube reads as a garden hose. Two strands
 * wound around the same path give the chevron that says "braided" at a glance,
 * and cost one extra sweep. `twists` must be a whole number on a closed path or
 * the plies do not meet at the seam.
 */
function plies(path: Boundary, count: number, twists: number, radius: number): Boundary[] {
  const n = path.points.length;
  const out: Boundary[] = [];
  const T = new THREE.Vector3();
  const side = new THREE.Vector3();
  for (let ply = 0; ply < count; ply++) {
    const points: THREE.Vector3[] = [];
    const normals: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      T.subVectors(path.points[Math.min(n - 1, i + 1)], path.points[Math.max(0, i - 1)]);
      if (T.lengthSq() < 1e-12) T.set(0, -1, 0);
      T.normalize();
      const nrm = path.normals[i].clone().addScaledVector(T, -path.normals[i].dot(T)).normalize();
      side.crossVectors(T, nrm);
      const a = Math.PI * 2 * (twists * t + ply / count);
      points.push(
        path.points[i].clone().addScaledVector(nrm, Math.cos(a) * radius).addScaledVector(side, Math.sin(a) * radius),
      );
      // The ply's own outward direction, so its band rolls with the twist.
      normals.push(nrm.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a)).normalize());
    }
    out.push({ points, normals, u: path.u.slice(), angle: path.angle.slice() });
  }
  return out;
}

export function buildDaviCostume(rig: BuiltCharacter, def: FighterDef): BuiltCostume {
  const body: GarmentBody = rig;
  const m = rig.metrics;
  const tex = fighterTextures(def);
  const p = def.palette;
  const out = emptyCostume();

  const Y = (l: Parameters<typeof landmarkY>[1]) => landmarkY(m, l);

  const CREAM = p.secondary;
  const CREAM_SHADE = 0xa79c88;
  const BLUE = p.accent;
  const BLUE_SHADE = 0x11306c;

  // ------------------------------------------------------------------ abadá --
  // Capoeira trousers are cut wide and left wide: near-constant girth from the
  // hip to the low calf, then gathered hard into a knit cuff. That constant
  // girth over a leg that tapers is what makes them break silhouette — the
  // offset has to *grow* down the thigh just to hold the same width.
  const waistTopY = Y('hip') + 0.086;
  const waistLowY = Y('hip') + 0.026;
  const cuffLowY = m.ankleY + 0.115;
  const cuffHighY = m.ankleY + 0.176;

  const legSlack = ramp([
    [waistTopY, 0.008],
    [Y('hip'), 0.013],
    [Y('crotch') - 0.03, 0.025],
    [Y('midThigh'), 0.037],
    [Y('knee') + 0.05, 0.044],
    [Y('knee'), 0.045],
    [Y('calf'), 0.043],
    [cuffHighY + 0.055, 0.032],
    [cuffHighY, 0.013],
    [cuffLowY + 0.008, 0.006],
  ]);
  const foldAmp = ramp([
    [waistTopY, 0.0008],
    [Y('hip') - 0.03, 0.0040],
    [Y('midThigh'), 0.0068],
    [Y('knee'), 0.0075],
    [cuffHighY + 0.10, 0.0062],
    [cuffHighY + 0.02, 0.0020],
    [cuffLowY, 0.0006],
  ]);
  /**
   * How hard the inner face is flattened.
   *
   * Full at the crotch, where two 10 cm-radius tubes would otherwise inflate
   * straight through each other, and released by the knee, where the legs have
   * parted and the cloth is free to hang.
   */
  const innerSquash = ramp([
    [Y('knee'), 0.34],
    [Y('midThigh'), 0.62],
    [Y('crotch'), 0.94],
  ]);

  for (const side of ['L', 'R'] as const) {
    const sign = side === 'L' ? 1 : -1;
    const hip = rig.joints[`thigh${side}` as BoneName];
    // Starts above the hip joint so the trouser covers the pelvis and its raw
    // top edge can hide under the waistband.
    const axis = axisFromPoints([
      new THREE.Vector3(hip.x * 0.55, waistTopY + 0.03, hip.z),
      hip.clone(),
      rig.joints[`shin${side}` as BoneName].clone(),
      rig.joints[`foot${side}` as BoneName].clone(),
    ]);
    const topS = axis.sAtY(waistTopY);
    const hemS = axis.sAtY(cuffLowY + 0.010);
    const folds = abadaFolds(side === 'L' ? 17 : 23);
    // The angle pointing away from the other leg, in this shell's own frame.
    const outer = sign > 0 ? Math.PI / 2 : -Math.PI / 2;
    // Two coincident surfaces at the inseam fight for the same depth; a fraction
    // of a millimetre settles it without opening a visible seam.
    const bias = side === 'L' ? 0 : 0.0007;

    const cloth = (s: number, angle: number): number => {
      const y = axis.pointAt(s).y;
      const inward = Math.max(0, Math.cos(angle - outer + Math.PI));
      const squash = 1 - innerSquash(y) * inward ** 1.25;
      return legSlack(y) * squash + foldAmp(y) * folds(s, angle) * squash + bias;
    };

    /**
     * Ceiling on the traced radius for rays crossing the midline.
     *
     * Above the crotch the two thighs and the pelvis are one mass, so a ray
     * fired inward from a leg's axis does not stop at the inseam — it travels
     * straight through and exits on the *far* hip, sixteen centimetres away.
     * `keepSide` then folds every one of those samples back onto the sagittal
     * plane, and a hundred vertices landing on one plane is a fan with no
     * surface normal: the crease ink pass reads it as one enormous fold and
     * fills the fly and the seat with solid black. Stopping the ray at the
     * midline keeps the inseam a seam.
     */
    const midlineCap = (s: number, angle: number): number => {
      const inward = -Math.sin(angle) * sign;
      if (inward < 0.25) return 9;
      return (axis.pointAt(s).x * sign + 0.012) / inward;
    };

    const shell = buildShell(body, {
      axis,
      from: topS,
      to: hemS,
      offset: (s, _u, angle) => cloth(s, angle),
      cloth: CLOTH * 1.2,
      segments: 30,
      radial: 44,
      lining: 3,
      // The top edge lives under the waistband; a hem bead there would swell
      // straight into the layer above it.
      toEdge: { fold: 0.012, roll: 0.005, rings: 3 },
      maxRadius: (s, _u, angle) => midlineCap(s, angle),
      keepSide: { normal: new THREE.Vector3(sign, 0, 0), d: -0.004, softness: 0.008 },
      tileMetres: tex.garments.abada.tileMetres * WEAVE,
    });
    // Off the shadow map's receiving list, and this one is not cosmetic. The
    // seat of a loose trouser spans the gluteal cleft, so in the key's view it
    // sits behind a body that is casting — a correct shadow, but one that lands
    // on the highest-contrast cloth in the outfit at the resolution of a couple
    // of shadow texels, and cream at the bottom of a cel ramp is black. What you
    // get is a stair-stepped blot the size of a hand. Nothing else is casting
    // onto these shells that the ramp does not already describe.
    attachGarment(rig, {
      name: `abada${side}`,
      geometry: shell.geometry,
      kind: 'cloth',
      color: CREAM,
      shadowColor: CREAM_SHADE,
      tex: tex.garments.abada,
      normalScale: 0.85,
      specular: 0.16,
    }, out).receiveShadow = false;

    // The outseam stripe. Same axis, same fold field, same angle — so it is a
    // rigid 3 mm lift of the trouser surface and can never dip into it.
    const stripeHalf = 19 * DEG;
    const stripe = buildShell(body, {
      axis,
      from: axis.sAtY(waistLowY),
      to: axis.sAtY(cuffHighY - 0.004),
      offset: (s, _u, angle) => cloth(s, angle) + 0.0030,
      cloth: 0.0028,
      segments: 26,
      radial: 16,
      lining: 2,
      arc: [outer - stripeHalf, outer + stripeHalf],
      closed: false,
      fromEdge: { fold: 0.006, roll: 0.0026, rings: 3 },
      toEdge: { fold: 0.006, roll: 0.0026, rings: 3 },
      tileMetres: tex.garments.stripe.tileMetres * WEAVE,
    });
    attachGarment(rig, {
      name: `stripe${side}`,
      geometry: stripe.geometry,
      kind: 'cloth',
      color: BLUE,
      shadowColor: BLUE_SHADE,
      tex: tex.garments.stripe,
      normalScale: 0.9,
      specular: 0.22,
      outlineWidth: 0.55,
      // Rides 3 mm above the abadá, so it has to answer the shadow map the same
      // way or a stripe would light differently from the cloth it is sewn to.
    }, out).receiveShadow = false;

    // Knit ankle cuff. Rigid to the shin: the whole ring sits between the ankle
    // and the calf, one bone's motion is the truth for it, and binding it that
    // way skips the field-weight diffusion that dominates a costume build.
    const shinAxis = chainAxis(body, [`shin${side}`, `foot${side}`] as BoneName[], 0);
    const cuff = buildShell(body, {
      axis: shinAxis,
      from: shinAxis.sAtY(cuffHighY),
      to: shinAxis.sAtY(cuffLowY),
      offset: 0.0195,
      cloth: 0.0065,
      segments: 9,
      radial: 30,
      lining: 3,
      follow: shinOf(side),
      fromEdge: { fold: 0.010, roll: 0.0048, rings: 3 },
      toEdge: { fold: 0.010, roll: 0.0048, rings: 3 },
      tileMetres: tex.garments.cuffs.tileMetres * WEAVE,
    });
    attachGarment(rig, {
      name: `cuff${side}`,
      geometry: cuff.geometry,
      kind: 'cloth',
      color: BLUE,
      shadowColor: BLUE_SHADE,
      tex: tex.garments.cuffs,
      bind: `shin${side}` as BoneName,
      normalScale: 1.25,
      specular: 0.2,
      outlineWidth: 0.6,
    }, out);
  }

  // -------------------------------------------------------------- waistband --
  // Its lower edge sits *below* the trousers' top edge, so the raw edge it is
  // there to cover is genuinely covered rather than merely abutted.
  const waistAxis = torsoAxis(body, Y('hip') - 0.10, Y('navel') + 0.06);
  const waistband = buildShell(body, {
    axis: waistAxis,
    from: waistAxis.sAtY(waistLowY),
    to: waistAxis.sAtY(waistTopY),
    offset: 0.022,
    cloth: 0.006,
    segments: 8,
    radial: 46,
    lining: 3,
    follow: TORSO,
    fromEdge: { fold: 0.010, roll: 0.0046, rings: 3 },
    toEdge: { fold: 0.010, roll: 0.0046, rings: 3 },
    tileMetres: tex.garments.abada.tileMetres * WEAVE,
  });
  attachGarment(rig, {
    name: 'waistband',
    geometry: waistband.geometry,
    kind: 'cloth',
    color: CREAM,
    shadowColor: CREAM_SHADE,
    tex: tex.garments.abada,
    normalScale: 0.8,
    specular: 0.18,
  }, out);

  buildHoodie(rig, def, tex, out);
  buildCordBelt(rig, def, tex, out, waistAxis, waistTopY - 0.022);

  // -------------------------------------------------------------- handwraps --
  for (const side of ['L', 'R'] as const) {
    const axis = chainAxis(body, [`forearm${side}`, `hand${side}`] as BoneName[], 0.72);
    const shell = buildShell(body, {
      axis,
      from: 0.46,
      to: 0.90,
      offset: ramp([[0, LAYER.skin], [0.4, LAYER.skin + 0.0020], [1, LAYER.skin]]),
      cloth: 0.0034,
      segments: 15,
      radial: 28,
      lining: 3,
      follow: armOf(side),
      fromEdge: { fold: 0.010, roll: 0.0040, rings: 3 },
      toEdge: { fold: 0.009, roll: 0.0040, rings: 3 },
      drape: { folds: 4, amplitude: 0.0009, along: 3.5, seed: 43 },
      tileMetres: tex.wrap.tileMetres * WEAVE,
    });
    // The extra turn at the wrist. One band is all it takes for the wrap to stop
    // looking like a blue sock.
    const wristRing = surfaceCurve(body, {
      axis,
      samples: 34,
      s: (t) => 0.575 + Math.sin(t * Math.PI * 2) * 0.013,
      angle: (t) => t * Math.PI * 2,
      offset: LAYER.skin + 0.0034,
      follow: armOf(side),
    });
    attachGarment(rig, {
      name: `handWrap${side}`,
      geometry: mergeGeometry([
        shell.geometry,
        buildBand(wristRing, {
          width: 0.020,
          thickness: 0.0034,
          closed: true,
          sides: 8,
          tileMetres: tex.wrap.tileMetres * WEAVE,
        }),
      ]),
      kind: 'wrap',
      color: p.wrap,
      shadowColor: BLUE_SHADE,
      tex: tex.wrap,
      normalScale: 1.2,
    }, out);
  }

  return out;
}

/**
 * The cropped hoodie: body panel and hood.
 *
 * Worn open over bare skin, so it is a *base* layer on the trunk rather than
 * outerwear — the offsets are small and the piece hugs the ribs, which is what
 * lets the hood sit on top of it without either one having to be inflated.
 */
function buildHoodie(
  rig: BuiltCharacter,
  def: FighterDef,
  tex: ReturnType<typeof fighterTextures>,
  out: BuiltCostume,
): void {
  const body: GarmentBody = rig;
  const m = rig.metrics;
  const p = def.palette;
  const GOLD_SHADE = 0x8a5a0e;
  const Y = (l: Parameters<typeof landmarkY>[1]) => landmarkY(m, l);

  const armpitY = Y('armpit');
  const hemY = Y('navel');

  const axis = torsoAxis(body, Y('waist') - 0.10, m.neckBaseY + 0.10);

  /**
   * Where the arm stops being covered.
   *
   * A hanging arm is fused to the ribcage in the implicit body, so a garment
   * traced against the trunk alone is *buried inside the deltoid* from the
   * armpit up to the shoulder crest — and that is not a bug, it is the armhole:
   * the cloth reappears at exactly the height where this bridge grows enough to
   * reach the real arm surface and cap it. Moving the transition moves the
   * armhole seam, and Davi's is cut higher than a gi's, so it opens later.
   *
   * The ramp is deliberately long. Made short, the cloth spends a couple of
   * rings floating in the hollow above the clavicle instead of lying on
   * anything, and its underside shows there as a black wedge between the
   * shoulder and the panel; stretched over ten centimetres the same transition
   * happens deep in the armpit, where the arm covers it.
   */
  const bridge = (s: number): number =>
    0.15 * THREE.MathUtils.smoothstep(axis.pointAt(s).y, armpitY + 0.076, armpitY + 0.168);

  // The front opening. The arc stops 16° short of the sternum on each side, and
  // over the next 40° the hem climbs from the crop line to the collarbone —
  // which is the diagonal lapel edge, carried as a rolled hem rather than a cut.
  const GAP = 16 * DEG;
  const hem = edgeAtHeight(axis, [
    [16, m.neckBaseY - 0.088],
    [24, m.neckBaseY - 0.176],
    [34, hemY + 0.115],
    [42, hemY + 0.022],
    [50, hemY + 0.000],
    [66, hemY + 0.020],
    [92, hemY + 0.046],
    [120, hemY + 0.064],
    [180, hemY + 0.074],
    [-120, hemY + 0.064],
    [-92, hemY + 0.046],
    [-66, hemY + 0.020],
    [-50, hemY + 0.000],
    [-42, hemY + 0.022],
    [-34, hemY + 0.115],
    [-24, m.neckBaseY - 0.176],
    [-16, m.neckBaseY - 0.088],
  ]);
  /**
   * The shoulder seam and neckline.
   *
   * Away from the front it is authored well *above* the neck base, and that is
   * not slack: a radial sweep from a near-vertical axis is almost tangent to the
   * top of a shoulder, so an edge asked for at shoulder height lands out on the
   * deltoid and the piece reads as off-the-shoulder. Five centimetres higher and
   * the same rings wrap over the trapezius and close on the neck, which is where
   * a hoodie's shoulder seam actually sits.
   */
  const seam = edgeAtHeight(axis, [
    [16, m.neckBaseY - 0.046],
    [26, m.neckBaseY - 0.020],
    [42, m.neckBaseY + 0.012],
    [62, m.neckBaseY + 0.032],
    [84, m.neckBaseY + 0.040],
    [104, m.neckBaseY + 0.042],
    [132, m.neckBaseY + 0.050],
    [180, m.neckBaseY + 0.058],
    [-132, m.neckBaseY + 0.050],
    [-104, m.neckBaseY + 0.042],
    [-84, m.neckBaseY + 0.040],
    [-62, m.neckBaseY + 0.032],
    [-42, m.neckBaseY + 0.012],
    [-26, m.neckBaseY - 0.020],
    [-16, m.neckBaseY - 0.046],
  ]);
  // The two free panels hang off the chest instead of lying on it; the closed
  // back does not.
  const openFront = byAngle([
    [0, 0.007],
    [40, 0.006],
    [70, 0.002],
    [100, 0],
    [180, 0],
    [-100, 0],
    [-70, 0.002],
    [-40, 0.006],
  ]);
  const slack = ramp([
    [hemY, 0.019],
    [Y('lowRib'), 0.014],
    [Y('chest'), 0.012],
  ]);

  const shell = buildShell(body, {
    axis,
    from: hem,
    to: seam,
    offset: (s, _u, angle) => slack(axis.pointAt(s).y) + openFront(angle) * (1 - THREE.MathUtils.smoothstep(axis.pointAt(s).y, hemY + 0.10, Y('chest'))),
    cloth: CLOTH * 1.3,
    segments: 26,
    radial: 84,
    lining: 4,
    arc: [GAP, Math.PI * 2 - GAP],
    closed: false,
    follow: TORSO,
    bridge,
    fromEdge: { fold: 0.014, roll: 0.0052, rings: 3 },
    toEdge: { fold: 0.012, roll: 0.0048, rings: 3 },
    drape: { folds: 4, amplitude: 0.0026, along: 1.5, seed: 5, sag: 0.003 },
    tileMetres: tex.garments.hoodie.tileMetres * WEAVE,
  });
  attachGarment(rig, {
    name: 'hoodie',
    geometry: shell.geometry,
    kind: 'cloth',
    color: p.primary,
    shadowColor: GOLD_SHADE,
    tex: tex.garments.hoodie,
    normalScale: 0.95,
    specular: 0.1,
  }, out);

  // ------------------------------------------------------------------- hood --
  // A hood that has been pushed back is not a bag on the shoulders: it is a
  // flattened pouch lying on the upper back whose *opening* is the free edge, so
  // the boundary curving across the back is the hood's mouth, not a hem. It is
  // built low-edge-first for that reason — `from` is the opening, `to` is the
  // crushed fold standing up behind the neck.
  const hoodAxis = torsoAxis(body, Y('lowRib') - 0.08, m.neckBaseY + 0.16);
  const hoodOpen = edgeAtHeight(hoodAxis, [
    [96, m.neckBaseY - 0.072],
    [112, m.neckBaseY - 0.146],
    [140, m.neckBaseY - 0.232],
    [165, m.neckBaseY - 0.281],
    [180, m.neckBaseY - 0.290],
    [-165, m.neckBaseY - 0.281],
    [-140, m.neckBaseY - 0.232],
    [-112, m.neckBaseY - 0.146],
    [-96, m.neckBaseY - 0.072],
  ]);
  const hoodTop = edgeAtHeight(hoodAxis, [
    [96, m.neckBaseY + 0.034],
    [118, m.neckBaseY + 0.056],
    [150, m.neckBaseY + 0.068],
    [180, m.neckBaseY + 0.072],
    [-150, m.neckBaseY + 0.068],
    [-118, m.neckBaseY + 0.056],
    [-96, m.neckBaseY + 0.034],
  ]);
  // Swell: thin where it is pinned under its own seam at the shoulders, deepest
  // behind the neck where the crown of the hood folds over on itself.
  const hoodSwell = ramp([
    [m.neckBaseY - 0.30, 0.033],
    [m.neckBaseY - 0.20, 0.040],
    [m.neckBaseY - 0.10, 0.050],
    [m.neckBaseY - 0.01, 0.059],
    [m.neckBaseY + 0.07, 0.063],
  ]);
  const hoodTaper = byAngle([
    [96, 0.80],
    [116, 0.90],
    [145, 0.99],
    [180, 1.0],
    [-145, 0.99],
    [-116, 0.90],
    [-96, 0.80],
  ]);

  const hood = buildShell(body, {
    axis: hoodAxis,
    from: hoodOpen,
    to: hoodTop,
    offset: (s, _u, angle) => hoodSwell(hoodAxis.pointAt(s).y) * hoodTaper(angle),
    cloth: CLOTH * 1.6,
    segments: 22,
    radial: 44,
    lining: 3,
    arc: [96 * DEG, 264 * DEG],
    closed: false,
    follow: TORSO,
    fromEdge: { fold: 0.018, roll: 0.0072, rings: 4 },
    toEdge: { fold: 0.020, roll: 0.0090, rings: 4 },
    drape: { folds: 2, amplitude: 0.0030, along: 1.3, seed: 29 },
    tileMetres: tex.garments.hoodie.tileMetres * WEAVE,
  });

  // The drawstring casing, swept along the hood's own opening boundary so it
  // cannot drift off the edge it is trimming. Two rows of stitching on a real
  // hood; one raised band is what survives at fighting distance.
  const casing = buildBand(hood.from, {
    width: 0.020,
    thickness: CLOTH * 1.5,
    lift: -CLOTH * 0.4,
    sides: 10,
    tileMetres: tex.garments.hoodie.tileMetres * WEAVE,
  });

  attachGarment(rig, {
    name: 'hood',
    geometry: mergeGeometry([hood.geometry, casing]),
    kind: 'cloth',
    color: p.primary,
    shadowColor: GOLD_SHADE,
    tex: tex.garments.hoodie,
    normalScale: 0.95,
    specular: 0.1,
  }, out);
}

/**
 * The braided cord belt.
 *
 * One wrap of two-ply cord round the waistband, an overhand knot at the front
 * left of centre, and two tasselled ends. Everything past the wrap is rigid to
 * the hips: a tail hanging in front of a thigh is nearest to that thigh in the
 * body's field and would be skinned to it, so a step forward would swing the
 * knot with the leg.
 */
function buildCordBelt(
  rig: BuiltCharacter,
  def: FighterDef,
  tex: ReturnType<typeof fighterTextures>,
  out: BuiltCostume,
  axis: Axis,
  cordY: number,
): void {
  const body: GarmentBody = rig;
  const p = def.palette;
  const BLUE_SHADE = 0x11306c;
  const PLY = 0.0034;
  const cordTile = tex.garments.cuffs.tileMetres * WEAVE;
  const band = (curve: Boundary, closed: boolean) =>
    buildBand(curve, { width: PLY * 2.1, thickness: PLY * 2.1, sides: 8, closed, tileMetres: cordTile });

  // --- the wrap ------------------------------------------------------------
  const ringS = axis.sAtY(cordY);
  const ring = surfaceCurve(body, {
    axis,
    samples: 112,
    s: () => ringS,
    angle: (t) => t * Math.PI * 2,
    offset: 0.031,
    follow: TORSO,
  });
  attachGarment(rig, {
    name: 'cordWrap',
    geometry: mergeGeometry(plies(ring, 2, 26, PLY).map((c) => band(c, true))),
    kind: 'cloth',
    color: p.accent,
    shadowColor: BLUE_SHADE,
    tex: tex.garments.cuffs,
    normalScale: 1.1,
    specular: 0.26,
    outlineWidth: 0.7,
  }, out);

  // --- knot and tails ------------------------------------------------------
  const knotAngle = 14 * Math.PI / 180;
  const anchor = surfaceCurve(body, {
    axis,
    samples: 3,
    s: () => ringS,
    angle: () => knotAngle,
    offset: 0.031 + PLY * 2.2,
    follow: TORSO,
  });
  const knotP = anchor.points[1];
  const knotN = anchor.normals[1];
  const knotSide = new THREE.Vector3().crossVectors(UP, knotN).normalize();

  const parts: THREE.BufferGeometry[] = [];

  // The overhand itself: a short cord loop pulled tight across the wrap. Two
  // crossing passes are what a knot is at this distance.
  for (const [rx, ry, roll] of [[0.019, 0.014, 0.008], [0.010, 0.019, 0.006]] as [number, number, number][]) {
    const pts: THREE.Vector3[] = [];
    const nrm: THREE.Vector3[] = [];
    const n = 26;
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n;
      pts.push(
        knotP
          .clone()
          .addScaledVector(knotSide, Math.cos(a) * rx)
          .addScaledVector(UP, Math.sin(a) * ry)
          .addScaledVector(knotN, Math.cos(a * 2) * roll),
      );
      nrm.push(knotN.clone());
    }
    const loop: Boundary = { points: pts, normals: nrm, u: pts.map((_, i) => i / n), angle: pts.map(() => 0) };
    for (const ply of plies(loop, 2, 8, PLY)) parts.push(band(ply, true));
  }

  // Two ends, different lengths and different lateral bias — two tails baked
  // from the same parameters hang as mirror images and the eye catches it.
  const tails: { len: number; bias: number; seed: number; flutter: number }[] = [
    { len: 0.235, bias: 0.30, seed: 12, flutter: 0.016 },
    { len: 0.150, bias: -0.55, seed: 27, flutter: 0.011 },
  ];
  for (const t of tails) {
    const start = knotP
      .clone()
      .addScaledVector(knotSide, t.bias * 0.020)
      .addScaledVector(UP, -0.017)
      .addScaledVector(knotN, -0.002);
    const path = bakeStrand(body, {
      from: start,
      dir: new THREE.Vector3(t.bias * 0.22, -1, 0.10).normalize(),
      length: t.len,
      segments: 20,
      stiffness: 0.55,
      bias: new THREE.Vector3(t.bias * 0.25, 0, 0.03),
      flutter: t.flutter,
      waves: 1.1,
      clearance: 0.016,
      seed: t.seed,
    });
    for (const ply of plies(path, 2, Math.round(t.len * 26), PLY)) parts.push(band(ply, false));

    // Tassel: a whipped head and a short fringe. The head is what stops the
    // fringe reading as the cord simply fraying into nothing.
    const tip = path.points[path.points.length - 1];
    const last = path.points[path.points.length - 2];
    const dir = tip.clone().sub(last).normalize();
    const lat = new THREE.Vector3().crossVectors(dir, knotN).normalize();
    const head: Boundary = {
      points: [tip.clone().addScaledVector(dir, -0.004), tip.clone().addScaledVector(dir, 0.010)],
      normals: [knotN.clone(), knotN.clone()],
      u: [0, 1],
      angle: [0, 0],
    };
    parts.push(buildBand(head, { width: 0.014, thickness: 0.014, sides: 10, tileMetres: cordTile }));
    const fringeRoot = tip.clone().addScaledVector(dir, 0.010);
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI * 2 * i) / 6 + t.seed;
      const spread = new THREE.Vector3()
        .addScaledVector(lat, Math.cos(a) * 0.010)
        .addScaledVector(knotN, Math.sin(a) * 0.010);
      const strand: Boundary = {
        points: [
          fringeRoot.clone(),
          fringeRoot.clone().addScaledVector(dir, 0.014).addScaledVector(spread, 0.5),
          fringeRoot.clone().addScaledVector(dir, 0.030).addScaledVector(spread, 1),
        ],
        normals: [knotN.clone(), knotN.clone(), knotN.clone()],
        u: [0, 0.5, 1],
        angle: [0, 0, 0],
      };
      parts.push(buildBand(strand, { width: 0.0045, thickness: 0.0045, sides: 6, tileMetres: cordTile }));
    }
  }

  attachGarment(rig, {
    name: 'cordKnot',
    geometry: mergeGeometry(parts),
    kind: 'cloth',
    color: p.accent,
    shadowColor: BLUE_SHADE,
    tex: tex.garments.cuffs,
    bind: 'hips',
    normalScale: 1.1,
    specular: 0.26,
    outlineWidth: 0.7,
  }, out);
}
