import * as THREE from 'three';
import type { SurfaceKind, ToonMaterialOptions } from './contract';
import { ToonMaterial, calibrateNpr, createToonMaterial } from './ToonMaterial';
import { addOutlines } from './outline';
import { VERA, MALI, KAI } from '../../data/roster';

export type { NPRMaterial, SurfaceKind, ToonMaterialOptions, CreateToonMaterial } from './contract';

export {
  ToonMaterial,
  createToonMaterial,
  calibrateNpr,
  setNprRimDirection,
  setNprLightingScale,
  setNprSaturation,
  nprMaterials,
  registerNprMaterial,
  unregisterNprMaterial,
  NPR_TUNING,
} from './ToonMaterial';

export {
  OutlineMaterial,
  createOutlineMesh,
  addOutlines,
  removeOutlineMesh,
  computeOutlineNormals,
} from './outline';
export type { OutlineOptions } from './outline';

export { bandRamp, disposeRamps, coolShadow, coreShadowTint, inkColor } from './ramps';
export type { RampSpec, ShadowTintOptions } from './ramps';

/**
 * Standalone test bench for the shading pipeline.
 *
 * One sphere and one capsule per `SurfaceKind`, in the roster's own colours,
 * under the same three-point rig the stages use. The sphere shows the band
 * layout and the terminator; the capsule shows what the treatment does to a
 * limb-shaped form, which is where anisotropy and wrapped lambert actually
 * matter and where a sphere would flatter a bad ramp.
 *
 * Screenshot this before and after any tuning pass: a change that improves skin
 * on a fighter but ruins satin is very hard to see in a fight and obvious here.
 *
 * Frame it with the camera at roughly (0, 1.95, 7.6) looking at (0, 1.95, 0).
 */
export function nprDebugScene(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'npr-debug';

  // Colours are the real ones the fighters use, so the bench exercises the
  // actual chroma range rather than a set of convenient mid greys.
  const swatches: Record<SurfaceKind, ToonMaterialOptions> = {
    skin: {
      kind: 'skin',
      color: VERA.palette.skin,
      shadowColor: VERA.palette.skinShadow,
      sssColor: VERA.palette.skinSSS,
      rimColor: VERA.palette.rim,
    },
    hair: { kind: 'hair', color: VERA.palette.hair, rimColor: VERA.palette.rim },
    cloth: { kind: 'cloth', color: KAI.palette.primary, rimColor: KAI.palette.rim },
    quilted: { kind: 'quilted', color: VERA.palette.primary, rimColor: VERA.palette.rim },
    satin: { kind: 'satin', color: MALI.palette.secondary, rimColor: MALI.palette.rim },
    leather: { kind: 'leather', color: VERA.palette.boots, rimColor: VERA.palette.rim },
    wrap: { kind: 'wrap', color: VERA.palette.wrap, rimColor: VERA.palette.rim },
    metal: { kind: 'metal', color: 0xb9c2cf, rimColor: KAI.palette.rim },
    stage: { kind: 'stage', color: 0x4a3f36, rimColor: 0xffc98a },
  };

  const kinds = Object.keys(swatches) as SurfaceKind[];
  const sphere = new THREE.SphereGeometry(0.4, 64, 40);
  const capsule = new THREE.CapsuleGeometry(0.21, 0.5, 16, 40);

  const cols = 4;
  const cellX = 1.36;
  const cellY = 1.12;

  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    const material = new ToonMaterial(swatches[kind]);
    const x = ((i % cols) - (cols - 1) / 2) * cellX;
    const y = 2.85 - Math.floor(i / cols) * cellY;

    const ball = new THREE.Mesh(sphere, material);
    ball.position.set(x - 0.31, y, 0);
    ball.castShadow = true;
    ball.receiveShadow = true;

    const limb = new THREE.Mesh(capsule, material);
    limb.position.set(x + 0.33, y, 0);
    // Tipped off-axis so the anisotropic sheen band has to travel across the
    // form rather than sitting conveniently on the equator.
    limb.rotation.set(0.18, 0, -0.22);
    limb.castShadow = true;
    limb.receiveShadow = true;

    group.add(ball, limb);
  }

  // Ink stress test: a shape with creases, self-occlusion and high curvature,
  // where a naive inverted hull tears and a uniform-weight line reads flat.
  const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.3, 0.1, 160, 24),
    new ToonMaterial({ kind: 'leather', color: KAI.palette.accent, rimColor: KAI.palette.rim }),
  );
  knot.position.set(1.36, 0.61, 0);
  knot.castShadow = true;
  group.add(knot);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 6),
    new ToonMaterial({ kind: 'stage', color: 0x2b2620 }),
  );
  floor.geometry.rotateX(-Math.PI / 2);
  floor.position.y = 0;
  floor.receiveShadow = true;
  group.add(floor);

  addOutlines(group);

  // Same rig proportions as the stages: warm key from camera-left, weak cool
  // fill opposite, hot rim from behind. The rim is the load-bearing light in a
  // fighting game and the bench has to be judged with it present.
  const key = new THREE.DirectionalLight(0xffd9b0, 2.6);
  key.position.set(-5.5, 8.0, 6.0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -4;
  key.shadow.camera.right = 4;
  key.shadow.camera.top = 4;
  key.shadow.camera.bottom = -1;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 30;
  key.shadow.bias = -0.0012;
  key.shadow.normalBias = 0.02;

  const fill = new THREE.DirectionalLight(0x6f86c9, 0.55);
  fill.position.set(6.5, 3.5, 4.0);

  const rim = new THREE.DirectionalLight(0xff9f5a, 1.9);
  rim.position.set(1.5, 4.5, -8.0);

  const ambient = new THREE.HemisphereLight(0x5a6a93, 0x2a1d16, 0.45);

  group.add(key, key.target, fill, rim, ambient);

  calibrateNpr(group);
  return group;
}

/** Frees every material and geometry a debug scene owns. */
export function disposeDebugScene(group: THREE.Group): void {
  const seen = new Set<THREE.Material | THREE.BufferGeometry>();
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!seen.has(mesh.geometry)) {
      seen.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (seen.has(m)) continue;
      seen.add(m);
      m.dispose();
    }
  });
}
