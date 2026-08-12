import { Btn, type MotionSpec } from '../../core/Input';
import type { BoxTuple, FrameBoxes } from '../../engine/Boxes';
import {
  AttackTier,
  GuardKind,
  Invuln,
  MoveType,
  PhysicsMode,
  Reaction,
  StateType,
  type CommandDef,
  type StateDef,
} from '../../engine/contract';
import type { Fighter } from '../../engine/Fighter';
import { JUMP_ARC } from '../../engine/Physics';
import type { FighterDef } from '../roster';
import {
  CANCEL,
  PUSH_AIR,
  PUSH_CROUCH,
  PUSH_STAND,
  REF_HEIGHT,
  S,
  attackState,
  hurtAir,
  hurtCrouch,
  hurtLying,
  hurtStand,
  inv,
  mkThrow,
} from './build';
import {
  COST_GUARD_CANCEL,
  COST_HD,
  GETUP_FRAMES,
  GETUP_INVULN,
  GUARD_CRUSH_FRAMES,
  KNOCKDOWN_FRAMES,
  THROW_TECH_WINDOW,
  UKEMI_WINDOW,
} from './tuning';

/**
 * The states and commands every fighter has.
 *
 * This is the KOF chassis: walk, run, backstep, three jump arcs, rolls, guard,
 * the universal CD blowback attack, throws with a break, guard cancels, HD
 * activation, and the whole hit-reaction and knockdown chain. A character file
 * only has to add their normals and specials on top.
 *
 * Movement states run on `PhysicsMode.None` and write their own velocity, so a
 * walk speed authored in the roster is the speed the character actually moves —
 * friction is for knockback, not for locomotion.
 */

/** Double-tap motions. KOF runs and backsteps rather than dashing. */
const DASH_FWD: MotionSpec = { beats: [6, 5, 6], slack: 7, window: 16 };
const DASH_BACK: MotionSpec = { beats: [4, 5, 4], slack: 7, window: 16 };

const UP_DIRS = [7, 8, 9];
const DOWN_DIRS = [1, 2, 3];

function isUp(d: number): boolean {
  return UP_DIRS.indexOf(d) >= 0;
}
function isDown(d: number): boolean {
  return DOWN_DIRS.indexOf(d) >= 0;
}
function isBack(d: number): boolean {
  return d === 4 || d === 1 || d === 7;
}

function scaleBox(b: BoxTuple, s: number): BoxTuple {
  return [b[0] * s, b[1] * s, b[2] * s, b[3] * s];
}
function scaleAll(bs: readonly BoxTuple[], s: number): BoxTuple[] {
  return bs.map((b) => scaleBox(b, s));
}

interface StateOpts {
  id: number;
  name: string;
  anim: string;
  type?: StateType;
  moveType?: MoveType;
  physics?: PhysicsMode;
  ctrl?: boolean;
  duration?: number;
  next?: number;
  landState?: number;
  turnable?: boolean;
  boxes?: readonly FrameBoxes[];
  invuln?: StateDef['invuln'];
  enterVel?: readonly [number, number];
  onEnter?: StateDef['onEnter'];
  onTick?: StateDef['onTick'];
  onExit?: StateDef['onExit'];
}

function mk(o: StateOpts): StateDef {
  return {
    id: o.id,
    name: o.name,
    anim: o.anim,
    type: o.type ?? StateType.Stand,
    moveType: o.moveType ?? MoveType.Idle,
    physics: o.physics ?? PhysicsMode.Stand,
    ctrl: o.ctrl ?? false,
    duration: o.duration ?? -1,
    next: o.next ?? S.STAND,
    landState: o.landState,
    turnable: o.turnable,
    boxes: o.boxes,
    invuln: o.invuln,
    enterVel: o.enterVel,
    onEnter: o.onEnter,
    onTick: o.onTick,
    onExit: o.onExit,
  };
}

/* ------------------------------------------------------------------ *
 * Shared behaviour
 * ------------------------------------------------------------------ */

/**
 * Guarding is passive, exactly as in KOF: holding back while the opponent is
 * committed to an attack puts you in the guard pose, and being hit there turns
 * into blockstun. There is no dedicated "block button" state to be locked into.
 */
function wantsGuard(f: Fighter): boolean {
  return isBack(f.input.dir) && f.opponent.moveType === MoveType.Attack;
}

/** The transitions available from any neutral grounded state. */
function groundNeutral(f: Fighter): boolean {
  const d = f.input.dir;
  if (isUp(d)) {
    f.sm.changeState(S.JUMP_START);
    return true;
  }
  if (isDown(d)) {
    f.sm.changeState(f.stateNo === S.CROUCH_IDLE ? S.CROUCH_IDLE : S.CROUCH_DOWN);
    return true;
  }
  if (wantsGuard(f)) {
    f.sm.changeState(S.GUARD_START);
    return true;
  }
  if (d === 6) {
    f.sm.changeState(S.WALK_FWD);
    return true;
  }
  if (d === 4) {
    f.sm.changeState(S.WALK_BACK);
    return true;
  }
  return false;
}

export function commonStates(def: FighterDef): StateDef[] {
  const h = def.proportions.height;
  const s = h / REF_HEIGHT;

  const stand: FrameBoxes[] = [{ from: 0, hurt: scaleAll(hurtStand(), s) }];
  const crouch: FrameBoxes[] = [{ from: 0, hurt: scaleAll(hurtCrouch(), s), push: scaleBox(PUSH_CROUCH, s) }];
  const air: FrameBoxes[] = [{ from: 0, hurt: scaleAll(hurtAir(), s), push: scaleBox(PUSH_AIR, s) }];
  const lying: FrameBoxes[] = [{ from: 0, hurt: scaleAll(hurtLying(), s), push: scaleBox([-0.4, 0, 0.4, 0.34], s) }];

  const throwRange = 0.82 * s;

  const states: StateDef[] = [
    /* -------- neutral -------- */
    mk({
      id: S.STAND, name: 'stand', anim: 'stand', ctrl: true, boxes: stand,
      onTick: (f) => {
        groundNeutral(f);
      },
    }),
    mk({
      id: S.WALK_FWD, name: 'walk-fwd', anim: 'walk-fwd', ctrl: true, boxes: stand,
      physics: PhysicsMode.None,
      onTick: (f) => {
        f.vx = f.facing * f.def.walkFwd;
        if (f.input.dir !== 6) {
          f.vx = 0;
          if (!groundNeutral(f)) f.sm.changeState(S.STAND);
        }
      },
    }),
    mk({
      id: S.WALK_BACK, name: 'walk-back', anim: 'walk-back', ctrl: true, boxes: stand,
      physics: PhysicsMode.None,
      onTick: (f) => {
        f.vx = -f.facing * f.def.walkBack;
        // Walking back into an incoming attack is the guard. Same input, and
        // that ambiguity is most of KOF's spacing game.
        if (wantsGuard(f)) {
          f.vx = 0;
          f.sm.changeState(S.GUARD_START);
          return;
        }
        if (f.input.dir !== 4) {
          f.vx = 0;
          if (!groundNeutral(f)) f.sm.changeState(S.STAND);
        }
      },
    }),
    mk({
      id: S.RUN, name: 'run', anim: 'run', ctrl: true, boxes: stand,
      physics: PhysicsMode.None,
      onTick: (f) => {
        f.vx = f.facing * f.def.runSpeed;
        const d = f.input.dir;
        if (isUp(d)) {
          f.sm.changeState(S.JUMP_START);
          return;
        }
        if (d !== 6 && d !== 3 && d !== 9) {
          f.vx = 0;
          f.sm.changeState(S.RUN_STOP);
        }
      },
    }),
    mk({ id: S.RUN_STOP, name: 'run-stop', anim: 'run-stop', duration: 6, next: S.STAND, boxes: stand }),

    /* -------- crouch -------- */
    mk({
      id: S.CROUCH_DOWN, name: 'crouch-down', anim: 'crouch-down', type: StateType.Crouch,
      physics: PhysicsMode.Crouch, duration: 3, next: S.CROUCH_IDLE, boxes: crouch, ctrl: true,
    }),
    mk({
      id: S.CROUCH_IDLE, name: 'crouch', anim: 'crouch', type: StateType.Crouch,
      physics: PhysicsMode.Crouch, ctrl: true, boxes: crouch,
      onTick: (f) => {
        if (!isDown(f.input.dir)) f.sm.changeState(S.CROUCH_UP);
        else if (wantsGuard(f)) f.sm.changeState(S.GUARD_CROUCH);
      },
    }),
    mk({
      id: S.CROUCH_UP, name: 'crouch-up', anim: 'crouch-up', type: StateType.Crouch,
      physics: PhysicsMode.Crouch, duration: 3, next: S.STAND, boxes: crouch, ctrl: true,
    }),

    /* -------- jumps -------- */
    mk({
      id: S.JUMP_START, name: 'prejump', anim: 'prejump', duration: 4, next: S.JUMP_UP,
      boxes: stand,
      onTick: (f) => {
        // Tap up for a short hop, hold it for a full jump. The whole KOF
        // neutral game lives in this one distinction.
        if (f.stateTime === 3) {
          f.jumpArc = f.input.heldDirFrames(8) >= 4 ? JUMP_ARC.full : JUMP_ARC.short;
        }
      },
    }),
    mk({
      id: S.JUMP_UP, name: 'jump-up', anim: 'jump-up', type: StateType.Air,
      physics: PhysicsMode.Air, ctrl: true, boxes: air, landState: S.LAND, turnable: false,
      onEnter: (f) => {
        f.vy = f.jumpVelocity();
        const d = f.input.dir;
        const drift = f.jumpArc === JUMP_ARC.short ? 0.78 : 1;
        if (d === 9) f.vx = f.facing * f.def.runSpeed * 0.86 * drift;
        else if (d === 7) f.vx = -f.facing * f.def.walkBack * 1.9 * drift;
        else f.vx = 0;
      },
      onTick: (f) => {
        if (f.vy <= 0) f.sm.changeState(S.JUMP_DOWN);
      },
    }),
    mk({
      id: S.JUMP_DOWN, name: 'jump-down', anim: 'jump-down', type: StateType.Air,
      physics: PhysicsMode.Air, ctrl: true, boxes: air, landState: S.LAND, turnable: false,
    }),
    mk({
      id: S.LAND, name: 'land', anim: 'land', duration: 4, next: S.STAND, boxes: stand,
      onEnter: (f) => {
        f.vx = 0;
        f.grantThrowProtection();
      },
    }),

    /* -------- backstep and rolls -------- */
    mk({
      id: S.BACKSTEP, name: 'backstep', anim: 'backstep', type: StateType.Air,
      physics: PhysicsMode.Air, boxes: air, landState: S.BACKSTEP_LAND, turnable: false,
      invuln: [inv(0, 7, Invuln.Strike | Invuln.Throw)],
      onEnter: (f) => {
        f.vx = -f.facing * f.def.walkBack * 3.4;
        f.vy = f.jumpVelocity(0.13);
      },
    }),
    mk({ id: S.BACKSTEP_LAND, name: 'backstep-land', anim: 'land', duration: 5, next: S.STAND, boxes: stand }),
    mk({
      id: S.ROLL_FWD, name: 'roll-fwd', anim: 'roll-fwd', duration: 28, next: S.STAND,
      physics: PhysicsMode.None, boxes: crouch, turnable: false,
      // The roll passes through strikes but not through throws, which is what
      // keeps it from being a universal escape.
      invuln: [inv(3, 20, Invuln.Strike | Invuln.Low)],
      onTick: (f) => {
        f.vx = f.stateTime < 22 ? f.facing * f.def.runSpeed * 1.06 : 0;
      },
    }),
    mk({
      id: S.ROLL_BACK, name: 'roll-back', anim: 'roll-back', duration: 28, next: S.STAND,
      physics: PhysicsMode.None, boxes: crouch, turnable: false,
      invuln: [inv(3, 20, Invuln.Strike | Invuln.Low)],
      onTick: (f) => {
        f.vx = f.stateTime < 22 ? -f.facing * f.def.runSpeed * 1.06 : 0;
      },
    }),

    /* -------- guard -------- */
    mk({
      id: S.GUARD_START, name: 'guard-start', anim: 'guard-stand', duration: 2,
      next: S.GUARD_STAND, ctrl: true, boxes: stand,
    }),
    mk({
      id: S.GUARD_STAND, name: 'guard-stand', anim: 'guard-stand', ctrl: true, boxes: stand,
      onTick: (f) => {
        if (isDown(f.input.dir)) {
          f.sm.changeState(S.GUARD_CROUCH);
          return;
        }
        if (!wantsGuard(f)) f.sm.changeState(S.GUARD_END);
      },
    }),
    mk({
      id: S.GUARD_CROUCH, name: 'guard-crouch', anim: 'guard-crouch', type: StateType.Crouch,
      physics: PhysicsMode.Crouch, ctrl: true, boxes: crouch,
      onTick: (f) => {
        if (!isDown(f.input.dir)) {
          f.sm.changeState(wantsGuard(f) ? S.GUARD_STAND : S.GUARD_END);
        } else if (!wantsGuard(f)) {
          f.sm.changeState(S.CROUCH_IDLE);
        }
      },
    }),
    mk({
      id: S.GUARD_AIR, name: 'guard-air', anim: 'guard-air', type: StateType.Air,
      physics: PhysicsMode.Air, ctrl: true, boxes: air, landState: S.LAND, turnable: false,
    }),
    mk({ id: S.GUARD_END, name: 'guard-end', anim: 'guard-end', duration: 4, next: S.STAND, boxes: stand }),

    mk({
      id: S.GUARDHIT_STAND, name: 'blockstun', anim: 'guard-hit', boxes: stand,
      onTick: (f) => {
        if (f.blockstun <= 0) f.sm.changeState(wantsGuard(f) ? S.GUARD_STAND : S.GUARD_END);
      },
    }),
    mk({
      id: S.GUARDHIT_CROUCH, name: 'blockstun-crouch', anim: 'guard-hit-crouch',
      type: StateType.Crouch, physics: PhysicsMode.Crouch, boxes: crouch,
      onTick: (f) => {
        if (f.blockstun <= 0) f.sm.changeState(isDown(f.input.dir) ? S.GUARD_CROUCH : S.GUARD_END);
      },
    }),
    mk({
      id: S.GUARDHIT_AIR, name: 'blockstun-air', anim: 'guard-hit-air', type: StateType.Air,
      physics: PhysicsMode.Air, boxes: air, landState: S.LAND, turnable: false,
      onTick: (f) => {
        if (f.blockstun <= 0) f.sm.changeState(S.GUARD_AIR);
      },
    }),
    mk({
      id: S.GUARD_CRUSH, name: 'guard-crush', anim: 'guard-crush', duration: GUARD_CRUSH_FRAMES,
      next: S.STAND, boxes: stand,
      onEnter: (f) => {
        f.vx = -f.facing * 0.03;
      },
    }),

    /* -------- hit reactions -------- */
    mk({
      id: S.HIT_STAND_L, name: 'hit-light', anim: 'hit-light', moveType: MoveType.BeingHit,
      boxes: stand,
      onTick: (f) => {
        if (f.hitstun <= 0) f.sm.changeState(S.STAND);
      },
    }),
    mk({
      id: S.HIT_STAND_H, name: 'hit-heavy', anim: 'hit-heavy', moveType: MoveType.BeingHit,
      boxes: stand,
      onTick: (f) => {
        if (f.hitstun <= 0) f.sm.changeState(S.STAND);
      },
    }),
    mk({
      id: S.HIT_CROUCH, name: 'hit-crouch', anim: 'hit-crouch', type: StateType.Crouch,
      physics: PhysicsMode.Crouch, moveType: MoveType.BeingHit, boxes: crouch,
      onTick: (f) => {
        if (f.hitstun <= 0) f.sm.changeState(S.CROUCH_IDLE);
      },
    }),
    mk({
      id: S.HIT_CRUMPLE, name: 'crumple', anim: 'crumple', moveType: MoveType.BeingHit,
      boxes: stand,
      onTick: (f) => {
        if (f.hitstun <= 0) f.sm.changeState(S.FALL);
      },
    }),
    mk({
      id: S.HIT_AIR, name: 'hit-air', anim: 'hit-air', type: StateType.Air,
      physics: PhysicsMode.Air, moveType: MoveType.BeingHit, boxes: air, turnable: false,
    }),
    mk({
      id: S.FALL, name: 'fall', anim: 'fall', type: StateType.Air, physics: PhysicsMode.Air,
      moveType: MoveType.BeingHit, boxes: air, turnable: false,
      onEnter: (f) => {
        if (f.vy < 0.02) f.vy = 0.06;
      },
    }),
    mk({
      id: S.DOWN_BOUNCE, name: 'down-bounce', anim: 'down-bounce', type: StateType.Lying,
      moveType: MoveType.BeingHit, duration: 6, next: S.LYING, boxes: lying,
      onEnter: (f) => {
        f.vx *= 0.3;
        f.vy = 0;
      },
    }),
    mk({
      id: S.LYING, name: 'lying', anim: 'lying', type: StateType.Lying, duration: KNOCKDOWN_FRAMES,
      next: S.GETUP, boxes: lying,
      onTick: (f) => {
        // Emergency roll: the recovery window is only open on the way down, so
        // it has to be pre-emptive rather than a reaction to the wake-up.
        if (f.stateTime < UKEMI_WINDOW && f.input.pressed(Btn.A, 1) && f.input.held(Btn.B)) {
          f.sm.changeState(S.UKEMI);
        }
      },
    }),
    mk({
      id: S.GETUP, name: 'getup', anim: 'getup', duration: GETUP_FRAMES, next: S.STAND,
      boxes: stand, invuln: [inv(0, GETUP_INVULN, Invuln.Full)],
      onEnter: (f) => {
        f.grantThrowProtection();
      },
    }),
    mk({
      id: S.UKEMI, name: 'ukemi', anim: 'roll-fwd', duration: 18, next: S.STAND,
      physics: PhysicsMode.None, boxes: crouch, invuln: [inv(0, 13, Invuln.Full)],
      onEnter: (f) => {
        f.grantThrowProtection();
      },
      onTick: (f) => {
        f.vx = f.stateTime < 13 ? -f.facing * f.def.runSpeed * 0.9 : 0;
      },
    }),
    mk({
      id: S.KO_FALL, name: 'ko-fall', anim: 'ko-fall', type: StateType.Air,
      physics: PhysicsMode.Air, moveType: MoveType.BeingHit, boxes: air, turnable: false,
      onEnter: (f) => {
        f.vy = Math.max(f.vy, 0.13);
      },
    }),
    mk({
      id: S.KO_LYING, name: 'ko-lying', anim: 'ko-lying', type: StateType.Lying, boxes: lying,
      onEnter: (f) => {
        f.vx *= 0.2;
      },
    }),

    /* -------- throws -------- */
    mk({
      id: S.THROW_TRY, name: 'throw-try', anim: 'throw-try', moveType: MoveType.Attack,
      duration: 15, next: S.STAND, boxes: stand, turnable: false,
    }),
    mk({
      id: S.THROW_HIT, name: 'throw-hit', anim: 'throw-hit', moveType: MoveType.Attack,
      physics: PhysicsMode.None, duration: 34, next: S.STAND, boxes: stand, turnable: false,
      onTick: (f) => {
        if (f.stateTime !== 17) return;
        // Release: the victim is launched away and takes the knockdown from
        // there, so the throw ends in the same okizeme as everything else.
        const v = f.opponent;
        v.bindTimer = 0;
        v.boundTo = -1;
        v.vx = -f.facing * 0.085;
        v.vy = 0.13;
        v.sm.changeState(S.FALL);
      },
    }),
    mk({
      id: S.THROWN, name: 'thrown', anim: 'thrown', physics: PhysicsMode.None,
      moveType: MoveType.BeingHit, duration: 40, next: S.FALL, boxes: stand, turnable: false,
    }),
    mk({
      id: S.THROW_TECH, name: 'throw-tech', anim: 'throw-tech', duration: 16, next: S.STAND,
      boxes: stand, invuln: [inv(0, 14, Invuln.Full)],
    }),

    /* -------- KOF system mechanics -------- */
    mk({
      id: S.HD_ACTIVATE, name: 'hd-activate', anim: 'hd-activate', duration: 14, next: S.STAND,
      boxes: stand,
      onEnter: (f) => {
        f.gauges.activateHD();
        f.vx = 0;
      },
    }),
    mk({
      id: S.GC_ROLL, name: 'guard-cancel-roll', anim: 'roll-fwd', duration: 28, next: S.STAND,
      physics: PhysicsMode.None, boxes: crouch, turnable: false,
      invuln: [inv(0, 22, Invuln.Full)],
      onTick: (f) => {
        f.vx = f.stateTime < 22 ? f.facing * f.def.runSpeed * 1.06 : 0;
      },
    }),

    mk({
      id: S.INTRO, name: 'intro', anim: 'intro', boxes: stand, turnable: false,
      onEnter: (f) => {
        f.noCommands = true;
      },
      onExit: (f) => {
        f.noCommands = false;
      },
    }),
    mk({ id: S.WIN, name: 'win', anim: 'win', boxes: stand, turnable: false }),
    mk({ id: S.LOSE, name: 'lose', anim: 'ko-lying', type: StateType.Lying, boxes: lying }),
  ];

  /* -------- the universal CD blowback attack --------
   * Every KOF character has it, it always knocks down, it is always
   * cancellable into a special or a jump, and it is the reason cornering
   * someone matters. */
  states.push(
    attackState(
      {
        id: S.BLOWBACK, name: 'blowback-cd', anim: 'blowback', stance: 'stand',
        startup: 13, active: 4, recovery: 21,
        hit: [[0.24, 0.62, 1.12, 1.42]],
        ext: [[0.2, 0.6, 1.02, 1.36]],
        cancel: CANCEL.heavy(),
        attack: {
          id: 700, name: 'Blowback Attack', grade: 'heavy', dmg: 80,
          reaction: Reaction.Blowback, juggleStart: 9, impact: 0.72,
          hitstop: 13, guardDamage: 105,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.AIR_BLOWBACK, name: 'air-blowback-cd', anim: 'blowback-air', stance: 'air',
        startup: 8, active: 5, recovery: 12, airborne: true, next: S.LAND,
        hit: [[0.18, 0.28, 1.0, 0.98]],
        ext: [[0.16, 0.3, 0.92, 0.94]],
        cancel: CANCEL.heavy(),
        attack: {
          id: 701, name: 'Air Blowback', grade: 'heavy', dmg: 74, guard: GuardKind.Overhead,
          reaction: Reaction.Blowback, juggleStart: 8, impact: 0.68,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.GC_BLOWBACK, name: 'guard-cancel-blowback', anim: 'blowback', stance: 'stand',
        startup: 9, active: 4, recovery: 24,
        hit: [[0.22, 0.6, 1.1, 1.4]],
        ext: [[0.2, 0.58, 1.0, 1.34]],
        cancel: CANCEL.locked(),
        invuln: [inv(0, 12, Invuln.Full)],
        attack: {
          id: 920, name: 'Guard Cancel Blowback', grade: 'heavy', dmg: 60,
          reaction: Reaction.Blowback, juggleStart: 6, impact: 0.7,
        },
      },
      h,
    ),
  );

  // Throw attempt carries the ThrowDef; `Combat` does the range check.
  const tryState = states.find((x) => x.id === S.THROW_TRY);
  if (tryState) {
    tryState.active = [{ from: 1, to: 2 }];
    tryState.throw = mkThrow({
      id: 800,
      name: 'Throw',
      range: throwRange,
      minY: -0.2,
      maxY: 0.35 * s,
      damage: Math.round(100 + def.weight * 22),
      execState: S.THROW_HIT,
      victimState: S.THROWN,
      techWindow: THROW_TECH_WINDOW,
      techable: true,
      hitstop: 12,
      powerHit: 90,
      powerTaken: 140,
      driveHit: 60,
      impact: 0.66,
    });
  }

  return states;
}

/* ------------------------------------------------------------------ *
 * Universal commands
 *
 * Priority order matters: the more specific input is tested first, so 6+C at
 * point-blank is a throw and the same C one step further out is a heavy punch.
 * ------------------------------------------------------------------ */

export function commonCommands(def: FighterDef): CommandDef[] {
  const throwReach = 0.86 * (def.proportions.height / REF_HEIGHT);
  return [
    // Guard cancels — the two ways out of a blockstring, both one stock.
    {
      name: 'gc-roll', buttons: Btn.A | Btn.B, state: S.GC_ROLL, priority: 96,
      require: { guardOnly: true, power: COST_GUARD_CANCEL },
    },
    {
      name: 'gc-blowback', buttons: Btn.C | Btn.D, state: S.GC_BLOWBACK, priority: 95,
      require: { guardOnly: true, power: COST_GUARD_CANCEL },
    },
    // HD activation. Costs the whole Drive gauge and nothing else.
    {
      name: 'hd', buttons: Btn.A | Btn.C, state: S.HD_ACTIVATE, priority: 70,
      require: { stance: 'ground', notHD: true, drive: COST_HD },
    },
    {
      name: 'throw', buttons: Btn.C, dir: 6, state: S.THROW_TRY, priority: 58,
      require: {
        stance: 'ground',
        test: (f) => f.toOpponent < throwReach && f.toOpponent > -0.2,
      },
    },
    {
      name: 'throw-back', buttons: Btn.C, dir: 4, state: S.THROW_TRY, priority: 57,
      require: {
        stance: 'ground',
        test: (f) => f.toOpponent < throwReach && f.toOpponent > -0.2,
      },
    },
    { name: 'air-cd', buttons: Btn.C | Btn.D, state: S.AIR_BLOWBACK, priority: 52, require: { stance: 'air' } },
    { name: 'cd', buttons: Btn.C | Btn.D, state: S.BLOWBACK, priority: 51, require: { stance: 'ground' } },
    // Rolls. Forward by default, backward when holding away.
    {
      name: 'roll-back', buttons: Btn.A | Btn.B, dir: 4, state: S.ROLL_BACK, priority: 50,
      require: { stance: 'ground' },
    },
    { name: 'roll', buttons: Btn.A | Btn.B, state: S.ROLL_FWD, priority: 49, require: { stance: 'ground' } },
    // Run and backstep are motions with no button at all.
    {
      name: 'run', motion: DASH_FWD, buttons: 0, state: S.RUN, priority: 20,
      require: { stance: 'ground', test: (f) => f.stateNo !== S.RUN },
    },
    {
      name: 'backstep', motion: DASH_BACK, buttons: 0, state: S.BACKSTEP, priority: 19,
      require: { stance: 'ground', test: (f) => f.stateNo !== S.BACKSTEP },
    },
  ];
}

/**
 * The fourteen normals, bound to buttons.
 *
 * Which one comes out is decided by the direction held, not by the state the
 * fighter is in: holding down turns every button into its crouching version,
 * which is what lets a chain run cr.B → cr.B → st.B without the player fighting
 * the state machine.
 */
export function normalCommands(): CommandDef[] {
  return [
    { name: 'j.C', buttons: Btn.C, state: S.JP_C, priority: 18, require: { stance: 'air' } },
    { name: 'j.D', buttons: Btn.D, state: S.JP_D, priority: 18, require: { stance: 'air' } },
    { name: 'j.A', buttons: Btn.A, state: S.JP_A, priority: 17, require: { stance: 'air' } },
    { name: 'j.B', buttons: Btn.B, state: S.JP_B, priority: 17, require: { stance: 'air' } },

    { name: 'cr.C', buttons: Btn.C, dir: 2, state: S.CR_C, priority: 15, require: { stance: 'ground' } },
    { name: 'cr.D', buttons: Btn.D, dir: 2, state: S.CR_D, priority: 15, require: { stance: 'ground' } },
    { name: 'cr.A', buttons: Btn.A, dir: 2, state: S.CR_A, priority: 14, require: { stance: 'ground' } },
    { name: 'cr.B', buttons: Btn.B, dir: 2, state: S.CR_B, priority: 14, require: { stance: 'ground' } },

    { name: 'st.C', buttons: Btn.C, state: S.ST_C, priority: 11, require: { stance: 'ground' } },
    { name: 'st.D', buttons: Btn.D, state: S.ST_D, priority: 11, require: { stance: 'ground' } },
    { name: 'st.A', buttons: Btn.A, state: S.ST_A, priority: 10, require: { stance: 'ground' } },
    { name: 'st.B', buttons: Btn.B, state: S.ST_B, priority: 10, require: { stance: 'ground' } },
  ];
}

export { PUSH_AIR, PUSH_CROUCH, PUSH_STAND, AttackTier };
