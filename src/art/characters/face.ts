import * as THREE from 'three';
import type { FighterDef } from '../../data/roster';
import type { BuiltCharacter } from './rig';

/** Placeholder — replaced below. */
export function buildFace(rig: BuiltCharacter, _def: FighterDef = rig.def): THREE.Object3D {
  const g = new THREE.Group();
  rig.bones.head.add(g);
  return g;
}
