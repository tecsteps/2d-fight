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

  /** Re-reads `spec` into the uniforms. Cheap enough to call every frame. */
  applySpec(): void {
    const s = this.spec;
    const knee = Math.max(s.knee, 1e-4);
    // Packed the way the shader wants it so the knee costs three multiplies
    // instead of a branch: (threshold, threshold-knee, 2*knee, 0.25/knee).
    (this.down.uniforms.uThreshold.value as THREE.Vector4).set(
      s.threshold,
      s.threshold - knee,
      2 * knee,
      0.25 / knee,
    );
    this.down.uniforms.uSaturation.value = s.saturation;
    this.up.uniforms.uRadius.value = s.radius;
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
