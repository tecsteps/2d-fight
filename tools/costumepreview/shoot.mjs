/**
 * Screenshots the costume preview.
 *
 *   node tools/costumepreview/shoot.mjs [--fighter kai] [--views front,three,side,back]
 *
 * Own harness rather than `tools/shots/capture.mjs`, because that one drives the
 * game's scene list and this needs a page that does not exist there yet.
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

const FIGHTER = args.fighter ?? 'kai';
const VIEWS = String(args.views ?? 'front,three,side,back').split(',');
const WIDTH = parseInt(args.width ?? '900', 10);
const HEIGHT = parseInt(args.height ?? '1400', 10);
const OUT = args.out ?? 'shots';
const TAG = args.tag ?? 'costume';

const server = await createServer({
  server: { port: 5203, strictPort: true, host: '127.0.0.1' },
  logLevel: 'error',
});
await server.listen();

const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-lcd-text',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
  ],
});

await mkdir(OUT, { recursive: true });
let failed = false;

for (const view of VIEWS) {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  const url = `http://127.0.0.1:5203/tools/costumepreview/index.html?fighter=${FIGHTER}&view=${view}`;
  await page.goto(url, { waitUntil: 'networkidle' });
  try {
    await page.waitForFunction(() => window.__fight?.ready === true, null, { timeout: 60_000 });
  } catch (e) {
    console.error(`[${view}] never became ready`, errors);
    failed = true;
    await page.close();
    continue;
  }
  const stats = await page.evaluate(() => window.__fight.stats);
  if (args.boxes) {
    for (const b of await page.evaluate(() => window.__fight.boxes))
      console.log(`   ${b.name.padEnd(16)} size ${b.x} x ${b.y} x ${b.z}   centre x${b.cx} y${b.cy}`);
  }
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  const file = path.join(OUT, `${TAG}-${FIGHTER}-${view}.png`);
  await writeFile(file, await page.locator('#stage').screenshot());
  console.log(`${file}  pieces=${stats.pieces} tris=${stats.triangles}`);
  if (errors.length) {
    console.error(`[${view}] console errors:`, errors.slice(0, 6));
    failed = true;
  }
  await page.close();
}

await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
