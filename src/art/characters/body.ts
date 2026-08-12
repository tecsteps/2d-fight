import * as THREE from 'three';
import { BONES, type BoneName } from '../../anim/contract';
import { boneDistance, type JointMap, type RigMetrics } from '../../anim/Skeleton';

/**
 * Procedural body mesh.
 *
 * The body is authored as an implicit field — a set of tapered, elliptical
 * muscle volumes strung along the rest skeleton — and then meshed with surface
 * nets into one closed manifold.
 *
 * Why implicit rather than sweeping cross-sections and stitching them: a fighter
 * silhouette is read against the ink outline, and any place two swept tubes are
 * merely *overlapped* rather than joined shows up as a hard seam the moment the
 * outline pass runs. Branching (four limbs + neck off one torso) is exactly
 * where stitched sweeps get ugly, and it is exactly where a fighter's silhouette
 * is judged: shoulders, hips, armpits. A single manifold with smooth-min joints
 * has no seams anywhere, by construction.
 *
 * The cost of implicits is normally topology quality, and that is paid for here
 * in two ways: surface nets gives one quad per surface crossing rather than
 * marching-cubes soup, and every vertex is relaxed tangentially and then snapped
 * back onto the exact zero level set, so the mesh is evenly spaced and the
 * silhouette error is second order. Normals come from the analytic gradient, so
 * there is no faceting at all regardless of resolution.
 *
 * Nothing here is loaded. Every number is derived from `RigMetrics`.
 */

/**
 * One muscle volume: a round cone (tapered capsule) from `a` to `b`, with an
 * elliptical, optionally super-elliptical cross-section.
 *
 * `a === b` degenerates to an ellipsoid, which is how the round masses — glutes,
 * deltoid caps, cranium, pectorals — are expressed.
 */
export interface Prim {
  bone: BoneName;
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  ra: number; rb: number;
  /** Cross-section scale across the limb (x), along it (y), and front-back (z). */
  sx: number; sy: number; sz: number;
  /** Cross-section exponent. 2 = ellipse, 3 = rounded rectangle (torso, feet). */
  n: number;
  /** Blend from the 2-norm to the 4-norm that stands in for that exponent. */
  nmix: number;
  /** Smooth-union radius against everything already accumulated. */
  k: number;
  /** Subtract instead of union — used for the few creases worth having in geometry. */
  sub: boolean;
  // Cached frame + bound.
  exx: number; exy: number; exz: number;
  eyx: number; eyy: number; eyz: number;
  ezx: number; ezy: number; ezz: number;
  len: number;
  coneB: number; coneA: number; coneAL: number;
  minS: number;
  cx: number; cy: number; cz: number; br: number;
  /**
   * Optional swept profile, sampled along the axis: stride 6 of
   * `[radius, depthScale, normMix, offsetX, offsetZ, dRadius/dLength]`.
   * When present this primitive is a single smooth generalised cylinder rather
   * than a cone — see `Plan.tube`.
   */
  lut: Float32Array | null;
  lutN: number;
  /** Bone per profile sample, for volumes that span a joint (the torso). */
  boneRamp: BoneName[] | null;
}

export interface BodyPlan {
  prims: Prim[];
  metrics: RigMetrics;
  joints: JointMap;
  /** Largest blend radius in the plan; the mesher needs it for its safe bounds. */
  maxK: number;
  /** Uniform grid of prim indices — the field is queried ~300k times per build. */
  grid: PrimGrid;
}

interface PrimGrid {
  ox: number; oy: number; oz: number;
  nx: number; ny: number; nz: number;
  cell: number;
  bins: Int32Array[];
}

function buildPrimGrid(prims: readonly Prim[], cell: number): PrimGrid {
  let ox = Infinity, oy = Infinity, oz = Infinity;
  let hx = -Infinity, hy = -Infinity, hz = -Infinity;
  for (const p of prims) {
    const r = p.br + 0.06;
    ox = Math.min(ox, p.cx - r); hx = Math.max(hx, p.cx + r);
    oy = Math.min(oy, p.cy - r); hy = Math.max(hy, p.cy + r);
    oz = Math.min(oz, p.cz - r); hz = Math.max(hz, p.cz + r);
  }
  const nx = Math.max(1, Math.ceil((hx - ox) / cell));
  const ny = Math.max(1, Math.ceil((hy - oy) / cell));
  const nz = Math.max(1, Math.ceil((hz - oz) / cell));
  const lists: number[][] = Array.from({ length: nx * ny * nz }, () => []);
  const half = cell * 0.5 * Math.sqrt(3);
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    const reach = p.br + 0.06 + half;
    const i0 = Math.max(0, Math.floor((p.cx - reach - ox) / cell));
    const i1 = Math.min(nx - 1, Math.floor((p.cx + reach - ox) / cell));
    const j0 = Math.max(0, Math.floor((p.cy - reach - oy) / cell));
    const j1 = Math.min(ny - 1, Math.floor((p.cy + reach - oy) / cell));
    const k0 = Math.max(0, Math.floor((p.cz - reach - oz) / cell));
    const k1 = Math.min(nz - 1, Math.floor((p.cz + reach - oz) / cell));
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let ii = i0; ii <= i1; ii++) lists[(k * ny + j) * nx + ii].push(i);
  }
  return { ox, oy, oz, nx, ny, nz, cell, bins: lists.map((l) => Int32Array.from(l)) };
}

const EMPTY_BIN = new Int32Array(0);

function binAt(g: PrimGrid, x: number, y: number, z: number): Int32Array {
  const i = Math.floor((x - g.ox) / g.cell);
  const j = Math.floor((y - g.oy) / g.cell);
  const k = Math.floor((z - g.oz) / g.cell);
  if (i < 0 || j < 0 || k < 0 || i >= g.nx || j >= g.ny || k >= g.nz) return EMPTY_BIN;
  return g.bins[(k * g.ny + j) * g.nx + i];
}

/** Field value using the plan's spatial index. Outside the grid the body is far. */
export function fieldAt(plan: BodyPlan, x: number, y: number, z: number): number {
  const bin = binAt(plan.grid, x, y, z);
  if (bin.length === 0) return FAR;
  return sampleField(plan.prims, x, y, z, bin);
}

interface PrimOpts {
  sx?: number;
  sy?: number;
  sz?: number;
  n?: number;
  k?: number;
  /** World direction that becomes the primitive's local +Z (its "front"). */
  ref?: [number, number, number];
  sub?: boolean;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _r = new THREE.Vector3();
const _x = new THREE.Vector3();

class Plan {
  prims: Prim[] = [];
  maxK = 0;

  seg(
    bone: BoneName,
    a: THREE.Vector3 | number[],
    b: THREE.Vector3 | number[],
    ra: number,
    rb: number,
    o: PrimOpts = {},
  ): Prim {
    _a.fromArray(Array.isArray(a) ? a : a.toArray());
    _b.fromArray(Array.isArray(b) ? b : b.toArray());
    const len = _d.subVectors(_b, _a).length();
    const isPoint = len < 1e-6;

    // Local +Y runs down the volume; local +Z is the anatomical front unless the
    // volume itself points that way (the feet), in which case the caller hands us
    // world up as the reference and +Z becomes "up" for that primitive.
    if (isPoint) {
      _d.set(0, 1, 0);
      _r.set(0, 0, 1);
      _x.set(1, 0, 0);
    } else {
      _d.normalize();
      _r.fromArray(o.ref ?? [0, 0, 1]);
      const proj = _r.dot(_d);
      _r.addScaledVector(_d, -proj);
      if (_r.lengthSq() < 0.02) {
        _r.set(0, 1, 0).addScaledVector(_d, -_d.y);
        if (_r.lengthSq() < 0.02) _r.set(1, 0, 0).addScaledVector(_d, -_d.x);
      }
      _r.normalize();
      _x.crossVectors(_d, _r);
    }

    const sx = o.sx ?? 1;
    // Scaling along the axis would move the endpoints, so it is only meaningful
    // for the ellipsoid case.
    const sy = isPoint ? (o.sy ?? 1) : 1;
    const sz = o.sz ?? 1;
    const k = o.k ?? 0.01;
    const maxS = Math.max(sx, sy, sz);
    const coneB = isPoint ? 0 : (ra - rb) / len;
    const coneA = Math.sqrt(Math.max(0, 1 - coneB * coneB));

    const p: Prim = {
      bone,
      ax: _a.x, ay: _a.y, az: _a.z,
      bx: _b.x, by: _b.y, bz: _b.z,
      ra, rb,
      sx, sy, sz,
      n: o.n ?? 2,
      nmix: THREE.MathUtils.clamp(((o.n ?? 2) - 2) / 2, 0, 1),
      k,
      sub: o.sub ?? false,
      exx: _x.x, exy: _x.y, exz: _x.z,
      eyx: _d.x, eyy: _d.y, eyz: _d.z,
      ezx: _r.x, ezy: _r.y, ezz: _r.z,
      len: isPoint ? 0 : len,
      coneB,
      coneA,
      coneAL: coneA * len,
      minS: Math.min(sx, sy, sz),
      cx: (_a.x + _b.x) * 0.5,
      cy: (_a.y + _b.y) * 0.5,
      cz: (_a.z + _b.z) * 0.5,
      br: len * 0.5 + Math.max(ra, rb) * maxS + k,
      lut: null,
      lutN: 0,
      boneRamp: null,
    };
    this.prims.push(p);
    if (!p.sub) this.maxK = Math.max(this.maxK, k);
    return p;
  }

  point(bone: BoneName, p: THREE.Vector3 | number[], r: number, o: PrimOpts = {}): Prim {
    return this.seg(bone, p, p, r, r, o);
  }

  /**
   * A limb or torso as **one** smooth swept volume.
   *
   * The obvious construction — chain short cones along the profile — cannot be
   * made to look right at any blend radius. Union them hard and every joint is
   * a crease the cel ramp turns into a contour ring; blend them and the
   * smooth-min inflates the surface by k/4 at each joint, which is the same
   * rings with softer edges. Twenty rings stacked down a thigh is the single
   * most obvious "procedural" tell there is.
   *
   * So a swept form is a primitive in its own right: radius, depth, section
   * exponent and centre offset are sampled from Catmull-Roms into one table and
   * read back with interpolation, giving a generalised cylinder that is smooth
   * by construction. It is also far cheaper — one primitive per limb instead of
   * twenty — which is most of why a fighter builds in under a second.
   */
  tube(o: {
    bones: BoneName[];
    pts: THREE.Vector3[];
    r: number[];
    sz?: number[];
    n?: number[];
    k: number;
    sx?: number;
    ref?: [number, number, number];
    samples?: number;
  }): Prim {
    const N = o.samples ?? 96;
    const last = o.pts.length - 1;
    const xs = o.pts.map((p) => p.x);
    const ys = o.pts.map((p) => p.y);
    const zs = o.pts.map((p) => p.z);
    const a = o.pts[0];
    const b = o.pts[last];

    // Build with a straight axis and the curve carried as a perpendicular
    // offset, so the sweep parameter is always distance along that axis.
    const p = this.seg(o.bones[0], a, b, o.r[0], o.r[last], {
      sx: o.sx,
      sz: o.sz ? o.sz[0] : 1,
      n: 2,
      k: o.k,
      ref: o.ref,
    });
    const len = p.len;
    const ex = new THREE.Vector3(p.exx, p.exy, p.exz);
    const ey = new THREE.Vector3(p.eyx, p.eyy, p.eyz);
    const ez = new THREE.Vector3(p.ezx, p.ezy, p.ezz);

    // Invert t -> distance-along-axis so the table is uniform in the parameter
    // the distance function actually has in hand.
    const FINE = 512;
    const axial = new Float32Array(FINE + 1);
    const c = new THREE.Vector3();
    for (let i = 0; i <= FINE; i++) {
      const t = i / FINE;
      c.set(catmull(xs, t), catmull(ys, t), catmull(zs, t)).sub(a);
      axial[i] = c.dot(ey);
    }
    const tOf = (s: number): number => {
      const target = s * len;
      let i = 0;
      while (i < FINE - 1 && axial[i + 1] < target) i++;
      const span = axial[i + 1] - axial[i];
      return (i + (span > 1e-9 ? (target - axial[i]) / span : 0)) / FINE;
    };

    const lut = new Float32Array(N * 6);
    let maxR = 0;
    let maxOff = 0;
    let minSz = Infinity;
    for (let i = 0; i < N; i++) {
      const t = tOf(i / (N - 1));
      const r = catmull(o.r, t);
      const sz = o.sz ? catmull(o.sz, t) : 1;
      const nn = o.n ? catmull(o.n, t) : 2;
      c.set(catmull(xs, t), catmull(ys, t), catmull(zs, t)).sub(a);
      c.addScaledVector(ey, -c.dot(ey));
      lut[i * 6] = r;
      lut[i * 6 + 1] = sz;
      lut[i * 6 + 2] = THREE.MathUtils.clamp((nn - 2) / 2, 0, 1);
      lut[i * 6 + 3] = c.dot(ex);
      lut[i * 6 + 4] = c.dot(ez);
      maxR = Math.max(maxR, r);
      maxOff = Math.max(maxOff, c.length());
      minSz = Math.min(minSz, sz);
    }
    // Radius slope, so the tube reports true distance rather than radial
    // distance — without it a tapered limb's shading skews toward the taper.
    for (let i = 0; i < N; i++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(N - 1, i + 1);
      lut[i * 6 + 5] = ((lut[i1 * 6] - lut[i0 * 6]) * (N - 1)) / ((i1 - i0) * len);
    }

    p.lut = lut;
    p.lutN = N;
    p.boneRamp = o.bones.length > 1 ? o.bones : null;
    p.minS = Math.min(p.sx, minSz, 1);
    p.br = len * 0.5 + maxR * Math.max(p.sx, 1) + maxOff + o.k;
    return p;
  }

  /** Mirrors the last `count` primitives across the sagittal plane. */
  mirror(count: number): void {
    const flip = (b: BoneName) => (b.endsWith('L') ? ((b.slice(0, -1) + 'R') as BoneName) : b);
    const src = this.prims.slice(this.prims.length - count);
    for (const p of src) {
      // Reflecting all three frame axes about x leaves the local coordinates of
      // the reflected point identical, so radii, profile offsets and the section
      // exponent all carry over untouched.
      const q: Prim = {
        ...p,
        bone: flip(p.bone),
        boneRamp: p.boneRamp ? p.boneRamp.map(flip) : null,
        ax: -p.ax, bx: -p.bx, cx: -p.cx,
        exx: -p.exx, exy: p.exy, exz: p.exz,
        eyx: -p.eyx, eyy: p.eyy, eyz: p.eyz,
        ezx: -p.ezx, ezy: p.ezy, ezz: p.ezz,
      };
      this.prims.push(q);
    }
  }
}

/** Catmull-Rom through evenly spaced control values, clamped at both ends. */
function catmull(v: number[], t: number): number {
  const n = v.length - 1;
  if (n <= 0) return v[0];
  const s = THREE.MathUtils.clamp(t, 0, 1) * n;
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

/** Quadratic smooth minimum. The blend inflates the surface by at most k/4. */
function smin(a: number, b: number, k: number): number {
  if (k <= 1e-6) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

export function primDistance(p: Prim, px: number, py: number, pz: number): number {
  const qx = px - p.ax;
  const qy = py - p.ay;
  const qz = pz - p.az;
  const lxr = qx * p.exx + qy * p.exy + qz * p.exz;
  const lyr = qx * p.eyx + qy * p.eyy + qz * p.eyz;
  const lzr = qx * p.ezx + qy * p.ezy + qz * p.ezz;

  if (p.lut) return tubeDistance(p, lxr, lyr, lzr);

  const lx = lxr / p.sx;
  const ly = lyr / p.sy;
  const lz = lzr / p.sz;

  // Cross-section norm. A true p-norm needs three `pow` calls and this runs a
  // few hundred thousand times per build, so the squarer sections are reached by
  // mixing toward the 4-norm instead — three square roots, visually identical,
  // and still 1-Lipschitz because a convex mix of norms is a norm.
  const x2 = lx * lx;
  const z2 = lz * lz;
  let r = Math.sqrt(x2 + z2);
  if (p.nmix > 0) r += (Math.sqrt(Math.sqrt(x2 * x2 + z2 * z2)) - r) * p.nmix;

  let d: number;
  if (p.len === 0) {
    d = Math.sqrt(r * r + ly * ly) - p.ra;
  } else {
    const t = r * -p.coneB + ly * p.coneA;
    if (t < 0) d = Math.sqrt(r * r + ly * ly) - p.ra;
    else if (t > p.coneAL) {
      const dy = ly - p.len;
      d = Math.sqrt(r * r + dy * dy) - p.rb;
    } else d = r * p.coneA + ly * p.coneB - p.ra;
  }
  return d * p.minS;
}

function tubeDistance(p: Prim, lx: number, ly: number, lz: number): number {
  const L = p.lut!;
  const s = ly / p.len;
  const sc = s < 0 ? 0 : s > 1 ? 1 : s;
  const f = sc * (p.lutN - 1);
  let i = f | 0;
  if (i > p.lutN - 2) i = p.lutN - 2;
  const u = f - i;
  const o = i * 6;
  const r = L[o] + (L[o + 6] - L[o]) * u;
  const sz = L[o + 1] + (L[o + 7] - L[o + 1]) * u;
  const nm = L[o + 2] + (L[o + 8] - L[o + 2]) * u;
  const ox = L[o + 3] + (L[o + 9] - L[o + 3]) * u;
  const oz = L[o + 4] + (L[o + 10] - L[o + 4]) * u;
  const rp = L[o + 5] + (L[o + 11] - L[o + 5]) * u;

  const X = (lx - ox) / p.sx;
  const Z = (lz - oz) / sz;
  const x2 = X * X;
  const z2 = Z * Z;
  let rad = Math.sqrt(x2 + z2);
  if (nm > 0) rad += (Math.sqrt(Math.sqrt(x2 * x2 + z2 * z2)) - rad) * nm;

  const dy = ly < 0 ? ly : ly > p.len ? ly - p.len : 0;
  const d =
    dy !== 0
      ? Math.sqrt(rad * rad + dy * dy) - r
      : (rad - r) / Math.sqrt(1 + rp * rp);
  return d * p.minS;
}

/** Which bone owns the surface here — profile tubes can span a joint. */
function primBone(p: Prim, x: number, y: number, z: number): BoneName {
  if (!p.boneRamp) return p.bone;
  const ly = (x - p.ax) * p.eyx + (y - p.ay) * p.eyy + (z - p.az) * p.eyz;
  const s = THREE.MathUtils.clamp(p.len > 0 ? ly / p.len : 0, 0, 1);
  return p.boneRamp[Math.round(s * (p.boneRamp.length - 1))];
}

const FAR = 1e3;

/** Field value of the whole body, optionally restricted to a candidate list. */
export function sampleField(
  prims: readonly Prim[],
  x: number,
  y: number,
  z: number,
  list?: ArrayLike<number>,
): number {
  let d = FAR;
  const n = list ? list.length : prims.length;
  for (let i = 0; i < n; i++) {
    const p = prims[list ? list[i] : i];
    const dx = x - p.cx;
    const dy = y - p.cy;
    const dz = z - p.cz;
    const bb = p.br + 0.06;
    if (dx * dx + dy * dy + dz * dz > bb * bb) continue;
    const di = primDistance(p, x, y, z);
    if (p.sub) d = smax(d, -di, p.k);
    else d = smin(d, di, p.k);
  }
  return d;
}

/**
 * The anatomy.
 *
 * Read this as a figure-drawing pass, not as code: masses are laid in from the
 * torso outward, big shapes first, and every radius is a fraction of a measured
 * quantity so that the four fighters stay siblings. `build` moves muscle volume,
 * `fem` moves the shoulder/hip/chest relationship — between them, Vera reads as
 * a powerlifter and Davi as a capoeirista without a single per-fighter branch.
 */
export function buildBodyPlan(m: RigMetrics, j: JointMap): BodyPlan {
  const P = new Plan();
  const H = m.height;
  const Y0 = m.legLen;
  const T = m.torsoLen;
  const build = m.build;
  const fem = m.fem;
  const depth = m.torsoDepth / 0.72;

  // --- Torso ---------------------------------------------------------------
  // A stack of super-elliptical slices. The z offsets are the spinal curve:
  // pelvis tipped back, lumbar hollow, ribcage forward, shoulders settled back.
  const waist = m.waistHalf;
  const chest = m.chestHalf;
  const hipW = m.hipHalf;
  const slices: [number, number, number, number, number, BoneName][] = [
    // y,                 halfWidth,      depthRatio, zOffset,   n,   bone
    [Y0 - 0.16 * T, hipW * 0.64, 0.6, -0.004 * H, 2.2, 'hips'],
    [Y0 + 0.05 * T, hipW * 1.0, 0.58, -0.012 * H, 2.6, 'hips'],
    [Y0 + 0.2 * T, hipW * 0.82, 0.64, -0.008 * H, 2.6, 'hips'],
    [Y0 + 0.36 * T, waist, 0.76, -0.002 * H, 2.5, 'spine'],
    [Y0 + 0.52 * T, waist + (chest - waist) * 0.7, 0.78, 0.004 * H, 2.6, 'spine'],
    [Y0 + 0.7 * T, chest, 0.72, 0.01 * H, 2.8, 'chest'],
    [Y0 + 0.86 * T, chest * 0.93, 0.74, 0.006 * H, 2.7, 'chest'],
    [m.neckBaseY, chest * 0.7, 0.8, -0.006 * H, 2.4, 'chest'],
  ];
  P.tube({
    bones: slices.map((s) => s[5]),
    pts: slices.map((s) => new THREE.Vector3(0, s[0], s[3])),
    r: slices.map((s) => s[1]),
    sz: slices.map((s) => s[2] * depth),
    n: slices.map((s) => s[4]),
    k: 0.005 * H,
  });

  // Belly wall. Without it the front of the torso is a plain ellipse and reads
  // as a barrel; a shallow forward mass gives the abdominal plane an edge.
  P.point('spine', [0, Y0 + 0.33 * T, waist * 0.52 * depth], waist * 0.68, {
    sy: 1.8,
    sz: 0.4,
    n: 2.6,
    k: 0.018 * H,
  });

  // Glutes. Sized off the hip width so the female silhouette gets them for free.
  P.point('hips', [hipW * 0.42, Y0 + 0.04 * T, -hipW * 0.42], hipW * (0.46 + 0.1 * fem), {
    sx: 0.95,
    sy: 0.85,
    sz: 0.78,
    k: 0.022 * H,
  });
  P.mirror(1);

  // Chest mass. One primitive family covers both readings: flat and high for a
  // pectoral, lower/rounder/deeper as `fem` rises.
  const armJointX = j.upperArmL.x;
  const pecY = Y0 + T * (0.745 - 0.025 * fem);
  const pecZ = chest * depth * (0.5 + 0.1 * fem);
  P.point('chest', [chest * (0.46 - 0.06 * fem), pecY, pecZ], chest * (0.37 + 0.04 * fem), {
    sx: 1.0,
    sy: 0.6 + 0.22 * fem,
    sz: 0.38 + 0.3 * fem,
    k: 0.024 * H,
  });
  P.mirror(1);

  // Clavicle. A thin ridge, but it is the landmark that tells a viewer where
  // the shoulder ends and the chest begins — without it a bare-chested fighter
  // reads as one soft mass from neck to armpit.
  P.seg(
    'shoulderL',
    [H * 0.012, m.neckBaseY - H * 0.026, chest * 0.52],
    [armJointX * 0.88, m.neckBaseY - H * 0.034, chest * 0.3],
    H * 0.011,
    H * 0.013,
    { sz: 0.55, k: 0.012 * H },
  );
  P.mirror(1);

  // Trapezius: the neck-to-shoulder slope. This is the single clearest read of
  // `build` in a front silhouette, so it is deliberately aggressive.
  const trapR = H * (0.009 + 0.013 * build) * (1 - 0.25 * fem);
  // Owned by the clavicle rather than the chest so a shrug actually shrugs.
  P.seg(
    'shoulderL',
    [H * 0.012, m.neckBaseY + H * 0.004, -H * 0.02],
    [armJointX * 0.8, m.neckBaseY - H * 0.026, -H * 0.008],
    trapR,
    trapR * 0.75,
    { sz: 0.85, k: 0.018 * H },
  );
  P.mirror(1);

  // Lats / serratus. Fills the armpit and cuts the V-taper into the flank.
  const latR = H * (0.011 + 0.02 * build);
  P.seg(
    'chest',
    [chest * 0.84, Y0 + 0.68 * T, -H * 0.024],
    [waist * 0.86, Y0 + 0.42 * T, -H * 0.006],
    latR,
    latR * 0.7,
    { sz: 0.8, k: 0.024 * H },
  );
  P.mirror(1);

  // --- Neck and head -------------------------------------------------------
  const headY = j.head.y;
  const hz = j.head.z;
  const HL = m.headLen;
  // A head is about 0.70 of its own height across and 0.88 deep; getting that
  // relationship wrong is the fastest way to make a stylised figure look wrong,
  // because every viewer knows heads.
  const HW = HL * 0.345 * (1 - 0.03 * fem);

  P.seg(
    'neck',
    [0, m.neckBaseY - H * 0.02, -H * 0.008],
    [0, headY + HL * 0.14, hz + HL * 0.02],
    m.neckR,
    m.neckR * 0.85,
    { sz: 0.95, n: 2.2, k: 0.018 * H },
  );

  // Cranium, then the back of the skull separately: a single ellipsoid gives an
  // egg, and the occiput is what makes a head read from behind and in profile.
  P.point('head', [0, headY + HL * 0.66, hz + HL * 0.02], HW, {
    sy: 1.03,
    sz: 1.22,
    n: 2.1,
    k: 0.012 * H,
  });
  P.point('head', [0, headY + HL * 0.56, hz - HL * 0.16], HW * 0.86, {
    sy: 0.88,
    sz: 0.86,
    k: 0.014 * H,
  });
  // Brow ridge, mid-face, cheekbones — the sockets appear between them.
  P.point('head', [0, headY + HL * 0.56, hz + HL * 0.22], HW * 0.84, {
    sy: 0.26,
    sz: 0.55,
    n: 2.4,
    k: 0.009 * H,
  });
  P.point('head', [0, headY + HL * 0.38, hz + HL * 0.12], HW * 0.82, {
    sy: 0.6,
    sz: 0.95,
    n: 2.3,
    k: 0.011 * H,
  });
  P.point('head', [HW * 0.6, headY + HL * 0.44, hz + HL * 0.1], HW * 0.34, {
    sy: 0.7,
    sz: 0.8,
    k: 0.011 * H,
  });
  P.mirror(1);
  // Jawline: angle of the jaw to the chin, one cone per side.
  P.seg(
    'head',
    [HW * 0.7, headY + HL * 0.32, hz - HL * 0.06],
    [HW * 0.12, headY + HL * 0.1, hz + HL * (0.3 - 0.02 * fem)],
    HL * (0.072 - 0.012 * fem),
    HL * (0.052 - 0.008 * fem),
    { k: 0.009 * H },
  );
  P.mirror(1);
  P.point('head', [0, headY + HL * 0.12, hz + HL * 0.3], HW * (0.3 - 0.04 * fem), {
    sy: 0.75,
    sz: 0.65,
    k: 0.009 * H,
  });
  // Nose. Small k so it stays a crisp wedge instead of melting into the face —
  // but not so small that the philtrum under it closes into a slot narrower
  // than a grid cell, which is a pinch and shows up as a non-manifold edge.
  P.seg(
    'head',
    [0, headY + HL * 0.55, hz + HL * 0.24],
    [0, headY + HL * 0.33, hz + HL * 0.4],
    HL * 0.032,
    HL * 0.048,
    { sx: 1.1, sz: 0.85, k: 0.007 * H },
  );
  // Lips, then ears flattened against the skull.
  P.point('head', [0, headY + HL * 0.225, hz + HL * 0.335], HW * 0.4, {
    sy: 0.3,
    sz: 0.38,
    k: 0.007 * H,
  });
  P.point('head', [HW * 0.97, headY + HL * 0.45, hz - HL * 0.04], HL * 0.1, {
    // Thin enough to read as an ear, thick enough that the mesher can see it:
    // at 0.28 the disc was under one grid cell and dropped out in patches.
    sx: 0.42,
    sy: 1.1,
    sz: 0.6,
    k: 0.004 * H,
  });
  P.mirror(1);

  // --- Limbs ---------------------------------------------------------------
  // Built once on the left and reflected, so the two sides can never drift.
  const beforeArm = P.prims.length;
  buildArm(P, m, j);
  P.mirror(P.prims.length - beforeArm);

  const beforeLeg = P.prims.length;
  buildLeg(P, m, j);
  P.mirror(P.prims.length - beforeLeg);

  return {
    prims: P.prims,
    metrics: m,
    joints: j,
    maxK: P.maxK,
    grid: buildPrimGrid(P.prims, H * 0.045),
  };
}

function buildArm(P: Plan, m: RigMetrics, j: JointMap): void {
  const H = m.height;
  const build = m.build;
  const shoulder = j.upperArmL;
  const elbow = j.forearmL;
  const wrist = j.handL;

  const lerp = (a: THREE.Vector3, b: THREE.Vector3, t: number) =>
    a.clone().lerp(b, t);

  // Deltoid cap. Big blend, because this is the one joint that must dissolve
  // into the torso; everything below it uses a tight blend so the arm never
  // webs to the ribcage when it hangs close.
  P.point('upperArmL', shoulder.clone().add(new THREE.Vector3(0, H * 0.002, 0)), m.deltoidR, {
    sx: 0.92,
    sy: 1.06,
    sz: 0.94,
    k: 0.03 * H,
  });

  const ua = m.upperArmR;
  const along = (a: THREE.Vector3, b: THREE.Vector3, n: number) =>
    Array.from({ length: n }, (_, i) => lerp(a, b, i / (n - 1)));
  P.tube({
    bones: ['upperArmL'],
    pts: along(shoulder, elbow, 5),
    r: [ua * 1.02, ua * 1.09, ua * 1.02, ua * 0.85, ua * 0.68],
    sz: [1.02, 1.16, 1.14, 1.06, 1.0],
    k: 0.005 * H,
  });
  // Triceps hang behind the humerus and are the reason a hanging arm is not a
  // cone; they also carry most of the `build` read from the side.
  P.point('upperArmL', lerp(shoulder, elbow, 0.44).add(new THREE.Vector3(0, 0, -ua * 0.48)), ua * (0.46 + 0.2 * build), {
    sy: 1.7,
    sz: 0.58,
    k: 0.013 * H,
  });

  // Olecranon. An elbow is a wider, bonier joint than the forearm below it, and
  // without a mass here the two limb tubes meet in a crease ring that the
  // mesher resolves as a non-manifold edge on the leanest fighter.
  P.point('forearmL', elbow, m.forearmR * 1.12, {
    sx: 1.0,
    sy: 1.1,
    sz: 1.05,
    k: 0.014 * H,
  });

  const fa = m.forearmR;
  P.tube({
    bones: ['forearmL'],
    pts: along(elbow, wrist, 5),
    r: [fa * 0.76, fa * 1.0, fa * 0.9, fa * 0.7, m.wristR],
    sz: [1.0, 1.0, 0.95, 0.88, 0.82],
    n: [2, 2, 2.1, 2.2, 2.2],
    k: 0.005 * H,
  });

  buildHand(P, m, elbow, wrist);
}

/**
 * The hand.
 *
 * Reviews 001 and 002 both called this out and both times it was answered with
 * a mitten and the argument that fingers are two pixels at gameplay size. Two
 * things are wrong with that argument. The hand is the *business end* of a
 * fighting game and it is where the eye goes, so it is the last thing that
 * should be under-modelled; and two pixels is a consequence of building the
 * hand at anatomical scale, which no fighting game does.
 *
 * So the hand is built ~15% oversized (`palmHalf` in `rigMetrics`) and out of
 * the four masses that actually make a hand read:
 *
 * - a **palm slab** that is a rounded box, not a cylinder — the flatness is
 *   what separates a hand from a paw;
 * - **knuckle heads** standing proud on the back of the hand at the metacarpal
 *   line, which is the break the fingers rotate about;
 * - **four fingers**, each in two segments with a bend at the middle joint, and
 *   fanned so the gaps open toward the tips. Near the knuckles they merge into
 *   one grooved mass — which is what a hand does — and only separate where a
 *   silhouette can show it;
 * - a **thumb** that leaves the palm at ~35° in plan and ~25° out of the palm
 *   plane, off a metacarpal that starts *inside* the hand. A thumb stuck on the
 *   side as one cone is the single loudest tell that a hand was not modelled.
 *
 * Everything is placed in a hand frame — `dir` down the hand, `across` along
 * the knuckles, `palmN` out of the palm — so the whole thing rotates with the
 * pronation roll and survives being posed into a fist, an open palm or a blade
 * hand without any of the masses needing to move relative to each other.
 */
function buildHand(P: Plan, m: RigMetrics, elbow: THREE.Vector3, wrist: THREE.Vector3): void {
  const H = m.height;
  const HL = m.handLen;
  const PW = m.palmHalf;
  const PT = m.palmThick;
  const FR = m.fingerR;

  const dir = wrist.clone().sub(elbow).normalize();
  const side = new THREE.Vector3(1, 0, 0).addScaledVector(dir, -dir.x).normalize();
  const front = new THREE.Vector3(0, 0, 1).addScaledVector(dir, -dir.z);
  front.addScaledVector(side, -front.dot(side)).normalize();

  // Pronation. A relaxed hanging hand does not present its back squarely to
  // the front: it rolls in by ~20°, which is what puts the thumb forward and
  // is most of the difference between a hand and a table-tennis bat.
  // Kept modest, and the reason is meshing as much as anatomy: `palmN` picks up
  // an X component as the roll grows, which fattens every finger along X — the
  // one axis the gaps between fingers are measured on. At 0.36 the fingers were
  // wider in X than the gaps between them were, and the mesher welded them.
  const roll = 0.2;
  const palmN = front
    .clone()
    .multiplyScalar(-Math.cos(roll))
    .addScaledVector(side, -Math.sin(roll))
    .normalize();
  const across = new THREE.Vector3().crossVectors(dir, palmN).normalize();
  // Handed to every primitive below as its local +Z, so `sz` means "thickness
  // through the palm" everywhere in this function regardless of how the arm is
  // rotated. Without it `sz` would mean "world front-to-back" and the hand
  // would flatten along the wrong axis the moment the roll was touched.
  const REF: [number, number, number] = [palmN.x, palmN.y, palmN.z];

  /** A point in the hand frame: `t` along the hand, `a` across it, `n` out of the palm. */
  const at = (t: number, a: number, n: number): THREE.Vector3 =>
    wrist
      .clone()
      .addScaledVector(dir, HL * t)
      .addScaledVector(across, a)
      .addScaledVector(palmN, n);

  // Palm slab. Widening from the wrist to the knuckle line and always thinner
  // than it is wide; `n` climbs toward 3 so the section is a rounded box.
  P.tube({
    bones: ['handL'],
    pts: [at(0, 0, 0), at(0.18, PW * 0.05, PT * 0.06), at(0.38, PW * 0.06, PT * 0.05), at(0.545, PW * 0.04, 0)],
    r: [m.wristR * 1.02, PW * 0.82, PW * 0.97, PW * 0.99],
    sz: [PT / (m.wristR * 1.02) * 0.98, (PT * 1.02) / (PW * 0.82), (PT * 1.0) / (PW * 0.97), (PT * 0.92) / (PW * 0.99)],
    n: [2.4, 2.9, 3.1, 3.1],
    ref: REF,
    k: 0.006 * H,
  });
  // Thenar and hypothenar — the two fleshy pads either side of the palm. They
  // are what give the palm an outline that is not a rectangle.
  P.point('handL', at(0.3, -PW * 0.5, PT * 0.42), PW * 0.42, {
    sx: 0.9, sy: 1.25, sz: 0.52, n: 2.4, k: 0.012 * H,
  });
  P.point('handL', at(0.34, PW * 0.6, PT * 0.3), PW * 0.34, {
    sx: 0.8, sy: 1.5, sz: 0.6, n: 2.4, k: 0.012 * H,
  });

  // Fingers. Index first, so index and thumb are both on the -across side.
  // Lengths and radii follow a real hand: middle longest, pinky shortest and
  // thinnest, and the knuckle line itself is an arc, not a straight edge.
  //
  // The fan is deliberately back-loaded. Fingers that diverge evenly from the
  // knuckle spend most of their length in the gap range that is wider than the
  // blend radius and narrower than a grid cell — which is exactly the range
  // that pinches, and pinches are non-manifold edges. Held together through the
  // proximal segment and then thrown apart through the distal one, the surface
  // is unambiguously one mass, then unambiguously four, and the crossing is
  // over in a few millimetres.
  const kx = [-0.735, -0.245, 0.245, 0.735];
  const tipx = [-1.24, -0.42, 0.47, 1.3];
  const len = [0.41, 0.455, 0.43, 0.375];
  const rad = [1.0, 1.02, 0.98, 0.92];
  // Knuckle t: the metacarpal heads are not level — index and pinky sit back.
  const kt = [0.5, 0.535, 0.52, 0.485];

  for (let f = 0; f < 4; f++) {
    const r0 = FR * rad[f];
    const a0 = PW * kx[f];
    const a1 = PW * tipx[f];
    const t0 = kt[f];
    const t2 = t0 + len[f];
    const t1 = t0 + len[f] * 0.5;

    // Knuckle head, proud on the back of the hand. This is the break the
    // review asked for and it is the thing that reads first in a fist.
    P.point('handL', at(t0 - 0.02, a0, -PT * 0.28), r0 * 1.12, {
      sx: 1.05, sy: 0.85, sz: 0.95, n: 2.3, k: 0.006 * H,
    });
    // Proximal segment, then the distal one bent into the palm at the middle
    // joint, which is what keeps a relaxed hand from reading as a rake.
    P.seg(
      'handL',
      at(t0, a0, -PT * 0.06),
      at(t1, THREE.MathUtils.lerp(a0, a1, 0.28), PT * 0.2),
      r0,
      r0 * 1.0,
      { sz: 1.24, n: 2.7, ref: REF, k: 0.005 * H },
    );
    P.seg(
      'handL',
      at(t1, THREE.MathUtils.lerp(a0, a1, 0.28), PT * 0.2),
      at(t2, a1, PT * 0.62),
      r0 * 0.92,
      r0 * 0.84,
      { sz: 1.22, n: 2.6, ref: REF, k: 0.003 * H },
    );
  }

  // Thumb. Metacarpal from inside the palm, then the two phalanges with a
  // break between them. The divergence angles are the point: ~35° in plan and
  // ~25° out of the palm plane at the metacarpal, opening further at the tip.
  // Note how far out of the palm plane the tip sits. It is not decoration:
  // brought back toward the fingers, the tip blends into the index and the web
  // between them closes into a ring, which turns the body into a genus-1
  // surface. A thumb has to be visibly *off* the hand, not beside it.
  //
  // Most of that separation is carried along `across` rather than along the
  // palm normal, and that is a meshing decision as much as an anatomical one:
  // `across` is very nearly the X axis, and X is the axis the mesher refines
  // around the hands. A thumb held forward instead of out would be separated
  // along Z, at the unrefined step, and would weld itself to the index finger.
  const tA = at(0.14, -PW * 0.4, PT * 0.36);
  const tB = at(0.42, -PW * 1.02, PT * 1.25);
  const tC = at(0.62, -PW * 1.26, PT * 1.8);
  const tD = at(0.76, -PW * 1.34, PT * 2.2);
  P.seg('handL', tA, tB, FR * 0.72, FR * 0.62, { sz: 1.25, n: 2.5, ref: REF, k: 0.007 * H });
  P.seg('handL', tB, tC, FR * 0.66, FR * 0.58, { sz: 1.35, n: 2.6, ref: REF, k: 0.004 * H });
  P.seg('handL', tC, tD, FR * 0.56, FR * 0.5, { sz: 1.4, n: 2.6, ref: REF, k: 0.0035 * H });
}

function buildLeg(P: Plan, m: RigMetrics, j: JointMap): void {
  const H = m.height;
  const build = m.build;
  const hip = j.thighL;
  const knee = j.shinL;
  const ankle = j.footL;
  const lerp = (a: THREE.Vector3, b: THREE.Vector3, t: number) => a.clone().lerp(b, t);

  const th = m.thighR;
  const along = (a: THREE.Vector3, b: THREE.Vector3, n: number) =>
    Array.from({ length: n }, (_, i) => lerp(a, b, i / (n - 1)));
  const hipTop = hip.clone().add(new THREE.Vector3(0, H * 0.025, 0));
  P.tube({
    bones: ['thighL'],
    pts: along(hipTop, knee, 5),
    r: [th * 0.97, th * 0.99, th * 0.9, th * 0.78, m.kneeR],
    sz: [0.92, 0.94, 0.95, 0.96, 0.98],
    n: [2.2, 2.2, 2.2, 2.2, 2.1],
    k: 0.006 * H,
  });
  // Quadriceps sweep: forward and slightly outboard, which is what gives a
  // strong fighter that teardrop above the knee in a front view.
  P.point('thighL', lerp(hip, knee, 0.62).add(new THREE.Vector3(th * 0.12, 0, th * 0.32)), th * (0.46 + 0.14 * build), {
    sy: 2.1,
    sz: 0.55,
    k: 0.018 * H,
  });
  P.point('thighL', lerp(hip, knee, 0.35).add(new THREE.Vector3(0, 0, -th * 0.4)), th * (0.44 + 0.12 * build), {
    sy: 2.2,
    sz: 0.55,
    k: 0.02 * H,
  });
  // Adductors. They run from high on the pubic ramus down the inside of the
  // thigh, and they reach *past* the midline so the two sides meet — which is
  // both what a standing figure does and what keeps the crotch a clean fused
  // join rather than a sub-grid gap the mesher has to guess at. The taper is
  // fast on purpose: the inner-leg contour is the line where they part, and a
  // slow taper puts that line somewhere vague near the knee.
  P.seg(
    'thighL',
    new THREE.Vector3(th * 0.2, hip.y - m.torsoLen * 0.1, -th * 0.06),
    lerp(hip, knee, 0.52).add(new THREE.Vector3(-th * 0.06, 0, th * 0.02)),
    th * 0.42,
    th * 0.27,
    { sz: 0.95, k: 0.026 * H },
  );

  P.tube({
    bones: ['shinL'],
    pts: along(knee, ankle, 5),
    r: [m.kneeR * 0.96, m.calfR * 0.94, m.calfR * 0.8, m.ankleR * 1.28, m.ankleR],
    sz: [1.0, 1.02, 1.05, 1.05, 1.0],
    n: [2.1, 2.1, 2.2, 2.2, 2.2],
    k: 0.006 * H,
  });
  // Gastrocnemius sits high and behind — the calf's peak is well above mid-shin.
  P.point('shinL', lerp(knee, ankle, 0.28).add(new THREE.Vector3(0, 0, -m.calfR * 0.4)), m.calfR * (0.6 + 0.16 * build), {
    sy: 1.9,
    sz: 0.68,
    k: 0.016 * H,
  });

  // Patella. A knee that is only a narrowing reads as a bend in a tube; the
  // kneecap is what makes the joint legible in a front silhouette.
  P.point('shinL', knee.clone().add(new THREE.Vector3(0, m.kneeR * 0.15, m.kneeR * 0.52)), m.kneeR * 0.62, {
    sx: 1.05,
    sy: 1.15,
    sz: 0.5,
    k: 0.007 * H,
  });

  buildFoot(P, m, ankle);
}

/**
 * The foot.
 *
 * What was here was a swept wedge with a flat sole from heel to tip, no ankle
 * narrowing and no toes — review 001 called it a ski tip and review 002 found
 * it unchanged. The four things it was missing are the four things that make a
 * foot read, and each of them is load-bearing for a different view:
 *
 * - the **ankle** is a narrowing between two masses. It only exists if the foot
 *   mass stops short of the shin's width, so the heel and the instep are sized
 *   against `ankleR` rather than against the foot length, and the two malleoli
 *   sit on it as bumps — medial high and forward, lateral low and back, which
 *   is the asymmetry every viewer knows without being able to name;
 * - the **arch** lifts the sole between heel and ball. It is the read that says
 *   a foot is bearing weight, and it is invisible from the front and obvious in
 *   profile — which is the view a fighting game spends most of its time in;
 * - the **heel** is a separate rounded mass behind and below the ankle, which
 *   is what stops the leg looking pushed into a slipper;
 * - the **toe break** is a step down in the profile at the ball of the foot,
 *   with the toes as their own masses below it. Without it the foot cannot roll
 *   through a step: there is no line for the sole to hinge about, so a walk
 *   cycle slides the whole wedge.
 *
 * Local +Z is world up for everything here, so `sz` reads as height, and each
 * centre is placed at its own half-height — which puts the sole on y = 0
 * exactly, for every fighter, without nudging the rig.
 */
function buildFoot(P: Plan, m: RigMetrics, ankle: THREE.Vector3): void {
  const H = m.height;
  const UP: [number, number, number] = [0, 1, 0];
  const FL = m.footLen;
  const HW = m.footHalf;
  const A = m.ankleY;
  const AR = m.ankleR;
  const az = ankle.z;
  const ax = ankle.x;
  // Toes point very slightly outboard — a stance with the feet turned out
  // 25° is a ballet position, not a fighting stance. Review 001 measured the
  // old feet as splayed; this is 4°.
  const tx = ax + FL * 0.035;

  // Heel: its own mass, behind and below the ankle.
  P.point('footL', new THREE.Vector3(ax, A * 0.62, az - FL * 0.185), m.heelR, {
    sx: 0.82,
    sy: (A * 0.62) / m.heelR,
    sz: 0.94,
    n: 2.4,
    k: 0.01 * H,
  });
  // Tarsus: the block the ankle sits on. Narrower than the ball of the foot,
  // which is what leaves the ankle a waist rather than a column.
  P.point('footL', new THREE.Vector3(ax, A * 0.66, az + FL * 0.02), AR * 1.16, {
    sx: 0.92,
    sy: (A * 0.66) / (AR * 1.16),
    sz: 1.5,
    n: 2.5,
    k: 0.012 * H,
  });

  // Malleoli. Small, but they are the whole reason an ankle reads as a joint.
  P.point('footL', new THREE.Vector3(ax - AR * 0.78, A * 1.12, az + FL * 0.012), AR * 0.4, {
    sx: 0.85, sy: 0.95, sz: 0.9, k: 0.006 * H,
  });
  P.point('footL', new THREE.Vector3(ax + AR * 0.86, A * 0.92, az - FL * 0.03), AR * 0.36, {
    sx: 0.85, sy: 0.95, sz: 0.9, k: 0.006 * H,
  });
  // Achilles: a flattened ridge running down the back of the ankle into the
  // heel. Cheap, and it is what fills the hollow either side of it.
  P.seg(
    'footL',
    new THREE.Vector3(ax, A * 2.05, az - FL * 0.135),
    new THREE.Vector3(ax, A * 0.8, az - FL * 0.17),
    AR * 0.62,
    AR * 0.95,
    // Deep rather than flat, and deliberately overlapping the tarsus in front
    // of it: run as a thin flap it is joined to the shin above and the heel
    // below but not to the block between, and those three joins close a ring
    // — a handle, on a surface that has to stay genus 0.
    { sx: 0.9, sz: 1.3, k: 0.014 * H },
  );

  // The body of the foot: heel to the ball, arched. Heights are fractions of
  // the ankle height, so the instep tops out just above the ankle joint on
  // every fighter and the foot never swallows the leg.
  const zs = [az - FL * 0.2, az - FL * 0.05, az + FL * 0.14, az + FL * 0.36, az + FL * 0.5];
  const rs = [HW * 0.74, HW * 0.8, HW * 0.83, HW * 1.0, HW * 0.99];
  // Half-heights, then converted to the tube's radius multiplier.
  const hh = [A * 0.6, A * 0.72, A * 0.55, A * 0.37, A * 0.29];
  // The arch: the sole lifts between heel and ball, and the mid-foot slides
  // outboard so the medial edge lifts further than the lateral one.
  const lift = [0, FL * 0.012, FL * 0.05, 0, 0];
  const dx = [0, 0, HW * 0.1, HW * 0.03, 0];
  P.tube({
    bones: ['footL', 'footL', 'footL', 'footL', 'toeL'],
    pts: zs.map((z, i) => new THREE.Vector3(
      THREE.MathUtils.lerp(ax, tx, i / (zs.length - 1)) + dx[i],
      hh[i] + lift[i],
      z,
    )),
    r: rs,
    sz: hh.map((h, i) => h / rs[i]),
    n: [2.5, 2.7, 2.9, 3.1, 3.2],
    ref: UP,
    k: 0.005 * H,
  });

  // Toes. Big toe distinct, the other four merged into a scalloped group —
  // which is what a toe reads as at 4 px, and is honest about it: five fully
  // separated toes at this scale is noise that the ink pass then draws.
  const toeA = [-0.58, -0.16, 0.12, 0.36, 0.56];
  const toeR = [0.33, 0.21, 0.195, 0.175, 0.15];
  const toeL = [1.0, 0.98, 0.92, 0.83, 0.7];
  const toeK = [0.005, 0.005, 0.005, 0.005, 0.005];
  const baseZ = az + FL * 0.44;
  for (let t = 0; t < 5; t++) {
    const r0 = HW * toeR[t];
    const r1 = r0 * 0.86;
    // Toes fan very slightly and the small ones curl down at the tip.
    const x0 = tx + HW * toeA[t] * 0.92;
    const x1 = tx + HW * toeA[t] * 1.08;
    const zEnd = baseZ + m.toeLen * toeL[t];
    const szT = t === 0 ? 0.92 : 0.8;
    P.seg(
      'toeL',
      new THREE.Vector3(x0, r0 * szT, baseZ - m.toeLen * 0.35),
      new THREE.Vector3(x1, r1 * szT * 0.94, zEnd),
      r0,
      r1,
      { sx: 0.94, sz: szT, n: 2.4, ref: UP, k: toeK[t] * H },
    );
  }
}

// ---------------------------------------------------------------------------
// Meshing
// ---------------------------------------------------------------------------

export interface BodyMeshOptions {
  /** Grid density multiplier. 1 lands at roughly 20k triangles for a 1.75 m rig. */
  density?: number;
  /** Relaxation passes after meshing. Two is enough; three is free insurance. */
  polish?: number;
}

interface Band {
  lo: number;
  hi: number;
  mul: number;
}

/**
 * A rectilinear axis whose samples bunch up inside the given bands.
 *
 * A uniform grid fine enough for a nose would be fine enough for a thigh, and
 * the thigh does not need it. Grading one axis at a time is nearly free: extra
 * samples along X only create extra quads on surfaces that face X, so refining
 * the head costs head triangles and almost nothing else.
 */
function gradedAxis(min: number, max: number, step: number, bands: Band[]): Float32Array {
  const feather = step * 3;
  const density = (x: number): number => {
    let mul = 1;
    for (const b of bands) {
      const t =
        THREE.MathUtils.smoothstep(x, b.lo - feather, b.lo) *
        (1 - THREE.MathUtils.smoothstep(x, b.hi, b.hi + feather));
      mul = Math.max(mul, 1 + (b.mul - 1) * t);
    }
    return mul;
  };
  const xs: number[] = [];
  let x = min;
  while (x < max - 1e-6) {
    xs.push(x);
    x += step / density(x);
  }
  // Absorb the leftover into the last two intervals rather than leaving a sliver.
  if (xs.length >= 2 && max - xs[xs.length - 1] < step * 0.45) xs.pop();
  xs.push(max);
  return Float32Array.from(xs);
}

interface RawMesh {
  pos: Float32Array;
  quads: Int32Array;
  count: number;
}

/** Central-difference gradient of the field. */
function fieldGradient(
  plan: BodyPlan,
  x: number,
  y: number,
  z: number,
  h: number,
  out: THREE.Vector3,
): void {
  out.set(
    fieldAt(plan, x + h, y, z) - fieldAt(plan, x - h, y, z),
    fieldAt(plan, x, y + h, z) - fieldAt(plan, x, y - h, z),
    fieldAt(plan, x, y, z + h) - fieldAt(plan, x, y, z - h),
  );
}

/** Corner offsets, indexed as di + 2*dj + 4*dk. */
const CORNER = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];
const EDGE = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

function surfaceNets(plan: BodyPlan, density: number): RawMesh {
  const { prims, metrics: m, joints: j } = plan;
  const H = m.height;
  const step = H / 54 / density;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of prims) {
    if (p.sub) continue;
    minX = Math.min(minX, p.cx - p.br); maxX = Math.max(maxX, p.cx + p.br);
    minY = Math.min(minY, p.cy - p.br); maxY = Math.max(maxY, p.cy + p.br);
    minZ = Math.min(minZ, p.cz - p.br); maxZ = Math.max(maxZ, p.cz + p.br);
  }
  const pad = step * 2.5;

  // Where the samples bunch up. Fingers and toes are an order of magnitude
  // smaller than a thigh and the uniform step that meshes a thigh cannot see
  // them at all — a 12 mm finger under a 25 mm grid is a bump, which is exactly
  // how the hand ended up a mitten twice.
  //
  // Grading one axis at a time is what makes this affordable: extra samples
  // along X create quads only on surfaces that face Y or Z, so refining a slab
  // that contains nothing but the two hands costs hand triangles. The hand
  // band is therefore keyed off the wrist joint and the palm width rather than
  // being a fixed fraction of height, so it tracks whatever the roster does.
  const wristX = j.handL.x;
  const handX0 = wristX - m.palmHalf * 1.55;
  const handX1 = wristX + m.palmHalf * 1.4;
  const fingerY = j.handL.y - m.handLen * 1.02;
  // The hand's own z slab: the palm is a 45 mm plate and the fingers are 20 mm
  // rods hanging off it, both of which sit inside a single unrefined cell.
  const handZ0 = j.handL.z - m.palmThick * 2.6;
  const handZ1 = j.handL.z + m.palmThick * 1.1;

  const xs = gradedAxis(minX - pad, maxX + pad, step, [
    { lo: -0.1 * H, hi: 0.1 * H, mul: 2.2 },
    { lo: handX0, hi: handX1, mul: 3.4 },
    { lo: -handX1, hi: -handX0, mul: 3.4 },
  ]);
  const ys = gradedAxis(minY - pad, maxY + pad, step, [
    { lo: m.neckBaseY - 0.02 * H, hi: H + 0.02 * H, mul: 2.6 },
    { lo: -0.02 * H, hi: m.ankleY * 1.5, mul: 2.2 },
    // Split in two: the fingers need the resolution, the palm does not, and
    // the palm half of the band is the half that also contains both thighs.
    { lo: fingerY, hi: j.handL.y - m.handLen * 0.4, mul: 2.15 },
    { lo: j.handL.y - m.handLen * 0.4, hi: j.handL.y + m.handLen * 0.12, mul: 1.25 },
  ]);
  const zs = gradedAxis(minZ - pad, maxZ + pad, step, [
    { lo: -0.01 * H, hi: 0.12 * H, mul: 1.5 },
    // Kept narrow deliberately: a z band is the most expensive kind, because
    // every surface anywhere in the slab pays for it, and this slab cuts
    // through the middle of the torso. Widened to the whole front of the body
    // it cost 4300 triangles; keyed to the hand it costs a third of that.
    { lo: handZ0, hi: handZ1, mul: 2.4 },
    // The toe break and the arch are both features along the length of the
    // foot, and the foot is the only thing this far forward and this low.
    { lo: j.footL.z + m.footLen * 0.2, hi: j.footL.z + m.footLen * 0.82, mul: 2.1 },
  ]);

  const nx = xs.length, ny = ys.length, nz = zs.length;
  const field = new Float32Array(nx * ny * nz).fill(FAR);
  const known = new Uint8Array(nx * ny * nz);
  const idx = (i: number, j: number, k: number) => (k * ny + j) * nx + i;

  // Coarse block cull. The field is 1-Lipschitz up to the smooth-min's small
  // overshoot, so a block whose centre is further from the surface than its own
  // radius cannot contain a crossing.
  const B = 4;
  const nbx = Math.ceil((nx - 1) / B), nby = Math.ceil((ny - 1) / B), nbz = Math.ceil((nz - 1) / B);
  const inactive: number[][] = [];
  const cand: number[] = [];

  for (let bz = 0; bz < nbz; bz++) {
    const k0 = bz * B, k1 = Math.min(k0 + B, nz - 1);
    for (let by = 0; by < nby; by++) {
      const j0 = by * B, j1 = Math.min(j0 + B, ny - 1);
      for (let bx = 0; bx < nbx; bx++) {
        const i0 = bx * B, i1 = Math.min(i0 + B, nx - 1);
        const cx = (xs[i0] + xs[i1]) * 0.5;
        const cy = (ys[j0] + ys[j1]) * 0.5;
        const cz = (zs[k0] + zs[k1]) * 0.5;
        const rad =
          0.5 *
          Math.sqrt(
            (xs[i1] - xs[i0]) ** 2 + (ys[j1] - ys[j0]) ** 2 + (zs[k1] - zs[k0]) ** 2,
          );

        cand.length = 0;
        for (let p = 0; p < prims.length; p++) {
          const pr = prims[p];
          const dx = cx - pr.cx, dy = cy - pr.cy, dz = cz - pr.cz;
          const reach = rad + pr.br + plan.maxK;
          if (dx * dx + dy * dy + dz * dz <= reach * reach) cand.push(p);
        }

        const dc = cand.length ? sampleField(prims, cx, cy, cz, cand) : FAR;
        if (Math.abs(dc) > rad * 1.35 + plan.maxK * 0.5) {
          inactive.push([i0, i1, j0, j1, k0, k1, dc < 0 ? -FAR : FAR]);
          continue;
        }
        const list = cand.slice();
        for (let k = k0; k <= k1; k++) {
          for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
              const o = idx(i, j, k);
              if (known[o]) continue;
              field[o] = sampleField(prims, xs[i], ys[j], zs[k], list);
              known[o] = 1;
            }
          }
        }
      }
    }
  }
  // Filled last so a corner shared with an active block keeps its real value.
  for (const [i0, i1, j0, j1, k0, k1, sentinel] of inactive) {
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const o = idx(i, j, k);
          if (!known[o]) {
            field[o] = sentinel;
            known[o] = 1;
          }
        }
  }

  // One vertex per cell that straddles the surface, placed at the centroid of
  // its edge crossings — the surface-nets dual, which gives quads instead of
  // marching-cubes slivers.
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cidx = (i: number, j: number, k: number) => (k * (ny - 1) + j) * (nx - 1) + i;
  const pos: number[] = [];
  const v = new Float32Array(8);

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const [di, dj, dk] = CORNER[c];
          const val = field[idx(i + di, j + dj, k + dk)];
          v[c] = val;
          if (val < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;

        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [ea, eb] of EDGE) {
          const va = v[ea], vb = v[eb];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          const ca = CORNER[ea], cb = CORNER[eb];
          sx += xs[i + ca[0]] + (xs[i + cb[0]] - xs[i + ca[0]]) * t;
          sy += ys[j + ca[1]] + (ys[j + cb[1]] - ys[j + ca[1]]) * t;
          sz += zs[k + ca[2]] + (zs[k + cb[2]] - zs[k + ca[2]]) * t;
          n++;
        }
        cellVert[cidx(i, j, k)] = pos.length / 3;
        pos.push(sx / n, sy / n, sz / n);
      }
    }
  }

  // Quads: one per grid edge that changes sign, spanning the four cells around it.
  const quads: number[] = [];
  const emit = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) quads.push(d, c, b, a);
    else quads.push(a, b, c, d);
  };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const here = field[idx(i, j, k)] < 0;
        if (i < nx - 1 && j > 0 && k > 0 && j < ny - 1 && k < nz - 1) {
          if (here !== field[idx(i + 1, j, k)] < 0) {
            emit(
              cellVert[cidx(i, j - 1, k - 1)],
              cellVert[cidx(i, j, k - 1)],
              cellVert[cidx(i, j, k)],
              cellVert[cidx(i, j - 1, k)],
              !here,
            );
          }
        }
        if (j < ny - 1 && i > 0 && k > 0 && i < nx - 1 && k < nz - 1) {
          if (here !== field[idx(i, j + 1, k)] < 0) {
            emit(
              cellVert[cidx(i - 1, j, k - 1)],
              cellVert[cidx(i - 1, j, k)],
              cellVert[cidx(i, j, k)],
              cellVert[cidx(i, j, k - 1)],
              !here,
            );
          }
        }
        if (k < nz - 1 && i > 0 && j > 0 && i < nx - 1 && j < ny - 1) {
          if (here !== field[idx(i, j, k + 1)] < 0) {
            emit(
              cellVert[cidx(i - 1, j - 1, k)],
              cellVert[cidx(i, j - 1, k)],
              cellVert[cidx(i, j, k)],
              cellVert[cidx(i - 1, j, k)],
              !here,
            );
          }
        }
      }
    }
  }

  return {
    pos: Float32Array.from(pos),
    quads: Int32Array.from(quads),
    count: pos.length / 3,
  };
}

/**
 * Even out the dual mesh and snap it back onto the exact surface.
 *
 * Surface nets alone leaves vertices wherever the cell edges happened to cross,
 * which reads as a faint quilted texture along the silhouette. Relaxing
 * tangentially and then projecting along the gradient removes that without
 * rounding off any real feature, because the projection is exact.
 */
function relax(plan: BodyPlan, mesh: RawMesh, passes: number, step: number): void {
  const n = mesh.count;
  const sum = new Float32Array(n * 3);
  const cnt = new Float32Array(n);
  const g = new THREE.Vector3();
  const h = step * 0.35;

  for (let pass = 0; pass < passes; pass++) {
    sum.fill(0);
    cnt.fill(0);
    for (let q = 0; q < mesh.quads.length; q += 4) {
      for (let e = 0; e < 4; e++) {
        const a = mesh.quads[q + e];
        const b = mesh.quads[q + ((e + 1) & 3)];
        sum[a * 3] += mesh.pos[b * 3];
        sum[a * 3 + 1] += mesh.pos[b * 3 + 1];
        sum[a * 3 + 2] += mesh.pos[b * 3 + 2];
        cnt[a]++;
        sum[b * 3] += mesh.pos[a * 3];
        sum[b * 3 + 1] += mesh.pos[a * 3 + 1];
        sum[b * 3 + 2] += mesh.pos[a * 3 + 2];
        cnt[b]++;
      }
    }
    for (let i = 0; i < n; i++) {
      if (cnt[i] === 0) continue;
      let x = mesh.pos[i * 3], y = mesh.pos[i * 3 + 1], z = mesh.pos[i * 3 + 2];
      // One gradient per vertex per pass: the tangential slide moves the point
      // along the surface, where the gradient barely turns, so re-measuring it
      // for the projection buys nothing and costs three more field samples.
      fieldGradient(plan, x, y, z, h, g);
      const gl = g.length();
      if (gl > 1e-6) {
        // Tangential component only: sliding along the surface is free, moving
        // off it is what the projection is for.
        let dx = sum[i * 3] / cnt[i] - x;
        let dy = sum[i * 3 + 1] / cnt[i] - y;
        let dz = sum[i * 3 + 2] / cnt[i] - z;
        const nx = g.x / gl, ny = g.y / gl, nz = g.z / gl;
        const dn = dx * nx + dy * ny + dz * nz;
        dx -= nx * dn; dy -= ny * dn; dz -= nz * dn;
        x += dx * 0.55; y += dy * 0.55; z += dz * 0.55;
      }
      // Newton step onto the zero level set. `fieldGradient` returns a raw
      // central difference over 2h, so the true gradient is g/(2h) and the step
      // works out as g * d * 2h / |g|^2.
      const d = fieldAt(plan, x, y, z);
      const g2 = g.lengthSq();
      if (g2 > 1e-12) {
        const f = THREE.MathUtils.clamp((d * 2 * h) / g2, -step / Math.sqrt(g2), step / Math.sqrt(g2));
        x -= g.x * f;
        y -= g.y * f;
        z -= g.z * f;
      }
      mesh.pos[i * 3] = x;
      mesh.pos[i * 3 + 1] = y;
      mesh.pos[i * 3 + 2] = z;
    }
  }
}

// ---------------------------------------------------------------------------
// Skinning
// ---------------------------------------------------------------------------

/** The line segment each bone deforms, used as the distance term for weighting. */
function boneSegments(m: RigMetrics, j: JointMap): Partial<Record<BoneName, number[]>> {
  const H = m.height;
  const seg = (a: THREE.Vector3, b: THREE.Vector3) => [a.x, a.y, a.z, b.x, b.y, b.z];
  const handDir = j.handL.clone().sub(j.forearmL).normalize();
  const handDirR = j.handR.clone().sub(j.forearmR).normalize();
  return {
    hips: seg(new THREE.Vector3(0, m.legLen - H * 0.05, 0), j.spine),
    spine: seg(j.spine, j.chest),
    chest: seg(j.chest, j.neck),
    neck: seg(j.neck, j.head),
    head: seg(j.head, j.head.clone().add(new THREE.Vector3(0, m.headLen * 0.75, 0))),
    shoulderL: seg(j.shoulderL, j.upperArmL),
    upperArmL: seg(j.upperArmL, j.forearmL),
    forearmL: seg(j.forearmL, j.handL),
    handL: seg(j.handL, j.handL.clone().addScaledVector(handDir, m.handLen * 0.8)),
    shoulderR: seg(j.shoulderR, j.upperArmR),
    upperArmR: seg(j.upperArmR, j.forearmR),
    forearmR: seg(j.forearmR, j.handR),
    handR: seg(j.handR, j.handR.clone().addScaledVector(handDirR, m.handLen * 0.8)),
    thighL: seg(j.thighL, j.shinL),
    shinL: seg(j.shinL, j.footL),
    footL: seg(j.footL, j.toeL),
    toeL: seg(j.toeL, j.toeL.clone().add(new THREE.Vector3(0, 0, m.footLen * 0.3))),
    thighR: seg(j.thighR, j.shinR),
    shinR: seg(j.shinR, j.footR),
    footR: seg(j.footR, j.toeR),
    toeR: seg(j.toeR, j.toeR.clone().add(new THREE.Vector3(0, 0, m.footLen * 0.3))),
  };
}

function distToSegment(s: number[], x: number, y: number, z: number): number {
  const ex = s[3] - s[0], ey = s[4] - s[1], ez = s[5] - s[2];
  const px = x - s[0], py = y - s[1], pz = z - s[2];
  const l2 = ex * ex + ey * ey + ez * ez;
  const t = l2 > 1e-12 ? THREE.MathUtils.clamp((px * ex + py * ey + pz * ez) / l2, 0, 1) : 0;
  const dx = px - ex * t, dy = py - ey * t, dz = pz - ez * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export interface SkinData {
  /** Four bone indices per vertex, into the skeleton's `BONES`-ordered array. */
  index: Uint16Array;
  weight: Float32Array;
}

/**
 * Skin weights.
 *
 * Two ideas, mixed. First, *ownership*: every vertex is claimed by the muscle
 * volume it is closest to, and that volume already knows which bone it belongs
 * to — so the deltoid goes to the upper arm and the trapezius to the clavicle,
 * which no distance function would ever work out on its own. Second, *distance*,
 * gated to bones within two hops of the owner so a hand hanging beside a thigh
 * cannot pick up leg weight.
 *
 * The mix is then diffused across the surface graph, which is what actually
 * makes elbows and knees bend instead of collapsing: the transition ends up
 * spread over a limb-radius' worth of mesh rather than snapping at one ring.
 *
 * `edges` is a flat list of vertex-index pairs; costume geometry can pass its
 * own so a vest deforms with exactly the weights the torso under it uses.
 */
export function computeSkinWeights(
  plan: BodyPlan,
  pos: ArrayLike<number>,
  count: number,
  edges: ArrayLike<number>,
): SkinData {
  const { prims, metrics: m, joints } = plan;
  const bones = BONES.filter((b) => b !== 'root');
  const NB = bones.length;
  const boneIndex = new Map<BoneName, number>(bones.map((b, i) => [b, i]));
  const segs = boneSegments(m, joints);
  const segList = bones.map((b) => segs[b] ?? null);

  // Which bones may influence a vertex owned by bone `s`.
  const gate = new Uint8Array(NB * NB);
  for (let a = 0; a < NB; a++)
    for (let b = 0; b < NB; b++)
      gate[a * NB + b] = boneDistance(bones[a], bones[b]) <= 2 ? 1 : 0;

  const n = count;
  let W = new Float32Array(n * NB);
  const eps = m.height * 0.012;

  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    let best = Infinity;
    let owner = 0;
    const bin = binAt(plan.grid, x, y, z);
    const near = bin.length ? bin : null;
    const count2 = near ? near.length : prims.length;
    for (let q = 0; q < count2; q++) {
      const p = prims[near ? near[q] : q];
      if (p.sub) continue;
      const d = primDistance(p, x, y, z);
      if (d < best) {
        best = d;
        owner = boneIndex.get(primBone(p, x, y, z)) ?? 0;
      }
    }
    const base = i * NB;
    let total = 0;
    for (let b = 0; b < NB; b++) {
      if (!gate[owner * NB + b]) continue;
      const s = segList[b];
      if (!s) continue;
      const d = distToSegment(s, x, y, z);
      const w = 1 / (d + eps) ** 4;
      W[base + b] = w;
      total += w;
    }
    if (total > 0) for (let b = 0; b < NB; b++) W[base + b] /= total;
    W[base + owner] += 0.9;
  }

  // Diffuse along the surface. Weight travels over the mesh, never through
  // space, so the arm cannot bleed onto the ribs it is resting against.
  const cnt = new Float32Array(n);
  for (let e = 0; e < edges.length; e += 2) {
    cnt[edges[e]]++;
    cnt[edges[e + 1]]++;
  }
  let next = new Float32Array(n * NB);
  for (let pass = 0; pass < 14; pass++) {
    next.set(W);
    for (let e = 0; e < edges.length; e += 2) {
      const a = edges[e];
      const b = edges[e + 1];
      const ca = 0.85 / Math.max(1, cnt[a]);
      const cb = 0.85 / Math.max(1, cnt[b]);
      for (let t = 0; t < NB; t++) {
        next[a * NB + t] += W[b * NB + t] * ca;
        next[b * NB + t] += W[a * NB + t] * cb;
      }
    }
    const swap = W;
    W = next;
    next = swap;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let t = 0; t < NB; t++) s += W[i * NB + t];
      if (s > 0) for (let t = 0; t < NB; t++) W[i * NB + t] /= s;
    }
  }

  // Down to four influences, which is what the GPU skinning path takes.
  const index = new Uint16Array(n * 4);
  const weight = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const base = i * NB;
    const top = [-1, -1, -1, -1];
    const val = [0, 0, 0, 0];
    for (let b = 0; b < NB; b++) {
      const w = W[base + b];
      if (w <= val[3]) continue;
      let s = 3;
      while (s > 0 && w > val[s - 1]) {
        val[s] = val[s - 1];
        top[s] = top[s - 1];
        s--;
      }
      val[s] = w;
      top[s] = b;
    }
    let sum = val[0] + val[1] + val[2] + val[3];
    if (sum <= 0) {
      top[0] = boneIndex.get('hips')!;
      val[0] = 1;
      sum = 1;
    }
    for (let s = 0; s < 4; s++) {
      // Bone indices are into the skeleton's bone array, which is BONES order —
      // one ahead of ours, since we dropped `root`.
      index[i * 4 + s] = top[s] < 0 ? 0 : top[s] + 1;
      weight[i * 4 + s] = top[s] < 0 ? 0 : val[s] / sum;
    }
  }
  return { index, weight };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface BuiltBody {
  geometry: THREE.BufferGeometry;
  triangles: number;
}

export function buildBodyGeometry(plan: BodyPlan, opts: BodyMeshOptions = {}): BuiltBody {
  const density = opts.density ?? 1;
  const step = plan.metrics.height / 100 / density;
  const mesh = surfaceNets(plan, density);
  relax(plan, mesh, opts.polish ?? 4, step);

  const edges = new Int32Array(mesh.quads.length * 2);
  for (let q = 0, e = 0; q < mesh.quads.length; q += 4) {
    for (let s = 0; s < 4; s++) {
      edges[e++] = mesh.quads[q + s];
      edges[e++] = mesh.quads[q + ((s + 1) & 3)];
    }
  }
  const skin = computeSkinWeights(plan, mesh.pos, mesh.count, edges);

  const n = mesh.count;
  const H = plan.metrics.height;
  const g = new THREE.Vector3();
  const pos: number[] = Array.from(mesh.pos);
  const nrm: number[] = new Array(n * 3);
  const uv: number[] = new Array(n * 2);
  const si: number[] = Array.from(skin.index);
  const sw: number[] = Array.from(skin.weight);

  for (let i = 0; i < n; i++) {
    const x = mesh.pos[i * 3], y = mesh.pos[i * 3 + 1], z = mesh.pos[i * 3 + 2];
    fieldGradient(plan, x, y, z, step * 0.3, g);
    if (g.lengthSq() < 1e-16) g.set(0, 1, 0);
    g.normalize();
    nrm[i * 3] = g.x; nrm[i * 3 + 1] = g.y; nrm[i * 3 + 2] = g.z;
    // Cylindrical unwrap with the seam down the spine. Good enough for gradients
    // and masks; anything with real detail should be sampled triplanar off the
    // world position instead.
    uv[i * 2] = 0.5 + Math.atan2(x, z) / (Math.PI * 2);
    uv[i * 2 + 1] = y / H;
  }

  // Split the wrap seam so a quad never spans u = 1 -> 0.
  const dup = new Map<number, number>();
  const seamCopy = (v: number): number => {
    const cached = dup.get(v);
    if (cached !== undefined) return cached;
    const j = pos.length / 3;
    pos.push(mesh.pos[v * 3], mesh.pos[v * 3 + 1], mesh.pos[v * 3 + 2]);
    nrm.push(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
    uv.push(uv[v * 2] + 1, uv[v * 2 + 1]);
    for (let s = 0; s < 4; s++) {
      si.push(si[v * 4 + s]);
      sw.push(sw[v * 4 + s]);
    }
    dup.set(v, j);
    return j;
  };

  const tris: number[] = [];
  const quad = [0, 0, 0, 0];
  for (let q = 0; q < mesh.quads.length; q += 4) {
    let lo = 2, hi = -1;
    for (let e = 0; e < 4; e++) {
      const u = uv[mesh.quads[q + e] * 2];
      lo = Math.min(lo, u);
      hi = Math.max(hi, u);
    }
    const split = hi - lo > 0.5;
    for (let e = 0; e < 4; e++) {
      const v = mesh.quads[q + e];
      quad[e] = split && uv[v * 2] < 0.5 ? seamCopy(v) : v;
    }
    // Split along the shorter diagonal; the dual mesh's quads are not planar.
    const d02 =
      (pos[quad[0] * 3] - pos[quad[2] * 3]) ** 2 +
      (pos[quad[0] * 3 + 1] - pos[quad[2] * 3 + 1]) ** 2 +
      (pos[quad[0] * 3 + 2] - pos[quad[2] * 3 + 2]) ** 2;
    const d13 =
      (pos[quad[1] * 3] - pos[quad[3] * 3]) ** 2 +
      (pos[quad[1] * 3 + 1] - pos[quad[3] * 3 + 1]) ** 2 +
      (pos[quad[1] * 3 + 2] - pos[quad[3] * 3 + 2]) ** 2;
    if (d02 <= d13) tris.push(quad[0], quad[1], quad[2], quad[0], quad[2], quad[3]);
    else tris.push(quad[1], quad[2], quad[3], quad[1], quad[3], quad[0]);
  }

  // The dual's face orientation depends on a sign convention that is easy to get
  // backwards and impossible to see until the ink outline inverts, so settle it
  // by measurement against the analytic normal rather than by argument.
  let agree = 0;
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const fn = new THREE.Vector3();
  const samples = Math.min(tris.length / 3, 240);
  for (let s = 0; s < samples; s++) {
    const t = Math.floor((s / samples) * (tris.length / 3)) * 3;
    const a = tris[t], b = tris[t + 1], c = tris[t + 2];
    ab.set(pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2]);
    ac.set(pos[c * 3] - pos[a * 3], pos[c * 3 + 1] - pos[a * 3 + 1], pos[c * 3 + 2] - pos[a * 3 + 2]);
    fn.crossVectors(ab, ac);
    agree += fn.x * nrm[a * 3] + fn.y * nrm[a * 3 + 1] + fn.z * nrm[a * 3 + 2] > 0 ? 1 : -1;
  }
  if (agree < 0) {
    for (let t = 0; t < tris.length; t += 3) {
      const tmp = tris[t + 1];
      tris[t + 1] = tris[t + 2];
      tris[t + 2] = tmp;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  geometry.setIndex(tris);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  return { geometry, triangles: tris.length / 3 };
}

/**
 * Skins arbitrary geometry to the same body plan.
 *
 * Costume pieces are modelled in rest space over the body and need to deform
 * with it exactly; running them through the body's own weighting is the only
 * way a vest edge does not slide off the ribs it is sitting on.
 */
export function skinGeometry(plan: BodyPlan, geometry: THREE.BufferGeometry): void {
  const posAttr = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = posAttr.count;
  const pos = posAttr.array as ArrayLike<number>;

  const edges: number[] = [];
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
      edges.push(a, b, b, c, c, a);
    }
  }
  const skin = computeSkinWeights(plan, pos, count, edges);
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skin.index, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skin.weight, 4));
}
