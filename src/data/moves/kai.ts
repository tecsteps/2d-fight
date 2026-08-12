import { Btn, Motion } from '../../core/Input';
import { GuardKind, Invuln, Reaction, type CommandDef, type StateDef } from '../../engine/contract';
import { SUPER_FLASH_FRAMES, NEOMAX_FLASH_FRAMES, COST_EX, COST_NEOMAX, COST_SUPER, COST_SUPER_MAX } from './tuning';
import type { FighterDef } from '../roster';
import { CANCEL, S, attackState, inv, normal } from './build';

/**
 * KAI — *Sudden Stillness*. Full-contact karate; the shoto seat of the roster.
 *
 * Kai is the character the game is taught with: honest normals, a
 * three-special kit that covers every range, and an invincible reversal that
 * has to be earned. His identity is the stop-and-strike — the specials are all
 * built on a moment of stillness followed by one committed line, so his frame
 * data has long startups and short, decisive active windows.
 *
 * Move ids are in the 1000 block so the repeat-damage penalty can tell his
 * moves apart from everyone else's.
 */

const LIGHTS = [S.ST_A, S.ST_B, S.CR_A, S.CR_B];

export function kaiStates(def: FighterDef): StateDef[] {
  const h = def.proportions.height;
  return [
    /* ---------------- normals ---------------- */
    normal(h, 'stA', {
      startup: 3, active: 3, recovery: 6,
      hit: [[0.22, 1.14, 0.74, 1.42]],
      ext: [[0.2, 1.12, 0.64, 1.38]],
      cancel: CANCEL.light(LIGHTS),
      attack: { id: 1001, name: 'Jab', grade: 'light', dmg: 25 },
    }),
    normal(h, 'stB', {
      startup: 4, active: 3, recovery: 8,
      hit: [[0.22, 0.5, 0.82, 0.9]],
      ext: [[0.2, 0.44, 0.72, 0.86]],
      cancel: CANCEL.light(LIGHTS),
      attack: { id: 1002, name: 'Low Round', grade: 'light', dmg: 28 },
    }),
    normal(h, 'stC', {
      startup: 7, active: 4, recovery: 15,
      hit: [[0.24, 1.0, 1.06, 1.42]],
      ext: [[0.22, 0.98, 0.96, 1.36]],
      cancel: CANCEL.heavy(),
      attack: { id: 1003, name: 'Straight', grade: 'heavy', dmg: 72, impact: 0.56 },
    }),
    normal(h, 'stD', {
      startup: 9, active: 4, recovery: 18,
      hit: [[0.26, 0.72, 1.2, 1.28]],
      ext: [[0.24, 0.68, 1.06, 1.2]],
      cancel: CANCEL.whiffable(),
      attack: { id: 1004, name: 'Roundhouse', grade: 'heavy', dmg: 78, reaction: Reaction.Heavy },
    }),
    normal(h, 'crA', {
      startup: 3, active: 3, recovery: 7,
      hit: [[0.2, 0.7, 0.7, 1.0]],
      ext: [[0.18, 0.66, 0.62, 0.96]],
      cancel: CANCEL.light(LIGHTS),
      attack: { id: 1005, name: 'Crouch Jab', grade: 'light', dmg: 23 },
    }),
    normal(h, 'crB', {
      startup: 4, active: 3, recovery: 8,
      hit: [[0.2, 0.04, 0.74, 0.34]],
      ext: [[0.18, 0.02, 0.64, 0.3]],
      cancel: CANCEL.light(LIGHTS),
      attack: { id: 1006, name: 'Low Jab Kick', grade: 'light', dmg: 24, guard: GuardKind.Low },
    }),
    normal(h, 'crC', {
      startup: 6, active: 4, recovery: 17,
      hit: [[0.18, 0.5, 0.82, 1.54]],
      ext: [[0.16, 0.46, 0.72, 1.44]],
      cancel: CANCEL.heavy(),
      // The stock anti-air normal: it launches, so it opens a juggle.
      attack: {
        id: 1007, name: 'Rising Palm', grade: 'heavy', dmg: 68,
        reaction: Reaction.Launch, juggleStart: 10, impact: 0.55,
      },
    }),
    normal(h, 'crD', {
      startup: 8, active: 4, recovery: 21,
      hit: [[0.22, 0.0, 1.12, 0.38]],
      ext: [[0.2, 0.0, 1.0, 0.36]],
      cancel: CANCEL.command(),
      attack: {
        id: 1008, name: 'Sweep', grade: 'heavy', dmg: 70, guard: GuardKind.Low,
        reaction: Reaction.Trip, impact: 0.5,
      },
    }),
    normal(h, 'jA', {
      startup: 4, active: 6, recovery: 8,
      hit: [[0.16, 0.5, 0.7, 0.9]],
      attack: { id: 1009, name: 'Air Jab', grade: 'light', dmg: 26, guard: GuardKind.Overhead },
    }),
    normal(h, 'jB', {
      startup: 5, active: 8, recovery: 8,
      hit: [[0.12, 0.14, 0.7, 0.58]],
      attack: { id: 1010, name: 'Air Knee', grade: 'light', dmg: 28, guard: GuardKind.Overhead },
    }),
    normal(h, 'jC', {
      startup: 7, active: 6, recovery: 10,
      hit: [[0.18, 0.4, 0.98, 0.98]],
      attack: { id: 1011, name: 'Air Hammer', grade: 'heavy', dmg: 70, guard: GuardKind.Overhead },
    }),
    normal(h, 'jD', {
      startup: 8, active: 7, recovery: 10,
      hit: [[0.16, 0.06, 1.06, 0.64]],
      attack: {
        id: 1012, name: 'Jump Kick', grade: 'heavy', dmg: 74, guard: GuardKind.Overhead,
        reaction: Reaction.Heavy,
      },
    }),

    /* ---------------- command normals ---------------- */
    normal(h, 'cmd1', {
      name: 'step-elbow', startup: 12, active: 4, recovery: 16,
      hit: [[0.3, 0.96, 1.14, 1.44]],
      ext: [[0.26, 0.92, 1.0, 1.38]],
      enterVel: [0.052, 0],
      cancel: CANCEL.command(),
      attack: {
        id: 1013, name: 'Step Elbow', grade: 'medium', dmg: 55, guard: GuardKind.Overhead,
        reaction: Reaction.Heavy, impact: 0.48,
      },
    }),
    normal(h, 'cmd2', {
      name: 'low-shin', startup: 7, active: 3, recovery: 13,
      hit: [[0.24, 0.02, 0.98, 0.4]],
      ext: [[0.22, 0.0, 0.88, 0.38]],
      cancel: CANCEL.command(),
      attack: { id: 1014, name: 'Low Shin', grade: 'medium', dmg: 48, guard: GuardKind.Low },
    }),

    /* ---------------- specials ---------------- */
    attackState(
      {
        id: S.SPECIAL_1, name: 'sen-un', anim: 'sp-sen-un', stance: 'stand',
        startup: 11, active: 5, recovery: 22,
        hit: [[0.3, 0.86, 1.42, 1.36]],
        ext: [[0.26, 0.82, 1.24, 1.3]],
        enterVel: [0.088, 0],
        cancel: CANCEL.special(),
        attack: {
          id: 1100, name: 'Sen-un Zuki', grade: 'special', dmg: 95,
          reaction: Reaction.Heavy, hitVel: [-0.086, 0], impact: 0.66,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_1_EX, name: 'sen-un-ex', anim: 'sp-sen-un-ex', stance: 'stand',
        windows: [
          { start: 8, len: 4, hit: [[0.3, 0.86, 1.42, 1.36]] },
          { start: 16, len: 5, hit: [[0.34, 0.82, 1.66, 1.4]] },
        ],
        recovery: 20,
        ext: [[0.26, 0.8, 1.3, 1.32]],
        enterVel: [0.11, 0],
        invuln: [inv(0, 6, Invuln.Strike)],
        cancel: CANCEL.special(),
        attack: {
          id: 1101, name: 'Sen-un Zuki EX', grade: 'ex', dmg: 62,
          reaction: Reaction.Blowback, juggleStart: 8, impact: 0.78,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_2, name: 'rising-heel', anim: 'sp-rising-heel', stance: 'stand',
        startup: 4, active: 8, recovery: 14, airborne: true,
        hit: [[0.1, 0.62, 0.86, 1.86]],
        ext: [[0.08, 0.6, 0.74, 1.7]],
        // Four frames of full invulnerability: a reversal that beats meaty
        // pressure but loses to anything that baits it.
        invuln: [inv(0, 4, Invuln.Full)],
        cancel: CANCEL.special(),
        onEnter: (f) => {
          f.vy = f.jumpVelocity(0.62);
          f.vx = f.facing * 0.028;
        },
        attack: {
          id: 1102, name: 'Rising Heel', grade: 'special', dmg: 100,
          reaction: Reaction.Launch, juggleStart: 8, impact: 0.72,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_2_EX, name: 'rising-heel-ex', anim: 'sp-rising-heel-ex', stance: 'stand',
        windows: [
          { start: 2, len: 4, hit: [[0.1, 0.6, 0.86, 1.5]] },
          { start: 8, len: 8, hit: [[0.1, 0.7, 0.9, 1.96]] },
        ],
        recovery: 16, airborne: true,
        ext: [[0.08, 0.58, 0.76, 1.72]],
        invuln: [inv(0, 9, Invuln.Full)],
        cancel: CANCEL.special(),
        onEnter: (f) => {
          f.vy = f.jumpVelocity(0.78);
          f.vx = f.facing * 0.02;
        },
        attack: {
          id: 1103, name: 'Rising Heel EX', grade: 'ex', dmg: 64,
          reaction: Reaction.Launch, juggleStart: 11, impact: 0.82,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_3, name: 'hisho-geri', anim: 'sp-hisho', stance: 'stand',
        startup: 18, active: 4, recovery: 20,
        hit: [[0.2, 0.28, 1.08, 1.6]],
        ext: [[0.18, 0.3, 0.98, 1.5]],
        cancel: CANCEL.special(),
        attack: {
          id: 1104, name: 'Hishō Geri', grade: 'special', dmg: 92, guard: GuardKind.Overhead,
          reaction: Reaction.Trip, impact: 0.68,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_3_EX, name: 'hisho-geri-ex', anim: 'sp-hisho-ex', stance: 'stand',
        startup: 13, active: 5, recovery: 20,
        hit: [[0.2, 0.24, 1.18, 1.68]],
        ext: [[0.18, 0.26, 1.04, 1.56]],
        cancel: CANCEL.special(),
        attack: {
          id: 1105, name: 'Hishō Geri EX', grade: 'ex', dmg: 112, guard: GuardKind.Overhead,
          reaction: Reaction.GroundBounce, juggleStart: 10, impact: 0.84,
        },
      },
      h,
    ),

    /* ---------------- desperation moves ---------------- */
    attackState(
      {
        id: S.SUPER, name: 'zetsu', anim: 'dm-zetsu', stance: 'stand',
        windows: [
          { start: 8, len: 3, hit: [[0.24, 0.7, 1.3, 1.44]] },
          { start: 13, len: 3, hit: [[0.28, 0.66, 1.5, 1.46]] },
          { start: 19, len: 5, hit: [[0.3, 0.6, 1.72, 1.5]] },
        ],
        recovery: 30,
        ext: [[0.24, 0.62, 1.3, 1.4]],
        invuln: [inv(0, 7, Invuln.Full)],
        cancel: CANCEL.dm(),
        onEnter: (f) => f.world.flash(SUPER_FLASH_FRAMES, f),
        attack: {
          id: 1200, name: 'Zetsu', grade: 'super', dmg: 78,
          reaction: Reaction.Heavy, impact: 0.9,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SUPER_MAX, name: 'zetsu-max', anim: 'dm-zetsu-max', stance: 'stand',
        windows: [
          { start: 6, len: 3, hit: [[0.24, 0.7, 1.34, 1.46]] },
          { start: 11, len: 3, hit: [[0.28, 0.66, 1.56, 1.48]] },
          { start: 16, len: 3, hit: [[0.3, 0.6, 1.78, 1.52]] },
          { start: 23, len: 6, hit: [[0.3, 0.5, 1.96, 1.6]] },
        ],
        recovery: 32,
        ext: [[0.24, 0.6, 1.34, 1.44]],
        invuln: [inv(0, 12, Invuln.Full)],
        cancel: CANCEL.dm(),
        onEnter: (f) => f.world.flash(SUPER_FLASH_FRAMES, f),
        attack: {
          id: 1201, name: 'Zetsu MAX', grade: 'super', dmg: 92,
          reaction: Reaction.Blowback, juggleStart: 12, impact: 0.95,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.NEOMAX, name: 'mu-shin', anim: 'neomax', stance: 'stand',
        windows: [
          { start: 5, len: 4, hit: [[0.16, 0.3, 1.5, 1.7]] },
          { start: 14, len: 4, hit: [[0.2, 0.3, 1.9, 1.74]] },
          { start: 24, len: 8, hit: [[0.2, 0.2, 2.3, 1.8]] },
        ],
        recovery: 44,
        ext: [[0.2, 0.4, 1.2, 1.5]],
        invuln: [inv(0, 20, Invuln.Full)],
        cancel: CANCEL.locked(),
        onEnter: (f) => f.world.flash(NEOMAX_FLASH_FRAMES, f),
        attack: {
          id: 1300, name: 'Mu-shin', grade: 'neomax', dmg: 132,
          reaction: Reaction.Blowback, juggleStart: 16, impact: 1,
        },
      },
      h,
    ),
  ];
}

export function kaiCommands(): CommandDef[] {
  return [
    { name: 'neomax', motion: Motion.QCFx2, buttons: Btn.A | Btn.C, state: S.NEOMAX, priority: 100,
      require: { stance: 'ground', power: COST_NEOMAX } },
    { name: 'zetsu-max', motion: Motion.QCFx2, buttons: Btn.C, state: S.SUPER_MAX, priority: 94,
      require: { stance: 'ground', power: COST_SUPER_MAX } },
    { name: 'zetsu', motion: Motion.QCFx2, buttons: Btn.A, state: S.SUPER, priority: 93,
      require: { stance: 'ground', power: COST_SUPER } },

    { name: 'sen-un-ex', motion: Motion.QCF, buttons: Btn.A | Btn.C, state: S.SPECIAL_1_EX, priority: 88,
      require: { stance: 'ground', power: COST_EX } },
    { name: 'rising-ex', motion: Motion.DP, buttons: Btn.A | Btn.C, state: S.SPECIAL_2_EX, priority: 87,
      require: { stance: 'ground', power: COST_EX } },
    { name: 'hisho-ex', motion: Motion.QCB, buttons: Btn.B | Btn.D, state: S.SPECIAL_3_EX, priority: 86,
      require: { stance: 'ground', power: COST_EX } },

    // The dragon-punch motion is tested before the quarter-circle: 623 contains
    // a 236, so the more specific input has to win or it can never come out.
    { name: 'rising', motion: Motion.DP, buttons: Btn.A | Btn.C, state: S.SPECIAL_2, priority: 82,
      require: { stance: 'ground' }, window: 1 },
    { name: 'rising-c', motion: Motion.DP, buttons: Btn.C, state: S.SPECIAL_2, priority: 81,
      require: { stance: 'ground' } },
    { name: 'rising-a', motion: Motion.DP, buttons: Btn.A, state: S.SPECIAL_2, priority: 81,
      require: { stance: 'ground' } },
    { name: 'sen-un', motion: Motion.QCF, buttons: Btn.C, state: S.SPECIAL_1, priority: 80,
      require: { stance: 'ground' } },
    { name: 'sen-un-a', motion: Motion.QCF, buttons: Btn.A, state: S.SPECIAL_1, priority: 80,
      require: { stance: 'ground' } },
    { name: 'hisho', motion: Motion.QCB, buttons: Btn.D, state: S.SPECIAL_3, priority: 79,
      require: { stance: 'ground' } },
    { name: 'hisho-b', motion: Motion.QCB, buttons: Btn.B, state: S.SPECIAL_3, priority: 79,
      require: { stance: 'ground' } },

    { name: 'step-elbow', buttons: Btn.B, dir: 6, state: S.CMD_1, priority: 62, require: { stance: 'ground' } },
    { name: 'low-shin', buttons: Btn.D, dir: 3, state: S.CMD_2, priority: 61, require: { stance: 'ground' } },
  ];
}
