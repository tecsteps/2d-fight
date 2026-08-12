import * as THREE from 'three';
import { TexSet, textureStats } from './texture';
import { bandageWrap, cottonCanvas, quiltedFabric, ribbedKnit, satinFabric } from './fabric';
import { skinDetail } from './skin';
import { hairStrands } from './hair';
import { leather } from './leather';
import { asphalt, brick, clothBanner, concrete, paintedMetal, wornWood } from './stage';

/**
 * Contact sheet of every generated map, as scene geometry.
 *
 * This is a **dev tool**, never part of a game frame: it exists so the
 * screenshot harness can capture the whole texture library in one shot and a
 * critic can be asked "which of these is not fabric?". Two things it is
 * deliberately built to expose:
 *
 * - **seams**, by drawing every quad with UVs running 0..N so any wrap
 *   discontinuity appears as a hard cross through the middle of the tile;
 * - **the maps that are not albedo**, because a weave that looks right in
 *   colour and wrong in its normal will look wrong the moment it is lit.
 *
 * Labels are drawn to a canvas with a generic system font. No font file is
 * fetched, and nothing here ships in the game build.
 */

export interface DebugSheetEntry {
  label: string;
  set: TexSet;
}

export interface DebugSheetOptions {
  /** Which sets to show. Defaults to one of everything. */
  entries?: DebugSheetEntry[];
  /** UV repeats per quad. 2 makes a seam unmissable. */
  tiling?: number;
  /** Quad edge length in world units. */
  quad?: number;
  gap?: number;
  /** Include roughness and aux maps, not just albedo and normal. */
  full?: boolean;
}

/** One of every generator, tuned the way the roster and stages actually use them. */
export function defaultDebugSets(): DebugSheetEntry[] {
  return [
    { label: 'gi twill (kai)', set: cottonCanvas({ color: 0x1b2c44, kind: 'twill', threads: 56, tileMetres: 0.25 }) },
    { label: 'abada canvas (davi)', set: cottonCanvas({ color: 0xece5d5, kind: 'basket', threads: 48, fuzz: 0.7 }) },
    { label: 'quilted vest (vera)', set: quiltedFabric({ color: 0xb44a1b, pattern: 'channel', cells: 6 }) },
    { label: 'quilted diamond', set: quiltedFabric({ color: 0x2e3138, pattern: 'diamond', cells: 5, puff: 0.55 }) },
    { label: 'satin shorts (mali)', set: satinFabric({ color: 0x16161a, direction: 'u' }) },
    { label: 'rib knit cuff', set: ribbedKnit({ color: 0x1e50b4, ribs: 16 }) },
    { label: 'hand wrap (kai)', set: bandageWrap({ color: 0xe8e2d6, bandsU: 1, bandsV: 4 }) },
    { label: 'hand wrap (mali)', set: bandageWrap({ color: 0xa8281c, bandsU: 1, bandsV: 3, grime: 0.5 }) },
    { label: 'skin (vera)', set: skinDetail({ tone: 0xe2a17c, sss: 0xd4674a, freckles: 0.55 }) },
    { label: 'skin (davi)', set: skinDetail({ tone: 0x7d4826, sss: 0x8e3a1c, sweat: 0.6 }) },
    { label: 'hair strands (kai)', set: hairStrands({ color: 0x1c1c24, sheenColor: 0x4d4d63, style: 'strand' }) },
    { label: 'locs (davi)', set: hairStrands({ color: 0x1b1418, sheenColor: 0x54402f, style: 'locs' }) },
    { label: 'braid (mali)', set: hairStrands({ color: 0x14100f, sheenColor: 0x4a3b34, style: 'braid' }) },
    { label: 'boot leather (vera)', set: leather({ color: 0x6e2129, wear: 0.6 }) },
    { label: 'concrete', set: concrete() },
    { label: 'worn wood', set: wornWood() },
    { label: 'painted metal', set: paintedMetal() },
    { label: 'brick', set: brick() },
    { label: 'banner cloth', set: clothBanner({ stripes: 4 }) },
    { label: 'asphalt', set: asphalt() },
  ];
}

/** Plane whose UVs run 0..`tiling`, so the wrap is under test rather than hidden. */
function tiledQuad(size: number, tiling: number): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(size, size);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * tiling, uv.getY(i) * tiling);
  uv.needsUpdate = true;
  return geo;
}

function labelTexture(text: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, 512, 64);
    ctx.fillStyle = '#000000';
    ctx.globalAlpha = 0.55;
    ctx.fillRect(0, 0, 512, 64);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#e8e8ec';
    ctx.font = '600 34px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 10, 34);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function quad(map: THREE.Texture, geo: THREE.PlaneGeometry, x: number, y: number): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({ map, toneMapped: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, 0);
  return mesh;
}

/**
 * Builds the sheet. One row per generator: albedo, normal, roughness, then any
 * aux maps, each labelled.
 */
export function textureDebugSheet(opts: DebugSheetOptions = {}): THREE.Group {
  const entries = opts.entries ?? defaultDebugSets();
  const tiling = opts.tiling ?? 2;
  const q = opts.quad ?? 1;
  const gap = opts.gap ?? 0.12;
  const full = opts.full ?? true;

  const group = new THREE.Group();
  group.name = 'texture-debug-sheet';
  const geo = tiledQuad(q, tiling);
  const labelGeo = new THREE.PlaneGeometry(q, q * 0.125);

  entries.forEach((entry, row) => {
    const maps: { name: string; tex: THREE.Texture }[] = [
      { name: 'albedo', tex: entry.set.map },
      { name: 'normal', tex: entry.set.normalMap },
    ];
    if (full && entry.set.roughnessMap) maps.push({ name: 'rough', tex: entry.set.roughnessMap });
    if (full && entry.set.aux) {
      for (const key of Object.keys(entry.set.aux)) maps.push({ name: key, tex: entry.set.aux[key] });
    }

    const y = -row * (q + gap * 3);
    maps.forEach((m, col) => {
      const x = col * (q + gap);
      group.add(quad(m.tex, geo, x, y));
      const label = new THREE.Mesh(labelGeo, new THREE.MeshBasicMaterial({
        map: labelTexture(col === 0 ? `${entry.label} — ${m.name}` : m.name),
        transparent: true,
        toneMapped: false,
      }));
      label.position.set(x, y - q * 0.5 - q * 0.075, 0.001);
      group.add(label);
    });
  });

  return group;
}

/**
 * Text report for the screenshot harness and for eyeballing in a console.
 *
 * `seam` is the ratio of the step across the tile's wrap edge to an ordinary
 * step inside it: 1.0 is perfect, and anything past about 1.5 is a seam a
 * player would see on a repeating stage surface.
 */
export function textureSheetReport(entries = defaultDebugSets()): string[] {
  const lines = entries.map((e) => {
    const aux = e.set.aux ? Object.keys(e.set.aux).join('+') : '-';
    const seam = e.set.seam === undefined ? '?' : e.set.seam.toFixed(2);
    return `${e.label.padEnd(22)} ${String(e.set.size).padStart(5)}px  tile ${e.set.tileMetres}m  seam ${seam}  aux ${aux}`;
  });
  const stats = textureStats();
  lines.push(`${'TOTAL'.padEnd(22)} ${stats.textures} textures, ~${(stats.bytes / 1048576).toFixed(1)} MB`);
  return lines;
}
