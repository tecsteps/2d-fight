import * as THREE from 'three';

/**
 * Fighting-game camera.
 *
 * A fighting camera is not a free camera: it lives on a rail, tracks the
 * midpoint between the fighters, zooms to keep both in frame, and is clamped so
 * it never shows past the edges of the stage. On top of that sit the "juice"
 * layers — shake, punch-in on heavy hits, and a slow drift that keeps the
 * framing from feeling locked to a tripod.
 *
 * Everything is expressed in world units where 1 unit ~ 1 metre and the
 * fighting plane is z = 0.
 */

export interface CameraBounds {
  /** Horizontal extent the camera centre may travel. */
  minX: number;
  maxX: number;
  /** Vertical extent of the camera centre. */
  minY: number;
  maxY: number;
}

const DEG2RAD = Math.PI / 180;

export class FightCamera {
  readonly camera: THREE.PerspectiveCamera;

  /** Where the camera wants to be, before shake. */
  private targetX = 0;
  private targetY = 1.5;
  private targetDist = 9;

  /** Where it actually is (critically damped toward target). */
  private x = 0;
  private y = 1.5;
  private dist = 9;

  private velX = 0;
  private velY = 0;
  private velDist = 0;

  bounds: CameraBounds = { minX: -14, maxX: 14, minY: 1.1, maxY: 5.0 };

  /** Distance limits — how far the camera may pull back or push in. */
  minDist = 6.2;
  maxDist = 13.5;

  /** Shake state: trauma decays, and shake amplitude is trauma^2. */
  private trauma = 0;
  private shakeSeed = Math.random() * 1000;

  /** Additive punch-in applied on impact, decays to zero. */
  private punch = 0;

  constructor(aspect = 16 / 9) {
    this.camera = new THREE.PerspectiveCamera(34, aspect, 0.1, 400);
    this.camera.position.set(0, 1.5, 9);
    this.camera.lookAt(0, 1.5, 0);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Add shake. `amount` in [0,1]; stacks but saturates. */
  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Punch the camera in by `amount` world units, decaying over ~10 frames. */
  addPunch(amount: number): void {
    this.punch = Math.min(1.2, this.punch + amount);
  }

  /**
   * Frame the two fighters. Called once per sim tick with their world x/y.
   */
  frameFighters(ax: number, ay: number, bx: number, by: number): void {
    const midX = (ax + bx) * 0.5;
    const spread = Math.abs(ax - bx);
    const highest = Math.max(ay, by);

    this.targetX = midX;

    // Pull back as they separate, and as either goes airborne.
    const spreadDist = 6.4 + spread * 0.52;
    const airDist = Math.max(0, highest - 1.0) * 0.42;
    this.targetDist = THREE.MathUtils.clamp(spreadDist + airDist, this.minDist, this.maxDist);

    // Rise with the higher fighter, but only partially — full tracking makes
    // jumps feel weightless because the ground never leaves the frame.
    this.targetY = 1.45 + Math.max(0, highest - 0.9) * 0.38;

    this.targetX = THREE.MathUtils.clamp(this.targetX, this.bounds.minX, this.bounds.maxX);
    this.targetY = THREE.MathUtils.clamp(this.targetY, this.bounds.minY, this.bounds.maxY);
  }

  /** Snap instantly to the current target — for round starts and cuts. */
  snap(): void {
    this.x = this.targetX;
    this.y = this.targetY;
    this.dist = this.targetDist;
    this.velX = this.velY = this.velDist = 0;
  }

  /** Advance one sim tick. */
  tick(): void {
    // Critically damped springs: smooth, never overshoots, no oscillation.
    const stiff = 0.16;
    const damp = 0.68;

    this.velX = (this.velX + (this.targetX - this.x) * stiff) * damp;
    this.velY = (this.velY + (this.targetY - this.y) * stiff) * damp;
    this.velDist = (this.velDist + (this.targetDist - this.dist) * stiff) * damp;

    this.x += this.velX;
    this.y += this.velY;
    this.dist += this.velDist;

    this.trauma = Math.max(0, this.trauma - 0.035);
    this.punch *= 0.82;
    if (this.punch < 0.001) this.punch = 0;
  }

  /** Write the final transform. `alpha` is the render interpolation factor. */
  apply(frame: number, alpha: number): void {
    const t = frame + alpha;

    // Shake amplitude scales with trauma squared so small hits barely move the
    // camera and big ones are violent.
    const s = this.trauma * this.trauma;
    const sx = s * 0.34 * this.noise(t * 0.9, 0);
    const sy = s * 0.26 * this.noise(t * 0.9, 17.3);
    const sr = s * 0.9 * DEG2RAD * this.noise(t * 0.7, 41.7);

    const dist = Math.max(this.minDist * 0.86, this.dist - this.punch);

    this.camera.position.set(this.x + sx, this.y + sy, dist);
    this.camera.rotation.set(0, 0, sr);
    this.camera.lookAt(this.x + sx * 0.6, this.y + sy * 0.6, 0);
    this.camera.rotateZ(sr);
  }

  /** Cheap value noise in [-1,1]; deterministic given (t, offset). */
  private noise(t: number, offset: number): number {
    const x = t + offset + this.shakeSeed;
    const i = Math.floor(x);
    const f = x - i;
    const a = this.hash(i);
    const b = this.hash(i + 1);
    const u = f * f * (3 - 2 * f);
    return (a + (b - a) * u) * 2 - 1;
  }

  private hash(n: number): number {
    let h = Math.imul(n | 0, 0x27d4eb2d);
    h = (h ^ (h >>> 15)) >>> 0;
    return (h % 10000) / 10000;
  }
}
