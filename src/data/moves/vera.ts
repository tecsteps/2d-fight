import { Btn, Motion } from '../../core/Input';
import { AttackTier, GuardKind, Invuln, Reaction, type CommandDef, type StateDef } from '../../engine/contract';
import type { FighterDef } from '../roster';
import { CANCEL, S, attackState, grabState, inv, mkThrow, normal } from './build';
import {
  COST_EX,
  COST_NEOMAX,
  COST_SUPER,
  COST_SUPER_MAX,
  NEOMAX_FLASH_FRAMES,
  SUPER_FLASH_FRAMES,
} from './tuning';

/**
 * VERA — *The Iron Clinch*. Catch wrestling; the grappler.
 *
 * Vera is the only character in the roster whose best moves cannot be blocked,
 * and the whole kit is arranged around getting into the range where that
 * matters. She walks slowly, her normals are short, and her one advancing
 * special commits hard — but two of her specials and both her supers are
 * command grabs, so every frame the opponent spends within a metre of her is a
 * guess.
 *
 * Move ids are in the 4000 block.
 */

const LIGHTS = [S.ST_A, S.ST_B, S.CR_A, S.CR_B];

export function veraStates(def: FighterDef): StateDef[] {
  const h = def.proportions.height;
  const s = h / 1.75;

  return [
    normal(h, 'stA', {
      startup: 4, active: 3, recovery: 7,
      hit: [[0.2, 1.1, 0.7, 1.42]],
      ext: [[0.18, 1.08, 0.62, 1.38]],
      cancel: CANCEL.light(LIGHTS),
      attack: { id: 4001, name: 'Hook', grade: 'light', dmg: 27 },
    }),
    normal(h, 'stB', {
      startup: 5, active: 3, recovery: 8,
      hit: [[0.2, 0.46, 0.74, 0.82]],
      ext: [[0.18, 0.42, 0.66, 0.78]],
      cancel: CANCEL.light(LIGHTS),
      attack: { id: 4002, name: 'Stomp Kick', grade: 'light', dmg: 29 },
    }),
    normal(h, 'stC', {
      startup: 8, active: 4, recovery: 16,
      hit: [[0.22, 0.94, 1.0, 1.46]],
      ext: [[0.2, 0.9, 0.9, 1.4]],
      cancel: CANCEL.heavy(),
      attack: {
        id: 4003, name: 'Overhand', grade: 'heavy', dmg: 84, reaction: Reaction.Heavy,
        impact: 0.64,
      },
    }),
    normal(h, 'stD', {
      startup: 11, active: 4, recovery: 19,
      hit: [[0.24, 0.62, 1.12, 1.2]],
      ext: [[0.22, 0.58, 1.0, 1.14]],
      cancel: CANCEL.whiffable(),
      attack: {
        id: 4004, name: 'Body Kick', grade: 'heavy', dmg: 86, reaction: Reaction.Heavy,
        impact: 0.64,
      },
    }),
    normal(h, 'crA', {
      startup: 4, active: 3, recovery: 7,
      hit: [[0.18, 0.68, 0.66, 0.98]],
      ext: [[0.16, 0.64, 0.58, 0.94]],
      cancel: CANCEL.light(LIGHTS),
      attack: { id: 4005, name: 'Crouch Hook', grade: 'light', dmg: 25 },
    }),
    normal(h, 'crB', {
      startup: 4, active: 3, recovery: 8,
      hit: [[0.18, 0.02, 0.68, 0.3]],
      ext: [[0.16, 0.02, 0.6, 0.28]],
      cancel: CANCEL.light(LIGHTS),
      attack: { id: 4006, name: 'Low Boot', grade: 'light', dmg: 25, guard: GuardKind.Low },
    }),
    normal(h, 'crC', {
      startup: 7, active: 4, recovery: 18,
      hit: [[0.16, 0.5, 0.8, 1.5]],
      ext: [[0.14, 0.46, 0.7, 1.4]],
      cancel: CANCEL.heavy(),
      attack: {
        id: 4007, name: 'Rising Shoulder', grade: 'heavy', dmg: 74,
        reaction: Reaction.Launch, juggleStart: 9, impact: 0.6,
      },
    }),
    normal(h, 'crD', {
      startup: 9, active: 4, recovery: 22,
      hit: [[0.2, 0.0, 1.04, 0.36]],
      ext: [[0.18, 0.0, 0.94, 0.34]],
      cancel: CANCEL.command(),
      attack: {
        id: 4008, name: 'Leg Sweep', grade: 'heavy', dmg: 74, guard: GuardKind.Low,
        reaction: Reaction.Trip,
      },
    }),
    normal(h, 'jA', {
      startup: 5, active: 6, recovery: 8,
      hit: [[0.16, 0.5, 0.7, 0.92]],
      attack: { id: 4009, name: 'Air Hook', grade: 'light', dmg: 28, guard: GuardKind.Overhead },
    }),
    normal(h, 'jB', {
      startup: 5, active: 7, recovery: 8,
      hit: [[0.12, 0.18, 0.68, 0.58]],
      attack: { id: 4010, name: 'Air Boot', grade: 'light', dmg: 30, guard: GuardKind.Overhead },
    }),
    normal(h, 'jC', {
      startup: 8, active: 6, recovery: 10,
      hit: [[0.18, 0.4, 0.96, 1.0]],
      attack: {
        id: 4011, name: 'Air Hammer', grade: 'heavy', dmg: 78, guard: GuardKind.Overhead,
        reaction: Reaction.Heavy,
      },
    }),
    normal(h, 'jD', {
      startup: 9, active: 7, recovery: 10,
      hit: [[0.14, 0.04, 1.02, 0.6]],
      attack: {
        id: 4012, name: 'Air Stomp', grade: 'heavy', dmg: 80, guard: GuardKind.Overhead,
        reaction: Reaction.Heavy,
      },
    }),

    normal(h, 'cmd1', {
      name: 'shoulder-step', startup: 14, active: 4, recovery: 16,
      hit: [[0.28, 0.8, 1.1, 1.4]],
      ext: [[0.24, 0.76, 0.98, 1.34]],
      enterVel: [0.058, 0],
      cancel: CANCEL.command(),
      attack: {
        id: 4013, name: 'Shoulder Step', grade: 'medium', dmg: 58, guard: GuardKind.Overhead,
        reaction: Reaction.Heavy, impact: 0.5,
      },
    }),
    normal(h, 'cmd2', {
      name: 'ankle-pick', startup: 8, active: 3, recovery: 14,
      hit: [[0.22, 0.0, 0.92, 0.36]],
      ext: [[0.2, 0.0, 0.82, 0.34]],
      cancel: CANCEL.command(),
      attack: { id: 4014, name: 'Ankle Pick', grade: 'medium', dmg: 50, guard: GuardKind.Low },
    }),

    /* ---------------- specials ---------------- */
    attackState(
      {
        id: S.SPECIAL_1, name: 'shoulder-charge', anim: 'sp-charge', stance: 'stand',
        startup: 13, active: 6, recovery: 24,
        hit: [[0.2, 0.5, 1.24, 1.42]],
        ext: [[0.18, 0.46, 1.1, 1.36]],
        enterVel: [0.14, 0],
        // Armoured through low pokes on the way in — the one way a grappler is
        // allowed to walk through a keep-out button.
        invuln: [inv(2, 12, Invuln.Low)],
        cancel: CANCEL.special(),
        attack: {
          id: 4100, name: 'Iron Charge', grade: 'special', dmg: 96,
          reaction: Reaction.Blowback, juggleStart: 8, impact: 0.72,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_1_EX, name: 'shoulder-charge-ex', anim: 'sp-charge-ex', stance: 'stand',
        windows: [
          { start: 9, len: 4, hit: [[0.2, 0.5, 1.2, 1.42]] },
          { start: 15, len: 6, hit: [[0.24, 0.44, 1.5, 1.48]] },
        ],
        recovery: 22,
        ext: [[0.18, 0.44, 1.2, 1.38]],
        enterVel: [0.175, 0],
        invuln: [inv(0, 10, Invuln.Strike)],
        cancel: CANCEL.special(),
        attack: {
          id: 4101, name: 'Iron Charge EX', grade: 'ex', dmg: 62,
          reaction: Reaction.WallBounce, juggleStart: 12, impact: 0.86,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_2, name: 'iron-hook', anim: 'sp-iron-hook', stance: 'stand',
        startup: 6, active: 7, recovery: 18, airborne: true,
        hit: [[0.08, 0.72, 0.9, 1.84]],
        ext: [[0.06, 0.68, 0.78, 1.7]],
        invuln: [inv(0, 4, Invuln.Full)],
        cancel: CANCEL.special(),
        onEnter: (f) => {
          f.vy = f.jumpVelocity(0.5);
          f.vx = f.facing * 0.03;
        },
        attack: {
          id: 4102, name: 'Iron Hook', grade: 'special', dmg: 104,
          reaction: Reaction.Launch, juggleStart: 8, impact: 0.74,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_2_EX, name: 'iron-hook-ex', anim: 'sp-iron-hook-ex', stance: 'stand',
        windows: [
          { start: 3, len: 4, hit: [[0.08, 0.68, 0.9, 1.5]] },
          { start: 10, len: 8, hit: [[0.08, 0.78, 0.96, 1.96]] },
        ],
        recovery: 20, airborne: true,
        ext: [[0.06, 0.66, 0.8, 1.74]],
        invuln: [inv(0, 9, Invuln.Full)],
        cancel: CANCEL.special(),
        onEnter: (f) => {
          f.vy = f.jumpVelocity(0.68);
          f.vx = f.facing * 0.022;
        },
        attack: {
          id: 4103, name: 'Iron Hook EX', grade: 'ex', dmg: 66,
          reaction: Reaction.Launch, juggleStart: 12, impact: 0.86,
        },
      },
      h,
    ),

    /* ---------------- command grabs ---------------- */
    grabState(
      {
        id: S.SPECIAL_3, name: 'clinch-drive', anim: 'sp-clinch-drive',
        startup: 5, active: 3, recovery: 27,
        ext: [[0.2, 0.7, 0.96, 1.3]],
        throw: mkThrow({
          id: 4104, name: 'Clinch Drive', range: 1.06 * s, minY: -0.2, maxY: 0.3 * s,
          damage: 128, execState: S.THROW_HIT, victimState: S.THROWN,
          techWindow: 0, techable: false, hitstop: 14,
          powerHit: 110, powerTaken: 180, driveHit: 80, impact: 0.8,
        }),
      },
      h,
    ),
    grabState(
      {
        id: S.SPECIAL_3_EX, name: 'clinch-drive-ex', anim: 'sp-clinch-drive-ex',
        startup: 2, active: 3, recovery: 30,
        ext: [[0.2, 0.7, 1.0, 1.32]],
        invuln: [inv(0, 5, Invuln.Full)],
        throw: mkThrow({
          id: 4105, name: 'Clinch Drive EX', range: 1.2 * s, minY: -0.2, maxY: 0.32 * s,
          damage: 172, execState: S.THROW_HIT, victimState: S.THROWN,
          techWindow: 0, techable: false, hitstop: 16,
          powerHit: 0, powerTaken: 210, driveHit: 40, impact: 0.9,
        }),
      },
      h,
    ),
    grabState(
      {
        id: S.SPECIAL_4, name: 'snap-suplex', anim: 'sp-suplex',
        startup: 7, active: 3, recovery: 30,
        ext: [[0.18, 0.6, 0.9, 1.36]],
        throw: mkThrow({
          id: 4106, name: 'Snap Suplex', range: 0.98 * s, minY: -0.2, maxY: 0.3 * s,
          damage: 140, execState: S.THROW_HIT, victimState: S.THROWN,
          techWindow: 0, techable: false, hitstop: 15,
          powerHit: 120, powerTaken: 190, driveHit: 85, impact: 0.84,
        }),
      },
      h,
    ),

    /* ---------------- desperation moves ---------------- */
    grabState(
      {
        id: S.SUPER, name: 'iron-clinch', anim: 'dm-iron-clinch',
        startup: 3, active: 4, recovery: 38,
        ext: [[0.18, 0.6, 1.0, 1.4]],
        invuln: [inv(0, 8, Invuln.Full)],
        onTick: (f) => {
          if (f.stateTime === 0) f.world.flash(SUPER_FLASH_FRAMES, f);
        },
        throw: mkThrow({
          id: 4200, name: 'Iron Clinch', range: 1.16 * s, minY: -0.2, maxY: 0.34 * s,
          damage: 250, tier: AttackTier.Super, execState: S.THROW_HIT,
          victimState: S.THROWN, techWindow: 0, techable: false, hitstop: 20,
          powerHit: 0, powerTaken: 240, driveHit: 0, impact: 0.95,
        }),
      },
      h,
    ),
    grabState(
      {
        id: S.SUPER_MAX, name: 'iron-clinch-max', anim: 'dm-iron-clinch-max',
        startup: 2, active: 4, recovery: 40,
        ext: [[0.18, 0.6, 1.04, 1.42]],
        invuln: [inv(0, 12, Invuln.Full)],
        onTick: (f) => {
          if (f.stateTime === 0) f.world.flash(SUPER_FLASH_FRAMES, f);
        },
        throw: mkThrow({
          id: 4201, name: 'Iron Clinch MAX', range: 1.3 * s, minY: -0.2, maxY: 0.36 * s,
          damage: 320, tier: AttackTier.Super, execState: S.THROW_HIT, victimState: S.THROWN,
          techWindow: 0, techable: false, hitstop: 24,
          powerHit: 0, powerTaken: 280, driveHit: 0, impact: 1,
        }),
      },
      h,
    ),
    attackState(
      {
        id: S.NEOMAX, name: 'anvil', anim: 'neomax', stance: 'stand',
        windows: [
          { start: 4, len: 5, hit: [[0.1, 0.2, 1.34, 1.8]] },
          { start: 14, len: 5, hit: [[0.14, 0.2, 1.8, 1.84]] },
          { start: 26, len: 9, hit: [[0.14, 0.1, 2.16, 1.9]] },
        ],
        recovery: 44,
        ext: [[0.16, 0.4, 1.14, 1.5]],
        invuln: [inv(0, 22, Invuln.Full)],
        cancel: CANCEL.locked(),
        onEnter: (f) => f.world.flash(NEOMAX_FLASH_FRAMES, f),
        attack: {
          id: 4300, name: 'Anvil', grade: 'neomax', dmg: 142,
          reaction: Reaction.Blowback, juggleStart: 16, impact: 1,
        },
      },
      h,
    ),
  ];
}

export function veraCommands(): CommandDef[] {
  return [
    { name: 'neomax', motion: Motion.HCBF, buttons: Btn.A | Btn.C, state: S.NEOMAX, priority: 100,
      require: { stance: 'ground', power: COST_NEOMAX } },
    { name: 'clinch-max', motion: Motion.HCBF, buttons: Btn.C, state: S.SUPER_MAX, priority: 94,
      require: { stance: 'ground', power: COST_SUPER_MAX } },
    { name: 'clinch-dm', motion: Motion.HCBF, buttons: Btn.A, state: S.SUPER, priority: 93,
      require: { stance: 'ground', power: COST_SUPER } },

    { name: 'grab-ex', motion: Motion.HCF, buttons: Btn.A | Btn.C, state: S.SPECIAL_3_EX, priority: 88,
      require: { stance: 'ground', power: COST_EX } },
    { name: 'charge-ex', motion: Motion.QCF, buttons: Btn.A | Btn.C, state: S.SPECIAL_1_EX, priority: 87,
      require: { stance: 'ground', power: COST_EX } },
    { name: 'hook-ex', motion: Motion.DP, buttons: Btn.A | Btn.C, state: S.SPECIAL_2_EX, priority: 86,
      require: { stance: 'ground', power: COST_EX } },

    { name: 'hook-c', motion: Motion.DP, buttons: Btn.C, state: S.SPECIAL_2, priority: 83,
      require: { stance: 'ground' } },
    { name: 'hook-a', motion: Motion.DP, buttons: Btn.A, state: S.SPECIAL_2, priority: 83,
      require: { stance: 'ground' } },
    { name: 'suplex', motion: Motion.HCB, buttons: Btn.C, state: S.SPECIAL_4, priority: 82,
      require: { stance: 'ground' } },
    { name: 'suplex-a', motion: Motion.HCB, buttons: Btn.A, state: S.SPECIAL_4, priority: 82,
      require: { stance: 'ground' } },
    { name: 'clinch', motion: Motion.HCF, buttons: Btn.C, state: S.SPECIAL_3, priority: 81,
      require: { stance: 'ground' } },
    { name: 'clinch-a', motion: Motion.HCF, buttons: Btn.A, state: S.SPECIAL_3, priority: 81,
      require: { stance: 'ground' } },
    { name: 'charge-c', motion: Motion.QCF, buttons: Btn.C, state: S.SPECIAL_1, priority: 80,
      require: { stance: 'ground' } },
    { name: 'charge-a', motion: Motion.QCF, buttons: Btn.A, state: S.SPECIAL_1, priority: 80,
      require: { stance: 'ground' } },

    { name: 'shoulder-step', buttons: Btn.B, dir: 6, state: S.CMD_1, priority: 62, require: { stance: 'ground' } },
    { name: 'ankle-pick', buttons: Btn.D, dir: 3, state: S.CMD_2, priority: 61, require: { stance: 'ground' } },
  ];
}
