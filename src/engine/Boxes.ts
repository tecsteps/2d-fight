/**
 * CLSN boxes — the geometry every exchange is actually decided by.
 *
 * M.U.G.E.N calls them CLSN1 (attack) and CLSN2 (hurt); we keep the same idea
 * and the same authoring model: axis-aligned rectangles in **character-local
 * space**, with the origin at the point between the feet, +x pointing the way
 * the character faces and +y up. Facing is applied when the box is transformed
 * to world space, so a move is authored once and plays identically mirrored.
 *
 * Boxes are per-frame. A move owns a short track of `FrameBoxes` entries, each
 * marked with the state frame it becomes current on; the active set is the last
 * entry at or before the current frame. That is exactly how a sprite-based
 * fighter works — one CLSN set per drawing — and it keeps the data readable.
 *
 * Units are metres, matching the render world. Nothing here allocates during
 * the fight: every query writes into a caller-owned AABB.
 */

/** Local-space rect `[x0, y0, x1, y1]`. x is forward-relative, y is up from the feet. */
export type BoxTuple = readonly [number, number, number, number];

/** World-space axis-aligned box. Mutable so it can be reused across ticks. */
export interface AABB {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export enum BoxKind {
  /** CLSN2 — can be hit here. */
  Hurt = 0,
  /** CLSN1 — hits here. */
  Hit = 1,
  /** Body volume that keeps two fighters from occupying the same ground. */
  Push = 2,
  /** Throw reach, drawn only when a throw is being attempted. */
  Throw = 3,
}

export function aabb(): AABB {
  return { x0: 0, y0: 0, x1: 0, y1: 0 };
}

export function copyAABB(src: AABB): AABB {
  return { x0: src.x0, y0: src.y0, x1: src.x1, y1: src.y1 };
}

/**
 * Local box -> world box at `(x, y)` facing `facing`.
 *
 * Mirroring swaps the x pair as well as negating it, otherwise a box authored
 * as x0 < x1 would come back inverted and every overlap test would fail.
 */
export function toWorld(b: BoxTuple, x: number, y: number, facing: number, out: AABB): AABB {
  if (facing >= 0) {
    out.x0 = x + b[0];
    out.x1 = x + b[2];
  } else {
    out.x0 = x - b[2];
    out.x1 = x - b[0];
  }
  out.y0 = y + b[1];
  out.y1 = y + b[3];
  return out;
}

export function overlaps(a: AABB, b: AABB): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Does any box in `as` touch any box in `bs`? Writes the first hit pair's overlap. */
export function overlapsAny(as: readonly AABB[], bs: readonly AABB[], out?: AABB): boolean {
  for (let i = 0; i < as.length; i++) {
    for (let j = 0; j < bs.length; j++) {
      if (overlaps(as[i], bs[j])) {
        if (out) intersection(as[i], bs[j], out);
        return true;
      }
    }
  }
  return false;
}

/** Overlap rect of two boxes known to intersect. The hitspark goes at its centre. */
export function intersection(a: AABB, b: AABB, out: AABB): AABB {
  out.x0 = a.x0 > b.x0 ? a.x0 : b.x0;
  out.y0 = a.y0 > b.y0 ? a.y0 : b.y0;
  out.x1 = a.x1 < b.x1 ? a.x1 : b.x1;
  out.y1 = a.y1 < b.y1 ? a.y1 : b.y1;
  return out;
}

/** How far `a` and `b` interpenetrate horizontally; 0 if they are clear. */
export function penetrationX(a: AABB, b: AABB): number {
  if (!overlaps(a, b)) return 0;
  const right = a.x1 - b.x0;
  const left = b.x1 - a.x0;
  return right < left ? right : left;
}

export function centreX(b: AABB): number {
  return (b.x0 + b.x1) * 0.5;
}

export function centreY(b: AABB): number {
  return (b.y0 + b.y1) * 0.5;
}

/** One drawing's worth of collision data. */
export interface FrameBoxes {
  /** State frame this set becomes current on. Entries must be ascending. */
  from: number;
  hurt: readonly BoxTuple[];
  /** Present only on frames where the move can actually connect. */
  hit?: readonly BoxTuple[];
  /** Overrides the fighter's default body volume (crouch is wider and shorter). */
  push?: BoxTuple;
}

/** The set current at `frame`. Tracks are short, so a linear scan beats a search. */
export function boxesAt(track: readonly FrameBoxes[], frame: number): FrameBoxes {
  let found = track[0];
  for (let i = 1; i < track.length; i++) {
    if (track[i].from > frame) break;
    found = track[i];
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * Debug capture
 *
 * The sim runs headless, so it never draws anything. It only *records* the
 * boxes it tested this tick when the toggle is on; `BoxDebug.ts` turns that
 * recording into Three.js line geometry. Keeping the two apart means enabling
 * box display cannot perturb the simulation.
 * ------------------------------------------------------------------ */

export interface DebugBox extends AABB {
  kind: BoxKind;
  /** Fighter slot the box belongs to, for colouring. */
  owner: number;
}

class BoxDebugRecorder {
  enabled = false;
  readonly boxes: DebugBox[] = [];

  /** Called once per tick before the combat pass. */
  begin(): void {
    if (this.enabled) this.boxes.length = 0;
  }

  add(kind: BoxKind, owner: number, b: AABB): void {
    if (!this.enabled) return;
    this.boxes.push({ kind, owner, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
  }

  addLocal(kind: BoxKind, owner: number, b: BoxTuple, x: number, y: number, facing: number): void {
    if (!this.enabled) return;
    this.add(kind, owner, toWorld(b, x, y, facing, aabb()));
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.boxes.length = 0;
  }

  toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }
}

export const boxDebug = new BoxDebugRecorder();
