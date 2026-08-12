/**
 * Fixed-timestep game loop.
 *
 * Fighting games are defined in frames, not seconds: a move is "4f startup, 3f
 * active, 12f recovery" and that must hold whether the display is 60, 120 or
 * 144 Hz. So the simulation advances in whole 1/60 s ticks and the renderer
 * interpolates between the last two sim states with the leftover alpha.
 *
 * Guards against the spiral of death: if the tab was backgrounded and we owe
 * hundreds of ticks, we drop the debt rather than trying to catch up.
 */
export interface LoopHooks {
  /** Advance the simulation exactly one 1/60 s tick. */
  tick(frame: number): void;
  /** Draw. `alpha` in [0,1) is the blend between the previous and current tick. */
  render(alpha: number, dt: number): void;
}

export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;

/** Never simulate more than this many ticks in one animation frame. */
const MAX_CATCHUP_TICKS = 5;

export class Loop {
  readonly hooks: LoopHooks;

  /** Monotonic simulation frame counter. The sim's only notion of time. */
  frame = 0;

  running = false;
  paused = false;

  /** Set >0 to advance exactly N ticks while paused (frame-step debugging). */
  private stepBudget = 0;

  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;

  /** Rolling render-side timing, for the debug overlay. */
  fps = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;

  constructor(hooks: LoopHooks) {
    this.hooks = hooks;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.frameCallback);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** Advance N sim ticks on the next frame even while paused. */
  step(ticks = 1): void {
    this.stepBudget += ticks;
  }

  private frameCallback = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frameCallback);

    let dt = now - this.lastTime;
    this.lastTime = now;

    // A backgrounded tab hands us a huge dt. Clamp it; the alternative is
    // simulating thousands of frames and hanging the main thread.
    if (dt > 250) dt = TICK_MS;

    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 500) {
      this.fps = (this.fpsFrames * 1000) / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    if (this.paused) {
      while (this.stepBudget > 0) {
        this.stepBudget--;
        this.hooks.tick(this.frame++);
      }
      this.hooks.render(0, dt);
      return;
    }

    this.accumulator += dt;

    let ticks = 0;
    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      this.hooks.tick(this.frame++);
      if (++ticks >= MAX_CATCHUP_TICKS) {
        // Give up on the backlog rather than stall. Better to skip time than
        // to freeze; the sim stays internally consistent either way.
        this.accumulator = 0;
        break;
      }
    }

    this.hooks.render(this.accumulator / TICK_MS, dt);
  };
}
