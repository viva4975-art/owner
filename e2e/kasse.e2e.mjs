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
  acceptDownloads: true,
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
p.on('dialog', (d) => d.accept().catch(() => {}));
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
p.once('dialog', (d) => d.accept().catch(() => {}));
await p.locator('summary:has-text("Buchung stornieren")').click();
await p.fill('#grund', 'E2E doppelt');
await p.click('button:has-text("Stornieren")');
await p.waitForLoadState();
check('storniert', (await flash(p)).includes('storniert'), await flash(p));
await p.goto(`${B}/kassenbuch?monat=${month}&q=Putzmittel%20${stamp}`);
check('Storno sichtbar, nicht gelöscht', (await p.locator('.kb-row.storno').count()) === 1);

console.log('4. Karten-Beleg und Auswertung');
await p.goto(`${B}/kassenbuch/kartenbelege`);
await p.click('a:has-text("+ Karten-Beleg")');
await p.waitForLoadState();
check('Neu auf eigener Seite', p.url().includes('/kassenbuch/kartenbelege/neu'));
await p.fill('#k-betrag', '45,67');
await p.fill('#k-notiz', `E2E Tanken ${stamp}`);
await p.setInputFiles('#k-datei', pdf);
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
const card = p.locator('.kb-card', { hasText: `E2E Tanken ${stamp}` });
check('Karten-Beleg archiviert', (await card.count()) === 1);
check(
  'Kachel öffnet den Beleg (neuer Tab)',
  (await card.locator('a.kb-thumb').getAttribute('target')) === '_blank' &&
    /\/kassenbuch\/kartenbeleg\//.test((await card.locator('a.kb-thumb').getAttribute('href')) ?? ''),
);
await card.locator('a:has-text("bearbeiten")').click();
await p.waitForLoadState();
check('Bearbeiten auf eigener Seite', p.url().includes('/bearbeiten'));
await p.fill('#k-notiz', `E2E Tanken2 ${stamp}`);
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check(
  'zurück zur Liste, geändert',
  (await p.locator('.kb-card', { hasText: `E2E Tanken2 ${stamp}` }).count()) === 1,
);
await p
  .locator('.kb-card', { hasText: `E2E Tanken2 ${stamp}` })
  .locator('button:has-text("löschen")')
  .click();
await p.waitForLoadState();
check(
  'im selben Monat gelöscht',
  (await p.locator('.kb-card', { hasText: `E2E Tanken2 ${stamp}` }).count()) === 0,
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
check(
  'Wiedervorlage auf der Startseite',
  (await p.locator('body').innerText()).includes('Wiedervorlage: E2E Akquise'),
);

console.log('8. Bewerber & Stellen');
await p.goto(`${B}/bewerber`);
await p.click('a:has-text("+ Neue Stelle")');
await p.selectOption('#vorlage', 'glasreiniger');
check(
  'Vorlage füllt Felder',
  (await p.inputValue('#titel')) === 'Glasreiniger' && (await p.inputValue('#stunden')) === '40',
);
await p.fill('#titel', `E2E Reinigungskraft ${stamp}`);
await p.selectOption('#art', 'Reinigungskraft');
await p.fill('#stunden', '20');
await p.selectOption('#zeit', 'morgens');
await p.fill('#plz', '81375');
await p.click('button[data-days="Mo,Di,Mi,Do,Fr"]');
await p.click('#stelle-form button:has-text("Speichern")');
await p.waitForLoadState();
check('Stelle gespeichert', (await flash(p)).includes('gespeichert'), await flash(p));
check('Arbeitstage zusammengefasst', (await p.locator('body').innerText()).includes('Mo–Fr: 06:00–10:00'));
const stelleUrl = p.url();
const plakat = await p.request.get(`${stelleUrl}/plakat`);
const ph = await plakat.text();
check('Plakat 9 Sprachen', ph.includes('Einsatzort') && ph.includes('Location') && ph.includes('WHATSAPP'));
{
  const pp = await ctx.newPage();
  pp.on('dialog', (d) => d.accept().catch(() => {}));
  await pp.goto(`${stelleUrl}/plakat`);
  const [dl] = await Promise.all([pp.waitForEvent('download'), pp.click('#jpg')]);
  const buf = await (await import('node:fs/promises')).readFile(await dl.path());
  check(
    'Plakat als JPG',
    dl.suggestedFilename().endsWith('.jpg') && buf[0] === 0xff && buf[1] === 0xd8,
    dl.suggestedFilename(),
  );
  await pp.close();
}
await p.goto(`${B}/bewerber/pool`);
await p.click('a:has-text("+ Neuer Bewerber")');
await p.fill('#name', `E2E Bewerber ${stamp}`);
await p.fill('#plz', '81379');
await p.fill('#ort', 'München');
await p.fill('#stunden', '22');
await p.selectOption('#zeit', 'morgens');
await p.click('form.card button:has-text("Speichern")');
await p.waitForLoadState();
check('Bewerber gespeichert', (await flash(p)).includes('Gespeichert'), await flash(p));
check(
  'passende Stelle beim Bewerber',
  (await p.locator('.bw-match', { hasText: `E2E Reinigungskraft ${stamp}` }).count()) === 1,
);
await p
  .locator('input[name=datei]')
  .setInputFiles({ name: 'lebenslauf.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
await p.waitForSelector('.bw-doc', { timeout: 10000 }).catch(() => {});
check('Unterlage hochgeladen', (await p.locator('.bw-doc').count()) === 1);
await p.goto(stelleUrl);
check(
  'Bewerber bei der Stelle',
  (await p.locator('.bw-match', { hasText: `E2E Bewerber ${stamp}` }).count()) === 1,
);
await p.goto(
  `${B}/bewerber/matching?los=1&ort=München&plz=81375&stunden=20&sprache=Deutsch&art=Reinigungskraft&zeit=morgens`,
);
check(
  'Manuelles Matching findet Bewerber',
  (await p.locator('.lc', { hasText: `E2E Bewerber ${stamp}` }).count()) === 1,
);

console.log('9. Glasreinigung');
await p.goto(`${B}/glasreinigung/kunden`);
await p.click('a:has-text("+ Neuer Kunde")');
await p.fill('#name', `E2E Glaskunde ${stamp}`);
await p.locator('input[name=ap_name]').first().fill('Frau Verwaltung');
await p.click('form.card button:has-text("Speichern")');
await p.waitForLoadState();
check('Glas-Kunde angelegt', (await p.locator('.lc', { hasText: `E2E Glaskunde ${stamp}` }).count()) === 1);
await p.goto(`${B}/glasreinigung/objekte`);
await p.click('a:has-text("+ Neues Objekt")');
await p.selectOption('#kunde', { label: `E2E Glaskunde ${stamp}` });
await p.fill('#name', `E2E Glasobjekt ${stamp}`);
await p.fill('#adr', 'Würmtalstr. 10, 81375 München');
await p.selectOption('#freq', '2');
await p.locator('.gp-wish > div').nth(0).locator('label:has-text("Apr")').click();
await p.locator('.gp-wish > div').nth(1).locator('label:has-text("Okt")').click();
await p.selectOption('#team', 'team_a');
await p.fill('#std', '6');
await p.click('form.card button:has-text("Speichern")');
await p.waitForLoadState();
const objCard = p.locator('.lc', { hasText: `E2E Glasobjekt ${stamp}` });
check('Objekt mit Bezirk aus PLZ', (await objCard.innerText()).includes('M-West'));
await objCard.locator('a:has-text("+ Termin")').click();
await p.waitForLoadState();
check('Termin-Vorschlag aus Stunden', (await p.locator('input[name=bis]').first().inputValue()) === '14:00');
await p.click('#gp-add-day');
check('Tag hinzufügen', (await p.locator('.gp-dayrow').count()) >= 2);
await p.locator('[data-del-day]').last().click();
await p.selectOption('#turnus', '2x');
await p.click('#gp-termin button:has-text("Speichern")');
await p.waitForLoadState();
check('Termin gespeichert', (await flash(p)).includes('gespeichert'), await flash(p));
const tcard = p.locator('.gp-card', { hasText: `E2E Glasobjekt ${stamp}` }).first();
await tcard.locator('button:has-text("Erledigt")').click();
await p.waitForLoadState();
check('Erledigt legt Folgetermin an', (await flash(p)).includes('Folgetermin'), await flash(p));
await p.goto(`${B}/glasreinigung/kalender`);
check(
  'Kalender mit Termin',
  (await p.locator('.gp-ev', { hasText: `E2E Glasobjekt ${stamp}` }).count()) >= 0 &&
    (await p.locator('.gp-cell').count()) >= 28,
);
const jp = await p.request.get(`${B}/glasreinigung/jahresplaner?jahr=${new Date().getFullYear()}`);
check('Jahresplaner', (await jp.text()).includes('Terminübersicht'));
const csvG = await p.request.get(`${B}/glasreinigung/termine.csv?status=alle`);
check('CSV-Export', (await csvG.text()).includes(`E2E Glasobjekt ${stamp}`));
await p.goto(`${B}/glasreinigung/planung`);
check('Offene Planung', (await p.locator('.stat-card').count()) >= 3);
await p.goto(`${B}/glasreinigung/autoplan`);
check('Auto-Plan Schritt 1', (await p.locator('h1').innerText()).includes('Schritt 1'));

console.log('10. Tiefgarage');
await p.goto(`${B}/tiefgarage`);
await p.click('a:has-text("+ Neues Objekt")');
await p.selectOption('#customer', 'Dawonia');
await p.fill('#name', `E2E TG ${stamp}`);
await p.fill('#postal_code', '81375');
await p.fill('#city', 'München');
await p.fill('#spaces_fixed', '30');
await p.fill('#duration', '4 Std.');
await p.selectOption('#site', { index: 1 });
await p.click('form.card button:has-text("Anlegen")');
await p.waitForLoadState();
check('TG-Objekt angelegt', (await p.locator('.lc', { hasText: `E2E TG ${stamp}` }).count()) === 1);
await p.goto(`${B}/tiefgarage/autoplan?los=1&kunde=Dawonia&kind=Grundreinigung&nur_neue=ja`);
check('Auto-Planer Vorschau', (await p.locator('tbody tr', { hasText: `E2E TG ${stamp}` }).count()) === 1);
await p.click('button:has-text("Termine übernehmen")');
await p.waitForLoadState();
check('Termine übernommen', (await flash(p)).includes('Termine angelegt'), await flash(p));
const tgCard = p.locator('.lc', { hasText: `E2E TG ${stamp}` });
check('Termin am Objekt', (await tgCard.locator('.tg-row').count()) === 1);
await tgCard.locator('button:has-text("bestätigen")').click();
await p.waitForLoadState();
check('Bestätigen legt Arbeitsschein an', (await flash(p)).includes('Arbeitsschein'), await flash(p));
const notice = await p.request.get(
  `${B}/tiefgarage/aushaenge.pdf?objekt=${await tgCard
    .locator('a:has-text("Objekt bearbeiten")')
    .getAttribute('href')
    .then((h) => h.split('/').pop())}`,
);
check('Aushang-PDF', notice.headers()['content-type'] === 'application/pdf');
const tgcsv = await p.request.get(`${B}/tiefgarage/export.csv?ansicht=alle`);
check('Excel/CSV', (await tgcsv.text()).includes(`E2E TG ${stamp}`));

console.log('11. Grundreinigung');
await p.goto(`${B}/grundreinigung`);
await p.click('a:has-text("+ Neue Planung")');
await p.fill('#kunde', 'E2E Kunde');
await p.click('#gr-next');
await p.fill('#objekt', `E2E Grundreinigung ${stamp}`);
await p.click('#gr-next');
await p.locator('#gr-floors input[name=flaeche]').first().fill('120');
await p.locator('#gr-floors input[name=preis]').first().fill('2,50');
check('Live-Verkaufspreis', (await p.locator('#gr-vk').innerText()).includes('300,00'));
await p.click('#gr-next');
check('Vorschlag an Sub', (await p.locator('#gr-box').innerText()).includes('Vorschlag an Sub'));
await p.locator('label:has-text("Eigenpersonal")').click();
check('Eigenleistung 7,5 h', (await p.locator('#gr-box').innerText()).includes('7,5 h'));
await p.click('#gr-next');
await p.fill('#von', `${new Date().getFullYear()}-11-02`);
await p.click('#gr-save');
await p.waitForLoadState();
check('Planung gespeichert', (await flash(p)).includes('gespeichert'), await flash(p));
const grCard = p.locator('.lc', { hasText: `E2E Grundreinigung ${stamp}` });
check('Karte mit VK und Stunden', (await grCard.innerText()).toLowerCase().includes('7,5 h eigenleistung'));
p.once('dialog', (d) => d.accept().catch(() => {}));
await grCard.locator('button:has-text("Ausgeführt")').click();
await p.waitForLoadState();
check('Ausgeführt', (await flash(p)).includes('Ausgeführt'), await flash(p));
const grcsv = await p.request.get(`${B}/grundreinigung/export.csv?preise=0`);
const grtxt = await grcsv.text();
check('CSV ohne Preise', grtxt.includes(`E2E Grundreinigung ${stamp}`) && !grtxt.includes('Umsatz VK'));

await browser.close();
console.log(`\ne2e:kasse: ${ok} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
