// Browser-Test Leistungen wie Fortytools: Leistung anlegen (quartalsweise, eigene Rechnung, immer unfertig,
// Ausführungshinweis) → am Objekt abrechnen → Entwurf „unfertig“ → geprüft → Leistung bearbeiten; Leistungsarten.
// Legt Testdaten an → nur gegen lokale Instanz.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('E2E nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const out = process.env.E2E_SCREENSHOTS ?? 'var/e2e';
mkdirSync(out, { recursive: true });
const SITE = '00000000-0000-4000-8000-000000000013'; // Firmenzentrale Planegg

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
const tag = Date.now().toString().slice(-5);
const month = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }).slice(0, 7);

console.log('1. Leistungsarten');
await p.goto(B + '/einstellungen/leistungsarten');
check(
  'Stammliste mit Unterhaltsreinigung',
  (await body(p)).includes('Unterhaltsreinigung') ||
    (await p.locator('input[value="Unterhaltsreinigung"]').count()) > 0,
);

console.log('2. Leistung anlegen');
await p.goto(B + `/objekte/${SITE}/leistungen/${randomUUID()}`);
await p.fill('#valid_from', `${month}-01`);
await p.selectOption('#service_type_id', { label: 'Glasreinigung' });
check('Leistungsart füllt den Titel', (await p.inputValue('#description')) === 'Glasreinigung');
check('Kostenstelle = Objektnummer', /^\d+$/.test(await p.inputValue('#cost_center')));
check(
  'kein Steuersatz, keine Stundenvorgabe, keine Art',
  (await p.locator('#vat_rate_bp, #hours_target, #kind').count()) === 0,
);
await p.fill('#description', `Glasreinigung E2E ${tag}`);
await p.fill('#note', 'innen und außen');
await p.selectOption('#invoice_target', 'separat');
await p.selectOption('#billing_cycle', 'quartalsweise');
await p.selectOption('#bill_mode', 'automatisch'); // Test des automatischen Monatslaufs
await p.fill('#unit_price', '1.200,00');
check('Lohnkostenanteil ist Pflicht', (await p.getAttribute('#labor_share', 'required')) !== null);
await p.fill('#labor_share', '60');
await p.check('#always_unfinished');
await p.fill('#execution_notes', 'Leiter im Hausmeisterraum, Schlüssel 12');
await p.click('button:has-text("Leistung anlegen")');
await p.waitForLoadState();
check('gespeichert', (await flash(p)).includes('Leistung gespeichert'), await flash(p));
const row = p.locator('a.svc-row', { hasText: `Glasreinigung E2E ${tag}` }).first();
check(
  'in der Liste mit Zyklus und eigener Rechnung',
  (await row.innerText()).includes('quartalsweise') && (await row.innerText()).includes('eigene Rechnung'),
);
await p.screenshot({ path: `${out}/l1-leistungen.png`, fullPage: true });

console.log('3. Am Objekt abrechnen');
await p.goto(B + `/objekte/${SITE}/leistungen?monat=${month}&datum=`);
const prev = p.locator('tr', { hasText: `Glasreinigung E2E ${tag}` }).last();
check('in der Vorschau fällig', (await prev.innerText()).includes('offen'), await prev.innerText());
await p.click('button:has-text("Leistung(en) abrechnen")');
await p.waitForLoadState();
const txt = await body(p);
check('Entwurf(e) erstellt', /Rechnungsentw|Rechnungsentwurf/.test(await flash(p)), await flash(p));
if (!/\/rechnungen\//.test(p.url())) {
  // mehrere Entwürfe → zurück zur Leistungsseite; Entwurf über die Vorschau öffnen
  await p
    .locator('tr', { hasText: `Glasreinigung E2E ${tag}` })
    .last()
    .locator('a.badge')
    .click();
  await p.waitForLoadState();
}
check('Entwurf mit Unfertig-Hinweis', (await body(p)).includes('Unfertig'), txt.slice(0, 200));
const draftUrl = p.url().split('?')[0];
await p.click('button:has-text("Ausstellen")');
await p.waitForLoadState();
check('Ausstellen vor Prüfung gesperrt', (await flash(p)).includes('unfertig'), await flash(p));
await p.goto(draftUrl);
await p.click('button:has-text("Geprüft")');
await p.waitForLoadState();
check('als geprüft markiert', (await flash(p)).includes('geprüft'), await flash(p));
check('Hinweis weg', !(await body(p)).includes('Unfertig:'));
await p.screenshot({ path: `${out}/l2-entwurf.png`, fullPage: true });
await p.goto(B + `/objekte/${SITE}/leistungen?monat=${month}`);
check(
  'danach als abgerechnet markiert',
  (
    await p
      .locator('tr', { hasText: `Glasreinigung E2E ${tag}` })
      .last()
      .innerText()
  ).includes('abgerechnet'),
);

console.log('4. Bearbeiten');
await p.click(`a:has-text("Glasreinigung E2E ${tag}")`);
await p.fill('#unit_price', '1.250,00');
await p.click('button:has-text("Leistung aktualisieren")');
await p.waitForLoadState();
check(
  'Preis geändert',
  (
    await p
      .locator('tr', { hasText: `Glasreinigung E2E ${tag}` })
      .first()
      .innerText()
  ).includes('1.250,00'),
);

console.log('5. Ausführungshinweis auf dem Arbeitsschein');
await p.goto(B + `/arbeitsscheine/${randomUUID()}?objekt=${SITE}`);
check('Hinweis sichtbar', (await body(p)).includes('Leiter im Hausmeisterraum'));

console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
