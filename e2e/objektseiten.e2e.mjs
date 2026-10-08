// Browser-Test Objektseiten (Runde 3c): Notizen mit Anhang und Aufgabe, Dokumente mit Pflichtkategorien,
// Schlüssel je Objekt, Angebote am Objekt. Legt Testdaten an → nur gegen lokale Instanz.
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

const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const uploaded = async (n = 1) => {
  await p.waitForFunction((n) => document.querySelectorAll('[data-uploader] .files li.done').length >= n, n, {
    timeout: 20000,
  });
};

console.log('1. Notiz anlegen, ändern, Anhang, Aufgabe');
await p.goto(`${B}/objekte/${SITE}/notizen`);
await p.click('a:has-text("Notiz anlegen")');
await p.waitForLoadState();
check('Neue Notiz: Datum vorbelegt', /^\d{4}-\d{2}-\d{2}$/.test(await p.inputValue('#note_date')));
check('Erfasser angezeigt', (await body(p)).includes('Erfasser'));
await p.fill('#title', `Begehung ${tag}`);
await p.fill('#body', 'Hausmeister wünscht Reinigung der Treppenhäuser freitags.');
await p.click('button:has-text("Notiz anlegen")');
await p.waitForLoadState();
check('Notiz angelegt', (await flash(p)).includes('angelegt'), await flash(p));
const noteUrl = p.url();
await p.setInputFiles('[data-uploader] input[type=file]', {
  name: 'protokoll.pdf',
  mimeType: 'application/pdf',
  buffer: pdfBytes,
});
await uploaded();
check('Anhang hochgeladen', true);
await p.goto(noteUrl);
await p.fill('#title', `Begehung ${tag} (geändert)`);
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('Notiz geändert', (await flash(p)).includes('gespeichert'), await flash(p));
await p.goto(`${B}/objekte/${SITE}/notizen`);
const row = p.locator('tr', { hasText: `Begehung ${tag} (geändert)` });
check('Liste zeigt Titel', (await row.count()) === 1);
check(
  'Liste zeigt Anhang',
  (await row.locator('[title="Anhänge"]').count()) === 1 &&
    (await row.locator('[title="Anhänge"]').innerText()).trim() === '1',
  await row.innerText(),
);
await row.locator('a:has-text("+ Aufgabe hinzufügen")').click();
await p.waitForLoadState();
check('Aufgabe mit Titel vorbelegt', (await p.inputValue('#title')).includes(`Begehung ${tag}`));

console.log('2. Dokumente mit Pflichtkategorien');
await p.goto(`${B}/objekte/${SITE}/dokumente`);
const before = await body(p);
check(
  'Kategorien sichtbar',
  ['Raumbuch', 'Leistungsverzeichnis', 'Revierplan'].every((k) => before.includes(k)),
);
await p.setInputFiles('#kat-Revierplan [data-uploader] input[type=file]', {
  name: `revierplan-${tag}.pdf`,
  mimeType: 'application/pdf',
  buffer: pdfBytes,
});
await p.waitForFunction(() => document.querySelectorAll('#kat-Revierplan .files li.done').length >= 1, null, {
  timeout: 20000,
});
await p.reload();
check('Revierplan zählt als vorhanden', (await p.locator('#kat-Revierplan .tag.ok').count()) === 1);

console.log('3. Schlüssel je Objekt');
await p.goto(`${B}/objekte/${SITE}/schluessel`);
check('Eigene Seite (kein Umleiten)', p.url().endsWith('/schluessel') && p.url().includes('/objekte/'));
await p.fill('#key_no', `S-E2E-${tag}`);
await p.fill('#description', 'Haupteingang');
await p.click('button:has-text("Schlüssel speichern")');
await p.waitForLoadState();
check('zurück auf der Objektseite', p.url().includes(`/objekte/${SITE}/schluessel`), p.url());
const krow = p.locator('tr', { hasText: `S-E2E-${tag}` });
check('Schlüssel in der Liste', (await krow.count()) === 1);
await krow.locator('select[name=employee_id]').selectOption({ index: 1 });
await krow.locator('button:has-text("Ausgeben")').click();
await p.waitForLoadState();
check('ausgegeben', (await p.locator('tr', { hasText: `S-E2E-${tag}` }).innerText()).includes('seit'));
await p
  .locator('tr', { hasText: `S-E2E-${tag}` })
  .locator('button:has-text("Rückgabe")')
  .click();
await p.waitForLoadState();
check('zurückgegeben', (await p.locator('tr', { hasText: `S-E2E-${tag}` }).innerText()).includes('im Büro'));

console.log('4. Angebote am Objekt');
await p.goto(`${B}/objekte/${SITE}/angebote`);
check('Reiter Angebote lädt', (await body(p)).includes('Angebot für dieses Objekt'));
await p.click('a:has-text("Angebot für dieses Objekt")');
await p.waitForLoadState();
check('Angebot mit Objekt vorbelegt', p.url().includes('/angebote/'), p.url());

console.log('5. Raumbuch aus Excel/CSV importieren');
await p.goto(`${B}/objekte/${SITE}/raumbuch`);
await p.click('a:has-text("Aus Excel importieren")');
await p.waitForLoadState();
const csvRooms = `Raumbuch Verwaltung\n\nEtage;Raum-Nr.;Raum;Raumart;Bodenbelag;Fläche m²;Intervall\nEG;I${tag}1;Empfang;Eingangsbereich;Fliesen;32,5;5x wöchentlich\nEG;I${tag}2;Archiv;Archivraum ${tag};PVC;12;14-tägig\nEG;I${tag}3;Kaputt;Büro;;abc;täglich\n`;
await p.setInputFiles('#file', { name: 'raumbuch.csv', mimeType: 'text/csv', buffer: Buffer.from(csvRooms) });
await p.click('button:has-text("Vorschau anzeigen")');
await p.waitForLoadState();
const prev = await body(p);
check('Vorschau zeigt Räume', prev.includes('Empfang') && prev.includes('Archiv'), prev.slice(0, 300));
check('neue Raumart angekündigt', prev.includes(`Neue Raumarten werden angelegt: Archivraum ${tag}`));
check('Intervall erkannt', prev.includes('5× pro Woche') && prev.includes('14-täglich'));
check('Fehlerzeile markiert', prev.includes('Fläche „abc“ ungültig'));
check('Vorschau ist eine GET-Seite', p.url().includes('/raumbuch/import?datei='));
await p.click('button:has-text("neue Räume übernehmen")');
await p.waitForLoadState();
check('2 Räume importiert', (await flash(p)).includes('2 neu'), await flash(p));
check('Räume im Raumbuch', (await body(p)).includes(`I${tag}1`));
await p.goBack();
await p.reload();
await p.click('button:has-text("neue Räume übernehmen")').catch(() => {});
await p.waitForLoadState();
await p.goto(`${B}/objekte/${SITE}/raumbuch`);
check('nichts doppelt', (await p.locator('tr', { hasText: `I${tag}1` }).count()) === 1);

console.log('6. Einsätze als Kalender');
await p.goto(`${B}/objekte/${SITE}/einsaetze`);
check('Standard: Wochenansicht', (await p.locator('.calbar .seg a.on').first().innerText()) === 'Woche');
check('7 Tagesspalten', (await p.locator('.cal .dh').count()) === 7);
check(
  'Zusammenfassung + nächste Einsätze',
  (await body(p)).includes('Zusammenfassung') && (await body(p)).includes('Nächste Einsätze'),
);
check(
  'höchstens 15 nächste Einsätze',
  (await p.locator('section:has(h3:has-text("Nächste Einsätze")) tbody tr').count()) <= 15,
);
for (const [v, n] of [
  ['Monat', 7],
  ['5 Tage', 5],
  ['Tag', 1],
]) {
  await p.click(`.calbar .seg a:has-text("${v}")`);
  await p.waitForLoadState();
  check(
    `Ansicht ${v}`,
    (await p.locator('.cal .dh').count()) === n,
    String(await p.locator('.cal .dh').count()),
  );
}
await p.click('.calbar a[aria-label=vor]');
await p.waitForLoadState();
check('Blättern', p.url().includes('ansicht=tag&datum='));
await p.click('.calbar .seg a:has-text("Wiederkehrende Einsätze")');
await p.waitForLoadState();
check(
  'Liste der wiederkehrenden Einsätze',
  !(await body(p)).includes('Fehler 500') && (await p.locator('.cal').count()) === 0,
);

console.log('7. Erfasste Zeiten');
await p.goto(`${B}/objekte/${SITE}/zeiten`);
const zt = await body(p);
check(
  'Übersicht mit Dauer/Geplant/Gesamtsumme',
  ['Dauer', 'Geplant', 'Gesamtsumme', 'Monatsübersicht'].every((x) => zt.includes(x)),
);
await p.click('a:has-text("Details")');
await p.waitForLoadState();
check('Details-Ansicht', p.url().includes('ansicht=details') && (await body(p)).includes('Beginn'));
await p.fill('#von', '2026-09-01');
await p.fill('#bis', '2026-09-30');
await p.click('button:has-text("Zeitraum")');
await p.waitForLoadState();
check('freier Zeitraum', (await body(p)).includes('01.09.2026 – 30.09.2026'));
await p.goto(`${B}/objekte/${SITE}/zeiten?monat=2026-09`);
const sepRow = p.locator('tr', { hasText: 'September 2026' });
if ((await sepRow.locator('button:has-text("zurücknehmen")').count()) > 0) {
  await sepRow.locator('button:has-text("zurücknehmen")').click();
  await p.waitForLoadState();
}
await p.locator('tr', { hasText: 'September 2026' }).locator('button:has-text("bestätigen")').click();
await p.waitForLoadState();
check('Monat bestätigt', (await flash(p)).includes('bestätigt'), await flash(p));
check(
  'Haken sichtbar',
  (await p.locator('tr', { hasText: 'September 2026' }).innerText()).includes('✓ bestätigt'),
);

await p.goBack();
await p.goBack();
await p.goForward();
check('Zurück/Vor ohne Fehler', !(await body(p)).includes('Fehler 500'));

console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
