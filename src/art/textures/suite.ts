import type { FighterDef } from '../../data/roster';
import { bandageWrap, cottonCanvas, quiltedFabric, ribbedKnit, satinFabric } from './fabric';
import { hairStrands } from './hair';
import { leather } from './leather';
import { skinDetail } from './skin';
import type { TexSet } from './texture';

/**
 * The texture set each fighter actually wears.
 *
 * The generators are general; this file is where they are *cast*. It reads a
 * roster entry and answers "what is this character made of", so the character
 * builder asks one question instead of choosing a weave, a thread count and a
 * tile size for every garment on four fighters.
 *
 * Everything is memoised upstream, so two fighters in white wrap share one
 * upload, and calling this twice for the same fighter is free.
 *
 * Tile sizes are physical: a gi's weave tiles every 25 cm, a hand wrap every
 * 16 cm. The character builder converts those to UV repeats with the surface's
 * real measurement — which is why a sleeve and a trouser leg made of the same
 * cloth end up with the same thread size on screen.
 */

export interface FighterTextures {
  skin: TexSet;
  hair: TexSet;
  /** Garment surfaces, keyed the way the character builder names its parts. */
  garments: Readonly<Record<string, TexSet>>;
  /** Hand and ankle wraps. */
  wrap: TexSet;
  /** Absent for the barefoot fighters. */
  boots?: TexSet;
}

export function fighterTextures(def: FighterDef): FighterTextures {
  const p = def.palette;
  // Seeds are derived from the id so two fighters never share a dye lot, and so
  // a given fighter's cloth is identical between runs.
  const seed = [...def.id].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7);

  const skin = skinDetail({
    tone: p.skin,
    sss: p.skinSSS,
    seed,
    // Vera is the freckled one; the others get none, not a little.
    freckles: def.id === 'vera' ? 0.6 : 0,
    // Heavier builds sweat harder, and it reads as effort.
    sweat: 0.35 + def.proportions.build * 0.35,
    micro: 0.5 + def.proportions.build * 0.25,
  });

  const wrap = bandageWrap({
    color: p.wrap,
    seed: seed + 3,
    bandsU: 1,
    bandsV: def.id === 'mali' ? 3 : 4,
    // Muay thai wraps are pulled tighter and dirtier than a karateka's.
    grime: def.id === 'mali' ? 0.5 : 0.3,
    fray: def.id === 'vera' ? 0.65 : 0.45,
  });

  const garments: Record<string, TexSet> = {};
  let hair: TexSet;
  let boots: TexSet | undefined;

  switch (def.id) {
    case 'kai':
      hair = hairStrands({ color: p.hair, sheenColor: p.hairSheen, style: 'strand', seed, strands: 72, clump: 0.75 });
      // A gi is heavy twill; the diagonal is what makes it read as a gi and not
      // as a shirt.
      garments.gi = cottonCanvas({ color: p.primary, seed, kind: 'twill', threads: 56, tileMetres: 0.25, roughness: 0.88 });
      garments.pants = cottonCanvas({ color: p.secondary, seed: seed + 1, kind: 'twill', threads: 64, tileMetres: 0.3, fuzz: 0.35 });
      // Obi and headband are cut from the same bolt, so they are the same
      // texture — one upload, and they will read as a matched set on screen.
      garments.obi = cottonCanvas({ color: p.accent, seed: seed + 2, kind: 'basket', threads: 36, tileMetres: 0.18, relief: 1.3, mottle: 0.7 });
      garments.headband = garments.obi;
      boots = leather({ color: p.boots, seed, creases: 0.7, wear: 0.4, roughness: 0.55 });
      break;

    case 'mali':
      hair = hairStrands({ color: p.hair, sheenColor: p.hairSheen, style: 'braid', seed, segments: 3, strands: 44 });
      // Compression knit: fine, smooth, and shinier than any woven cotton.
      garments.bra = cottonCanvas({ color: p.primary, seed, kind: 'plain', threads: 110, tileMetres: 0.14, fuzz: 0.12, roughness: 0.6, relief: 0.6 });
      garments.shorts = satinFabric({ color: p.secondary, seed, direction: 'u', roughness: 0.2, creases: 0.4 });
      garments.trim = satinFabric({ color: p.accent, seed: seed + 1, direction: 'v', roughness: 0.26, creases: 0.15 });
      break;

    case 'davi':
      hair = hairStrands({ color: p.hair, sheenColor: p.hairSheen, style: 'locs', seed, strands: 11, twist: 7 });
      garments.hoodie = cottonCanvas({ color: p.primary, seed, kind: 'plain', threads: 44, tileMetres: 0.22, fuzz: 0.85, roughness: 0.9 });
      // Abadá is a heavy cotton drill — coarse enough to see across the ring.
      garments.abada = cottonCanvas({ color: p.secondary, seed: seed + 1, kind: 'basket', threads: 40, tileMetres: 0.26, mottle: 0.7 });
      garments.cuffs = ribbedKnit({ color: p.accent, seed, ribs: 14, courses: 20 });
      garments.stripe = cottonCanvas({ color: p.accent, seed: seed + 2, kind: 'basket', threads: 40, tileMetres: 0.26 });
      break;

    default:
      hair = hairStrands({ color: p.hair, sheenColor: p.hairSheen, style: 'braid', seed, segments: 4, strands: 38, variation: 0.65 });
      garments.vest = quiltedFabric({
        color: p.primary,
        seed,
        pattern: 'channel',
        cells: 6,
        puff: 0.78,
        seamDepth: 0.55,
        stitch: true,
        ripstop: true,
        tileMetres: 0.5,
      });
      garments.collar = ribbedKnit({ color: p.primary, seed: seed + 5, ribs: 18, courses: 24, tileMetres: 0.1 });
      garments.top = cottonCanvas({ color: p.secondary, seed: seed + 1, kind: 'plain', threads: 96, tileMetres: 0.16, fuzz: 0.2, relief: 0.7 });
      garments.shorts = cottonCanvas({ color: p.accent, seed: seed + 2, kind: 'twill', threads: 104, tileMetres: 0.2, fuzz: 0.1, roughness: 0.72, relief: 0.6 });
      boots = leather({ color: p.boots, seed, creases: 0.85, wear: 0.65, grain: 48, roughness: 0.52 });
      break;
  }

  return boots ? { skin, hair, garments, wrap, boots } : { skin, hair, garments, wrap };
}
