import type { BoxTuple, FrameBoxes } from '../../engine/Boxes';
import {
  AttackTier,
  GuardKind,
  Invuln,
  MoveType,
  PhysicsMode,
  Reaction,
  StateType,
  type AttackDef,
  type CancelRule,
  type FrameWindow,
  type InvulnWindow,
  type StateDef,
  type ThrowDef,
} from '../../engine/contract';
import { POWER_PER_DAMAGE_DEALT, POWER_PER_DAMAGE_TAKEN } from './tuning';

/**
 * Authoring helpers for frame data.
 *
 * Every number a move needs is spelled out somewhere, but spelling all of them
 * out at every call site would bury the four or five that actually characterise
 * the move. So each attack declares its *grade* — light, heavy, special, super
 * — which supplies the stun/freeze/meter profile, and then overrides only what
 * makes it itself.
 *
 * ## Box authoring convention
 *
 * All box tuples in `src/data/moves` are authored **for a 1.75 m reference
 * fighter** and scaled by the real fighter's height when the move list is
 * built. That way DAVI's 1.83 m front kick genuinely out-ranges MALI's 1.71 m
 * one without anybody retyping coordinates, and a jab always lands at chin
 * height on whoever throws it.
 */

export const REF_HEIGHT = 1.75;

/**
 * Canonical state numbers.
 *
 * The layout follows M.U.G.E.N's so that anyone who has read a .cns file can
 * read this: 0-199 movement and guard, 200-699 normals, 700-999 command
 * normals and throws, 1000-2999 specials, 3000-3999 supers, 4000+ NeoMax,
 * 5000+ hit reactions.
 */
export const S = {
  STAND: 0,
  TURN: 5,
  CROUCH_DOWN: 10,
  CROUCH_IDLE: 11,
  CROUCH_UP: 12,
  WALK_FWD: 20,
  WALK_BACK: 21,
  JUMP_START: 40,
  JUMP_UP: 50,
  JUMP_DOWN: 52,
  LAND: 51,
  RUN: 100,
  RUN_STOP: 101,
  BACKSTEP: 105,
  BACKSTEP_LAND: 106,
  ROLL_FWD: 110,
  ROLL_BACK: 111,
  GUARD_START: 120,
  GUARD_STAND: 130,
  GUARD_CROUCH: 131,
  GUARD_AIR: 132,
  GUARD_END: 140,
  GUARDHIT_STAND: 150,
  GUARDHIT_CROUCH: 152,
  GUARDHIT_AIR: 155,

  ST_A: 200,
  ST_B: 210,
  ST_C: 220,
  ST_D: 230,
  CR_A: 400,
  CR_B: 410,
  CR_C: 420,
  CR_D: 430,
  JP_A: 600,
  JP_B: 610,
  JP_C: 620,
  JP_D: 630,

  BLOWBACK: 700,
  AIR_BLOWBACK: 701,
  CMD_1: 710,
  CMD_2: 720,

  THROW_TRY: 800,
  THROW_HIT: 810,
  THROWN: 820,
  THROW_TECH: 830,

  HD_ACTIVATE: 900,
  GC_ROLL: 910,
  GC_BLOWBACK: 920,

  SPECIAL_1: 1000,
  SPECIAL_1_EX: 1010,
  SPECIAL_2: 1100,
  SPECIAL_2_EX: 1110,
  SPECIAL_3: 1200,
  SPECIAL_3_EX: 1210,
  SPECIAL_4: 1300,
  SPECIAL_4_EX: 1310,
  SUPER: 3000,
  SUPER_MAX: 3010,
  NEOMAX: 4000,

  HIT_STAND_L: 5000,
  HIT_STAND_H: 5001,
  HIT_CROUCH: 5010,
  HIT_AIR: 5030,
  HIT_CRUMPLE: 5040,
  FALL: 5050,
  DOWN_BOUNCE: 5100,
  LYING: 5110,
  GETUP: 5120,
  UKEMI: 5140,
  KO_FALL: 5150,
  KO_LYING: 5160,
  GUARD_CRUSH: 5300,

  INTRO: 5900,
  WIN: 5910,
  LOSE: 5920,
} as const;


export type Grade = 'light' | 'medium' | 'heavy' | 'special' | 'ex' | 'super' | 'neomax';

interface GradeProfile {
  tier: AttackTier;
  hitstun: number;
  blockstun: number;
  hitstop: number;
  hitShake: number;
  guardDamage: number;
  chip: number;
  priority: number;
  impact: number;
  /** 0 means "derive from damage". */
  powerHit: number;
  driveHit: number;
  powerWhiff: number;
}

const GRADES: Record<Grade, GradeProfile> = {
  light: {
    tier: AttackTier.Normal, hitstun: 13, blockstun: 9, hitstop: 7, hitShake: 3,
    guardDamage: 26, chip: 0, priority: 1, impact: 0.22, powerHit: 0, driveHit: 22,
    powerWhiff: 4,
  },
  medium: {
    tier: AttackTier.Normal, hitstun: 16, blockstun: 11, hitstop: 9, hitShake: 4,
    guardDamage: 42, chip: 0, priority: 2, impact: 0.34, powerHit: 0, driveHit: 30,
    powerWhiff: 6,
  },
  heavy: {
    tier: AttackTier.Normal, hitstun: 19, blockstun: 14, hitstop: 11, hitShake: 5,
    guardDamage: 68, chip: 0, priority: 3, impact: 0.52, powerHit: 0, driveHit: 38,
    powerWhiff: 9,
  },
  special: {
    tier: AttackTier.Special, hitstun: 21, blockstun: 15, hitstop: 12, hitShake: 6,
    guardDamage: 92, chip: 0.06, priority: 4, impact: 0.62, powerHit: 0, driveHit: 52,
    // KOF pays for a whiffed special, which is why everybody throws fireballs
    // at nothing between rounds.
    powerWhiff: 55,
  },
  ex: {
    tier: AttackTier.EX, hitstun: 23, blockstun: 16, hitstop: 14, hitShake: 7,
    guardDamage: 120, chip: 0.07, priority: 6, impact: 0.74, powerHit: 18, driveHit: 26,
    powerWhiff: 0,
  },
  super: {
    tier: AttackTier.Super, hitstun: 27, blockstun: 18, hitstop: 18, hitShake: 9,
    guardDamage: 170, chip: 0.08, priority: 8, impact: 0.9, powerHit: 0, driveHit: 0,
    powerWhiff: 0,
  },
  neomax: {
    tier: AttackTier.NeoMax, hitstun: 32, blockstun: 20, hitstop: 22, hitShake: 12,
    guardDamage: 260, chip: 0.09, priority: 10, impact: 1.0, powerHit: 0, driveHit: 0,
    powerWhiff: 0,
  },
};

export interface AttackSpec {
  id: number;
  name: string;
  grade: Grade;
  dmg: number;
  tier?: AttackTier;
  guard?: GuardKind;
  reaction?: Reaction;
  airReaction?: Reaction;
  /** Facing-relative knockback on a grounded hit. */
  hitVel?: readonly [number, number];
  airHitVel?: readonly [number, number];
  guardVel?: readonly [number, number];
  selfPush?: number;
  selfPushGuard?: number;
  hitstun?: number;
  blockstun?: number;
  hitstop?: number;
  hitShake?: number;
  juggle?: number;
  juggleStart?: number;
  guardDamage?: number;
  chip?: number;
  priority?: number;
  hitInterval?: number;
  counterBonus?: number;
  noScaling?: boolean;
  impact?: number;
  powerHit?: number;
  powerWhiff?: number;
  driveHit?: number;
}

/** Reaction-driven default knockback, so a move only names it when it is unusual. */
const KNOCKBACK: Record<Reaction, { hit: [number, number]; air: [number, number] }> = {
  [Reaction.Light]: { hit: [-0.032, 0], air: [-0.05, 0.03] },
  [Reaction.Medium]: { hit: [-0.048, 0], air: [-0.062, 0.042] },
  [Reaction.Heavy]: { hit: [-0.07, 0], air: [-0.082, 0.058] },
  [Reaction.Trip]: { hit: [-0.055, 0.02], air: [-0.07, 0.02] },
  [Reaction.Launch]: { hit: [-0.05, 0.175], air: [-0.055, 0.16] },
  [Reaction.Blowback]: { hit: [-0.145, 0.105], air: [-0.155, 0.1] },
  [Reaction.Crumple]: { hit: [-0.012, 0], air: [-0.06, 0.05] },
  [Reaction.WallBounce]: { hit: [-0.185, 0.075], air: [-0.19, 0.07] },
  [Reaction.GroundBounce]: { hit: [-0.06, -0.16], air: [-0.07, -0.2] },
};

export function mkAttack(s: AttackSpec): AttackDef {
  const g = GRADES[s.grade];
  const reaction = s.reaction ?? (s.grade === 'light' ? Reaction.Light : Reaction.Medium);
  const kb = KNOCKBACK[reaction];
  const dmg = s.dmg;
  return {
    id: s.id,
    name: s.name,
    tier: s.tier ?? g.tier,
    guard: s.guard ?? GuardKind.Mid,
    damage: dmg,
    chip: s.chip ?? g.chip,
    hitstun: s.hitstun ?? g.hitstun,
    blockstun: s.blockstun ?? g.blockstun,
    hitstop: s.hitstop ?? g.hitstop,
    hitShake: s.hitShake ?? g.hitShake,
    hitVel: s.hitVel ?? kb.hit,
    airHitVel: s.airHitVel ?? kb.air,
    guardVel: s.guardVel ?? [(s.hitVel ?? kb.hit)[0] * 0.55, 0],
    selfPush: s.selfPush ?? Math.abs((s.hitVel ?? kb.hit)[0]) * 0.32,
    selfPushGuard: s.selfPushGuard ?? Math.abs((s.hitVel ?? kb.hit)[0]) * 0.5,
    reaction,
    airReaction: s.airReaction,
    juggle: s.juggle ?? 2,
    juggleStart: s.juggleStart ?? 0,
    guardDamage: s.guardDamage ?? g.guardDamage,
    powerHit: s.powerHit ?? (g.powerHit || Math.round(dmg * POWER_PER_DAMAGE_DEALT)),
    powerBlock: Math.round((s.powerHit ?? (g.powerHit || dmg * POWER_PER_DAMAGE_DEALT)) * 0.45),
    powerWhiff: s.powerWhiff ?? g.powerWhiff,
    powerTaken: Math.round(dmg * POWER_PER_DAMAGE_TAKEN),
    driveHit: s.driveHit ?? g.driveHit,
    driveBlock: Math.round((s.driveHit ?? g.driveHit) * 0.5),
    priority: s.priority ?? g.priority,
    hitInterval: s.hitInterval ?? 0,
    counterBonus: s.counterBonus ?? 1,
    noScaling: s.noScaling ?? false,
    impact: s.impact ?? g.impact,
  };
}

/* ---------------------------------------------------------------- *
 * Hurt volumes
 *
 * Three stacked boxes — legs, torso, head — is what a sprite fighter uses, and
 * it is what makes anti-airs and low pokes behave: the head box is what a
 * jumping heavy has to reach, and the crouch stack drops it out of range.
 * ---------------------------------------------------------------- */

export function hurtStand(): readonly BoxTuple[] {
  return [
    [-0.20, 0.0, 0.20, 0.76],
    [-0.25, 0.72, 0.26, 1.44],
    [-0.17, 1.4, 0.18, 1.75],
  ];
}

export function hurtCrouch(): readonly BoxTuple[] {
  return [
    [-0.28, 0.0, 0.28, 0.52],
    [-0.28, 0.48, 0.3, 1.12],
  ];
}

export function hurtAir(): readonly BoxTuple[] {
  return [
    [-0.26, 0.16, 0.28, 0.82],
    [-0.2, 0.78, 0.22, 1.16],
  ];
}

export function hurtLying(): readonly BoxTuple[] {
  return [[-0.52, 0.0, 0.52, 0.34]];
}

export const PUSH_STAND: BoxTuple = [-0.23, 0, 0.23, 1.75];
export const PUSH_CROUCH: BoxTuple = [-0.27, 0, 0.27, 1.12];
export const PUSH_AIR: BoxTuple = [-0.22, 0.1, 0.24, 1.2];

function baseHurt(stance: Stance): readonly BoxTuple[] {
  return stance === 'crouch' ? hurtCrouch() : stance === 'air' ? hurtAir() : hurtStand();
}

export type Stance = 'stand' | 'crouch' | 'air';

function scaleBox(b: BoxTuple, s: number): BoxTuple {
  return [b[0] * s, b[1] * s, b[2] * s, b[3] * s];
}

function scaleAll(bs: readonly BoxTuple[], s: number): BoxTuple[] {
  return bs.map((b) => scaleBox(b, s));
}

/* ---------------------------------------------------------------- *
 * Attacking states
 * ---------------------------------------------------------------- */

/** One live window of a move: when the hitbox opens, how long, and where. */
export interface HitWindow {
  start: number;
  len: number;
  hit: readonly BoxTuple[];
  /** Attack override for this window; multi-hit moves usually weaken later hits. */
  attack?: AttackDef;
}

export interface AttackStateSpec {
  id: number;
  name: string;
  anim: string;
  stance: Stance;
  attack: AttackSpec;
  /** Single-window shorthand. */
  startup?: number;
  active?: number;
  hit?: readonly BoxTuple[];
  /** Multi-window form; overrides the shorthand. */
  windows?: readonly HitWindow[];
  recovery: number;
  /** Extra hurt volume while the limb is committed. This is what makes whiffs punishable. */
  ext?: readonly BoxTuple[];
  /** Frame the extra hurt volume appears on. Defaults to the first startup frame. */
  extFrom?: number;
  cancel?: CancelRule;
  invuln?: readonly InvulnWindow[];
  enterVel?: readonly [number, number];
  /** Air moves fall through to a landing state instead of a fixed recovery. */
  airborne?: boolean;
  landState?: number;
  physics?: PhysicsMode;
  next?: number;
  onEnter?: StateDef['onEnter'];
  onTick?: StateDef['onTick'];
}

/**
 * Build an attacking state, scaled to the fighter's height.
 *
 * The box track is derived rather than authored: neutral volume during startup,
 * neutral + extended limb from the first active frame through recovery. Only
 * the hitbox itself needs hand placing.
 */
export function attackState(spec: AttackStateSpec, height: number): StateDef {
  const s = height / REF_HEIGHT;
  const stance = spec.stance;
  const base = scaleAll(baseHurt(stance), s);
  const ext = spec.ext ? scaleAll(spec.ext, s) : [];
  const withExt = ext.length ? [...base, ...ext] : base;

  const windows: HitWindow[] = spec.windows
    ? spec.windows.map((w) => ({ ...w, hit: scaleAll(w.hit, s) }))
    : [{ start: spec.startup ?? 4, len: spec.active ?? 3, hit: scaleAll(spec.hit ?? [], s) }];

  const track: FrameBoxes[] = [{ from: 0, hurt: base }];
  const extFrom = spec.extFrom ?? windows[0].start;
  if (ext.length && extFrom < windows[0].start) track.push({ from: extFrom, hurt: withExt });

  const active: FrameWindow[] = [];
  for (const w of windows) {
    track.push({ from: w.start, hurt: withExt, hit: w.hit });
    track.push({ from: w.start + w.len, hurt: withExt });
    active.push({ from: w.start, to: w.start + w.len - 1 });
  }
  track.sort((a, b) => a.from - b.from);

  const last = windows[windows.length - 1];
  const total = last.start + last.len + spec.recovery;

  const attack = mkAttack(spec.attack);
  // A move flagged `airborne` leaves the ground even though it is authored from
  // a standing stance — that is what a dragon punch is — so it takes air physics
  // and an air posture, and ends when it lands rather than on a frame count.
  const air = spec.airborne || stance === 'air';
  const st: StateDef = {
    id: spec.id,
    name: spec.name,
    type: air ? StateType.Air : stance === 'crouch' ? StateType.Crouch : StateType.Stand,
    moveType: MoveType.Attack,
    physics:
      spec.physics ?? (air ? PhysicsMode.Air : stance === 'crouch' ? PhysicsMode.Crouch : PhysicsMode.Stand),
    ctrl: false,
    duration: spec.airborne ? -1 : total,
    next: spec.next ?? (stance === 'crouch' ? S.CROUCH_IDLE : S.STAND),
    landState: spec.airborne ? (spec.landState ?? S.LAND) : undefined,
    anim: spec.anim,
    boxes: track,
    attack,
    active,
    cancel: spec.cancel,
    invuln: spec.invuln,
    enterVel: spec.enterVel,
    onEnter: spec.onEnter,
    onTick: spec.onTick,
  };
  if (windows.some((w) => w.attack)) st.windowAttacks = windows.map((w) => w.attack);
  return st;
}

/**
 * The fourteen slots every character fills.
 *
 * Naming the slot rather than the state number keeps a character file reading
 * like a frame-data table instead of a list of magic numbers, and guarantees
 * that j.C is always state 620 on everyone.
 */
const SLOTS = {
  stA: { id: S.ST_A, anim: 'st-a', stance: 'stand' },
  stB: { id: S.ST_B, anim: 'st-b', stance: 'stand' },
  stC: { id: S.ST_C, anim: 'st-c', stance: 'stand' },
  stD: { id: S.ST_D, anim: 'st-d', stance: 'stand' },
  crA: { id: S.CR_A, anim: 'cr-a', stance: 'crouch' },
  crB: { id: S.CR_B, anim: 'cr-b', stance: 'crouch' },
  crC: { id: S.CR_C, anim: 'cr-c', stance: 'crouch' },
  crD: { id: S.CR_D, anim: 'cr-d', stance: 'crouch' },
  jA: { id: S.JP_A, anim: 'j-a', stance: 'air' },
  jB: { id: S.JP_B, anim: 'j-b', stance: 'air' },
  jC: { id: S.JP_C, anim: 'j-c', stance: 'air' },
  jD: { id: S.JP_D, anim: 'j-d', stance: 'air' },
  cmd1: { id: S.CMD_1, anim: 'cmd-1', stance: 'stand' },
  cmd2: { id: S.CMD_2, anim: 'cmd-2', stance: 'stand' },
} as const satisfies Record<string, { id: number; anim: string; stance: Stance }>;

export type NormalSlot = keyof typeof SLOTS;

type NormalSpec = Omit<AttackStateSpec, 'id' | 'name' | 'anim' | 'stance'> & { name?: string };

/** Build one of the fourteen standard normals. */
export function normal(height: number, slot: NormalSlot, spec: NormalSpec): StateDef {
  const meta = SLOTS[slot];
  const air = meta.stance === 'air';
  return attackState(
    {
      ...spec,
      id: meta.id,
      name: spec.name ?? slot,
      anim: meta.anim,
      stance: meta.stance,
      airborne: spec.airborne ?? air,
      next: spec.next ?? (air ? S.LAND : undefined),
    },
    height,
  );
}

/**
 * A command grab: startup and recovery like a move, but the connect test is a
 * range check rather than a hitbox, and there is nothing to block.
 */
export interface GrabStateSpec {
  id: number;
  name: string;
  anim: string;
  startup: number;
  active: number;
  recovery: number;
  throw: ThrowDef;
  ext?: readonly BoxTuple[];
  invuln?: readonly InvulnWindow[];
  cancel?: CancelRule;
  enterVel?: readonly [number, number];
  onTick?: StateDef['onTick'];
}

export function grabState(spec: GrabStateSpec, height: number): StateDef {
  const s = height / REF_HEIGHT;
  const base = scaleAll(hurtStand(), s);
  const ext = spec.ext ? scaleAll(spec.ext, s) : [];
  const track: FrameBoxes[] = [{ from: 0, hurt: base }];
  if (ext.length) track.push({ from: spec.startup, hurt: [...base, ...ext] });
  return {
    id: spec.id,
    name: spec.name,
    type: StateType.Stand,
    moveType: MoveType.Attack,
    physics: PhysicsMode.Stand,
    ctrl: false,
    duration: spec.startup + spec.active + spec.recovery,
    next: S.STAND,
    anim: spec.anim,
    boxes: track,
    throw: spec.throw,
    active: [{ from: spec.startup, to: spec.startup + spec.active - 1 }],
    invuln: spec.invuln,
    cancel: spec.cancel ?? { onContact: AttackTier.None, onWhiff: AttackTier.None },
    enterVel: spec.enterVel,
    onTick: spec.onTick,
  };
}

/**
 * Cancel presets.
 *
 * The ladder is free in one direction only: a move may be cancelled into
 * anything strictly above it, once it has connected. Going sideways — special
 * into special, DM into NeoMax — is what the Drive gauge and HD mode are for,
 * so those presets leave the free tier empty and let `StateMachine` charge for
 * it.
 */
export const CANCEL = {
  /** Chainable light: into itself, into the other lights, and up the ladder. */
  light(chain: readonly number[]): CancelRule {
    return { onContact: AttackTier.Normal, onWhiff: AttackTier.None, chain, self: true };
  },
  /** Heavy normal: no chain, but cancels into command normals, specials and up. */
  heavy(): CancelRule {
    return { onContact: AttackTier.CommandNormal, onWhiff: AttackTier.None };
  },
  /** Command normal: specials and up only. */
  command(): CancelRule {
    return { onContact: AttackTier.Special, onWhiff: AttackTier.None };
  },
  /**
   * The poke a character is allowed to be sloppy with: cancellable into a
   * special even when it hits nothing, which is how KOF's whiff-cancel pressure
   * and its fake-out mixups work.
   */
  whiffable(): CancelRule {
    return { onContact: AttackTier.CommandNormal, onWhiff: AttackTier.Special };
  },
  /** Special / EX: terminal unless a Drive Cancel or HD cancel pays for it. */
  special(): CancelRule {
    return { onContact: AttackTier.None, onWhiff: AttackTier.None };
  },
  /** DM: only an HD NeoMax cancel gets out of it. */
  dm(): CancelRule {
    return { onContact: AttackTier.None, onWhiff: AttackTier.None };
  },
  /** Cannot be cancelled out of by any means. */
  locked(): CancelRule {
    return { onContact: AttackTier.None, onWhiff: AttackTier.None, locked: true };
  },
} as const;

export function inv(from: number, to: number, bits: number = Invuln.Full): InvulnWindow {
  return { from, to, bits };
}

export function mkThrow(t: Omit<ThrowDef, 'tier'> & { tier?: AttackTier }): ThrowDef {
  return { ...t, tier: t.tier ?? AttackTier.CommandNormal };
}
