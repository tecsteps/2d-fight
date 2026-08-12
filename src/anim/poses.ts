import type { Pose } from './contract';

/**
 * Art-directed standing poses — one per fighter.
 *
 * Reviews 001, 002 and 003 all landed on the same thing: four symmetric A-poses
 * with the arms dead at the sides and every head pitched at the floor. Review
 * 003 measured what that costs. Counting separate runs across the silhouette on
 * a horizontal slice, our fighters were **one solid run** at nearly every height
 * between the armpit and the hip, while the design sheets run three. A KOF XIII
 * sprite is not a filled outline, it is a shape with holes in it: air between a
 * forearm and the ribs, air between the thighs, a triangle under a raised elbow.
 * That negative space is most of what makes a fighter readable at 40 px, and no
 * amount of costume, hair or ink can add it — only the pose can.
 *
 * ## What every pose here has to carry
 *
 * 1. **A weight shift.** One leg owns the mass; the pelvis slides over it and
 *    tilts, and the ribcage counter-tilts. A figure standing evenly on two legs
 *    describes no weight at all, which is why criterion 5 has been stuck at 2.
 * 2. **A line of action** — a single readable curve from the grounded foot
 *    through the hip and up to the head, not a straight spine with limbs
 *    attached.
 * 3. **Arms carried off the ribs**, so daylight passes between arm and torso.
 *    One arm high and one low, deliberately: a symmetric guard puts *both* arms
 *    above 0.40H and leaves the whole lower torso a slab again.
 * 4. **The head up, on the eyeline**, turned back toward the viewer. The faces
 *    were invisible for three reviews because every chin was on the chest.
 *
 * ## Reading the numbers
 *
 * Authored in degrees and converted once, because a pose is a drawing note and
 * `-18` is a note where `-0.3141` is not. Axis conventions come from the rig
 * (see the header of `Skeleton.ts`) and hold because rest rotations are
 * identity:
 *
 * - **X** swings a hanging limb: negative forward, positive back. A knee flexes
 *   on **+X** at the shin, an elbow on **−X** at the forearm.
 * - **Z** is abduction: positive lifts the character's **left** limb away from
 *   the body and pulls the **right** one in. The two sides therefore mirror in
 *   sign, and every `R` bone below reads with the sign flipped from its `L`.
 * - **Y** is twist, and on the spine chain it is the body's turn to camera.
 *
 * The lineup yaws each fighter 0.42 rad, so the character's **right** side is
 * the near side and their left is the far side. `root.rot[1]` trims that per
 * fighter — Vera squares up to the viewer, Davi turns further away — which is a
 * character read, so it lives here and not in the scene file.
 *
 * Verify with `tools/critic/runs.py` on a matte capture: at least two runs at
 * 0.35H, 0.42H and 0.50H on every fighter, which is what the reference sheets'
 * own standing poses measure.
 */

const D = Math.PI / 180;

/** Degrees in, rig radians out. */
function r(x: number, y: number, z: number): [number, number, number] {
  return [x * D, y * D, z * D];
}

/**
 * Kai — calm and centred.
 *
 * The one fighter who is not going anywhere. Both feet are flat and the base is
 * wide and even, weight only just favouring the rear leg; the whole read comes
 * from the vertical: a long straight line from the rear heel through a lifted
 * chest to a level chin. The near hand is carried up in a loose vertical
 * knife-hand at the sternum and the far arm hangs open and pushed off the hip,
 * so the two silhouette holes sit at different heights and the figure never
 * closes into a column. Reference: `kai/07-high-hand-ready-stance.jpg`, calmed
 * down out of the guard.
 */
const KAI_STANDING: Pose = {
  root: { rot: r(0, -6, 0) },

  hips: { rot: r(-2, -6, -4), pos: [-0.022, -0.03, 0] },
  spine: { rot: r(2, 5, 3) },
  chest: { rot: r(-4, 7, 3) },
  neck: { rot: r(1, -9, -2) },
  head: { rot: r(-1, -17, -3) },

  // Far arm: hanging, but levered off the hip at the shoulder and brought back
  // under itself at the elbow. Abducting the humerus is the whole point — the
  // hole the silhouette needs is under the armpit, and a wide *hand* with the
  // biceps still on the ribs buys nothing above 0.42H.
  shoulderL: { rot: r(0, -2, 5) },
  upperArmL: { rot: r(2, 4, 21) },
  forearmL: { rot: r(-18, 0, -16) },
  handL: { rot: r(-6, 0, -6) },

  // Near arm: elbow dropped and slightly forward, forearm up the centre line —
  // a karate ready hand, not a boxer's guard.
  shoulderR: { rot: r(0, 6, -4) },
  upperArmR: { rot: r(-16, 0, -22) },
  forearmR: { rot: r(-98, -14, 4) },
  handR: { rot: r(-12, 0, 0) },

  // Base wide and flat, lead foot turned out. `footX = -(hips.x + thigh.x +
  // shin.x)` is what keeps a sole flat under a bent knee; every leg below solves
  // that, and the deliberate exceptions are commented where they occur.
  thighL: { rot: r(-10, 10, 20) },
  shinL: { rot: r(16, 0, 0) },
  footL: { rot: r(-4, 16, -6) },
  thighR: { rot: r(6, -10, -20) },
  shinR: { rot: r(10, 0, 0) },
  footR: { rot: r(-14, -12, 6) },
};

/**
 * Mali — compact and coiled.
 *
 * Everything is pulled in and loaded: hips square over a short base, rear heel
 * off the floor, both knees soft, shoulders up around a tucked chin. The guard
 * stays high because that is what eight limbs looks like, but the elbows are
 * carried *out* of the ribs rather than clamped to them, which is what turns a
 * tight guard into two triangles of daylight instead of one slab. Her lead hand
 * drops to the sternum so the silhouette still breaks below the ribcage.
 * Reference: `mali/06-fighting-guard.jpg`.
 */
const MALI_STANDING: Pose = {
  root: { rot: r(0, 5, 0) },

  hips: { rot: r(-3, 6, 5), pos: [0.02, -0.045, 0.01] },
  spine: { rot: r(4, -3, -4) },
  chest: { rot: r(-2, -6, -3) },
  neck: { rot: r(6, -8, 2) },
  head: { rot: r(-7, -20, 2) },

  // Lead (far) arm long: the Thai check hand, elbow forward and hand dropped to
  // sternum height. It is also the only mass this pose has outboard of the ribs
  // below the elbow — two hands at the cheeks would put the entire guard above
  // 0.40H and hand the lower torso straight back to the slab.
  shoulderL: { rot: r(0, -8, 8) },
  upperArmL: { rot: r(-40, -8, 20) },
  forearmL: { rot: r(-50, 8, -12) },
  handL: { rot: r(-16, 0, -6) },

  // Rear (near) arm: hand at the cheek, elbow carried out of the ribs rather
  // than clamped to them.
  shoulderR: { rot: r(0, 5, -9) },
  upperArmR: { rot: r(-12, 2, -26) },
  forearmR: { rot: r(-116, -16, 6) },
  handR: { rot: r(-16, 0, 0) },

  thighL: { rot: r(-14, 10, 16) },
  shinL: { rot: r(20, 0, 0) },
  footL: { rot: r(-3, 12, -4) },
  // Rear leg loaded on the ball of the foot — the heel lifts, so this foot
  // breaks the flat-sole rule on purpose and plantarflexes instead.
  thighR: { rot: r(8, -10, -16) },
  shinR: { rot: r(22, 0, 0) },
  footR: { rot: r(-7, -10, 4) },
};

/**
 * Davi — loose and ready to move.
 *
 * The ginga, caught at the end of a sway: all the weight on the rear leg, the
 * lead foot forward and barely touching, hips swung out past the support ankle
 * and the ribcage thrown the other way. He is the only fighter here whose line
 * of action is a full S, and the longest limbs on the roster are what sell it —
 * one arm swept up across the head, the other trailing low and behind, so the
 * silhouette reads as a diagonal rather than a stack. Reference:
 * `davi/07-high-hand-ready-stance.jpg`.
 */
const DAVI_STANDING: Pose = {
  root: { rot: r(0, 8, 0) },

  hips: { rot: r(-4, 12, 9), pos: [0.045, -0.04, 0] },
  spine: { rot: r(3, -5, -7) },
  chest: { rot: r(-6, -9, -6) },
  neck: { rot: r(5, -10, -4) },
  head: { rot: r(-1, -14, -5) },

  // Far arm swept up and across — the capoeira guard hand that shields the head
  // while the body sways under it.
  shoulderL: { rot: r(0, -8, 10) },
  upperArmL: { rot: r(-40, -14, 34) },
  forearmL: { rot: r(-104, 16, -10) },
  handL: { rot: r(-12, 0, -8) },

  // Near arm trails low and back, wrist loose. The gap it opens against the hip
  // is the only thing keeping the lower half from closing into one tube.
  shoulderR: { rot: r(0, -5, -6) },
  upperArmR: { rot: r(14, 6, -26) },
  forearmR: { rot: r(-30, -8, -12) },
  handR: { rot: r(-6, 0, -10) },

  // Lead leg long and light on a flat foot; the support leg carries everything,
  // which is what lets the hips swing this far past the support ankle.
  thighL: { rot: r(-16, 12, 16) },
  shinL: { rot: r(14, 0, 0) },
  footL: { rot: r(6, 14, -6) },
  thighR: { rot: r(8, -10, -16) },
  shinR: { rot: r(12, 0, 0) },
  footR: { rot: r(-16, -10, 6) },
};

/**
 * Vera — plants and squares up.
 *
 * The grappler does not angle away from you, she turns her chest at you and
 * waits, which is why her root untwists most of the lineup's yaw. Feet wide and
 * flat, knees pushed out over them, both hands open and carried well off the
 * body at clinch height — a grappler's hands are for catching, not for punching,
 * and holding them out is what makes her arms read as arms instead of as part of
 * the vest. Chin down, eyes up. Reference: `vera/06-fighting-guard.jpg`.
 */
const VERA_STANDING: Pose = {
  root: { rot: r(0, -15, 0) },

  hips: { rot: r(-2, -4, 5), pos: [0.028, -0.05, 0] },
  spine: { rot: r(3, 2, -4) },
  chest: { rot: r(-5, 3, -3) },
  neck: { rot: r(8, -3, 2) },
  head: { rot: r(-8, -6, 2) },

  // Hands low, open and well off the body: a catch wrestler's hands are for
  // catching, and carrying them at waist height is also the only place they can
  // sit and still break the silhouette at 0.42–0.50H, which a chest-high guard
  // leaves solid.
  shoulderL: { rot: r(0, -7, 10) },
  upperArmL: { rot: r(-14, -8, 28) },
  forearmL: { rot: r(-48, 12, -14) },
  handL: { rot: r(-14, 0, -8) },

  shoulderR: { rot: r(0, 8, -11) },
  upperArmR: { rot: r(-10, 8, -32) },
  forearmR: { rot: r(-38, -12, 14) },
  handR: { rot: r(-14, 0, 8) },

  thighL: { rot: r(-6, 16, 24) },
  shinL: { rot: r(14, 0, 0) },
  footL: { rot: r(-6, 16, -6) },
  thighR: { rot: r(-2, -16, -24) },
  shinR: { rot: r(14, 0, 0) },
  footR: { rot: r(-10, -14, 6) },
};

const STANDING: Record<string, Pose> = {
  kai: KAI_STANDING,
  mali: MALI_STANDING,
  davi: DAVI_STANDING,
  vera: VERA_STANDING,
};

/**
 * The character-select standing pose for a fighter.
 *
 * Falls back to Kai's, which is the most neutral of the four, so a fighter added
 * to the roster before their pose is authored still stands like a fighter.
 */
export function standingPose(id: string): Pose {
  return STANDING[id] ?? KAI_STANDING;
}

export { KAI_STANDING, MALI_STANDING, DAVI_STANDING, VERA_STANDING };
