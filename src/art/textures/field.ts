import * as THREE from 'three';
import { clamp01, mix } from './noise';

/**
 * CPU raster buffers used to author a texture before it becomes a GPU texture.
 *
 * Every generator here builds up one or more **height/mask** fields and one
 * **colour** field, then converts. Working in float and converting once at the
 * end matters: a normal map derived from an already-quantised 8-bit height is
 * full of terraces, and terraces on a fighter's cloth catch the specular in
 * horizontal bands that look like corrugated iron.
 *
 * Addressing wraps in both axes — everything in this directory tiles, so a
 * filter that clamps at the border would build the seam back in at the last
 * step.
 *
 * Row 0 is v = 0. Three's `DataTexture` uploads bottom-up and UV origin is
 * bottom-left, so y increasing means v increasing, which is also the direction
 * the OpenGL-convention green channel of a normal map points.
 */
export class Field {
  readonly size: number;
  readonly data: Float32Array;

  constructor(size: number, fill = 0) {
    this.size = size;
    this.data = new Float32Array(size * size);
    if (fill !== 0) this.data.fill(fill);
  }

  /** Fill from a callback over normalised tile coordinates. */
  static from(size: number, fn: (u: number, v: number, x: number, y: number) => number): Field {
    const f = new Field(size);
    const inv = 1 / size;
    let i = 0;
    for (let y = 0; y < size; y++) {
      const v = (y + 0.5) * inv;
      for (let x = 0; x < size; x++, i++) {
        f.data[i] = fn((x + 0.5) * inv, v, x, y);
      }
    }
    return f;
  }

  get(x: number, y: number): number {
    const n = this.size;
    const xi = ((x % n) + n) % n;
    const yi = ((y % n) + n) % n;
    return this.data[yi * n + xi];
  }

  set(x: number, y: number, value: number): void {
    this.data[y * this.size + x] = value;
  }

  /** Bilinear tap in tile coordinates. Wraps. */
  sample(u: number, v: number): number {
    const n = this.size;
    const x = u * n - 0.5;
    const y = v * n - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const a = this.get(x0, y0);
    const b = this.get(x0 + 1, y0);
    const c = this.get(x0 + 1, y0 + 1);
    const d = this.get(x0, y0 + 1);
    return mix(mix(a, b, fx), mix(d, c, fx), fy);
  }

  forEach(fn: (value: number, x: number, y: number, u: number, v: number) => void): this {
    const n = this.size;
    const inv = 1 / n;
    let i = 0;
    for (let y = 0; y < n; y++) {
      const v = (y + 0.5) * inv;
      for (let x = 0; x < n; x++, i++) fn(this.data[i], x, y, (x + 0.5) * inv, v);
    }
    return this;
  }

  map(fn: (value: number, x: number, y: number, u: number, v: number) => number): this {
    const n = this.size;
    const inv = 1 / n;
    let i = 0;
    for (let y = 0; y < n; y++) {
      const v = (y + 0.5) * inv;
      for (let x = 0; x < n; x++, i++) this.data[i] = fn(this.data[i], x, y, (x + 0.5) * inv, v);
    }
    return this;
  }

  add(other: Field, scale = 1): this {
    for (let i = 0; i < this.data.length; i++) this.data[i] += other.data[i] * scale;
    return this;
  }

  mul(other: Field): this {
    for (let i = 0; i < this.data.length; i++) this.data[i] *= other.data[i];
    return this;
  }

  max(other: Field): this {
    for (let i = 0; i < this.data.length; i++) {
      if (other.data[i] > this.data[i]) this.data[i] = other.data[i];
    }
    return this;
  }

  scale(k: number, offset = 0): this {
    for (let i = 0; i < this.data.length; i++) this.data[i] = this.data[i] * k + offset;
    return this;
  }

  clampTo(lo = 0, hi = 1): this {
    for (let i = 0; i < this.data.length; i++) {
      const v = this.data[i];
      this.data[i] = v < lo ? lo : v > hi ? hi : v;
    }
    return this;
  }

  /** Rescale so the actual extremes land on `lo`..`hi`. */
  normalize(lo = 0, hi = 1): this {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < this.data.length; i++) {
      const v = this.data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const span = max - min;
    if (span < 1e-9) {
      this.data.fill((lo + hi) * 0.5);
      return this;
    }
    const k = (hi - lo) / span;
    for (let i = 0; i < this.data.length; i++) this.data[i] = lo + (this.data[i] - min) * k;
    return this;
  }

  /**
   * Wrapped box blur, run twice so the kernel is effectively a tent — cheap,
   * separable, and smooth enough that the derived normal has no ringing.
   */
  blur(radius: number, passes = 2): this {
    const r = Math.max(1, Math.round(radius));
    const n = this.size;
    let src = this.data;
    let tmp = new Float32Array(n * n);
    const inv = 1 / (r * 2 + 1);
    for (let pass = 0; pass < passes; pass++) {
      for (let y = 0; y < n; y++) {
        const row = y * n;
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[row + (((k % n) + n) % n)];
        for (let x = 0; x < n; x++) {
          tmp[row + x] = sum * inv;
          sum -= src[row + (((x - r) % n) + n) % n];
          sum += src[row + (((x + r + 1) % n) + n) % n];
        }
      }
      for (let x = 0; x < n; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += tmp[((((k % n) + n) % n) * n) + x];
        for (let y = 0; y < n; y++) {
          src[y * n + x] = sum * inv;
          sum -= tmp[(((((y - r) % n) + n) % n) * n) + x];
          sum += tmp[(((((y + r + 1) % n) + n) % n) * n) + x];
        }
      }
    }
    return this;
  }

  /**
   * Wrapped box blur along one axis only.
   *
   * Smearing isotropic noise along a direction is the cheapest honest way to
   * get *fibre*: satin floats, brushed metal, hair strands and wood grain are
   * all the same operation with a different radius.
   */
  blurAxis(radius: number, axis: 'u' | 'v', passes = 2): this {
    const r = Math.max(1, Math.round(radius));
    const n = this.size;
    const inv = 1 / (r * 2 + 1);
    const line = new Float32Array(n);
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < n; i++) {
        const idx = axis === 'u'
          ? (k: number) => i * n + ((k % n) + n) % n
          : (k: number) => (((k % n) + n) % n) * n + i;
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += this.data[idx(k)];
        for (let k = 0; k < n; k++) {
          line[k] = sum * inv;
          sum -= this.data[idx(k - r)];
          sum += this.data[idx(k + r + 1)];
        }
        for (let k = 0; k < n; k++) this.data[idx(k)] = line[k];
      }
    }
    return this;
  }

  clone(): Field {
    const f = new Field(this.size);
    f.data.set(this.data);
    return f;
  }

  /**
   * How much the wrap edge stands out from ordinary texel-to-texel variation.
   *
   * Absolute differences mean nothing on their own — a coarse weave steps hard
   * everywhere — so this is a *ratio*: the mean step across the wrap boundary
   * over the mean step one texel inside it. 1 means the seam is
   * indistinguishable from the rest of the surface, which is the only result
   * worth accepting. `textureDebugSheet` reports it per generator.
   */
  seamError(): number {
    const n = this.size;
    let seam = 0;
    let inner = 0;
    for (let i = 0; i < n; i++) {
      seam += Math.abs(this.get(0, i) - this.get(n - 1, i)) + Math.abs(this.get(i, 0) - this.get(i, n - 1));
      inner += Math.abs(this.get(1, i) - this.get(0, i)) + Math.abs(this.get(i, 1) - this.get(i, 0));
    }
    if (inner < 1e-6) return seam < 1e-6 ? 1 : Infinity;
    return seam / inner;
  }
}

const _rgb = { r: 0, g: 0, b: 0 };

/** sRGB-encoded components of an authored colour, 0..1. */
export function srgb(color: THREE.ColorRepresentation, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  new THREE.Color(color).getRGB(_rgb, THREE.SRGBColorSpace);
  out[0] = _rgb.r;
  out[1] = _rgb.g;
  out[2] = _rgb.b;
  return out;
}

const _hsl = { h: 0, s: 0, l: 0 };

/**
 * A neighbour of an authored colour, moved in HSL.
 *
 * Dye lots, thread tone, worn paint and grime are all small hue/chroma moves —
 * never plain multiplies. A thread that is only *darker* than its neighbour
 * reads as a shadow; a thread that is darker *and* slightly redder reads as a
 * different thread.
 */
export function shiftedSrgb(
  color: THREE.ColorRepresentation,
  dl = 0,
  ds = 0,
  dh = 0,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const c = new THREE.Color(color);
  c.getHSL(_hsl, THREE.SRGBColorSpace);
  c.setHSL(
    (_hsl.h + dh + 1) % 1,
    THREE.MathUtils.clamp(_hsl.s + ds, 0, 1),
    THREE.MathUtils.clamp(_hsl.l + dl, 0, 1),
    THREE.SRGBColorSpace,
  );
  return srgb(c, out);
}

/**
 * RGB raster held in **sRGB** 0..1, not linear.
 *
 * Deliberate: fabric tinting, dye variation and grime are all authored the way
 * a painter picks them, and a 6% value wobble on a thread means 6% of what you
 * see. Doing the same arithmetic in linear light crushes the variation in the
 * darks — a navy gi's weave would vanish while a cream abadá's screamed.
 */
export class ColorField {
  readonly size: number;
  readonly data: Float32Array;

  constructor(size: number, base: THREE.ColorRepresentation = 0xffffff) {
    this.size = size;
    this.data = new Float32Array(size * size * 3);
    const c = srgb(base);
    for (let i = 0; i < this.data.length; i += 3) {
      this.data[i] = c[0];
      this.data[i + 1] = c[1];
      this.data[i + 2] = c[2];
    }
  }

  set(x: number, y: number, r: number, g: number, b: number): void {
    const i = (y * this.size + x) * 3;
    this.data[i] = r;
    this.data[i + 1] = g;
    this.data[i + 2] = b;
  }

  /** Multiply one texel — the standard move for shading a weave by its height. */
  scaleAt(x: number, y: number, k: number): void {
    const i = (y * this.size + x) * 3;
    this.data[i] *= k;
    this.data[i + 1] *= k;
    this.data[i + 2] *= k;
  }

  lerpAt(x: number, y: number, r: number, g: number, b: number, t: number): void {
    const i = (y * this.size + x) * 3;
    this.data[i] = mix(this.data[i], r, t);
    this.data[i + 1] = mix(this.data[i + 1], g, t);
    this.data[i + 2] = mix(this.data[i + 2], b, t);
  }

  /** Per-texel callback; write the result into `out` to avoid allocating. */
  fill(fn: (u: number, v: number, x: number, y: number, out: [number, number, number]) => void): this {
    const n = this.size;
    const inv = 1 / n;
    const out: [number, number, number] = [0, 0, 0];
    let i = 0;
    for (let y = 0; y < n; y++) {
      const v = (y + 0.5) * inv;
      for (let x = 0; x < n; x++, i += 3) {
        out[0] = this.data[i];
        out[1] = this.data[i + 1];
        out[2] = this.data[i + 2];
        fn((x + 0.5) * inv, v, x, y, out);
        this.data[i] = out[0];
        this.data[i + 1] = out[1];
        this.data[i + 2] = out[2];
      }
    }
    return this;
  }

  /**
   * Shade by a height/mask field: `amount` is the full-swing value change, so
   * 0.2 means the crests are 10% brighter and the troughs 10% darker.
   *
   * Baked lighting in an albedo is normally a sin, but a cel-shaded fighter
   * only gets two or three lighting bands — without a little contact darkening
   * in the weave and the seams, cloth reads as coloured plastic.
   */
  shade(field: Field, amount: number, pivot = 0.5): this {
    for (let i = 0, j = 0; i < field.data.length; i++, j += 3) {
      const k = 1 + (field.data[i] - pivot) * amount;
      this.data[j] *= k;
      this.data[j + 1] *= k;
      this.data[j + 2] *= k;
    }
    return this;
  }

  /** Blend a flat colour in through a mask. */
  overlay(color: THREE.ColorRepresentation, mask: Field, amount = 1): this {
    const c = srgb(color);
    for (let i = 0, j = 0; i < mask.data.length; i++, j += 3) {
      const t = clamp01(mask.data[i] * amount);
      this.data[j] = mix(this.data[j], c[0], t);
      this.data[j + 1] = mix(this.data[j + 1], c[1], t);
      this.data[j + 2] = mix(this.data[j + 2], c[2], t);
    }
    return this;
  }

  /**
   * Pull everything toward mid-grey by `amount`, keeping the hue.
   *
   * Used for the `neutral` option: the same generator can produce either a
   * finished albedo or a multiplicative detail map for a material that already
   * carries the palette colour.
   */
  desaturateToward(level: number, amount: number): this {
    for (let i = 0; i < this.data.length; i += 3) {
      const l = (this.data[i] * 0.299 + this.data[i + 1] * 0.587 + this.data[i + 2] * 0.114) || 1e-6;
      const k = level / l;
      this.data[i] = mix(this.data[i], this.data[i] * k, amount);
      this.data[i + 1] = mix(this.data[i + 1], this.data[i + 1] * k, amount);
      this.data[i + 2] = mix(this.data[i + 2], this.data[i + 2] * k, amount);
    }
    return this;
  }
}
