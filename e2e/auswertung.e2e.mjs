// Browser-Test Auswertungen: Übersicht, alle Berichte laden, Reiter, CSV-Exporte, Jahreswechsel. Nur lokal.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('E2E nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const out = process.env.E2E_SCREENSHOTS ?? 'var/e2e';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const ctx = await browser.newContext({
  extraHTTPHeaders: { Authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}` },
  viewport: { width: 1280, height: 900 },
  locale: 'de-DE',
});
let ok = 0,
  fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    ok++;
    console.log('  ✓', name);
  } else {
    fail++;
    console.log('  ✗', name, extra);
  }
};
const p = await ctx.newPage();

console.log('1. Übersicht');
await p.goto(B + '/auswertungen');
const cards = await p.locator('a.card').count();
check('Übersicht mit allen Berichten', cards === 10, String(cards));

console.log('2. Berichte über die Reiter');
const tabs = await p
  .goto(B + '/auswertungen/rechnungen')
  .then(() => p.locator('.tabs a').evaluateAll((as) => as.map((a) => a.getAttribute('href'))));
check('10 Reiter', tabs.length === 10, String(tabs.length));
for (const href of tabs) {
  const r = await p.goto(B + href);
  check(`${href} lädt`, r.ok() && (await p.locator('.tabs a.on').count()) === 1, String(r.status()));
}
await p.goto(B + '/auswertungen/rechnungen');
await p.click('a:has-text("←")');
check(
  'Jahr zurück',
  p.url().includes('jahr=') &&
    (await p.locator('h1').innerText()).includes(String(new Date().getFullYear() - 1)),
);
await p.goBack();
check('Zurück-Taste', (await p.locator('h1').innerText()).includes(String(new Date().getFullYear())));

console.log('3. CSV');
for (const u of ['/auswertungen/stunden.csv', '/auswertungen/dienste.csv']) {
  const r = await p.request.get(B + u);
  const t = await r.text();
  check(
    `${u}: CSV mit Kopfzeile`,
    r.ok() && /text\/csv/.test(r.headers()['content-type']) && t.split('\r\n')[0].includes(';'),
  );
}
const bad = await p.request.get(B + '/auswertungen/dienste?von=2026-01-01&bis=2026-12-31');
check('zu langer Zeitraum → Hinweis statt Absturz', (await bad.text()).includes('höchstens 2 Monate'));
await p.goto(B + '/auswertungen/stunden');
await p.screenshot({ path: `${out}/a1-stunden.png`, fullPage: true });

console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
