import * as THREE from 'three';
import { PostStack } from './PostStack';
import { PASS_NAMES, type PassName } from './contract';
import { ROSTER } from '../../data/roster';

/**
 * Standalone tuning harness for the post chain.
 *
 * Not part of the game. It exists because the grade cannot be judged against a
 * checker chart — it has to be judged on the things it will actually run on:
 * lit skin, saturated cloth, a specular on a wrap, a hitspark hot enough to
 * bloom, and a lot of near-black. So this builds exactly that, with no
 * dependency on the character or stage pipelines, and lets the capture script
 * A/B individual passes without touching the game's own entry point.
 *
 * ```js
 * const p = await import('/src/render/post/preview.ts');
 * p.mountPostPreview({ impact: 1 });
 * ```
 */

export interface PreviewOptions {
  width?: number;
  height?: number;
  /** Passes to leave on. Defaults to all of them. */
  passes?: PassName[];
  impact?: number;
  dim?: number;
  timeStop?: number;
  speedLines?: number;
  /** Adds a ramp/patch strip along the bottom to read the grade numerically. */
  chart?: boolean;
}

export interface PreviewHandle {
  post: PostStack;
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  draw(): void;
  dispose(): void;
}

export function mountPostPreview(opts: PreviewOptions = {}): PreviewHandle {
  const width = opts.width ?? window.innerWidth;
  const height = opts.height ?? window.innerHeight;

  const canvas = document.createElement('canvas');
  canvas.id = 'post-preview';
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:9999';
  document.body.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x05060a, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 200);
  camera.position.set(0, 1.55, 8.2);
  camera.lookAt(0, 1.35, 0);

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // A stage is mostly a dark wall with a few practicals on it. Getting that
  // gradient in shot matters more than it sounds: the vignette, the black lift
  // and the shadow tint all do their work in exactly this value range.
  const backdrop = track(new THREE.PlaneGeometry(60, 26));
  const backdropMat = track(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
    }),
  );
  const cols: number[] = [];
  const top = new THREE.Color(0x101728);
  const bottom = new THREE.Color(0x02030a);
  const pos = backdrop.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) / 26 + 0.5) ** 1.4;
    const c = bottom.clone().lerp(top, t);
    cols.push(c.r, c.g, c.b);
  }
  backdrop.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const wall = new THREE.Mesh(backdrop, backdropMat);
  wall.position.set(0, 7, -14);
  scene.add(wall);

  const floorGeo = track(new THREE.PlaneGeometry(40, 40));
  // Deliberately matte. A semi-rough floor throws a broad specular sheet under
  // this rig that swamps everything else in frame, and the grade cannot be read
  // off a picture that is 60% blown highlight.
  const floorMat = track(new THREE.MeshStandardMaterial({ color: 0x16161d, roughness: 0.92, metalness: 0 }));
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Three-point rig with a warm key and a cool fill — the light setup the grade
  // was tuned against. Grading a neutrally lit scene teaches you nothing.
  const key = new THREE.DirectionalLight(0xfff0d8, 3.4);
  key.position.set(4.5, 7, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -8;
  key.shadow.camera.right = 8;
  key.shadow.camera.top = 8;
  key.shadow.camera.bottom = -2;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x5c78c8, 0.8);
  fill.position.set(-6, 3, 4);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xa8d8ff, 1.6);
  rim.position.set(-2, 4, -7);
  scene.add(rim);

  scene.add(new THREE.HemisphereLight(0x30405a, 0x0a0a10, 0.35));

  // Stand-in fighters: one column per roster palette, so the grade is judged on
  // the exact skin, costume and wrap colours it will ship against.
  const bodyGeo = track(new THREE.CapsuleGeometry(0.3, 1.05, 12, 24));
  const headGeo = track(new THREE.SphereGeometry(0.21, 24, 18));
  const wrapGeo = track(new THREE.TorusGeometry(0.31, 0.055, 10, 28));

  ROSTER.forEach((f, i) => {
    const x = (i - (ROSTER.length - 1) / 2) * 1.75;
    const g = new THREE.Group();
    g.position.set(x, 0, 0);

    const bodyMat = track(
      new THREE.MeshStandardMaterial({ color: f.palette.primary, roughness: 0.62, metalness: 0.04 }),
    );
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 1.02;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    const skinMat = track(
      new THREE.MeshStandardMaterial({ color: f.palette.skin, roughness: 0.48, metalness: 0 }),
    );
    const head = new THREE.Mesh(headGeo, skinMat);
    head.position.y = 1.83;
    head.castShadow = true;
    g.add(head);

    // A tight bright ring is the hardest thing in the frame for a bloom chain:
    // too much threshold and it dies, too little and it hazes the whole fighter.
    const wrapMat = track(
      new THREE.MeshStandardMaterial({
        color: f.palette.wrap,
        emissive: new THREE.Color(f.palette.energy),
        emissiveIntensity: 0.35,
        roughness: 0.35,
      }),
    );
    const band = new THREE.Mesh(wrapGeo, wrapMat);
    band.position.y = 1.55;
    band.rotation.x = Math.PI / 2;
    g.add(band);

    // The hitspark: genuinely over-range, which is the only input that proves
    // the half-float path and the threshold are both alive.
    const sparkMat = track(
      new THREE.MeshBasicMaterial({ color: new THREE.Color(f.palette.energy).multiplyScalar(7) }),
    );
    const spark = new THREE.Mesh(track(new THREE.SphereGeometry(0.075, 16, 12)), sparkMat);
    spark.position.set(0.36, 1.34 + (i % 2) * 0.22, 0.45);
    g.add(spark);

    scene.add(g);
  });

  if (opts.chart) {
    const chart = buildChart(disposables);
    chart.position.set(0, 0.22, 3.2);
    scene.add(chart);
  }

  const post = new PostStack(renderer, scene, camera, { samples: 4 });
  post.setSize(width, height);

  if (opts.passes) {
    for (const name of PASS_NAMES) post.setPassEnabled(name, opts.passes.includes(name));
  }
  post.setImpact(opts.impact ?? 0);
  post.setDim(opts.dim ?? 0);
  post.setTimeStop(opts.timeStop ?? 0);
  post.setSpeedLines(opts.speedLines ?? 0, 0.5, 0.46);

  const draw = (): void => {
    post.render(1 / 60);
  };
  draw();

  return {
    post,
    renderer,
    canvas,
    draw,
    dispose() {
      post.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}

/**
 * Grey ramp plus saturated patches, lit flat.
 *
 * A grade is a claim about what happens to every value, and the only way to
 * catch it crushing a step or hue-shifting a primary is to put every value in
 * the same frame.
 */
function buildChart(disposables: { dispose(): void }[]): THREE.Group {
  const group = new THREE.Group();
  const geo = new THREE.PlaneGeometry(0.3, 0.3);
  disposables.push(geo);

  const add = (hex: THREE.ColorRepresentation, x: number, y: number): void => {
    const mat = new THREE.MeshBasicMaterial({ color: hex });
    disposables.push(mat);
    const q = new THREE.Mesh(geo, mat);
    q.position.set(x, y, 0);
    group.add(q);
  };

  const steps = 11;
  for (let i = 0; i < steps; i++) {
    const v = i / (steps - 1);
    add(new THREE.Color(v, v, v), (i - (steps - 1) / 2) * 0.33, 0.34);
  }

  const swatches = [0xd94f4f, 0xe0a318, 0x3ea05a, 0x2f7fd9, 0x8c4fd9, 0xe2a17c, 0x7d4826, 0x1f4a38];
  swatches.forEach((hex, i) => add(hex, (i - (swatches.length - 1) / 2) * 0.33, 0));

  return group;
}
