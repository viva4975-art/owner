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
  await p.click('button:has-text("Prüfen")');
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

console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
