// Browser-Test: Zurück/Vor, Eingaben behalten, zwei Tabs. Legt Testdaten an → nur gegen lokale Instanz.
// Start: npm run dev (anderes Terminal), dann npm run e2e
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('E2E nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const out = process.env.E2E_SCREENSHOTS ?? 'var/e2e';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  args: ['--lang=de-DE'],
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

// ---------- 1. Rechnung bearbeiten → Startseite → Zurück: Eingaben noch da ----------
console.log('1. Zurück-Taste im Rechnungseditor');
const a = await ctx.newPage();
a.on('dialog', (d) => d.accept());
await a.goto(B + '/neu?typ=rechnung&kunde=00000000-0000-4000-8000-000000000002');
await a.selectOption('#objekt', { index: 1 });
await a.waitForURL(/objekt=/);
const editorUrl = a.url();
await a.fill('#period_start', '2026-09-15');
await a.fill('#intro_text', 'Sonderreinigung nach Wasserschaden im Keller');
const row = a.locator('#lines tbody tr').first();
await row.locator('[name=desc]').fill('Trocknung und Reinigung');
await row.locator('[name=qty]').fill('3,5');
await row.locator('[name=unit]').selectOption('HUR');
await row.locator('[name=price]').fill('31,50');
await a.click('#add-line');
await a.locator('#lines tbody tr').nth(1).locator('[name=desc]').fill('Entsorgung');
await a.locator('#lines tbody tr').nth(1).locator('[name=price]').fill('80,00');
await a.waitForTimeout(400);
await a.click('nav.menu a.item:has-text("Übersicht")');
await a.waitForURL(B + '/');
await a.goBack();
await a.waitForLoadState();
check('URL wieder der Editor', a.url() === editorUrl, a.url());
check(
  'Einleitung erhalten',
  (await a.inputValue('#intro_text')) === 'Sonderreinigung nach Wasserschaden im Keller',
);
check('2 Positionen erhalten', (await a.locator('#lines tbody tr').count()) === 2);
check(
  'Menge erhalten',
  (await a.locator('#lines tbody tr').first().locator('[name=qty]').inputValue()) === '3,5',
);
check(
  'Summe neu berechnet',
  (await a.locator('#t-net').innerText()).includes('190,25'),
  await a.locator('#t-net').innerText(),
);
await a.goForward();
await a.waitForURL(B + '/');
check('Vor-Taste funktioniert', a.url() === B + '/');

// ---------- 2. Seite später neu öffnen (kein bfcache): Wiederherstellung aus Tab-Speicher ----------
console.log('2. Editor später erneut öffnen');
await a.goto(B + '/kunden');
await a.goto(editorUrl);
check('still wiederhergestellt, ohne Hinweisbalken', (await a.locator('.restore').count()) === 0);
check('Positionen wiederhergestellt', (await a.locator('#lines tbody tr').count()) === 2);
await a.screenshot({ path: `${out}/1-wiederhergestellt.png`, fullPage: true });
await a.click('text=Entwurf speichern');
await a.waitForLoadState();
check('gespeichert', (await flash(a)).includes('Entwurf gespeichert'), await flash(a));
check('Meldung aus URL entfernt', !a.url().includes('ok='), a.url());
const draftUrl = a.url();
await a.goto(editorUrl.split('?')[0]);
check('nach Speichern kein alter Entwurf-Hinweis', (await a.locator('.restore').count()) === 0);

// ---------- 3. Fehler beim Speichern: Eingaben bleiben ----------
console.log('3. Fehlerhafte Eingabe');
await a.goto(B + '/neu?typ=kunde');
await a.fill('#name', 'Testkunde Fehlerfall GmbH');
await a.fill('#street', 'Teststraße 1');
await a.fill('#postal_code', '123'); // ungültig
await a.fill('#city', 'München');
await a.click('button:has-text("Speichern")');
await a.waitForLoadState();
check('Fehlermeldung PLZ', (await flash(a)).includes('PLZ'), await flash(a));
check('Name nach Fehler noch da', (await a.inputValue('#name')) === 'Testkunde Fehlerfall GmbH');
await a.fill('#postal_code', '81375');
await a.click('button:has-text("Speichern")');
await a.waitForLoadState();
check('nach Korrektur gespeichert', (await flash(a)).includes('Kunde gespeichert'), await flash(a));
const newCustomerUrl = a.url();

// ---------- 4. Zwei Tabs: gleicher Kunde, kein stilles Überschreiben ----------
console.log('4. Zwei Tabs bearbeiten denselben Kunden');
const b = await ctx.newPage();
b.on('dialog', (d) => d.accept());
await a.goto(newCustomerUrl + '/bearbeiten');
await b.goto(newCustomerUrl + '/bearbeiten');
await a.fill('#notes', 'Frau A aus Tab 1');
await b.fill('#notes', 'Herr B aus Tab 2');
await b.click('button:has-text("Speichern")');
await b.waitForLoadState();
check('Tab 2 speichert', (await flash(b)).includes('Kunde gespeichert'));
await a.click('button:has-text("Speichern")');
await a.waitForLoadState();
check(
  'Tab 1 wird gewarnt statt zu überschreiben',
  (await flash(a)).includes('zwischenzeitlich geändert'),
  await flash(a),
);
await a.screenshot({ path: `${out}/2-zwei-tabs-konflikt.png`, fullPage: true });
check(
  'Tab 1: Option „Meine Eingaben übernehmen“',
  (await a.locator('.restore button:has-text("Meine Eingaben übernehmen")').count()) === 1,
);
await a.click('.restore button:has-text("Meine Eingaben übernehmen")');
check('Tab 1: eigene Eingabe zurück im Feld', (await a.inputValue('#notes')) === 'Frau A aus Tab 1');

// ---------- 5. Zwei Tabs, verschiedene Arbeit gleichzeitig ----------
console.log('5. Zwei Tabs, verschiedene Arbeit');
await a.goto(B + '/neu?typ=mitarbeiter');
await b.goto(draftUrl.replace(/\?.*/, ''));
await a.fill('#first_name', 'Elena');
await a.fill('#last_name', 'Popescu');
await a.fill('#entry_date', '2024-10-08');
await a.fill('#birth_date', '1990-10-12');
await a.fill('#residence_permit_until', '2026-11-15');
await a.fill('#iban', 'DE89 3704 0044 0532 0130 00');
await a.fill('#languages', 'Rumänisch, Deutsch');
// in Tab B derweil an der Rechnung arbeiten
await b.click('a:has-text("Bearbeiten")');
await b.locator('#lines tbody tr').first().locator('[name=price]').fill('33,00');
await b.click('text=Entwurf speichern');
await b.waitForLoadState();
check('Tab B: Rechnung gespeichert', (await flash(b)).includes('Entwurf gespeichert'));
await a.click('button:has-text("Speichern")');
await a.waitForLoadState();
check('Tab A: Mitarbeiter gespeichert', (await flash(a)).includes('Mitarbeiter gespeichert'), await flash(a));
check('Tab A: Eingaben nicht vermischt', (await a.locator('h1').innerText()).includes('Elena Popescu'));

// ---------- 6. Zwei Tabs: Kunde in Tab A halb ausgefüllt, Tab B arbeitet woanders, Tab A neu geladen ----------
console.log('6. Ungespeicherte Eingaben überleben Arbeit im anderen Tab (jedes Formular)');
const AUTH = '00000000-0000-4000-8000-000000000001';
await a.goto(`${B}/kunden/${AUTH}/rechnungsgruppen?neu=1`);
await a.fill('#g-name', 'Halb ausgefüllt Tab A');
await a.fill('#g-emails', 'tab-a@example.org');
await a.waitForTimeout(400);
await b.goto(`${B}/kunden/${AUTH}/bearbeiten`);
await b.fill('#notes', 'Tab B speichert etwas anderes');
await b.click('button:has-text("Speichern")');
await b.waitForLoadState();
check('Tab B gespeichert', (await flash(b)).includes('Kunde gespeichert'), await flash(b));
check('Tab A: Eingabe noch da', (await a.inputValue('#g-name')) === 'Halb ausgefüllt Tab A');
await a.reload();
check(
  'Tab A nach Neuladen wiederhergestellt',
  (await a.inputValue('#g-name')) === 'Halb ausgefüllt Tab A' &&
    (await a.inputValue('#g-emails')) === 'tab-a@example.org',
  await a.inputValue('#g-name'),
);
check('Tab B sieht Tab-A-Eingaben nicht', !(await b.content()).includes('Halb ausgefüllt Tab A'));

console.log(`\n${ok} ok, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
