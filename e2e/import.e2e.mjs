// Browser-Test Import aus Fortytools: Kunden-CSV hochladen → Vorschau (Spalten, Fehlerzeile) → übernehmen →
// erneut hochladen = vorhanden, nichts doppelt. Objekte-CSV mit Bezug. Nur lokal.
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

const n = String(Date.now()).slice(-6);
const kunden = Buffer.from(
  [
    'Kd-Nr.;Firma;Straße;PLZ;Ort;Rechnungs-E-Mail;Zahlungsziel',
    `E${n}1;E2E Import Kunde A;Teststr. 1;80331;München;a@example.org;30`,
    `E${n}2;E2E Import Kunde B;Teststr. 2;1067;Dresden;b@example.org;14`,
    `E${n}3;E2E Ohne Ort;Teststr. 3;80331;;;30`,
  ].join('\r\n'),
);

const upload = async (art, name, buffer) => {
  await p.goto(B + '/transfer/import');
  await p.selectOption('#art', art);
  await p.setInputFiles('#datei', { name, mimeType: 'text/csv', buffer });
  await p.click('form[action="/transfer/import"] button');
  await p.waitForLoadState();
};

console.log('1. Kunden prüfen');
await upload('kunden', 'kunden.csv', kunden);
check('Vorschau-Seite', p.url().includes('/transfer/import/vorschau'), p.url());
const body = await p.locator('body').innerText();
check('Spalte erkannt (Kundennummer ← Kd-Nr.)', body.includes('Kundennummer ← Kd-Nr.'));
check(
  '2 neu, 1 Fehler',
  (await p.locator('tbody .badge.ok').count()) === 2 && (await p.locator('tbody .badge.err').count()) === 1,
);
await p.screenshot({ path: `${out}/i1-vorschau.png`, fullPage: true });
await p.reload();
check('Vorschau neu laden geht (GET)', (await p.locator('h1').innerText()).includes('Import prüfen'));

console.log('2. Übernehmen');
await p.click('button:has-text("neue übernehmen")');
await p.waitForLoadState();
check('2 neu übernommen', (await flash(p)).includes('2 neu'), await flash(p));
await p.goto(B + `/suche?q=E${n}2`);
check('Kunden sind da', (await p.locator('body').innerText()).includes('E2E Import Kunde B'));

console.log('3. Erneut = nichts doppelt');
await upload('kunden', 'kunden.csv', kunden);
check('jetzt „vorhanden“', (await p.locator('tbody .badge.info').count()) === 2);

console.log('4. Objekte mit Bezug');
await upload(
  'objekte',
  'objekte.csv',
  Buffer.from(
    `Objektnummer;Kundennummer;Bezeichnung;Ort\nE${n}101;E${n}1;E2E Objekt;München\nE${n}999;X${n};Ohne Kunde;`,
  ),
);
await p.click('button:has-text("neue übernehmen")');
await p.waitForLoadState();
check('Objekt übernommen, Fehlerzeile gezählt', /1 neu.*1 mit Fehlern/.test(await flash(p)), await flash(p));

console.log('5. Gesamtimport (Fortytools-Exporte unverändert, zwei Dateien auf einmal)');
const kd = `7${n}`;
const ftKunden = Buffer.from(
  [
    '"{one: ""Kundenstatus"", other: ""Kundenstatus""}";"Kundennummer";"Kurzname";"Name";"Straße";"PLZ";"Ort";"Zusatz";"Telefon";"Fax";"Mobilnummer";"E-Mail";"Homepage";"{one: ""Zahlungsbedingung"", other: ""Zahlungsbedingungen""}";"IBAN";"Kontoinhaber";"BIC";"Kurzinfo";"Einsatzort-Notizen"',
    `"Kunde";"${kd}";"E2E FT ${n}";"E2E Gesamt ${n}\nAbteilung";"Weg 1";"80331";"München";"";"";"";"";"";"";"7 Tage 3%, 20 Tage netto";"";"";"";"";""`,
  ].join('\r\n'),
);
const ftLeist = Buffer.from(
  [
    'Kundennummer;Kundenname;Straße;PLZ;Ort;Zusatz;Objektname;Auftragsnummer;Link zum Auftrag;Leistungsart;Titel;Beschreibung;Menge;Betrag;Anfangsdatum;Enddatum',
    `${kd};E2E;Weg 1;80331;München;;;;https://ft.example/contracts/e2e${n};Unterhaltsreinigung;E2E Pauschale;;1,0;500,0;01.01.2026;`,
  ].join('\r\n'),
);
await p.goto(B + '/transfer/import');
await p.setInputFiles('#ftdateien', [
  { name: 'Kunden_utf-8.csv', mimeType: 'text/csv', buffer: ftKunden },
  { name: 'active_services.csv', mimeType: 'text/csv', buffer: ftLeist },
]);
await p.click('form[action="/transfer/import/fortytools"] button');
await p.waitForLoadState();
const gb = await p.locator('body').innerText();
check('Dateien erkannt', gb.includes('Kunden ← Kunden_utf-8.csv') && gb.includes('Leistungen ← active_services.csv'), gb.slice(0, 300));
check('Hinweis: ohne Objekt → Allgemein', gb.includes('Hinweise (1)'));
await p.screenshot({ path: `${out}/i5-gesamt.png`, fullPage: true });
p.once('dialog', (d) => d.accept());
await p.click('button:has-text("Übernehmen")');
await p.waitForLoadState();
check('3 neu (Kunde, Objekt, Leistung)', (await flash(p)).includes('Gesamtimport: 3 neu'), await flash(p));
await p.goto(B + `/suche?q=E2E Gesamt ${n}`);
check('Kunde mit Name aus erster Zeile', (await p.locator('body').innerText()).includes(`E2E Gesamt ${n}`));
await p.goto(B + '/transfer/import');
check('im Protokoll als Gesamtimport', (await p.locator('body').innerText()).includes('Gesamtimport'));

console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
