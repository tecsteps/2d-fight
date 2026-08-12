import { InputBuffer } from '../core/Input';
import type { FighterDef } from '../data/roster';
import { S } from '../data/moves/build';
import { moveListFor } from '../data/moves';
import {
  COMBO_DROP_FRAMES,
  KNOCKDOWN_FRAMES,
  THROW_PROTECT_FRAMES,
} from '../data/moves/tuning';
import {
  MoveType,
  PhysicsMode,
  Reaction,
  StateType,
  type AttackDef,
  type MoveList,
  type ThrowDef,
} from './contract';
import {
  aabb,
  boxDebug,
  BoxKind,
  boxesAt,
  toWorld,
  type AABB,
  type BoxTuple,
} from './Boxes';
import { Gauges, type GaugeState } from './Gauges';
import {
  gravityFor,
  integrate,
  jumpVelocityFor,
  touchedGround,
  snapToGround,
  type StageBounds,
} from './Physics';
import { StateMachine } from './StateMachine';

/**
 * One fighter.
 *
 * Everything a character is at a given instant lives here as plain numbers:
 * where they are, what state they are in, how long they have been in it, what
 * their meters read, and which of their boxes are live. There are no
 * references to anything renderable and no wall-clock reads, so a `Fighter`
 * can be stepped headless, hashed, saved and restored — which is the shape
 * rollback netcode needs even though we are not writing it yet.
 *
 * The renderer reads `x`, `y`, `facing`, `anim`, `animFrame` and `shake`; the
 * HUD reads `health` and `gauges`. Nothing outside the engine writes any of it.
 */

/** What the world around a fighter can be asked to do. `Match` implements it. */
export interface FightWorld {
  readonly stage: StageBounds;
  readonly tick: number;
  /** Freeze the fight for a super flash. */
  flash(frames: number, source: Fighter): void;
}

export interface FighterState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  stateNo: number;
  prevStateNo: number;
  stateTime: number;
  animFrame: number;
  health: number;
  hitstop: number;
  shake: number;
  hitstun: number;
  blockstun: number;
  juggle: number;
  throwProtect: number;
  pauseTimer: number;
  moveContact: number;
  attackId: number;
  hitKey: number;
  hitDone: number;
  comboHits: number;
  comboDamage: number;
  comboTimer: number;
  comboMoves: number[];
  driveCancels: number;
  boundTo: number;
  bindX: number;
  bindY: number;
  bindTimer: number;
  jumpArc: number;
  inputLog: number[];
  inputHead: number;
  inputCount: number;
  noCommands: boolean;
  noGuard: boolean;
  ko: boolean;
  gauges: GaugeState;
  sm: ReturnType<StateMachine['save']>;
}

/** Frames of input history retained for snapshot/restore. Matches InputBuffer. */
const INPUT_LOG = 80;

export class Fighter {
  readonly def: FighterDef;
  /** 0 or 1. Used for box ownership and the hit bookkeeping bitmask. */
  readonly slot: number;
  /** Which team this character is fighting for, in 3v3. */
  readonly team: number;
  readonly input = new InputBuffer();
  readonly moves: MoveList;
  readonly sm: StateMachine;
  readonly gauges = new Gauges();

  opponent!: Fighter;
  world!: FightWorld;

  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  facing: 1 | -1 = 1;

  /** Derived once from the roster def — see `Physics.gravityFor`. */
  readonly gravity: number;
  readonly halfWidth: number;
  readonly height: number;

  stateNo = 0;
  prevStateNo = 0;
  stateTime = 0;
  ctrl = true;
  stateType: StateType = StateType.Stand;
  moveType: MoveType = MoveType.Idle;
  physics: PhysicsMode = PhysicsMode.Stand;
  anim = 'stand';
  animFrame = 0;

  health: number;
  readonly maxHealth: number;

  /** Impact freeze. Nothing about this fighter advances while it is non-zero. */
  hitstop = 0;
  /** Amplitude of the victim's rattle, in centimetres. Render-only. */
  shake = 0;
  hitstun = 0;
  blockstun = 0;
  /** Air-hit budget. Runs out and further juggles simply miss. */
  juggle = 0;
  throwProtect = 0;
  /** Super-flash freeze, applied to both fighters by `FightWorld.flash`. */
  pauseTimer = 0;

  /** 0 = the current move has touched nothing, 1 = hit, 2 = guarded. */
  moveContact = 0;
  /** Bumped on every attack state entry; identifies one activation. */
  attackId = 0;
  private hitKey = -1;
  private hitDone = 0;

  /** Hits taken in the current combo — the scaling index and the HUD counter. */
  comboHits = 0;
  comboDamage = 0;
  private comboTimer = 0;
  private comboMoves: number[] = [];

  /** Drive/HD cancels used, for the HUD and for post-match stats. */
  driveCancels = 0;

  /**
   * Largest pushback magnitude claimed this tick. Reset by `Combat` before the
   * apply phase; never read across ticks, so it stays out of the snapshot.
   */
  pushClaim = 0;

  /** Slot of the fighter this one is glued to during a throw, or -1. */
  boundTo = -1;
  bindX = 0;
  bindY = 0;
  bindTimer = 0;

  /** Apex multiplier chosen when the jump started: short hop vs full jump. */
  jumpArc = 1;

  /**
   * Our own copy of the last `INPUT_LOG` frames of input.
   *
   * `InputBuffer` is a ring we cannot read the internals of, and motion
   * recognition looks back more than a second — so restoring a snapshot without
   * restoring the buffer would leave a fighter's quarter-circle half-remembered
   * from a future that no longer happens. Keeping the log here means a restore
   * can replay it back into the buffer, which is exactly what real rollback
   * netcode does with the inputs it already has.
   */
  private readonly inputLog = new Int32Array(INPUT_LOG);
  private inputHead = 0;
  private inputCount = 0;

  /** Round flow gates: intro, KO and win poses take the player's hands away. */
  noCommands = false;
  noGuard = false;
  ko = false;

  /* Live collision geometry, rebuilt every tick. */
  readonly hurtWorld: AABB[] = [];
  readonly hitWorld: AABB[] = [];
  readonly pushWorld: AABB = aabb();
  activeAttack: AttackDef | null = null;
  activeThrow: ThrowDef | null = null;
  activeWindowIndex = -1;

  private readonly hurtPool: AABB[] = [];
  private readonly hitPool: AABB[] = [];

  constructor(def: FighterDef, slot: number, team: number) {
    this.def = def;
    this.slot = slot;
    this.team = team;
    this.moves = moveListFor(def);
    this.height = def.proportions.height;
    this.gravity = gravityFor(def);
    this.halfWidth = this.moves.pushStand[2];
    this.maxHealth = def.health;
    this.health = def.health;
    for (let i = 0; i < 8; i++) {
      this.hurtPool.push(aabb());
      this.hitPool.push(aabb());
    }
    this.sm = new StateMachine(this, this.moves, S.STAND);
    this.refreshBoxes();
  }

  get airborne(): boolean {
    return this.physics === PhysicsMode.Air;
  }

  get frozen(): boolean {
    return this.pauseTimer > 0 || this.hitstop > 0;
  }

  /** Feed one frame of raw input. Call exactly once per tick, before `update`. */
  pushInput(dir: number, buttons: number): void {
    this.inputLog[this.inputHead] = (dir & 15) | (buttons << 4);
    this.inputHead = (this.inputHead + 1) % INPUT_LOG;
    if (this.inputCount < INPUT_LOG) this.inputCount++;
    this.input.push(dir, buttons);
  }

  private rebuildInputBuffer(): void {
    this.input.reset();
    this.input.facing = this.facing;
    for (let i = this.inputCount; i > 0; i--) {
      const v = this.inputLog[(this.inputHead - i + INPUT_LOG * 2) % INPUT_LOG];
      this.input.push(v & 15, v >> 4);
    }
  }

  /** Signed distance to the opponent, positive when they are in front. */
  get toOpponent(): number {
    return (this.opponent.x - this.x) * this.facing;
  }

  /** Jump velocity for the arc currently selected. */
  jumpVelocity(arc = this.jumpArc): number {
    return jumpVelocityFor(this.def, arc);
  }

  /* ---------------------------------------------------------------- *
   * Per-tick update
   *
   * Called by `Match` between the input push and the combat pass. Ordering is
   * deliberate and fixed: freezes first (they cancel everything), then timers,
   * then state logic, then integration. Boxes are rebuilt last so the combat
   * pass sees this frame's geometry.
   * ---------------------------------------------------------------- */

  update(stage: StageBounds): void {
    if (this.pauseTimer > 0) {
      this.pauseTimer--;
      this.refreshBoxes();
      return;
    }
    if (this.hitstop > 0) {
      this.hitstop--;
      // The rattle decays inside the freeze, which is what reads as impact.
      if (this.shake > 0) this.shake = this.shake > 1 ? this.shake - 1 : 0;
      // Inputs still count during the freeze — this is where combos are
      // confirmed — they just do not take effect until it lifts.
      this.sm.bufferDuringFreeze();
      this.refreshBoxes();
      return;
    }
    this.shake = 0;

    if (this.hitstun > 0) this.hitstun--;
    if (this.blockstun > 0) this.blockstun--;
    if (this.throwProtect > 0) this.throwProtect--;
    this.gauges.tick();
    this.tickCombo();

    this.faceOpponent();
    this.input.facing = this.facing;

    this.sm.tick();

    if (this.bindTimer > 0) {
      this.tickBind();
    } else {
      integrate(this, stage);
      if (touchedGround(this, stage)) {
        snapToGround(this, stage);
        this.land();
      }
    }

    this.refreshBoxes();
  }

  /**
   * Turn to face the opponent.
   *
   * Only ever in a neutral posture: committing to a move commits to a
   * direction, which is what makes crossing someone up mid-attack work.
   */
  private faceOpponent(): void {
    if (this.moveType === MoveType.Attack) return;
    if (this.airborne) return;
    if (this.hitstun > 0 || this.stateType === StateType.Lying) return;
    if (this.sm.def.turnable === false) return;
    const want = this.opponent.x >= this.x ? 1 : -1;
    if (want !== this.facing) {
      this.facing = want;
      this.input.facing = want;
    }
  }

  private tickCombo(): void {
    if (this.moveType === MoveType.BeingHit || this.stateType === StateType.Lying) {
      this.comboTimer = COMBO_DROP_FRAMES;
      return;
    }
    if (this.comboTimer > 0) {
      this.comboTimer--;
      if (this.comboTimer === 0) this.resetCombo();
    }
  }

  private resetCombo(): void {
    this.comboHits = 0;
    this.comboDamage = 0;
    this.comboMoves.length = 0;
  }

  /** Glue this fighter to another during a throw. */
  bindTo(other: Fighter, dx: number, dy: number, frames: number): void {
    this.boundTo = other.slot;
    this.bindX = dx;
    this.bindY = dy;
    this.bindTimer = frames;
    this.vx = 0;
    this.vy = 0;
  }

  private tickBind(): void {
    const host = this.opponent.slot === this.boundTo ? this.opponent : null;
    if (!host) {
      this.bindTimer = 0;
      return;
    }
    this.x = host.x + host.facing * this.bindX;
    this.y = host.y + this.bindY;
    this.bindTimer--;
    if (this.bindTimer === 0) this.boundTo = -1;
  }

  /** An airborne state has touched the floor. */
  private land(): void {
    const d = this.sm.def;
    if (this.moveType === MoveType.BeingHit || this.stateType === StateType.Lying) {
      this.sm.changeState(this.ko ? S.KO_LYING : S.DOWN_BOUNCE);
      return;
    }
    this.sm.changeState(d.landState ?? S.LAND);
  }

  /* ---------------------------------------------------------------- *
   * Collision geometry
   * ---------------------------------------------------------------- */

  /**
   * Rebuild world-space boxes. `Match` calls this again after push-out has
   * nudged positions, so the combat pass always tests this frame's geometry.
   */
  refreshBoxes(): void {
    const d = this.sm.def;
    const t = this.stateTime;

    const set = d.boxes ? boxesAt(d.boxes, t) : null;
    const hurt = set ? set.hurt : this.defaultHurt();

    this.hurtWorld.length = 0;
    for (let i = 0; i < hurt.length && i < this.hurtPool.length; i++) {
      const box = toWorld(hurt[i], this.x, this.y, this.facing, this.hurtPool[i]);
      this.hurtWorld.push(box);
      boxDebug.add(BoxKind.Hurt, this.slot, box);
    }

    const push = set?.push ?? this.defaultPush();
    toWorld(push, this.x, this.y, this.facing, this.pushWorld);
    boxDebug.add(BoxKind.Push, this.slot, this.pushWorld);

    const w = this.sm.activeWindow(t);
    this.activeWindowIndex = w;
    this.hitWorld.length = 0;
    this.activeAttack = null;
    this.activeThrow = null;

    if (w >= 0) {
      this.activeAttack = d.windowAttacks?.[w] ?? d.attack ?? null;
      this.activeThrow = d.throw ?? null;
      const hitBoxes = set?.hit;
      if (hitBoxes) {
        for (let i = 0; i < hitBoxes.length && i < this.hitPool.length; i++) {
          this.hitWorld.push(toWorld(hitBoxes[i], this.x, this.y, this.facing, this.hitPool[i]));
        }
      }
    }

    // One activation gets one hit per window, unless the move declares a repeat
    // cadence. Rolling the key forward is what re-opens it.
    const interval = this.activeAttack?.hitInterval ?? 0;
    const phase = interval > 0 ? Math.floor(t / interval) : 0;
    const key = w < 0 ? -1 : this.attackId * 4096 + w * 64 + phase;
    if (key !== this.hitKey) {
      this.hitKey = key;
      this.hitDone = 0;
    }
  }

  private defaultHurt(): readonly BoxTuple[] {
    return this.moves.states.get(S.STAND)?.boxes?.[0].hurt ?? [];
  }

  private defaultPush(): BoxTuple {
    if (this.airborne) return this.moves.pushAir;
    return this.stateType === StateType.Crouch ? this.moves.pushCrouch : this.moves.pushStand;
  }

  hasHit(slot: number): boolean {
    return (this.hitDone & (1 << slot)) !== 0;
  }

  markHit(slot: number): void {
    this.hitDone |= 1 << slot;
  }

  /* ---------------------------------------------------------------- *
   * Being hit
   * ---------------------------------------------------------------- */

  takeDamage(amount: number): void {
    this.health -= amount;
    this.comboDamage += amount;
    if (this.health <= 0) {
      this.health = 0;
      this.ko = true;
    }
  }

  registerComboHit(moveId: number): void {
    this.comboHits++;
    this.comboMoves.push(moveId);
    this.comboTimer = COMBO_DROP_FRAMES;
  }

  comboMoveUses(moveId: number): number {
    let n = 0;
    for (let i = 0; i < this.comboMoves.length; i++) if (this.comboMoves[i] === moveId) n++;
    return n;
  }

  /** Put the victim in the reaction the attack asked for. */
  enterHitReaction(reaction: Reaction, wasAirborne: boolean): void {
    this.moveContact = 0;
    if (this.ko) {
      this.sm.changeState(S.KO_FALL);
      return;
    }
    if (wasAirborne || reaction === Reaction.Launch || reaction === Reaction.Blowback ||
        reaction === Reaction.WallBounce || reaction === Reaction.GroundBounce) {
      this.sm.changeState(S.HIT_AIR);
      return;
    }
    switch (reaction) {
      case Reaction.Trip:
        this.sm.changeState(S.FALL);
        break;
      case Reaction.Crumple:
        this.sm.changeState(S.HIT_CRUMPLE);
        break;
      case Reaction.Light:
        this.sm.changeState(
          this.stateType === StateType.Crouch ? S.HIT_CROUCH : S.HIT_STAND_L,
        );
        break;
      default:
        this.sm.changeState(
          this.stateType === StateType.Crouch ? S.HIT_CROUCH : S.HIT_STAND_H,
        );
        break;
    }
  }

  enterBlockstun(): void {
    this.moveContact = 0;
    const s = this.airborne
      ? S.GUARDHIT_AIR
      : this.stateType === StateType.Crouch
        ? S.GUARDHIT_CROUCH
        : S.GUARDHIT_STAND;
    this.sm.changeState(s);
  }

  enterGuardCrush(): void {
    this.moveContact = 0;
    this.blockstun = 0;
    this.sm.changeState(S.GUARD_CRUSH);
  }

  beThrown(attacker: Fighter, t: ThrowDef): void {
    this.moveContact = 0;
    this.hitstun = 0;
    this.blockstun = 0;
    this.facing = attacker.facing === 1 ? -1 : 1;
    this.input.facing = this.facing;
    this.takeDamage(t.damage);
    this.registerComboHit(t.id);
    this.sm.changeState(t.victimState);
    // Held slightly longer than the attacker's release frame, so the throw
    // animation is what lets go rather than the timer running out.
    this.bindTo(attacker, 0.5, 0, 20);
  }

  /** Called on wake-up and on landing, so nobody can be grabbed out of nothing. */
  grantThrowProtection(): void {
    this.throwProtect = THROW_PROTECT_FRAMES;
  }

  /* ---------------------------------------------------------------- *
   * Round lifecycle
   * ---------------------------------------------------------------- */

  /** Put the fighter back on their mark. `carryHealth < 0` means "full". */
  resetForRound(x: number, facing: 1 | -1, carryHealth = -1, carryPower = 0): void {
    this.x = x;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.facing = facing;
    this.input.reset();
    this.input.facing = facing;
    this.inputLog.fill(0);
    this.inputHead = 0;
    this.inputCount = 0;
    this.health = carryHealth < 0 ? this.maxHealth : Math.max(1, Math.min(this.maxHealth, carryHealth));
    this.ko = false;
    this.hitstop = 0;
    this.shake = 0;
    this.hitstun = 0;
    this.blockstun = 0;
    this.pauseTimer = 0;
    this.juggle = 0;
    this.throwProtect = 0;
    this.moveContact = 0;
    this.attackId = 0;
    this.hitKey = -1;
    this.hitDone = 0;
    this.driveCancels = 0;
    this.boundTo = -1;
    this.bindTimer = 0;
    this.noCommands = false;
    this.noGuard = false;
    this.resetCombo();
    this.comboTimer = 0;
    this.gauges.reset(carryPower, 0);
    this.sm.buffered = -1;
    this.sm.bufferedFrames = 0;
    this.sm.changeState(S.STAND);
    this.refreshBoxes();
  }

  /** Knock the loser down and take their hands off the controls. */
  enterKO(): void {
    this.ko = true;
    this.noCommands = true;
    this.noGuard = true;
    if (this.stateNo !== S.KO_FALL && this.stateNo !== S.KO_LYING) {
      this.sm.changeState(S.KO_FALL);
    }
  }

  enterWinPose(): void {
    this.noCommands = true;
    if (this.sm.has(S.WIN)) this.sm.changeState(S.WIN);
  }

  /* ---------------------------------------------------------------- *
   * Snapshot / restore — the rollback contract
   * ---------------------------------------------------------------- */

  save(): FighterState {
    return {
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      facing: this.facing,
      stateNo: this.stateNo,
      prevStateNo: this.prevStateNo,
      stateTime: this.stateTime,
      animFrame: this.animFrame,
      health: this.health,
      hitstop: this.hitstop,
      shake: this.shake,
      hitstun: this.hitstun,
      blockstun: this.blockstun,
      juggle: this.juggle,
      throwProtect: this.throwProtect,
      pauseTimer: this.pauseTimer,
      moveContact: this.moveContact,
      attackId: this.attackId,
      hitKey: this.hitKey,
      hitDone: this.hitDone,
      comboHits: this.comboHits,
      comboDamage: this.comboDamage,
      comboTimer: this.comboTimer,
      comboMoves: this.comboMoves.slice(),
      driveCancels: this.driveCancels,
      boundTo: this.boundTo,
      bindX: this.bindX,
      bindY: this.bindY,
      bindTimer: this.bindTimer,
      jumpArc: this.jumpArc,
      inputLog: Array.from(this.inputLog),
      inputHead: this.inputHead,
      inputCount: this.inputCount,
      noCommands: this.noCommands,
      noGuard: this.noGuard,
      ko: this.ko,
      gauges: this.gauges.save(),
      sm: this.sm.save(),
    };
  }

  load(s: FighterState): void {
    this.x = s.x;
    this.y = s.y;
    this.vx = s.vx;
    this.vy = s.vy;
    this.facing = s.facing as 1 | -1;
    this.prevStateNo = s.prevStateNo;
    this.stateTime = s.stateTime;
    this.animFrame = s.animFrame;
    this.health = s.health;
    this.hitstop = s.hitstop;
    this.shake = s.shake;
    this.hitstun = s.hitstun;
    this.blockstun = s.blockstun;
    this.juggle = s.juggle;
    this.throwProtect = s.throwProtect;
    this.pauseTimer = s.pauseTimer;
    this.moveContact = s.moveContact;
    this.attackId = s.attackId;
    this.hitKey = s.hitKey;
    this.hitDone = s.hitDone;
    this.comboHits = s.comboHits;
    this.comboDamage = s.comboDamage;
    this.comboTimer = s.comboTimer;
    this.comboMoves = s.comboMoves.slice();
    this.driveCancels = s.driveCancels;
    this.boundTo = s.boundTo;
    this.bindX = s.bindX;
    this.bindY = s.bindY;
    this.bindTimer = s.bindTimer;
    this.jumpArc = s.jumpArc;
    this.inputLog.set(s.inputLog);
    this.inputHead = s.inputHead;
    this.inputCount = s.inputCount;
    this.noCommands = s.noCommands;
    this.noGuard = s.noGuard;
    this.ko = s.ko;
    this.gauges.load(s.gauges);
    this.sm.load(s.sm);
    // The state fields are derived, not stored: restoring the state def is
    // enough to put posture, physics and control back where they were.
    this.stateNo = s.stateNo;
    this.stateType = this.sm.def.type;
    this.moveType = this.sm.def.moveType;
    this.physics = this.sm.def.physics;
    this.ctrl = this.sm.def.ctrl;
    this.anim = this.sm.def.anim;
    this.rebuildInputBuffer();
    this.refreshBoxes();
  }

  /** Everything that must match, bit for bit, for two runs to be identical. */
  hashInto(h: { mix(v: number): void }): void {
    h.mix(q(this.x));
    h.mix(q(this.y));
    h.mix(q(this.vx));
    h.mix(q(this.vy));
    h.mix(this.facing);
    h.mix(this.stateNo);
    h.mix(this.stateTime);
    h.mix(this.health);
    h.mix(this.hitstop);
    h.mix(this.hitstun);
    h.mix(this.blockstun);
    h.mix(this.juggle);
    h.mix(this.comboHits);
    h.mix(this.comboDamage);
    h.mix(Math.round(this.gauges.power));
    h.mix(Math.round(this.gauges.drive));
    h.mix(Math.round(this.gauges.guard));
    h.mix(this.gauges.hdTimer);
    h.mix(this.attackId);
    h.mix(this.hitDone);
  }
}

/** Quantise a float to 1/100 mm so the hash is stable but not brittle. */
function q(v: number): number {
  return Math.round(v * 100000);
}
