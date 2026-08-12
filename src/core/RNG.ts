/**
 * Deterministic PRNG (xoshiro128**) for the simulation.
 *
 * The sim must never touch `Math.random()`. Every stochastic decision — VFX
 * jitter that feeds back into gameplay, AI mixups, damage scaling ties — draws
 * from a seeded stream so a replay reproduces bit-for-bit.
 *
 * Purely cosmetic randomness (particle sprites, crowd animation) should use a
 * *separate* RNG instance seeded off the frame counter, never this one, so that
 * turning effects on and off cannot desync the match.
 */
export class RNG {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  constructor(seed = 0x2f6e2b1) {
    this.seed(seed);
  }

  seed(seed: number): void {
    // SplitMix32 expansion so that adjacent seeds produce distant streams.
    let z = seed >>> 0;
    const next = () => {
      z = (z + 0x9e3779b9) >>> 0;
      let t = z;
      t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
      t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
      return (t ^ (t >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
  }

  /** Raw 32-bit draw. */
  u32(): number {
    const r = (Math.imul(this.s1 * 5, 1) >>> 0) & 0xffffffff;
    const result = ((((r << 7) | (r >>> 25)) >>> 0) * 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) >>> 0;
    return result;
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.u32() / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.float() * (max - min);
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.float() * (max - min + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }

  /** Snapshot for rollback / replay checkpoints. */
  save(): Uint32Array {
    return Uint32Array.of(this.s0, this.s1, this.s2, this.s3);
  }

  restore(state: Uint32Array): void {
    this.s0 = state[0];
    this.s1 = state[1];
    this.s2 = state[2];
    this.s3 = state[3];
  }
}

/** The one true simulation RNG. Cosmetic systems must not use this. */
export const simRNG = new RNG();

/** Cosmetic-only RNG. Safe to consume from render code. */
export const fxRNG = new RNG(0x51a7f00d);
