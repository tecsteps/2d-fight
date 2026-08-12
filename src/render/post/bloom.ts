import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { BLOOM_DOWN_FRAG, BLOOM_UP_FRAG, FULLSCREEN_VERT } from './shaders';
import type { BloomSpec } from './contract';

/**
 * Mip-chain bloom.
 *
 * Down the chain with a 13-tap filter, back up with additive 3x3 tents — the
 * dual-filter approach from Call of Duty rather than Three's `UnrealBloomPass`.
 * The difference is not subtle at this quality bar:
 *
 * - `UnrealBloomPass` blurs five fixed-size gaussians and sums them with hand
 *   tuned weights. Every kernel has a hard end, so bright areas get a visible
 *   halo boundary and the whole screen hazes over when anything gets bright.
 * - A progressive tent chain has *no* characteristic radius. Falloff is smooth
 *   over four decades of distance, which is what a real lens does, and small
 *   highlights stay small while a genuinely blown-out super still floods.
 *
 * The chain starts at half resolution. Bloom is the lowest-frequency thing in
 * the frame; paying full rate for it buys nothing and costs 3 ms.
 *
 * ## The halo guard, and why a 2D fighter gets almost no bloom
 *
 * Everything above is about how the glow *falls off*. What review 002 caught is
 * a different question — what is allowed to glow at all — and getting it wrong
 * is worth more than every quality property in this file put together.
 *
 * The spec that shipped asked for `threshold 0.78, knee 0.42`, so the soft knee
 * opened at scene-linear 0.36. A fighter's lit skin sits at about 0.5. Every
 * fighter in the frame was therefore a bloom source along their whole lit side,
 * and the measurement is unambiguous: background luminance climbed **+30 to
 * +60% over the last 30px approaching a figure**, and the lift was absent on the
 * darkest-skinned fighter, which proves it scaled with figure brightness rather
 * than being anything in the stage.
 *
 * A hand-drawn sprite has *zero* bleed into the background. Nothing about a
 * painted 2D fighter glows: the light in the frame is drawn, not emitted. A
 * halo around a character is the single loudest cue that a frame was rendered in
 * 3D — louder than the shading, louder than the outline — because it is the one
 * artifact that has no counterpart anywhere in hand-painted work.
 *
 * So `MIN_KNEE_FLOOR` below is a floor on where the knee may open, expressed in
 * scene-linear radiance and enforced here rather than left to each stage's
 * tuning. It is deliberately above anything a *diffuse surface* can reach under
 * a sane rig, which leaves bloom to do the only job it should have in this
 * renderer: genuine emitters — hitsparks, super flashes, practicals, blade
 * trails — authored above the floor on purpose. If a stage's glow has
 * disappeared, the fix is to make the emitter brighter, not to lower this.
 *
 * The guard is a clamp and a warning rather than an assertion because a stage
 * mid-authoring should still render; the warning names the number to change.
 */
export class BloomChain {
  /** Mip 0 is half-res and is the texture the composite samples. */
  private mips: THREE.WebGLRenderTarget[] = [];
  private readonly down: THREE.ShaderMaterial;
  private readonly up: THREE.ShaderMaterial;
  private readonly quad = new FullScreenQuad();
  private readonly type: THREE.TextureDataType;

  spec: BloomSpec;

  constructor(spec: BloomSpec, type: THREE.TextureDataType) {
    this.spec = spec;
    this.type = type;

    this.down = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uThreshold: { value: new THREE.Vector4() },
        uFirst: { value: 0 },
        uSaturation: { value: spec.saturation },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLOOM_DOWN_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.up = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: spec.radius },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLOOM_UP_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      transparent: true,
    });

    this.applySpec();
  }

  /**
   * Lowest scene-linear radiance at which the soft knee may start to admit
   * light, i.e. the smallest legal `threshold - knee`.
   *
   * 1.0 is not a round number chosen for tidiness — it is measured. Under the
   * `dusk` rig the brightest diffuse surface in the lineup frame is a fighter's
   * lit skin at scene-linear ≈ 0.55, and the brightest the stage itself reaches
   * is ≈ 0.25 on the near floor. A knee opening at 1.0 clears the brightest
   * *surface* by roughly a stop, which is the margin that keeps a cel-shaded
   * body from bleeding while an emitter authored at 1.5-3.0 still floods.
   */
  private static readonly MIN_KNEE_FLOOR = 1.0;

  /**
   * Widest legal tent spread on the way back up the chain.
   *
   * The threshold decides *what* blooms; this decides how far what does bloom
   * reaches sideways. At 0.85 a single bright pixel is still measurably lifting
   * the background two mip levels away — fine for an anamorphic lens, wrong for
   * a frame that has to read as drawn. 0.6 keeps the glow attached to its
   * source.
   */
  private static readonly MAX_RADIUS = 0.6;

  private warnedGuard = false;

  /** Re-reads `spec` into the uniforms. Cheap enough to call every frame. */
  applySpec(): void {
    const s = this.spec;
    const knee = Math.max(s.knee, 1e-4);

    // The guard: keep the *bottom* of the knee above anything a lit surface can
    // reach, by raising the threshold rather than by narrowing the knee — a
    // hard knee makes the glow switch on and off across a whole surface as a
    // light rotates, which is the failure the soft knee exists to prevent.
    const threshold = Math.max(s.threshold, BloomChain.MIN_KNEE_FLOOR + knee);
    const radius = Math.min(s.radius, BloomChain.MAX_RADIUS);

    if (!this.warnedGuard && (threshold !== s.threshold || radius !== s.radius)) {
      this.warnedGuard = true;
      console.warn(
        `[bloom] spec asks for threshold ${s.threshold} / radius ${s.radius}; clamped to ` +
          `${threshold.toFixed(2)} / ${radius.toFixed(2)}. A knee opening below ` +
          `${BloomChain.MIN_KNEE_FLOOR} admits lit skin and haloes every fighter — see the ` +
          `header and docs/FRAME_BUDGET.md. Raise the emitter, not the bloom.`,
      );
    }

    // Packed the way the shader wants it so the knee costs three multiplies
    // instead of a branch: (threshold, threshold-knee, 2*knee, 0.25/knee).
    (this.down.uniforms.uThreshold.value as THREE.Vector4).set(
      threshold,
      threshold - knee,
      2 * knee,
      0.25 / knee,
    );
    this.down.uniforms.uSaturation.value = s.saturation;
    this.up.uniforms.uRadius.value = radius;
  }

  /** `width`/`height` are the full-resolution frame in device pixels. */
  setSize(width: number, height: number): void {
    for (const rt of this.mips) rt.dispose();
    this.mips = [];

    // One level per halving until the smallest mip would go under ~8 texels,
    // where a tent filter stops meaning anything.
    const maxLevels = Math.max(3, Math.floor(Math.log2(Math.min(width, height))) - 3);
    const levels = Math.min(this.spec.levels, maxLevels);

    let w = Math.max(1, Math.floor(width / 2));
    let h = Math.max(1, Math.floor(height / 2));
    for (let i = 0; i < levels; i++) {
      const rt = new THREE.WebGLRenderTarget(w, h, {
        type: this.type,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      rt.texture.name = `bloom.mip${i}`;
      // Clamped, or the tent filter wraps a bright edge to the opposite side of
      // the screen — which reads as a ghost image, not as glow.
      rt.texture.wrapS = THREE.ClampToEdgeWrapping;
      rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      this.mips.push(rt);
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
    }
  }

  /** The half-res result. Valid after `render`. */
  get texture(): THREE.Texture | null {
    return this.mips.length > 0 ? this.mips[0].texture : null;
  }

  /**
   * The level the anamorphic streak feeds from. Deep enough that only real
   * highlights survive, shallow enough that the streak still has a shape.
   */
  get streakSource(): THREE.Texture | null {
    if (this.mips.length === 0) return null;
    return this.mips[Math.min(2, this.mips.length - 1)].texture;
  }

  render(renderer: THREE.WebGLRenderer, source: THREE.Texture): void {
    if (this.mips.length === 0) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;

    this.quad.material = this.down;
    let src = source;
    for (let i = 0; i < this.mips.length; i++) {
      const dst = this.mips[i];
      // Texel size is the *source's*, since the 13-tap kernel is defined in the
      // space it reads from, not the space it writes to.
      const sw = i === 0 ? dst.width * 2 : this.mips[i - 1].width;
      const sh = i === 0 ? dst.height * 2 : this.mips[i - 1].height;
      (this.down.uniforms.uTexel.value as THREE.Vector2).set(1 / sw, 1 / sh);
      this.down.uniforms.tSrc.value = src;
      this.down.uniforms.uFirst.value = i === 0 ? 1 : 0;
      renderer.setRenderTarget(dst);
      renderer.clear(true, false, false);
      this.quad.render(renderer);
      src = dst.texture;
    }

    this.quad.material = this.up;
    for (let i = this.mips.length - 1; i > 0; i--) {
      const from = this.mips[i];
      const to = this.mips[i - 1];
      (this.up.uniforms.uTexel.value as THREE.Vector2).set(1 / from.width, 1 / from.height);
      this.up.uniforms.tSrc.value = from.texture;
      // No clear: the coarse level is *added* to the finer one already there.
      // That accumulation is the whole point of the progressive chain.
      renderer.setRenderTarget(to);
      this.quad.render(renderer);
    }

    renderer.autoClear = autoClear;
  }

  dispose(): void {
    for (const rt of this.mips) rt.dispose();
    this.mips = [];
    this.down.dispose();
    this.up.dispose();
    // Not `quad.dispose()`: FullScreenQuad shares one static geometry across
    // every instance in the process, so disposing it here would break any other
    // pass still using it.
  }
}
