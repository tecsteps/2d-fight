import type { FighterDef } from '../data/roster';
import {
  AIR_DRAG,
  CORNER_PUSH_TRANSFER,
  FRICTION_CROUCH,
  FRICTION_FLOOR,
  FRICTION_STAND,
  GRAVITY,
  GROUND_Y,
  MAX_FALL,
  MAX_SEPARATION,
  STAGE_HALF_WIDTH,
} from '../data/moves/tuning';
import { PhysicsMode } from './contract';
import { overlaps, penetrationX, type AABB } from './Boxes';
import type { Fighter } from './Fighter';

/**
 * Movement, collision and knockback.
 *
 * A fighting game's physics is not a simulation of bodies, it is a set of rules
 * that make spacing legible. Three of them matter more than everything else:
 *
 * 1. **Gravity is per fighter.** Each character's jump apex is authored; their
 *    gravity comes from their weight, and their jump velocity is then whatever
 *    reaches that apex. So VERA and DAVI can both jump "two metres" while VERA
 *    gets there and back in 40 frames and DAVI floats for 49.
 * 2. **Bodies never overlap on the ground**, and separating them is symmetric —
 *    except against a wall, where the cornered fighter cannot give ground and
 *    the whole correction goes to the other one. That asymmetry *is* corner
 *    pressure.
 * 3. **The pair is leashed.** Two fighters can never be further apart than one
 *    screen, because the camera has to hold both.
 */

export interface StageBounds {
  /** Half the playfield width in metres; walls sit at ±halfWidth. */
  halfWidth: number;
  groundY: number;
}

export const DEFAULT_STAGE: StageBounds = {
  halfWidth: STAGE_HALF_WIDTH,
  groundY: GROUND_Y,
};

/** Downward acceleration in metres per frame². Heavier characters fall harder. */
export function gravityFor(def: FighterDef): number {
  return GRAVITY * def.weight;
}

/**
 * Initial vertical velocity that reaches `apexScale × jumpHeight`.
 * v = sqrt(2·g·h) — the one place in the engine where real physics is the
 * clearest way to express a design intent.
 */
export function jumpVelocityFor(def: FighterDef, apexScale = 1): number {
  return Math.sqrt(2 * gravityFor(def) * def.jumpHeight * apexScale);
}

/** KOF's three jump arcs. The short hop is the whole neutral game. */
export const JUMP_ARC = {
  short: 0.42,
  full: 1,
  super: 1.45,
} as const;

/**
 * Integrate one fighter for one frame.
 *
 * Order is fixed: accelerate, damp, move, resolve ground. Anything that reads
 * position after this sees the same frame's position, which is what makes the
 * combat pass symmetric.
 */
export function integrate(f: Fighter, stage: StageBounds): void {
  switch (f.physics) {
    case PhysicsMode.Air:
      f.vy -= f.gravity;
      if (f.vy < -MAX_FALL) f.vy = -MAX_FALL;
      f.vx *= AIR_DRAG;
      break;
    case PhysicsMode.Stand:
      f.vx *= FRICTION_STAND;
      if (Math.abs(f.vx) < FRICTION_FLOOR) f.vx = 0;
      f.vy = 0;
      break;
    case PhysicsMode.Crouch:
      f.vx *= FRICTION_CROUCH;
      if (Math.abs(f.vx) < FRICTION_FLOOR) f.vx = 0;
      f.vy = 0;
      break;
    case PhysicsMode.None:
      break;
  }

  f.x += f.vx;
  f.y += f.vy;

  if (f.physics !== PhysicsMode.Air && f.y !== stage.groundY) f.y = stage.groundY;

  clampToStage(f, stage);
}

/** Has this airborne fighter crossed the floor this frame? */
export function touchedGround(f: Fighter, stage: StageBounds): boolean {
  return f.physics === PhysicsMode.Air && f.y <= stage.groundY && f.vy <= 0;
}

export function snapToGround(f: Fighter, stage: StageBounds): void {
  f.y = stage.groundY;
  f.vy = 0;
}

export function clampToStage(f: Fighter, stage: StageBounds): void {
  const limit = stage.halfWidth - f.halfWidth;
  if (f.x < -limit) {
    f.x = -limit;
    if (f.vx < 0) f.vx = 0;
  } else if (f.x > limit) {
    f.x = limit;
    if (f.vx > 0) f.vx = 0;
  }
}

/** Is this fighter's back against a wall? The one fact corner pressure needs. */
export function isCornered(f: Fighter, stage: StageBounds): boolean {
  const limit = stage.halfWidth - f.halfWidth - 0.02;
  return f.facing === 1 ? f.x <= -limit : f.x >= limit;
}

export function atWall(f: Fighter, stage: StageBounds): boolean {
  const limit = stage.halfWidth - f.halfWidth - 0.02;
  return f.x <= -limit || f.x >= limit;
}

/**
 * Keep two push volumes from overlapping.
 *
 * Airborne fighters pass through each other in KOF, which is what makes
 * cross-ups possible, so only ground-vs-ground separates. When one of the two
 * is jammed against a wall the entire correction is applied to the other — that
 * is how a blocked string walks you into the corner.
 */
export function separate(a: Fighter, b: Fighter, stage: StageBounds): void {
  if (a.airborne && b.airborne) return;

  const boxA: AABB = a.pushWorld;
  const boxB: AABB = b.pushWorld;
  if (!overlaps(boxA, boxB)) return;

  const depth = penetrationX(boxA, boxB);
  if (depth <= 0) return;

  const dir = a.x <= b.x ? -1 : 1;
  const aStuck = a.airborne || wallBlocked(a, dir, stage);
  const bStuck = b.airborne || wallBlocked(b, -dir, stage);

  if (aStuck && bStuck) return;
  if (aStuck) {
    b.x -= dir * depth;
  } else if (bStuck) {
    a.x += dir * depth;
  } else {
    a.x += dir * depth * 0.5;
    b.x -= dir * depth * 0.5;
  }
  clampToStage(a, stage);
  clampToStage(b, stage);
}

function wallBlocked(f: Fighter, dir: number, stage: StageBounds): boolean {
  const limit = stage.halfWidth - f.halfWidth - 0.001;
  return dir < 0 ? f.x <= -limit : f.x >= limit;
}

/**
 * The leash: the pair may never be more than one screen apart. Whoever is
 * free to move gives ground; if both are free they split it.
 */
export function clampSeparation(a: Fighter, b: Fighter, stage: StageBounds): void {
  const d = b.x - a.x;
  const over = Math.abs(d) - MAX_SEPARATION;
  if (over <= 0) return;
  const s = Math.sign(d);
  const aFree = !wallBlocked(a, s, stage);
  const bFree = !wallBlocked(b, -s, stage);
  if (aFree && bFree) {
    a.x += s * over * 0.5;
    b.x -= s * over * 0.5;
  } else if (aFree) {
    a.x += s * over;
  } else if (bFree) {
    b.x -= s * over;
  }
  clampToStage(a, stage);
  clampToStage(b, stage);
}

/**
 * Knockback from a connected attack.
 *
 * `defenderVX` and `attackerPush` are magnitudes; direction comes from the
 * attacker's facing. When the defender's back is on the wall the push they
 * cannot take is handed to the attacker instead, so hitting a cornered opponent
 * walks *you* backwards — the corner-push rule every KOF blockstring is built
 * around.
 *
 * Both fighters can be on the receiving end of a knockback in the same tick,
 * because a trade is two hits landing at once. Pushback is therefore *claimed*
 * rather than assigned: the largest shove a fighter receives this tick wins,
 * whichever direction it was resolved in. Without that, whichever hit happened
 * to be applied second would decide, and a mirror trade would send one fighter
 * flying while the other barely moved.
 */
export function applyKnockback(
  attacker: Fighter,
  defender: Fighter,
  defenderVX: number,
  defenderVY: number,
  attackerPush: number,
  stage: StageBounds,
): void {
  const dir = attacker.facing;
  let selfPush = attackerPush;
  let defPush = defenderVX;

  const limit = stage.halfWidth - defender.halfWidth - 0.02;
  const pinned = dir > 0 ? defender.x >= limit : defender.x <= -limit;
  if (pinned) {
    // Whatever the wall refuses to absorb comes back through the attacker.
    selfPush += Math.abs(defenderVX) * CORNER_PUSH_TRANSFER;
    defPush = 0;
  }

  claimPush(defender, dir, defPush, defenderVY);
  claimPush(attacker, -dir, selfPush, 0);
}

/** Largest shove this tick wins, so simultaneous hits resolve symmetrically. */
function claimPush(f: Fighter, sign: number, mag: number, vy: number): void {
  if (mag < f.pushClaim) return;
  f.pushClaim = mag;
  f.vx = sign * mag;
  if (vy !== 0) f.vy = vy;
}

/** Instantaneous separation used by throw breaks and clashes. */
export function shoveApart(a: Fighter, b: Fighter, speed: number): void {
  const dir = a.x <= b.x ? -1 : 1;
  a.vx = dir * speed;
  b.vx = -dir * speed;
}
