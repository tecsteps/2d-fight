/**
 * Input buffer and motion-command parser.
 *
 * Directions use numpad notation relative to the *facing* direction, so a
 * command is authored once ("236A") and works on both sides:
 *
 *     7 8 9        up-back    up    up-fwd
 *     4 5 6   =>   back      neutral  fwd
 *     1 2 3        down-back  down  down-fwd
 *
 * Recognition walks the buffer backwards from the current frame looking for the
 * motion's beats in reverse order. Each beat may be separated by at most
 * `slack` frames, which is what makes a real player's sloppy quarter-circle
 * read as a quarter-circle. Charge moves are handled separately since they care
 * about how *long* a direction was held rather than the order of taps.
 */

export const enum Btn {
  A = 1 << 0, // light punch
  B = 1 << 1, // light kick
  C = 1 << 2, // heavy punch
  D = 1 << 3, // heavy kick
  Start = 1 << 4,
}

export const ALL_BUTTONS: readonly Btn[] = [Btn.A, Btn.B, Btn.C, Btn.D];

/** One frame of raw input, stored facing-agnostic (absolute left/right). */
export interface InputFrame {
  /** Absolute direction, numpad notation with 5 = neutral. */
  dir: number;
  /** Bitmask of held buttons. */
  buttons: number;
}

/** How many frames of history the buffer keeps. ~1.3 s at 60 Hz. */
const BUFFER_SIZE = 80;

/** Mirror a numpad direction across the vertical axis. */
export function mirrorDir(dir: number): number {
  switch (dir) {
    case 1: return 3;
    case 3: return 1;
    case 4: return 6;
    case 6: return 4;
    case 7: return 9;
    case 9: return 7;
    default: return dir;
  }
}

/** Does `dir` satisfy `want`? `want` may be a "loose" direction. */
function dirMatches(dir: number, want: number): boolean {
  if (dir === want) return true;
  // Diagonals satisfy their cardinal components, which is what makes a
  // quarter-circle forgiving: 3 counts as both "down" and "forward".
  switch (want) {
    case 2: return dir === 1 || dir === 3;
    case 4: return dir === 1 || dir === 7;
    case 6: return dir === 3 || dir === 9;
    case 8: return dir === 7 || dir === 9;
    default: return false;
  }
}

export interface MotionSpec {
  /** Beats in input order, e.g. [2,3,6] for a quarter-circle forward. */
  readonly beats: readonly number[];
  /** Max frames allowed between consecutive beats. */
  readonly slack: number;
  /** Total frames the whole motion may span. */
  readonly window: number;
}

/** Canonical motions, authored facing-relative. */
export const Motion = {
  QCF: { beats: [2, 3, 6], slack: 8, window: 20 },
  QCB: { beats: [2, 1, 4], slack: 8, window: 20 },
  DP: { beats: [6, 2, 3], slack: 10, window: 24 },
  RDP: { beats: [4, 2, 1], slack: 10, window: 24 },
  HCF: { beats: [4, 1, 2, 3, 6], slack: 8, window: 32 },
  HCB: { beats: [6, 3, 2, 1, 4], slack: 8, window: 32 },
  QCFx2: { beats: [2, 3, 6, 2, 3, 6], slack: 9, window: 42 },
  QCBx2: { beats: [2, 1, 4, 2, 1, 4], slack: 9, window: 42 },
  /** KOF's "pretzel" — the classic Iori/Geese-style super motion. */
  HCBF: { beats: [6, 3, 2, 1, 4, 6], slack: 9, window: 40 },
} as const satisfies Record<string, MotionSpec>;

export class InputBuffer {
  /** Ring buffer of the last BUFFER_SIZE frames, newest at `head`. */
  private frames: InputFrame[] = [];
  private head = 0;
  private filled = 0;

  /** +1 when this player faces right, -1 when facing left. */
  facing: 1 | -1 = 1;

  constructor() {
    for (let i = 0; i < BUFFER_SIZE; i++) this.frames.push({ dir: 5, buttons: 0 });
  }

  reset(): void {
    for (const f of this.frames) {
      f.dir = 5;
      f.buttons = 0;
    }
    this.head = 0;
    this.filled = 0;
  }

  /** Push one frame of absolute input. Call exactly once per sim tick. */
  push(dir: number, buttons: number): void {
    this.head = (this.head + 1) % BUFFER_SIZE;
    const f = this.frames[this.head];
    f.dir = dir;
    f.buttons = buttons;
    if (this.filled < BUFFER_SIZE) this.filled++;
  }

  /** Frame `age` ticks ago (0 = this frame), facing-relative. */
  at(age: number): InputFrame {
    const idx = (this.head - age + BUFFER_SIZE * 2) % BUFFER_SIZE;
    const raw = this.frames[idx];
    return this.facing === 1 ? raw : { dir: mirrorDir(raw.dir), buttons: raw.buttons };
  }

  /** Facing-relative direction this frame. */
  get dir(): number {
    return this.at(0).dir;
  }

  get buttons(): number {
    return this.at(0).buttons;
  }

  held(btn: number): boolean {
    return (this.at(0).buttons & btn) !== 0;
  }

  /** Was `btn` pressed within the last `window` frames (rising edge)? */
  pressed(btn: number, window = 1): boolean {
    for (let age = 0; age < window; age++) {
      const now = this.at(age).buttons & btn;
      const prev = this.at(age + 1).buttons & btn;
      if (now && !prev) return true;
    }
    return false;
  }

  /** Was `btn` released within the last `window` frames (falling edge)? */
  released(btn: number, window = 1): boolean {
    for (let age = 0; age < window; age++) {
      const now = this.at(age).buttons & btn;
      const prev = this.at(age + 1).buttons & btn;
      if (!now && prev) return true;
    }
    return false;
  }

  /** How many consecutive frames `dir` has been held, up to the buffer size. */
  heldDirFrames(want: number): number {
    let n = 0;
    while (n < this.filled && dirMatches(this.at(n).dir, want)) n++;
    return n;
  }

  /**
   * Has `motion` completed within the last `lenience` frames?
   *
   * Walks beats in reverse from a recent anchor so that pressing the button a
   * few frames after finishing the motion still registers.
   */
  motion(spec: MotionSpec, lenience = 4): boolean {
    for (let anchor = 0; anchor < lenience; anchor++) {
      if (this.matchFrom(spec, anchor)) return true;
    }
    return false;
  }

  private matchFrom(spec: MotionSpec, anchor: number): boolean {
    const { beats, slack, window } = spec;
    let age = anchor;
    let beat = beats.length - 1;

    // The final beat must be satisfied at (or very near) the anchor.
    if (!dirMatches(this.at(age).dir, beats[beat])) return false;
    beat--;

    while (beat >= 0) {
      let stepped = 0;
      // Skip frames still showing the beat we just matched.
      while (
        age + 1 - anchor < window &&
        stepped <= slack &&
        dirMatches(this.at(age + 1).dir, beats[beat + 1])
      ) {
        age++;
        stepped++;
      }
      // Then look back up to `slack` frames for the previous beat.
      let found = false;
      for (let k = 0; k <= slack; k++) {
        const a = age + 1 + k;
        if (a - anchor >= window || a >= this.filled) break;
        if (dirMatches(this.at(a).dir, beats[beat])) {
          age = a;
          found = true;
          break;
        }
      }
      if (!found) return false;
      beat--;
    }
    return true;
  }

  /**
   * Charge command: `hold` held for `charge` frames, then `release` pressed
   * within `window` frames. Used for Guile/Kyo-style charge specials.
   */
  charge(hold: number, release: number, chargeFrames = 40, window = 12): boolean {
    for (let age = 0; age < window; age++) {
      if (!dirMatches(this.at(age).dir, release)) continue;
      let n = 0;
      let a = age + 1;
      while (a < this.filled && dirMatches(this.at(a).dir, hold)) {
        n++;
        a++;
        if (n >= chargeFrames) return true;
      }
    }
    return false;
  }
}

/** Keyboard → InputFrame. Two local players share one keyboard by default. */
export class KeyboardSource {
  private down = new Set<string>();
  private readonly map: Record<string, string>;

  constructor(map: Record<string, string>) {
    this.map = map;
    window.addEventListener('keydown', this.onDown, { passive: false });
    window.addEventListener('keyup', this.onUp, { passive: false });
    window.addEventListener('blur', this.onBlur);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    window.removeEventListener('blur', this.onBlur);
  }

  private onDown = (e: KeyboardEvent): void => {
    if (this.map[e.code]) e.preventDefault();
    this.down.add(e.code);
  };

  private onUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  /** Dropping every key on blur avoids "stuck forward" when tabbing away. */
  private onBlur = (): void => {
    this.down.clear();
  };

  private action(name: string): boolean {
    for (const code in this.map) {
      if (this.map[code] === name && this.down.has(code)) return true;
    }
    return false;
  }

  /** Sample current state into an absolute InputFrame. */
  sample(): InputFrame {
    const up = this.action('up');
    const dn = this.action('down');
    const lf = this.action('left');
    const rt = this.action('right');

    // Simultaneous opposites cancel — matches arcade SOCD "neutral" handling.
    const h = lf && rt ? 0 : lf ? -1 : rt ? 1 : 0;
    const v = up && dn ? 0 : dn ? -1 : up ? 1 : 0;
    const dir = 5 + h + v * 3;

    let buttons = 0;
    if (this.action('a')) buttons |= Btn.A;
    if (this.action('b')) buttons |= Btn.B;
    if (this.action('c')) buttons |= Btn.C;
    if (this.action('d')) buttons |= Btn.D;
    if (this.action('start')) buttons |= Btn.Start;

    return { dir, buttons };
  }
}

export const P1_KEYS: Record<string, string> = {
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
  KeyJ: 'a', KeyK: 'b', KeyU: 'c', KeyI: 'd', Enter: 'start',
};

export const P2_KEYS: Record<string, string> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Numpad1: 'a', Numpad2: 'b', Numpad4: 'c', Numpad5: 'd', NumpadEnter: 'start',
};
