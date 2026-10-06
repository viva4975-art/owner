// Browser-Test Kassenbuch: Buchung mit Beleg, Tagessaldo, Filter, Storno, CSV/PDF, Karten-Beleg, Auswertung,
// Import-Seite alte App. Nur lokal.
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
const month = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 7);
const pdf = { name: 'quittung.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') };

console.log('1. Einnahme + Ausgabe mit Beleg');
await p.goto(`${B}/kassenbuch?monat=${month}`);
check('Kasse-Seite mit Kacheln', (await p.locator('.stat-card').count()) === 4);
await p.click('a:has-text("+ Buchung")');
await p.check('input[name=typ][value=einnahme]', { force: true });
await p.fill('#beschreibung', `E2E Einlage ${stamp}`);
await p.fill('#betrag', '200,00');
await p.click('button:has-text("Buchen")');
await p.waitForLoadState();
check('Einnahme gebucht', (await flash(p)).includes('gespeichert'), await flash(p));
await p.click('a:has-text("+ Buchung")');
await p.fill('#beschreibung', `E2E Putzmittel ${stamp}`);
await p.fill('#betrag', '12,34');
await p.fill('#beleg', 'Q-77');
await p.setInputFiles('#datei', pdf);
await p.click('button:has-text("Buchen")');
await p.waitForLoadState();
const row = p.locator('.kb-row', { hasText: `E2E Putzmittel ${stamp}` });
check('Ausgabe mit Beleg in der Liste', (await row.count()) === 1 && (await row.innerText()).includes('Beleg-Foto'));
check('Tagessaldo sichtbar', (await p.locator('.kb-day-s').first().innerText()).includes('Saldo Tagesende'));
await p.screenshot({ path: `${out}/kasse.png`, fullPage: true });

console.log('2. Filter und Export');
await p.fill('form.toolbar input[name=q]', `Putzmittel ${stamp}`);
await p.press('form.toolbar input[name=q]', 'Enter');
await p.waitForLoadState();
check('Suche filtert', (await p.locator('.kb-row').count()) === 1);
const csv = await p.request.get(`${B}/kassenbuch/${month}.csv`);
check('CSV enthält Buchung', (await csv.text()).includes(`E2E Putzmittel ${stamp}`));
const pdfRes = await p.request.get(`${B}/kassenbuch/${month}.pdf`);
check('PDF erzeugt', pdfRes.headers()['content-type'] === 'application/pdf');

console.log('3. Beleg öffnen, Storno');
await row.first().click();
await p.waitForLoadState();
const belegHref = await p.locator('a:has-text("öffnen")').first().getAttribute('href');
const beleg = await p.request.get(B + belegHref);
check('Beleg abrufbar', (await beleg.body()).toString().startsWith('%PDF'));
p.once('dialog', (d) => d.accept());
await p.locator('summary:has-text("Buchung stornieren")').click();
await p.fill('#grund', 'E2E doppelt');
await p.click('button:has-text("Stornieren")');
await p.waitForLoadState();
check('storniert', (await flash(p)).includes('storniert'), await flash(p));
await p.goto(`${B}/kassenbuch?monat=${month}&q=Putzmittel%20${stamp}`);
check('Storno sichtbar, nicht gelöscht', (await p.locator('.kb-row.storno').count()) === 1);

console.log('4. Karten-Beleg und Auswertung');
await p.goto(`${B}/kassenbuch/kartenbelege`);
await p.fill('#k-betrag', '45,67');
await p.fill('#k-notiz', `E2E Tanken ${stamp}`);
await p.setInputFiles('#k-datei', pdf);
await p.click('#kb-form button:has-text("Speichern")');
await p.waitForLoadState();
check('Karten-Beleg archiviert', (await p.locator('.kb-card', { hasText: `E2E Tanken ${stamp}` }).count()) === 1);
const zip = await p.request.get(`${B}/kassenbuch/kartenbelege.zip`);
check('ZIP-Export', zip.headers()['content-type'] === 'application/zip');
await p.goto(`${B}/kassenbuch/auswertung`);
check('Auswertung mit Monat', (await p.locator('tbody tr').count()) >= 1);

console.log('5. Import-Seite alte App');
await p.goto(`${B}/transfer/altdaten`);
check('Import-Seite mit Upload', (await p.locator('[data-uploader]').count()) === 1);

await browser.close();
console.log(`\ne2e:kasse: ${ok} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
