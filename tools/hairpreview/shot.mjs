/**
 * Scratch capture for the hair preview page. Same mechanics as
 * tools/shots/capture.mjs, pointed at tools/hairpreview/index.html.
 *
 *   node tools/hairpreview/shot.mjs --fighter kai --view head --tag kai-head
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

const WIDTH = parseInt(args.width ?? '1280', 10);
const HEIGHT = parseInt(args.height ?? '1280', 10);
const OUT = args.out ?? 'shots';
const TAG = args.tag ?? 'hair';

const server = await createServer({
  server: { port: 5207, strictPort: true, host: '127.0.0.1' },
  logLevel: 'error',
});
await server.listen();

const q = new URLSearchParams();
for (const k of ['fighter', 'view', 'yaw', 'pose', 'post']) if (args[k]) q.set(k, args[k]);
const url = `http://127.0.0.1:5207/tools/hairpreview/index.html?${q}`;

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
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });

const errors = [];
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  else logs.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__fight?.ready === true, null, { timeout: 60_000 });
await page.evaluate(() => window.__fight.seek(0));
await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));

await mkdir(OUT, { recursive: true });
const file = path.join(OUT, `${TAG}.png`);
await writeFile(file, await page.locator('#stage').screenshot());
console.log(`wrote ${file}`);
for (const l of logs.slice(0, 20)) console.log('  log: ' + l);
if (errors.length) {
  console.error('Page errors:');
  for (const e of errors.slice(0, 20)) console.error('  ' + e);
}

await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
