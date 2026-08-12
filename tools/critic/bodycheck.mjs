/**
 * Body mesh unit check: manifold, budget, skin weights.
 *
 * Three properties the body has to hold that a screenshot can never show, and
 * all three break silently:
 *
 *   1. **Closed genus-0 manifold.** Euler characteristic 2, zero boundary
 *      edges, every edge shared by exactly two faces. The ink pass extrudes an
 *      inverted hull along welded normals — a hole or a T-junction shows up as
 *      a spike of black in one frame of an animation and is essentially
 *      impossible to find after the fact.
 *   2. **Triangle budget.** Two fighters on screen at 60 fps at 1080p.
 *   3. **Skin weights sum to 1 with no NaN**, and every vertex is claimed. A
 *      vertex whose weights sum to 0.9 shrinks toward the origin under GPU
 *      skinning — visible only once the fighter moves.
 *
 * Runs the shipped TypeScript through Vite's SSR transform, so it checks the
 * real builder rather than a copy of it.
 *
 *   node tools/critic/bodycheck.mjs
 */
import { createServer } from 'vite';

const server = await createServer({ logLevel: 'error', server: { middlewareMode: true } });
const { ROSTER } = await server.ssrLoadModule('/src/data/roster/index.ts');
const { rigMetrics, restJoints } = await server.ssrLoadModule('/src/anim/Skeleton.ts');
const { buildBodyPlan, buildBodyGeometry } = await server.ssrLoadModule('/src/art/characters/body.ts');

const rows = [];
let bad = 0;

for (const def of ROSTER) {
  const m = rigMetrics(def);
  const j = restJoints(m);
  const t0 = Date.now();
  const plan = buildBodyPlan(m, j);
  const built = buildBodyGeometry(plan, {});
  const ms = Date.now() - t0;

  const idx = built.geometry.getIndex().array;
  const pos = built.geometry.getAttribute('position').array;
  const nv = built.geometry.getAttribute('position').count;
  const tris = idx.length / 3;

  // Weld first: the UV seam is split into duplicate vertices at the very end of
  // the build, so the index buffer is topologically torn along the spine even
  // though the surface is not. Weld on position and the real topology is back.
  const key = new Map();
  const weld = new Int32Array(nv);
  const q = 1e-6;
  for (let i = 0; i < nv; i++) {
    const k = `${Math.round(pos[i * 3] / q)},${Math.round(pos[i * 3 + 1] / q)},${Math.round(pos[i * 3 + 2] / q)}`;
    let w = key.get(k);
    if (w === undefined) { w = key.size; key.set(k, w); }
    weld[i] = w;
  }
  const V = key.size;

  const edges = new Map();
  let degenerate = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = weld[idx[t]], b = weld[idx[t + 1]], c = weld[idx[t + 2]];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = u < v ? `${u}_${v}` : `${v}_${u}`;
      const e = edges.get(k);
      if (e) { e.n++; e.dir += u < v ? 1 : -1; } else edges.set(k, { n: 1, dir: u < v ? 1 : -1 });
    }
  }
  let boundary = 0, nonManifold = 0, misoriented = 0;
  for (const e of edges.values()) {
    if (e.n === 1) boundary++;
    else if (e.n > 2) nonManifold++;
    else if (e.dir !== 0) misoriented++;
  }
  const F = tris - degenerate;
  const E = edges.size;
  const euler = V - E + F;

  // Skin weights.
  const sw = built.geometry.getAttribute('skinWeight').array;
  let worstSum = 0, nan = 0, empty = 0;
  for (let i = 0; i < nv; i++) {
    let s = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw[i * 4 + k];
      if (!Number.isFinite(w)) { nan++; continue; }
      s += w;
    }
    if (s <= 0) empty++;
    worstSum = Math.max(worstSum, Math.abs(s - 1));
  }

  const ok =
    euler === 2 && boundary === 0 && nonManifold === 0 && misoriented === 0 &&
    nan === 0 && empty === 0 && worstSum < 1e-4 && tris <= 26000;
  if (!ok) bad++;

  rows.push({ id: def.id, V, E, F, euler, boundary, nonManifold, misoriented, degenerate,
              tris, nan, empty, worstSum, ms, ok });
}

console.log('');
console.log('  id      tris     V      E      F   euler  bdry  nonman  misor   degen  wsum-err   ms   ');
console.log('  ' + '-'.repeat(94));
for (const r of rows) {
  console.log(
    `  ${r.id.padEnd(6)}${String(r.tris).padStart(6)}${String(r.V).padStart(7)}` +
    `${String(r.E).padStart(7)}${String(r.F).padStart(7)}${String(r.euler).padStart(8)}` +
    `${String(r.boundary).padStart(6)}${String(r.nonManifold).padStart(8)}` +
    `${String(r.misoriented).padStart(7)}${String(r.degenerate).padStart(8)}` +
    `${r.worstSum.toExponential(1).padStart(11)}` +
    `${String(r.ms).padStart(6)}  ${r.ok ? 'OK' : 'FAIL'}`,
  );
}
console.log('\n  euler must be 2, bdry/nonman/misor must be 0, tris <= 26000\n');

await server.close();
process.exit(bad ? 1 : 0);
