import * as THREE from 'three';
import { Renderer, QUALITY_HIGH } from '../../src/render/Renderer';
import { buildBootstrapStage } from '../../src/art/stages/bootstrap';
import { buildCharacter, NEUTRAL_STANCE } from '../../src/art/characters';
import { buildCostume } from '../../src/art/characters/costume';
import { PostStack } from '../../src/render/post';
import { fighterById } from '../../src/data/roster';

/**
 * Costume-only preview harness.
 *
 * A separate entry point rather than a new case in `src/main.ts`, so that the
 * costume work can be looked at without touching a file another agent is
 * editing. `?view=front|side|back|three|closeup` picks the camera; `?fighter=`
 * picks the roster entry.
 */

const params = new URLSearchParams(location.search);
const id = params.get('fighter') ?? 'kai';
const view = params.get('view') ?? 'three';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new Renderer(canvas, QUALITY_HIGH);

const stage = buildBootstrapStage();
renderer.background.add(stage.background);
renderer.world.add(stage.world);

const def = fighterById(id);
// Built undressed and dressed explicitly, so this harness still exercises
// `buildCostume` directly even when `buildCharacter` stops calling it.
const t0 = performance.now();
const rig = buildCharacter(def, { costume: false });
const tBody = performance.now() - t0;
rig.resetPose();
rig.applyPose(NEUTRAL_STANCE);
const t1 = performance.now();
const costume = buildCostume(rig, def);
const tCostume = performance.now() - t1;
renderer.world.add(rig.root);

const YAW: Record<string, number> = { front: 0, three: 0.42, side: Math.PI / 2, back: Math.PI, closeup: 0.42 };
rig.root.rotation.y = YAW[view] ?? 0.42;

const H = def.proportions.height;
const cam = renderer.cam.camera;
const target =
  view === 'closeup' ? new THREE.Vector3(0, H * 0.62, 0) : new THREE.Vector3(0, H * 0.5, 0);
const fill = view === 'closeup' ? 0.46 : 0.94;
const vFov = (cam.fov * Math.PI) / 180;
cam.position.set(target.x, target.y, (H / fill) / (2 * Math.tan(vFov / 2)));
cam.lookAt(target);
cam.updateProjectionMatrix();

const post = new PostStack(renderer.renderer, renderer.scene, cam);
const { width, height } = renderer.size;
post.setSize(width, height);

interface Harness {
  ready: boolean;
  seek(frame: number): void;
  stats: { triangles: number; pieces: number; bodyMs: number; costumeMs: number };
  /** Rest-space extents per piece: the fastest way to catch a runaway ray trace. */
  boxes: { name: string; x: number; y: number; z: number; cx: number; cy: number }[];
}
const harness: Harness = {
  ready: false,
  seek() {
    post.render(1 / 60);
  },
  stats: {
    triangles: costume.triangles,
    pieces: costume.meshes.length,
    bodyMs: Math.round(tBody),
    costumeMs: Math.round(tCostume),
  },
  boxes: costume.meshes.map((mesh) => {
    mesh.geometry.computeBoundingBox();
    const b = mesh.geometry.boundingBox!;
    const r = (v: number) => Math.round(v * 1000) / 1000;
    return {
      name: mesh.name.split(':')[1] ?? mesh.name,
      x: r(b.max.x - b.min.x),
      y: r(b.max.y - b.min.y),
      z: r(b.max.z - b.min.z),
      cx: r((b.max.x + b.min.x) / 2),
      cy: r((b.max.y + b.min.y) / 2),
    };
  }),
};
(window as unknown as { __fight: Harness }).__fight = harness;

post.render(1 / 60);
requestAnimationFrame(() => {
  harness.ready = true;
});
