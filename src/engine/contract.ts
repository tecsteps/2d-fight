import type { MotionSpec } from '../core/Input';
import type { BoxTuple, FrameBoxes } from './Boxes';
import type { Fighter } from './Fighter';

/**
 * The vocabulary shared by the simulation and the authored frame data.
 *
 * `src/data/moves` speaks only this file, and the engine implements it. Keeping
 * the enums and the move/state shapes here is what lets frame data live outside
 * the logic without the two ending up in an import cycle.
 */

/** Body posture. Decides which guard is legal and which hit reaction plays. */
export const enum StateType {
  Stand = 0,
  Crouch = 1,
  Air = 2,
  /** Knocked down — on the floor, not yet up. */
  Lying = 3,
}

/** What the character is doing, in the only three flavours combat cares about. */
export const enum MoveType {
  Idle = 0,
  Attack = 1,
  BeingHit = 2,
}

/** Which integrator runs this frame. `None` means the state drives position itself. */
export const enum PhysicsMode {
  Stand = 0,
  Crouch = 1,
  Air = 2,
  None = 3,
}

/**
 * The KOF cancel ladder. A move may always be cancelled into something strictly
 * further up the ladder once it has connected; going sideways or down needs a
 * resource (Drive Cancel) or HD mode.
 */
export const enum AttackTier {
  None = 0,
  Normal = 1,
  CommandNormal = 2,
  Special = 3,
  EX = 4,
  Super = 5,
  NeoMax = 6,
}

/** How an attack must be guarded. */
export const enum GuardKind {
  /** Blockable standing or crouching. Most attacks. */
  Mid = 0,
  /** Must be blocked crouching. Sweeps and low pokes. */
  Low = 1,
  /** Must be blocked standing. Jump-ins and overhead command normals. */
  Overhead = 2,
  /** Only air-guardable, i.e. only relevant while the defender is airborne. */
  Air = 3,
  /** Throws and command grabs — no guard, only a tech. */
  Unblockable = 4,
}

/** The shape of the victim's reaction. Drives state choice, velocity and anim. */
export const enum Reaction {
  Light = 0,
  Medium = 1,
  Heavy = 2,
  /** Sweep: knocks down without launching. */
  Trip = 3,
  /** Sends the victim airborne and opens the juggle. */
  Launch = 4,
  /** KOF's CD knockback — long, flat, wall-carrying. */
  Blowback = 5,
  /** Stagger on the spot; only supers and counter-hit command normals do this. */
  Crumple = 6,
  WallBounce = 7,
  GroundBounce = 8,
}

/** Invulnerability bits. A window may combine them. */
export const enum Invuln {
  None = 0,
  Strike = 1 << 0,
  Throw = 1 << 1,
  /** Off the ground: low attacks miss. */
  Low = 1 << 2,
  Full = Strike | Throw | Low,
}

export const enum HitOutcomeKind {
  None = 0,
  Hit = 1,
  CounterHit = 2,
  Blocked = 3,
  /** Connected but the victim had no juggle points left. */
  JuggleRefused = 4,
  /** Throw attempt that the victim broke. */
  Teched = 5,
}

/** A window inside a state, in frames relative to state entry. */
export interface FrameWindow {
  from: number;
  to: number;
}

export interface InvulnWindow extends FrameWindow {
  bits: number;
}

/**
 * Everything about an attack that combat needs. One per attacking state; a
 * multi-hit move carries several, indexed by the active window it belongs to.
 */
export interface AttackDef {
  /** Stable id used for the repeat-move damage penalty. */
  id: number;
  name: string;
  tier: AttackTier;
  guard: GuardKind;

  damage: number;
  /** Chip damage dealt through a guard, as a fraction of `damage`. */
  chip: number;

  /** Frames the victim cannot act after being hit / after guarding. */
  hitstun: number;
  blockstun: number;
  /** Frames both fighters freeze on contact — the "impact hold". */
  hitstop: number;
  /** Extra freeze the victim alone eats, which is what the shake reads as. */
  hitShake: number;

  /** Knockback given to a grounded victim, facing-relative to the attacker. */
  hitVel: readonly [number, number];
  /** Knockback given to an airborne victim. */
  airHitVel: readonly [number, number];
  /** Knockback given to a guarding victim. */
  guardVel: readonly [number, number];
  /** How hard the *attacker* is shoved back on contact. */
  selfPush: number;
  /** How hard the attacker is shoved back when the hit was guarded. */
  selfPushGuard: number;

  reaction: Reaction;
  /** Reaction used when the victim is already airborne, if it differs. */
  airReaction?: Reaction;

  /** Juggle points this hit costs. An air hit is refused if the victim is short. */
  juggle: number;
  /** Juggle points granted to the victim when this move starts the launch. */
  juggleStart: number;

  /** Guard gauge removed on block. */
  guardDamage: number;

  /** Power gauge, in gauge units (1000 = one stock). */
  powerHit: number;
  powerBlock: number;
  powerWhiff: number;
  /** Power the *victim* earns for eating it — KOF pays you for being hit. */
  powerTaken: number;
  /** Drive gauge earned by the attacker. */
  driveHit: number;
  driveBlock: number;

  /** Trade arbitration. Higher wins outright; equal trades. */
  priority: number;
  /** May this activation connect more than once with the same victim? */
  multiHit: boolean;
  /** Extra damage multiplier on counter-hit, above the global bonus. */
  counterBonus: number;
  /** Ignores the combo scaling table — reserved for the first hit of a NeoMax. */
  noScaling: boolean;
  /** Camera/impact weight 0..1, read by the renderer for shake and punch-in. */
  impact: number;
}

/** A throw. KOF throws are a range check plus a tech window, not a hitbox. */
export interface ThrowDef {
  id: number;
  name: string;
  tier: AttackTier;
  /** Forward reach from the attacker's origin, metres. */
  range: number;
  /** Vertical span the victim's origin must sit in. */
  minY: number;
  maxY: number;
  damage: number;
  /** State the *attacker* switches to once the throw takes. */
  execState: number;
  /** State the victim is put in. */
  victimState: number;
  /** Frames the victim's throw-break input may lag the grab. */
  techWindow: number;
  /** Command grabs cannot be teched. */
  techable: boolean;
  hitstop: number;
  powerHit: number;
  powerTaken: number;
  driveHit: number;
  impact: number;
}

/** Cancel permissions for a single attacking state. */
export interface CancelRule {
  /** Lowest tier reachable once the move has hit or been guarded. */
  onContact: AttackTier;
  /** Lowest tier reachable when the move whiffed. KOF is stingy here. */
  onWhiff: AttackTier;
  /** Specific states this move chains into regardless of tier (rapid-fire lights). */
  chain?: readonly number[];
  /** Window the cancel is legal in, relative to the first active frame. */
  window?: FrameWindow;
  /** May this state cancel into itself? Only true for true rapid-fire jabs. */
  self?: boolean;
}

export interface StateDef {
  id: number;
  name: string;
  type: StateType;
  moveType: MoveType;
  physics: PhysicsMode;
  /** Does the player have control on entry? */
  ctrl: boolean;
  /** Frames before `next` is entered automatically. -1 = the state decides. */
  duration: number;
  next: number;
  /** Animation clip name handed to the animator. */
  anim: string;
  /** Facing is locked for the duration of most attacks. */
  turnable?: boolean;

  boxes?: readonly FrameBoxes[];
  attack?: AttackDef;
  /** Frames the hitbox is live, relative to state entry. */
  active?: readonly FrameWindow[];
  /**
   * Per-window attack override, parallel to `active`. Multi-hit moves almost
   * always want the later hits weaker, and a rekka's last hit knocks down.
   */
  windowAttacks?: readonly (AttackDef | undefined)[];
  throw?: ThrowDef;
  invuln?: readonly InvulnWindow[];
  cancel?: CancelRule;

  /** Velocity set on entry, facing-relative x. */
  enterVel?: readonly [number, number];
  /** Per-fighter scaling applied to `enterVel` — walk/run/jump read their def. */
  onEnter?: (f: Fighter) => void;
  onTick?: (f: Fighter) => void;
  onExit?: (f: Fighter) => void;
}

/** Buttons a command may require, plus how it must be entered. */
export interface CommandDef {
  name: string;
  /** Motion from `core/Input`, facing-relative. Omit for a button-only command. */
  motion?: MotionSpec;
  /** Charge command: hold `hold` for `frames`, then press `release`. */
  charge?: { hold: number; release: number; frames: number };
  /** Bitmask of buttons. All of them must be freshly pressed together. */
  buttons: number;
  /** Direction that must be held this frame, facing-relative. */
  dir?: number;
  /** Frames the button press may lag the motion. */
  lenience?: number;
  /** Frames the buttons of a multi-button command may be split across. */
  window?: number;
  state: number;
  require?: MoveRequire;
  /** Tested high to low; the first legal command wins. */
  priority: number;
}

export interface MoveRequire {
  /** Posture the fighter must be in. */
  stance?: 'ground' | 'air' | 'crouch' | 'stand';
  /** Power gauge units needed and spent. */
  power?: number;
  /** Drive gauge units needed and spent. */
  drive?: number;
  /** Only while HD mode is running. */
  hdOnly?: boolean;
  /** Only while HD mode is *not* running (activation commands). */
  notHD?: boolean;
  /** Only while blocking — guard cancels. */
  guardOnly?: boolean;
  /** Custom gate, evaluated against the live fighter. */
  test?: (f: Fighter) => boolean;
}

/** Everything one fighter can do. Built once per fighter id, then shared. */
export interface MoveList {
  id: string;
  states: ReadonlyMap<number, StateDef>;
  /** Pre-sorted by descending priority. */
  commands: readonly CommandDef[];
  /** Default body volume while standing / crouching / airborne. */
  pushStand: BoxTuple;
  pushCrouch: BoxTuple;
  pushAir: BoxTuple;
}
