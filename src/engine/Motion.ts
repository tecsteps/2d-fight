import type { InputBuffer, MotionSpec } from '../core/Input';

/**
 * Motion-command recognition.
 *
 * The engine reads the buffer through `InputBuffer`'s public API but does its
 * own beat matching, because recognising a quarter-circle is subtler than it
 * looks and the subtlety is where fighting games are won or lost.
 *
 * The hard part is that **diagonals satisfy their cardinals**: down-forward is
 * both "down" and "forward", which is exactly the leniency a player needs, and
 * exactly what breaks a naive matcher. Walk a 236 backwards from the button and
 * the trailing 6 happily swallows the 3 that was supposed to be the middle
 * beat, and the motion never resolves.
 *
 * So we scan **forwards in time** instead — oldest frame in the window to
 * newest — and advance a beat cursor greedily. Each frame can satisfy at most
 * one beat, and because we move forward, a 3 is offered to the "3" beat before
 * the "6" beat ever sees it. On top of that:
 *
 * - `slack` bounds the gap between consecutive beats, so a 2 from a second ago
 *   cannot be the start of this quarter-circle. Overshoot restarts the attempt
 *   at the current frame rather than abandoning it.
 * - A **missing diagonal is forgiven**: keyboard players release down before
 *   pressing forward and never produce a 3 at all. One skipped diagonal beat
 *   between two matched cardinals still reads as the motion.
 * - `lenience` bounds how long ago the motion may have *finished*, which is the
 *   window a player has to press the button after the stick arrives.
 */

/** Does a held direction satisfy a wanted direction, diagonals included? */
export function dirSatisfies(dir: number, want: number): boolean {
  if (dir === want) return true;
  switch (want) {
    case 2: return dir === 1 || dir === 3;
    case 4: return dir === 1 || dir === 7;
    case 6: return dir === 3 || dir === 9;
    case 8: return dir === 7 || dir === 9;
    default: return false;
  }
}

function isDiagonal(d: number): boolean {
  return d === 1 || d === 3 || d === 7 || d === 9;
}

/**
 * Has `spec` been completed within the last `lenience` frames?
 * Directions are read facing-relative, so a command is authored once.
 */
export function matchMotion(input: InputBuffer, spec: MotionSpec, lenience = 5): boolean {
  const { beats, slack, window } = spec;
  const last = beats.length - 1;

  let beat = 0;
  let lastAge = -1;

  for (let age = window - 1; age >= 0; age--) {
    const dir = input.at(age).dir;

    // Too long since the previous beat: this is a different input, not a
    // sloppy one. Start the attempt over from here.
    if (beat > 0 && lastAge - age > slack + 1) {
      beat = 0;
      lastAge = -1;
    }

    // Forgive one absent diagonal between two cardinals — a keyboard simply
    // cannot produce it, and refusing the input would punish the hardware.
    if (
      beat > 0 &&
      beat < last &&
      isDiagonal(beats[beat]) &&
      !dirSatisfies(dir, beats[beat]) &&
      dirSatisfies(dir, beats[beat + 1])
    ) {
      beat++;
    }

    if (!dirSatisfies(dir, beats[beat])) continue;

    lastAge = age;
    beat++;
    if (beat > last) {
      if (age <= lenience) return true;
      // Completed, but too long ago for this button press to claim it. Keep
      // scanning: a fresher completion may follow.
      beat = 0;
      lastAge = -1;
    }
  }
  return false;
}
