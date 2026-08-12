/**
 * Roster definitions.
 *
 * Everything here is *authored data*, not art. The procedural character builder
 * in `src/art/characters` reads these palettes and proportions and generates the
 * meshes, materials and textures from scratch. No reference image is ever
 * sampled — the numbers below were eyedropped by hand from the design sheets in
 * `/reference` and then tuned for how they read under the game's lighting.
 *
 * Colours are authored in **linear-ish sRGB hex** as they should appear on
 * screen; the material builder converts to working space.
 */

export interface Palette {
  /** Base skin tone in full light. */
  skin: number;
  /** Skin in shadow — not just a darker skin, it shifts toward the ambient. */
  skinShadow: number;
  /** Subsurface tint that bleeds through thin areas (ears, fingers). */
  skinSSS: number;
  hair: number;
  hairSheen: number;
  /** Primary costume colour — the one you'd name the character by. */
  primary: number;
  /** Secondary costume colour. */
  secondary: number;
  /** Small accent: trim, laces, ties. */
  accent: number;
  /** Wraps / tape / bandage. */
  wrap: number;
  /** Footwear, or a second accent for barefoot fighters. */
  boots: number;
  /** The colour of this fighter's energy: hitsparks, aura, super flash. */
  energy: number;
  /** Rim-light colour used to separate them from the stage. */
  rim: number;
}

export type Archetype = 'grappler' | 'rushdown' | 'striker' | 'shoto';

export interface Proportions {
  /** Total height in world units (metres). */
  height: number;
  /** Shoulder width relative to height. */
  shoulder: number;
  /** Hip width relative to height. */
  hip: number;
  /** Overall muscle mass, 0 = lean, 1 = heavily built. */
  build: number;
  /** Leg length as a fraction of total height. */
  legRatio: number;
  /** Head size as a fraction of height — lower = more heroic/stylised. */
  headRatio: number;
}

export interface FighterDef {
  id: string;
  name: string;
  /** Shown under the name on the select screen. */
  epithet: string;
  archetype: Archetype;
  /** Discipline, for flavour text and move naming. */
  style: string;
  palette: Palette;
  proportions: Proportions;
  /** Directory under /reference holding this fighter's design sheets. */
  referenceDir: string;
  /** Base health. KOF-ish range is 1000 ± 15%. */
  health: number;
  /** Walk / run / jump tuning, in world units per frame. */
  walkFwd: number;
  walkBack: number;
  runSpeed: number;
  jumpHeight: number;
  /** Mass affects how far they get knocked back and how fast they fall. */
  weight: number;
  /** Barefoot fighters get no shoe geometry and different footstep audio. */
  barefoot: boolean;
}

export const VERA: FighterDef = {
  id: 'vera',
  name: 'VERA',
  epithet: 'The Iron Clinch',
  archetype: 'grappler',
  style: 'Catch Wrestling',
  referenceDir: 'vera',
  palette: {
    skin: 0xe2a17c,
    skinShadow: 0xa9694f,
    skinSSS: 0xd4674a,
    hair: 0xa8481f,
    hairSheen: 0xd8763c,
    primary: 0xb44a1b, // burnt-orange quilted vest
    secondary: 0x4a2c42, // plum crop top
    accent: 0x2e3138, // charcoal compression shorts
    wrap: 0xded6c6, // hand wraps
    boots: 0x6e2129, // maroon wrestling boots
    energy: 0xff8a3c,
    rim: 0xffc98a,
  },
  proportions: {
    height: 1.74,
    shoulder: 0.255,
    hip: 0.205,
    build: 0.82,
    legRatio: 0.49,
    headRatio: 0.125,
  },
  health: 1150,
  walkFwd: 0.0295,
  walkBack: 0.0235,
  runSpeed: 0.052,
  jumpHeight: 2.05,
  weight: 1.18,
  barefoot: false,
};

export const DAVI: FighterDef = {
  id: 'davi',
  name: 'DAVI',
  epithet: 'Ginga Unbroken',
  archetype: 'rushdown',
  style: 'Capoeira Regional',
  referenceDir: 'davi',
  palette: {
    skin: 0x7d4826,
    skinShadow: 0x4b2916,
    skinSSS: 0x8e3a1c,
    hair: 0x1b1418,
    hairSheen: 0x54402f,
    primary: 0xe0a318, // gold cropped hoodie
    secondary: 0xece5d5, // cream abadá
    accent: 0x1e50b4, // blue stripe, cord, wraps
    wrap: 0x1e50b4,
    boots: 0x7d4826, // barefoot — reuse skin
    energy: 0x4ec3ff,
    rim: 0xffd98a,
  },
  proportions: {
    height: 1.83,
    shoulder: 0.238,
    hip: 0.178,
    build: 0.55,
    legRatio: 0.535,
    headRatio: 0.118,
  },
  health: 980,
  walkFwd: 0.0345,
  walkBack: 0.029,
  runSpeed: 0.066,
  jumpHeight: 2.35,
  weight: 0.92,
  barefoot: true,
};

export const MALI: FighterDef = {
  id: 'mali',
  name: 'MALI',
  epithet: 'Eight Limbs',
  archetype: 'striker',
  style: 'Muay Thai',
  referenceDir: 'mali',
  palette: {
    skin: 0xc2793f,
    skinShadow: 0x8a4d26,
    skinSSS: 0xb8451f,
    hair: 0x14100f,
    hairSheen: 0x4a3b34,
    primary: 0x1f4a38, // teal sports bra
    secondary: 0x16161a, // black satin shorts
    accent: 0xc9a227, // gold trim
    wrap: 0xa8281c, // red hand and ankle wraps
    boots: 0xc2793f, // barefoot
    energy: 0xff4a2e,
    rim: 0xffb26a,
  },
  proportions: {
    height: 1.71,
    shoulder: 0.228,
    hip: 0.19,
    build: 0.62,
    legRatio: 0.515,
    headRatio: 0.12,
  },
  health: 1000,
  walkFwd: 0.0315,
  walkBack: 0.0265,
  runSpeed: 0.058,
  jumpHeight: 2.18,
  weight: 1.0,
  barefoot: true,
};

export const KAI: FighterDef = {
  id: 'kai',
  name: 'KAI',
  epithet: 'Sudden Stillness',
  archetype: 'shoto',
  style: 'Full-Contact Karate',
  referenceDir: 'kai',
  palette: {
    skin: 0xe09868,
    skinShadow: 0xa3623c,
    skinSSS: 0xcf5c3a,
    hair: 0x1c1c24,
    hairSheen: 0x4d4d63,
    primary: 0x1b2c44, // navy sleeveless wrap gi
    secondary: 0x33353c, // charcoal calf-length pants
    accent: 0xd05a18, // orange obi, headband, ankle wraps
    wrap: 0xe8e2d6, // white hand wraps
    boots: 0x1e3050, // navy shoes
    energy: 0x5cc8ff,
    rim: 0xa8d8ff,
  },
  proportions: {
    height: 1.78,
    shoulder: 0.242,
    hip: 0.185,
    build: 0.63,
    legRatio: 0.515,
    headRatio: 0.12,
  },
  health: 1020,
  walkFwd: 0.032,
  walkBack: 0.027,
  runSpeed: 0.059,
  jumpHeight: 2.2,
  weight: 1.0,
  barefoot: false,
};

export const ROSTER: readonly FighterDef[] = [KAI, MALI, DAVI, VERA];

export function fighterById(id: string): FighterDef {
  const f = ROSTER.find((r) => r.id === id);
  if (!f) throw new Error(`Unknown fighter: ${id}`);
  return f;
}
