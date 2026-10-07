// Browser-Test gemeinsame App: eine Anmeldung für alle (/app) – Personalnummer + PIN → Mitarbeiter-Ansicht,
// Benutzername + Passwort → Objektleitung & Büro; Büro-Benutzer mit verknüpftem Mitarbeiter stempelt ohne PIN.
// Legt Testdaten an → nur lokal.
import { chromium, devices } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('E2E nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
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
const stamp = Date.now().toString().slice(-6);
const admin = await (
  await browser.newContext({
    extraHTTPHeaders: { Authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}` },
    viewport: { width: 1280, height: 900 },
  })
).newPage();

console.log('1. Vorbereitung: Mitarbeiterin mit PIN, Objektleitung mit verknüpftem Mitarbeiter');
const newEmployee = async (first) => {
  await admin.goto(B + '/neu?typ=mitarbeiter');
  const pno = await admin.inputValue('#personnel_no');
  await admin.fill('#first_name', first);
  await admin.fill('#last_name', `Login${stamp}`);
  await admin.fill('#entry_date', '2026-01-01');
  await admin.selectOption('#employment_type', 'vollzeit');
  await admin.check('input[name=pay_model][value=individuell]');
  await admin.fill('#hourly_wage', '15,00');
  await admin.click('button:has-text("Speichern")');
  await admin.waitForLoadState();
  return { pno, id: admin.url().match(/personal\/([0-9a-f-]{36})/)[1] };
};
const worker = await newEmployee('Rita');
await admin.goto(B + `/personal/${worker.id}/app-zugang`);
await admin.fill('#pin', '5173');
await admin.click('button:has-text("PIN setzen")');
await admin.waitForLoadState();
const lead = await newEmployee('Oskar');
const login = `ola${stamp}`;
await admin.goto(B + '/benutzer');
await admin.click('a:has-text("Benutzer anlegen")');
await admin.fill('#name', `Oskar Login${stamp}`);
await admin.fill('#login', login);
await admin.selectOption('#role', 'objektleitung');
await admin.selectOption('#emp', lead.id);
await admin.click('button:has-text("Benutzer anlegen")');
await admin.waitForLoadState();
const tmp = (await admin.locator('.flash b').first().innerText()).trim();
check('Benutzer mit Mitarbeiter verknüpft', (await admin.inputValue('#emp')) === lead.id);

console.log('2. Reinigungskraft: Personalnummer + PIN → Mitarbeiter-Ansicht');
const phone = await (await browser.newContext({ ...devices['Pixel 7'], locale: 'de-DE' })).newPage();
await phone.goto(B + '/app');
check('ein Anmeldeformular', (await phone.locator('form[action="/app/anmelden"]').count()) === 1);
await phone.fill('#k', worker.pno);
await phone.fill('#p', '0000');
await Promise.all([phone.waitForNavigation(), phone.click('button:has-text("Anmelden")')]);
check(
  'falsche PIN → zurück mit Meldung',
  phone.url().includes('/app') && (await phone.content()).includes('flash err'),
);
check('Personalnummer bleibt eingetragen', (await phone.inputValue('#k')) === worker.pno);
await phone.fill('#p', '5173');
await Promise.all([phone.waitForNavigation(), phone.click('button:has-text("Anmelden")')]);
check('→ Mitarbeiter-Ansicht', new URL(phone.url()).pathname === '/m', phone.url());
check('kein Büro-Bereich', (await phone.goto(B + '/qm')).url().includes('/anmelden'));
await phone.goto(B + '/app');
check('erneut öffnen → direkt Mitarbeiter-Ansicht', new URL(phone.url()).pathname === '/m');

console.log('3. Objektleitung: Benutzername + Passwort → Objektleitung & Büro, Stempeln ohne PIN');
const ol = await (await browser.newContext({ ...devices['Pixel 7'], locale: 'de-DE' })).newPage();
await ol.goto(B + '/app');
await ol.fill('#k', login.toUpperCase());
await ol.fill('#p', tmp);
await Promise.all([ol.waitForNavigation(), ol.click('button:has-text("Anmelden")')]);
check('Erstpasswort ändern', ol.url().includes('/konto'), ol.url());
await ol.fill('#current', tmp);
await ol.fill('#next', 'OlPasswort2026');
await ol.fill('#next2', 'OlPasswort2026');
await Promise.all([ol.waitForNavigation(), ol.click('button:has-text("Passwort speichern")')]);
await ol.goto(B + '/app');
check('erneut öffnen → Objektleitung & Büro', new URL(ol.url()).pathname === '/qm', ol.url());
check('Kachel „Meine Zeiterfassung“', (await ol.locator('a[href="/m"]').count()) > 0);
await ol.goto(B + '/m');
const m = await ol.content();
check('eigene Zeiterfassung ohne PIN (Name)', m.includes('Oskar') && !m.includes('id="pin"'));
check('Link zurück ins Büro statt Abmelden', (await ol.locator('header a[href="/qm"]').count()) === 1);

console.log('4. Büro am PC: Knopf „Meine Zeiterfassung“');
await admin.goto(B + '/');
check('Knopf in der Kopfzeile', (await admin.locator('div.right > a[href="/m"]').count()) >= 1);

console.log('5. In der App bleiben: Büro-Seiten im App-Rahmen, Urlaub/Krank für andere');
await admin.goto(B + '/qm');
await admin.goto(B + '/objekte');
check('Büro-Seite aus der App im App-Rahmen', (await admin.locator('header.apphead').count()) === 1);
check('kein PC-Menü im App-Rahmen', (await admin.locator('aside.appside').count()) === 0);
check('Leiste unten', (await admin.locator('nav.apptabs').count()) === 1);
await admin.goto(B + `/qm/team/${worker.id}`);
check('Team: Mitarbeiterin sichtbar', (await admin.content()).includes(`Login${stamp}`));
await admin.goto(B + `/qm/abwesenheit/neu?ma=${worker.id}`);
await admin.check('input[name=kind][value=krank]');
await Promise.all([admin.waitForNavigation(), admin.click('button:has-text("Eintragen")')]);
check('Krank für andere eingetragen', (await admin.content()).includes('Krank eingetragen'), admin.url());
check(
  'Abwesenheit beim Mitarbeiter',
  (await admin.locator('.tm-card:has-text("Abwesenheiten")').innerText()).includes('genehmigt'),
);
check('Zeiten heute erreichbar', (await admin.goto(B + '/qm/zeiten')).status() === 200);
await admin.goto(B + '/?pc=1');
check('„PC-Ansicht“ schaltet zurück', (await admin.locator('aside.appside').count()) === 1);
await admin.goto(B + '/objekte');
check('bleibt in der PC-Ansicht', (await admin.locator('header.apphead').count()) === 0);
await ol.goto(B + `/qm/team/${worker.id}`);
check(
  'Objektleitung sieht fremde Mitarbeitende nicht',
  (await ol.content()).includes('nicht in Ihren Objekten'),
);

await browser.close();
console.log(`\n${ok} ok, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
