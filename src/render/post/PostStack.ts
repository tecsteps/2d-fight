import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { BloomChain } from './bloom';
import { AnamorphicStreak } from './streak';
import { buildGradeLUT, displayRGB } from './grade';
import { COMPOSITE_FRAG, FULLSCREEN_VERT } from './shaders';
import {
  PASS_NAMES,
  resolveTuning,
  type DeepPartial,
  type PassName,
  type PostStackOptions,
  type PostTuning,
} from './contract';

/**
 * The post-processing chain.
 *
 * ## Shape of the frame
 *
 * ```
 * scene ──▶ sceneRT (RGBA16F, MSAA)
 *             ├──▶ BloomChain   ──▶ half-res glow
 *             │        └──▶ AnamorphicStreak ──▶ 1/8-res streak
 *             └──▶ composite ──▶ canvas (sRGB bytes)
 * ```
 *
 * Three full-screen resolves total. Everything else — tone mapping, the LUT
 * grade, aberration, distortion, speed lines, vignette, grain, dither — happens
 * inside the single composite shader, because at 1080p a full-screen resolve
 * costs roughly 0.3 ms of pure bandwidth and eight of them would eat a third of
 * the frame for pixels that never changed.
 *
 * ## Colour management
 *
 * The scene is drawn into a **linear half-float target**. Three deliberately
 * skips tone mapping and output encoding when it renders to a target, which is
 * exactly what this needs: the renderer's own `ACESFilmicToneMapping` is
 * bypassed and the composite's GT curve runs instead. The composite writes
 * already-encoded sRGB bytes and never includes Three's `colorspace_fragment`,
 * so nothing gets gamma-corrected twice.
 *
 * ## Gameplay hooks
 *
 * `setImpact` / `setSpeedLines` / `setDim` / `setTimeStop` are pure uniform
 * writes with no allocation and no state of their own — the simulation owns the
 * envelopes, because a decay curve living down here would be invisible to the
 * replay system and would desync rollback.
 */
export class PostStack {
  readonly renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;

  readonly tuning: PostTuning;

  /**
   * Frame counter driving grain and speed-line drift. Advanced by `render`;
   * assignable so the screenshot harness can pin a reproducible frame.
   */
  frame = 0;

  private sceneRT: THREE.WebGLRenderTarget;
  private bloom: BloomChain;
  private streak: AnamorphicStreak;
  private lut: THREE.DataTexture;
  private composite: THREE.ShaderMaterial;
  private quad = new FullScreenQuad();

  private width = 1;
  private height = 1;
  private readonly renderScale: number;
  private readonly drawScene: (renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget) => void;
  private readonly enabledPasses = new Set<PassName>(PASS_NAMES);
  private disposed = false;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    opts: PostStackOptions = {},
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.tuning = resolveTuning(opts.tuning);
    this.renderScale = opts.renderScale ?? 1;
    this.drawScene =
      opts.renderScene ??
      ((r, target) => {
        r.setRenderTarget(target);
        r.render(this.scene, this.camera);
      });

    // Half-float is the only sane working format: 8-bit clips every highlight
    // below the bloom threshold and bands the graded shadows. If the context
    // cannot render to it we fall back rather than fail, but the frame will
    // visibly lose its glow.
    const hdr =
      renderer.extensions.has('EXT_color_buffer_half_float') ||
      renderer.extensions.has('EXT_color_buffer_float');
    const type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;

    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      // The canvas' own MSAA never runs — post bypasses the default framebuffer
      // entirely — so the scene target has to carry it. Ink outlines on a cel
      // shaded fighter alias brutally without it.
      samples: opts.samples ?? 4,
    });
    this.sceneRT.texture.name = 'post.scene';

    this.bloom = new BloomChain(this.tuning.bloom, type);
    this.streak = new AnamorphicStreak(this.tuning.streak, type);
    this.lut = buildGradeLUT(this.tuning.grade);
    this.composite = this.buildComposite();

    for (const name of opts.disabled ?? []) this.enabledPasses.delete(name);
    this.syncDefines();

    const size = renderer.getSize(new THREE.Vector2());
    this.setSize(size.x || 1920, size.y || 1080);
  }

  private buildComposite(): THREE.ShaderMaterial {
    const t = this.tuning;
    return new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.sceneRT.texture },
        tBloom: { value: null },
        tStreak: { value: null },
        tLut: { value: this.lut },

        uResolution: { value: new THREE.Vector2(1920, 1080) },
        uAspect: { value: 16 / 9 },
        uScale: { value: 1 },

        uExposure: { value: t.exposure },
        uHueShift: { value: t.tonemapHueShift },
        uCurve: {
          value: new THREE.Vector4(
            t.tonemapContrast,
            t.tonemapLinearStart,
            t.tonemapLinearLength,
            t.tonemapToe,
          ),
        },

        uBloom: { value: t.bloom.intensity },
        uBloomTint: { value: new THREE.Color(t.bloom.tint) },
        uStreak: { value: t.streak.intensity },
        uStreakTint: { value: new THREE.Color(t.streak.tint) },

        uLutSize: { value: t.grade.size },
        uLutStrength: { value: t.gradeStrength },

        uAberration: { value: t.aberration },
        uAberrationImpact: { value: t.aberrationImpact },
        uDrag: { value: t.impactDrag },
        uDistortion: { value: t.distortion },

        uImpact: { value: 0 },
        uImpactColor: { value: new THREE.Color(t.impactColor) },
        uImpactFlash: { value: t.impactFlash },

        uDim: { value: 0 },
        uDimColor: { value: new THREE.Color(t.dimColor) },
        uDimFloor: { value: t.dimFloor },
        uTimeStop: { value: 0 },
        // Applied after the tone curve, so the tint is read as authored rather
        // than decoded to linear light first.
        uTimeStopColor: { value: new THREE.Vector3(...displayRGB(t.timeStopColor)) },

        uLines: { value: 0 },
        uLineCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uLineCount: { value: t.speedLineCount },
        uLineCountFine: { value: t.speedLineCountFine },
        uLineGain: { value: t.speedLineGain },
        uLineColor: { value: new THREE.Color(t.speedLineColor) },
        uLineSeed: { value: 0 },

        uVignette: { value: t.vignette },
        uVigInner: { value: t.vignetteInner },
        uVigOuter: { value: t.vignetteOuter },
        uVigRound: { value: t.vignetteRoundness },

        uGrain: { value: t.grain },
        uGrainSize: { value: t.grainSize },
        uSeed: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });
  }

  /** `w`/`h` are CSS pixels — the same numbers passed to `renderer.setSize`. */
  setSize(w: number, h: number): void {
    const dpr = this.renderer.getPixelRatio();
    const dw = Math.max(1, Math.round(w * dpr * this.renderScale));
    const dh = Math.max(1, Math.round(h * dpr * this.renderScale));
    if (dw === this.width && dh === this.height) return;
    this.width = dw;
    this.height = dh;

    this.sceneRT.setSize(dw, dh);
    this.bloom.setSize(dw, dh);
    this.streak.setSize(dw, dh);

    const u = this.composite.uniforms;
    (u.uResolution.value as THREE.Vector2).set(dw, dh);
    u.uAspect.value = dw / dh;
    // Every pixel-quoted knob in `tuning` is authored at 1080p. Without this a
    // 4K frame gets grain four times finer and aberration half as wide, and the
    // whole look silently changes with the window size.
    u.uScale.value = dh / 1080;
  }

  /** 0..1. Radial aberration, radial drag, additive flash, and a bloom kick. */
  setImpact(amount: number, color?: THREE.ColorRepresentation): void {
    this.composite.uniforms.uImpact.value = clamp01(amount);
    if (color !== undefined) (this.composite.uniforms.uImpactColor.value as THREE.Color).set(color);
  }

  /**
   * Radial speed lines for supers. `cx`/`cy` are normalised viewport coords with
   * the origin bottom-left — gameplay projects the attacker's chest through the
   * camera and passes the result.
   */
  setSpeedLines(amount: number, cx: number, cy: number, color?: THREE.ColorRepresentation): void {
    const u = this.composite.uniforms;
    u.uLines.value = clamp01(amount);
    (u.uLineCenter.value as THREE.Vector2).set(cx, cy);
    if (color !== undefined) (u.uLineColor.value as THREE.Color).set(color);
  }

  /** 0..1. Darkens and drains the world so a cut-in portrait can own the frame. */
  setDim(amount: number): void {
    this.composite.uniforms.uDim.value = clamp01(amount);
  }

  /** 0..1. Desaturates and closes the vignette during hitstop. */
  setTimeStop(amount: number): void {
    this.composite.uniforms.uTimeStop.value = clamp01(amount);
  }

  /** Re-seeds the speed-line wheel so two supers in a row do not share a pattern. */
  setSpeedLineSeed(seed: number): void {
    this.composite.uniforms.uLineSeed.value = seed;
  }

  isPassEnabled(name: PassName): boolean {
    return this.enabledPasses.has(name);
  }

  /** A/B a single pass. Recompiles the composite, so not a per-frame call. */
  setPassEnabled(name: PassName, on: boolean): void {
    if (on === this.enabledPasses.has(name)) return;
    if (on) this.enabledPasses.add(name);
    else this.enabledPasses.delete(name);
    this.syncDefines();
  }

  /**
   * Rebuilds the LUT after a grade change. Costs a 32^3 evaluation on the main
   * thread — fine for a tuning slider, never for a frame.
   */
  refreshGrade(over?: DeepPartial<PostTuning>['grade']): void {
    if (over) Object.assign(this.tuning.grade, over);
    this.lut.dispose();
    this.lut = buildGradeLUT(this.tuning.grade);
    this.composite.uniforms.tLut.value = this.lut;
    this.composite.uniforms.uLutSize.value = this.tuning.grade.size;
  }

  render(dt: number): void {
    if (this.disposed) return;
    const r = this.renderer;
    const u = this.composite.uniforms;

    // Wrapped rather than free-running: the hash functions driving grain lose
    // precision once the seed passes a few thousand, and the frame it wraps on
    // is one frame of a different grain pattern, which nobody can see.
    this.frame = (this.frame + Math.max(1, Math.round(dt * 60))) % 1024;
    u.uSeed.value = this.frame;

    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;

    this.drawScene(r, this.sceneRT);

    if (this.enabledPasses.has('bloom')) {
      this.bloom.applySpec();
      this.bloom.render(r, this.sceneRT.texture);
      u.tBloom.value = this.bloom.texture;
      u.uBloom.value = this.tuning.bloom.intensity;

      const streakSrc = this.bloom.streakSource;
      if (this.enabledPasses.has('streak') && streakSrc) {
        this.streak.render(r, streakSrc);
        u.tStreak.value = this.streak.texture;
        u.uStreak.value = this.tuning.streak.intensity;
      }
    }

    r.autoClear = prevAutoClear;
    r.setRenderTarget(null);
    this.quad.material = this.composite;
    this.quad.render(r);

    r.setRenderTarget(prevTarget);
  }

  /** Depth and colour of the drawn world, for effects that need to read it. */
  get sceneTarget(): THREE.WebGLRenderTarget {
    return this.sceneRT;
  }

  dispose(): void {
    this.disposed = true;
    this.sceneRT.dispose();
    this.bloom.dispose();
    this.streak.dispose();
    this.lut.dispose();
    this.composite.dispose();
  }

  /**
   * Compiles disabled passes out of the composite entirely. A `uniform == 0`
   * branch would still pay for its texture fetches; a define means a disabled
   * pass measures as exactly zero, which is what makes the A/B numbers usable.
   */
  private syncDefines(): void {
    const d: Record<string, string> = {};
    if (this.enabledPasses.has('bloom')) d.USE_BLOOM = '1';
    if (this.enabledPasses.has('bloom') && this.enabledPasses.has('streak')) d.USE_STREAK = '1';
    // `tonemap` off leaves a straight clamp into sRGB, which is the only honest
    // way to see what the curve is actually doing to the frame.
    if (this.enabledPasses.has('tonemap')) d.USE_TONEMAP = '1';
    if (this.enabledPasses.has('grade')) d.USE_GRADE = '1';
    if (this.enabledPasses.has('aberration')) d.USE_ABERRATION = '1';
    if (this.enabledPasses.has('distortion')) d.USE_DISTORTION = '1';
    if (this.enabledPasses.has('speedlines')) d.USE_SPEEDLINES = '1';
    if (this.enabledPasses.has('vignette')) d.USE_VIGNETTE = '1';
    if (this.enabledPasses.has('grain')) d.USE_GRAIN = '1';
    this.composite.defines = d;
    this.composite.needsUpdate = true;
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Pass names in chain order, for the A/B debug UI. */
export function postDebugToggles(): PassName[] {
  return [...PASS_NAMES];
}
