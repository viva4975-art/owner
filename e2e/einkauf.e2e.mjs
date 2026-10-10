// Browser-Test Einkauf: Nachbestellen → Bestellung → Wareneingang → Eingangsrechnung mit Beleg → Freigabe →
// SEPA-Zahlungslauf → DATEV-Export → Nachkalkulation. Legt Testdaten an → nur gegen lokale Instanz (Demo-Daten nötig).
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('E2E nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const out = process.env.E2E_SCREENSHOTS ?? 'var/e2e';
mkdirSync(out, { recursive: true });
const ARTICLE = '00000000-0000-4000-8000-000000000231'; // Demo: Allzweckreiniger

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

console.log('1. Nachbestellen und Wareneingang');
await p.goto(B + `/artikel/${ARTICLE}`);
const stockBefore = parseFloat((await p.locator('.kpi .v').first().innerText()).replace(',', '.'));
await p.click('a:has-text("Nachbestellen")');
check(
  'Artikel vorbelegt',
  (await p.inputValue('#po-lines tbody tr [name=desc]')).includes('Allzweckreiniger'),
);
await p.locator('#po-lines tbody tr [name=qty]').first().fill('10');
await p.locator('#po-lines tbody tr [name=price]').first().fill('28,90');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
const poNo = (await p.locator('h1').innerText()).match(/BE-\d{4}-\d{4}/)?.[0];
check('Bestellnummer BE-JJJJ-NNNN', !!poNo, await p.locator('h1').innerText());
await p.click('button:has-text("Als bestellt markieren")');
await p.waitForLoadState();
await p.click('button:has-text("Wareneingang buchen")');
await p.waitForLoadState();
check('Wareneingang gebucht', (await flash(p)).includes('Wareneingang gebucht'));
await p.screenshot({ path: `${out}/e1-bestellung.png`, fullPage: true });
await p.goto(B + `/artikel/${ARTICLE}`);
const stockAfter = parseFloat((await p.locator('.kpi .v').first().innerText()).replace(',', '.'));
check('Lager +10', stockAfter - stockBefore === 10, `${stockBefore} → ${stockAfter}`);

console.log('2. Eingangsrechnung zur Bestellung');
await p.goto(B + '/bestellungen');
await p.click(`a:has-text("${poNo}")`);
await p.click('a:has-text("Rechnung erfassen")');
const invNo = `RE-${Date.now().toString().slice(-6)}`;
await p.fill('#invoice_no', invNo);
check('Nettobetrag aus Bestellung', (await p.inputValue('#net')) === '289,00', await p.inputValue('#net'));
await p.fill('#vat', '54,91');
await p.selectOption('#site_id', { index: 1 });
await p.fill('#skonto_percent', '2');
const skontoDate = new Date(Date.now() + 5 * 86400000).toLocaleDateString('sv-SE', {
  timeZone: 'Europe/Berlin',
});
await p.fill('#skonto_until', skontoDate);
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('gespeichert', (await flash(p)).includes('Gespeichert'), await flash(p));
// Dublette
const url = p.url().split('?')[0];
const pdf = join(tmpdir(), 'eingangsrechnung.pdf');
writeFileSync(pdf, '%PDF-1.4\n% Test-Beleg\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n');
await p.locator('[data-uploader] input[type=file]').setInputFiles(pdf);
await p.waitForSelector('[data-uploader] .files li.done', { timeout: 30000 });
await p.waitForTimeout(1500);
await p.goto(url);
check('Beleg hochgeladen', (await p.locator('.filearea > ul.files li').count()) === 1);
await p.click('button:has-text("freigeben")');
await p.waitForLoadState();
check('freigegeben', (await flash(p)).includes('Freigegeben'));
await p.screenshot({ path: `${out}/e2-eingangsrechnung.png`, fullPage: true });

console.log('3. Zahlungsliste');
await p.goto(B + '/zahlungsliste');
const row = p.locator('tr', { hasText: invNo });
check(
  'Skonto 2 % abgezogen (343,91 − 6,88 = 337,03)',
  (await row.innerText()).includes('337,03'),
  await row.innerText(),
);
check('IBAN zum Kopieren', /DE\d{2} /.test(await row.innerText()));
// nur diese Rechnung als bezahlt festhalten
for (const cb of await p.locator('input[name=invoice]').all()) if (await cb.isChecked()) await cb.uncheck();
await row.locator('input[name=invoice]').check();
await p.screenshot({ path: `${out}/e3-zahlungsliste.png`, fullPage: true });
await p.click('button:has-text("Als bezahlt festhalten")');
await p.waitForLoadState();
check('als bezahlt festgehalten', (await flash(p)).includes('1 Rechnung als bezahlt'), await flash(p));
check(
  'unter „Zuletzt bezahlt“ mit Skonto',
  (
    await p.locator('.card', { hasText: 'Zuletzt bezahlt' }).locator('tr', { hasText: invNo }).innerText()
  ).includes('6,88'),
);
// zurücknehmen und stattdessen per SEPA-Datei bezahlen
await p
  .locator('.card', { hasText: 'Zuletzt bezahlt' })
  .locator('tr', { hasText: invNo })
  .locator('button:has-text("zurücknehmen")')
  .click();
await p.waitForLoadState();
check('Zahlung zurückgenommen', (await flash(p)).includes('zurückgenommen'), await flash(p));
for (const cb of await p.locator('input[name=invoice]').all()) if (await cb.isChecked()) await cb.uncheck();
await p.locator('tr', { hasText: invNo }).locator('input[name=invoice]').check();
await p.click('button:has-text("SEPA-Datei erstellen")');
await p.waitForLoadState();
check('SEPA-Datei erstellt', (await flash(p)).includes('SEPA-Datei erstellt'), await flash(p));
check('Zahlungslauf mit Skonto', (await p.locator('tr', { hasText: invNo }).innerText()).includes('337,03'));
const xml = await p.request.get(p.url().split('?')[0] + '/sepa.xml');
const xmlText = await xml.text();
check(
  'pain.001 mit Betrag',
  xml.ok() && xmlText.includes('pain.001.001.09') && xmlText.includes('337.03'),
  xmlText.slice(0, 200),
);
await p.goto(B + '/zahlungsliste');
check(
  'unter „Zuletzt bezahlt“ als SEPA, nicht zurücknehmbar',
  (
    await p.locator('.card', { hasText: 'Zuletzt bezahlt' }).locator('tr', { hasText: invNo }).innerText()
  ).includes('SEPA-Zahlungslauf') &&
    (await p
      .locator('.card', { hasText: 'Zuletzt bezahlt' })
      .locator('tr', { hasText: invNo })
      .locator('button')
      .count()) === 0,
);
check('alte Adresse leitet um', (await p.goto(B + '/zahlungslauf')).url().endsWith('/zahlungsliste'));

console.log('4. DATEV und Nachkalkulation');
await p.goto(B + '/datev');
await p.fill('#datev_consultant_no', '12345');
await p.fill('#datev_client_no', '678');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
await p.goto(B + `/datev?von=${today.slice(0, 8)}01&bis=${today}`);
await p.screenshot({ path: `${out}/e4-datev.png`, fullPage: true });
const csv = await p.request.get(B + `/datev/buchungsstapel.csv?von=${today.slice(0, 8)}01&bis=${today}`);
const body = Buffer.from(await csv.body()).toString('latin1');
check('EXTF-Kopf', body.startsWith('"EXTF";700;21;"Buchungsstapel"'));
check('Eingangsrechnung mit Kreditor 70001', body.includes(`"${invNo}"`) && body.includes(';70001;'));
await p.goto(B + `/auswertungen/nachkalkulation?monat=${today.slice(0, 7)}`);
const materialCells = await p.locator('table tbody tr td:nth-child(5)').allInnerTexts();
check(
  'Nachkalkulation zeigt Material ≥ 289,00 €',
  materialCells.some((t) => parseFloat(t.replace(/\./g, '').replace(',', '.')) >= 289),
  materialCells.join(' | '),
);
await p.screenshot({ path: `${out}/e5-nachkalkulation.png`, fullPage: true });

console.log(`\n${ok} ok, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
