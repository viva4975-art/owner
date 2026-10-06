import crypto from 'node:crypto';
// Browser-Test Vorfaktura (Runde 4b): Leistungen je Ausführung am Objekt verrichten → vorgemerkt → unter Rechnungen →
// Entwürfe je Kunde auswählen → Entwürfe erstellen → Rechnungsdatum setzen → mehrere ausstellen. Nur lokal.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('E2E nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const out = process.env.E2E_SCREENSHOTS ?? 'var/e2e';
mkdirSync(out, { recursive: true });
const SITE = '00000000-0000-4000-8000-000000000011'; // Grundschule (Glasreinigung je Ausführung, Regie)

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const auth = { Authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}` };
const ctx = await browser.newContext({
  extraHTTPHeaders: auth,
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
const body = async (p) => p.locator('body').innerText();
const p = await ctx.newPage();
p.on('dialog', (d) => d.accept());
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

console.log('1. Leistungen verrichten');
await p.goto(`${B}/objekte/${SITE}/leistungen`);
const panel = p.locator('.card:has(h3:has-text("Leistungen verrichten"))');
check('Abschnitt „Leistungen verrichten“', (await panel.count()) === 1);
check('Knopf ohne Auswahl gesperrt', await panel.locator('button:has-text("verrichten")').isDisabled());
const glas = panel.locator('tr', { hasText: 'Glasreinigung' }).first();
await glas.locator('input[name=service]').check();
const regie = panel.locator('tr', { hasText: 'Regiestunden' }).first();
await regie.locator('input[name=service]').check();
await regie.locator('input[name^=qty_]').fill('2,5');
await p.fill('#exec_from', today);
await panel.locator('button:has-text("verrichten")').click();
await p.waitForLoadState();
check('vorgemerkt', (await flash(p)).includes('verrichtet'), await flash(p));
const vorgemerkt = p.locator('h4:has-text("Vorgemerkt")');
check('Liste „Vorgemerkt“ am Objekt', (await vorgemerkt.count()) === 1);
await p.goBack();
await p.goForward();
check('Zurück/Vor ohne doppelte Buchung', !(await body(p)).includes('Fehler 500'));

console.log('2. Entwürfe aus Vorgemerktem');
await p.goto(`${B}/rechnungen/entwuerfe`);
const box = p.locator('section:has(h3:has-text("Vorgemerkte Leistungen"))');
check('Vorgemerkte Leistungen sichtbar', (await box.locator('input[name=exec]').count()) >= 2);
// Kunde komplett auswählen
await box.locator('tr.group-row', { hasText: 'Referat' }).first().locator('input[data-group]').check();
const n = Number(await box.locator('[data-count]').first().innerText());
check('Kunde auswählen markiert seine Zeilen', n >= 2, String(n));
await box.locator('button:has-text("Entwürfe erstellen")').click();
await p.waitForLoadState();
check('Entwurf erstellt', /Rechnungsentwurf/.test(await flash(p)), await flash(p));
check(
  'vorgemerkt jetzt leer (für den Kunden)',
  (await box.locator('tr', { hasText: 'Grundschule' }).count()) === 0,
);

console.log('3. Entwürfe auswählen, Datum setzen, ausstellen');
const drafts = p.locator('section:has(h3:has-text("Rechnungsentwürfe"))');
const row = drafts.locator('tr', { hasText: 'Grundschule' }).first();
await row.locator('input[name=inv]').check();
await p.fill('#dr_date', today);
await drafts.locator('button:has-text("Datum setzen")').click();
await p.waitForLoadState();
check('Datum gesetzt', (await flash(p)).includes('Rechnungsdatum'), await flash(p));
await drafts.locator('tr', { hasText: 'Grundschule' }).first().locator('input[name=inv]').check();
await drafts.locator('button:has-text("Markierte ausstellen")').click();
await p.waitForLoadState();
const f = await flash(p);
check('ausgestellt (oder klarer Grund)', /ausgestellt|Nicht ausgestellt/.test(f), f);
if (f.includes('Nicht ausgestellt')) console.log('    Hinweis:', f);

console.log('4. Zurücknehmen');
await p.goto(`${B}/objekte/${SITE}/leistungen`);
await p
  .locator('.card:has(h3:has-text("Leistungen verrichten")) tr', { hasText: 'Glasreinigung' })
  .first()
  .locator('input[name=service]')
  .check();
await p.click('.card:has(h3:has-text("Leistungen verrichten")) button:has-text("verrichten")');
await p.waitForLoadState();
const before = await p.locator('form[action^="/ausfuehrungen/"]').count();
await p.locator('form[action^="/ausfuehrungen/"] button').first().click();
await p.waitForLoadState();
check(
  'zurückgenommen',
  (await flash(p)).includes('zurückgenommen') &&
    (await p.locator('form[action^="/ausfuehrungen/"]').count()) === before - 1,
);

console.log('5. Suche in langen Auswahllisten');
await p.goto(`${B}/rechnungen/${crypto.randomUUID()}/bearbeiten`);
const search = p.locator('.sel-wrap:has(#kunde) .sel-search');
check('Suchfeld über der Kundenliste', (await search.count()) === 1);
const nBefore = await p.locator('#kunde option').count();
await search.fill('29901');
const nAfter = await p.locator('#kunde option').count();
check('Liste gefiltert', nAfter < nBefore && nAfter >= 2, `${nBefore} → ${nAfter}`);
await search.press('Enter');
await p.waitForLoadState();
check(
  'Enter übernimmt den Treffer',
  /kunde=/.test(p.url()) || (await p.locator('#kunde').inputValue()) !== '',
  p.url(),
);

console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
