// Browser-Test Rechnungsgruppen = Rechnungseinstellungen: Gruppe beim Kunden anlegen (Adresse, E-Mail, Zahlungsziel),
// Fehler bei unvollständiger Adresse, am Objekt wählen, Vorschau „So geht die Rechnung raus“, Kundenformular ohne
// Rechnungsfelder und mit Status (Kunde/Interessent/Ehemalig). Nur lokal.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('E2E nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const out = process.env.E2E_SCREENSHOTS ?? 'var/e2e';
mkdirSync(out, { recursive: true });
const SCHOOL = '00000000-0000-4000-8000-000000000011';

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
p.on('dialog', (d) => d.accept());
const url = `${B}/objekte/${SCHOOL}/rechnungsangaben`;

const AUTHORITY = '00000000-0000-4000-8000-000000000001';
const tag = Date.now().toString().slice(-6);

console.log('1. Rechnungsgruppe beim Kunden anlegen');
await p.goto(`${B}/kunden/${AUTHORITY}/rechnungsgruppen?neu=1`);
await p.fill('#g-name', `Schulen Süd ${tag}`);
await p.check('#g-own-addr');
await p.fill('#g-bname', 'Schulverwaltung Süd');
await p.fill('#g-street', '');
await p.fill('#g-plz', '80335');
await p.fill('#g-city', 'München');
await p.click('button:has-text("Rechnungsgruppe anlegen")');
await p.waitForLoadState();
check('unvollständige Adresse abgelehnt', (await flash(p)).includes('Rechnungsadresse'), await flash(p));
await p.goto(`${B}/kunden/${AUTHORITY}/rechnungsgruppen?neu=1`);
await p.fill('#g-name', `Schulen Süd ${tag}`);
await p.check('#g-own-addr');
await p.fill('#g-bname', 'Schulverwaltung Süd');
await p.fill('#g-street', 'Bayerstr. 28');
await p.fill('#g-plz', '80335');
await p.fill('#g-city', 'München');
await p.fill('#g-emails', 'sued@schule.example');
await p.selectOption('#g-format', 'zugferd');
await p.selectOption('#g-terms', '45');
await p.check('#g-own-dun');
await p.fill('#g-dunning', 'mahnung@schule.example');
await p.click('button:has-text("Rechnungsgruppe anlegen")');
await p.waitForLoadState();
check('Gruppe gespeichert', (await flash(p)).includes('gespeichert'), await flash(p));
check('in der Liste', (await p.locator('main').innerText()).includes(`Schulen Süd ${tag}`));
await p.goto(`${B}/kunden/${AUTHORITY}/rechnungsgruppen?ansicht=zuordnung`);
const sel = p.locator('table.rg-map select').first();
const newOpt = await sel.locator('option', { hasText: `Schulen Süd ${tag}` }).getAttribute('value');
await sel.selectOption(newOpt);
await p.click('button:has-text("Zuordnung speichern")');
await p.waitForLoadState();
check('Zuordnung je Objekt gespeichert', (await flash(p)).includes('neu zugeordnet'), await flash(p));

console.log('2. Am Objekt wählen');
await p.goto(url);
await p
  .locator('label.row', { hasText: `Schulen Süd ${tag}` })
  .locator('input[type=radio]')
  .check();
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('gespeichert', (await flash(p)).includes('gespeichert'), await flash(p));
const prev = await p.locator('.card', { hasText: 'So geht die Rechnung raus' }).innerText();
check(
  'Vorschau zeigt Angaben der Gruppe',
  prev.includes('Schulverwaltung Süd') && prev.includes('sued@schule.example') && prev.includes('45 Tage'),
  prev,
);
await p.screenshot({ path: `${out}/ra-objekt.png`, fullPage: true });
await p.goto(`${B}/kunden/${AUTHORITY}`);
const sum = await p.locator('.card', { hasText: 'Rechnungsgruppen' }).innerText();
check('Übersicht beim Kunden zeigt die Gruppe', sum.includes(`Schulen Süd ${tag}`), sum);

console.log('3. Kundenformular: keine Rechnungsfelder, Status dreistufig');
await p.goto(`${B}/kunden/${AUTHORITY}/bearbeiten`);
check('kein Rechnungsformat am Kunden', (await p.locator('#invoice_format').count()) === 0);
check('keine Mahnsperre', (await p.locator('#dunning_block').count()) === 0);
check('kein öffentlicher Auftraggeber', (await p.locator('#is_public_authority').count()) === 0);
const opts = await p.locator('#status option').allInnerTexts();
check('Status Kunde/Interessent/Ehemaliger', opts.length === 3, opts.join(','));
await p.goto(`${B}/kunden`);
check(
  'farbige Status-Chips',
  (await p.locator('.chips .dot.ok, .chips .dot.warn, .chips .dot.err').count()) === 3,
);

console.log('4. Felder untereinander');
await p.goto(`${B}/kunden/${AUTHORITY}/bearbeiten`);
const y1 = (await p.locator('#name').boundingBox()).y;
const y2 = (await p.locator('#street').boundingBox()).y;
const x1 = (await p.locator('#name').boundingBox()).x;
const x2 = (await p.locator('#street').boundingBox()).x;
check('Felder stehen untereinander', y2 > y1 && Math.abs(x1 - x2) < 2, `${x1}/${y1} ${x2}/${y2}`);

await browser.close();
console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
