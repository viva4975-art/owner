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
check(
  'Ausgabe mit Beleg in der Liste',
  (await row.count()) === 1 && (await row.innerText()).includes('Beleg-Foto'),
);
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
check(
  'Karten-Beleg archiviert',
  (await p.locator('.kb-card', { hasText: `E2E Tanken ${stamp}` }).count()) === 1,
);
const zip = await p.request.get(`${B}/kassenbuch/kartenbelege.zip`);
check('ZIP-Export', zip.headers()['content-type'] === 'application/zip');
await p.goto(`${B}/kassenbuch/auswertung`);
check('Auswertung mit Monat', (await p.locator('tbody tr').count()) >= 1);

console.log('5. Import-Seite alte App');
await p.goto(`${B}/transfer/altdaten`);
check('Import-Seite mit Upload', (await p.locator('[data-uploader]').count()) === 1);

console.log('6. Eigen-Compliance');
await p.goto(`${B}/eigen-compliance`);
check('Nachweise in 5 Gruppen', (await p.locator('details.ec-group').count()) === 5);
const row1 = p.locator('.ec-doc', { hasText: 'Gewerbezentralregisterauszug' }).first();
await row1.locator('input[type=file]').setInputFiles(pdf);
await p.waitForURL(/\/eigen-compliance\/version\//);
check('nach Upload Datum & Gültigkeit', (await p.locator('h1').innerText()).includes('Gültigkeit'));
await p.selectOption('#guelt', 'manuell');
check('manuell zeigt Datumsfeld', await p.locator('#bis').isVisible());
await p.fill('#bis', '2099-12-31');
await p.click('button:has-text("Übernehmen")');
await p.waitForLoadState();
check(
  'gültig bis gespeichert',
  (await p.locator('.ec-doc', { hasText: 'Gewerbezentralregisterauszug' }).first().innerText()).includes(
    '31.12.2099',
  ),
);
await p
  .locator('.ec-multi', { hasText: 'Krankenkasse' })
  .locator('input[name=name]:not([type=hidden])')
  .fill(`E2E Kasse ${stamp}`);
await p
  .locator('.ec-multi', { hasText: 'Krankenkasse' })
  .locator('button:has-text("+ Krankenkasse")')
  .click();
await p.waitForLoadState();
check(
  'Krankenkasse hinzugefügt',
  (await p.locator('.ec-doc.sub', { hasText: `E2E Kasse ${stamp}` }).count()) === 1,
);
await p.goto(`${B}/eigen-compliance/pruefung`);
await p.locator('.ec-chk').first().locator('label.chk-ja').click();
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('Prüfung gespeichert', await p.locator('.ec-chk').first().locator('input[value=ja]').isChecked());
const rep = await p.request.get(`${B}/eigen-compliance/report.pdf`);
check('Report-PDF', rep.headers()['content-type'] === 'application/pdf');
const vor = await p.request.get(`${B}/eigen-compliance/vorlage/milog.pdf`);
check('Vorlage MiLoG', vor.headers()['content-type'] === 'application/pdf');

console.log('7. Akquise');
await p.goto(`${B}/akquise`);
await p.click('a:has-text("+ Neue Akquise")');
await p.fill('#firma', `E2E Akquise ${stamp}`);
await p.fill('#ort', 'München');
await p.fill('#wv', new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }));
await p.click('form.card button:has-text("Speichern")');
await p.waitForLoadState();
check('Akquise angelegt', (await flash(p)).includes('Gespeichert'), await flash(p));
await p.locator('label:has-text("Termin")').click();
await p.selectOption('#ns', 'interesse_stark');
await p.fill('#notiz', 'Ortstermin vereinbart');
await p.locator('form:has(#notiz) button:has-text("Speichern")').click();
await p.waitForLoadState();
check('Aktivität erfasst', (await p.locator('.ak-acts li').count()) === 1);
check('Status geändert', (await p.locator('.sub .badge').innerText()).includes('Starkes Interesse'));
await p.goto(`${B}/akquise?filter=due&q=${stamp}`);
check('in „Heute / überfällig“', (await p.locator('.lc', { hasText: `E2E Akquise ${stamp}` }).count()) === 1);
check('Funnel sichtbar', (await p.locator('.ak-stage').count()) === 4);
await p.goto(`${B}/`);
check('Wiedervorlage auf der Startseite', (await p.locator('body').innerText()).includes('heute fällig'));

await browser.close();
console.log(`\ne2e:kasse: ${ok} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
