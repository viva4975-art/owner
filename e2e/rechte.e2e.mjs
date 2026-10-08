// Browser-Test Anmeldung und Rechte: Anmeldeformular, Admin legt Objektleitung an, Erstpasswort ändern,
// Objektleitung sieht nur eigenes Objekt und keine Rechnungen/Preise. Nur gegen lokale Instanz (Demo-Daten nötig).
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('E2E nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const out = process.env.E2E_SCREENSHOTS ?? 'var/e2e';
mkdirSync(out, { recursive: true });
const SCHOOL = '00000000-0000-4000-8000-000000000011';
const OFFICE_SITE = '00000000-0000-4000-8000-000000000012';

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
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

console.log('1. Anmeldung Admin');
const a = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await a.goto(B + '/rechnungen');
check('ohne Anmeldung → Anmeldeseite', a.url().includes('/anmelden?next=%2Frechnungen'));
await a.screenshot({ path: `${out}/r1-anmelden.png` });
await a.fill('#login', USER);
await a.fill('#password', 'falsch');
await a.click('button:has-text("Anmelden")');
check('falsches Passwort', (await flash(a)).includes('Benutzername oder Passwort falsch'));
await a.fill('#login', USER);
await a.fill('#password', PASS);
await a.click('button:has-text("Anmelden")');
await a.waitForLoadState();
check('nach Anmeldung zurück zur gewünschten Seite', new URL(a.url()).pathname === '/rechnungen', a.url());

console.log('2. Admin legt Objektleitung an');
const login = `ol${Date.now().toString().slice(-6)}`;
await a.goto(B + '/benutzer');
await a.click('a:has-text("Benutzer anlegen")');
await a.fill('#name', 'Olga Objektleitung');
await a.fill('#login', login);
await a.selectOption('#role', 'objektleitung');
await a.check(`#s-${SCHOOL}`);
await a.click('button:has-text("Benutzer anlegen")');
await a.waitForLoadState();
const tmp = (await a.locator('.flash b').first().innerText()).trim();
check('Einmal-Passwort angezeigt', /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}7$/.test(tmp), tmp);
check('Passwort nicht in der Adresse', !a.url().includes(tmp));
await a.screenshot({ path: `${out}/r2-benutzer.png`, fullPage: true });

console.log('3. Objektleitung');
const o = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await o.goto(B + '/anmelden');
await o.fill('#login', login);
await o.fill('#password', tmp);
await o.click('button:has-text("Anmelden")');
await o.waitForLoadState();
check('Erstpasswort muss geändert werden', o.url().includes('/konto'));
await o.goto(B + '/zeiterfassung');
check('ohne neues Passwort kein Zugriff', o.url().includes('/konto'));
await o.fill('#current', tmp);
await o.fill('#next', 'MeinPasswort2026');
await o.fill('#next2', 'MeinPasswort2026');
await o.click('button:has-text("Passwort speichern")');
await o.waitForLoadState();
check('danach Startseite Zeiterfassung', new URL(o.url()).pathname.startsWith('/zeiterfassung'), o.url());
const menu = await o.locator('nav.menu').innerText();
check(
  'Menü ohne Rechnungen/Angebote/Lieferanten/Transfer',
  !/Rechnungen|Angebote|Lieferanten|Transfer/.test(menu), // Auswertungen: nur Dienste-Liste
  menu.replace(/\s+/g, ' '),
);
check('keine globale Suche', (await o.locator('form.search').count()) === 0);
await o.screenshot({ path: `${out}/r3-objektleitung.png`, fullPage: true });
const r = await o.goto(B + '/rechnungen');
check('Rechnungen gesperrt (403)', r.status() === 403 && (await o.content()).includes('Keine Berechtigung'));
const leist = await o.goto(B + `/objekte/${SCHOOL}/leistungen`);
check('Preise des Objekts gesperrt', leist.status() === 403);
const other = await o.goto(B + `/objekte/${OFFICE_SITE}/einsaetze`);
check('fremdes Objekt gesperrt', other.status() === 403);
await o.goto(B + '/objekte');
const sites = await o.locator('.list.sites .row').allInnerTexts();
check(
  'Objektliste nur eigenes Objekt',
  sites.length === 1 && sites[0].includes('Grundschule'),
  sites.join(' | '),
);
await o.goto(B + `/objekte/${SCHOOL}`);
check('Objekt öffnet Einsatzplan statt Preise', o.url().endsWith('/einsaetze'));
await o.goto(B + '/einsatzplanung');
check('Wochenplan ohne fremde Objekte', !(await o.content()).includes('Verwaltungsgebäude'));
await o.goto(B + `/objekte/${SCHOOL}/stundenvorgabe`);
const svText = await o.locator('body').innerText();
check('Stundenvorgabe ohne Erlöse', svText.includes('Stundenvorgabe') && !svText.includes('Monatspauschale'));
await o.goto(B + `/objekte/${SCHOOL}/qualitaet`);
check(
  'Qualitätskontrolle eigenes Objekt',
  (await o.locator('button:has-text("Qualitätskontrolle starten")').count()) === 1,
);
const lw = await o.request.get(B + '/raumbuch/raumarten', { maxRedirects: 0 });
check('Raumarten nur Büro (403)', lw.status() === 403, String(lw.status()));
check('Einstellungen für Objektleitung gesperrt', (await o.goto(B + '/einstellungen')).status() === 403);
check('kein Zahnrad für Objektleitung', (await o.locator('a.gear').count()) === 0);
await a.goto(B + '/einstellungen');
const setText = await a.locator('main').innerText();
check(
  'Einstellungen: alle Stammlisten',
  ['Leistungsarten', 'Mahnstufen', 'Tariflöhne', 'Raumarten', 'Firmendaten'].every((t) =>
    setText.includes(t),
  ),
  setText.slice(0, 300),
);
await a.goto(B + '/einstellungen/firma');
await a.fill('input[name=phone]', '+49 89 63855496');
await a.click('button:has-text("Speichern")');
await a.waitForLoadState();
check('Firmendaten speichern', (await a.locator('.flash').innerText()).includes('Firmendaten gespeichert'));
const fq = await o.request.get(B + '/objekte/00000000-0000-4000-8000-000000000012/raumbuch', {
  maxRedirects: 0,
});
check('Raumbuch fremdes Objekt gesperrt', fq.status() === 403, String(fq.status()));
await o.goto(B + '/qualitaet');
check(
  'QK-Liste ohne fremde Objekte',
  !(await o.locator('select[name=site_id]').innerText()).includes('Verwaltungsgebäude'),
);
// Auswertungen: Objektleitung nur Dienste-Liste (eigene Objekte), keine Umsätze/Personalauswertungen
const rs = await o.request.get(B + '/auswertungen/statistik', { maxRedirects: 0 });
const ru = await o.request.get(B + '/auswertungen/urlaub', { maxRedirects: 0 });
check('Auswertungen Umsatz/Urlaub gesperrt (403)', rs.status() === 403 && ru.status() === 403);
const dl = await o.request.get(B + '/auswertungen/dienste.csv?von=2026-01-05&bis=2026-02-28');
check('Dienste-Liste nur eigene Objekte', dl.ok() && !(await dl.text()).includes('Verwaltungsgebäude'));
// Personaldokument (Admin legt an) darf die Objektleitung nicht laden
const emps = await a.request.get(B + '/personal');
const empId = (await emps.text()).match(/href="\/personal\/([0-9a-f-]{36})"/)?.[1];
await a.goto(B + `/personal/${empId}/dokumente`);
await a.selectOption('select[name=vorlage]', { index: 0 });
await a.click('button:has-text("Erstellen und ablegen")');
await a.waitForLoadState();
const fileHref = await a.locator('a[href^="/dateien/"]').first().getAttribute('href');
check('Admin lädt Personaldokument', (await a.request.get(B + fileHref)).ok());
const denied = await o.request.get(B + fileHref, { maxRedirects: 0 });
check('Objektleitung: Personaldokument gesperrt (403)', denied.status() === 403, String(denied.status()));
await o.click('.usr');
await o.click('details:has(.usr) button:has-text("Abmelden")');
await o.waitForLoadState();
check('abgemeldet', o.url().includes('/anmelden'));

console.log(`\n${ok} ok, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
