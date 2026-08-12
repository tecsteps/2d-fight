import { addOutlines } from '../../../render/npr';
import type { FighterDef } from '../../../data/roster';
import type { BuiltCharacter } from '../rig';
import { emptyCostume, type BuiltCostume } from './garment';
import { buildKaiCostume } from './kai';
import { buildVeraCostume } from './vera';

/**
 * Costume assembly.
 *
 * One entry point: `buildCostume(rig, def)` dresses a fighter that has already
 * been built, dispatching on `def.id`. Each fighter's outfit lives in its own
 * file and is written against `garment.ts`; nothing here knows about cloth.
 *
 * The ink pass is re-run at the end rather than being left to `buildCharacter`,
 * because `addOutlines` skips meshes that already carry an ink shell — so
 * calling it again is cheap, idempotent, and inks exactly the garments that were
 * just attached. That is what lets a costume be added after the fact without the
 * character builder having to know the order.
 */

export {
  // Anatomy and layering
  LAYER,
  LAYER_GAP,
  CLOTH,
  over,
  landmarkY,
  torsoEnvelope,
  // Axes
  axisFromPoints,
  torsoAxis,
  chainAxis,
  CHAIN,
  // Offset surfaces
  traceOffset,
  buildShell,
  surfaceCurve,
  sliceBoundary,
  // Trims and free cloth
  buildBand,
  bakeStrand,
  // Profiles
  ramp,
  byAngle,
  edgeAtHeight,
  // Attachment
  attachGarment,
  bindRigid,
  emptyCostume,
} from './garment';

export type {
  Axis,
  Boundary,
  BandOptions,
  BuiltCostume,
  DrapeOptions,
  EdgeProfile,
  EdgeStyle,
  GarmentBody,
  GarmentPiece,
  Landmark,
  RadialProfile,
  ShellOptions,
  ShellResult,
  StrandOptions,
} from './garment';

export { buildKaiCostume } from './kai';

/**
 * Dresses `rig`. Safe to call on a fighter with no costume written yet — the
 * default arm returns an empty result rather than throwing, so a wave of
 * parallel costume work can land one fighter at a time.
 */
export function buildCostume(rig: BuiltCharacter, def: FighterDef = rig.def): BuiltCostume {
  let costume: BuiltCostume;
  switch (def.id) {
    case 'kai':
      costume = buildKaiCostume(rig, def);
      break;
    case 'vera':
      costume = buildVeraCostume(rig, def);
      break;
    default:
      costume = emptyCostume();
      break;
  }

  if (costume.meshes.length > 0) {
    const ink = addOutlines(rig.root);
    rig.outlines.push(...ink);
    rig.triangles += costume.triangles;
  }
  return costume;
}
