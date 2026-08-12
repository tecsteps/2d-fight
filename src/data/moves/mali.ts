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
 * MALI — *Eight Limbs*. Muay Thai; the striker.
 *
 * Mali trades range for density. Her normals are shorter than Kai's but recover
 * faster, and her specials all move her *in* rather than away, so her whole
 * game is winning the step and then not giving it back. The clinch knees are
 * the identity move: a multi-hit special on a fixed cadence that shreds a guard
 * gauge and forces the opponent to find a way out rather than wait one out.
 *
 * Move ids are in the 2000 block.
 */

const LIGHTS = [S.ST_A, S.ST_B, S.CR_A, S.CR_B];

export function maliStates(def: FighterDef): StateDef[] {
  const h = def.proportions.height;
  return [
    normal(h, 'stA', {
      startup: 3, active: 3, recovery: 5,
      hit: [[0.2, 1.12, 0.68, 1.4]],
      ext: [[0.18, 1.1, 0.6, 1.36]],
      cancel: CANCEL.light(LIGHTS),
      attack: { id: 2001, name: 'Jab', grade: 'light', dmg: 24 },
    }),
    normal(h, 'stB', {
      startup: 4, active: 3, recovery: 7,
      hit: [[0.2, 0.68, 0.8, 1.06]],
      ext: [[0.18, 0.64, 0.7, 1.0]],
      cancel: CANCEL.light(LIGHTS),
      attack: { id: 2002, name: 'Teep Jab', grade: 'light', dmg: 27 },
    }),
    normal(h, 'stC', {
      startup: 6, active: 4, recovery: 14,
      hit: [[0.22, 1.0, 0.98, 1.5]],
      ext: [[0.2, 0.98, 0.88, 1.44]],
      cancel: CANCEL.heavy(),
      attack: { id: 2003, name: 'Elbow', grade: 'heavy', dmg: 74, impact: 0.6 },
    }),
    normal(h, 'stD', {
      startup: 10, active: 4, recovery: 17,
      hit: [[0.24, 0.86, 1.18, 1.4]],
      ext: [[0.22, 0.8, 1.04, 1.32]],
      cancel: CANCEL.whiffable(),
      attack: {
        id: 2004, name: 'Body Round', grade: 'heavy', dmg: 80, reaction: Reaction.Heavy,
        impact: 0.6,
      },
    }),
    normal(h, 'crA', {
      startup: 3, active: 3, recovery: 6,
      hit: [[0.18, 0.7, 0.66, 0.98]],
      ext: [[0.16, 0.66, 0.58, 0.94]],
      cancel: CANCEL.light(LIGHTS),
      attack: { id: 2005, name: 'Crouch Jab', grade: 'light', dmg: 22 },
    }),
    normal(h, 'crB', {
      startup: 3, active: 3, recovery: 7,
      hit: [[0.18, 0.02, 0.72, 0.3]],
      ext: [[0.16, 0.02, 0.62, 0.28]],
      cancel: CANCEL.light(LIGHTS),
      attack: { id: 2006, name: 'Low Shin', grade: 'light', dmg: 23, guard: GuardKind.Low },
    }),
    normal(h, 'crC', {
      startup: 5, active: 4, recovery: 16,
      hit: [[0.16, 0.56, 0.78, 1.52]],
      ext: [[0.14, 0.52, 0.68, 1.42]],
      cancel: CANCEL.heavy(),
      attack: {
        id: 2007, name: 'Rising Elbow', grade: 'heavy', dmg: 66,
        reaction: Reaction.Launch, juggleStart: 10, impact: 0.56,
      },
    }),
    normal(h, 'crD', {
      startup: 7, active: 4, recovery: 20,
      hit: [[0.2, 0.0, 1.06, 0.36]],
      ext: [[0.18, 0.0, 0.94, 0.34]],
      cancel: CANCEL.command(),
      attack: {
        id: 2008, name: 'Sweep', grade: 'heavy', dmg: 68, guard: GuardKind.Low,
        reaction: Reaction.Trip,
      },
    }),
    normal(h, 'jA', {
      startup: 4, active: 6, recovery: 8,
      hit: [[0.14, 0.5, 0.66, 0.88]],
      attack: { id: 2009, name: 'Air Elbow', grade: 'light', dmg: 26, guard: GuardKind.Overhead },
    }),
    normal(h, 'jB', {
      startup: 4, active: 8, recovery: 8,
      hit: [[0.1, 0.2, 0.64, 0.6]],
      attack: { id: 2010, name: 'Air Knee', grade: 'light', dmg: 28, guard: GuardKind.Overhead },
    }),
    normal(h, 'jC', {
      startup: 7, active: 5, recovery: 10,
      hit: [[0.16, 0.44, 0.92, 1.02]],
      attack: { id: 2011, name: 'Air Smash', grade: 'heavy', dmg: 70, guard: GuardKind.Overhead },
    }),
    normal(h, 'jD', {
      startup: 7, active: 8, recovery: 10,
      hit: [[0.14, 0.1, 1.0, 0.68]],
      attack: {
        id: 2012, name: 'Jump Knee', grade: 'heavy', dmg: 76, guard: GuardKind.Overhead,
        reaction: Reaction.Heavy,
      },
    }),

    normal(h, 'cmd1', {
      name: 'long-knee', startup: 11, active: 4, recovery: 15,
      hit: [[0.28, 0.72, 1.1, 1.26]],
      ext: [[0.24, 0.7, 0.98, 1.2]],
      enterVel: [0.062, 0],
      cancel: CANCEL.command(),
      attack: {
        id: 2013, name: 'Long Knee', grade: 'medium', dmg: 54, guard: GuardKind.Overhead,
        reaction: Reaction.Heavy,
      },
    }),
    normal(h, 'cmd2', {
      name: 'cut-kick', startup: 6, active: 3, recovery: 12,
      hit: [[0.22, 0.04, 0.94, 0.42]],
      ext: [[0.2, 0.02, 0.84, 0.4]],
      cancel: CANCEL.command(),
      attack: { id: 2014, name: 'Cut Kick', grade: 'medium', dmg: 46, guard: GuardKind.Low },
    }),

    /* ---------------- specials ---------------- */
    attackState(
      {
        id: S.SPECIAL_1, name: 'teep', anim: 'sp-teep', stance: 'stand',
        startup: 12, active: 4, recovery: 20,
        hit: [[0.3, 0.66, 1.5, 1.18]],
        ext: [[0.26, 0.62, 1.3, 1.12]],
        cancel: CANCEL.special(),
        // The push kick's job is space, not damage: huge knockback, tiny reward.
        attack: {
          id: 2100, name: 'Teep', grade: 'special', dmg: 72,
          reaction: Reaction.Heavy, hitVel: [-0.14, 0], guardVel: [-0.1, 0],
          selfPushGuard: 0.02, impact: 0.6,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_1_EX, name: 'teep-ex', anim: 'sp-teep-ex', stance: 'stand',
        windows: [
          { start: 8, len: 3, hit: [[0.28, 0.66, 1.36, 1.18]] },
          { start: 14, len: 5, hit: [[0.32, 0.6, 1.66, 1.24]] },
        ],
        recovery: 18,
        ext: [[0.26, 0.6, 1.34, 1.16]],
        invuln: [inv(0, 5, Invuln.Strike)],
        cancel: CANCEL.special(),
        attack: {
          id: 2101, name: 'Teep EX', grade: 'ex', dmg: 60,
          reaction: Reaction.Blowback, juggleStart: 8, impact: 0.8,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_2, name: 'sok-chiang', anim: 'sp-sok', stance: 'stand',
        startup: 5, active: 7, recovery: 16, airborne: true,
        hit: [[0.08, 0.7, 0.82, 1.8]],
        ext: [[0.06, 0.66, 0.72, 1.66]],
        invuln: [inv(0, 4, Invuln.Full)],
        cancel: CANCEL.special(),
        onEnter: (f) => {
          f.vy = f.jumpVelocity(0.56);
          f.vx = f.facing * 0.034;
        },
        attack: {
          id: 2102, name: 'Sok Chiang', grade: 'special', dmg: 96,
          reaction: Reaction.Launch, juggleStart: 8, impact: 0.7,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_2_EX, name: 'sok-chiang-ex', anim: 'sp-sok-ex', stance: 'stand',
        windows: [
          { start: 3, len: 4, hit: [[0.08, 0.66, 0.82, 1.5]] },
          { start: 9, len: 8, hit: [[0.08, 0.76, 0.88, 1.94]] },
        ],
        recovery: 18, airborne: true,
        ext: [[0.06, 0.64, 0.74, 1.7]],
        invuln: [inv(0, 8, Invuln.Full)],
        cancel: CANCEL.special(),
        onEnter: (f) => {
          f.vy = f.jumpVelocity(0.74);
          f.vx = f.facing * 0.026;
        },
        attack: {
          id: 2103, name: 'Sok Chiang EX', grade: 'ex', dmg: 62,
          reaction: Reaction.Launch, juggleStart: 11, impact: 0.84,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_3, name: 'khao-loi', anim: 'sp-khao', stance: 'stand',
        startup: 14, active: 6, recovery: 22, airborne: true,
        hit: [[0.18, 0.5, 1.02, 1.34]],
        ext: [[0.16, 0.48, 0.92, 1.28]],
        cancel: CANCEL.special(),
        onEnter: (f) => {
          f.vy = f.jumpVelocity(0.3);
          f.vx = f.facing * 0.105;
        },
        attack: {
          id: 2104, name: 'Khao Loi', grade: 'special', dmg: 94, guard: GuardKind.Overhead,
          reaction: Reaction.Blowback, juggleStart: 7, impact: 0.7,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_3_EX, name: 'khao-loi-ex', anim: 'sp-khao-ex', stance: 'stand',
        startup: 10, active: 8, recovery: 20, airborne: true,
        hit: [[0.18, 0.44, 1.12, 1.4]],
        ext: [[0.16, 0.44, 1.0, 1.32]],
        invuln: [inv(0, 6, Invuln.Strike | Invuln.Low)],
        cancel: CANCEL.special(),
        onEnter: (f) => {
          f.vy = f.jumpVelocity(0.36);
          f.vx = f.facing * 0.128;
        },
        attack: {
          id: 2105, name: 'Khao Loi EX', grade: 'ex', dmg: 108, guard: GuardKind.Overhead,
          reaction: Reaction.WallBounce, juggleStart: 12, impact: 0.86,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SPECIAL_4, name: 'clinch-knees', anim: 'sp-clinch', stance: 'stand',
        startup: 9, active: 30, recovery: 20,
        hit: [[0.16, 0.5, 0.98, 1.3]],
        ext: [[0.14, 0.5, 0.86, 1.24]],
        cancel: CANCEL.special(),
        // Six knees on a five-frame cadence: the guard gauge is the real target.
        attack: {
          id: 2106, name: 'Clinch Knees', grade: 'special', dmg: 22, hitInterval: 5,
          hitstun: 12, blockstun: 10, hitstop: 6, hitShake: 2,
          hitVel: [-0.006, 0], guardVel: [-0.014, 0], selfPush: 0, selfPushGuard: 0.006,
          guardDamage: 46, juggle: 1, impact: 0.36, driveHit: 14, powerHit: 14,
        },
      },
      h,
    ),

    /* ---------------- desperation moves ---------------- */
    attackState(
      {
        id: S.SUPER, name: 'eight-limbs', anim: 'dm-eight-limbs', stance: 'stand',
        windows: [
          { start: 7, len: 3, hit: [[0.2, 0.9, 1.16, 1.46]] },
          { start: 12, len: 3, hit: [[0.2, 0.6, 1.2, 1.3]] },
          { start: 17, len: 3, hit: [[0.2, 0.9, 1.24, 1.5]] },
          { start: 22, len: 3, hit: [[0.2, 0.5, 1.26, 1.24]] },
          { start: 28, len: 6, hit: [[0.24, 0.5, 1.5, 1.54]] },
        ],
        recovery: 28,
        ext: [[0.2, 0.55, 1.2, 1.42]],
        invuln: [inv(0, 6, Invuln.Full)],
        cancel: CANCEL.dm(),
        onEnter: (f) => f.world.flash(SUPER_FLASH_FRAMES, f),
        attack: {
          id: 2200, name: 'Eight Limbs', grade: 'super', dmg: 58,
          reaction: Reaction.Medium, impact: 0.88,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.SUPER_MAX, name: 'eight-limbs-max', anim: 'dm-eight-limbs-max', stance: 'stand',
        windows: [
          { start: 5, len: 3, hit: [[0.2, 0.9, 1.2, 1.48]] },
          { start: 10, len: 3, hit: [[0.2, 0.6, 1.24, 1.32]] },
          { start: 15, len: 3, hit: [[0.2, 0.9, 1.28, 1.52]] },
          { start: 20, len: 3, hit: [[0.2, 0.5, 1.3, 1.26]] },
          { start: 25, len: 3, hit: [[0.2, 0.9, 1.34, 1.56]] },
          { start: 32, len: 7, hit: [[0.24, 0.44, 1.62, 1.6]] },
        ],
        recovery: 30,
        ext: [[0.2, 0.5, 1.26, 1.46]],
        invuln: [inv(0, 11, Invuln.Full)],
        cancel: CANCEL.dm(),
        onEnter: (f) => f.world.flash(SUPER_FLASH_FRAMES, f),
        attack: {
          id: 2201, name: 'Eight Limbs MAX', grade: 'super', dmg: 66,
          reaction: Reaction.Blowback, juggleStart: 12, impact: 0.94,
        },
      },
      h,
    ),
    attackState(
      {
        id: S.NEOMAX, name: 'ram-muay', anim: 'neomax', stance: 'stand',
        windows: [
          { start: 6, len: 4, hit: [[0.14, 0.3, 1.4, 1.72]] },
          { start: 15, len: 4, hit: [[0.18, 0.3, 1.86, 1.76]] },
          { start: 26, len: 8, hit: [[0.18, 0.16, 2.2, 1.82]] },
        ],
        recovery: 42,
        ext: [[0.18, 0.4, 1.16, 1.5]],
        invuln: [inv(0, 20, Invuln.Full)],
        cancel: CANCEL.locked(),
        onEnter: (f) => f.world.flash(NEOMAX_FLASH_FRAMES, f),
        attack: {
          id: 2300, name: 'Ram Muay', grade: 'neomax', dmg: 128,
          reaction: Reaction.Blowback, juggleStart: 16, impact: 1,
        },
      },
      h,
    ),
  ];
}

export function maliCommands(): CommandDef[] {
  return [
    { name: 'neomax', motion: Motion.QCFx2, buttons: Btn.B | Btn.D, state: S.NEOMAX, priority: 100,
      require: { stance: 'ground', power: COST_NEOMAX } },
    { name: 'eight-max', motion: Motion.QCFx2, buttons: Btn.D, state: S.SUPER_MAX, priority: 94,
      require: { stance: 'ground', power: COST_SUPER_MAX } },
    { name: 'eight', motion: Motion.QCFx2, buttons: Btn.B, state: S.SUPER, priority: 93,
      require: { stance: 'ground', power: COST_SUPER } },

    { name: 'sok-ex', motion: Motion.DP, buttons: Btn.A | Btn.C, state: S.SPECIAL_2_EX, priority: 88,
      require: { stance: 'ground', power: COST_EX } },
    { name: 'teep-ex', motion: Motion.QCF, buttons: Btn.B | Btn.D, state: S.SPECIAL_1_EX, priority: 87,
      require: { stance: 'ground', power: COST_EX } },
    { name: 'khao-ex', motion: Motion.QCB, buttons: Btn.B | Btn.D, state: S.SPECIAL_3_EX, priority: 86,
      require: { stance: 'ground', power: COST_EX } },

    { name: 'sok-c', motion: Motion.DP, buttons: Btn.C, state: S.SPECIAL_2, priority: 82,
      require: { stance: 'ground' } },
    { name: 'sok-a', motion: Motion.DP, buttons: Btn.A, state: S.SPECIAL_2, priority: 82,
      require: { stance: 'ground' } },
    { name: 'clinch', motion: Motion.HCF, buttons: Btn.A, state: S.SPECIAL_4, priority: 81,
      require: { stance: 'ground' } },
    { name: 'clinch-c', motion: Motion.HCF, buttons: Btn.C, state: S.SPECIAL_4, priority: 81,
      require: { stance: 'ground' } },
    { name: 'teep', motion: Motion.QCF, buttons: Btn.D, state: S.SPECIAL_1, priority: 80,
      require: { stance: 'ground' } },
    { name: 'teep-b', motion: Motion.QCF, buttons: Btn.B, state: S.SPECIAL_1, priority: 80,
      require: { stance: 'ground' } },
    { name: 'khao', motion: Motion.QCB, buttons: Btn.D, state: S.SPECIAL_3, priority: 79,
      require: { stance: 'ground' } },
    { name: 'khao-b', motion: Motion.QCB, buttons: Btn.B, state: S.SPECIAL_3, priority: 79,
      require: { stance: 'ground' } },

    { name: 'long-knee', buttons: Btn.B, dir: 6, state: S.CMD_1, priority: 62, require: { stance: 'ground' } },
    { name: 'cut-kick', buttons: Btn.D, dir: 3, state: S.CMD_2, priority: 61, require: { stance: 'ground' } },
  ];
}
