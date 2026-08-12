import * as THREE from 'three';
import type { JointMap, RigMetrics } from '../../anim/Skeleton';
import type { FighterDef } from '../../data/roster';
import { computeOutlineNormals } from '../../render/npr/outline';
import type { BuiltCharacter } from './rig';

/**
 * The head *form* — skull, jaw, brow, nose, chin, ears — as a re-sculpt of the
 * body mesh's own vertices.
 *
 * ## Why it works this way
 *
 * Review 001 scored faces 1/5 and named the cause: "the head *form* is a
 * featureless ovoid with no jaw, brow or occiput". That is a modelling defect,
 * not a shading one, and it lives in the silhouette — so it cannot be fixed by
 * anything that sits *on top of* the head. Three approaches were considered:
 *
 * 1. **A face shell over the body's head.** Fails. The shell has to stay inside
 *    the body head's silhouette or the body's ink hull (a constant ~3.4 px
 *    screen-space expansion, which at gameplay scale is ~15 mm of world space)
 *    draws a dark contour *across* the new features. Staying inside the old
 *    silhouette means the old silhouette is still what the eye reads, which is
 *    precisely the thing that scored 1.
 * 2. **A separate head mesh with the body's head deleted.** Fails on the neck:
 *    the cut leaves a rim whose own ink expands outward, and hiding that rim
 *    needs the replacement neck to be ~25% fatter than the real one.
 * 3. **Re-sculpting the vertices the body already has.** One watertight mesh,
 *    one material, one ink shell, no seam anywhere, and the silhouette is the
 *    sculpt's. This is what happens below.
 *
 * The sculpt is expressed as a small signed-distance field — the same primitive
 * vocabulary `body.ts` uses, but with three times the primitives and placed off
 * anatomical landmarks rather than off an ovoid — and the body's head vertices
 * are Newton-projected onto its zero level set. Topology is untouched, so
 * skinning, UVs and the ink pass all keep working; only positions and normals
 * move. Resolution is bought back with two levels of local red-green
 * subdivision, because the body's grid is ~10 mm in the head band and a nose is
 * 20 mm wide.
 *
 * The projection is faded to zero through the neck, and the field carries a copy
 * of the body's *own* neck primitive, so down there the projection is a no-op by
 * construction and there is nothing for the fade to hide.
 *
 * ## Coordinates
 *
 * Everything is authored in **head-local units of `headLen`**: `x` lateral from
 * the midline, `y` above the chin (0 = menton, 1 = crown), `z` forward of the
 * head joint's z. That makes every number in the sculpt a readable proportion —
 * "the nose tip is 0.42 head-lengths in front of the ear canal" — and makes the
 * four fighters siblings, since the same table drives all of them through
 * `FaceSpec`.
 */

// ---------------------------------------------------------------------------
// Per-fighter dial box
// ---------------------------------------------------------------------------

/**
 * Everything that makes one fighter's head not another's.
 *
 * Values cluster around 1 = "the roster average". The four sheets differ mostly
 * in four places — jaw width, cheekbone height, brow weight and eye shape — so
 * those carry the widest spreads on purpose: getting the four *distinguishable*
 * matters more than any one being exactly on model.
 */
export interface FaceSpec {
  /** Overall skull width multiplier. */
  faceW: number;
  /** Front-to-back skull depth multiplier. */
  skullDepth: number;
  /** Occipital bulge. */
  occiput: number;
  /** How far the forehead leans back above the brow, in head-lengths. */
  foreheadBack: number;

  /** Half-width at the jaw angle, head-lengths. */
  jawW: number;
  /** 0 = tapered/oval jaw, 1 = square with a hard gonion corner. */
  jawSquare: number;
  /** Masseter volume — the slab of muscle on the side of a fighter's jaw. */
  masseter: number;
  /** Chin half-width, head-lengths. */
  chinW: number;
  /** Chin projection, head-lengths of z. */
  chinFwd: number;

  /** Cheekbone lateral prominence. */
  cheekOut: number;
  /** Cheekbone height in head-lengths (higher = sharper face). */
  cheekY: number;
  /** Hollow under the cheekbone; what makes a cheekbone read at all. */
  buccal: number;

  /** Brow ridge mass. */
  browHeavy: number;
  /** Brow ridge height, head-lengths. */
  browY: number;
  /** Orbit depth — how far the eye sits behind the brow. */
  orbitDeep: number;
  /** Temple hollow. */
  temple: number;

  /** Nose tip z, head-lengths. */
  noseLen: number;
  /** Nose tip height, head-lengths. */
  noseY: number;
  /** Half-width across the nostril wings, head-lengths. */
  noseW: number;
  /** Bridge thickness. */
  noseBridge: number;

  /** Mouth centre height, head-lengths. */
  mouthY: number;
  /** Mouth half-width, head-lengths. */
  mouthW: number;
  /** Lip volume. */
  lipFull: number;

  /** Ear size multiplier. */
  earSize: number;

  // --- eyes: consumed by face.ts, kept here so one table owns the face -----
  /** Eyeball radius, head-lengths. */
  eyeR: number;
  /** Eye centre, head-lengths. */
  eyeX: number;
  eyeY: number;
  /** Eyeball centre z, head-lengths. */
  eyeZ: number;
  /** Half-width of the palpebral opening in radians of the eyeball. */
  eyeOpen: number;
  /** Upper lid aperture, radians. Large = wide anime eye. */
  lidUpper: number;
  /** Lower lid aperture, radians. */
  lidLower: number;
  /** Canthal tilt: + raises the outer corner. */
  eyeTilt: number;
  /** How far the upper lid hangs over the iris, 0..1. High = hooded. */
  hood: number;
  /** Upper lash thickness in radians. */
  lashWeight: number;
  /** Iris angular radius, radians. */
  irisR: number;
  irisColor: number;
  /** Bright rim inside the limbus, for the two-tone anime iris. */
  irisEdge: number;
  pupil: number;

  // --- brows ---------------------------------------------------------------
  /** Brow ribbon thickness, head-lengths. */
  browThick: number;
  /** Brow arch height, head-lengths. */
  browArch: number;
  /** Brow tilt: + raises the outer end. */
  browTilt: number;
  /** Brow length as a fraction of the eye's own span. */
  browLen: number;
  /** How far the brow's inner end sits from the midline, head-lengths. */
  browInner: number;

  /** Freckle density for the face skin detail. */
  freckles: number;
  /** Lip colour bias toward the subsurface tone, 0..1. */
  lipTint: number;
}

const BASE: FaceSpec = {
  faceW: 1, skullDepth: 1, occiput: 1, foreheadBack: 0.03,
  jawW: 0.255, jawSquare: 0.5, masseter: 1, chinW: 0.1, chinFwd: 1,
  cheekOut: 1, cheekY: 0.45, buccal: 1,
  browHeavy: 1, browY: 0.555, orbitDeep: 1, temple: 1,
  noseLen: 0.43, noseY: 0.335, noseW: 0.062, noseBridge: 1,
  mouthY: 0.175, mouthW: 0.105, lipFull: 1,
  earSize: 1,
  eyeR: 0.056, eyeX: 0.152, eyeY: 0.472, eyeZ: 0.235,
  eyeOpen: 0.92, lidUpper: 0.5, lidLower: 0.4, eyeTilt: 0.06, hood: 0.18,
  lashWeight: 0.13, irisR: 0.42, irisColor: 0x5b3520, irisEdge: 0.3, pupil: 0.42,
  browThick: 0.032, browArch: 0.022, browTilt: 0.02, browLen: 1.05, browInner: 0.055,
  freckles: 0, lipTint: 0.35,
};

/**
 * The four heads.
 *
 * Read against `/reference/<id>/01-neutral-front.jpg`: Kai is young and
 * open-featured, Mali is all cheekbone with level brows, Davi is narrow with a
 * fine jaw, Vera is broad and heavy-browed with a hard set to the mouth.
 */
const SPECS: Record<string, Partial<FaceSpec>> = {
  kai: {
    // Young: shortish face, wide rounded jaw, big open eyes, thick angled brows.
    faceW: 1.02, jawW: 0.262, jawSquare: 0.42, chinW: 0.108, chinFwd: 1.0,
    cheekOut: 0.94, cheekY: 0.44, buccal: 0.7,
    browHeavy: 1.0, browY: 0.552, orbitDeep: 0.9, temple: 0.85,
    noseLen: 0.425, noseY: 0.338, noseW: 0.058, noseBridge: 0.92,
    mouthY: 0.178, mouthW: 0.104, lipFull: 0.92,
    eyeR: 0.058, eyeX: 0.153, eyeY: 0.474, lidUpper: 0.55, lidLower: 0.44,
    eyeTilt: 0.05, hood: 0.12, lashWeight: 0.15, irisR: 0.45, irisColor: 0x5e3a22,
    browThick: 0.036, browArch: 0.018, browTilt: 0.055, browLen: 1.08, browInner: 0.048,
    lipTint: 0.3,
  },
  mali: {
    // Sharp: high narrow cheekbones, tapered jaw, pointed chin, level brows,
    // upswept outer canthus.
    faceW: 0.96, skullDepth: 0.98, jawW: 0.228, jawSquare: 0.22, masseter: 0.72,
    chinW: 0.082, chinFwd: 1.02,
    cheekOut: 1.24, cheekY: 0.478, buccal: 1.45,
    browHeavy: 0.72, browY: 0.558, orbitDeep: 0.92, temple: 1.15,
    noseLen: 0.425, noseY: 0.332, noseW: 0.055, noseBridge: 0.86,
    mouthY: 0.172, mouthW: 0.1, lipFull: 1.22,
    earSize: 0.92,
    eyeR: 0.056, eyeX: 0.15, eyeY: 0.474, lidUpper: 0.5, lidLower: 0.4,
    eyeTilt: 0.13, hood: 0.16, lashWeight: 0.16, irisR: 0.42, irisColor: 0x6b4523,
    browThick: 0.024, browArch: 0.008, browTilt: 0.005, browLen: 1.1, browInner: 0.05,
    lipTint: 0.5,
  },
  davi: {
    // Narrow and long: fine jaw, pointed chin, wide-set eyes, broader nose with
    // fuller wings, arched thin brows.
    faceW: 0.93, skullDepth: 1.03, occiput: 1.06, foreheadBack: 0.036,
    jawW: 0.222, jawSquare: 0.3, masseter: 0.66, chinW: 0.086, chinFwd: 1.05,
    cheekOut: 1.05, cheekY: 0.458, buccal: 1.25,
    browHeavy: 0.8, browY: 0.562, orbitDeep: 1.0, temple: 1.0,
    noseLen: 0.435, noseY: 0.33, noseW: 0.072, noseBridge: 0.88,
    mouthY: 0.17, mouthW: 0.104, lipFull: 1.3,
    eyeR: 0.055, eyeX: 0.158, eyeY: 0.472, lidUpper: 0.5, lidLower: 0.42,
    eyeTilt: 0.04, hood: 0.14, lashWeight: 0.13, irisR: 0.42, irisColor: 0x3d2717,
    browThick: 0.026, browArch: 0.03, browTilt: 0.03, browLen: 1.05, browInner: 0.056,
    lipTint: 0.42,
  },
  vera: {
    // Broad and heavy: wide square jaw, strong chin, low level brows sitting
    // close over hooded eyes, hard flat mouth.
    faceW: 1.07, skullDepth: 0.99, jawW: 0.285, jawSquare: 0.88, masseter: 1.3,
    chinW: 0.118, chinFwd: 1.1,
    cheekOut: 1.1, cheekY: 0.452, buccal: 0.95,
    browHeavy: 1.4, browY: 0.538, orbitDeep: 1.18, temple: 0.9,
    noseLen: 0.42, noseY: 0.336, noseW: 0.062, noseBridge: 1.1,
    mouthY: 0.176, mouthW: 0.107, lipFull: 0.82,
    earSize: 0.95,
    eyeR: 0.055, eyeX: 0.152, eyeY: 0.468, lidUpper: 0.44, lidLower: 0.36,
    eyeTilt: 0.0, hood: 0.32, lashWeight: 0.12, irisR: 0.4, irisColor: 0x7a7a48,
    irisEdge: 0.38,
    browThick: 0.038, browArch: 0.012, browTilt: -0.03, browLen: 1.02, browInner: 0.05,
    freckles: 0.62, lipTint: 0.28,
  },
};

export function faceSpec(def: FighterDef): FaceSpec {
  return { ...BASE, ...(SPECS[def.id] ?? {}) };
}

// ---------------------------------------------------------------------------
// A very small signed-distance kit
// ---------------------------------------------------------------------------

type V3 = readonly [number, number, number];

interface SPrim {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  ra: number; rb: number;
  /** Cross-section scale across the axis and front-back. */
  sx: number; sz: number;
  /** Blend from the 2-norm toward the 4-norm; squarer sections. */
  nmix: number;
  k: number;
  sub: boolean;
  exx: number; exy: number; exz: number;
  eyx: number; eyy: number; eyz: number;
  ezx: number; ezy: number; ezz: number;
  len: number; coneA: number; coneB: number; coneAL: number;
  minS: number;
  cx: number; cy: number; cz: number; br: number;
}

interface PrimOpts {
  /** Cross-section scale across the axis. */
  sx?: number;
  /** Cross-section scale front-back. */
  sz?: number;
  /** Section exponent: 2 = ellipse, 4 = rounded rectangle. */
  n?: number;
  /** Smooth-union radius against everything accumulated so far. */
  k?: number;
  sub?: boolean;
  /** World direction that becomes this primitive's local +Z. */
  ref?: V3;
}

function smin(a: number, b: number, k: number): number {
  if (k <= 1e-6) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _rf = new THREE.Vector3();
const _cr = new THREE.Vector3();

class Sculpt {
  readonly prims: SPrim[] = [];

  /** A tapered elliptical capsule from `a` to `b`. */
  bone(a: V3, b: V3, ra: number, rb: number, o: PrimOpts = {}): void {
    _u.set(a[0], a[1], a[2]);
    _v.set(b[0], b[1], b[2]);
    _ax.subVectors(_v, _u);
    const len = _ax.length();
    if (len < 1e-9) {
      _ax.set(0, 1, 0);
      _rf.set(0, 0, 1);
      _cr.set(1, 0, 0);
    } else {
      _ax.divideScalar(len);
      const r = o.ref ?? [0, 0, 1];
      _rf.set(r[0], r[1], r[2]).addScaledVector(_ax, -(_ax.x * r[0] + _ax.y * r[1] + _ax.z * r[2]));
      if (_rf.lengthSq() < 0.02) _rf.set(0, 1, 0).addScaledVector(_ax, -_ax.y);
      _rf.normalize();
      _cr.crossVectors(_ax, _rf);
    }
    const sx = o.sx ?? 1;
    const sz = o.sz ?? 1;
    const k = o.k ?? 0.01;
    const L = len < 1e-9 ? 0 : len;
    const coneB = L === 0 ? 0 : (ra - rb) / L;
    const coneA = Math.sqrt(Math.max(0, 1 - coneB * coneB));
    this.prims.push({
      ax: a[0], ay: a[1], az: a[2],
      bx: b[0], by: b[1], bz: b[2],
      ra, rb, sx, sz,
      nmix: THREE.MathUtils.clamp(((o.n ?? 2) - 2) / 2, 0, 1),
      k, sub: o.sub ?? false,
      exx: _cr.x, exy: _cr.y, exz: _cr.z,
      eyx: _ax.x, eyy: _ax.y, eyz: _ax.z,
      ezx: _rf.x, ezy: _rf.y, ezz: _rf.z,
      len: L, coneA, coneB, coneAL: coneA * L,
      minS: Math.min(sx, 1, sz),
      cx: (a[0] + b[0]) * 0.5, cy: (a[1] + b[1]) * 0.5, cz: (a[2] + b[2]) * 0.5,
      br: L * 0.5 + Math.max(ra, rb) * Math.max(sx, 1, sz) + k,
    });
  }

  /** An ellipsoid with independent radii. */
  ball(c: V3, r: V3, o: PrimOpts = {}): void {
    this.bone(c, c, r[1], r[1], { ...o, sx: r[0] / r[1], sz: r[2] / r[1] });
  }

  /** Same primitive on both sides of the midline. */
  pair(fn: (side: number) => void): void {
    fn(1);
    fn(-1);
  }

  eval(x: number, y: number, z: number): number {
    let d = 1e3;
    const ps = this.prims;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const dx = x - p.cx, dy = y - p.cy, dz = z - p.cz;
      const bb = p.br + 0.05;
      if (dx * dx + dy * dy + dz * dz > bb * bb) {
        // Outside a subtractor's reach it contributes nothing; outside a union's
        // it can only lose the min.
        continue;
      }
      const qx = x - p.ax, qy = y - p.ay, qz = z - p.az;
      const lx = (qx * p.exx + qy * p.exy + qz * p.exz) / p.sx;
      const ly = qx * p.eyx + qy * p.eyy + qz * p.eyz;
      const lz = (qx * p.ezx + qy * p.ezy + qz * p.ezz) / p.sz;

      const x2 = lx * lx;
      const z2 = lz * lz;
      let r = Math.sqrt(x2 + z2);
      if (p.nmix > 0) r += (Math.sqrt(Math.sqrt(x2 * x2 + z2 * z2)) - r) * p.nmix;

      let di: number;
      if (p.len === 0) {
        di = Math.sqrt(r * r + ly * ly) - p.ra;
      } else {
        const t = r * -p.coneB + ly * p.coneA;
        if (t < 0) di = Math.sqrt(r * r + ly * ly) - p.ra;
        else if (t > p.coneAL) {
          const ey = ly - p.len;
          di = Math.sqrt(r * r + ey * ey) - p.rb;
        } else di = r * p.coneA + ly * p.coneB - p.ra;
      }
      di *= p.minS;
      if (p.sub) d = -smin(-d, -(-di), p.k);
      else d = smin(d, di, p.k);
    }
    return d;
  }
}

// ---------------------------------------------------------------------------
// The head
// ---------------------------------------------------------------------------

/**
 * The sculpted head: a field, a coordinate frame, and the landmarks `face.ts`
 * hangs eyes, brows, lips and ears off.
 *
 * Landmarks are read back out of the *field*, not out of the table that built
 * it, so a feature can never end up floating off the skin: `project()` snaps any
 * point onto the surface, which is how the eyelids and brows are fitted.
 */
export class HeadForm {
  /** Chin-to-crown, metres. Every local unit is a multiple of this. */
  readonly HL: number;
  /** World y of the menton (chin bottom). */
  readonly y0: number;
  /** World z the local frame measures from. */
  readonly z0: number;
  /** Skull half-width in local units. */
  readonly hw: number;
  readonly spec: FaceSpec;
  private readonly s = new Sculpt();

  constructor(m: RigMetrics, j: JointMap, spec: FaceSpec) {
    this.HL = m.headLen;
    this.y0 = j.head.y;
    this.z0 = j.head.z;
    this.spec = spec;
    this.hw = m.skullR * (1 - 0.03 * m.fem) / m.headLen * spec.faceW;
    this.build(m, j);
  }

  /** Head-local (head-length units) to world. */
  world(n: V3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(n[0] * this.HL, this.y0 + n[1] * this.HL, this.z0 + n[2] * this.HL);
  }

  /** World to head-local. */
  local(p: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(p.x / this.HL, (p.y - this.y0) / this.HL, (p.z - this.z0) / this.HL);
  }

  /** Signed distance in **world** metres. */
  sd(x: number, y: number, z: number): number {
    return this.s.eval(x / this.HL, (y - this.y0) / this.HL, (z - this.z0) / this.HL) * this.HL;
  }

  /** Central-difference gradient of `sd`, normalised. */
  normal(p: THREE.Vector3, out = new THREE.Vector3(), h = this.HL * 0.006): THREE.Vector3 {
    const { x, y, z } = p;
    out.set(
      this.sd(x + h, y, z) - this.sd(x - h, y, z),
      this.sd(x, y + h, z) - this.sd(x, y - h, z),
      this.sd(x, y, z + h) - this.sd(x, y, z - h),
    );
    const l = out.length();
    return l > 1e-12 ? out.divideScalar(l) : out.set(0, 0, 1);
  }

  /**
   * Newton-projects a world point onto the surface.
   *
   * Steps are clamped, because a point that starts inside a concavity can see a
   * gradient pointing somewhere unhelpful and an unclamped Newton step from
   * there lands on the other side of the head.
   */
  project(p: THREE.Vector3, iters = 12, maxStep = this.HL * 0.06): THREE.Vector3 {
    const g = new THREE.Vector3();
    for (let i = 0; i < iters; i++) {
      const d = this.sd(p.x, p.y, p.z);
      if (Math.abs(d) < this.HL * 2e-4) break;
      this.normal(p, g);
      p.addScaledVector(g, -THREE.MathUtils.clamp(d, -maxStep, maxStep));
    }
    return p;
  }

  /** Surface point nearest the local position `n`, in world space. */
  snap(n: V3, out = new THREE.Vector3()): THREE.Vector3 {
    return this.project(this.world(n, out));
  }

  // --- landmarks ----------------------------------------------------------

  /** Eyeball centre, world. `side` is +1 for the character's left. */
  eyeCentre(side: number, out = new THREE.Vector3()): THREE.Vector3 {
    const sp = this.spec;
    return this.world([side * sp.eyeX, sp.eyeY, sp.eyeZ], out);
  }

  /** Radius of the eyeball, metres. */
  get eyeRadius(): number {
    return this.spec.eyeR * this.HL;
  }

  mouthCentre(out = new THREE.Vector3()): THREE.Vector3 {
    return this.world([0, this.spec.mouthY, 0.36], out);
  }

  noseTip(out = new THREE.Vector3()): THREE.Vector3 {
    return this.snap([0, this.spec.noseY, this.spec.noseLen + 0.02], out);
  }

  earCentre(side: number, out = new THREE.Vector3()): THREE.Vector3 {
    return this.world([side * (this.hw * 0.93), 0.415, -0.115], out);
  }

  // --- the sculpt ---------------------------------------------------------

  private build(m: RigMetrics, j: JointMap): void {
    const S = this.s;
    const sp = this.spec;
    const w = this.hw;
    const HL = this.HL;

    // The neck, copied from `body.ts` so the projection is a no-op down there.
    // Getting this wrong is the one way this pass can leave a visible seam.
    const nr = m.neckR / HL;
    const nyBase = (m.neckBaseY - 0.02 * m.height - this.y0) / HL;
    const nzBase = (-0.008 * m.height - this.z0) / HL;
    S.bone([0, nyBase, nzBase], [0, 0.14, 0.02], nr, nr * 0.85, { sz: 0.95, n: 2.2, k: 0.09 });

    // --- cranium -----------------------------------------------------------
    // Deliberately the same ellipsoid `hair.ts` fits to (centre 0.66 HL above
    // the chin, radii 1 : 1.03 : 1.22 on the skull half-width), so hair keeps
    // sitting on the scalp. Only its depth is trimmed a little, and the front is
    // then carved back below the hairline where hair does not lie flat anyway.
    S.ball([0, 0.658, 0.012], [w, w * 1.03, w * 1.185 * sp.skullDepth], { k: 0 });
    // Occiput. The single biggest miss in the old head: without it the back of
    // the skull is a smooth dome that runs straight into the neck, and the head
    // reads as an egg balanced on a stick from any angle but dead front.
    S.ball([0, 0.5, -0.185], [w * 0.9, 0.2, 0.23 * sp.occiput], { k: 0.07 });
    // Mastoid / nuchal mass behind and below the ear, joining skull to neck.
    S.pair((s) => S.ball([s * w * 0.58, 0.315, -0.155], [0.1, 0.115, 0.14], { k: 0.06 }));
    // Parietal slab: keeps the skull square-ish above the ear instead of round,
    // which is what makes the temple read as a plane.
    S.pair((s) => S.ball([s * w * 0.66, 0.555, -0.045], [0.115, 0.185, 0.245], { k: 0.07 }));

    // --- mid-face ----------------------------------------------------------
    // A flattish front plane between the cheekbones. A round section here is why
    // the old head had no face: the midline bulged as far forward as the nose.
    S.bone([0, 0.6, 0.115], [0, 0.26, 0.145], w * 0.72, w * 0.62, {
      sz: 0.84, n: 2.8, k: 0.05,
    });
    // Maxilla — the muzzle carrying the upper lip and the nose base.
    S.ball([0, 0.315, 0.2], [w * 0.56, 0.115, 0.155], { n: 2.4, k: 0.045 });

    // Cheekbones and the zygomatic arch running back to the ear. Height is the
    // per-fighter dial that separates Mali from Kai at a glance.
    S.pair((s) =>
      S.ball(
        [s * w * 0.665 * sp.cheekOut, sp.cheekY, 0.115],
        [0.105 * sp.cheekOut, 0.072, 0.15],
        { k: 0.045 },
      ),
    );
    S.pair((s) =>
      S.bone(
        [s * w * 0.74, sp.cheekY + 0.02, 0.03],
        [s * w * 0.42, sp.cheekY - 0.02, 0.225],
        0.05, 0.044, { k: 0.04 },
      ),
    );

    // Brow ridge: a glabella at the midline plus a ridge per side running out
    // and back over the orbit. The ridge is what casts the shadow the eye sits
    // in, so `browHeavy` is the loudest single dial in the box.
    const bh = sp.browHeavy;
    S.ball([0, sp.browY + 0.012, 0.245], [0.07, 0.045 + 0.02 * bh, 0.06 * bh], { k: 0.035 });
    S.pair((s) =>
      S.bone(
        [s * 0.05, sp.browY + 0.008, 0.245],
        [s * 0.225, sp.browY + 0.012, 0.14],
        0.05 + 0.022 * bh, 0.04 + 0.016 * bh,
        { sz: 0.62, k: 0.03 },
      ),
    );

    // --- jaw ---------------------------------------------------------------
    // Ramus (vertical, hanging off the ear) and body (gonion forward to the
    // chin). Small blend radii on purpose: the jaw has to keep an *edge*, and a
    // generous smooth-min is exactly what dissolved it before.
    const jw = sp.jawW;
    const gonZ = -0.115 - 0.02 * sp.jawSquare;
    S.pair((s) =>
      S.bone([s * jw * 0.98, 0.44, gonZ + 0.01], [s * jw, 0.245, gonZ], 0.055, 0.07, {
        sz: 0.8, n: 2 + 1.6 * sp.jawSquare, k: 0.035,
      }),
    );
    S.pair((s) =>
      S.bone([s * jw, 0.245, gonZ], [s * sp.chinW * 0.72, 0.055, 0.255], 0.072, 0.05, {
        sz: 0.86, n: 2 + 1.2 * sp.jawSquare, k: 0.03,
      }),
    );
    // Masseter: the slab that makes a fighter's jaw wide from the front.
    S.pair((s) =>
      S.ball([s * (jw - 0.03), 0.335, -0.02], [0.062 * sp.masseter, 0.105, 0.125], { k: 0.05 }),
    );
    // Chin. Squarer section on the heavy builds; `chinFwd` sets the profile.
    S.ball(
      [0, 0.075, 0.255 + 0.045 * sp.chinFwd],
      [sp.chinW, 0.075, 0.075 * sp.chinFwd],
      { n: 2.2 + 1.4 * sp.jawSquare, k: 0.04 },
    );

    // --- nose --------------------------------------------------------------
    // Small k throughout: a nose that melts into the face is not a nose. The
    // bridge is one tapered bone from the nasion to just above the tip, then the
    // tip, wings and columella are separate small masses.
    const nb = sp.noseBridge;
    S.bone([0, 0.55, 0.245], [0, sp.noseY + 0.03, sp.noseLen - 0.045], 0.03 * nb, 0.042 * nb, {
      sx: 1.05, sz: 0.85, k: 0.014,
    });
    S.ball([0, sp.noseY, sp.noseLen - 0.015], [0.048, 0.042, 0.05], { k: 0.012 });
    S.pair((s) =>
      S.ball([s * sp.noseW, sp.noseY - 0.03, sp.noseLen - 0.075], [0.042, 0.034, 0.046], {
        k: 0.014,
      }),
    );
    S.ball([0, sp.noseY - 0.038, sp.noseLen - 0.06], [0.026, 0.028, 0.04], { k: 0.012 });

    // --- lips --------------------------------------------------------------
    // Only the *mound* is here; the lip surfaces themselves are separate meshes
    // in `face.ts` so the mouth can open.
    const lf = sp.lipFull;
    S.ball([0, sp.mouthY + 0.028, 0.335], [sp.mouthW * 1.02, 0.032 * lf, 0.045 * lf], {
      n: 2.4, k: 0.022,
    });
    S.ball([0, sp.mouthY - 0.036, 0.338], [sp.mouthW * 0.94, 0.034 * lf, 0.048 * lf], {
      n: 2.3, k: 0.022,
    });

    // --- ears --------------------------------------------------------------
    // Mass only: the helix and concha are separate geometry. This has to live in
    // the body mesh because the ear is the one feature that breaks the head's
    // silhouette sideways, and the silhouette is drawn from this mesh.
    const es = sp.earSize;
    S.pair((s) =>
      S.ball([s * w * 0.98, 0.42, -0.115], [0.04 * es, 0.108 * es, 0.075 * es], {
        n: 2.3, k: 0.02,
      }),
    );
    S.pair((s) =>
      S.ball([s * w * 0.95, 0.322, -0.1], [0.032 * es, 0.042 * es, 0.045 * es], { k: 0.02 }),
    );

    // --- subtractions ------------------------------------------------------
    // Everything above is mass; the face is finished by taking material away.
    // Order matters: these carve the accumulated form, so they run last.

    // Forehead: lean it back above the brow. Stops short of the hairline so the
    // scalp hair still lies on the ellipsoid it was fitted to.
    S.ball([0, 0.62, 0.44 + sp.foreheadBack * 1.2], [0.42, 0.13, 0.14], { sub: true, k: 0.09 });
    // Orbits. This is what makes the brow read as a brow: an eye in a hole with
    // a ridge over it, rather than an eye painted on a curve.
    S.pair((s) =>
      S.ball(
        [s * sp.eyeX, sp.eyeY + 0.012, sp.eyeZ + 0.135 + 0.022 * sp.orbitDeep],
        [0.115, 0.082, 0.105 * sp.orbitDeep],
        { sub: true, k: 0.05 },
      ),
    );
    // Temple hollows, behind the brow's outer end.
    S.pair((s) =>
      S.ball([s * (w + 0.055), sp.browY + 0.045, 0.2], [0.11, 0.115, 0.115], {
        sub: true, k: 0.075 * sp.temple,
      }),
    );
    // Buccal hollow under the cheekbone — the shadow that makes a cheekbone.
    S.pair((s) =>
      S.ball([s * (jw + 0.045), 0.29, 0.155], [0.09 * sp.buccal, 0.1, 0.11], {
        sub: true, k: 0.075,
      }),
    );
    // Undercut beneath the nose, so the nose has a base rather than a ramp.
    S.ball([0, sp.noseY - 0.135, sp.noseLen + 0.02], [0.1, 0.075, 0.075], { sub: true, k: 0.022 });
    // Mouth seam and the mentolabial sulcus below the lower lip.
    S.ball([0, sp.mouthY - 0.088, 0.375], [sp.mouthW * 0.95, 0.03, 0.045], {
      sub: true, k: 0.045,
    });
    // Submental scoop: gives the jaw an underside instead of letting it run
    // smoothly into the throat.
    S.ball([0, 0.03, 0.235], [0.185, 0.06, 0.14], { sub: true, k: 0.06 });
    // Front of the ear: a shallow trench so the ear is a separate form.
    S.pair((s) =>
      S.ball([s * (w * 0.86), 0.4, -0.055], [0.05, 0.1, 0.05], { sub: true, k: 0.035 }),
    );
  }
}

// ---------------------------------------------------------------------------
// Applying the sculpt to the body mesh
// ---------------------------------------------------------------------------

interface MeshData {
  pos: number[];
  nrm: number[];
  uv: number[];
  si: number[];
  sw: number[];
  idx: number[];
}

function readMesh(g: THREE.BufferGeometry): MeshData {
  const arr = (name: string): number[] => {
    const a = g.getAttribute(name);
    return a ? Array.from(a.array as ArrayLike<number>) : [];
  };
  const index = g.getIndex();
  if (!index) throw new Error('head sculpt needs an indexed body mesh');
  return {
    pos: arr('position'),
    nrm: arr('normal'),
    uv: arr('uv'),
    si: arr('skinIndex'),
    sw: arr('skinWeight'),
    idx: Array.from(index.array as ArrayLike<number>),
  };
}

function writeMesh(g: THREE.BufferGeometry, md: MeshData): void {
  g.setAttribute('position', new THREE.Float32BufferAttribute(md.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(md.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(md.uv, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(md.si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(md.sw, 4));
  g.setIndex(md.idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  // The ink hull and the crease pass share this geometry and cache a welded
  // normal off it, so it has to be invalidated or the outline expands along
  // directions the surface no longer has.
  g.deleteAttribute('outlineNormal');
  computeOutlineNormals(g, true);
}

/** Merge two vertices' four-bone influences into a new four-bone set. */
function mergeSkin(md: MeshData, a: number, b: number): void {
  const acc = new Map<number, number>();
  for (const v of [a, b]) {
    for (let s = 0; s < 4; s++) {
      const i = md.si[v * 4 + s];
      const wt = md.sw[v * 4 + s];
      if (wt <= 0) continue;
      acc.set(i, (acc.get(i) ?? 0) + wt * 0.5);
    }
  }
  const top = [...acc.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4);
  let sum = 0;
  for (const [, wt] of top) sum += wt;
  for (let s = 0; s < 4; s++) {
    md.si.push(top[s] ? top[s][0] : 0);
    md.sw.push(top[s] && sum > 0 ? top[s][1] / sum : 0);
  }
}

/**
 * One level of red-green subdivision over the triangles `select` accepts.
 *
 * Every edge of a selected triangle is split; neighbours that end up with one or
 * two split edges are re-triangulated rather than left with a T-junction, which
 * is what would otherwise open a hairline crack along the boundary of the
 * refined patch — and a crack in a closed mesh means the ink hull leaks.
 */
function subdivide(md: MeshData, select: (cx: number, cy: number, cz: number) => boolean): void {
  const tris = md.idx.length / 3;
  const wanted = new Set<number>();
  const N = md.pos.length / 3;
  const key = (a: number, b: number) => (a < b ? a * N + b : b * N + a);

  for (let t = 0; t < tris; t++) {
    const a = md.idx[t * 3], b = md.idx[t * 3 + 1], c = md.idx[t * 3 + 2];
    const cx = (md.pos[a * 3] + md.pos[b * 3] + md.pos[c * 3]) / 3;
    const cy = (md.pos[a * 3 + 1] + md.pos[b * 3 + 1] + md.pos[c * 3 + 1]) / 3;
    const cz = (md.pos[a * 3 + 2] + md.pos[b * 3 + 2] + md.pos[c * 3 + 2]) / 3;
    if (!select(cx, cy, cz)) continue;
    wanted.add(key(a, b));
    wanted.add(key(b, c));
    wanted.add(key(c, a));
  }
  if (wanted.size === 0) return;

  const mid = new Map<number, number>();
  const midOf = (a: number, b: number): number => {
    const kk = key(a, b);
    const found = mid.get(kk);
    if (found !== undefined) return found;
    const i = md.pos.length / 3;
    for (let c = 0; c < 3; c++) md.pos.push((md.pos[a * 3 + c] + md.pos[b * 3 + c]) * 0.5);
    const nx = md.nrm[a * 3] + md.nrm[b * 3];
    const ny = md.nrm[a * 3 + 1] + md.nrm[b * 3 + 1];
    const nz = md.nrm[a * 3 + 2] + md.nrm[b * 3 + 2];
    const l = Math.hypot(nx, ny, nz) || 1;
    md.nrm.push(nx / l, ny / l, nz / l);
    md.uv.push((md.uv[a * 2] + md.uv[b * 2]) * 0.5, (md.uv[a * 2 + 1] + md.uv[b * 2 + 1]) * 0.5);
    mergeSkin(md, a, b);
    mid.set(kk, i);
    return i;
  };

  const out: number[] = [];
  for (let t = 0; t < tris; t++) {
    let v0 = md.idx[t * 3], v1 = md.idx[t * 3 + 1], v2 = md.idx[t * 3 + 2];
    // Rotate the triangle so the split pattern is canonical: for one split it is
    // edge (v0,v1); for two it is (v0,v1) and (v1,v2).
    let s0 = wanted.has(key(v0, v1));
    let s1 = wanted.has(key(v1, v2));
    let s2 = wanted.has(key(v2, v0));
    const n = (s0 ? 1 : 0) + (s1 ? 1 : 0) + (s2 ? 1 : 0);
    for (let spin = 0; spin < 3; spin++) {
      if (n === 1 && s0) break;
      if (n === 2 && s0 && s1) break;
      if (n !== 1 && n !== 2) break;
      const tv = v0; v0 = v1; v1 = v2; v2 = tv;
      const ts = s0; s0 = s1; s1 = s2; s2 = ts;
    }
    if (n === 0) {
      out.push(v0, v1, v2);
    } else if (n === 1) {
      const m01 = midOf(v0, v1);
      out.push(v0, m01, v2, m01, v1, v2);
    } else if (n === 2) {
      const m01 = midOf(v0, v1);
      const m12 = midOf(v1, v2);
      out.push(m01, v1, m12, v0, m01, m12, v0, m12, v2);
    } else {
      const m01 = midOf(v0, v1);
      const m12 = midOf(v1, v2);
      const m20 = midOf(v2, v0);
      out.push(v0, m01, m20, m01, v1, m12, m20, m12, v2, m01, m12, m20);
    }
  }
  md.idx = out;
}

export interface HeadRefineResult {
  form: HeadForm;
  /** Vertices the projection actually moved. */
  moved: number;
  triangles: number;
}

/**
 * Re-sculpts `rig`'s head in place.
 *
 * Must run **before** `addOutlines`, though it repairs the welded outline normal
 * if it has already run, so calling it late degrades to "correct but wasteful"
 * rather than "silently broken".
 */
export function refineHead(rig: BuiltCharacter, spec = faceSpec(rig.def)): HeadRefineResult {
  const form = new HeadForm(rig.metrics, rig.joints, spec);
  const geo = rig.meshes[0].geometry;
  const md = readMesh(geo);
  const HL = form.HL;
  const y0 = form.y0;
  const z0 = form.z0;

  // Local height and axial radius of a world point, in head-lengths.
  const uOf = (y: number) => (y - y0) / HL;
  const rhoOf = (x: number, z: number) => Math.hypot(x / HL, (z - z0) / HL);

  // Two refinement passes. The whole head first, then the front of the face
  // again, because eyes, nose and mouth are 2 cm features on a 10 mm grid and
  // the rest of the skull is not.
  subdivide(md, (x, y, z) => uOf(y) > -0.2 && rhoOf(x, z) < 0.66);
  subdivide(md, (x, y, z) => {
    const u = uOf(y);
    const zl = (z - z0) / HL;
    return u > -0.02 && u < 0.78 && zl > -0.16 && rhoOf(x, z) < 0.56;
  });

  const n = md.pos.length / 3;
  const weight = new Float32Array(n);
  const p = new THREE.Vector3();
  const g = new THREE.Vector3();
  let moved = 0;

  for (let i = 0; i < n; i++) {
    const x = md.pos[i * 3], y = md.pos[i * 3 + 1], z = md.pos[i * 3 + 2];
    const u = uOf(y);
    if (u < -0.3 || rhoOf(x, z) > 0.7) continue;
    // Fade out through the neck, and fade out for anything that was never part
    // of the head to begin with — the trapezius runs up beside the neck and must
    // not be dragged onto it.
    const fu = THREE.MathUtils.smoothstep(u, -0.26, -0.06);
    const d0 = Math.abs(form.sd(x, y, z));
    const fd = 1 - THREE.MathUtils.smoothstep(d0, HL * 0.17, HL * 0.34);
    const wt = fu * fd;
    if (wt < 0.004) continue;
    weight[i] = wt;
    moved++;
  }

  const project = (i: number): void => {
    const wt = weight[i];
    if (wt <= 0) return;
    const ox = md.pos[i * 3], oy = md.pos[i * 3 + 1], oz = md.pos[i * 3 + 2];
    p.set(ox, oy, oz);
    form.project(p);
    md.pos[i * 3] = ox + (p.x - ox) * wt;
    md.pos[i * 3 + 1] = oy + (p.y - oy) * wt;
    md.pos[i * 3 + 2] = oz + (p.z - oz) * wt;
  };

  for (let i = 0; i < n; i++) project(i);

  // Even the patch out and re-project. The sculpt contracts the forehead and
  // grows the occiput by a couple of cells, which bunches vertices; two
  // tangential relaxation passes cost little and stop the ink hull from
  // wobbling along the crowded rows.
  const edges: number[] = [];
  for (let t = 0; t < md.idx.length; t += 3) {
    const a = md.idx[t], b = md.idx[t + 1], c = md.idx[t + 2];
    if (weight[a] > 0.75 || weight[b] > 0.75) edges.push(a, b);
    if (weight[b] > 0.75 || weight[c] > 0.75) edges.push(b, c);
    if (weight[c] > 0.75 || weight[a] > 0.75) edges.push(c, a);
  }
  const sum = new Float32Array(n * 3);
  const cnt = new Float32Array(n);
  for (let pass = 0; pass < 2; pass++) {
    sum.fill(0);
    cnt.fill(0);
    for (let e = 0; e < edges.length; e += 2) {
      const a = edges[e], b = edges[e + 1];
      for (let c = 0; c < 3; c++) {
        sum[a * 3 + c] += md.pos[b * 3 + c];
        sum[b * 3 + c] += md.pos[a * 3 + c];
      }
      cnt[a]++;
      cnt[b]++;
    }
    for (let i = 0; i < n; i++) {
      if (weight[i] < 0.75 || cnt[i] === 0) continue;
      const x = md.pos[i * 3], y = md.pos[i * 3 + 1], z = md.pos[i * 3 + 2];
      form.normal(p.set(x, y, z), g);
      let dx = sum[i * 3] / cnt[i] - x;
      let dy = sum[i * 3 + 1] / cnt[i] - y;
      let dz = sum[i * 3 + 2] / cnt[i] - z;
      const dn = dx * g.x + dy * g.y + dz * g.z;
      dx -= g.x * dn; dy -= g.y * dn; dz -= g.z * dn;
      md.pos[i * 3] = x + dx * 0.42;
      md.pos[i * 3 + 1] = y + dy * 0.42;
      md.pos[i * 3 + 2] = z + dz * 0.42;
      p.set(md.pos[i * 3], md.pos[i * 3 + 1], md.pos[i * 3 + 2]);
      form.project(p, 4, HL * 0.02);
      md.pos[i * 3] = p.x;
      md.pos[i * 3 + 1] = p.y;
      md.pos[i * 3 + 2] = p.z;
    }
  }

  // Normals from the field's own gradient: analytic, so the nose and the jaw
  // edge come out crisp at any triangle density, and no faceting anywhere.
  for (let i = 0; i < n; i++) {
    const wt = weight[i];
    if (wt <= 0) continue;
    form.normal(p.set(md.pos[i * 3], md.pos[i * 3 + 1], md.pos[i * 3 + 2]), g);
    for (let c = 0; c < 3; c++) {
      md.nrm[i * 3 + c] = md.nrm[i * 3 + c] * (1 - wt) + g.getComponent(c) * wt;
    }
    const l = Math.hypot(md.nrm[i * 3], md.nrm[i * 3 + 1], md.nrm[i * 3 + 2]) || 1;
    for (let c = 0; c < 3; c++) md.nrm[i * 3 + c] /= l;
  }

  writeMesh(geo, md);
  return { form, moved, triangles: md.idx.length / 3 };
}
