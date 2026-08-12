import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { FULLSCREEN_VERT, STREAK_FRAG } from './shaders';
import type { StreakSpec } from './contract';

/**
 * Anamorphic highlight streak.
 *
 * Three horizontal blur iterations at 1/8 resolution with the tap stride
 * quadrupling each pass, so seven taps reach roughly 500 full-res pixels. Total
 * cost is under 0.1 ms at 1080p — this is the cheapest expensive-looking thing
 * in the whole pipeline.
 *
 * It is deliberately almost invisible. An anamorphic streak you can *see* is a
 * 2010 bloom filter; one you can only notice by turning it off is the reason a
 * frame reads as photographed. It only ever fires on the thresholded bright
 * pass, so it can appear on a hitspark or a wet specular and nowhere else.
 */
export class AnamorphicStreak {
  private a: THREE.WebGLRenderTarget | null = null;
  private b: THREE.WebGLRenderTarget | null = null;
  private readonly mat: THREE.ShaderMaterial;
  private readonly quad = new FullScreenQuad();
  private readonly type: THREE.TextureDataType;
  private out: THREE.WebGLRenderTarget | null = null;

  spec: StreakSpec;

  constructor(spec: StreakSpec, type: THREE.TextureDataType) {
    this.spec = spec;
    this.type = type;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uStride: { value: spec.stride },
        uAttenuation: { value: spec.attenuation },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: STREAK_FRAG,
      depthTest: false,
      depthWrite: false,
    });
  }

  setSize(width: number, height: number): void {
    this.a?.dispose();
    this.b?.dispose();
    const w = Math.max(1, Math.floor(width / 8));
    const h = Math.max(1, Math.floor(height / 8));
    const opts: THREE.RenderTargetOptions = {
      type: this.type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    this.a = new THREE.WebGLRenderTarget(w, h, opts);
    this.b = new THREE.WebGLRenderTarget(w, h, opts);
    this.a.texture.name = 'streak.a';
    this.b.texture.name = 'streak.b';
    this.out = null;
  }

  /** Valid after `render`; null before the first frame. */
  get texture(): THREE.Texture | null {
    return this.out?.texture ?? null;
  }

  render(renderer: THREE.WebGLRenderer, source: THREE.Texture): void {
    if (!this.a || !this.b) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;

    this.quad.material = this.mat;
    (this.mat.uniforms.uTexel.value as THREE.Vector2).set(1 / this.a.width, 1 / this.a.height);
    this.mat.uniforms.uAttenuation.value = this.spec.attenuation;

    let src = source;
    let dst = this.a;
    let other = this.b;
    const iterations = Math.max(1, Math.min(4, Math.round(this.spec.iterations)));
    for (let i = 0; i < iterations; i++) {
      this.mat.uniforms.tSrc.value = src;
      this.mat.uniforms.uStride.value = this.spec.stride * Math.pow(4, i);
      renderer.setRenderTarget(dst);
      renderer.clear(true, false, false);
      this.quad.render(renderer);
      src = dst.texture;
      const swap = dst;
      dst = other;
      other = swap;
    }
    this.out = other;

    renderer.autoClear = autoClear;
  }

  dispose(): void {
    this.a?.dispose();
    this.b?.dispose();
    this.a = this.b = this.out = null;
    this.mat.dispose();
  }
}
