// Browser-Test Personal wie Fortytools: Lohnstufe, Stammdaten (Anrede, Tags, Warnhinweis), Tag-Filter, Dokument aus
// Vorlage, Serienbrief, Einsatzkalender, Soll/Plan/Ist. Legt Testdaten an → nur lokal.
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
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
const body = async (p) => p.locator('body').innerText();
const p = await ctx.newPage();
p.on('dialog', (d) => d.accept());
const tag = `E2E${Date.now().toString().slice(-5)}`;

console.log('1. Lohnstufe');
await p.goto(B + '/personal/lohnstufen');
const last = p.locator('tbody tr').last();
await last.locator('input[name=name]').fill(`Tarif ${tag}`);
await last.locator('input[name=wage]').fill('14,25');
await last.locator('button').click();
await p.waitForLoadState();
check('Lohnstufe angelegt', (await flash(p)).includes('gespeichert'), await flash(p));

console.log('2. Mitarbeiter mit neuen Stammdaten');
await p.goto(B + '/neu?typ=mitarbeiter');
await p.selectOption('#salutation', 'Herr');
await p.fill('#first_name', 'Amar');
await p.fill('#last_name', `Abas${tag}`);
await p.fill('#entry_date', '2026-01-01');
await p.fill('#tag-in', tag);
await p.press('#tag-in', 'Enter');
await p.fill('#warning_note', 'kein Einsatz in Schulen');
await p.fill('#weekly_hours', '30');
await p.selectOption('#employment_type', 'teilzeit');
await p.check('input[name=pay_model][value=tarif]');
await p.selectOption('#wage_level_id', { label: `Tarif ${tag} (14,25 €/Std.)` });
await p.fill('#street', 'Hauptstr. 12');
await p.fill('#postal_code', '84101');
await p.fill('#city', 'Obersüßbach');
await p.fill('#birth_place', 'Damaskus');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
const empUrl = p.url().split('?')[0];
const txt = await body(p);
check('Warnhinweis sichtbar', txt.includes('kein Einsatz in Schulen'));
check('Lohn aus Lohnstufe', txt.includes('14,25 €/Std.'), txt.slice(0, 600));
check('Soll/Plan/Ist-Box', txt.includes('Dispo & Zeiterfassung'));
await p.screenshot({ path: `${out}/p1-uebersicht.png`, fullPage: true });

console.log('3. Tag-Filter');
await p.goto(B + `/personal?status=aktiv&tag=${tag}`);
check(
  'Filter zeigt genau den Mitarbeiter',
  (await p.locator('.emp-card').count()) === 1 && (await body(p)).includes(`Abas${tag}`),
);

console.log('4. Dokument aus Vorlage');
await p.goto(empUrl + '/dokumente');
await p.selectOption('select[name=vorlage]', {
  label: 'Bescheinigung über das Beschäftigungsverhältnis (Bescheinigung)',
});
await p.click('button:has-text("Erstellen und ablegen")');
await p.waitForLoadState();
check('Dokument erstellt', (await flash(p)).includes('erstellt und abgelegt'), await flash(p));
const href = await p.locator('a[href^="/dateien/"]').first().getAttribute('href');
const dl = await p.request.get(B + href);
const pdfBytes = await dl.body();
check('Download als PDF', dl.ok() && pdfBytes.subarray(0, 5).toString() === '%PDF-');
check('unter Kategorie „Bescheinigung“', (await body(p)).includes('Bescheinigung'));
await p.screenshot({ path: `${out}/p2-dokumente.png`, fullPage: true });

console.log('5. Serienbrief');
const sb = await p.request.get(
  B + `/personal/serienbrief.pdf?status=aktiv&tag=${tag}&vorlage=00000000-0000-4000-8000-0000000c1001`,
);
const doc = await PDFDocument.load(await sb.body());
check('Serienbrief mit einer Seite', doc.getPageCount() === 1);

console.log('6. Einsatzkalender');
await p.goto(empUrl + '/kalender?monat=2026-10');
check('Kalender mit Feiertag', (await body(p)).includes('Tag der Deutschen Einheit'));

console.log('7. Zugriffsschutz Dateien');
const fake = await p.request.get(B + `/dateien/${randomUUID()}`);
check('unbekannte Datei 404', fake.status() === 404);

console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
