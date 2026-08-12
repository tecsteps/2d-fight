/**
 * Shoots the face-inspection grid at several yaws in one page load.
 *
 *   node tools/faceshot/capture.mjs [--tag face] [--yaws 0,0.6,1.35] [--query hair=1]
 *                                   [--expr '{"squint":0.7}'] [--w 1920] [--h 620]
 *
 * Writes to `shots/face/<tag>-y<yaw>.png`. Starts and stops its own vite server,
 * so it always returns.
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
const ROOT = '/home/user/2d-fight';
const TAG = args.tag ?? 'face';
const YAWS = String(args.yaws ?? '0,0.55,1.45').split(',').map(Number);
const EXPR = args.expr ?? '';
const OUT = args.out ?? path.join(ROOT, 'shots/face');
const W = parseInt(args.w ?? '1920', 10);
const H = parseInt(args.h ?? '620', 10);

const server = await createServer({
  root: ROOT,
  server: { port: 5211, strictPort: true, host: '127.0.0.1' },
  logLevel: 'error',
});
await server.listen();

const q = new URLSearchParams({ w: String(W), h: String(H) });
for (const kv of String(args.query ?? '').split(',')) {
  if (!kv) continue;
  const [k, v] = kv.split('=');
  q.set(k, v ?? '1');
}
const url = `http://127.0.0.1:5211/tools/faceshot/face.html?${q}`;

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
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  else if (String(args.log ?? '') === '1') console.log('   [page]', m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__face?.ready === true, null, { timeout: 90_000 });
// Vite's dep optimizer can force a full reload right after the first load, which
// destroys the execution context mid-evaluate. Settle before driving anything.
await page.waitForTimeout(1500);
await page.waitForFunction(() => window.__face?.ready === true, null, { timeout: 90_000 });
await mkdir(OUT, { recursive: true });

if (EXPR) {
  await page.evaluate((e) => window.__face.expr(JSON.parse(e)), EXPR);
}

for (const y of YAWS) {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.evaluate((yy) => window.__face.setYaw(yy), y);
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
      await page.waitForFunction(() => window.__face?.ready === true, null, { timeout: 90_000 });
    }
  }
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  const buf = await page.locator('#stage').screenshot();
  const name = `${TAG}-y${String(Math.round(y * 100)).padStart(3, '0')}.png`;
  await writeFile(path.join(OUT, name), buf);
  console.log('wrote', path.join(OUT, name));
}

if (errors.length) {
  console.error('\nPage errors:');
  for (const e of errors.slice(0, 25)) console.error('  ' + e);
}
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
