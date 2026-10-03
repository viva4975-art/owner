// Browser-Test Objektbetreuung: Raumbuch → Stundenvorgabe → Qualitätskontrolle mit Mangel und Unterschrift →
// Nachbesserungs-Aufgabe → Zählerstände. Legt Testdaten an → nur gegen lokale Instanz.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('E2E nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const out = process.env.E2E_SCREENSHOTS ?? 'var/e2e';
mkdirSync(out, { recursive: true });
const SITE = '00000000-0000-4000-8000-000000000012'; // zweites Demo-Objekt

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const auth = { Authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}` };
const ctx = await browser.newContext({
  extraHTTPHeaders: auth,
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

console.log('1. Raumbuch');
await p.goto(B + `/objekte/${SITE}/raumbuch`);
check('Raumbuch-Reiter erreichbar', (await p.title()).length > 0 && !(await body(p)).includes('Fehler 500'));
const before = await p.locator('tbody tr').count();
await p.click('a:has-text("+ Raum")');
await p.fill('#floor', 'EG');
await p.fill('#room_no', `E${tag}`);
await p.fill('#name', 'Büro Leitung');
await p.selectOption('#room_type_id', { label: 'Büro (200 m²/h)' });
await p.fill('#area', '40');
await p.selectOption('#visits', '260');
await p.click('button:has-text("Speichern und nächster Raum")');
await p.waitForLoadState();
check('nächster Raum: leeres Formular', (await p.inputValue('#name')) === '', await flash(p));
await p.fill('#floor', 'EG');
await p.fill('#room_no', `W${tag}`);
await p.fill('#name', 'WC Herren');
await p.selectOption('#room_type_id', { label: 'Sanitär / WC (80 m²/h)' });
await p.fill('#area', '16');
await p.click('button:has-text("Speichern")>>nth=-1');
await p.waitForLoadState();
check(
  'zwei Räume im Raumbuch',
  (await p.locator('tbody tr').count()) >= Math.max(before, 0) + 2 - (before === 1 ? 1 : 0),
);
check('12 min je Reinigung', (await body(p)).includes('0:12 h'));
await p.screenshot({ path: `${out}/o1-raumbuch.png`, fullPage: true });
const csv = await p.request.get(B + `/objekte/${SITE}/raumbuch.csv`);
check('CSV-Export', csv.ok() && (await csv.text()).includes('WC Herren'));
// Fehleingabe
await p.goto(B + `/objekte/${SITE}/raumbuch/${randomUUID()}`);
await p.fill('#name', 'Ohne Fläche');
await p.fill('#area', 'abc');
await p.click('button:has-text("Speichern")>>nth=-1');
await p.waitForLoadState();
check('ungültige Fläche abgelehnt', (await flash(p)).includes('Fläche'), await flash(p));

console.log('2. Stundenvorgabe');
await p.goto(B + `/objekte/${SITE}/stundenvorgabe`);
const sv = await body(p);
check('Vorgabe Std./Woche angezeigt', /Std\.\/Woche/.test(sv));
check('Vergleich Einsatzplan', sv.includes('Einsatzplan aktuell'));
check('Erlös je Stunde (Büro)', sv.includes('Erlös je Vorgabe-Std.'));
await p.screenshot({ path: `${out}/o2-stundenvorgabe.png`, fullPage: true });

console.log('3. Qualitätskontrolle');
await p.goto(B + `/objekte/${SITE}/qualitaet`);
await p.click('button:has-text("Qualitätskontrolle starten")');
await p.waitForLoadState();
check('Kontrolle angelegt (QK-Nummer)', /QK-\d{4}-\d{4}/.test(await body(p)), p.url());
const qcUrl = p.url().split('?')[0];
const rows = p.locator('table.qc tbody tr');
const n = await rows.count();
check('Bereiche aus dem Raumbuch', n >= 2 && (await body(p)).includes('WC Herren'));
for (let i = 0; i < n; i++) {
  const r = rows.nth(i);
  const isWc = (await r.innerText()).includes('WC Herren');
  await r.locator(`input[type=radio][value=${isWc ? 'mangel' : 'ok'}]`).check();
  if (isWc) {
    await r.locator('summary').click();
    await r.locator('input[type=checkbox][value="Sanitärobjekte"]').check();
    await r.locator('input[name^=note_]').fill('Urinal verkalkt');
  }
}
await p.fill('#attendee', 'Frau Huber');
await p.click('button:has-text("Speichern")>>nth=0');
await p.waitForLoadState();
check('Zwischenstand berechnet', /\d+ %/.test(await body(p)));
await p.screenshot({ path: `${out}/o3-qk.png`, fullPage: true });
await p.click('button:has-text("Speichern und abschließen")');
await p.waitForLoadState();
check('Abschluss-Seite', p.url().endsWith('/abschliessen'));
const box = await p.locator('#sig').boundingBox();
await p.mouse.move(box.x + 40, box.y + 90);
await p.mouse.down();
for (let i = 1; i <= 25; i++)
  await p.mouse.move(box.x + 40 + i * 14, box.y + 90 + Math.cos(i / 2) * 30, { steps: 2 });
await p.mouse.up();
await p.click('button:has-text("Abschließen")');
await p.waitForLoadState();
const done = await body(p);
check('abgeschlossen mit Ergebnis', /\d+ % in Ordnung/.test(done), await flash(p));
check('Nachbesserung verlinkt', (await p.locator('td a:has-text("Aufgabe")').count()) >= 1);
check('unveränderbar (kein Speichern)', (await p.locator('button:has-text("Speichern")').count()) === 0);
const pdf = await p.request.get(qcUrl + '/bericht.pdf');
check('Prüfbericht PDF', pdf.ok() && (await pdf.body()).subarray(0, 5).toString() === '%PDF-');
await p.goto(B + '/aufgaben');
check(
  'Aufgabe „Nachbesserung“ angelegt',
  (await body(p)).includes('Nachbesserung: EG · W' + tag + ' WC Herren'),
);
await p.goto(B + '/qualitaet');
check('Übersicht Qualitätskontrollen', (await body(p)).includes('in Ordnung') || /\d+ %/.test(await body(p)));

console.log('4. Zählerstände');
await p.goto(B + `/objekte/${SITE}/zaehler`);
await p.selectOption('#kind', 'wasser');
await p.fill('#meter_no', `WZ-${tag}`);
await p.fill('#location', 'Keller');
await p.click('button:has-text("Zähler anlegen")');
await p.waitForLoadState();
check('Zähler angelegt', (await body(p)).includes(`WZ-${tag}`), await flash(p));
const row = p.locator('tr', { hasText: `WZ-${tag}` });
await row.locator('input[name=read_on]').fill('2026-09-01');
await row.locator('input[name=value]').fill('1234,5');
await row.locator('button:has-text("Erfassen")').click();
await p.waitForLoadState();
check('Ablesung erfasst', (await body(p)).includes('1234,5 m³'), await flash(p));
await p
  .locator('tr', { hasText: `WZ-${tag}` })
  .locator('input[name=value]')
  .fill('1000');
await p
  .locator('tr', { hasText: `WZ-${tag}` })
  .locator('button:has-text("Erfassen")')
  .click();
await p.waitForLoadState();
check('kleinerer Stand abgelehnt', (await flash(p)).includes('kleiner'), await flash(p));
await p
  .locator('tr', { hasText: `WZ-${tag}` })
  .locator('input[name=value]')
  .fill('1300');
await p
  .locator('tr', { hasText: `WZ-${tag}` })
  .locator('button:has-text("Erfassen")')
  .click();
await p.waitForLoadState();
await p.click(`a:has-text("WZ-${tag}")`);
const mt = await body(p);
check('Verbrauch berechnet', mt.includes('65,5 m³'), mt.slice(0, 400));
await p.screenshot({ path: `${out}/o4-zaehler.png`, fullPage: true });
await p.goto(B + '/zaehler?faellig=1');
check('Übersicht fällige Ablesungen', !(await body(p)).includes('Fehler 500'));

console.log('5. Zurück/Vor');
await p.goBack();
await p.goBack();
await p.goForward();
check('Zurück/Vor ohne Fehler', !(await body(p)).includes('Fehler 500'));

console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
