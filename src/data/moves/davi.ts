import { Btn, Motion } from '../../core/Input';
import { GuardKind, Invuln, Reaction, type CommandDef, type StateDef } from '../../engine/contract';
import type { FighterDef } from '../roster';
import { CANCEL, S, attackState, inv, normal } from './build';
import {
  COST_EX,
  COST_NEOMAX,
  COST_SUPER,
  COST_SUPER_MAX,
  NEOMAX_FLASH_FRAMES,
  SUPER_FLASH_FRAMES,
} from './tuning';

/**
 * DAVI — *Ginga Unbroken*. Capoeira Regional; the rushdown.
 *
 * Davi is built out of momentum. Almost every one of his moves carries him
 * somewhere, his jump is the floatiest on the roster, and his specials are
 * cheap enough to throw out constantly — the trade is that they leave him
 * committed and his health is the lowest in the game. His low sweep trips
 * rather than knocks back, so his pressure keeps ending in front of the
 * opponent instead of pushing them away.
 *
 * Move ids are in the 3000 block.
 */

const LIGHTS = [S.ST_A, S.ST_B, S.CR_A, S.CR_B];

export function daviStates(def: FighterDef): StateDef[] {
  const h = def.proportions.height;
  return [
    normal(h, 'stA', {
      startup: 3, active: 3, recovery: 6,
      hit: [[0.22, 1.1, 0.76, 1.4]],
      ext: [[0.2, 1.08, 0.66, 1.36]],
      cancel: CANCEL.light(LIGHTS),
      attack: { id: 3001, name: 'Backhand', grade: 'light', dmg: 24 },
    }),
    normal(h, 'stB', {
      startup: 4, active: 4, recovery: 7,
      hit: [[0.24, 0.6, 0.94, 1.0]],
      ext: [[0.22, 0.56, 0.82, 0.96]],
      cancel: CANCEL.light(LIGHTS),
      attack: { id: 3002, name: 'Ginga Kick', grade: 'light', dmg: 27 },
    }),
    normal(h, 'stC', {
      startup: 7, active: 4, recovery: 15,
      hit: [[0.24, 0.98, 1.08, 1.44]],
      ext: [[0.22, 0.94, 0.98, 1.38]],
      cancel: CANCEL.heavy(),
      attack: { id: 3003, name: 'Spin Hand', grade: 'heavy', dmg: 70 },
    }),
    normal(h, 'stD', {
      startup: 10, active: 5, recovery: 18,
      hit: [[0.26, 0.9, 1.32, 1.52]],
      ext: [[0.24, 0.84, 1.16, 1.44]],
      cancel: CANCEL.whiffable(),
      attack: {
        id: 3004, name: 'Armada', grade: 'heavy', dmg: 78, reaction: Reaction.Heavy,
        impact: 0.6,
      },
    }),
    normal(h, 'crA', {
      startup: 3, active: 3, recovery: 6,
      hit: [[0.2, 0.68, 0.7, 0.96]],
      ext: [[0.18, 0.64, 0.62, 0.92]],
      cancel: CANCEL.light(LIGHTS),
      attack: { id: 3005, name: 'Crouch Hand', grade: 'light', dmg: 22 },
    }),
    normal(h, 'crB', {
      startup: 3, active: 3, recovery: 7,
      hit: [[0.2, 0.02, 0.8, 0.3]],
      ext: [[0.18, 0.02, 0.7, 0.28]],
      cancel: CANCEL.light(LIGHTS),
      attack: { id: 3006, name: 'Low Toe', grade: 'light', dmg: 22, guard: GuardKind.Low },
    }),
    normal(h, 'crC', {
      startup: 6, active: 4, recovery: 16,
      hit: [[0.16, 0.5, 0.86, 1.6]],
      ext: [[0.14, 0.46, 0.76, 1.48]],
      cancel: CANCEL.heavy(),
      attack: {
        id: 3007, name: 'Rising Heel', grade: 'heavy', dmg: 64,
        reaction: Reaction.Launch, juggleStart: 11, impact: 0.54,
      },
    }),
    normal(h, 'crD', {
      startup: 7, active: 5, recovery: 20,
      hit: [[0.22, 0.0, 1.2, 0.36]],
      ext: [[0.2, 0.0, 1.06, 0.34]],
      cancel: CANCEL.command(),
      attack: {
        id: 3008, name: 'Rasteira', grade: 'heavy', dmg: 66, guard: GuardKind.Low,
        reaction: Reaction.Trip, hitVel: [-0.02, 0.03], impact: 0.5,
      },
    }),
    normal(h, 'jA', {
      startup: 4, active: 6, recovery: 8,
      hit: [[0.16, 0.5, 0.72, 0.9]],
      attack: { id: 3009, name: 'Air Hand', grade: 'light', dmg: 25, guard: GuardKind.Overhead },
    }),
    normal(h, 'jB', {
      startup: 4, active: 9, recovery: 8,
      hit: [[0.1, 0.12, 0.72, 0.56]],
      attack: { id: 3010, name: 'Air Toe', grade: 'light', dmg: 27, guard: GuardKind.Overhead },
    }),
    normal(h, 'jC', {
      startup: 7, active: 6, recovery: 10,
      hit: [[0.18, 0.44, 1.0, 1.06]],
      attack: { id: 3011, name: 'Air Armada', grade: 'heavy', dmg: 68, guard: GuardKind.Overhead },
    }),
    normal(h, 'jD', {
      startup: 8, active: 8, recovery: 10,
      hit: [[0.14, 0.02, 1.14, 0.62]],
      attack: {
        id: 3012, name: 'Martelo', grade: 'heavy', dmg: 74, guard: GuardKind.Overhead,
        reaction: Reaction.Heavy,
      },
    }),

    normal(h, 'cmd1', {
      name: 'esquiva-kick', startup: 13, active: 4, recovery: 15,
      hit: [[0.3, 1.0, 1.24, 1.52]],
      ext: [[0.26, 0.94, 1.1, 1.44]],
      enterVel: [0.07, 0],
      cancel: CANCEL.command(),
      attack: {
        id: 3013, name: 'Esquiva Kick', grade: 'medium', dmg: 52, guard: GuardKind.Overhead,
        reaction: Reaction.Heavy,
      },
    }),
    normal(h, 'cmd2', {
      name: 'negativa', startup: 6, active: 4, recovery: 13,
      hit: [[0.24, 0.0, 1.08, 0.4]],
      ext: [[0.22, 0.0, 0.94, 0.38]],
      cancel: CANCEL.command(),
      // Ducks under high attacks on the way in, which is the capoeirista's
      // whole answer to a fireball-shaped world.
      invuln: [inv(4, 12, Invuln.Strike)],
      attack: { id: 3014, name: 'Negativa', grade: 'medium', dmg: 44, guard: GuardKind.Low },
    }),

    /* ---------------- specials ---------------- */
    attackState(
      {
        id: S.SPECIAL_1, name: 'meia-lua', anim: 'sp-meia-lua', stance: 'stand',
        startup: 10, active: 6, recovery: 20,
        hit: [[0.2, 0.5, 1.36, 1.56]],
        ext: [[0.18, 0.48, 1.2, 1.46]],
        enterVel: [0.07, 0],
        cancel: CANCEL.special(),
        attack: {
          id: 3100, name: 'Meia Lua', grade: 'special', dmg: 88,
          reaction: Reaction.Heavy, impact: 0.64,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_1_EX, name: 'meia-lua-ex', anim: 'sp-meia-lua-ex', stance: 'stand',
        windows: [
          { start: 7, len: 4, hit: [[0.2, 0.5, 1.3, 1.56]] },
          { start: 14, len: 6, hit: [[0.22, 0.44, 1.58, 1.62]] },
        ],
        recovery: 18,
        ext: [[0.18, 0.44, 1.3, 1.5]],
        enterVel: [0.096, 0],
        invuln: [inv(0, 5, Invuln.Strike)],
        cancel: CANCEL.special(),
        attack: {
          id: 3101, name: 'Meia Lua EX', grade: 'ex', dmg: 58,
          reaction: Reaction.Blowback, juggleStart: 9, impact: 0.78,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_2, name: 'au-batido', anim: 'sp-au-batido', stance: 'stand',
        startup: 5, active: 9, recovery: 15, airborne: true,
        hit: [[0.06, 0.7, 0.9, 1.92]],
        ext: [[0.04, 0.66, 0.78, 1.76]],
        invuln: [inv(0, 5, Invuln.Full)],
        cancel: CANCEL.special(),
        onEnter: (f) => {
          f.vy = f.jumpVelocity(0.6);
          f.vx = f.facing * 0.04;
        },
        attack: {
          id: 3102, name: 'Aú Batido', grade: 'special', dmg: 92,
          reaction: Reaction.Launch, juggleStart: 9, impact: 0.7,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_2_EX, name: 'au-batido-ex', anim: 'sp-au-batido-ex', stance: 'stand',
        windows: [
          { start: 3, len: 4, hit: [[0.06, 0.66, 0.9, 1.5]] },
          { start: 9, len: 9, hit: [[0.06, 0.76, 0.96, 2.0]] },
        ],
        recovery: 17, airborne: true,
        ext: [[0.04, 0.62, 0.8, 1.78]],
        invuln: [inv(0, 10, Invuln.Full)],
        cancel: CANCEL.special(),
        onEnter: (f) => {
          f.vy = f.jumpVelocity(0.8);
          f.vx = f.facing * 0.03;
        },
        attack: {
          id: 3103, name: 'Aú Batido EX', grade: 'ex', dmg: 60,
          reaction: Reaction.Launch, juggleStart: 12, impact: 0.84,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_3, name: 'rasteira', anim: 'sp-rasteira', stance: 'crouch',
        startup: 9, active: 5, recovery: 24,
        hit: [[0.2, 0.0, 1.48, 0.4]],
        ext: [[0.18, 0.0, 1.3, 0.38]],
        enterVel: [0.062, 0],
        cancel: CANCEL.special(),
        attack: {
          id: 3104, name: 'Rasteira', grade: 'special', dmg: 84, guard: GuardKind.Low,
          reaction: Reaction.Trip, hitVel: [-0.024, 0.05], impact: 0.62,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_3_EX, name: 'rasteira-ex', anim: 'sp-rasteira-ex', stance: 'crouch',
        startup: 6, active: 6, recovery: 22,
        hit: [[0.2, 0.0, 1.62, 0.42]],
        ext: [[0.18, 0.0, 1.4, 0.4]],
        enterVel: [0.086, 0],
        invuln: [inv(0, 8, Invuln.Strike | Invuln.Low)],
        cancel: CANCEL.special(),
        attack: {
          id: 3105, name: 'Rasteira EX', grade: 'ex', dmg: 100, guard: GuardKind.Low,
          reaction: Reaction.Launch, juggleStart: 12, impact: 0.8,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_4, name: 'macaco', anim: 'sp-macaco', stance: 'stand',
        startup: 8, active: 6, recovery: 18, airborne: true,
        hit: [[-0.1, 0.7, 0.72, 1.8]],
        ext: [[-0.08, 0.5, 0.6, 1.6]],
        // The escape special: it retreats while it hits, so it is the answer to
        // being cornered rather than a combo tool.
        invuln: [inv(0, 8, Invuln.Strike | Invuln.Throw)],
        cancel: CANCEL.special(),
        onEnter: (f) => {
          f.vy = f.jumpVelocity(0.42);
          f.vx = -f.facing * 0.09;
        },
        attack: {
          id: 3106, name: 'Macaco', grade: 'special', dmg: 70,
          reaction: Reaction.Medium, impact: 0.5,
        },
      },
      h,
    ),

    /* ---------------- desperation moves ---------------- */
    attackState(
      {
        id: S.SUPER, name: 'roda', anim: 'dm-roda', stance: 'stand',
        windows: [
          { start: 6, len: 4, hit: [[0.16, 0.4, 1.34, 1.6]] },
          { start: 13, len: 4, hit: [[0.16, 0.4, 1.4, 1.64]] },
          { start: 20, len: 4, hit: [[0.16, 0.4, 1.46, 1.66]] },
          { start: 28, len: 6, hit: [[0.2, 0.34, 1.66, 1.7]] },
        ],
        recovery: 28,
        ext: [[0.18, 0.4, 1.24, 1.5]],
        invuln: [inv(0, 6, Invuln.Full)],
        cancel: CANCEL.dm(),
        onEnter: (f) => f.world.flash(SUPER_FLASH_FRAMES, f),
        attack: {
          id: 3200, name: 'Roda', grade: 'super', dmg: 64,
          reaction: Reaction.Medium, impact: 0.88,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SUPER_MAX, name: 'roda-max', anim: 'dm-roda-max', stance: 'stand',
        windows: [
          { start: 5, len: 4, hit: [[0.16, 0.4, 1.38, 1.62]] },
          { start: 11, len: 4, hit: [[0.16, 0.4, 1.44, 1.66]] },
          { start: 17, len: 4, hit: [[0.16, 0.4, 1.5, 1.68]] },
          { start: 23, len: 4, hit: [[0.16, 0.4, 1.56, 1.7]] },
          { start: 31, len: 7, hit: [[0.2, 0.3, 1.8, 1.74]] },
        ],
        recovery: 30,
        ext: [[0.18, 0.36, 1.3, 1.54]],
        invuln: [inv(0, 11, Invuln.Full)],
        cancel: CANCEL.dm(),
        onEnter: (f) => f.world.flash(SUPER_FLASH_FRAMES, f),
        attack: {
          id: 3201, name: 'Roda MAX', grade: 'super', dmg: 72,
          reaction: Reaction.Blowback, juggleStart: 12, impact: 0.94,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.NEOMAX, name: 'ginga-infinita', anim: 'neomax', stance: 'stand',
        windows: [
          { start: 6, len: 4, hit: [[0.12, 0.24, 1.5, 1.78]] },
          { start: 16, len: 4, hit: [[0.16, 0.24, 1.94, 1.82]] },
          { start: 27, len: 8, hit: [[0.16, 0.14, 2.34, 1.86]] },
        ],
        recovery: 42,
        ext: [[0.16, 0.36, 1.2, 1.52]],
        invuln: [inv(0, 20, Invuln.Full)],
        cancel: CANCEL.locked(),
        onEnter: (f) => f.world.flash(NEOMAX_FLASH_FRAMES, f),
        attack: {
          id: 3300, name: 'Ginga Infinita', grade: 'neomax', dmg: 124,
          reaction: Reaction.Blowback, juggleStart: 16, impact: 1,
        },
      },
      h,
    ),
  ];
}

export function daviCommands(): CommandDef[] {
  return [
    { name: 'neomax', motion: Motion.QCBx2, buttons: Btn.B | Btn.D, state: S.NEOMAX, priority: 100,
      require: { stance: 'ground', power: COST_NEOMAX } },
    { name: 'roda-max', motion: Motion.QCFx2, buttons: Btn.D, state: S.SUPER_MAX, priority: 94,
      require: { stance: 'ground', power: COST_SUPER_MAX } },
    { name: 'roda', motion: Motion.QCFx2, buttons: Btn.B, state: S.SUPER, priority: 93,
      require: { stance: 'ground', power: COST_SUPER } },

    { name: 'au-ex', motion: Motion.DP, buttons: Btn.B | Btn.D, state: S.SPECIAL_2_EX, priority: 88,
      require: { stance: 'ground', power: COST_EX } },
    { name: 'meia-ex', motion: Motion.QCF, buttons: Btn.B | Btn.D, state: S.SPECIAL_1_EX, priority: 87,
      require: { stance: 'ground', power: COST_EX } },
    { name: 'rasteira-ex', motion: Motion.QCB, buttons: Btn.B | Btn.D, state: S.SPECIAL_3_EX, priority: 86,
      require: { stance: 'ground', power: COST_EX } },

    { name: 'au-d', motion: Motion.DP, buttons: Btn.D, state: S.SPECIAL_2, priority: 82,
      require: { stance: 'ground' } },
    { name: 'au-b', motion: Motion.DP, buttons: Btn.B, state: S.SPECIAL_2, priority: 82,
      require: { stance: 'ground' } },
    { name: 'macaco', motion: Motion.QCB, buttons: Btn.C, state: S.SPECIAL_4, priority: 81,
      require: { stance: 'ground' } },
    { name: 'macaco-a', motion: Motion.QCB, buttons: Btn.A, state: S.SPECIAL_4, priority: 81,
      require: { stance: 'ground' } },
    { name: 'meia-d', motion: Motion.QCF, buttons: Btn.D, state: S.SPECIAL_1, priority: 80,
      require: { stance: 'ground' } },
    { name: 'meia-b', motion: Motion.QCF, buttons: Btn.B, state: S.SPECIAL_1, priority: 80,
      require: { stance: 'ground' } },
    { name: 'rasteira-d', motion: Motion.QCB, buttons: Btn.D, state: S.SPECIAL_3, priority: 79,
      require: { stance: 'ground' } },
    { name: 'rasteira-b', motion: Motion.QCB, buttons: Btn.B, state: S.SPECIAL_3, priority: 79,
      require: { stance: 'ground' } },

    { name: 'esquiva-kick', buttons: Btn.B, dir: 6, state: S.CMD_1, priority: 62, require: { stance: 'ground' } },
    { name: 'negativa', buttons: Btn.D, dir: 3, state: S.CMD_2, priority: 61, require: { stance: 'ground' } },
  ];
}
