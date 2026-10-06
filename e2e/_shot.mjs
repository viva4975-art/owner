import { chromium } from 'playwright-core';
const b = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const ctx = await b.newContext({ extraHTTPHeaders: { Authorization: 'Basic ' + Buffer.from('ahmed:prototyp2026').toString('base64') }, viewport: { width: 1400, height: 950 } });
const p = await ctx.newPage();
const [, , ...pairs] = process.argv;
for (let i = 0; i < pairs.length; i += 2) {
  const r = await p.goto('http://127.0.0.1:3000' + pairs[i]);
  console.log(pairs[i], r.status());
  await p.screenshot({ path: pairs[i + 1], fullPage: false });
}
await b.close();
