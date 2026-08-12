import type { InputFrame } from '../core/Input';
import { simRNG } from '../core/RNG';
import { S } from '../data/moves/build';
import {
  FIGHT_FRAMES,
  INTRO_FRAMES,
  KO_FRAMES,
  KO_SLOWMO_FRAMES,
  READY_FRAMES,
  ROUNDS_TO_WIN,
  ROUND_COUNTS,
  ROUND_END_FRAMES,
  ROUND_HEAL_FRACTION,
  TICKS_PER_COUNT,
} from '../data/moves/tuning';
import { fighterById, type FighterDef } from '../data/roster';
import { boxDebug } from './Boxes';
import { Combat, type ContactEvent } from './Combat';
import { Fighter, type FighterState, type FightWorld } from './Fighter';
import { DEFAULT_STAGE, clampSeparation, separate, type StageBounds } from './Physics';

/**
 * Round and match flow.
 *
 * `Match` owns the two active fighters, the clock, and the phase machine that
 * runs intro → ready → fight → active → KO → round end. It is also the fight's
 * `FightWorld`: the thing a super asks to stop time.
 *
 * ## Team mode
 *
 * KOF is a 3v3 game and the team rules are load-bearing, not decoration. A
 * round ends when one character is knocked out, not when a team is; the loser
 * sends in their next character at full health while **the winner keeps
 * whatever health they had left**, plus a small recovery. Power gauge is a team
 * resource and carries across the swap. That asymmetry is why order selection
 * matters and why a comeback with one character left is the format's whole
 * emotional shape.
 *
 * ## Determinism
 *
 * `tick(inputs)` is the only entry point and the only source of time. Nothing
 * in here reads the wall clock; the KO slow-motion is expressed as "skip the
 * fighter update on odd ticks" rather than as a time scale, so a replay of the
 * same input stream produces the same frames.
 */

export enum Phase {
  /** Characters walking on. */
  Intro = 0,
  Ready = 1,
  /** "FIGHT!" — control is live from the first frame of this phase. */
  Fight = 2,
  Active = 3,
  KO = 4,
  RoundEnd = 5,
  MatchEnd = 6,
}

export interface TeamSetup {
  /** One to three roster ids, in play order. */
  members: readonly string[];
}

export interface MatchOptions {
  teams: readonly [TeamSetup, TeamSetup];
  stage?: StageBounds;
  seed?: number;
  /** Rounds one side must take in a 1v1 set. Ignored when a team has 3 members. */
  roundsToWin?: number;
  /** Starting distance between the two marks, in metres. */
  startSeparation?: number;
}

export interface MatchState {
  tick: number;
  phase: Phase;
  phaseTime: number;
  timer: number;
  round: number;
  roundsWon: [number, number];
  activeIdx: [number, number];
  teamPower: [number, number];
  flashTimer: number;
  lastWinner: number;
  fighters: FighterState[][];
  rng: Uint32Array;
}

export class Match implements FightWorld {
  readonly stage: StageBounds;
  /** All characters on both teams, in play order. */
  readonly roster: [Fighter[], Fighter[]];

  tick = 0;
  phase: Phase = Phase.Intro;
  phaseTime = 0;
  /** Ticks left on the round clock. */
  timer = ROUND_COUNTS * TICKS_PER_COUNT;
  round = 1;
  roundsWon: [number, number] = [0, 0];
  /** -1 while the round is live; 0/1 for the winner; 2 for a draw. */
  lastWinner = -1;
  matchWinner = -1;

  /** Frames of super-flash freeze left. */
  flashTimer = 0;
  flashSource = -1;

  readonly combat = new Combat();

  private readonly activeIdx: [number, number] = [0, 0];
  /** Power gauge is a team resource in KOF, so it survives a character swap. */
  private readonly teamPower: [number, number] = [0, 0];
  private readonly roundsToWin: number;
  private readonly startSeparation: number;
  private readonly teamMode: boolean;

  constructor(opts: MatchOptions) {
    this.stage = opts.stage ?? DEFAULT_STAGE;
    this.startSeparation = opts.startSeparation ?? 2.6;
    simRNG.seed(opts.seed ?? 0x5f3a91c);

    this.roster = [
      opts.teams[0].members.map((id) => new Fighter(defOf(id), 0, 0)),
      opts.teams[1].members.map((id) => new Fighter(defOf(id), 1, 1)),
    ];
    this.teamMode = this.roster[0].length > 1 || this.roster[1].length > 1;
    this.roundsToWin = opts.roundsToWin ?? ROUNDS_TO_WIN;

    for (const team of this.roster) {
      for (const f of team) f.world = this;
    }
    this.beginRound(true);
  }

  get p1(): Fighter {
    return this.roster[0][this.activeIdx[0]];
  }

  get p2(): Fighter {
    return this.roster[1][this.activeIdx[1]];
  }

  get fighters(): [Fighter, Fighter] {
    return [this.p1, this.p2];
  }

  /** Contacts raised this tick. Cleared at the start of every combat pass. */
  get events(): readonly ContactEvent[] {
    return this.combat.events;
  }

  /** Round clock as the HUD shows it. */
  get displayTime(): number {
    return Math.ceil(this.timer / TICKS_PER_COUNT);
  }

  /** Characters left standing on each team, including the active one. */
  remaining(team: number): number {
    return this.roster[team].length - this.activeIdx[team];
  }

  /* ---------------------------------------------------------------- *
   * FightWorld
   * ---------------------------------------------------------------- */

  flash(frames: number, source: Fighter): void {
    this.flashTimer = Math.max(this.flashTimer, frames);
    this.flashSource = source.slot;
    // Both fighters stop. The attacker's own move does not advance either —
    // the flash is a held pose, and the move starts when the screen comes back.
    for (const f of this.fighters) f.pauseTimer = Math.max(f.pauseTimer, frames);
  }

  /* ---------------------------------------------------------------- *
   * The tick
   * ---------------------------------------------------------------- */

  /**
   * Advance exactly one 1/60 s frame.
   *
   * Fixed order, and the order is the specification:
   *   1. inputs in
   *   2. phase machine
   *   3. both fighters update independently
   *   4. push-out and the screen leash, applied symmetrically
   *   5. boxes rebuilt at final positions
   *   6. combat resolved from one shared snapshot
   *   7. KO / time-over checks
   */
  step(inputs: readonly [InputFrame, InputFrame]): void {
    this.tick++;
    boxDebug.begin();

    const fs = this.fighters;
    for (let i = 0; i < 2; i++) fs[i].pushInput(inputs[i].dir, inputs[i].buttons);

    if (this.flashTimer > 0) this.flashTimer--;

    this.advancePhase();

    if (this.simRunning()) {
      fs[0].update(this.stage);
      fs[1].update(this.stage);

      separate(fs[0], fs[1], this.stage);
      clampSeparation(fs[0], fs[1], this.stage);
      fs[0].refreshBoxes();
      fs[1].refreshBoxes();

      this.combat.step(fs[0], fs[1], this.stage);
    } else {
      this.combat.events.length = 0;
    }

    if (this.phase === Phase.Active || this.phase === Phase.Fight) {
      if (this.phase === Phase.Active && this.timer > 0) this.timer--;
      this.checkRoundOver();
    }
  }

  /** Should the fight itself advance this tick? */
  private simRunning(): boolean {
    switch (this.phase) {
      case Phase.Fight:
      case Phase.Active:
        return true;
      case Phase.KO:
        // Deterministic half speed: the KO plays back on even ticks only.
        return (this.tick & 1) === 0 || this.phaseTime > KO_SLOWMO_FRAMES;
      case Phase.RoundEnd:
        return true;
      default:
        return false;
    }
  }

  private advancePhase(): void {
    this.phaseTime++;
    switch (this.phase) {
      case Phase.Intro:
        if (this.phaseTime >= INTRO_FRAMES) this.setPhase(Phase.Ready);
        break;
      case Phase.Ready:
        if (this.phaseTime >= READY_FRAMES) this.setPhase(Phase.Fight);
        break;
      case Phase.Fight:
        if (this.phaseTime >= FIGHT_FRAMES) this.setPhase(Phase.Active);
        break;
      case Phase.KO:
        if (this.phaseTime >= KO_FRAMES) this.setPhase(Phase.RoundEnd);
        break;
      case Phase.RoundEnd:
        if (this.phaseTime >= ROUND_END_FRAMES) this.nextRound();
        break;
      default:
        break;
    }
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.phaseTime = 0;
    const fs = this.fighters;
    switch (p) {
      case Phase.Ready:
        for (const f of fs) {
          f.sm.changeState(S.STAND);
          f.noCommands = true;
        }
        break;
      case Phase.Fight:
        for (const f of fs) f.noCommands = false;
        break;
      case Phase.RoundEnd:
        for (const f of fs) {
          f.noCommands = true;
          if (!f.ko && this.lastWinner === f.team) f.enterWinPose();
        }
        break;
      default:
        break;
    }
  }

  /* ---------------------------------------------------------------- *
   * Round resolution
   * ---------------------------------------------------------------- */

  private checkRoundOver(): void {
    const [a, b] = this.fighters;
    const aDown = a.health <= 0;
    const bDown = b.health <= 0;

    if (aDown || bDown) {
      // Both at zero on the same tick is a double KO, and the trade rule in
      // `Combat` means that genuinely happens.
      this.lastWinner = aDown && bDown ? 2 : aDown ? 1 : 0;
      if (aDown) a.enterKO();
      if (bDown) b.enterKO();
      this.setPhase(Phase.KO);
      return;
    }

    if (this.timer <= 0) {
      const fa = a.health / a.maxHealth;
      const fb = b.health / b.maxHealth;
      this.lastWinner = fa === fb ? 2 : fa > fb ? 0 : 1;
      // Time over is still a KO for whoever was behind — they play the same
      // fall, which is what makes a timeout read as a loss and not a shrug.
      if (this.lastWinner === 0) b.enterKO();
      else if (this.lastWinner === 1) a.enterKO();
      this.setPhase(Phase.KO);
    }
  }

  private nextRound(): void {
    const winner = this.lastWinner;
    // Meter is banked before the swap, while the outgoing character still owns
    // it — in KOF the gauge belongs to the team, not the body holding it.
    this.teamPower[0] = this.p1.gauges.power;
    this.teamPower[1] = this.p2.gauges.power;

    if (this.teamMode) {
      // A round costs the loser a character. A draw costs both.
      if (winner === 2) {
        this.activeIdx[0]++;
        this.activeIdx[1]++;
      } else if (winner === 0) {
        this.activeIdx[1]++;
      } else if (winner === 1) {
        this.activeIdx[0]++;
      }
      const out0 = this.activeIdx[0] >= this.roster[0].length;
      const out1 = this.activeIdx[1] >= this.roster[1].length;
      if (out0 || out1) {
        this.matchWinner = out0 && out1 ? 2 : out0 ? 1 : 0;
        this.setPhase(Phase.MatchEnd);
        return;
      }
    } else {
      if (winner === 2) {
        this.roundsWon[0]++;
        this.roundsWon[1]++;
      } else if (winner >= 0) {
        this.roundsWon[winner]++;
      }
      const w0 = this.roundsWon[0] >= this.roundsToWin;
      const w1 = this.roundsWon[1] >= this.roundsToWin;
      if (w0 || w1) {
        this.matchWinner = w0 && w1 ? 2 : w0 ? 0 : 1;
        this.setPhase(Phase.MatchEnd);
        return;
      }
    }

    this.round++;
    this.beginRound(false);
  }

  /**
   * Place both fighters and start the clock.
   *
   * The survivor keeps their health and gets a slice back; whoever was swapped
   * in arrives full. Meter belongs to the team either way.
   */
  private beginRound(first: boolean): void {
    if (first) {
      this.teamPower[0] = 0;
      this.teamPower[1] = 0;
    }

    const a = this.p1;
    const b = this.p2;
    a.opponent = b;
    b.opponent = a;

    const half = this.startSeparation * 0.5;
    a.resetForRound(-half, 1, first ? -1 : survivorHealth(a, this.lastWinner), this.teamPower[0]);
    b.resetForRound(half, -1, first ? -1 : survivorHealth(b, this.lastWinner), this.teamPower[1]);

    a.sm.changeState(S.INTRO);
    b.sm.changeState(S.INTRO);

    this.timer = ROUND_COUNTS * TICKS_PER_COUNT;
    this.lastWinner = -1;
    this.combat.events.length = 0;
    this.setPhase(Phase.Intro);
  }

  /* ---------------------------------------------------------------- *
   * Snapshot / restore
   * ---------------------------------------------------------------- */

  save(): MatchState {
    return {
      tick: this.tick,
      phase: this.phase,
      phaseTime: this.phaseTime,
      timer: this.timer,
      round: this.round,
      roundsWon: [this.roundsWon[0], this.roundsWon[1]],
      activeIdx: [this.activeIdx[0], this.activeIdx[1]],
      teamPower: [this.teamPower[0], this.teamPower[1]],
      flashTimer: this.flashTimer,
      lastWinner: this.lastWinner,
      fighters: this.roster.map((team) => team.map((f) => f.save())),
      rng: simRNG.save(),
    };
  }

  load(s: MatchState): void {
    this.tick = s.tick;
    this.phase = s.phase;
    this.phaseTime = s.phaseTime;
    this.timer = s.timer;
    this.round = s.round;
    this.roundsWon[0] = s.roundsWon[0];
    this.roundsWon[1] = s.roundsWon[1];
    this.activeIdx[0] = s.activeIdx[0];
    this.activeIdx[1] = s.activeIdx[1];
    this.teamPower[0] = s.teamPower[0];
    this.teamPower[1] = s.teamPower[1];
    this.flashTimer = s.flashTimer;
    this.lastWinner = s.lastWinner;
    for (let t = 0; t < 2; t++) {
      for (let i = 0; i < this.roster[t].length; i++) this.roster[t][i].load(s.fighters[t][i]);
    }
    const a = this.p1;
    const b = this.p2;
    a.opponent = b;
    b.opponent = a;
    simRNG.restore(s.rng);
  }

  /**
   * A 32-bit FNV-1a over everything that can differ between two runs. Two
   * simulations that agree on this after N ticks agree, full stop.
   */
  hash(): number {
    const h = new Hasher();
    h.mix(this.tick);
    h.mix(this.phase);
    h.mix(this.phaseTime);
    h.mix(this.timer);
    h.mix(this.round);
    h.mix(this.roundsWon[0]);
    h.mix(this.roundsWon[1]);
    h.mix(this.activeIdx[0]);
    h.mix(this.activeIdx[1]);
    h.mix(this.flashTimer);
    for (const team of this.roster) for (const f of team) f.hashInto(h);
    const rng = simRNG.save();
    for (let i = 0; i < rng.length; i++) h.mix(rng[i] | 0);
    return h.value >>> 0;
  }
}

class Hasher {
  value = 0x811c9dc5;
  mix(v: number): void {
    let x = v | 0;
    for (let i = 0; i < 4; i++) {
      this.value ^= x & 0xff;
      this.value = Math.imul(this.value, 0x01000193) >>> 0;
      x >>= 8;
    }
  }
}

function defOf(id: string): FighterDef {
  return fighterById(id);
}

function survivorHealth(f: Fighter, lastWinner: number): number {
  if (f.team !== lastWinner) return -1; // fresh character, or the loser's next
  const healed = f.health + f.maxHealth * ROUND_HEAL_FRACTION;
  return Math.min(f.maxHealth, healed);
}
