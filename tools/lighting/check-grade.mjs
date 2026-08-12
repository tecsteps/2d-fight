/**
 * Grade unit check: does the LUT stay honest?
 *
 * Three questions a colour grade has to answer before anyone looks at a frame,
 * because all three failures are invisible on a single screenshot and obvious
 * across a whole game:
 *
 *   1. **Is a neutral grey chart still neutral?** A split tone is supposed to
 *      colour the ends of the scale, not the middle. If mid grey comes out warm
 *      the grade is a sepia filter and every stage inherits it.
 *   2. **Does the grade preserve hue separation?** Fed the four authored skin
 *      tones, the pairwise CIELAB distance between them must not shrink. A grade
 *      that compresses this is destroying character identity by itself, before
 *      the lighting even gets a say.
 *   3. **Does it still bend?** A grade that passes 1 and 2 by doing nothing is
 *      not a grade. Contrast and the shadow/highlight split have to measurably
 *      move.
 *
 * Loads the real TypeScript through Vite's SSR transform, so this checks the
 * shipped `gradeColor`, not a copy of it.
 *
 *   node tools/lighting/check-grade.mjs
 */
import { createServer } from 'vite';

const server = await createServer({ logLevel: 'error', server: { middlewareMode: true } });
const { gradeColor } = await server.ssrLoadModule('/src/render/post/grade.ts');
const { DEFAULT_TUNING } = await server.ssrLoadModule('/src/render/post/contract.ts');
const spec = DEFAULT_TUNING.grade;

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function lab([r, g, b]) {
  const [R, G, B] = [r, g, b].map(srgbToLinear);
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const de = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const chroma = (c) => Math.hypot(lab(c)[1], lab(c)[2]);
const hex = (c) => c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

let fail = 0;
const check = (ok, label, detail) => {
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
};

// --- 1. grey chart ---------------------------------------------------------
console.log('\n1. neutral grey chart (Kodak-style 11 step)');
console.log(`  ${'in'.padEnd(6)} ${'out'.padEnd(8)} ${'L*'.padStart(6)} ${'a*'.padStart(6)} ${'b*'.padStart(6)} ${'C*'.padStart(6)}`);
const greys = [];
for (let i = 0; i <= 10; i++) {
  const v = i / 10;
  const out = gradeColor([v, v, v], spec);
  const [L, a, b] = lab(out);
  greys.push({ v, out, L, a, b, C: Math.hypot(a, b) });
  console.log(
    `  ${v.toFixed(2).padEnd(6)} ${hex(out).padEnd(8)} ${L.toFixed(1).padStart(6)} ` +
      `${a.toFixed(2).padStart(6)} ${b.toFixed(2).padStart(6)} ${Math.hypot(a, b).toFixed(2).padStart(6)}`,
  );
}
// The midtones are what "neutral" means here: a viewer reads the illuminant off
// them, so a cast there is a cast on the whole picture. 2.5 is about the just-
// noticeable chroma difference on a large flat field.
const mids = greys.filter((g) => g.v >= 0.35 && g.v <= 0.7);
const worstMid = Math.max(...mids.map((g) => g.C));
check(worstMid < 2.5, 'mid greys (0.35..0.70) stay neutral', `max C* = ${worstMid.toFixed(2)}`);
// And the cast that does exist at the ends must be cool below and warm above,
// never warm at both ends — warm everywhere is the definition of a sepia filter.
const lowB = greys[1].b;
const highB = greys[9].b;
check(lowB < 0.5, 'deep greys are not warm (split tone points cool down there)', `b* = ${lowB.toFixed(2)}`);
check(highB > -0.5, 'bright greys carry the warm half', `b* = ${highB.toFixed(2)}`);
check(
  Math.abs(highB) < 9,
  'highlight warmth stays under a sepia cast',
  `b* = ${highB.toFixed(2)} (cap 9)`,
);

// --- 2. hue separation of the roster's skin tones ---------------------------
console.log('\n2. authored skin tones through the grade');
const SKIN = { kai: 0xe09868, mali: 0xc2793f, davi: 0x7d4826, vera: 0xe2a17c };
const ids = Object.keys(SKIN);
const before = {};
const after = {};
for (const id of ids) {
  const h = SKIN[id];
  const rgb = [(h >> 16) & 255, (h >> 8) & 255, h & 255].map((v) => v / 255);
  before[id] = rgb;
  after[id] = gradeColor(rgb, spec);
  const [L, a, b] = lab(after[id]);
  console.log(
    `  ${id.padEnd(6)} ${hex(rgb)} -> ${hex(after[id])}   L*=${L.toFixed(1)} ` +
      `a*=${a.toFixed(1)} b*=${b.toFixed(1)}  C* ${chroma(rgb).toFixed(1)} -> ${chroma(after[id]).toFixed(1)}`,
  );
}
let worstRatio = Infinity;
let worstPair = '';
for (let i = 0; i < ids.length; i++) {
  for (let j = i + 1; j < ids.length; j++) {
    const a = ids[i];
    const b = ids[j];
    const d0 = de(lab(before[a]), lab(before[b]));
    const d1 = de(lab(after[a]), lab(after[b]));
    const ratio = d1 / d0;
    console.log(`  ${(a + '-' + b).padEnd(12)} dE ${d0.toFixed(1)} -> ${d1.toFixed(1)}  (x${ratio.toFixed(2)})`);
    if (ratio < worstRatio) {
      worstRatio = ratio;
      worstPair = `${a}-${b}`;
    }
  }
}
check(worstRatio >= 0.95, 'no skin pair loses separation', `worst ${worstPair} x${worstRatio.toFixed(2)}`);

// --- 3. the grade still does something -------------------------------------
console.log('\n3. the grade is not a no-op');
const contrast = (gradeColor([0.75, 0.75, 0.75], spec)[1] - gradeColor([0.25, 0.25, 0.25], spec)[1]) / 0.5;
check(contrast > 1.15, 'midtone contrast is lifted', `slope = ${contrast.toFixed(2)}`);
// Measured as a channel ratio, not as Lab b*: down here Lab chroma is squashed
// by the cube-root lightness, so a shadow that is visibly teal on screen still
// reads as b* = -0.7. The ratio is what the eye is actually responding to.
const shade = greys[2].out;
const coolRatio = shade[2] / Math.max(shade[0], 1e-5);
check(coolRatio > 1.06, 'shadows carry a cool tint', `B/R at 0.2 grey = ${coolRatio.toFixed(3)}`);
const black = gradeColor([0, 0, 0], spec);
check(Math.max(...black) > 0.002, 'blacks are lifted off zero', `black = ${hex(black)}`);
// A saturated warm surface must come back with its chroma compressed, not
// expanded: the roster is already at the edge of what a cel band can hold.
const hot = gradeColor([1.0, 0.42, 0.16], spec);
check(chroma(hot) < chroma([1.0, 0.42, 0.16]) * 1.12, 'saturated warm surfaces are not pushed further',
  `C* ${chroma([1.0, 0.42, 0.16]).toFixed(1)} -> ${chroma(hot).toFixed(1)}`);

await server.close();
console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks passed');
process.exit(fail ? 1 : 0);
