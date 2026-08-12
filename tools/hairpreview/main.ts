import * as THREE from 'three';
import { Loop } from '../../src/core/Loop';
import { Renderer, QUALITY_HIGH } from '../../src/render/Renderer';
import { buildBootstrapStage, type Stage } from '../../src/art/stages/bootstrap';
import { buildCharacter, NEUTRAL_STANCE } from '../../src/art/characters';
import { buildHair, hairRigOf } from '../../src/art/characters/hair';
import { PostStack } from '../../src/render/post';
import { ROSTER, fighterById } from '../../src/data/roster';

/**
 * Scratch harness for the hair pass — not shipped, not imported by the game.
 *
 * `?fighter=kai&view=head|body|all&yaw=0.42&pose=0|1`. It exists because the
 * only honest way to judge hair is a rendered frame with the real ink and the
 * real cel ramp on it, and the game's own scenes do not yet attach hair.
 */

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'body';
const yaw = parseFloat(params.get('yaw') ?? '0.42');
const posed = params.get('pose') !== '0';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new Renderer(canvas, QUALITY_HIGH);
let stage: Stage | null = null;
let post: PostStack | null = null;

function frameOn(box: THREE.Box3, fill = 0.82): void {
  const size = new THREE.Vector3();
  const centre = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(centre);
  const cam = renderer.cam.camera;
  const vFov = (cam.fov * Math.PI) / 180;
  const dist = size.y / fill / (2 * Math.tan(vFov / 2));
  const distH = size.x / fill / (2 * Math.tan(vFov / 2) * cam.aspect);
  cam.position.set(centre.x, centre.y, Math.max(dist, distH) + size.z);
  cam.lookAt(centre);
  cam.updateProjectionMatrix();
}

function place(id: string, x: number): { height: number; headY: number } {
  const def = fighterById(id);
  const rig = buildCharacter(def);
  buildHair(rig);
  rig.resetPose();
  if (posed) rig.applyPose(NEUTRAL_STANCE);
  rig.root.rotation.y = yaw;
  rig.root.position.x = x;
  renderer.world.add(rig.root);
  const chains = hairRigOf(rig.root.getObjectByName(`${def.id}:hair`)!)?.chains.length ?? 0;
  console.log(`${def.id}: hair chains=${chains}`);
  return { height: def.proportions.height, headY: rig.joints.head.y };
}

stage = buildBootstrapStage();
renderer.background.add(stage.background);
renderer.world.add(stage.world);

if (view === 'all') {
  const spacing = 1.35;
  const x0 = -((ROSTER.length - 1) * spacing) / 2;
  ROSTER.forEach((def, i) => place(def.id, x0 + i * spacing));
  frameOn(
    new THREE.Box3(new THREE.Vector3(x0 - 0.7, 0, -0.8), new THREE.Vector3(-x0 + 0.7, 1.9, 0.8)),
    0.86,
  );
} else {
  const info = place(params.get('fighter') ?? 'kai', 0);
  if (view === 'head') {
    const c = new THREE.Vector3(0, (info.headY + info.height) * 0.5 + 0.02, 0);
    const r = (info.height - info.headY) * 0.9;
    frameOn(new THREE.Box3(c.clone().subScalar(r), c.clone().addScalar(r)), 0.9);
  } else {
    frameOn(
      new THREE.Box3(new THREE.Vector3(-0.6, 0, -0.6), new THREE.Vector3(0.6, info.height, 0.6)),
      0.9,
    );
  }
}

if (params.get('post') !== '0') {
  post = new PostStack(renderer.renderer, renderer.scene, renderer.cam.camera);
  const { width, height } = renderer.size;
  post.setSize(width, height);
}

const loop = new Loop({
  tick(frame) {
    stage?.tick?.(frame);
  },
  render(_alpha, dt) {
    if (post) post.render(dt / 1000);
    else renderer.renderer.render(renderer.scene, renderer.cam.camera);
  },
});
loop.start();

interface FightHarness {
  seek(frame: number): void;
  ready: boolean;
}
const harness: FightHarness = {
  seek(frame: number) {
    loop.stop();
    loop.paused = true;
    if (frame < loop.frame) loop.frame = 0;
    while (loop.frame < frame) loop.hooks.tick(loop.frame++);
    loop.hooks.render(0, 1000 / 60);
  },
  ready: false,
};
(window as unknown as { __fight: FightHarness }).__fight = harness;
requestAnimationFrame(() => {
  harness.ready = true;
});
