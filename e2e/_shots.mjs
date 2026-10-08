import { chromium } from 'playwright-core';
const B = process.env.SHOT_BASE || 'http://127.0.0.1:3000';
const b = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const ctx = await b.newContext({
  extraHTTPHeaders: { Authorization: 'Basic ' + Buffer.from('ahmed:prototyp2026').toString('base64') },
  viewport: { width: Number(process.env.SHOT_W) || 1366, height: 900 },
  ...(process.env.SHOT_W && Number(process.env.SHOT_W) < 700
    ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true }
    : {}),
});
const p = await ctx.newPage();
const out = process.argv[2];
for (const [n, u] of (process.argv[3] || '').split(',').map((x) => {
  const i = x.indexOf('=');
  return [x.slice(0, i), x.slice(i + 1)];
})) {
  const r = await p.goto(B + u);
  await p.screenshot({ path: `${out}/${n}.png`, fullPage: !process.env.SHOT_TOP });
  console.log(n, r.status());
}
await b.close();
