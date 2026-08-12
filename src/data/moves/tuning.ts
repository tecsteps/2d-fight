/**
 * Global fight tuning.
 *
 * Everything the simulation balances against lives here rather than inline in
 * the engine, so a designer can retune the game without opening a logic file.
 * Numbers are chosen to sit where KOF XIII sits: ~1000 health, five power
 * stocks, damage scaling that lets a full HD combo take about 70% but never
 * quite kill from neutral.
 *
 * Units: metres and frames at 60 Hz. Velocities are metres per frame.
 */

/** Ticks per displayed timer count. KOF's clock is slightly faster than real time. */
export const TICKS_PER_COUNT = 58;

/** Round clock, in displayed counts. */
export const ROUND_COUNTS = 60;

/* ---------------------------------------------------------------- *
 * Physics
 * ---------------------------------------------------------------- */

/**
 * Baseline gravity. A fighter's actual gravity is derived from this and their
 * weight, and their jump velocity from their authored apex — so a heavy
 * character reaches the same height in less time, which is exactly how a
 * grappler's jump should feel next to a capoeirista's.
 */
export const GRAVITY = 0.0086;

/** Ground friction per frame while standing / crouching. */
export const FRICTION_STAND = 0.86;
export const FRICTION_CROUCH = 0.8;
/** Below this speed, friction snaps to zero so characters do not creep. */
export const FRICTION_FLOOR = 0.0015;

/** Horizontal air drag. Almost none — air momentum in KOF is committed. */
export const AIR_DRAG = 0.998;

/** Terminal fall speed, so a long juggle cannot become a missile. */
export const MAX_FALL = 0.32;

/** Half-width of the playfield in metres. Fighters cannot walk past this. */
export const STAGE_HALF_WIDTH = 18.5;

/**
 * The pair is never allowed further apart than this. KOF keeps both fighters on
 * one screen; the camera zooms out to this and no further.
 */
export const MAX_SEPARATION = 8.6;

/** Extra shove the attacker eats when the defender's back is on the wall. */
export const CORNER_PUSH_TRANSFER = 1.0;

/** Ground level. Everything falls to here. */
export const GROUND_Y = 0;

/* ---------------------------------------------------------------- *
 * Stun and reactions
 * ---------------------------------------------------------------- */

/** Frames of extra hitstun a counter-hit adds. */
export const COUNTER_HITSTUN_BONUS = 6;
/** Damage multiplier for a counter-hit, before the move's own bonus. */
export const COUNTER_DAMAGE = 1.25;
/** Extra freeze on a counter-hit, which is what sells it. */
export const COUNTER_HITSTOP_BONUS = 4;

/** Juggle points a launched victim starts with. */
export const JUGGLE_POINTS = 15;

/** Frames the victim lies on the floor before the getup state. */
export const KNOCKDOWN_FRAMES = 26;
/** Frames of the getup animation. Rising is the only truly safe part. */
export const GETUP_FRAMES = 18;
/** Getup is strike-invulnerable for this long — KOF's wake-up cushion. */
export const GETUP_INVULN = 12;
/** Window after landing from a knockdown in which a recovery roll is legal. */
export const UKEMI_WINDOW = 8;

/** Frames of hitstop that a whiffed-into-nothing super flash still holds. */
export const SUPER_FLASH_FRAMES = 34;
export const NEOMAX_FLASH_FRAMES = 52;

/* ---------------------------------------------------------------- *
 * Damage scaling
 * ---------------------------------------------------------------- */

/**
 * Combo scaling, indexed by hit number (0-based). KOF XIII leaves the first two
 * hits alone so that a two-hit confirm still hurts, then falls off steadily and
 * bottoms out — long HD combos trade damage for style, which is the point.
 */
export const COMBO_SCALE: readonly number[] = [
  1.0, 1.0, 0.9, 0.85, 0.8, 0.75, 0.7, 0.66, 0.62, 0.58, 0.54, 0.5, 0.46, 0.43,
  0.4, 0.37, 0.34, 0.31, 0.28, 0.26, 0.24, 0.22, 0.2,
];
export const COMBO_SCALE_FLOOR = 0.18;

/** Repeating a move inside one combo scales it by this much again, per repeat. */
export const REPEAT_PENALTY = 0.75;

/** No hit may ever be scaled below this fraction of its base damage. */
export const MIN_DAMAGE_FRACTION = 0.12;

/** Frames without contact before the combo counter resets. */
export const COMBO_DROP_FRAMES = 4;

/* ---------------------------------------------------------------- *
 * Guard
 * ---------------------------------------------------------------- */

/**
 * Guard gauge. Sized so that roughly eight blocked heavy hits or specials break
 * a guard that never gets a moment to breathe — enough that turtling through a
 * whole round is not a plan, not so little that blocking stops being an answer.
 */
export const GUARD_MAX = 720;
/** Guard gauge regained per frame once the pressure stops. */
export const GUARD_REGEN = 2.2;
/** Frames after the last blocked hit before regeneration starts. */
export const GUARD_REGEN_DELAY = 42;
/** Frames of helpless stun on a guard crush. Long enough to be a full punish. */
export const GUARD_CRUSH_FRAMES = 48;
/** Guard gauge you come back with after being crushed. */
export const GUARD_CRUSH_REFUND = 700;

/** Chip damage can never kill; the defender is left on this much health. */
export const CHIP_KILL_FLOOR = 1;

/* ---------------------------------------------------------------- *
 * Meter — KOF XIII power gauge, drive gauge and HD mode
 * ---------------------------------------------------------------- */

/** Gauge units in one power stock. */
export const STOCK = 1000;
/** Five stocks, as in KOF XIII. */
export const MAX_STOCKS = 5;
export const POWER_MAX = STOCK * MAX_STOCKS;

/** Costs, in gauge units. */
export const COST_EX = STOCK; // EX special
export const COST_SUPER = STOCK; // DM
export const COST_SUPER_MAX = STOCK * 2; // EX DM / MAX version
export const COST_NEOMAX = STOCK * 3;
export const COST_GUARD_CANCEL = STOCK; // guard cancel roll and blowback

/** Meter earned per point of damage dealt / taken. Being hit pays better. */
export const POWER_PER_DAMAGE_DEALT = 0.9;
export const POWER_PER_DAMAGE_TAKEN = 1.6;

export const DRIVE_MAX = 1000;
/** Drive Cancel — special into special or super, mid-combo. */
export const COST_DRIVE_CANCEL = 500;
/** HD activation empties the bar. */
export const COST_HD = DRIVE_MAX;
/** Frames HD mode lasts once activated. */
export const HD_FRAMES = 340;
/** Drive drained per frame while HD is running. */
export const HD_DRAIN = DRIVE_MAX / HD_FRAMES;
/** Each HD cancel costs a slice of the remaining timer, so the combo has an end. */
export const HD_CANCEL_COST = 14;
/** Damage dealt during HD is scaled — the mode buys length, not raw damage. */
export const HD_DAMAGE_SCALE = 0.86;

/* ---------------------------------------------------------------- *
 * Throws
 * ---------------------------------------------------------------- */

/** Frames a throw break input may lag the grab. */
export const THROW_TECH_WINDOW = 9;
/** Both fighters are shoved this far apart by a break. */
export const THROW_TECH_PUSH = 0.055;
/** Frames after landing / waking in which throws simply do not connect. */
export const THROW_PROTECT_FRAMES = 6;

/* ---------------------------------------------------------------- *
 * Round flow
 * ---------------------------------------------------------------- */

export const INTRO_FRAMES = 72;
export const READY_FRAMES = 54;
export const FIGHT_FRAMES = 36;
export const KO_FRAMES = 96;
export const ROUND_END_FRAMES = 150;
/** Rounds needed to take a 1v1 set. */
export const ROUNDS_TO_WIN = 2;

/**
 * KOF hands the surviving character a slice of health back between rounds, so a
 * 3v3 anchor is not doomed by whatever the point character left them with.
 */
export const ROUND_HEAL_FRACTION = 0.16;

/** Frames the KO is played back at half speed. Deterministic: every other tick. */
export const KO_SLOWMO_FRAMES = 48;
