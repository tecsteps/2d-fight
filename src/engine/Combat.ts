import { Btn } from '../core/Input';
import {
  CHIP_KILL_FLOOR,
  COMBO_SCALE,
  COMBO_SCALE_FLOOR,
  COUNTER_DAMAGE,
  COUNTER_HITSTOP_BONUS,
  COUNTER_HITSTUN_BONUS,
  HD_DAMAGE_SCALE,
  JUGGLE_POINTS,
  MIN_DAMAGE_FRACTION,
  REPEAT_PENALTY,
  THROW_TECH_PUSH,
} from '../data/moves/tuning';
import { S } from '../data/moves/build';
import {
  AttackTier,
  GuardKind,
  HitOutcomeKind,
  Invuln,
  MoveType,
  Reaction,
  StateType,
  type AttackDef,
  type ThrowDef,
} from './contract';
import {
  aabb,
  boxDebug,
  BoxKind,
  centreX,
  centreY,
  intersection,
  overlaps,
  type AABB,
} from './Boxes';
import { applyKnockback, shoveApart, type StageBounds } from './Physics';
import type { Fighter } from './Fighter';

/**
 * Hit resolution.
 *
 * ## Symmetry
 *
 * The one rule that everything else here serves: **both fighters resolve
 * against the same snapshot**. Positions, boxes, stun counters and health are
 * copied into two `CombatSnapshot`s once per tick, both directions are decided
 * from those copies, and only then is anything written back. Nothing that
 * happens to fighter A during resolution can change what happens to fighter B,
 * so a genuine simultaneous exchange is always a mutual trade and never a race
 * decided by array order.
 *
 * ## Order within a tick
 *
 *   1. Snapshot both fighters.
 *   2. Throws, both directions, from the snapshot.
 *   3. Strikes, both directions, from the same snapshot.
 *   4. Arbitrate: a throw that landed cancels the victim's strike; two strikes
 *      that both landed trade, unless one out-prioritises the other by a wide
 *      margin (a super beats a jab; a heavy and a light still trade).
 *   5. Apply.
 *
 * ## Hit vs block vs whiff
 *
 * A defender blocks when they are holding back, are in a state that permits
 * guarding, and their posture is legal for the attack's guard kind. Holding
 * back in the wrong posture is not a block — that is the whole point of a
 * high/low mixup.
 */

export type ContactKind =
  | 'hit'
  | 'counter'
  | 'block'
  | 'guardCrush'
  | 'throw'
  | 'tech'
  | 'juggleRefused'
  | 'ko';

/** Everything VFX, audio and the camera need to know about one contact. */
export interface ContactEvent {
  kind: ContactKind;
  /** Contact point in world space — the centre of the box overlap. */
  x: number;
  y: number;
  attacker: number;
  defender: number;
  /** 0..1 weight for shake, punch-in and spark size. */
  impact: number;
  damage: number;
  tier: AttackTier;
  /** Hits landed in the defender's current combo, after this one. */
  comboHits: number;
}

/** Immutable per-tick view of one fighter. Resolution reads only these. */
export interface CombatSnapshot {
  slot: number;
  x: number;
  y: number;
  facing: number;
  hurt: AABB[];
  hit: AABB[];
  attack: AttackDef | null;
  throwDef: ThrowDef | null;
  attackId: number;
  window: number;
  moveType: MoveType;
  stateType: StateType;
  stateNo: number;
  stateTime: number;
  airborne: boolean;
  invuln: number;
  guardIntent: boolean;
  canGuard: boolean;
  hitstun: number;
  blockstun: number;
  hitstop: number;
  health: number;
  juggle: number;
  counterVulnerable: boolean;
  throwProtect: boolean;
  hdActive: boolean;
  /** Has this activation+window already connected with the other fighter? */
  alreadyHit: boolean;
}

interface Outcome {
  kind: HitOutcomeKind;
  attack: AttackDef | null;
  throwDef: ThrowDef | null;
  x: number;
  y: number;
  window: number;
}

const NO_OUTCOME: Outcome = {
  kind: HitOutcomeKind.None,
  attack: null,
  throwDef: null,
  x: 0,
  y: 0,
  window: -1,
};

export function emptySnapshot(slot: number): CombatSnapshot {
  return {
    slot,
    x: 0,
    y: 0,
    facing: 1,
    hurt: [],
    hit: [],
    attack: null,
    throwDef: null,
    attackId: 0,
    window: -1,
    moveType: MoveType.Idle,
    stateType: StateType.Stand,
    stateNo: 0,
    stateTime: 0,
    airborne: false,
    invuln: 0,
    guardIntent: false,
    canGuard: false,
    hitstun: 0,
    blockstun: 0,
    hitstop: 0,
    health: 0,
    juggle: 0,
    counterVulnerable: false,
    throwProtect: false,
    hdActive: false,
    alreadyHit: false,
  };
}

/** Copy a fighter's decision-relevant state. Boxes are already world-space. */
export function snapshot(f: Fighter, other: Fighter, out: CombatSnapshot): CombatSnapshot {
  out.slot = f.slot;
  out.x = f.x;
  out.y = f.y;
  out.facing = f.facing;
  out.hurt = f.hurtWorld;
  out.hit = f.hitWorld;
  out.attack = f.activeAttack;
  out.throwDef = f.activeThrow;
  out.attackId = f.attackId;
  out.window = f.activeWindowIndex;
  out.moveType = f.moveType;
  out.stateType = f.stateType;
  out.stateNo = f.stateNo;
  out.stateTime = f.stateTime;
  out.airborne = f.airborne;
  out.invuln = f.sm.invulnAt(f.stateTime);
  out.guardIntent = isHoldingBack(f);
  out.canGuard = canGuard(f);
  out.hitstun = f.hitstun;
  out.blockstun = f.blockstun;
  out.hitstop = f.hitstop;
  out.health = f.health;
  out.juggle = f.juggle;
  out.counterVulnerable = f.sm.counterVulnerable(f.stateTime);
  out.throwProtect = f.throwProtect > 0;
  out.hdActive = f.gauges.hdActive;
  out.alreadyHit = f.hasHit(other.slot);
  return out;
}

function isHoldingBack(f: Fighter): boolean {
  const d = f.input.dir;
  return d === 4 || d === 1 || d === 7;
}

function canGuard(f: Fighter): boolean {
  if (f.stateType === StateType.Lying) return false;
  if (f.moveType === MoveType.Attack) return false;
  if (f.hitstun > 0) return false;
  if (f.noGuard) return false;
  return f.ctrl || f.blockstun > 0;
}

/** Is this posture legal against this attack's guard kind? */
function guardLegal(kind: GuardKind, snap: CombatSnapshot): boolean {
  if (kind === GuardKind.Unblockable) return false;
  if (snap.airborne) return true; // air guard covers everything it can reach
  switch (kind) {
    case GuardKind.Low:
      return snap.stateType === StateType.Crouch;
    case GuardKind.Overhead:
      return snap.stateType === StateType.Stand;
    default:
      return true;
  }
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

export class Combat {
  readonly snaps: [CombatSnapshot, CombatSnapshot] = [emptySnapshot(0), emptySnapshot(1)];
  /** Contact events raised this tick, consumed by VFX/audio/camera. */
  readonly events: ContactEvent[] = [];

  private readonly outcomes: [Outcome, Outcome] = [{ ...NO_OUTCOME }, { ...NO_OUTCOME }];
  private readonly scratch: AABB = aabb();

  /** The whole exchange for one tick. */
  step(a: Fighter, b: Fighter, stage: StageBounds): void {
    this.events.length = 0;

    const sa = snapshot(a, b, this.snaps[0]);
    const sb = snapshot(b, a, this.snaps[1]);

    const oa = this.outcomes[0];
    const ob = this.outcomes[1];
    reset(oa);
    reset(ob);

    this.tryThrow(sa, sb, oa);
    this.tryThrow(sb, sa, ob);
    this.tryStrike(sa, sb, oa);
    this.tryStrike(sb, sa, ob);

    arbitrate(oa, ob);

    // Nothing is written back until both directions are decided.
    a.pushClaim = 0;
    b.pushClaim = 0;
    this.apply(a, b, sa, sb, oa, stage);
    this.apply(b, a, sb, sa, ob, stage);
  }

  private tryThrow(atk: CombatSnapshot, def: CombatSnapshot, out: Outcome): void {
    if (out.kind !== HitOutcomeKind.None) return;
    const t = atk.throwDef;
    if (!t || atk.alreadyHit) return;

    // Throws refuse airborne, stunned and freshly-recovered targets. That
    // protection is what stops a wake-up throw loop from existing.
    if (def.airborne) return;
    if (def.hitstun > 0 || def.blockstun > 0) return;
    if (def.throwProtect) return;
    if (def.invuln & Invuln.Throw) return;
    if (def.stateType === StateType.Lying) return;

    const dx = (def.x - atk.x) * atk.facing;
    if (dx < -0.12 || dx > t.range) return;
    const dy = def.y - atk.y;
    if (dy < t.minY || dy > t.maxY) return;

    out.throwDef = t;
    out.kind = HitOutcomeKind.Hit;
    out.x = (atk.x + def.x) * 0.5;
    out.y = def.y + 0.9;
    out.window = 0;
  }

  private tryStrike(atk: CombatSnapshot, def: CombatSnapshot, out: Outcome): void {
    if (out.kind !== HitOutcomeKind.None) return;
    const hd = atk.attack;
    if (!hd || atk.hit.length === 0) return;
    if (atk.alreadyHit) return;
    if (def.invuln & Invuln.Strike) return;
    if (hd.guard === GuardKind.Low && def.invuln & Invuln.Low) return;

    let found = false;
    for (let i = 0; i < atk.hit.length && !found; i++) {
      boxDebug.add(BoxKind.Hit, atk.slot, atk.hit[i]);
      for (let j = 0; j < def.hurt.length; j++) {
        if (overlaps(atk.hit[i], def.hurt[j])) {
          intersection(atk.hit[i], def.hurt[j], this.scratch);
          found = true;
          break;
        }
      }
    }
    if (!found) return;

    out.attack = hd;
    out.x = centreX(this.scratch);
    out.y = centreY(this.scratch);
    out.window = atk.window;

    const blocking = def.canGuard && def.guardIntent;
    if (blocking && guardLegal(hd.guard, def)) {
      out.kind = HitOutcomeKind.Blocked;
      return;
    }

    // Juggle: an airborne victim can only be caught so many times.
    if (def.airborne && hd.juggle > 0 && def.juggle < hd.juggle) {
      out.kind = HitOutcomeKind.JuggleRefused;
      return;
    }

    out.kind = def.counterVulnerable ? HitOutcomeKind.CounterHit : HitOutcomeKind.Hit;
  }

  /* ---------------------------------------------------------------- */

  private apply(
    atk: Fighter,
    def: Fighter,
    atkSnap: CombatSnapshot,
    defSnap: CombatSnapshot,
    out: Outcome,
    stage: StageBounds,
  ): void {
    switch (out.kind) {
      case HitOutcomeKind.None:
        return;
      case HitOutcomeKind.JuggleRefused:
        // The move passes harmlessly through. Consuming the activation stops it
        // from retrying every frame of its active window.
        atk.markHit(def.slot);
        return;
      case HitOutcomeKind.Teched:
        this.applyTech(atk, def, out);
        return;
      default:
        break;
    }

    if (out.throwDef) this.applyThrow(atk, def, defSnap, out);
    else this.applyStrike(atk, def, atkSnap, defSnap, out, stage);
  }

  private applyStrike(
    atk: Fighter,
    def: Fighter,
    atkSnap: CombatSnapshot,
    defSnap: CombatSnapshot,
    out: Outcome,
    stage: StageBounds,
  ): void {
    const hd = out.attack;
    if (!hd) return;
    const blocked = out.kind === HitOutcomeKind.Blocked;
    const counter = out.kind === HitOutcomeKind.CounterHit;

    atk.markHit(def.slot);
    atk.moveContact = blocked ? 2 : 1;

    const hitstop = hd.hitstop + (counter ? COUNTER_HITSTOP_BONUS : 0);
    atk.hitstop = Math.max(atk.hitstop, hitstop);
    def.hitstop = Math.max(def.hitstop, hitstop + hd.hitShake);
    def.shake = hd.hitShake;

    if (blocked) {
      const chip = Math.round(hd.damage * hd.chip);
      if (chip > 0) def.health = Math.max(CHIP_KILL_FLOOR, def.health - chip);

      def.blockstun = hd.blockstun;
      def.hitstun = 0;
      atk.gauges.addPower(hd.powerBlock);
      atk.gauges.addDrive(hd.driveBlock);
      def.gauges.addPower(Math.round(hd.powerTaken * 0.25));

      const crushed = def.gauges.damageGuard(hd.guardDamage);
      applyKnockback(atk, def, Math.abs(hd.guardVel[0]), hd.guardVel[1], hd.selfPushGuard, stage);
      if (crushed) {
        def.enterGuardCrush();
        this.push('guardCrush', out, atk, def, hd, 0);
      } else {
        def.enterBlockstun();
        this.push('block', out, atk, def, hd, chip);
      }
      return;
    }

    const damage = this.computeDamage(hd, atkSnap, def, counter);
    def.takeDamage(damage);
    def.registerComboHit(hd.id);

    atk.gauges.addPower(hd.powerHit);
    atk.gauges.addDrive(hd.driveHit);
    def.gauges.addPower(hd.powerTaken);

    def.hitstun = hd.hitstun + (counter ? COUNTER_HITSTUN_BONUS : 0);
    def.blockstun = 0;

    const airborne = defSnap.airborne;
    const reaction = airborne && hd.airReaction !== undefined ? hd.airReaction : hd.reaction;
    const vel = airborne ? hd.airHitVel : hd.hitVel;

    if (!airborne && (reaction === Reaction.Launch || reaction === Reaction.Blowback)) {
      def.juggle = hd.juggleStart || JUGGLE_POINTS;
    } else if (airborne) {
      def.juggle = Math.max(0, def.juggle - hd.juggle);
    }

    applyKnockback(atk, def, Math.abs(vel[0]), vel[1], hd.selfPush, stage);
    def.enterHitReaction(reaction, airborne);

    this.push(counter ? 'counter' : 'hit', out, atk, def, hd, damage);
    if (def.health <= 0) this.push('ko', out, atk, def, hd, damage);
  }

  private applyThrow(atk: Fighter, def: Fighter, defSnap: CombatSnapshot, out: Outcome): void {
    const t = out.throwDef;
    if (!t) return;
    atk.markHit(def.slot);
    atk.moveContact = 1;

    if (t.techable && this.techPressed(def, t.techWindow)) {
      this.applyTech(atk, def, out);
      return;
    }

    atk.hitstop = t.hitstop;
    def.hitstop = t.hitstop;
    atk.gauges.addPower(t.powerHit);
    atk.gauges.addDrive(t.driveHit);
    def.gauges.addPower(t.powerTaken);

    def.beThrown(atk, t);
    atk.sm.changeState(t.execState);
    this.push('throw', out, atk, def, null, 0);
  }

  private applyTech(atk: Fighter, def: Fighter, out: Outcome): void {
    atk.hitstop = 8;
    def.hitstop = 8;
    atk.sm.changeState(S.THROW_TECH);
    def.sm.changeState(S.THROW_TECH);
    shoveApart(atk, def, THROW_TECH_PUSH);
    this.push('tech', out, atk, def, null, 0);
  }

  /**
   * Did the victim mash a throw break in time?
   *
   * KOF gives a short window around the grab rather than a reaction test, so we
   * look backwards through the defender's own buffer — deterministic, and it
   * rewards the player who was already pressing.
   */
  private techPressed(def: Fighter, window: number): boolean {
    return def.input.pressed(Btn.C, window) || def.input.pressed(Btn.D, window);
  }

  /**
   * Combo scaling.
   *
   * Three multipliers stack: how deep into the combo this hit is, how many
   * times this exact move has already been used in it, and whether HD mode is
   * paying for the length. A floor keeps the twentieth hit from being free.
   */
  private computeDamage(
    hd: AttackDef,
    atkSnap: CombatSnapshot,
    def: Fighter,
    counter: boolean,
  ): number {
    let base = hd.damage;
    if (counter) base *= COUNTER_DAMAGE * hd.counterBonus;
    if (atkSnap.hdActive) base *= HD_DAMAGE_SCALE;

    if (hd.noScaling) return Math.max(1, Math.round(base));

    const idx = def.comboHits;
    const stage = idx < COMBO_SCALE.length ? COMBO_SCALE[idx] : COMBO_SCALE_FLOOR;
    const repeats = def.comboMoveUses(hd.id);
    const repeat = repeats > 0 ? Math.pow(REPEAT_PENALTY, repeats) : 1;

    const scaled = base * stage * repeat;
    const floor = base * MIN_DAMAGE_FRACTION;
    return Math.max(1, Math.round(scaled > floor ? scaled : floor));
  }

  private push(
    kind: ContactKind,
    out: Outcome,
    atk: Fighter,
    def: Fighter,
    hd: AttackDef | null,
    damage: number,
  ): void {
    this.events.push({
      kind,
      x: out.x,
      y: out.y,
      attacker: atk.slot,
      defender: def.slot,
      impact: hd ? hd.impact : out.throwDef ? out.throwDef.impact : 0.4,
      damage,
      tier: hd ? hd.tier : (out.throwDef?.tier ?? AttackTier.None),
      comboHits: def.comboHits,
    });
  }
}

function reset(o: Outcome): void {
  o.kind = HitOutcomeKind.None;
  o.attack = null;
  o.throwDef = null;
  o.x = 0;
  o.y = 0;
  o.window = -1;
}

/**
 * Trade arbitration.
 *
 * The default is a mutual trade: both fighters connected on the same frame, so
 * both eat it. A wide priority gap is the only thing that breaks the tie — a
 * NeoMax should plough through a jab, but a heavy and a light still trade,
 * because that ambiguity is what makes neutral tense.
 *
 * A throw that lands cancels the other fighter's strike outright: you cannot be
 * hit by someone you have already picked up.
 */
function arbitrate(a: Outcome, b: Outcome): void {
  const aLive = a.kind === HitOutcomeKind.Hit || a.kind === HitOutcomeKind.CounterHit;
  const bLive = b.kind === HitOutcomeKind.Hit || b.kind === HitOutcomeKind.CounterHit;
  if (!aLive || !bLive) return;

  if (a.throwDef && !b.throwDef) {
    reset(b);
    return;
  }
  if (b.throwDef && !a.throwDef) {
    reset(a);
    return;
  }
  if (a.throwDef && b.throwDef) {
    // Two grabs on the same frame: nobody gets thrown.
    a.kind = HitOutcomeKind.Teched;
    reset(b);
    return;
  }

  const pa = a.attack?.priority ?? 0;
  const pb = b.attack?.priority ?? 0;
  if (pa - pb >= 4) reset(b);
  else if (pb - pa >= 4) reset(a);
  // Otherwise both stand: a real trade, applied to both fighters.
}
