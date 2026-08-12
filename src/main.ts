import * as THREE from 'three';
import { Loop } from './core/Loop';
import { Renderer, QUALITY_HIGH } from './render/Renderer';
import { buildBootstrapStage } from './art/stages/bootstrap';

/**
 * Entry point.
 *
 * Wires the fixed-timestep loop to the renderer and stands up whatever the
 * current milestone is. The `__fight` global is the contract the headless
 * screenshot and critic harnesses drive: they need to force a deterministic
 * frame and know when the scene is settled.
 */

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new Renderer(canvas, QUALITY_HIGH);

const stage = buildBootstrapStage();
renderer.background.add(stage.background);
renderer.world.add(stage.world);
renderer.foreground.add(stage.foreground);

// Placeholder fighter volumes so the camera framing logic has something real to
// track until the character pipeline lands.
const markerGeo = new THREE.CapsuleGeometry(0.32, 1.1, 8, 20);
const makeMarker = (color: number): THREE.Mesh => {
  const m = new THREE.Mesh(
    markerGeo,
    new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.05 }),
  );
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
};

const p1 = makeMarker(0xd94f4f);
const p2 = makeMarker(0x4f7fd9);
p1.position.set(-2.0, 0.87, 0);
p2.position.set(2.0, 0.87, 0);
renderer.world.add(p1, p2);

renderer.cam.frameFighters(p1.position.x, p1.position.y, p2.position.x, p2.position.y);
renderer.cam.snap();

const loop = new Loop({
  tick(frame) {
    // Placeholder idle motion so the frame is not visually dead. The real
    // simulation replaces this wholesale.
    const t = frame / 60;
    p1.position.y = 0.87 + Math.sin(t * 2.1) * 0.018;
    p2.position.y = 0.87 + Math.sin(t * 2.1 + 1.7) * 0.018;

    renderer.cam.frameFighters(p1.position.x, p1.position.y, p2.position.x, p2.position.y);
    renderer.cam.tick();
    stage.tick?.(frame);
  },
  render(alpha) {
    renderer.render(loop.frame, alpha);
  },
});

loop.start();

document.getElementById('boot')?.classList.add('gone');

/** Harness contract — see tools/shots. */
interface FightHarness {
  loop: Loop;
  renderer: Renderer;
  /** Jump to an exact sim frame deterministically, then draw it. */
  seek(frame: number): void;
  /** True once the first frame has been presented. */
  ready: boolean;
}

const harness: FightHarness = {
  loop,
  renderer,
  seek(frame: number) {
    loop.stop();
    loop.paused = true;
    if (frame < loop.frame) {
      loop.frame = 0;
      renderer.cam.snap();
    }
    while (loop.frame < frame) loop.hooks.tick(loop.frame++);
    renderer.render(loop.frame, 0);
  },
  ready: false,
};

(window as unknown as { __fight: FightHarness }).__fight = harness;
requestAnimationFrame(() => {
  harness.ready = true;
});
