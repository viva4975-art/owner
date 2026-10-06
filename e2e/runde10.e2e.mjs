// Browser-Test Runde 10: Startseite, Bordeaux, Pflichtangaben/Vergütung, Planen-Rücksprung, Urlaub auf Einsätze,
// Stundenzettel, Leistungsart je Rechnungsposition. Legt Testdaten an → nur lokal.
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
const body = async (p) => p.locator('body').innerText();
const p = await ctx.newPage();
p.on('dialog', (d) => d.accept());
const tag = `E2E${Date.now().toString().slice(-5)}`;

// ---------- 1. Startseite ----------
console.log('1. Startseite');
await p.goto(B + '/');
const h = await p.evaluate(() => document.body.scrollHeight);
check('Startseite kompakt (< 4000 px)', h < 4000, String(h));
check(
  'keine Kennzahl-Kacheln, Offene Posten als Tabelle',
  (await p.locator('.dash-kpis').count()) === 0 && (await p.locator('.op-table, .dash-empty').count()) > 0,
);
const sideBg = await p.evaluate(
  () => globalThis.getComputedStyle(document.querySelector('.appside')).backgroundImage,
);
check('Seitenleiste Bordeaux', /130, 21, 56|108, 17, 48/.test(sideBg), sideBg);
check('helles Logo', (await p.locator('.side-logo img').getAttribute('src')) === '/static/logo-hell.png');

// ---------- 2. Mitarbeiter: Pflichtangaben, Tariflohn, Festgehalt ----------
console.log('2. Mitarbeiter');
await p.goto(B + '/neu?typ=mitarbeiter');
await p.fill('#first_name', 'Rada');
await p.fill('#last_name', `Pflicht${tag}`);
await p.fill('#entry_date', '2026-01-01');
const valid = await p.evaluate(() => document.querySelector('#employment_type').checkValidity());
check('Beschäftigungsart ohne Vorauswahl = Pflichtfeld', valid === false);
await p.selectOption('#employment_type', 'teilzeit');
await p.fill('#weekly_hours', '20');
await p.check('input[name=pay_model][value=tarif]');
check('Tariflohn-Auswahl sichtbar', await p.isVisible('#wage_level_id'));
check('Festgehalt-Feld versteckt', !(await p.isVisible('#monthly_salary')));
const opts = await p.locator('#wage_level_id option').allInnerTexts();
check(
  'Tariflöhne 1/4/6 vorhanden',
  ['Tariflohn 1 (15,00 €', 'Tariflohn 4 (16,66 €', 'Tariflohn 6 Glasreiniger (18,40 €'].every((x) =>
    opts.some((o) => o.startsWith(x)),
  ),
  opts.join(' | '),
);
await p.selectOption('#wage_level_id', { label: 'Tariflohn 4 (16,66 €/Std.)' });
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
const empId = p.url().match(/personal\/([0-9a-f-]{36})$/)?.[1];
check('gespeichert', !!empId, p.url() + ' ' + (await flash(p)));
check('Vergütung in Übersicht', (await body(p)).includes('16,66 €/Std.'));
await p.goto(B + `/personal/${empId}/bearbeiten`);
await p.check('input[name=pay_model][value=festgehalt]');
await p.fill('#monthly_salary', '1.733,33');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('Festgehalt gespeichert', (await body(p)).includes('Festgehalt 1.733,33 €/Monat'), await flash(p));

// ---------- 3. Einsatz planen → zurück zum Mitarbeiter ----------
console.log('3. Einsatz vom Mitarbeiter aus planen');
await p.goto(B + `/personal/${empId}/einsaetze`);
await p.click('a:has-text("Einsatz planen")');
check('Planung mit Rücksprung', p.url().includes('zurueck='));
await p.click('a.x');
await p.waitForLoadState();
check('Schließen → zurück zum Mitarbeiter', p.url().endsWith(`/personal/${empId}/einsaetze`), p.url());
await p.click('a:has-text("Einsatz planen")');
await p.selectOption('select[name=site_id]', { index: 1 });
await p.click('button:has-text("Planung erstellen")');
await p.waitForLoadState();
check(
  'Speichern → zurück zum Mitarbeiter',
  p.url().includes(`/personal/${empId}/einsaetze`),
  p.url() + (await flash(p)),
);

// ---------- 4. Urlaub → Stunden je Einsatz ----------
console.log('4. Urlaub auf Einsätze');
const next = new Date();
next.setDate(next.getDate() + 14);
const d = next.toISOString().slice(0, 10);
await p.goto(B + `/personal/${empId}/abwesenheiten`);
await p.selectOption('#kind', 'urlaub');
await p.fill('#start', d);
await p.fill('#end', d);
await p.click('button:has-text("Erfassen")');
await p.waitForLoadState();
await p.click('a:has-text("Stunden je Einsatz")');
await p.waitForLoadState();
check(
  'Stundenseite',
  (await body(p)).includes('Stunden speichern') || (await body(p)).includes('Tag ergänzen'),
);

// ---------- 5. Stundenzettel ----------
console.log('5. Stundenzettel');
await p.goto(B + `/personal/${empId}/stundenzettel`);
check('Reiter Stundenzettel', (await body(p)).includes('Gearbeitet (netto)'));
const pr = await p.goto(B + `/personal/${empId}/stundenzettel/druck`);
const pt = await body(p);
check(
  'Druckseite mit § 17 MiLoG und Unterschriftsfeldern',
  pr.status() === 200 && pt.includes('§ 17 MiLoG') && pt.includes('Unterschrift Arbeitgeber'),
);
await p.goto(B + '/zeiterfassung/stundenzettel');
check('Monatsübersicht', (await body(p)).includes('unterschrieben'));

// ---------- 6. Rechnung: Leistungsart + mehrzeilige Beschreibung ----------
console.log('6. Rechnungsposition');
await p.goto(B + '/neu?typ=rechnung');
await p.selectOption('#kunde', { index: 1 });
await p.waitForSelector('#lines select[name=stype]');
check('Leistungsart je Position', (await p.locator('#lines select[name=stype]').count()) >= 1);
check('Beschreibung mehrzeilig', (await p.locator('#lines textarea[name=detail]').count()) >= 1);
await p.selectOption('#lines select[name=stype]', { index: 1 });
const desc = await p.inputValue('#lines input[name=desc]');
check('Leistungsart füllt leere Leistung', desc.length > 0, desc);

// ---------- 7. Lohnarten (Runde 11) ----------
console.log('7. Lohnarten');
await p.goto(B + '/zeiterfassung/lohnarten');
check('Lohnarten-Seite', (await body(p)).includes('Zuschl. Nachtarbeit'));
const csv = await p.request.get(B + '/zeiterfassung/lohnarten.csv');
check('CSV-Export', csv.status() === 200 && (await csv.text()).includes('Personalnummer;Name;Lohnart-Nr.'));
await p.goto(B + '/zeiterfassung/lohnarten/einstellungen');
check(
  'Zuschläge voreingestellt (RTV)',
  (await p.inputValue('#sunday_bp')) === '80' && (await p.inputValue('#high_holiday_bp')) === '200',
);
await p.fill('#ln-normal', '1000');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('Lohnart-Nummer gespeichert', (await p.inputValue('#ln-normal')) === '1000', await flash(p));

// ---------- 8. QM-App ----------
console.log('8. QM-App');
await p.goto(B + '/qm');
check('QM-Übersicht', (await body(p)).includes('Guten'));
await p.goto(B + '/qm/objekte');
check('Einsatzorte nach Kunde', (await p.locator('details.qm-cust').count()) > 0);
await p.locator('details.qm-cust').first().locator('summary').click();
await p.locator('a.qm-site').first().click();
await p.waitForLoadState();
check('Objekt Details', (await body(p)).includes('Vergangene Audits'));
await p.click('a:has-text("Tickets (")');
await p.waitForLoadState();
await p.click('a.fab');
await p.waitForLoadState();
await p.fill('#title', `Ticket ${tag}`);
await p.click('button:has-text("Ticket speichern")');
await p.waitForLoadState();
check('Ticket angelegt', (await body(p)).includes(`Ticket ${tag}`), await flash(p));
await p
  .locator('.qm-ticket', { hasText: `Ticket ${tag}` })
  .locator('button:has-text("erledigt")')
  .click();
await p.waitForLoadState();
check('Ticket erledigt', !(await body(p)).includes(`Ticket ${tag}`));

// ---------- 9. QM: Einstellungen + Audit Raum für Raum ----------
console.log('9. QM-Audit');
await p.goto(B + '/einstellungen/qualitaet');
await p
  .locator('table')
  .first()
  .locator('tbody tr')
  .last()
  .locator('input[name=name]')
  .fill(`Lichtschalter ${tag}`);
await p.locator('table').first().locator('tbody tr').last().locator('button').click();
await p.waitForLoadState();
check('Kontrollgegenstand angelegt', (await flash(p)).includes('gespeichert'), await flash(p));
await p.click('button:has-text("Zuordnung speichern")');
await p.waitForLoadState();
check('Zuordnung gespeichert', (await flash(p)).includes('Zuordnung gespeichert'));
await p.goto(B + '/qm/objekt/00000000-0000-4000-8000-000000000012');
await p.click('summary.fab');
await Promise.all([p.waitForNavigation(), p.click('button:has-text("Audit starten")')]);
check('Audit: Raumliste', (await p.locator('a.qm-room').count()) > 0);
await p.locator('a.qm-room').first().click();
await p.waitForLoadState();
await p.locator('.scale input[value="2"]').first().check({ force: true });
check('Gesamtnote live', (await p.textContent('#gnote')) === '80 %');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check(
  'Raum gespeichert, weiter zum nächsten Raum',
  (await flash(p)).includes('80 %') && p.url().includes('/raum/'),
  await flash(p),
);

console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
