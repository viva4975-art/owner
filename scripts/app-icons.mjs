// Erzeugt die App-Icons (PWA, App Store, Play Store) aus HTML: Bordeaux-Kachel mit „VD“.
// Aufruf: node scripts/app-icons.mjs  → assets/web/app-icon-{192,512}.png, app-icon-maskable-512.png, apple-touch-icon.png
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const font = readFileSync(new URL('../assets/web/inter-latin.woff2', import.meta.url)).toString('base64');
const html = (size, pad) => `<!doctype html><html><head><style>
@font-face{font-family:Inter;font-weight:100 900;src:url(data:font/woff2;base64,${font}) format("woff2")}
html,body{margin:0;width:${size}px;height:${size}px;background:#7D1435}
.c{position:absolute;inset:${pad}px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-family:Inter}
.l{font-weight:800;font-size:${size * 0.34}px;letter-spacing:-${size * 0.012}px;line-height:1}
.s{font-weight:600;font-size:${size * 0.075}px;letter-spacing:${size * 0.01}px;margin-top:${size * 0.04}px;opacity:.9;text-transform:uppercase}
</style></head><body><div class="c"><div class="l">VD</div><div class="s">Viva-Deluxe</div></div></body></html>`;

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
for (const [name, size, pad] of [
  ['app-icon-192.png', 192, 0],
  ['app-icon-512.png', 512, 0],
  ['app-icon-maskable-512.png', 512, 64], // Inhalt in der sicheren Zone (80 %)
  ['apple-touch-icon.png', 180, 0],
]) {
  const p = await browser.newPage({ viewport: { width: size, height: size } });
  await p.setContent(html(size, pad));
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: `assets/web/${name}` });
  await p.close();
}
await browser.close();
console.log('Icons geschrieben.');
