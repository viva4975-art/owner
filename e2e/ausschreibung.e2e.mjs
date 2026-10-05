// Browser-Test Ausschreibungen: erfassen (Termine), Liste mit Countdown, Startseite, Status, Angebot daraus. Nur lokal.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('E2E nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const out = process.env.E2E_SCREENSHOTS ?? 'var/e2e';
mkdirSync(out, { recursive: true });
const AUTHORITY = '00000000-0000-4000-8000-000000000001';

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
const day = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
};
const title = `E2E Ausschreibung ${Date.now().toString().slice(-6)}`;

console.log('1. Erfassen');
await p.goto(B + '/ausschreibungen');
await p.click('a:has-text("+ Ausschreibung erfassen")');
await p.waitForLoadState();
await p.fill('#title', title);
await p.fill('#authority', 'Landeshauptstadt München');
await p.fill('#reference_no', 'VGSt-E2E-1');
await p.fill('#platform', 'Vergabe.bayern');
await p.fill('#deadline', `${day(4)}T10:00`);
await p.fill('#questions', `${day(2)}T12:00`);
await p.fill('#visit', `${day(1)}T09:00`);
await p.check('#visit_req');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('gespeichert', (await flash(p)).includes('Ausschreibung gespeichert'), await flash(p));
const url = p.url().split('?')[0];
check('Kopf zeigt Abgabe 10:00 Uhr', (await p.locator('.hero').innerText()).includes('10:00 Uhr'));

console.log('2. Liste und Startseite');
await p.goto(B + '/ausschreibungen');
const row = p.locator('.card:not(:has(h3)) .list .row', { hasText: title });
check('in der Liste mit 4 Tagen', (await row.innerText()).includes('4'), await row.innerText());
check(
  'Termin Ortsbesichtigung (Pflicht)',
  (await p.locator('.card', { hasText: 'Nächste Termine' }).innerText()).includes(
    'Ortsbesichtigung (Pflicht)',
  ),
);
await p.screenshot({ path: `${out}/as-liste.png`, fullPage: true });
await p.goto(B + '/');
check('Startseite zeigt Abgabetermin', (await p.locator('main').innerText()).includes(title));

console.log('3. Angebot daraus');
await p.goto(url);
await p.click('button:has-text("Angebot erstellen")');
await p.waitForLoadState();
check('ohne Kunde: Hinweis', (await flash(p)).includes('Kunde oder Interessent'), await flash(p));
await p.selectOption('#customer', AUTHORITY);
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
await p.click('button:has-text("Angebot erstellen")');
await p.waitForLoadState();
check('Angebotsentwurf mit Titel übernommen', (await p.inputValue('#title')) === title);
await p.screenshot({ path: `${out}/as-angebot.png`, fullPage: true });

console.log('4. Status');
await p.goto(url);
await p.click('button[value=verzichtet]');
await p.waitForLoadState();
check('Grund Pflicht', (await flash(p)).includes('Grund'), await flash(p));
await p.fill('input[name=note]', 'zu weit weg');
await p.click('button[value=verzichtet]');
await p.waitForLoadState();
check('nicht teilnehmen', (await p.locator('.hero .status-xl').innerText()).includes('nicht teilgenommen'));
await p.goto(B + '/ausschreibungen?ansicht=abgeschlossen');
check('unter Abgeschlossen', (await p.locator('.list .row', { hasText: title }).count()) === 1);

await browser.close();
console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
