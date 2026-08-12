import * as THREE from 'three';
import { FightCamera } from './Camera';

/**
 * Render root.
 *
 * Owns the WebGL context, the scene graph split into named layers, and the
 * resize/quality policy. Post-processing lives in `src/render/post` and is
 * attached here once available; until then this draws straight to the canvas so
 * the pipeline is always runnable.
 *
 * Layer split matters for a fighting game: the stage backdrop, the fighting
 * plane, and the foreground parallax are lit and graded differently, and the
 * HUD must never be touched by the world's colour grade.
 */
export interface RendererQuality {
  /** Device pixel ratio cap. 1 = never supersample, 2 = retina. */
  pixelRatio: number;
  /** MSAA samples on the main target. */
  samples: number;
  shadows: boolean;
}

export const QUALITY_HIGH: RendererQuality = { pixelRatio: 2, samples: 4, shadows: true };
export const QUALITY_LOW: RendererQuality = { pixelRatio: 1, samples: 0, shadows: false };

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly cam: FightCamera;

  /** Everything behind the fighting plane: sky, buildings, crowd. */
  readonly background = new THREE.Group();
  /** The fighting plane itself: floor, fighters, gameplay VFX. */
  readonly world = new THREE.Group();
  /** In front of the fighters: dust, foreground parallax, screen-space FX. */
  readonly foreground = new THREE.Group();

  quality: RendererQuality;

  private canvas: HTMLCanvasElement;
  private width = 1920;
  private height = 1080;

  constructor(canvas: HTMLCanvasElement, quality: RendererQuality = QUALITY_HIGH) {
    this.canvas = canvas;
    this.quality = quality;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality.samples > 0,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      // Needed for the screenshot harness: without it the drawing buffer is
      // cleared before we can read it back.
      preserveDrawingBuffer: true,
    });

    this.renderer.setClearColor(0x05060a, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.add(this.background, this.world, this.foreground);

    this.cam = new FightCamera();
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    this.renderer.dispose();
  }

  resize = (): void => {
    // In headless capture we honour the canvas' CSS box; on desktop that is the
    // window. Either way the backing store is the box times the ratio cap.
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;

    const ratio = Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.cam.setAspect(w / h);
  };

  render(frame: number, alpha: number): void {
    this.cam.apply(frame, alpha);
    this.renderer.render(this.scene, this.cam.camera);
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }
}
