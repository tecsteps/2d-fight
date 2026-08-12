import * as THREE from 'three';
import type { FighterDef } from '../../data/roster';
import type { BuiltCharacter } from './rig';
import { refineHead, faceSpec } from './head';

/** Placeholder — features land in the next pass. */
export function buildFace(rig: BuiltCharacter, def: FighterDef = rig.def): THREE.Object3D {
  const spec = faceSpec(def);
  const t0 = performance.now();
  const r = refineHead(rig, spec);
  // eslint-disable-next-line no-console
  console.log(`[face] ${def.id} sculpt ${(performance.now() - t0).toFixed(0)}ms moved ${r.moved} tris ${r.triangles}`);
  const g = new THREE.Group();
  g.name = `${def.id}:face`;
  rig.bones.head.add(g);
  return g;
}
