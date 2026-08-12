import * as THREE from 'three';
import { Loop } from './core/Loop';
import { Renderer, QUALITY_HIGH } from './render/Renderer';
import { buildBootstrapStage, type BootstrapStage } from './art/stages/bootstrap';
import { buildCharacterPreview } from './art/characters';
import { nprDebugScene } from './render/npr';
import { textureDebugSheet } from './art/textures';
import { PostStack } from './render/post';
import { ROSTER, fighterById } from './data/roster';

/**
 * Entry point.
 *
 * Scene selection is by query string (`?scene=lineup`) so the capture harness
 * can shoot each subsystem in isolation and the critic can score them
 * separately. A visual regression in the ink outline should not be hidden
 * behind a stage that happens to look good.
 */

type SceneName = 'lineup' | 'solo' | 'npr' | 'tex';

const params = new URLSearchParams(location.search);
const sceneName = (params.get('scene') ?? 'lineup') as SceneName;
const soloId = params.get('fighter') ?? 'kai';
/**
 * Matte mode: the fighters as flat white on black, no stage, no post.
 *
 * This exists for `tools/critic/measure.py`, which otherwise has to guess which
 * pixels are fighter from brightness alone. That guess held only while the stage
 * was nearly black, and `docs/FRAME_BUDGET.md` requires it not to be — so as the
 * frame moved into its budgeted value band the tool's per-figure statistics
 * quietly started measuring the floor. Every photometric alternative tried
 * either swallowed the near-black ink and destroyed the hue numbers, or moved
 * the historical values so reviews 001 and 002 stopped being comparable to
 * anything. A matte is the only answer that is exact and stays exact on any
 * stage.
 *
 * Capture the pair and pass both:
 *
 * ```
 * node tools/shots/capture.mjs --scene lineup --frames 0 --tag look
 * node tools/shots/capture.mjs --scene lineup --frames 0 --tag matte --matte 1
 * python3 tools/critic/measure.py shots/look-0000.png --matte shots/matte-0000.png
 * ```
 */
const matte = params.get('matte') === '1';
const usePost = params.get('post') !== '0' && !matte;
// Turnaround control. A silhouette element that hangs behind the body — a
// braid, a hood, a sash tail — is invisible from the default three-quarter
// view, so verifying one means being able to spin the fighter.
const yaw = params.has('yaw') ? parseFloat(params.get('yaw')!) : 0.42;

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new Renderer(canvas, QUALITY_HIGH);

let stage: BootstrapStage | null = null;
let post: PostStack | null = null;

/** Frame the camera on a bounding box, filling the given fraction of height. */
function frameOn(box: THREE.Box3, fill = 0.82): void {
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);
  const cam = renderer.cam.camera;
  const vFov = (cam.fov * Math.PI) / 180;
  const dist = size.y / fill / (2 * Math.tan(vFov / 2));
  // Widen if the group is broader than it is tall.
  const distH = size.x / fill / (2 * Math.tan(vFov / 2) * cam.aspect);
  cam.position.set(centre.x, centre.y, Math.max(dist, distH) + size.z);
  cam.lookAt(centre);
  cam.updateProjectionMatrix();
}

function buildScene(): void {
  switch (sceneName) {
    case 'npr': {
      renderer.world.add(nprDebugScene());
      lightDebugRig();
      frameOn(new THREE.Box3(new THREE.Vector3(-4, -1, -2), new THREE.Vector3(4, 3, 2)));
      break;
    }

    case 'tex': {
      renderer.world.add(textureDebugSheet());
      // Texture sheets are unlit swatches — a flat bright ambient is correct
      // here, since any directional term would misrepresent the albedo.
      renderer.world.add(new THREE.AmbientLight(0xffffff, 3.0));
      const box = new THREE.Box3().setFromObject(renderer.world);
      frameOn(box, 0.92);
      break;
    }

    case 'solo': {
      stage = buildBootstrapStage();
      renderer.background.add(stage.background);
      renderer.world.add(stage.world);
      const def = fighterById(soloId);
      const g = buildCharacterPreview(def, { yaw });
      renderer.world.add(g);
      stage.setContactPoints(footContacts(g.position.x));
      frameOn(new THREE.Box3(
        new THREE.Vector3(-0.6, 0, -0.6),
        new THREE.Vector3(0.6, def.proportions.height, 0.6),
      ), 0.9);
      break;
    }

    case 'lineup':
    default: {
      stage = buildBootstrapStage();
      renderer.background.add(stage.background);
      renderer.world.add(stage.world);

      // Spread the roster along the fight line, each turned slightly toward
      // camera so the three-quarter read — the view a character sheet is
      // judged on — is what gets captured.
      const spacing = 1.35;
      const x0 = -((ROSTER.length - 1) * spacing) / 2;
      const contacts: { x: number; z: number }[] = [];
      ROSTER.forEach((def, i) => {
        const g = buildCharacterPreview(def, { yaw: 0.42 });
        g.position.x = x0 + i * spacing;
        renderer.world.add(g);
        contacts.push(...footContacts(g.position.x));
      });
      stage.setContactPoints(contacts);
      frameOn(new THREE.Box3(
        new THREE.Vector3(x0 - 0.7, 0, -0.8),
        new THREE.Vector3(-x0 + 0.7, 1.9, 0.8),
      ), 0.86);
      break;
    }
  }
}

/**
 * The two soles of a fighter standing at `x`, for `stage.setContactPoints`.
 *
 * Hard-coded to the preview's A-pose stance and its 0.42 rad yaw, which is all
 * a static lineup needs. Gameplay replaces this with the ankle joints read off
 * the posed skeleton and a per-foot `strength` from the grounded flag — the
 * point of the stage API is that it takes world positions and knows nothing
 * about how they were obtained.
 */
function footContacts(x: number): { x: number; z: number }[] {
  const half = 0.064;
  const yawZ = 0.028;
  return [
    { x: x - half, z: -yawZ },
    { x: x + half, z: yawZ },
  ];
}

/**
 * Strips the frame to a fighter matte: flat white bodies on black.
 *
 * The ink shells are hidden rather than whitened. They are separate meshes that
 * sit a few pixels *outside* the body, so leaving them in would grow the matte
 * by the outline's width — and the pixels it would add are the darkest in the
 * frame, which is exactly the wrong thing to feed into a statistic about a
 * fighter's shadow value.
 */
function applyMatte(): void {
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  renderer.background.clear();
  renderer.foreground.clear();
  renderer.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // Key owned by `render/npr/outline.ts`, which tags every ink shell it makes.
    if (mesh.userData.nprInk) {
      mesh.visible = false;
      return;
    }
    mesh.material = white;
  });
  renderer.renderer.setClearColor(0x000000, 1);
}

/** Neutral three-point rig for scenes that have no stage of their own. */
function lightDebugRig(): void {
  const key = new THREE.DirectionalLight(0xffe3c0, 2.4);
  key.position.set(-4, 6, 5);
  const fill = new THREE.DirectionalLight(0x7a90d0, 0.5);
  fill.position.set(5, 2.5, 3);
  const rim = new THREE.DirectionalLight(0xffa060, 1.7);
  rim.position.set(1, 3.5, -6);
  renderer.world.add(key, fill, rim, new THREE.HemisphereLight(0x5a6a93, 0x2a1d16, 0.4));
}

buildScene();
if (matte) {
  // After `buildScene`, so it catches the stage as well as the fighters: the
  // stage's own meshes are removed from the layers rather than whitened.
  const built = stage as BootstrapStage | null;
  if (built) {
    renderer.world.remove(built.world);
    renderer.background.remove(built.background);
  }
  applyMatte();
}

if (usePost) {
  post = new PostStack(renderer.renderer, renderer.scene, renderer.cam.camera);
  const { width, height } = renderer.size;
  post.setSize(width, height);
}

const loop = new Loop({
  tick(frame) {
    stage?.tick?.(frame);
  },
  render(alpha, dt) {
    if (post) {
      post.render(dt / 1000);
    } else {
      renderer.renderer.render(renderer.scene, renderer.cam.camera);
    }
  },
});

loop.start();
document.getElementById('boot')?.classList.add('gone');

/** Harness contract — see tools/shots. */
interface FightHarness {
  loop: Loop;
  renderer: Renderer;
  seek(frame: number): void;
  ready: boolean;
  scene: SceneName;
}

const harness: FightHarness = {
  loop,
  renderer,
  seek(frame: number) {
    loop.stop();
    loop.paused = true;
    if (frame < loop.frame) loop.frame = 0;
    while (loop.frame < frame) loop.hooks.tick(loop.frame++);
    loop.hooks.render(0, 1000 / 60);
  },
  ready: false,
  scene: sceneName,
};

(window as unknown as { __fight: FightHarness }).__fight = harness;
requestAnimationFrame(() => {
  harness.ready = true;
});
