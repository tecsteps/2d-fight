import {
  COST_DRIVE_CANCEL,
  COST_HD,
  DRIVE_MAX,
  GUARD_CRUSH_REFUND,
  GUARD_MAX,
  GUARD_REGEN,
  GUARD_REGEN_DELAY,
  HD_CANCEL_COST,
  HD_DRAIN,
  HD_FRAMES,
  POWER_MAX,
  STOCK,
} from '../data/moves/tuning';

/**
 * KOF XIII's three meters.
 *
 * **Power gauge** — five stocks. It fills from almost everything you do: landing
 * hits, having them blocked, eating them, and throwing specials into thin air.
 * Stocks buy EX specials (1), Desperation Moves (1), MAX DMs (2) and the NeoMax
 * (3). Stocks are spent whole; there is no partial-stock move.
 *
 * **Drive gauge** — one bar, filled by connecting attacks. Half a bar Drive
 * Cancels a special into another special or a super mid-combo. A full bar buys
 * **HD mode**, which is where KOF XIII's identity lives: for a few seconds
 * every attack cancels into every other attack, at the price of a damage
 * penalty and a timer that each cancel shortens.
 *
 * **Guard gauge** — not shown as a bar in KOF, but the pressure model is the
 * same: blocking wears it down, letting go lets it recover, and running it out
 * breaks the guard wide open.
 *
 * All state here is plain numbers so the whole thing snapshots by value, which
 * is what rollback needs.
 */

export interface GaugeState {
  power: number;
  drive: number;
  guard: number;
  guardIdle: number;
  hdTimer: number;
  hdCancels: number;
  maxFlash: number;
}

export class Gauges {
  /** 0..POWER_MAX, in units. One stock is STOCK units. */
  power = 0;
  /** 0..DRIVE_MAX. */
  drive = 0;
  /** 0..GUARD_MAX. Reaching 0 crushes the guard. */
  guard = GUARD_MAX;
  /** Frames since the last blocked hit, gating guard regeneration. */
  guardIdle = GUARD_REGEN_DELAY;
  /** Frames of HD mode left. 0 = not in HD. */
  hdTimer = 0;
  /** HD cancels used this activation, for the UI and for combo-length pacing. */
  hdCancels = 0;
  /** Frames of "MAX" flash left after a stock fills — purely a UI cue. */
  maxFlash = 0;

  get stocks(): number {
    return Math.floor(this.power / STOCK);
  }

  get hdActive(): boolean {
    return this.hdTimer > 0;
  }

  /** Fraction of the current partial stock, for the HUD's ticking segment. */
  get stockFraction(): number {
    return (this.power % STOCK) / STOCK;
  }

  reset(carryPower = 0, carryDrive = 0): void {
    this.power = clamp(carryPower, 0, POWER_MAX);
    this.drive = clamp(carryDrive, 0, DRIVE_MAX);
    this.guard = GUARD_MAX;
    this.guardIdle = GUARD_REGEN_DELAY;
    this.hdTimer = 0;
    this.hdCancels = 0;
    this.maxFlash = 0;
  }

  addPower(units: number): void {
    if (units <= 0) return;
    const before = this.stocks;
    this.power = Math.min(POWER_MAX, this.power + units);
    if (this.stocks > before) this.maxFlash = 24;
  }

  hasPower(units: number): boolean {
    return this.power >= units;
  }

  spendPower(units: number): boolean {
    if (this.power < units) return false;
    this.power -= units;
    return true;
  }

  addDrive(units: number): void {
    if (units <= 0) return;
    // HD is already spending the bar; topping it up mid-mode would make the
    // mode self-sustaining, which is exactly the degenerate case KOF avoids.
    if (this.hdActive) return;
    this.drive = Math.min(DRIVE_MAX, this.drive + units);
  }

  canDriveCancel(): boolean {
    return this.hdActive || this.drive >= COST_DRIVE_CANCEL;
  }

  /**
   * Pay for a cancel that the tier ladder would otherwise forbid. Inside HD the
   * price is timer, not bar, which is why an HD combo has a natural length.
   */
  payDriveCancel(): boolean {
    if (this.hdActive) {
      this.hdTimer = Math.max(1, this.hdTimer - HD_CANCEL_COST);
      this.hdCancels++;
      return true;
    }
    if (this.drive < COST_DRIVE_CANCEL) return false;
    this.drive -= COST_DRIVE_CANCEL;
    return true;
  }

  canActivateHD(): boolean {
    return !this.hdActive && this.drive >= COST_HD;
  }

  activateHD(): boolean {
    if (!this.canActivateHD()) return false;
    this.drive = 0;
    this.hdTimer = HD_FRAMES;
    this.hdCancels = 0;
    return true;
  }

  /** Guard gauge damage from a blocked hit. Returns true if the guard broke. */
  damageGuard(amount: number): boolean {
    this.guardIdle = 0;
    this.guard -= amount;
    if (this.guard > 0) return false;
    this.guard = GUARD_CRUSH_REFUND;
    return true;
  }

  /** Once per tick, after state logic. Hitstop must not advance any of this. */
  tick(): void {
    if (this.hdTimer > 0) {
      this.hdTimer--;
      // Draining the bar in step with the timer gives the HUD one number to
      // draw for both, and leaves the bar empty exactly when the mode ends.
      this.drive = Math.max(0, this.drive - HD_DRAIN);
      if (this.hdTimer === 0) this.drive = 0;
    }
    if (this.maxFlash > 0) this.maxFlash--;

    if (this.guardIdle < GUARD_REGEN_DELAY) {
      this.guardIdle++;
    } else if (this.guard < GUARD_MAX) {
      this.guard = Math.min(GUARD_MAX, this.guard + GUARD_REGEN);
    }
  }

  save(): GaugeState {
    return {
      power: this.power,
      drive: this.drive,
      guard: this.guard,
      guardIdle: this.guardIdle,
      hdTimer: this.hdTimer,
      hdCancels: this.hdCancels,
      maxFlash: this.maxFlash,
    };
  }

  load(s: GaugeState): void {
    this.power = s.power;
    this.drive = s.drive;
    this.guard = s.guard;
    this.guardIdle = s.guardIdle;
    this.hdTimer = s.hdTimer;
    this.hdCancels = s.hdCancels;
    this.maxFlash = s.maxFlash;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
