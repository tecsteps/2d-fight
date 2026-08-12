import { Btn } from '../core/Input';
import { COST_DRIVE_CANCEL } from '../data/moves/tuning';
import {
  AttackTier,
  CancelPay,
  MoveType,
  PhysicsMode,
  StateType,
  type CommandDef,
  type MoveList,
  type MoveRequire,
  type StateDef,
} from './contract';
import { dirSatisfies, matchMotion } from './Motion';
import type { Fighter } from './Fighter';

/**
 * The CNS-shaped state system.
 *
 * A fighter is always in exactly one numbered state. A state declares its
 * posture, its move type, which integrator runs, whether the player has
 * control, how long it lasts and what follows it — and optionally three
 * callbacks. That is the whole vocabulary; everything else the game does is
 * expressed as data in `src/data/moves`.
 *
 * ## Tick order inside a state
 *
 * 1. If the state's duration has elapsed, fall through to `next`.
 * 2. Poll commands. A command that cannot run yet is buffered for a few frames.
 * 3. Run `onTick` for whatever state we are now in.
 * 4. Advance `stateTime`.
 *
 * Frame 0 of a state is the frame it was entered on, so a move with 4 frames of
 * startup becomes active on the fourth frame after the button, which is what
 * "4f startup" means to a player.
 *
 * ## The cancel ladder
 *
 *     normal → command normal → special → EX → super → NeoMax
 *
 * A connected move may always be cancelled into something strictly higher.
 * Lights additionally chain into each other and into themselves. Going sideways
 * or backwards down the ladder is only possible by paying: half the Drive gauge
 * for a Drive Cancel, or HD timer for an HD cancel — and inside HD mode
 * *everything* cancels into everything, which is the mode's entire point.
 *
 * Whiff cancels are a separate permission: a move marked whiff-cancellable can
 * buy a special even when it touched nothing, while everything else has to
 * actually connect first.
 */

/** How many frames a command that could not run stays queued. */
const COMMAND_BUFFER = 4;
/** Frames of recovery past the last active frame that cancels stay legal. */
const CANCEL_TAIL = 6;

export class StateMachine {
  readonly owner: Fighter;
  moves: MoveList;
  def: StateDef;
  prevDef: StateDef;

  /** Index into `moves.commands` of a command waiting for a legal moment. */
  buffered = -1;
  bufferedFrames = 0;

  constructor(owner: Fighter, moves: MoveList, startState: number) {
    this.owner = owner;
    this.moves = moves;
    this.def = this.lookup(startState);
    this.prevDef = this.def;
    this.applyStateFields(this.def);
  }

  lookup(id: number): StateDef {
    const d = this.moves.states.get(id);
    if (!d) throw new Error(`${this.moves.id}: no state ${id}`);
    return d;
  }

  has(id: number): boolean {
    return this.moves.states.has(id);
  }

  /**
   * Enter a state. Velocity survives unless the state declares an `enterVel`;
   * fighting games depend on that — a jump attack keeps the jump's momentum.
   */
  changeState(id: number, keepStateTime = false): void {
    const f = this.owner;
    const next = this.lookup(id);
    this.def.onExit?.(f);
    this.prevDef = this.def;
    f.prevStateNo = f.stateNo;
    this.def = next;
    f.stateNo = id;
    if (!keepStateTime) f.stateTime = 0;
    this.applyStateFields(next);

    if (next.moveType === MoveType.Attack) {
      // Every activation gets a fresh identity so `hitOnce` bookkeeping and the
      // per-move damage penalty can tell one swing from the next.
      f.attackId++;
      f.moveContact = 0;
    }
    if (next.enterVel) {
      f.vx = f.facing * next.enterVel[0];
      f.vy = next.enterVel[1];
    }
    next.onEnter?.(f);
  }

  private applyStateFields(d: StateDef): void {
    const f = this.owner;
    f.stateType = d.type;
    f.moveType = d.moveType;
    f.physics = d.physics;
    f.ctrl = d.ctrl;
    f.anim = d.anim;
    f.animFrame = 0;
  }

  /** Runs once per tick, after hitstop has been cleared. */
  tick(): void {
    const f = this.owner;

    if (this.def.duration >= 0 && f.stateTime >= this.def.duration) {
      this.changeState(this.def.next);
    }

    if (this.bufferedFrames > 0) this.bufferedFrames--;
    else this.buffered = -1;

    this.poll();

    this.def.onTick?.(f);
    f.stateTime++;
    f.animFrame++;
  }

  /* -------------------------------------------------------------- *
   * Cancels
   * -------------------------------------------------------------- */

  /** The window, in state frames, during which this state accepts cancels. */
  private cancelWindow(d: StateDef): { from: number; to: number } {
    const rule = d.cancel;
    if (rule?.window) return rule.window;
    const act = d.active;
    if (!act || act.length === 0) return { from: 0, to: -1 };
    return { from: act[0].from, to: act[act.length - 1].to + CANCEL_TAIL };
  }

  /**
   * May the fighter leave the current state for `target` right now, and what
   * does it cost? This is the single authority on the cancel ladder.
   */
  canCancelInto(target: StateDef): CancelPay {
    const f = this.owner;
    const cur = this.def;

    // With control there is nothing to cancel — this is just starting a move.
    if (f.ctrl && cur.moveType !== MoveType.Attack) return CancelPay.Free;
    if (cur.moveType !== MoveType.Attack) return CancelPay.No;

    const rule = cur.cancel;
    if (!rule || rule.locked) return CancelPay.No;

    const win = this.cancelWindow(cur);
    if (f.stateTime < win.from || f.stateTime > win.to) return CancelPay.No;

    const targetTier = target.attack?.tier ?? target.throw?.tier ?? AttackTier.None;
    if (targetTier === AttackTier.None) return CancelPay.No;
    const curTier = cur.attack?.tier ?? cur.throw?.tier ?? AttackTier.None;

    const contacted = f.moveContact !== 0;

    // Free: strictly up the ladder, and only as high as the rule permits.
    const minTier = contacted ? rule.onContact : rule.onWhiff;
    if (minTier !== AttackTier.None && targetTier >= minTier && targetTier > curTier) {
      return CancelPay.Free;
    }
    // Free: an explicit chain, which is how rapid-fire lights work.
    if (contacted && rule.chain && rule.chain.indexOf(target.id) >= 0) {
      if (target.id !== cur.id || rule.self) return CancelPay.Free;
    }

    if (!contacted) return CancelPay.No;

    // Paid. HD mode first — inside HD every attack cancels into every attack.
    if (f.gauges.hdActive && targetTier >= AttackTier.Special) return CancelPay.HD;
    if (
      curTier >= AttackTier.Special &&
      targetTier >= AttackTier.Special &&
      f.gauges.drive >= COST_DRIVE_CANCEL
    ) {
      return CancelPay.Drive;
    }
    return CancelPay.No;
  }

  /* -------------------------------------------------------------- *
   * Commands
   * -------------------------------------------------------------- */

  private poll(): void {
    const f = this.owner;
    if (f.noCommands) return;

    // A command that was legal-but-blocked when it was entered gets first
    // refusal, so a special buffered during blockstun comes out on wake-up.
    if (this.buffered >= 0) {
      const cmd = this.moves.commands[this.buffered];
      if (this.tryExecute(cmd)) {
        this.buffered = -1;
        this.bufferedFrames = 0;
        return;
      }
    }

    const cmds = this.moves.commands;
    for (let i = 0; i < cmds.length; i++) {
      const cmd = cmds[i];
      if (!this.inputMatches(cmd)) continue;
      // A command whose requirements fail is not this player's input at all —
      // 6+C out of throw range is a heavy punch, so keep looking.
      if (!this.requirementsMet(cmd.require)) continue;
      if (this.tryExecute(cmd)) {
        this.buffered = -1;
        this.bufferedFrames = 0;
        return;
      }
      // Right input, wrong moment — hold it briefly rather than eat it.
      this.buffered = i;
      this.bufferedFrames = COMMAND_BUFFER;
      return;
    }
  }

  private inputMatches(cmd: CommandDef): boolean {
    const inp = this.owner.input;

    if (cmd.buttons !== 0) {
      const window = cmd.window ?? 3;
      let fresh = false;
      for (let bit = 1; bit <= Btn.D; bit <<= 1) {
        if ((cmd.buttons & bit) === 0) continue;
        if (!inp.pressed(bit, window)) return false;
        if (inp.pressed(bit, 1)) fresh = true;
      }
      // The command fires on the frame the last button of the combination goes
      // down, so A+C is one command and never two.
      if (!fresh) return false;
    }

    if (cmd.dir !== undefined && !dirSatisfies(inp.dir, cmd.dir)) return false;

    if (cmd.motion && !matchMotion(inp, cmd.motion, cmd.lenience ?? 5)) return false;
    if (cmd.charge && !inp.charge(cmd.charge.hold, cmd.charge.release, cmd.charge.frames)) {
      return false;
    }
    return true;
  }

  private requirementsMet(req: MoveRequire | undefined): boolean {
    if (!req) return true;
    const f = this.owner;

    switch (req.stance) {
      case 'air':
        if (!f.airborne) return false;
        break;
      case 'ground':
        if (f.airborne) return false;
        break;
      case 'crouch':
        if (f.airborne || f.stateType !== StateType.Crouch) return false;
        break;
      case 'stand':
        if (f.airborne || f.stateType !== StateType.Stand) return false;
        break;
      default:
        break;
    }

    if (req.power !== undefined && !f.gauges.hasPower(req.power)) return false;
    if (req.drive !== undefined && f.gauges.drive < req.drive) return false;
    if (req.hdOnly && !f.gauges.hdActive) return false;
    if (req.notHD && f.gauges.hdActive) return false;
    if (req.guardOnly && f.blockstun <= 0) return false;
    if (req.test && !req.test(f)) return false;
    return true;
  }

  private tryExecute(cmd: CommandDef): boolean {
    const f = this.owner;
    if (!this.requirementsMet(cmd.require)) return false;
    if (!this.has(cmd.state)) return false;

    const target = this.lookup(cmd.state);

    // A guard cancel is not a cancel of an attack — it is an escape from
    // blockstun, and it is the one thing allowed to interrupt it.
    const fromBlockstun = cmd.require?.guardOnly === true;
    if (!fromBlockstun) {
      if (f.hitstun > 0 || f.blockstun > 0) return false;
      const pay = this.canCancelInto(target);
      if (pay === CancelPay.No) return false;
      if (pay === CancelPay.Drive || pay === CancelPay.HD) {
        if (!f.gauges.payDriveCancel()) return false;
        f.driveCancels++;
      }
    }

    if (cmd.require?.power) f.gauges.spendPower(cmd.require.power);
    if (cmd.require?.drive) f.gauges.drive -= cmd.require.drive;

    if (fromBlockstun) {
      f.blockstun = 0;
      f.hitstun = 0;
    }
    this.changeState(cmd.state);
    return true;
  }

  /* -------------------------------------------------------------- *
   * Queries the rest of the engine asks
   * -------------------------------------------------------------- */

  get attackTier(): AttackTier {
    return this.def.attack?.tier ?? this.def.throw?.tier ?? AttackTier.None;
  }

  /** Is the hitbox live this frame? */
  isActive(frame: number): boolean {
    const act = this.def.active;
    if (!act) return false;
    for (let i = 0; i < act.length; i++) {
      if (frame >= act[i].from && frame <= act[i].to) return true;
    }
    return false;
  }

  /** Which active window `frame` falls in, or -1. Multi-hit moves need this. */
  activeWindow(frame: number): number {
    const act = this.def.active;
    if (!act) return -1;
    for (let i = 0; i < act.length; i++) {
      if (frame >= act[i].from && frame <= act[i].to) return i;
    }
    return -1;
  }

  /** Invulnerability bits in force this frame. */
  invulnAt(frame: number): number {
    const w = this.def.invuln;
    if (!w) return 0;
    let bits = 0;
    for (let i = 0; i < w.length; i++) {
      if (frame >= w[i].from && frame <= w[i].to) bits |= w[i].bits;
    }
    return bits;
  }

  /** True while the fighter is in the part of a move a counter-hit punishes. */
  counterVulnerable(frame: number): boolean {
    if (this.def.moveType !== MoveType.Attack) return false;
    const act = this.def.active;
    if (!act || act.length === 0) return true;
    return frame <= act[act.length - 1].to;
  }

  get isAirState(): boolean {
    return this.def.physics === PhysicsMode.Air;
  }

  save(): { state: number; prev: number; buffered: number; bufferedFrames: number } {
    return {
      state: this.def.id,
      prev: this.prevDef.id,
      buffered: this.buffered,
      bufferedFrames: this.bufferedFrames,
    };
  }

  load(s: { state: number; prev: number; buffered: number; bufferedFrames: number }): void {
    this.def = this.lookup(s.state);
    this.prevDef = this.lookup(s.prev);
    this.buffered = s.buffered;
    this.bufferedFrames = s.bufferedFrames;
  }
}
