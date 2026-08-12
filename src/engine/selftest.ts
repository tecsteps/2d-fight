import { Btn, mirrorDir, type InputFrame } from '../core/Input';
import { Match } from './Match';
import { STAGE_HALF_WIDTH } from '../data/moves/tuning';

/**
 * Deterministic self-test.
 *
 * Runs 600 ticks of two scripted fighters and proves three things:
 *
 *   1. **Reproducibility** — two fresh matches fed the identical input stream
 *      produce the identical state hash at every checkpoint.
 *   2. **Rollback equivalence** — saving at tick 200, running to 400, restoring
 *      the tick-200 snapshot and re-running the same inputs lands on the same
 *      hash. This is the property rollback netcode needs, and it is the one
 *      that catches state we forgot to put in `save()`.
 *   3. **Sanity** — nobody leaves the stage, nobody goes NaN, health stays in
 *      range, and hits actually happened (a script that whiffs everything would
 *      pass 1 and 2 while testing nothing).
 *
 * `EXPECTED_HASH` pins the current behaviour. It is *supposed* to change when
 * frame data or physics changes — the point is that it must never change on its
 * own, and it must never differ between two runs of the same build.
 */

const TICKS = 600;
const CHECKPOINT = 25;
const ROLLBACK_FROM = 200;
const ROLLBACK_TO = 400;

/**
 * Baseline hash of the 600-tick script. Re-pin deliberately, never silently.
 *
 * Re-pinned after wave C changed roster proportions (build now spans 0.32-0.97,
 * height 1.66-1.90) and wave D changed two skin palettes. Both feed the physics
 * through per-fighter weight and reach, so the script's trajectory genuinely
 * differs. The property that matters was re-verified at the same time: replay
 * from a mid-run checkpoint reproduces the straight run exactly.
 */
export const EXPECTED_HASH: number = 0x86bba811;

interface Step {
  dir: number;
  buttons: number;
  frames: number;
}

/**
 * The script, authored facing-relative so it reads the same for both sides:
 * 6 is always "towards the opponent". `mirrorDir` flips it for player 2.
 *
 * Between them the two programs exercise walking, both jump arcs, chained
 * lights, low/overhead mixups, quarter-circle and dragon-punch specials, an EX
 * (A+C), the CD blowback, a roll, a throw, and a long block string.
 */
const P1: Step[] = [
  // The resting direction is forward, not neutral: this script is supposed to
  // stay in range, because a test that never touches anything proves nothing.
  { dir: 6, buttons: 0, frames: 14 },
  { dir: 2, buttons: Btn.B, frames: 2 },
  { dir: 2, buttons: 0, frames: 5 },
  { dir: 2, buttons: Btn.A, frames: 2 },
  { dir: 2, buttons: 0, frames: 3 },
  { dir: 3, buttons: 0, frames: 2 },
  { dir: 6, buttons: Btn.C, frames: 3 },
  { dir: 6, buttons: 0, frames: 24 },
  { dir: 5, buttons: Btn.C, frames: 2 },
  { dir: 6, buttons: 0, frames: 20 },
  { dir: 4, buttons: 0, frames: 11 },
  { dir: 6, buttons: 0, frames: 12 },
  { dir: 5, buttons: Btn.C | Btn.D, frames: 3 },
  { dir: 6, buttons: 0, frames: 26 },
  { dir: 9, buttons: 0, frames: 7 },
  { dir: 9, buttons: Btn.C, frames: 3 },
  { dir: 6, buttons: 0, frames: 14 },
  { dir: 2, buttons: Btn.D, frames: 3 },
  { dir: 6, buttons: 0, frames: 18 },
  { dir: 6, buttons: Btn.C, frames: 2 },
  { dir: 6, buttons: 0, frames: 16 },
  { dir: 2, buttons: 0, frames: 2 },
  { dir: 3, buttons: 0, frames: 2 },
  { dir: 6, buttons: Btn.A | Btn.C, frames: 4 },
  { dir: 6, buttons: 0, frames: 22 },
  { dir: 5, buttons: Btn.A | Btn.B, frames: 3 },
  { dir: 6, buttons: 0, frames: 15 },
];

const P2: Step[] = [
  // Also holds forward at rest, so the two stay in each other's range for the
  // whole run: guard segments are deliberate, not the default.
  { dir: 4, buttons: 0, frames: 18 },
  { dir: 1, buttons: 0, frames: 12 },
  { dir: 6, buttons: 0, frames: 10 },
  { dir: 5, buttons: Btn.A, frames: 2 },
  { dir: 6, buttons: 0, frames: 4 },
  { dir: 5, buttons: Btn.B, frames: 2 },
  { dir: 4, buttons: 0, frames: 14 },
  { dir: 2, buttons: Btn.D, frames: 3 },
  { dir: 6, buttons: 0, frames: 16 },
  { dir: 8, buttons: 0, frames: 3 },
  { dir: 6, buttons: 0, frames: 9 },
  { dir: 5, buttons: Btn.C, frames: 2 },
  { dir: 4, buttons: 0, frames: 20 },
  { dir: 6, buttons: 0, frames: 12 },
  { dir: 5, buttons: Btn.D, frames: 3 },
  { dir: 6, buttons: 0, frames: 13 },
];

/**
 * Programs are authored facing-relative and converted to the absolute frames a
 * real controller produces, using the fighter's current facing. Reading facing
 * out of the sim keeps "6 is towards the opponent" true even after a cross-up,
 * and it stays deterministic because facing is itself a pure function of the
 * simulation.
 */
function sample(program: Step[], tick: number, facing: number): InputFrame {
  let total = 0;
  for (const s of program) total += s.frames;
  let t = tick % total;
  for (const s of program) {
    if (t < s.frames) {
      return { dir: facing === 1 ? s.dir : mirrorDir(s.dir), buttons: s.buttons };
    }
    t -= s.frames;
  }
  return { dir: 5, buttons: 0 };
}

function inputsAt(tick: number, m: Match): [InputFrame, InputFrame] {
  // The offset keeps the two programs out of phase so they collide at varying
  // ranges instead of replaying one fixed exchange.
  return [sample(P1, tick, m.p1.facing), sample(P2, tick + 37, m.p2.facing)];
}

function newMatch(): Match {
  return new Match({
    teams: [{ members: ['kai', 'mali'] }, { members: ['davi', 'vera'] }],
    seed: 0x1f2e3d4c,
    startSeparation: 1.1,
  });
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SelfTestResult {
  ok: boolean;
  hash: number;
  checks: Check[];
}

export function runSelfTest(): SelfTestResult {
  const checks: Check[] = [];

  // --- run A, recording a hash every CHECKPOINT ticks -------------------
  const a = newMatch();
  const trace: number[] = [];
  let sane = true;
  let saneDetail = 'all frames in range';
  let contacts = 0;

  for (let t = 0; t < TICKS; t++) {
    // Checkpoint before the step, so `trace[k]` is the state after exactly
    // `k * CHECKPOINT` steps — which is what a restore lands on.
    if (t % CHECKPOINT === 0) trace.push(a.hash());
    a.step(inputsAt(t, a));
    contacts += a.events.length;

    for (const team of a.roster) {
      for (const f of team) {
        if (!Number.isFinite(f.x) || !Number.isFinite(f.y) || !Number.isFinite(f.vx)) {
          sane = false;
          saneDetail = `non-finite transform on ${f.def.id} at tick ${t}`;
        } else if (Math.abs(f.x) > STAGE_HALF_WIDTH + 0.001) {
          sane = false;
          saneDetail = `${f.def.id} escaped the stage at tick ${t} (x=${f.x.toFixed(3)})`;
        } else if (f.y < -0.001) {
          sane = false;
          saneDetail = `${f.def.id} fell through the floor at tick ${t}`;
        } else if (f.health < 0 || f.health > f.maxHealth) {
          sane = false;
          saneDetail = `${f.def.id} health out of range at tick ${t} (${f.health})`;
        }
      }
    }
  }
  const finalHash = a.hash();

  // --- run B: same script, fresh match ---------------------------------
  const b = newMatch();
  let divergedAt = -1;
  for (let t = 0; t < TICKS; t++) {
    if (t % CHECKPOINT === 0 && b.hash() !== trace[t / CHECKPOINT] && divergedAt < 0) {
      divergedAt = t;
    }
    b.step(inputsAt(t, b));
  }
  checks.push({
    name: 'reproducible',
    ok: divergedAt < 0 && b.hash() === finalHash,
    detail: divergedAt < 0 ? 'identical at every checkpoint' : `diverged at tick ${divergedAt}`,
  });

  // --- rollback equivalence --------------------------------------------
  const c = newMatch();
  for (let t = 0; t < ROLLBACK_FROM; t++) c.step(inputsAt(t, c));
  const snap = c.save();
  for (let t = ROLLBACK_FROM; t < ROLLBACK_TO; t++) c.step(inputsAt(t, c));
  const straight = c.hash();
  c.load(snap);
  const restored = c.hash();
  for (let t = ROLLBACK_FROM; t < ROLLBACK_TO; t++) c.step(inputsAt(t, c));
  const replayed = c.hash();

  checks.push({
    name: 'snapshot-restores',
    ok: restored === trace[ROLLBACK_FROM / CHECKPOINT],
    detail: `restored ${hex(restored)} vs checkpoint ${hex(trace[ROLLBACK_FROM / CHECKPOINT])}`,
  });
  checks.push({
    name: 'rollback-replay',
    ok: replayed === straight,
    detail: `replay ${hex(replayed)} vs straight ${hex(straight)}`,
  });

  checks.push({ name: 'sane', ok: sane, detail: saneDetail });
  const damageDealt =
    a.roster[0][0].maxHealth - a.roster[0][0].health + a.roster[1][0].maxHealth - a.roster[1][0].health;
  checks.push({
    name: 'script-connects',
    ok: contacts >= 6 && damageDealt > 0,
    detail: `${contacts} contacts, ${damageDealt} damage over ${TICKS} ticks`,
  });
  checks.push({
    name: 'baseline',
    ok: EXPECTED_HASH === 0 || finalHash === EXPECTED_HASH,
    detail: `hash ${hex(finalHash)}, expected ${hex(EXPECTED_HASH)}`,
  });

  return { ok: checks.every((c2) => c2.ok), hash: finalHash, checks };
}

function hex(v: number): string {
  return `0x${(v >>> 0).toString(16).padStart(8, '0')}`;
}

/** Printable one-liner per check, for CI logs and the debug overlay. */
export function formatSelfTest(r: SelfTestResult): string {
  const lines = r.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(18)} ${c.detail}`);
  lines.push(`${r.ok ? 'PASS' : 'FAIL'}  engine selftest      hash=${hex(r.hash)}`);
  return lines.join('\n');
}
