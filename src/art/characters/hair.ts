import * as THREE from 'three';
import type { RigMetrics } from '../../anim/Skeleton';
import type { FighterDef } from '../../data/roster';
import { createToonMaterial } from '../../render/npr/ToonMaterial';
import { createOutlineMesh } from '../../render/npr/outline';
import { inkColor } from '../../render/npr/ramps';
import { clamp01, hairStrands, noise, smoothstep, type Noise, type TexSet } from '../textures';
import type { BuiltCharacter } from './rig';

/**
 * Hair.
 *
 * A fighting game character is recognised in one frame, at a distance, against a
 * busy stage — and above the shoulders the only thing carrying that read is the
 * hair. So this is built as **form**, not as texture: every lock, loc, spike and
 * plait is real swept geometry with a real silhouette, because the ink outline
 * pass draws what the geometry does and nothing else. Cards with alpha would
 * give us a shape that vanishes edge-on and an outline that inks a rectangle.
 *
 * ## How a head of hair is assembled here
 *
 * 1. **A scalp shell.** A closed cap fitted to the cranium the body mesh
 *    actually built (see `Skull`), thick enough to have its own silhouette above
 *    the skull and sunk *into* the skull at its lower edge — so the hairline is
 *    the intersection curve of two solids and can never open a bald seam, at any
 *    angle, under any pose.
 * 2. **Swept tubes** for everything that hangs, sticks up or wraps: locks,
 *    locs, spikes, headband, ties. One generalised sweep with an elliptical,
 *    orientable cross-section covers all of it.
 * 3. **Braids as three interleaved strands.** Three tubes whose centres orbit a
 *    common axis, flattened so the plait is wider than it is deep, with the
 *    lateral travel eased at the extremes and the depth snapped at the
 *    crossings. That is what turns a twisted rope into a plait: the strands
 *    dwell at the outside of the braid and change sides quickly through the
 *    middle, which is exactly the lobe-and-chevron pattern a braid shows in
 *    silhouette.
 *
 * ## Motion
 *
 * Anything that should swing gets a **bone chain** parented under the fighter's
 * head bone, and the geometry is skinned to it. The chains are handed back on
 * `HairRig.chains` with their rest directions, lengths and section radii, so a
 * secondary-motion pass can integrate a spring per segment and write back
 * `bone.quaternion` without knowing anything about hair. Everything else is
 * skinned rigidly to the head bone, which is index 0 of the hair's own skeleton.
 *
 * The chain bones live in the fighter's bone hierarchy but *not* in the body's
 * `THREE.Skeleton`, so the body's skinning, the poser and the clip system never
 * see them.
 *
 * Nothing here is loaded: the maps come from `hairStrands()`, the shading from
 * `createToonMaterial({ kind: 'hair' })`, and every measurement is derived from
 * `rig.metrics`.
 */

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/** One swinging strand — a braid, a ponytail, a loc, a trailing ribbon. */
export interface HairChain {
  /** `<fighter>:<part>`, e.g. `mali:braid`. */
  name: string;
  /** Root first. `bones[0]` is a child of the head bone. */
  bones: THREE.Bone[];
  /** Rest length of the segment that starts at each bone, in metres. */
  length: number[];
  /** Rest direction of each segment, unit, in rig space. */
  dir: THREE.Vector3[];
  /** Section half-width at each bone. A physics pass needs the mass and the drag area. */
  radius: number[];
  /** How hard this chain resists leaving its rest pose, 0..1. A braid is stiffer than a loc. */
  stiffness: number;
  /** Air drag hint, 0..1. Thin locs whip; a thick plait does not. */
  drag: number;
}

export interface HairRig {
  group: THREE.Group;
  /** Every swinging strand, for the secondary-motion pass. */
  chains: HairChain[];
  meshes: THREE.SkinnedMesh[];
  /** `[head, ...chain bones]` — hair skin indices are into this array. */
  skeleton: THREE.Skeleton;
  triangles: number;
  dispose(): void;
}

/** The hair data hanging off an object returned by `buildHair`. */
export function hairRigOf(o: THREE.Object3D): HairRig | undefined {
  return o.userData.hair as HairRig | undefined;
}

// ---------------------------------------------------------------------------
// Mesh accumulation
// ---------------------------------------------------------------------------

/** Up to three bone influences; hair never needs the fourth slot. */
interface Bind {
  i: [number, number, number];
  w: [number, number, number];
}

/** Index of the head bone in the hair skeleton. Everything rigid binds here. */
const HEAD = 0;
const RIGID: Bind = { i: [HEAD, 0, 0], w: [1, 0, 0] };

class Buf {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly si: number[] = [];
  readonly sw: number[] = [];
  readonly idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vert(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, b: Bind): number {
    const i = this.pos.length / 3;
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.si.push(b.i[0], b.i[1], b.i[2], 0);
    this.sw.push(b.w[0], b.w[1], b.w[2], 0);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Wound so that (a→b) then (b→c) crosses toward the outward normal. */
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  geometry(): THREE.BufferGeometry | null {
    if (this.idx.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ---------------------------------------------------------------------------
// The skull
// ---------------------------------------------------------------------------

/**
 * The cranium as an ellipsoid, matched to the primitives `buildBodyPlan` sweeps
 * for the head.
 *
 * Hair that assumes a sphere floats at the temples and cuts into the occiput, so
 * this reads the same numbers the body did: `metrics.skullR` for the half-width
 * and `metrics.headLen` for where the cranium sits above the head joint. It is a
 * deliberate hair's breadth larger than the body's cranium, because the female
 * pass narrows the skull a further 3% and hair must never end up *inside* it.
 */
class Skull {
  readonly c = new THREE.Vector3();
  readonly r = new THREE.Vector3();
  /** Vertical distance from the head joint (chin height) to the crown. */
  readonly headLen: number;
  readonly R: number;

  constructor(m: RigMetrics, headJoint: THREE.Vector3) {
    this.headLen = m.headLen;
    this.R = m.skullR;
    this.c.set(0, headJoint.y + 0.66 * m.headLen, headJoint.z + 0.02 * m.headLen);
    this.r.set(m.skullR, m.skullR * 1.03, m.skullR * 1.22);
  }

  /** Unit direction from the cranium centre. θ = 0 faces +Z, +θ turns to +X. */
  static dir(theta: number, phi: number, out = new THREE.Vector3()): THREE.Vector3 {
    const sp = Math.sin(phi);
    return out.set(sp * Math.sin(theta), Math.cos(phi), sp * Math.cos(theta));
  }

  /** Surface point in direction (θ, φ), pushed `lift` metres along the normal. */
  at(theta: number, phi: number, lift = 0, out = new THREE.Vector3()): THREE.Vector3 {
    const d = Skull.dir(theta, phi, out);
    const k =
      1 /
      Math.sqrt(
        (d.x / this.r.x) ** 2 + (d.y / this.r.y) ** 2 + (d.z / this.r.z) ** 2,
      );
    d.multiplyScalar(k).add(this.c);
    if (lift !== 0) d.addScaledVector(this.normalAt(theta, phi, _n0), lift);
    return d;
  }

  /** Outward unit normal of the ellipsoid at (θ, φ). */
  normalAt(theta: number, phi: number, out = new THREE.Vector3()): THREE.Vector3 {
    const d = Skull.dir(theta, phi, out);
    return d
      .set(d.x / (this.r.x * this.r.x), d.y / (this.r.y * this.r.y), d.z / (this.r.z * this.r.z))
      .normalize();
  }
}

const _n0 = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Curves and sweeps
// ---------------------------------------------------------------------------

interface Frame {
  p: THREE.Vector3;
  t: THREE.Vector3;
  /** Cross-section axis carrying the *wide* radius. */
  e1: THREE.Vector3;
  /** Cross-section axis carrying the *thin* radius; a ribbon's face normal. */
  e2: THREE.Vector3;
  /** Arc length from the start, metres. */
  s: number;
}

function curvePoints(ctrl: THREE.Vector3[], samples: number): THREE.Vector3[] {
  if (ctrl.length === 2) {
    return Array.from({ length: samples }, (_, i) =>
      ctrl[0].clone().lerp(ctrl[1], i / (samples - 1)),
    );
  }
  const curve = new THREE.CatmullRomCurve3(ctrl, false, 'catmullrom', 0.5);
  return Array.from({ length: samples }, (_, i) => curve.getPoint(i / (samples - 1)));
}

/**
 * Frames along a point list.
 *
 * Without `orient` the cross-section is parallel transported, which is the only
 * way a long curved strand does not accumulate a twist it was never given.
 * With it — a headband hugging the skull, a lock lying flat on the forehead —
 * the flat face is aimed at a surface normal instead, which also makes a closed
 * loop close exactly, where transport would leave a seam.
 */
function buildFrames(
  pts: THREE.Vector3[],
  up: THREE.Vector3,
  orient?: (t: number, i: number) => THREE.Vector3,
): Frame[] {
  const n = pts.length;
  const frames: Frame[] = [];
  let s = 0;

  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const t = b.clone().sub(a);
    if (t.lengthSq() < 1e-12) t.copy(up);
    t.normalize();
    if (i > 0) s += pts[i].distanceTo(pts[i - 1]);

    let e1: THREE.Vector3;
    let e2: THREE.Vector3;
    if (orient) {
      e2 = orient(i / (n - 1), i).clone();
      e2.addScaledVector(t, -e2.dot(t));
      if (e2.lengthSq() < 1e-8) e2.set(0, 1, 0).addScaledVector(t, -t.y);
      e2.normalize();
      e1 = e2.clone().cross(t);
    } else {
      const prev = frames[i - 1];
      e1 = prev ? prev.e1.clone() : up.clone();
      e1.addScaledVector(t, -e1.dot(t));
      if (e1.lengthSq() < 1e-8) {
        e1.set(1, 0, 0).addScaledVector(t, -t.x);
        if (e1.lengthSq() < 1e-8) e1.set(0, 0, 1).addScaledVector(t, -t.z);
      }
      e1.normalize();
      e2 = t.clone().cross(e1);
    }
    frames.push({ p: pts[i].clone(), t, e1, e2, s });
  }
  return frames;
}

interface SweepSpec {
  /** Wide half-width at t, metres. */
  radius: (t: number) => number;
  /** Thin/wide ratio at t. 1 = round, 0.3 = ribbon. */
  flat?: (t: number) => number;
  sides?: number;
  bind?: (t: number) => Bind;
  /** Texture repeats per metre. */
  tile: number;
  /** Extra repeats around the section, on top of the physical wrap. */
  uScale?: number;
  /** Close the t=0 end with a fan. Off when the end is buried in the scalp. */
  capStart?: boolean;
  /** Taper the last ring to a point instead of capping it flat. */
  tip?: boolean;
  /** The path is a ring — join the last section back to the first, no caps. */
  loop?: boolean;
}

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

/**
 * One generalised cylinder.
 *
 * Normals are analytic — the ellipse gradient tilted by the radius slope — so a
 * tapered spike shades as a cone rather than as a cylinder that happens to get
 * thinner, and there is no seam where the section wraps.
 */
function sweep(buf: Buf, frames: Frame[], spec: SweepSpec): void {
  const sides = spec.sides ?? 10;
  const n = frames.length;
  // The section seam column is always duplicated so u can run to the full
  // circumference; only the *path* can be a loop.
  const cols = sides + 1;
  const rings: number[][] = [];
  // Never all the way to zero: a ring of coincident vertices is a fan of
  // degenerate triangles, and the ink hull cannot weld a normal out of them.
  const taperAt = (t: number): number =>
    spec.tip ? Math.sqrt(Math.max(0.02, 1 - t ** 4)) : 1;

  for (let i = 0; i < n; i++) {
    const f = frames[i];
    const t = i / (n - 1);
    const rw = spec.radius(t) * taperAt(t);
    const rt = rw * (spec.flat ? spec.flat(t) : 1);
    // Radius slope along the sweep, so the normal leans the way the surface does.
    const t0 = Math.max(0, i - 1) / (n - 1);
    const t1 = Math.min(n - 1, i + 1) / (n - 1);
    const ds = frames[Math.min(n - 1, i + 1)].s - frames[Math.max(0, i - 1)].s;
    const slope =
      ds > 1e-6 ? (spec.radius(t1) * taperAt(t1) - spec.radius(t0) * taperAt(t0)) / ds : 0;
    const bind = spec.bind ? spec.bind(t) : RIGID;
    const circ = Math.PI * (rw + rt);
    const ring: number[] = [];

    for (let j = 0; j < cols; j++) {
      const a = (j / sides) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      _p.copy(f.p).addScaledVector(f.e1, rw * ca).addScaledVector(f.e2, rt * sa);
      _q.set(0, 0, 0)
        .addScaledVector(f.e1, ca / Math.max(rw, 1e-5))
        .addScaledVector(f.e2, sa / Math.max(rt, 1e-5))
        .normalize()
        .addScaledVector(f.t, -slope)
        .normalize();
      ring.push(
        buf.vert(
          _p,
          _q,
          (j / sides) * (circ / spec.tile) * (spec.uScale ?? 1),
          f.s / spec.tile,
          bind,
        ),
      );
    }
    rings.push(ring);
  }

  const spans = spec.loop ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const next = rings[(i + 1) % n];
    for (let j = 0; j < sides; j++) {
      buf.quad(rings[i][j], rings[i][j + 1], next[j + 1], next[j]);
    }
  }
  if (spec.loop) return;

  if (spec.capStart) {
    const f0 = frames[0];
    const c = buf.vert(f0.p, _q.copy(f0.t).negate(), 0.5, 0, spec.bind ? spec.bind(0) : RIGID);
    for (let j = 0; j < sides; j++) buf.tri(c, rings[0][j + 1], rings[0][j]);
  }

  const f = frames[n - 1];
  const apex = buf.vert(
    _p.copy(f.p).addScaledVector(f.t, spec.tip ? spec.radius(1) * 0.6 : 0),
    _q.copy(f.t),
    0.5,
    f.s / spec.tile,
    spec.bind ? spec.bind(1) : RIGID,
  );
  for (let j = 0; j < sides; j++) buf.tri(rings[n - 1][j], rings[n - 1][j + 1], apex);
}

// ---------------------------------------------------------------------------
// The scalp shell
// ---------------------------------------------------------------------------

/** Catmull-Rom through evenly spaced values, clamped at both ends. */
function spline(v: number[], t: number): number {
  const n = v.length - 1;
  if (n <= 0) return v[0];
  const s = clamp01(t) * n;
  const i = Math.min(Math.floor(s), n - 1);
  const f = s - i;
  const p0 = v[Math.max(i - 1, 0)];
  const p1 = v[i];
  const p2 = v[i + 1];
  const p3 = v[Math.min(i + 2, n)];
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * f +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f +
      (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f)
  );
}

/** Five samples front → back, mirrored across the sagittal plane. */
function profile(samples: number[]): (theta: number) => number {
  return (theta: number) => {
    let a = ((theta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (a > Math.PI) a = Math.PI * 2 - a;
    return spline(samples, a / Math.PI);
  };
}

interface ScalpSpec {
  /** Hairline polar angle (degrees from the crown) at five azimuths, front → back. */
  edge: number[];
  /** Hair mass thickness in metres at the same five azimuths. */
  thickness: number[];
  /** Thickness at the crown itself. */
  crown: number;
  /** Extra radial lift, for a swept mass or a crown poof. */
  lift?: (theta: number, v: number) => number;
  /** Stubble amplitude in metres. Shaved sides only. */
  fuzz?: number;
  cols?: number;
  rows?: number;
  tile: number;
}

/**
 * The hair mass over the cranium, as one closed shell.
 *
 * The lower edge is sunk *inside* the skull rather than landing on it, so the
 * visible hairline is the intersection of two solids: it can never open a gap,
 * and the inner sheet — which exists only to close the shell for the ink hull —
 * is never seen.
 */
function scalp(buf: Buf, skull: Skull, spec: ScalpSpec, n: Noise): void {
  const cols = spec.cols ?? 56;
  const rows = spec.rows ?? 12;
  const edge = profile(spec.edge.map((d) => (d * Math.PI) / 180));
  const thick = profile(spec.thickness);
  const outer: number[][] = [];
  const inner: number[][] = [];
  // Deep enough to clear the 3% the female pass narrows the real cranium by.
  const inset = skull.R * 0.075;
  const nr = new THREE.Vector3();
  const du = new THREE.Vector3();
  const dv = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();

  const uSpan = (Math.PI * 2 * skull.R) / spec.tile;
  const vSpan = (skull.R * 1.6) / spec.tile;

  /** The outer surface of the hair mass as a parametric patch. */
  const at = (theta: number, v: number, out: THREE.Vector3): THREE.Vector3 => {
    const vc = clamp01(v);
    const phi = edge(theta) * (1 - vc);
    // The rim dives inside the skull; the mass reaches full thickness a short
    // way up, which is what gives the hairline a soft edge instead of a step.
    const s = smoothstep(0, 0.3, vc);
    const T = thick(theta) + (spec.crown - thick(theta)) * smoothstep(0.45, 1, vc);
    let off = T * s - T * 0.9 * (1 - s);
    if (spec.lift) off += spec.lift(theta, vc) * s;
    if (spec.fuzz) {
      off += spec.fuzz * (n.value(theta / (Math.PI * 2), phi / Math.PI, 26, 4) - 0.5) * s;
    }
    return skull.at(theta, phi, off, out);
  };

  // Normals come off the displaced patch, not off the skull: the mass changes
  // thickness with azimuth and height, and shading a lumpy surface with a smooth
  // ellipsoid's normals is what makes procedural hair look shrink-wrapped.
  const normalAt = (theta: number, v: number, out: THREE.Vector3): THREE.Vector3 => {
    const h = 0.008;
    du.copy(at(theta + h, v, a)).sub(at(theta - h, v, b));
    dv.copy(at(theta, v + h, a)).sub(at(theta, v - h, b));
    out.crossVectors(du, dv);
    if (out.lengthSq() < 1e-14) skull.normalAt(theta, edge(theta) * (1 - v), out);
    return out.normalize();
  };

  for (let i = 0; i < rows; i++) {
    const v = i / (rows - 1);
    const ro: number[] = [];
    const ri: number[] = [];
    for (let j = 0; j <= cols; j++) {
      const theta = (j / cols) * Math.PI * 2;
      const phi = edge(theta) * (1 - v);
      const p = at(theta, v, new THREE.Vector3());
      normalAt(theta, v, nr);
      const u = (j / cols) * uSpan;
      ro.push(buf.vert(p, nr, u, (1 - v) * vSpan, RIGID));
      skull.at(theta, phi, -inset, p);
      ri.push(buf.vert(p, nr.clone().negate(), u, (1 - v) * vSpan, RIGID));
    }
    outer.push(ro);
    inner.push(ri);
  }

  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols; j++) {
      buf.quad(outer[i][j], outer[i][j + 1], outer[i + 1][j + 1], outer[i + 1][j]);
      buf.quad(inner[i][j], inner[i + 1][j], inner[i + 1][j + 1], inner[i][j + 1]);
    }
  }
  // Rim, closing outer to inner along the hairline.
  for (let j = 0; j < cols; j++) {
    buf.quad(outer[0][j], inner[0][j], inner[0][j + 1], outer[0][j + 1]);
  }
}

// ---------------------------------------------------------------------------
// Braids
// ---------------------------------------------------------------------------

interface BraidSpec {
  /** Half-width of the whole plait at t. */
  radius: (t: number) => number;
  /** Metres of axis length per full plait period. Each period shows three lobes. */
  period: number;
  bind?: (t: number) => Bind;
  sides?: number;
  tile: number;
  tip?: boolean;
}

/**
 * A three-strand plait.
 *
 * The strands orbit the axis, but not on a circle: the lateral travel is eased
 * so each strand *dwells* at the outside of the braid, and the depth is snapped
 * so it changes sides quickly through the middle. A plain circular orbit gives a
 * twisted rope — lobes marching steadily in one direction — where a plait gives
 * lobes that stack alternately left and right with a chevron between them. That
 * difference is the whole read at fighting-game distance.
 */
function braid(buf: Buf, frames: Frame[], spec: BraidSpec): void {
  const n = frames.length;
  const sides = spec.sides ?? 9;

  for (let j = 0; j < 3; j++) {
    const pts: THREE.Vector3[] = [];
    const rs: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = frames[i];
      const t = i / (n - 1);
      const R = spec.radius(t);
      const phase = (f.s / spec.period + j / 3) * Math.PI * 2;
      const si = Math.sin(phase);
      const co = Math.cos(phase);
      const lat = Math.sign(si) * Math.abs(si) ** 0.78;
      const dep = Math.sign(co) * Math.abs(co) ** 0.5;
      pts.push(
        f.p
          .clone()
          .addScaledVector(f.e1, R * 0.47 * lat)
          .addScaledVector(f.e2, R * 0.25 * dep),
      );
      // A lobe swells where it is on the outside of the plait; that swelling is
      // what makes the braid bumpy in silhouette rather than a smooth cylinder.
      rs.push(R * 0.56 * (0.88 + 0.2 * Math.abs(si)));
    }
    const sf = buildFrames(pts, new THREE.Vector3(0, 0, 1));
    sweep(buf, sf, {
      radius: (t) => rs[Math.min(n - 1, Math.round(t * (n - 1)))],
      sides,
      bind: spec.bind,
      tile: spec.tile,
      capStart: true,
      tip: spec.tip,
    });
  }
}

// ---------------------------------------------------------------------------
// Bone chains
// ---------------------------------------------------------------------------

interface Ctx {
  def: FighterDef;
  m: RigMetrics;
  skull: Skull;
  head: THREE.Bone;
  headPos: THREE.Vector3;
  n: Noise;
  /** Bone list of the hair skeleton; index 0 is the head. */
  bones: THREE.Bone[];
  chains: HairChain[];
  hair: Buf;
  fuzz: Buf;
  tie: Buf;
  tile: number;
}

/**
 * Builds a bone chain along a path and returns the weight function for it.
 *
 * The first tenth of the strand stays welded to the skull — hair does not pivot
 * at the scalp, it pivots a centimetre or two out — and from there the weight
 * walks down the chain, blending across each joint so a swing bends rather than
 * hinges.
 */
function chain(
  ctx: Ctx,
  name: string,
  frames: Frame[],
  segments: number,
  radius: (t: number) => number,
  stiffness: number,
  drag: number,
  glue = 0.12,
): (t: number) => Bind {
  const at = (t: number): THREE.Vector3 => {
    const f = frames[Math.min(frames.length - 1, Math.max(0, Math.round(t * (frames.length - 1))))];
    return f.p;
  };
  const bones: THREE.Bone[] = [];
  const length: number[] = [];
  const dir: THREE.Vector3[] = [];
  const radii: number[] = [];
  const first = ctx.bones.length;

  let prev = ctx.headPos;
  for (let s = 0; s < segments; s++) {
    const a = at(s / segments);
    const b = at((s + 1) / segments);
    const bone = new THREE.Bone();
    bone.name = `${name}:${s}`;
    bone.position.copy(a).sub(prev);
    if (s === 0) ctx.head.add(bone);
    else bones[s - 1].add(bone);
    bones.push(bone);
    ctx.bones.push(bone);
    length.push(a.distanceTo(b));
    dir.push(b.clone().sub(a).normalize());
    radii.push(radius(s / segments));
    prev = a;
  }
  ctx.chains.push({ name, bones, length, dir, radius: radii, stiffness, drag });

  return (t: number): Bind => {
    const s = clamp01(t) * segments;
    const j = Math.min(segments - 1, Math.floor(s));
    const f = s - j;
    const b0 = first + j;
    const b1 = first + Math.min(segments - 1, j + 1);
    const blend = b1 === b0 ? 0 : smoothstep(0.15, 0.85, f);
    const hold = 1 - smoothstep(0, glue, t);
    const w0 = (1 - blend) * (1 - hold);
    const w1 = blend * (1 - hold);
    return { i: [HEAD, b0, b1], w: [hold, w0, w1] };
  };
}

// ---------------------------------------------------------------------------
// Fighters
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

/**
 * Kai — black hair in a short spiky topknot under an orange headband.
 *
 * The read is: a hard fringe with pointed clumps sweeping across the brow, a
 * band cutting the head horizontally, and a burst of spikes leaving the crown
 * up and back. All three are silhouette, which is why the fringe overhangs the
 * forehead instead of being painted on it.
 */
function buildKai(ctx: Ctx): void {
  const { skull, hair, tie, n } = ctx;
  const R = skull.R;

  scalp(hair, skull, {
    edge: [86, 96, 108, 118, 126],
    thickness: [R * 0.22, R * 0.24, R * 0.22, R * 0.26, R * 0.28],
    crown: R * 0.34,
    // Mass behind the crown, because the hair is gathered backward into the
    // knot — plus coarse clumping, which is the difference between a head of
    // hair and a swim cap. The clumps have to be centimetres across: a smooth
    // dome is the single loudest tell that hair was generated.
    lift: (theta, v) =>
      R * 0.14 * smoothstep(0.35, 1, v) * clamp01(-Math.cos(theta)) +
      R * 0.16 * (n.value(theta / (Math.PI * 2), v * 0.5, 4, 9) - 0.45),
    tile: ctx.tile,
  }, n);

  // --- Fringe: pointed clumps over the brow, all sweeping to his left --------
  // The brow sits at roughly φ = 106°, so the tips stop just short of it: a
  // fringe that reaches the mouth reads as a set of claws, not as hair.
  for (let i = 0; i < 9; i++) {
    const u = i / 8;
    const jitter = n.rand(i, 3, 1);
    const theta = (-76 + 152 * u) * DEG;
    const root = skull.at(theta, 72 * DEG, R * 0.22);
    const sweepTo = (20 + 14 * jitter) * DEG;
    const mid = skull.at(theta + sweepTo * 0.45, 90 * DEG, R * 0.36 + R * 0.06 * jitter);
    // Alternating long and short locks. A fringe whose tips all land on the same
    // line is a bowl cut; the jagged edge is the whole silhouette here.
    const drop = (i % 2 === 0 ? 1.15 : 0.45) + 0.35 * jitter;
    const tip = skull.at(theta + sweepTo, (94 + 13 * drop) * DEG, R * (0.34 + 0.12 * jitter));
    const frames = buildFrames(
      curvePoints([root, mid, tip], 14),
      new THREE.Vector3(0, 1, 0),
      (t) => skull.normalAt(theta + t * sweepTo, (72 + t * 34) * DEG),
    );
    sweep(hair, frames, {
      // Roots overlap so no scalp shows through; tips run out to a point so the
      // gaps between locks open up as V-shaped notches.
      radius: (t) => R * (0.25 + 0.05 * jitter) * (1 - 0.72 * t * t),
      flat: () => 0.38,
      sides: 8,
      tile: ctx.tile,
      tip: true,
      capStart: true,
    });
  }

  // Sideburn locks in front of the ears — the small thing that keeps a gathered
  // hairstyle from reading as a bowl.
  for (const side of [-1, 1]) {
    const theta = side * 80 * DEG;
    const root = skull.at(theta, 92 * DEG, R * 0.2);
    const tip = skull.at(theta + side * 6 * DEG, 124 * DEG, R * 0.12);
    tip.y -= skull.headLen * 0.1;
    tip.z += skull.headLen * 0.02;
    const frames = buildFrames(
      curvePoints([root, root.clone().lerp(tip, 0.5), tip], 10),
      new THREE.Vector3(0, 1, 0),
      (t) => skull.normalAt(theta, (92 + t * 30) * DEG),
    );
    sweep(hair, frames, {
      radius: (t) => R * 0.17 * (1 - 0.55 * t),
      flat: () => 0.45,
      sides: 7,
      tile: ctx.tile,
      tip: true,
      capStart: true,
    });
  }

  // --- Topknot ---------------------------------------------------------------
  const knotBase = skull.at(180 * DEG, 30 * DEG, R * 0.2);
  const knotDir = new THREE.Vector3(0, 0.88, -0.48).normalize();
  const knotFrames = buildFrames(
    [knotBase.clone().addScaledVector(knotDir, -R * 0.25), knotBase, knotBase.clone().addScaledVector(knotDir, R * 0.5)],
    new THREE.Vector3(0, 0, 1),
  );
  sweep(hair, knotFrames, {
    // Pinched where the band binds it, flaring above — that pinch is what makes
    // a topknot read as gathered rather than as a lump.
    radius: (t) => R * (0.4 - 0.16 * Math.sin(clamp01(t * 1.3) * Math.PI)),
    flat: () => 0.85,
    sides: 12,
    tile: ctx.tile,
    capStart: true,
  });

  const spikeRoot = knotBase.clone().addScaledVector(knotDir, R * 0.42);
  for (let i = 0; i < 9; i++) {
    const j0 = n.rand(i, 11, 2);
    const j1 = n.rand(i, 12, 2);
    const spread = ((i / 8) * 2 - 1) * 0.9;
    const len = R * (1.8 + 0.7 * j0) * (1 - 0.28 * Math.abs(spread));
    const dir = new THREE.Vector3(spread * 0.55 + (j1 - 0.5) * 0.14, 0.9 + 0.16 * j0, -0.34 - 0.34 * j1)
      .normalize();
    const mid = spikeRoot.clone().addScaledVector(dir, len * 0.55);
    const tip = spikeRoot.clone().addScaledVector(dir, len);
    // Every spike droops a touch at the tip; a fan of straight cones reads as a
    // sea urchin, and hair has weight.
    tip.y -= len * (0.2 + 0.3 * j1);
    tip.z -= len * 0.12;
    const frames = buildFrames(curvePoints([spikeRoot, mid, tip], 12), new THREE.Vector3(0, 0, -1));
    sweep(hair, frames, {
      radius: (t) => R * (0.2 + 0.05 * j0) * (1 - 0.3 * t),
      flat: () => 0.5,
      sides: 8,
      tile: ctx.tile,
      tip: true,
      capStart: true,
    });
  }

  // --- Headband --------------------------------------------------------------
  // A hachimaki: tied at the back, riding over the hair, and all but hidden at
  // the front under the fringe — which is exactly how it reads on the sheet.
  const bandPhi = profile([100, 99, 96, 93, 92].map((d) => d * DEG));
  // Under the fringe at the front, over the hair everywhere else.
  const bandLift = profile([R * 0.14, R * 0.2, R * 0.26, R * 0.3, R * 0.32]);
  const bandPts: THREE.Vector3[] = [];
  const BAND = 40;
  for (let i = 0; i < BAND; i++) {
    const theta = (i / BAND) * Math.PI * 2;
    bandPts.push(skull.at(theta, bandPhi(theta), bandLift(theta)));
  }
  bandPts.push(bandPts[0].clone());
  const bandFrames = buildFrames(bandPts, new THREE.Vector3(0, 1, 0), (t) => {
    const theta = t * Math.PI * 2;
    return skull.normalAt(theta, bandPhi(theta));
  });
  sweep(tie, bandFrames.slice(0, BAND), {
    radius: () => skull.headLen * 0.055,
    flat: () => 0.075,
    sides: 10,
    tile: ctx.tile,
    loop: true,
  });

  // Knot and trailing ends, at the back and to his right — the asymmetry is
  // what makes the head read as turned even in a flat front view.
  const knotTheta = 208 * DEG;
  const knotP = skull.at(knotTheta, bandPhi(knotTheta), bandLift(knotTheta) + skull.headLen * 0.02);
  const knotN = skull.normalAt(knotTheta, bandPhi(knotTheta));
  const knotAxis = new THREE.Vector3(0, 1, 0).cross(knotN).normalize();
  const kf = buildFrames(
    [knotP.clone().addScaledVector(knotAxis, -skull.headLen * 0.05), knotP, knotP.clone().addScaledVector(knotAxis, skull.headLen * 0.05)],
    new THREE.Vector3(0, 1, 0),
    () => knotN,
  );
  sweep(tie, kf, {
    radius: (t) => skull.headLen * (0.045 + 0.03 * Math.sin(t * Math.PI)),
    flat: () => 0.55,
    sides: 8,
    tile: ctx.tile,
    capStart: true,
  });

  const HLn = skull.headLen;
  for (let i = 0; i < 2; i++) {
    const len = HLn * (0.5 + 0.3 * i);
    const away = (i === 0 ? -1 : 1) * HLn * 0.055;
    const pts = [
      knotP.clone(),
      knotP.clone().add(new THREE.Vector3(away * 0.5, -len * 0.36, -HLn * 0.05)),
      knotP.clone().add(new THREE.Vector3(away * 1.2, -len * 0.72, -HLn * 0.02)),
      knotP.clone().add(new THREE.Vector3(away * 1.5, -len, HLn * 0.03)),
    ];
    const frames = buildFrames(curvePoints(pts, 20), new THREE.Vector3(0, 0, -1));
    const bind = chain(ctx, `${ctx.def.id}:band${i}`, frames, 3, () => HLn * 0.06, 0.35, 0.75, 0.14);
    sweep(tie, frames, {
      // A ribbon end is a flat strip that turns as it falls, so the section
      // rolls with it — that turn is the only thing that says "cloth" here.
      radius: (t) => HLn * 0.075 * (1 - 0.25 * t),
      flat: (t) => 0.1 + 0.5 * Math.abs(Math.sin(t * 2.4)),
      sides: 8,
      bind,
      tile: ctx.tile,
      capStart: true,
    });
  }
}

/**
 * Mali — one very long plait, tied off into bulbs down its length.
 *
 * The scalp is deliberately sleek: everything is pulled back into the tail, so
 * the top of the head is nearly skull-tight and all the volume is in the rope
 * hanging down her back.
 */
function buildMali(ctx: Ctx): void {
  const { skull, hair, tie, m, n } = ctx;
  const R = skull.R;

  scalp(hair, skull, {
    edge: [82, 90, 106, 116, 122],
    thickness: [R * 0.11, R * 0.12, R * 0.13, R * 0.17, R * 0.2],
    crown: R * 0.15,
    tile: ctx.tile,
  }, n);

  // Gathered mass where the tail leaves the head.
  const base = skull.at(180 * DEG, 38 * DEG, R * 0.1);
  const gatherDir = new THREE.Vector3(0, 0.72, -0.69).normalize();
  const gf = buildFrames(
    [base.clone().addScaledVector(gatherDir, -R * 0.25), base, base.clone().addScaledVector(gatherDir, R * 0.3)],
    new THREE.Vector3(0, 0, 1),
  );
  sweep(hair, gf, {
    radius: (t) => R * (0.26 + 0.14 * Math.sin(t * Math.PI)),
    flat: () => 0.95,
    sides: 12,
    tile: ctx.tile,
    capStart: true,
  });

  // --- The tail --------------------------------------------------------------
  const top = base.clone().addScaledVector(gatherDir, R * 0.28);
  const H = m.height;
  const pts = [
    top,
    new THREE.Vector3(0, top.y - H * 0.012, top.z - H * 0.022),
    new THREE.Vector3(0, m.height * 0.965, -H * 0.072),
    new THREE.Vector3(0, m.height * 0.92, -H * 0.077),
    new THREE.Vector3(0, m.height * 0.855, -H * 0.075),
    new THREE.Vector3(0, m.height * 0.79, -H * 0.068),
    new THREE.Vector3(0, m.height * 0.742, -H * 0.058),
  ];
  const frames = buildFrames(curvePoints(pts, 88), new THREE.Vector3(1, 0, 0));
  const braidR = (t: number): number => R * (0.42 - 0.16 * t);
  // Ties pinch the plait; the bulbs are the swellings between them, and they are
  // most of why this silhouette is hers and not a generic ponytail.
  const ties = [0.035, 0.3, 0.56, 0.8];
  const pinch = (t: number): number => {
    let k = 1;
    for (const c of ties) k -= 0.3 * Math.exp(-(((t - c) / 0.045) ** 2));
    return k;
  };
  const bind = chain(ctx, `${ctx.def.id}:braid`, frames, 6, (t) => braidR(t), 0.45, 0.45, 0.08);

  braid(hair, frames, {
    radius: (t) => braidR(t) * pinch(t),
    period: 0.165,
    bind,
    sides: 9,
    tile: ctx.tile,
    tip: true,
  });

  // Red ties. The base one is a wide wrap; the rest are single bands.
  for (let i = 0; i < ties.length; i++) {
    const c = ties[i];
    const wide = i === 0 ? 0.045 : 0.022;
    const lo = Math.max(0, Math.round((c - wide) * (frames.length - 1)));
    const hi = Math.min(frames.length - 1, Math.round((c + wide) * (frames.length - 1)));
    if (hi - lo < 1) continue;
    sweep(tie, frames.slice(lo, hi + 1), {
      radius: (t) => braidR(c) * pinch(c) * (0.78 + 0.1 * Math.sin(t * Math.PI)),
      flat: () => 0.82,
      sides: 10,
      bind,
      tile: ctx.tile,
      capStart: true,
    });
  }

  // Loose wisps at the temples, falling in front of the ears.
  for (const side of [-1, 1]) {
    const theta = side * 68 * DEG;
    const root = skull.at(theta, 92 * DEG, R * 0.09);
    const tip = skull.at(theta + side * 4 * DEG, 128 * DEG, R * 0.02);
    tip.y -= skull.headLen * (side < 0 ? 0.3 : 0.2);
    tip.z += skull.headLen * 0.05;
    const wf = buildFrames(curvePoints([root, root.clone().lerp(tip, 0.45), tip], 12), new THREE.Vector3(0, 1, 0));
    const wb = chain(ctx, `${ctx.def.id}:wisp${side > 0 ? 'L' : 'R'}`, wf, 2, () => R * 0.05, 0.3, 0.9, 0.25);
    sweep(hair, wf, {
      radius: (t) => R * 0.075 * (1 - 0.5 * t),
      flat: () => 0.55,
      sides: 7,
      bind: wb,
      tile: ctx.tile,
      tip: true,
      capStart: true,
    });
  }
}

/**
 * Davi — shoulder-length locs, gathered back with a blue tie.
 *
 * Every loc is its own cylinder with its own path and its own bone chain: the
 * whole point of locs is that they are separate ropes that part and swing
 * independently, and a single gathered mass with grooves cut in it never reads
 * as anything but a helmet.
 */
function buildDavi(ctx: Ctx): void {
  const { skull, hair, tie, n } = ctx;
  const R = skull.R;
  const HL = skull.headLen;

  scalp(hair, skull, {
    edge: [88, 96, 108, 118, 124],
    thickness: [R * 0.1, R * 0.11, R * 0.12, R * 0.14, R * 0.15],
    crown: R * 0.14,
    tile: ctx.tile,
  }, n);

  const locR = R * 0.15;
  // The gather: where the blue tie holds the back locs together.
  const gather = skull.at(180 * DEG, 104 * DEG, R * 0.34);

  const BACK = 13;
  const FRONT = 6;

  for (let i = 0; i < BACK + FRONT; i++) {
    const front = i >= BACK;
    const k = front ? i - BACK : i;
    const j0 = n.rand(i, 21, 3);
    const j1 = n.rand(i, 22, 3);
    const j2 = n.rand(i, 23, 3);
    const pts: THREE.Vector3[] = [];
    let stiff: number;

    if (!front) {
      // Roots spread over the crown, paths converge on the gather, then fan out
      // below it — which is exactly how a tied bundle of locs behaves.
      const spread = (k / (BACK - 1)) * 2 - 1;
      const theta = spread * 118 * DEG;
      const phi = (26 + 46 * j0) * DEG;
      const root = skull.at(theta, phi, R * 0.1);
      const bend = skull.at(theta * 0.5, (72 + 20 * j1) * DEG, R * 0.26);
      const knot = gather.clone().add(new THREE.Vector3(spread * R * 0.16, R * 0.1 * (j1 - 0.5), R * 0.05 * j2));
      const len = HL * (0.62 + 0.5 * j1);
      const tipX = spread * HL * (0.24 + 0.16 * j2);
      const tail = new THREE.Vector3(tipX * 0.5, knot.y - len * 0.55, knot.z - HL * 0.05 * j0);
      const tip = new THREE.Vector3(tipX, knot.y - len, knot.z - HL * (0.04 + 0.1 * j2));
      pts.push(root, bend, knot, tail, tip);
      stiff = 0.55;
    } else {
      // Face-framing locs: they leave the temple, clear the ear and hang free.
      const side = k % 2 === 0 ? 1 : -1;
      const rank = Math.floor(k / 2);
      const theta = side * (54 + 16 * rank) * DEG;
      const root = skull.at(theta, (52 + 22 * j0) * DEG, R * 0.1);
      const bend = skull.at(theta * 1.04, (104 + 8 * j1) * DEG, R * 0.24);
      const len = HL * (0.5 + 0.42 * j2 + 0.16 * rank);
      const tip = bend
        .clone()
        .add(new THREE.Vector3(side * HL * 0.07 * j1, -len, HL * (0.04 - 0.14 * j0)));
      pts.push(root, bend, bend.clone().lerp(tip, 0.5).add(new THREE.Vector3(0, 0, HL * 0.02)), tip);
      stiff = 0.3;
    }

    const frames = buildFrames(curvePoints(pts, 30), new THREE.Vector3(0, 0, 1));
    const bind = chain(ctx, `${ctx.def.id}:loc${i}`, frames, 3, () => locR, stiff, 0.85, front ? 0.16 : 0.3);
    sweep(hair, frames, {
      // A loc is a twisted rope: the small bulge every few centimetres is the
      // twist, and it has to be in the geometry to survive the silhouette.
      radius: (t) => locR * (0.92 + 0.1 * Math.sin(t * 14 + j0 * 6)) * (1 - 0.22 * t),
      flat: () => 0.92,
      sides: 8,
      bind,
      tile: ctx.tile,
      tip: true,
      capStart: true,
    });

    // A few locs carry blue beads.
    if (!front && k % 4 === 1) {
      const c = 0.62 + 0.12 * j2;
      const lo = Math.max(0, Math.round((c - 0.035) * (frames.length - 1)));
      const hi = Math.min(frames.length - 1, Math.round((c + 0.035) * (frames.length - 1)));
      sweep(tie, frames.slice(lo, hi + 1), {
        radius: () => locR * 1.45,
        flat: () => 1,
        sides: 8,
        bind,
        tile: ctx.tile,
        capStart: true,
      });
    }
  }

  // The blue tie, wrapping the gathered bundle.
  const tieDir = new THREE.Vector3(0, -0.55, -0.84).normalize();
  const tf = buildFrames(
    [gather.clone().addScaledVector(tieDir, -R * 0.16), gather.clone(), gather.clone().addScaledVector(tieDir, R * 0.16)],
    new THREE.Vector3(1, 0, 0),
  );
  sweep(tie, tf, {
    radius: (t) => R * (0.46 + 0.06 * Math.sin(t * Math.PI)),
    flat: () => 0.72,
    sides: 12,
    tile: ctx.tile,
    capStart: true,
  });
}

/**
 * Vera — a braided mohawk with the sides shaved close.
 *
 * Two treatments on one head: a thin stubble shell over the whole skull, and a
 * plait running sagittally from the hairline over the crown and off the back of
 * the head. The braid is the silhouette; the stubble is what keeps the shaved
 * sides from reading as a bald scalp — shaved hair is a surface, not an absence.
 */
function buildVera(ctx: Ctx): void {
  const { skull, hair, fuzz, m, n } = ctx;
  const R = skull.R;

  scalp(fuzz, skull, {
    edge: [96, 102, 114, 122, 126],
    thickness: [R * 0.05, R * 0.05, R * 0.055, R * 0.06, R * 0.06],
    crown: R * 0.06,
    fuzz: R * 0.022,
    cols: 72,
    rows: 14,
    tile: ctx.tile * 0.35,
  }, n);

  // --- The ridge -------------------------------------------------------------
  // Sagittal arc: forehead hairline, over the crown, down the occiput, then off
  // the skull and hanging free.
  const arc: THREE.Vector3[] = [];
  const stops: [number, number][] = [
    [0, 92],
    [0, 62],
    [0, 30],
    [0, 6],
    [180, 26],
    [180, 56],
    [180, 84],
  ];
  for (const [th, ph] of stops) arc.push(skull.at(th * DEG, ph * DEG, R * 0.3));
  const tail = skull.at(180 * DEG, 96 * DEG, R * 0.2);
  arc.push(
    tail,
    new THREE.Vector3(0, tail.y - m.height * 0.045, tail.z - m.height * 0.004),
    new THREE.Vector3(0, tail.y - m.height * 0.085, tail.z + m.height * 0.006),
    new THREE.Vector3(0, tail.y - m.height * 0.115, tail.z + m.height * 0.014),
  );

  const frames = buildFrames(curvePoints(arc, 96), new THREE.Vector3(1, 0, 0));
  // Ridge radius: tallest over the forehead and crown where the mohawk stands
  // up, thinning into the plait that hangs down the back.
  const ridge = (t: number): number =>
    R * (0.34 + 0.08 * Math.sin(clamp01(t / 0.45) * Math.PI)) * (1 - 0.52 * smoothstep(0.5, 1, t));
  const bind = chain(ctx, `${ctx.def.id}:mohawk`, frames, 5, ridge, 0.8, 0.5, 0.62);

  braid(hair, frames, {
    radius: ridge,
    period: 0.105,
    bind,
    sides: 9,
    tile: ctx.tile,
    tip: true,
  });

  // The end tuft: a braid stops being a braid at the tip and frays.
  const end = frames[frames.length - 1];
  for (let i = 0; i < 3; i++) {
    const j0 = n.rand(i, 31, 5);
    const dir = new THREE.Vector3((i - 1) * 0.5 + (j0 - 0.5) * 0.3, -0.85, 0.25 + 0.2 * j0).normalize();
    const len = m.height * (0.022 + 0.014 * j0);
    const pts = [end.p.clone(), end.p.clone().addScaledVector(dir, len * 0.6), end.p.clone().addScaledVector(dir, len)];
    const tf = buildFrames(curvePoints(pts, 8), new THREE.Vector3(0, 0, 1));
    sweep(hair, tf, {
      radius: (t) => R * 0.07 * (1 - 0.5 * t),
      flat: () => 0.8,
      sides: 6,
      bind: () => bind(1),
      tile: ctx.tile,
      tip: true,
      capStart: true,
    });
  }

  // One loose strand at the temple: the shaved side needs something growing out
  // of it or the head reads as a helmet with a crest bolted on.
  for (const side of [-1, 1]) {
    const theta = side * 62 * DEG;
    const root = skull.at(theta, 100 * DEG, R * 0.05);
    const tip = skull.at(theta - side * 4 * DEG, 126 * DEG, R * 0.02);
    tip.y -= skull.headLen * (side < 0 ? 0.34 : 0.18);
    tip.z += skull.headLen * 0.03;
    const wf = buildFrames(curvePoints([root, root.clone().lerp(tip, 0.5), tip], 10), new THREE.Vector3(0, 1, 0));
    const wb = chain(ctx, `${ctx.def.id}:wisp${side > 0 ? 'L' : 'R'}`, wf, 2, () => R * 0.05, 0.3, 0.9, 0.3);
    sweep(hair, wf, {
      radius: (t) => R * 0.06 * (1 - 0.45 * t),
      flat: () => 0.65,
      sides: 6,
      bind: wb,
      tile: ctx.tile,
      tip: true,
      capStart: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

const gainCache = new Map<string, THREE.Color>();

function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * The base colour to hand the material so that `uColor * map` lands on the
 * authored palette colour.
 *
 * The shading model treats `map` as a *detail* multiplier, but every generator
 * in the texture library hands back a fully coloured albedo. Multiplying a
 * near-black hair colour by a near-black hair map gives near-black squared,
 * which is a silhouette with no shading in it at all. So the map is measured
 * once and the base colour is pre-divided by its mean — per channel, so a copper
 * braid stays copper instead of turning into saturated rust.
 */
function detailBase(tex: THREE.Texture, target: THREE.ColorRepresentation): THREE.Color {
  const want = new THREE.Color(target);
  const key = `${tex.uuid}|${want.getHexString()}`;
  const hit = gainCache.get(key);
  if (hit) return hit;

  const img = tex.image as { data?: ArrayLike<number>; width?: number; height?: number };
  const out = want.clone();
  if (img?.data && img.width && img.height) {
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    // Every 16th texel: the mean of a tiling texture converges long before the
    // full 512² and this runs at load, on the main thread.
    for (let i = 0; i < img.width * img.height; i += 16) {
      r += srgbToLinear(img.data[i * 4] / 255);
      g += srgbToLinear(img.data[i * 4 + 1] / 255);
      b += srgbToLinear(img.data[i * 4 + 2] / 255);
      count++;
    }
    const gain = (mean: number): number => THREE.MathUtils.clamp(1 / Math.max(mean / count, 0.004), 0.4, 14);
    out.setRGB(want.r * gain(r), want.g * gain(g), want.b * gain(b), THREE.LinearSRGBColorSpace);
  }
  gainCache.set(key, out);
  return out;
}

/**
 * The lit tone of a head of hair.
 *
 * `palette.hair` is the *darkest* tone — for three of the four fighters it is
 * near-black, and shading a two-band cel ramp between near-black and something
 * darker gives a silhouette with no form in it. An animator paints the base a
 * good way up from that darkest value and reserves the dark for the shadow band,
 * so the base is lifted toward the palette's own `hairSheen`. Nothing is
 * invented: both ends of the range are authored data.
 */
function hairBase(p: { hair: number; hairSheen: number }): THREE.Color {
  return new THREE.Color(p.hair).lerp(new THREE.Color(p.hairSheen), 0.62);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Builds and attaches this fighter's hair.
 *
 * Call it with the rig in bind pose. It snapshots and restores the pose anyway —
 * skinning binds against whatever the bones read at that instant, and hair that
 * was bound over a posed skeleton floats off the head forever after — but the
 * snapshot is insurance, not a licence to build hair mid-animation.
 */
export function buildHair(rig: BuiltCharacter, def: FighterDef = rig.def): THREE.Object3D {
  const m = rig.metrics;
  const p = def.palette;

  // Bind pose, guaranteed.
  const snapshot = Object.values(rig.bones).map((b) => ({
    b,
    p: b.position.clone(),
    q: b.quaternion.clone(),
    s: b.scale.clone(),
  }));
  rig.resetPose();
  rig.root.updateMatrixWorld(true);

  const head = rig.bones.head;
  const ctx: Ctx = {
    def,
    m,
    skull: new Skull(m, rig.joints.head),
    head,
    headPos: rig.joints.head.clone(),
    n: noise([...def.id].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 17)),
    bones: [head],
    chains: [],
    hair: new Buf(),
    fuzz: new Buf(),
    tie: new Buf(),
    tile: 0.18,
  };

  switch (def.id) {
    case 'kai':
      buildKai(ctx);
      break;
    case 'mali':
      buildMali(ctx);
      break;
    case 'davi':
      buildDavi(ctx);
      break;
    default:
      buildVera(ctx);
      break;
  }

  // --- Materials -------------------------------------------------------------
  const seed = [...def.id].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);
  const base = hairBase(p);
  const strandTex: TexSet =
    def.id === 'davi'
      ? hairStrands({ color: p.hair, sheenColor: p.hairSheen, style: 'locs', seed, strands: 11, twist: 7 })
      : hairStrands({
          color: p.hair,
          sheenColor: p.hairSheen,
          style: 'strand',
          // ~5 mm per lock at the tile size below. Finer than that and the map is
          // sub-pixel on a fighting-game head, where it turns into crawling noise.
          strands: 34,
          seed,
          clump: def.id === 'kai' ? 0.75 : 0.62,
          variation: def.id === 'vera' ? 0.62 : 0.5,
        });

  const hairMat = createToonMaterial({
    kind: 'hair',
    color: detailBase(strandTex.map, base),
    // The darkest authored tone, lifted off the floor: a hair shadow that lands
    // on the palette's black leaves the shadow side with no form in it at all,
    // and on a two-band ramp the shadow side is most of the head.
    shadowColor: new THREE.Color(p.hair).lerp(base, 0.3),
    rimColor: p.rim,
    map: strandTex.map,
    normalMap: strandTex.normalMap,
    normalScale: 0.55,
    // Three tones, not the kind's default two: black hair needs a mid value or
    // the whole head collapses into the highlight band and a silhouette.
    bands: 3,
    // The kind is tuned for a broad sheen on a big mass; on locks and spikes a
    // full-strength band turns the head into wet vinyl.
    specular: 0.46,
    outlineColor: inkColor(p.hair),
    // Locs and wisps are a couple of centimetres across; a full-weight ink line
    // on each would fuse the whole head back into one mass.
    outlineWidth: 0.82,
    skinned: true,
  });

  const fuzzTex = hairStrands({
    color: p.hair,
    sheenColor: p.hairSheen,
    style: 'strand',
    seed: seed + 9,
    strands: 96,
    clump: 0.15,
    variation: 0.3,
    roughness: 0.6,
  });
  // Shaved hair shows the scalp between the stubble, so it sits between the hair
  // colour and the skin's own shadow — never the flat hair colour thinned down.
  const shavedColor = hairBase(p).lerp(new THREE.Color(p.skinShadow), 0.34);
  const fuzzMat = createToonMaterial({
    kind: 'hair',
    color: detailBase(fuzzTex.map, shavedColor),
    shadowColor: new THREE.Color(p.hair).lerp(new THREE.Color(p.skinShadow), 0.25),
    rimColor: p.rim,
    map: fuzzTex.map,
    normalMap: fuzzTex.normalMap,
    normalScale: 0.6,
    specular: 0.22,
    outlineColor: inkColor(shavedColor),
    outlineWidth: 0.7,
    skinned: true,
  });

  const tieColor = def.id === 'mali' ? p.wrap : p.accent;
  const tieMat = createToonMaterial({
    kind: def.id === 'mali' ? 'satin' : 'cloth',
    color: tieColor,
    rimColor: p.rim,
    outlineWidth: 0.75,
    skinned: true,
  });

  // --- Meshes ----------------------------------------------------------------
  const group = new THREE.Group();
  group.name = `${def.id}:hair`;
  rig.root.add(group);
  rig.root.updateMatrixWorld(true);

  const skeleton = new THREE.Skeleton(ctx.bones);
  const meshes: THREE.SkinnedMesh[] = [];
  const materials: THREE.Material[] = [];
  let triangles = 0;

  const add = (buf: Buf, material: THREE.Material, name: string): void => {
    const geometry = buf.geometry();
    if (!geometry) {
      material.dispose();
      return;
    }
    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.name = `${def.id}:${name}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Hair leaves the fighter's bind bounds the moment the head turns.
    mesh.frustumCulled = false;
    group.add(mesh);
    mesh.updateMatrixWorld(true);
    mesh.bind(skeleton);
    meshes.push(mesh);
    materials.push(material);
    triangles += buf.idx.length / 3;
    // Inked here rather than by a later `addOutlines(root)` pass so the hair
    // carries its own line weight; the pass skips anything already inked.
    rig.outlines.push(createOutlineMesh(mesh));
  };

  add(ctx.hair, hairMat, 'hair');
  add(ctx.fuzz, fuzzMat, 'fuzz');
  add(ctx.tie, tieMat, 'ties');

  // Registered with the rig so a hit flash, a super silhouette or a dispose
  // reaches the hair — a fighter whose body whites out and whose hair does not
  // stops being one character for that frame.
  for (const mesh of meshes) rig.meshes.push(mesh);

  const hair: HairRig = {
    group,
    chains: ctx.chains,
    meshes,
    skeleton,
    triangles,
    dispose(): void {
      for (const mesh of meshes) mesh.geometry.dispose();
      for (const material of materials) material.dispose();
      skeleton.dispose();
      for (const bone of ctx.bones) if (bone !== head) bone.removeFromParent();
      group.removeFromParent();
    },
  };
  group.userData.hair = hair;

  for (const s of snapshot) {
    s.b.position.copy(s.p);
    s.b.quaternion.copy(s.q);
    s.b.scale.copy(s.s);
  }
  rig.root.updateMatrixWorld(true);

  return group;
}
