// Browser-Test Sonderdienste: anlegen (Tiefgarage), Termin planen, Aushang-PDF, angekündigt, erledigt → Arbeitsschein,
// Rechnungsentwurf, Liste fällig. Nur lokal.
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
const flash = async (p) => (await p.locator('.flash').allInnerTexts()).join(' | ');
const p = await ctx.newPage();

const stamp = Date.now();
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

console.log('1. Sonderdienst anlegen');
await p.goto(B + '/sonderdienste');
await p.click('a:has-text("Sonderdienst anlegen")');
await p.waitForLoadState();
await p.selectOption('#site', { index: 1 });
await p.selectOption('#kind', 'tiefgarage');
await p.fill('#title', `E2E Tiefgarage ${stamp}`);
await p.fill('#interval', '12');
await p.fill('#due', today);
await p.fill('#notice', '14');
await p.fill('#price', '890,00');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('gespeichert', (await flash(p)).includes('gespeichert'), await flash(p));
const svcUrl = p.url().split('?')[0];

console.log('2. Termin planen + Aushang');
await p.click('a:has-text("Termin planen")');
await p.waitForLoadState();
await p.fill('#date', today);
await p.fill('#start', '06:00');
await p.fill('#end', '10:00');
await p.click('button:has-text("Termin planen")');
await p.waitForLoadState();
check('Termin gespeichert', (await flash(p)).includes('Termin gespeichert'), await flash(p));
const runUrl = p.url().split('?')[0];
const pdf = await p.request.get(runUrl + '/aushang.pdf');
check('Aushang-PDF', pdf.ok() && (await pdf.body()).subarray(0, 4).toString() === '%PDF');
await p.click('button:has-text("Aushang ist aufgehängt")');
await p.waitForLoadState();
check('angekündigt', (await p.locator('body').innerText()).includes('angekündigt'));
await p.screenshot({ path: `${out}/s1-termin.png`, fullPage: true });

console.log('3. Liste');
await p.goto(B + '/sonderdienste');
const row = p.locator('tr', { hasText: `E2E Tiefgarage ${stamp}` });
check(
  'in der Fälligkeitsliste mit Termin',
  (await row.count()) === 1 && (await row.innerText()).includes('angekündigt'),
);

console.log('4. Erledigt → Arbeitsschein → Rechnung');
await p.goto(runUrl);
await p.click('button:has-text("Erledigt")');
await p.waitForLoadState();
check(
  'Arbeitsschein geöffnet',
  p.url().includes('/arbeitsscheine/') && (await flash(p)).includes('Arbeitsschein angelegt'),
  p.url(),
);
await p.goto(runUrl);
await p.click('button:has-text("Rechnungsentwurf")');
await p.waitForLoadState();
check(
  'Rechnungsentwurf',
  p.url().includes('/rechnungen/') &&
    (await p.locator('body').innerText()).includes(`E2E Tiefgarage ${stamp}`),
  p.url(),
);
await p.goto(svcUrl);
const next = `${Number(today.slice(0, 4)) + 1}`;
check('nächste Fälligkeit +12 Monate', (await p.locator('#due').inputValue()).startsWith(next));

console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
