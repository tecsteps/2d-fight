/**
 * Seamless noise kit — the foundation every generator in this directory stands on.
 *
 * Two constraints shape the whole API.
 *
 * **It has to tile.** A fighter's gi is a handful of UV islands sampled at
 * arbitrary scales and a stage wall repeats twenty times across the shot; one
 * visible seam is a visible seam sixty times a second. So the kit is defined in
 * *tile space*: `u` and `v` run 0..1 across the tile and every function is
 * exactly periodic on that interval. Lattice noises wrap their integer cells.
 * Simplex has no lattice to wrap, so its 2D form here is a slice of 4D simplex
 * taken around a torus — seamless by construction, and it keeps simplex's
 * freedom from the axis-aligned artifacts that give Perlin away on a flat wall.
 *
 * **It has to be deterministic.** Textures are generated at load from a seed,
 * never loaded, so two runs must produce byte-identical maps or the screenshot
 * harness can't diff frames. Nothing here touches `Math.random()`.
 *
 * `freq` always means "features across the tile". For the lattice noises it is
 * rounded to an integer because that integer *is* the wrap period.
 */

const F4 = (Math.sqrt(5) - 1) / 4;
const G4 = (5 - Math.sqrt(5)) / 20;
const TAU = Math.PI * 2;

/** Unit gradients for 2D lattice noise. Eight directions is plenty once fBm stacks them. */
const GRAD2 = new Float32Array([
  1, 0, -1, 0, 0, 1, 0, -1,
  0.70710678, 0.70710678, -0.70710678, 0.70710678,
  0.70710678, -0.70710678, -0.70710678, -0.70710678,
]);

/**
 * The 32 vertices of the 24-cell used by 4D simplex, as a flat array.
 * Every vector has one zero component and three ±1s.
 */
const GRAD4 = new Int8Array([
  0, 1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1,
  0, -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1,
  1, 0, 1, 1, 1, 0, 1, -1, 1, 0, -1, 1, 1, 0, -1, -1,
  -1, 0, 1, 1, -1, 0, 1, -1, -1, 0, -1, 1, -1, 0, -1, -1,
  1, 1, 0, 1, 1, 1, 0, -1, 1, -1, 0, 1, 1, -1, 0, -1,
  -1, 1, 0, 1, -1, 1, 0, -1, -1, -1, 0, 1, -1, -1, 0, -1,
  1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1, 0,
  -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1, 0,
]);

function floorFast(x: number): number {
  const i = x | 0;
  return x < i ? i - 1 : i;
}

/** Quintic fade. Cubic leaves second-derivative creases that show up in normal maps. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Positive modulo — cell indices go negative near the tile origin. */
function wrap(i: number, n: number): number {
  return ((i % n) + n) % n;
}

export type NoiseKind = 'value' | 'perlin' | 'simplex';

export interface FbmOptions {
  /** Features across the tile at the base octave. */
  freq?: number;
  octaves?: number;
  /** Amplitude multiplier per octave. */
  gain?: number;
  /** Frequency multiplier per octave. Keep integral so the wrap survives. */
  lacunarity?: number;
  kind?: NoiseKind;
  /** Absolute-value inverted octaves: sharp creases, for cracks and grain. */
  ridged?: boolean;
  /** Absolute-value octaves: puffy blobs, for clouds and stains. */
  billow?: boolean;
  /**
   * Decorrelates two fields sampled at the same frequency. Two calls with the
   * same layer give the same field — that is the point, it is not a seed.
   */
  layer?: number;
}

export interface WorleyResult {
  /** Distance to the nearest feature point, in cell units. */
  f1: number;
  /** Distance to the second nearest. `f2 - f1` is the cell-boundary distance. */
  f2: number;
  /** Stable 0..1 id of the nearest cell, for per-cell colour and rotation. */
  id: number;
  /** Direction from the sample to the nearest point, in tile units. */
  dx: number;
  dy: number;
}

export type WorleyMetric = 'euclidean' | 'manhattan' | 'chebyshev';

export interface WorleyOptions {
  /** 0 = a perfect grid, 1 = fully scattered points. */
  jitter?: number;
  metric?: WorleyMetric;
  layer?: number;
}

const _worley: WorleyResult = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };

export class Noise {
  private readonly perm = new Uint8Array(512);

  constructor(seed = 0x1a2b3c) {
    // SplitMix32, matching the expansion in core/RNG so seeds behave the same
    // way here as they do in the simulation.
    let z = seed >>> 0;
    const next = (): number => {
      z = (z + 0x9e3779b9) >>> 0;
      let t = z;
      t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
      t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
      return (t ^ (t >>> 15)) >>> 0;
    };
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = next() % (i + 1);
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  /** Hash of a wrapped 2D cell plus a layer selector. Returns 0..255. */
  private h2(ix: number, iy: number, layer: number): number {
    const p = this.perm;
    return p[(p[(ix + p[layer & 255]) & 255] + iy) & 255];
  }

  /** Deterministic 0..1 from a cell. */
  private r2(ix: number, iy: number, layer: number, salt: number): number {
    const p = this.perm;
    return p[(this.h2(ix, iy, layer) + p[salt & 255]) & 255] / 255;
  }

  /**
   * Stable 0..1 per integer cell. Threads, planks, bricks and quilt panels all
   * need "give me this one's dye lot" without another noise evaluation.
   */
  rand(ix: number, iy: number, layer = 0): number {
    return this.r2(ix & 255, iy & 255, layer, 23);
  }

  // -- primitives ----------------------------------------------------------

  /** Bilinear value noise. Blockiest of the three; useful when you want tooth. */
  value(u: number, v: number, freq: number, layer = 0): number {
    const n = Math.max(1, Math.round(freq));
    const x = u * n;
    const y = v * n;
    const ix = floorFast(x);
    const iy = floorFast(y);
    const fx = fade(x - ix);
    const fy = fade(y - iy);
    const x0 = wrap(ix, n);
    const y0 = wrap(iy, n);
    const x1 = wrap(ix + 1, n);
    const y1 = wrap(iy + 1, n);
    const a = this.h2(x0, y0, layer) / 255;
    const b = this.h2(x1, y0, layer) / 255;
    const c = this.h2(x0, y1, layer) / 255;
    const d = this.h2(x1, y1, layer) / 255;
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fy) * 2 - 1;
  }

  /** Periodic gradient (Perlin) noise. The workhorse: cheap and smooth. */
  perlin(u: number, v: number, freq: number, layer = 0): number {
    const n = Math.max(1, Math.round(freq));
    const x = u * n;
    const y = v * n;
    const ix = floorFast(x);
    const iy = floorFast(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fade(fx);
    const sy = fade(fy);
    const x0 = wrap(ix, n);
    const y0 = wrap(iy, n);
    const x1 = wrap(ix + 1, n);
    const y1 = wrap(iy + 1, n);

    const g = (cx: number, cy: number, dx: number, dy: number): number => {
      const gi = (this.h2(cx, cy, layer) & 7) * 2;
      return GRAD2[gi] * dx + GRAD2[gi + 1] * dy;
    };

    const n00 = g(x0, y0, fx, fy);
    const n10 = g(x1, y0, fx - 1, fy);
    const n01 = g(x0, y1, fx, fy - 1);
    const n11 = g(x1, y1, fx - 1, fy - 1);
    return lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy) * 1.4142;
  }

  /**
   * Seamless 2D simplex: the unit tile is wrapped onto a torus in 4D and the
   * noise is evaluated there. Costs about four times a Perlin tap, so it is
   * reserved for the low-frequency layers where Perlin's grid would show —
   * dye mottling, stains, subdermal colour.
   */
  simplex(u: number, v: number, freq: number, layer = 0): number {
    const r = Math.max(0.5, freq) / TAU;
    const a = u * TAU;
    const b = v * TAU;
    const o = layer * 31.7;
    return this.simplex4(o + r * Math.cos(a), o + r * Math.sin(a), o + r * Math.cos(b), o + r * Math.sin(b));
  }

  /** 4D simplex, Gustavson/Eastman rank ordering. Output is roughly -1..1. */
  simplex4(x: number, y: number, z: number, w: number): number {
    const p = this.perm;
    const s = (x + y + z + w) * F4;
    const i = floorFast(x + s);
    const j = floorFast(y + s);
    const k = floorFast(z + s);
    const l = floorFast(w + s);
    const t = (i + j + k + l) * G4;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);
    const w0 = w - (l - t);

    // Rank the four coordinates; the ranking gives the simplex corner order
    // without the 64-entry lookup table the original paper used.
    let rx = 0;
    let ry = 0;
    let rz = 0;
    let rw = 0;
    if (x0 > y0) rx++; else ry++;
    if (x0 > z0) rx++; else rz++;
    if (x0 > w0) rx++; else rw++;
    if (y0 > z0) ry++; else rz++;
    if (y0 > w0) ry++; else rw++;
    if (z0 > w0) rz++; else rw++;

    const i1 = rx >= 3 ? 1 : 0;
    const j1 = ry >= 3 ? 1 : 0;
    const k1 = rz >= 3 ? 1 : 0;
    const l1 = rw >= 3 ? 1 : 0;
    const i2 = rx >= 2 ? 1 : 0;
    const j2 = ry >= 2 ? 1 : 0;
    const k2 = rz >= 2 ? 1 : 0;
    const l2 = rw >= 2 ? 1 : 0;
    const i3 = rx >= 1 ? 1 : 0;
    const j3 = ry >= 1 ? 1 : 0;
    const k3 = rz >= 1 ? 1 : 0;
    const l3 = rw >= 1 ? 1 : 0;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    const ll = l & 255;

    let n = 0;
    const corner = (
      dx: number, dy: number, dz: number, dw: number,
      oi: number, oj: number, ok: number, ol: number,
    ): void => {
      const tt = 0.6 - dx * dx - dy * dy - dz * dz - dw * dw;
      if (tt <= 0) return;
      const gi = (p[(ii + oi + p[(jj + oj + p[(kk + ok + p[(ll + ol) & 255]) & 255]) & 255]) & 255] % 32) * 4;
      const t2 = tt * tt;
      n += t2 * t2 * (GRAD4[gi] * dx + GRAD4[gi + 1] * dy + GRAD4[gi + 2] * dz + GRAD4[gi + 3] * dw);
    };

    corner(x0, y0, z0, w0, 0, 0, 0, 0);
    corner(x0 - i1 + G4, y0 - j1 + G4, z0 - k1 + G4, w0 - l1 + G4, i1, j1, k1, l1);
    corner(x0 - i2 + 2 * G4, y0 - j2 + 2 * G4, z0 - k2 + 2 * G4, w0 - l2 + 2 * G4, i2, j2, k2, l2);
    corner(x0 - i3 + 3 * G4, y0 - j3 + 3 * G4, z0 - k3 + 3 * G4, w0 - l3 + 3 * G4, i3, j3, k3, l3);
    corner(x0 - 1 + 4 * G4, y0 - 1 + 4 * G4, z0 - 1 + 4 * G4, w0 - 1 + 4 * G4, 1, 1, 1, 1);
    return 27 * n;
  }

  /**
   * Cellular / Worley noise on a wrapped grid.
   *
   * The result object is reused between calls — read what you need before the
   * next call. Generation is a single synchronous pass, so this saves a few
   * hundred thousand allocations per texture.
   */
  worley(u: number, v: number, freq: number, opts: WorleyOptions = {}): Readonly<WorleyResult> {
    const n = Math.max(1, Math.round(freq));
    const jitter = opts.jitter ?? 1;
    const layer = opts.layer ?? 0;
    const metric = opts.metric ?? 'euclidean';
    const x = u * n;
    const y = v * n;
    const cx = floorFast(x);
    const cy = floorFast(y);

    let f1 = 1e9;
    let f2 = 1e9;
    let id = 0;
    let bx = 0;
    let by = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const gx = cx + ox;
        const gy = cy + oy;
        const wx = wrap(gx, n);
        const wy = wrap(gy, n);
        const px = gx + 0.5 + (this.r2(wx, wy, layer, 11) - 0.5) * jitter;
        const py = gy + 0.5 + (this.r2(wx, wy, layer, 47) - 0.5) * jitter;
        const dx = px - x;
        const dy = py - y;
        let d: number;
        if (metric === 'manhattan') d = Math.abs(dx) + Math.abs(dy);
        else if (metric === 'chebyshev') d = Math.max(Math.abs(dx), Math.abs(dy));
        else d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) {
          f2 = f1;
          f1 = d;
          id = this.r2(wx, wy, layer, 101);
          bx = dx / n;
          by = dy / n;
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
    _worley.f1 = f1;
    _worley.f2 = f2;
    _worley.id = id;
    _worley.dx = bx;
    _worley.dy = by;
    return _worley;
  }

  /** Distance to the nearest feature point, 0..~1. */
  worleyF1(u: number, v: number, freq: number, opts?: WorleyOptions): number {
    return this.worley(u, v, freq, opts).f1;
  }

  /**
   * Cell-boundary proximity: 1 on a boundary, 0 deep inside a cell. This is the
   * shape behind cracked asphalt, leather grain and the furrow network in skin.
   */
  worleyEdge(u: number, v: number, freq: number, opts?: WorleyOptions): number {
    const w = this.worley(u, v, freq, opts);
    return 1 - Math.min(1, w.f2 - w.f1);
  }

  // -- composites ----------------------------------------------------------

  /** Fractal sum. Returns -1..1, or 0..1 when ridged or billow is set. */
  fbm(u: number, v: number, opts: FbmOptions = {}): number {
    const freq = opts.freq ?? 4;
    const octaves = Math.max(1, Math.round(opts.octaves ?? 4));
    const gain = opts.gain ?? 0.5;
    const lac = opts.lacunarity ?? 2;
    const kind = opts.kind ?? 'perlin';
    const layer = opts.layer ?? 0;

    let sum = 0;
    let norm = 0;
    let amp = 1;
    let f = freq;
    for (let o = 0; o < octaves; o++) {
      let s: number;
      if (kind === 'simplex') s = this.simplex(u, v, f, layer + o * 7);
      else if (kind === 'value') s = this.value(u, v, f, layer + o * 7);
      else s = this.perlin(u, v, f, layer + o * 7);
      if (opts.ridged) s = 1 - Math.abs(s);
      else if (opts.billow) s = Math.abs(s);
      sum += s * amp;
      norm += amp;
      amp *= gain;
      f *= lac;
    }
    return sum / norm;
  }

  /**
   * Domain warp: pushes the sample point around with a low-frequency field
   * before the real noise is evaluated.
   *
   * This is what turns obviously-synthetic bands into wood grain, marble and
   * weathering streaks. Both the warp and the field being warped are periodic
   * on the tile, so the composition still tiles exactly.
   *
   * Writes into `out` and returns it.
   */
  warp(u: number, v: number, amp: number, opts: FbmOptions = {}, out: [number, number] = [0, 0]): [number, number] {
    const layer = opts.layer ?? 0;
    out[0] = u + amp * this.fbm(u, v, { ...opts, layer });
    out[1] = v + amp * this.fbm(u, v, { ...opts, layer: layer + 131 });
    return out;
  }

  /**
   * Curl of a periodic scalar potential — a divergence-free flow field.
   *
   * Used for fibres, brushed metal and smoke-like staining, where a plain
   * gradient would produce sources and sinks the eye reads as blobs.
   */
  curl(u: number, v: number, opts: FbmOptions = {}, out: [number, number] = [0, 0]): [number, number] {
    const e = 1 / 512;
    const px = this.fbm(u + e, v, opts) - this.fbm(u - e, v, opts);
    const py = this.fbm(u, v + e, opts) - this.fbm(u, v - e, opts);
    const inv = 1 / (2 * e);
    out[0] = py * inv;
    out[1] = -px * inv;
    const len = Math.hypot(out[0], out[1]) || 1;
    out[0] /= len;
    out[1] /= len;
    return out;
  }
}

const instances = new Map<number, Noise>();

/** Shared, seeded noise instance. Building the permutation table is not free. */
export function noise(seed = 0x1a2b3c): Noise {
  let n = instances.get(seed);
  if (!n) {
    n = new Noise(seed);
    instances.set(seed, n);
  }
  return n;
}

// -- small shaping helpers ---------------------------------------------------

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Smoothstep that also flattens the *third* derivative — no Mach banding in a normal map. */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Signed distance to the nearest repeat of a line grid, in tile units. */
export function stripeDistance(t: number, period: number): number {
  const p = t / period;
  const f = p - Math.floor(p);
  return Math.min(f, 1 - f) * period;
}

/**
 * Triangle wave 0..1..0 with period 1. The workhorse for thread and rib
 * profiles: it never introduces a discontinuity, so it cannot seam.
 */
export function tri(t: number): number {
  const f = t - Math.floor(t);
  return f < 0.5 ? f * 2 : 2 - f * 2;
}
