import * as THREE from 'three';
import { Loop } from './core/Loop';
import { Renderer, QUALITY_HIGH } from './render/Renderer';
import { buildBootstrapStage, type BootstrapStage, type Stage } from './art/stages/bootstrap';
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
const usePost = params.get('post') !== '0';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new Renderer(canvas, QUALITY_HIGH);

let stage: Stage | null = null;
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
      const g = buildCharacterPreview(def, { yaw: 0.42 });
      renderer.world.add(g);
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
        contacts.push(
          { x: g.position.x - 0.064, z: -0.028 },
          { x: g.position.x + 0.064, z: 0.028 },
        );
      });
      (stage as BootstrapStage).setContactPoints(contacts);
      frameOn(new THREE.Box3(
        new THREE.Vector3(x0 - 0.7, 0, -0.8),
        new THREE.Vector3(-x0 + 0.7, 1.9, 0.8),
      ), 0.86);
      break;
    }
  }
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
