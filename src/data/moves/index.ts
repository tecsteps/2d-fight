import type { BoxTuple } from '../../engine/Boxes';
import type { CommandDef, MoveList, StateDef } from '../../engine/contract';
import type { FighterDef } from '../roster';
import { PUSH_AIR, PUSH_CROUCH, PUSH_STAND, REF_HEIGHT } from './build';
import { commonCommands, commonStates, normalCommands } from './common';
import { daviCommands, daviStates } from './davi';
import { kaiCommands, kaiStates } from './kai';
import { maliCommands, maliStates } from './mali';
import { veraCommands, veraStates } from './vera';

/**
 * Assembles a fighter's complete move list: the universal chassis from
 * `common.ts`, then their own states and commands layered on top. A character
 * file may override a common state simply by declaring the same number, which
 * is how a character would get, say, a unique backstep.
 *
 * The result is pure data and never mutated, so it is built once per fighter id
 * and shared by every `Fighter` instance — including both sides of a mirror
 * match, and every rollback re-simulation.
 */

type Kit = {
  states: (def: FighterDef) => StateDef[];
  commands: () => CommandDef[];
};

const KITS: Record<string, Kit> = {
  kai: { states: kaiStates, commands: kaiCommands },
  mali: { states: maliStates, commands: maliCommands },
  davi: { states: daviStates, commands: daviCommands },
  vera: { states: veraStates, commands: veraCommands },
};

const cache = new Map<string, MoveList>();

export function moveListFor(def: FighterDef): MoveList {
  const cached = cache.get(def.id);
  if (cached) return cached;

  const kit = KITS[def.id];
  if (!kit) throw new Error(`No move list authored for fighter "${def.id}"`);

  const states = new Map<number, StateDef>();
  for (const s of commonStates(def)) states.set(s.id, s);
  for (const s of kit.states(def)) states.set(s.id, s);

  // Highest priority first, so the most specific input is always tested first.
  // The sort is stable in every engine we target, which keeps equal-priority
  // commands in authored order — and therefore keeps the sim deterministic.
  const commands = [...kit.commands(), ...commonCommands(def), ...normalCommands()].sort(
    (a, b) => b.priority - a.priority,
  );

  const s = def.proportions.height / REF_HEIGHT;
  const list: MoveList = {
    id: def.id,
    states,
    commands,
    pushStand: scale(PUSH_STAND, s),
    pushCrouch: scale(PUSH_CROUCH, s),
    pushAir: scale(PUSH_AIR, s),
  };
  cache.set(def.id, list);
  return list;
}

function scale(b: BoxTuple, s: number): BoxTuple {
  return [b[0] * s, b[1] * s, b[2] * s, b[3] * s];
}

export { S } from './build';
