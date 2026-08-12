/**
 * Headless screenshot harness.
 *
 * Boots the production build in Chromium, drives the `__fight` harness to exact
 * simulation frames, and writes deterministic PNGs to `shots/`. Determinism is
 * the point: the critic compares successive runs, so an identical build must
 * produce identical pixels or every comparison is noise.
 *
 *   node tools/shots/capture.mjs [--frames 0,60,120] [--width 1920] [--out shots]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) =>
    a.startsWith('--') ? [[a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]] : [],
  ),
);

const FRAMES = String(args.frames ?? '0,45,90,150').split(',').map((n) => parseInt(n, 10));
const WIDTH = parseInt(args.width ?? '1920', 10);
const HEIGHT = parseInt(args.height ?? '1080', 10);
const OUT = args.out ?? 'shots';
const TAG = args.tag ?? 'frame';

const SCENE = args.scene ?? 'lineup';
const FIGHTER = args.fighter ?? '';
const POST = args.post ?? '1';
// Fighters as flat white on black, no stage, no post — the mask
// `tools/critic/measure.py --matte` needs to know which pixels are fighter
// without guessing from brightness. Shoot it alongside the look frame at the
// same size and frame numbers.
const MATTE = args.matte === true || args.matte === '1';

const server = await createServer({
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
  logLevel: 'error',
});
await server.listen();
const q = new URLSearchParams({ scene: SCENE, post: POST });
if (FIGHTER) q.set('fighter', FIGHTER);
if (MATTE) q.set('matte', '1');
const url = `http://127.0.0.1:5199/?${q}`;

// The container ships a Chromium build that may not match the revision this
// Playwright wants. Point straight at it rather than downloading — the image is
// explicitly configured to forbid `playwright install`.
const CHROME =
  process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [
    // Software rendering would give us a blank canvas; force real GL.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-lcd-text',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
  ],
});

const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
});

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__fight?.ready === true, null, { timeout: 45_000 });

await mkdir(OUT, { recursive: true });

for (const f of FRAMES) {
  await page.evaluate((frame) => window.__fight.seek(frame), f);
  // One rAF so the composited frame matches the canvas we just drew.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  const buf = await page.locator('#stage').screenshot();
  const file = path.join(OUT, `${TAG}-${String(f).padStart(4, '0')}.png`);
  await writeFile(file, buf);
  console.log(`wrote ${file}`);
}

if (errors.length) {
  console.error('\nPage errors:');
  for (const e of errors.slice(0, 20)) console.error('  ' + e);
}

await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
