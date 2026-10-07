// Browser-Test Übergaben: Kleidung ausgeben + unterschreiben (Bestand), Rückgabe ohne Unterschrift, Reiter am
// Mitarbeiter, Objektleitung: Übergabe am eigenen Objekt, kein Bestand/fremdes Objekt. Nur lokal.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('E2E nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const out = process.env.E2E_SCREENSHOTS ?? 'var/e2e';
mkdirSync(out, { recursive: true });
const SCHOOL = '00000000-0000-4000-8000-000000000011';
const SHIRT = '00000000-0000-4000-8000-0000000c7001';

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

async function sign(page, name) {
  await page.fill('#name', name);
  const box = await page.locator('#sig').boundingBox();
  await page.mouse.move(box.x + 30, box.y + 120);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++)
    await page.mouse.move(box.x + 30 + i * 12, box.y + 120 + Math.sin(i / 3) * 40, { steps: 2 });
  await page.mouse.up();
  await page.click('button:has-text("Unterschreiben")');
  await page.waitForLoadState();
}
async function shirtStock() {
  await p.goto(B + '/arbeitskleidung');
  const row = p
    .locator('tr', { hasText: 'T-Shirt grau' })
    .filter({ has: p.locator('td:nth-child(2):text-is("M")') });
  return Number((await row.locator('td').nth(2).innerText()).trim());
}

console.log('1. Zugang buchen');
const before = await shirtStock();
await p.selectOption('#article', SHIRT);
await p.fill('#size', 'M');
await p.fill('#delta', '5');
await p.click('button:has-text("Buchen")');
await p.waitForLoadState();
check('Zugang gebucht', (await shirtStock()) === before + 5);

console.log('2. Kleidung ausgeben und unterschreiben (beim Mitarbeiter)');
const listRes = await p.request.get(B + '/uebergaben', { maxRedirects: 0 });
check('keine eigene Übergaben-Seite mehr (Umleitung)', listRes.status() === 302);
const firstEmp = (await (await p.request.get(B + '/personal')).text()).match(
  /href="\/personal\/([0-9a-f-]{36})"/,
)[1];
await p.goto(B + `/personal/${firstEmp}/uebergaben`);
await p.click('a:has-text("+ Arbeitskleidung")');
await p.waitForLoadState();
const empName = (await p.locator('#employee option:checked').innerText()).trim();
await p.locator('select[name=item_article]').first().selectOption(SHIRT);
await p.locator('select[name=item_size]').first().selectOption('M');
check('kein Feld „Übergeben durch“', (await p.locator('#issuer').count()) === 0);
check('Art ohne Schlüssel (Schlüsselbuch)', !(await p.locator('#sel-art').innerText()).includes('Schlüssel'));
await p.locator('input[name=item_qty]').first().fill('2');
await p.click('button:has-text("Speichern und zur Unterschrift")');
await p.waitForLoadState();
check('Unterschriftsseite', p.url().includes('/unterschrift'), (await flash(p)) + p.url());
check(
  'Erklärung sichtbar',
  (await p.locator('body').innerText()).includes('Empfang der aufgeführten Arbeitskleidung'),
);
await p.click('button:has-text("Unterschreiben")');
check('ohne Zeichnung kein Absenden', await p.locator('#sig-hint').isVisible());
await p.screenshot({ path: `${out}/u1-unterschrift.png`, fullPage: true });
await sign(p, 'Testperson');
check('unterschrieben', (await flash(p)).includes('Unterschrieben'), await flash(p));
const hUrl = p.url().split('?')[0];
const pdf = await p.request.get(hUrl + '/protokoll.pdf');
check('Protokoll-PDF', pdf.ok() && (await pdf.body()).subarray(0, 4).toString() === '%PDF');
check('Bestand −2', (await shirtStock()) === before + 3);

console.log('3. Rückgabe ohne Unterschrift');
await p.goto(hUrl);
await p.click('a:has-text("Rückgabe erfassen")');
await p.waitForLoadState();
await p.locator('input[name=item_qty]').first().fill('1');
await p.click('button:has-text("Speichern und zur Unterschrift")');
await p.waitForLoadState();
await p.goto(p.url().replace('/unterschrift', '').split('?')[0]);
await p.fill('input[name=reason]:not([type=hidden])', 'Mitarbeiter nicht vor Ort');
await p.click('button:has-text("Ohne Unterschrift abschließen")');
await p.waitForLoadState();
check('Rückgabe abgeschlossen', (await flash(p)).includes('Ohne Unterschrift'), await flash(p));
check('Verweis auf Ausgabe', (await p.locator('body').innerText()).includes('zu Ausgabe'));
check('Bestand +1', (await shirtStock()) === before + 4);

console.log('4. Reiter am Mitarbeiter');
await p.goto(hUrl);
await p.click(`a:has-text("${empName.split(' (')[0].split(', ')[1]}")`);
await p.waitForLoadState();
check('Reiter Übergaben', p.url().endsWith('/uebergaben'));
check('Kleidung beim Mitarbeiter', (await p.locator('body').innerText()).includes('T-Shirt grau'));
await p.screenshot({ path: `${out}/u2-mitarbeiter.png`, fullPage: true });

console.log('5. Objektleitung');
const login = `olu${Date.now().toString().slice(-6)}`;
await p.goto(B + '/benutzer');
await p.click('a:has-text("Benutzer anlegen")');
await p.fill('#name', 'Udo Objektleitung');
await p.fill('#login', login);
await p.selectOption('#role', 'objektleitung');
await p.check(`#s-${SCHOOL}`);
await p.click('button:has-text("Benutzer anlegen")');
await p.waitForLoadState();
const tmp = (await p.locator('.flash b').first().innerText()).trim();
const o = await (await browser.newContext({ viewport: { width: 820, height: 1100 } })).newPage();
await o.goto(B + '/anmelden');
await o.fill('#login', login);
await o.fill('#password', tmp);
await o.click('button:has-text("Anmelden")');
await o.waitForLoadState();
await o.fill('#current', tmp);
await o.fill('#next', 'MeinPasswort2026');
await o.fill('#next2', 'MeinPasswort2026');
await o.click('button:has-text("Passwort speichern")');
await o.waitForLoadState();
check('Bestand gesperrt', (await o.goto(B + '/arbeitskleidung')).status() === 403);
check('Übergabe ohne Objekt (Büro) gesperrt', (await o.goto(hUrl)).status() === 403);
await o.goto(B + `/objekte/${SCHOOL}/uebergaben`);
check('Objekt-Reiter Übergaben für Objektleitung', (await o.locator('h1').innerText()).includes('Objekt'));
await o.click('a:has-text("+ Sonstiges")');
await o.waitForLoadState();
await o.selectOption('#employee', { index: 1 });
await o.locator('select[name=item_pick]').first().selectOption('Diensthandy');
await o.locator('select[name=item_pick]').nth(1).selectOption('__andere');
await o.locator('input[name=item_label]').nth(1).fill('Powerbank');
await o.click('button:has-text("Speichern und zur Unterschrift")');
await o.waitForLoadState();
check('Objektleitung: Unterschriftsseite', o.url().includes('/unterschrift'), await flash(o));
await sign(o, 'Mitarbeiter Test');
check('Objektleitung: unterschrieben', (await flash(o)).includes('Unterschrieben'), await flash(o));
await o.goto(B + `/objekte/${SCHOOL}/uebergaben`);
const olist = await o.locator('body').innerText();
check(
  'Objekt-Liste zeigt unterschriebene Übergabe',
  /unterschrieben/i.test(olist) && !olist.includes(hUrl.split('/').pop()),
  olist.slice(0, 300),
);
await o.screenshot({ path: `${out}/u3-objektleitung.png`, fullPage: true });

console.log('6. Fahrzeuge');
await p.goto(B + '/fahrzeuge');
await p.click('a:has-text("+ Fahrzeug anlegen")');
await p.waitForLoadState();
const plate = `M-VD ${Date.now().toString().slice(-4)}`;
await p.fill('#plate', plate);
await p.fill('#make', 'VW');
await p.fill('#model', 'Caddy');
await p.fill('#vin', 'WVWZZZ1KZ6W00001I');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('FIN mit I abgelehnt', (await flash(p)).includes('17 Zeichen'), await flash(p));
await p.fill('#vin', 'WVWZZZ1KZ6W000011');
await p.fill('#ez', '2021-03-15');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('Fahrzeug gespeichert', (await flash(p)).includes('Fahrzeug gespeichert'), await flash(p));
check('Fahrzeugschein-Upload sichtbar', (await p.locator('.filearea').count()) >= 1);
await p.goto(B + '/fahrzeuge');
const row = await p.locator('tr', { hasText: plate }).innerText();
check('Liste: Fahrzeugschein fehlt', row.includes('Fahrzeugschein fehlt') && row.includes('Caddy'), row);
await p.goto(B + `/personal/${firstEmp}/uebergaben`);
await p.click('a:has-text("+ Sonstiges")');
await p.waitForLoadState();
check(
  'Fahrzeug als Gegenstand wählbar',
  (await p.locator('select[name=item_pick]').first().innerHTML()).includes(plate),
);
await p.selectOption('#sel-an', 'nu');
await p.waitForLoadState();
check('Nachunternehmer: Auswahl statt Mitarbeiter', (await p.locator('#employee').count()) === 0);

await browser.close();
console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
