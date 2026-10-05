// Browser-Test Rechnungsangaben je Objekt: „wie Kunde“ → „abweichend“ (Kundendaten übernommen), ändern, speichern,
// Vorschau „So geht die Rechnung raus“, Fehler bei unvollständiger Adresse, zurück auf „wie Kunde“. Nur lokal.
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

console.log('1. Abweichend wählen → Kundendaten werden übernommen');
await p.goto(url);
await p.check('#bm-kunde');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check(
  'Ausgangslage wie Kunde',
  (await p.locator('.card', { hasText: 'So geht die Rechnung raus' }).innerText()).includes(
    'Angaben des Kunden',
  ),
);
check('Felder verborgen', await p.locator('#bill-own').isHidden());
await p.check('#bm-eigen');
check('Felder sichtbar', await p.locator('#bill-own').isVisible());
const name = await p.inputValue('#bill_name');
check('Kundenname übernommen', name.length > 3, name);
check('Skonto-Felder erst mit Häkchen', await p.locator('#bill-skonto').isHidden());
await p.check('#bill_skonto_custom');
check('Skonto-Felder sichtbar', await p.locator('#bill-skonto').isVisible());
await p.uncheck('#bill_skonto_custom');

console.log('2. Ändern und speichern');
await p.fill('#bill_name', 'Schulverwaltung Süd');
await p.fill('#bill_street', 'Bayerstr. 28');
await p.fill('#bill_postal_code', '80335');
await p.fill('#bill_city', 'München');
await p.fill('#bill_emails', 'sued@schule.example');
await p.fill('#bill_payment_terms_days', '45');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('gespeichert', (await flash(p)).includes('gespeichert'), await flash(p));
const prev = await p.locator('.card', { hasText: 'So geht die Rechnung raus' }).innerText();
check(
  'Vorschau zeigt Objekt-Angaben',
  prev.includes('Schulverwaltung Süd') && prev.includes('sued@schule.example') && prev.includes('45 Tage'),
  prev,
);
await p.screenshot({ path: `${out}/ra-abweichend.png`, fullPage: true });

console.log('3. Unvollständige Adresse → Fehler');
await p.fill('#bill_street', '');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('Fehlermeldung', (await flash(p)).includes('Rechnungsadresse'), await flash(p));

console.log('4. Zurück auf „wie Kunde“');
await p.goto(url);
await p.check('#bm-kunde');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check(
  'wieder wie Kunde',
  (await p.locator('.card', { hasText: 'So geht die Rechnung raus' }).innerText()).includes(
    'Angaben des Kunden',
  ),
);

await browser.close();
console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
