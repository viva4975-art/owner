// Browser-Test Nachunternehmer: anlegen (GmbH), Nachweis hochladen, Portal (Link + PIN) mit Upload, Prüfung im Büro,
// Auftrag nur mit Nachweisen erteilbar, Übersicht/Zahlungslauf. Nur lokal.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('E2E nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const out = process.env.E2E_SCREENSHOTS ?? 'var/e2e';
mkdirSync(out, { recursive: true });
// kleinstes gültiges PDF für Uploads
const pdfPath = `${out}/nachweis.pdf`;
writeFileSync(
  pdfPath,
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

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
const stamp = Date.now().toString().slice(-6);

console.log('1. Nachunternehmer anlegen');
await p.goto(B + '/nachunternehmer');
await p.click('a:has-text("+ Nachunternehmer")');
await p.waitForLoadState();
await p.fill('#name', `E2E Reinigung ${stamp} GmbH`);
await p.selectOption('#kind', 'nachunternehmer');
await p.selectOption('#legal_form', 'gmbh');
await p.fill('#iban', 'DE02120300000000202051');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
await p.click('a:has-text("Nachweise, Aufträge, Portal")');
await p.waitForLoadState();
const nuUrl = p.url().split('?')[0];
check(
  'Ampel „Nachweise fehlen“',
  (await p.locator('.status-xl').innerText()).includes('Nachweise fehlen'),
);
check('HR-Auszug bei GmbH verlangt', (await p.locator('body').innerText()).includes('Handelsregisterauszug'));

console.log('2. Nachweis im Büro hochladen');
const row = p.locator('.list .row', { hasText: 'Nachunternehmervertrag' });
await row.locator('summary:has-text("Hochladen")').click();
await row.locator('input[type=file]').setInputFiles(pdfPath);
await row.locator('input[type=date]').fill('2029-09-30');
await row.locator('button:has-text("Speichern")').click();
await p.waitForLoadState();
check('gespeichert', (await flash(p)).includes('Nachweis gespeichert'), await flash(p));
check(
  'Vertrag gültig',
  (await p.locator('.list .row', { hasText: 'Nachunternehmervertrag' }).innerText()).includes('bis 30.09.2029'),
);

console.log('3. Portal');
await p.click('button:has-text("Zugang einrichten")');
await p.waitForLoadState();
const text = await p.locator('main').innerText();
const link = /\/np\/[A-Za-z0-9_-]{32}/.exec(text)?.[0];
const pin = /PIN:\s*(\d{6})/.exec(text)?.[1];
check('Link + PIN angezeigt', !!link && !!pin, text.slice(0, 200));
check('PIN nicht in der Adresse', !p.url().includes(pin));
const np = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
await np.goto(B + link);
await np.fill('#pin', '000000');
await np.click('button:has-text("Weiter")');
await np.waitForLoadState();
check('falsche PIN abgelehnt', (await np.locator('.flash').innerText()).includes('PIN falsch'));
await np.fill('#pin', pin);
await np.click('button:has-text("Weiter")');
await np.waitForLoadState();
const card = np.locator('form.card', { hasText: 'Betriebshaftpflicht' });
await card.locator('input[type=file]').setInputFiles(pdfPath);
await card.locator('input[type=date]').fill('2027-08-31');
await card.locator('button:has-text("Hochladen")').click();
await np.waitForLoadState();
check('Portal-Upload angenommen', (await np.locator('.flash').innerText()).includes('geprüft'));
check(
  'Status „in Prüfung“',
  (await np.locator('form.card', { hasText: 'Betriebshaftpflicht' }).innerText()).includes('in Prüfung'),
);
await np.screenshot({ path: `${out}/n1-portal.png`, fullPage: true });
const noLogin = await (await browser.newContext()).newPage();
await noLogin.goto(B + link);
check('ohne PIN keine Liste', (await noLogin.locator('#pin').count()) === 1);

console.log('4. Prüfen im Büro');
await p.goto(B + '/nachunternehmer/pruefen');
const f = p.locator('form.card', { hasText: `E2E Reinigung ${stamp}` });
check('Upload in „Zu prüfen“', (await f.count()) === 1);
await f.locator('button:has-text("Gültig")').click();
await p.waitForLoadState();
check('geprüft', (await flash(p)).includes('Geprüft'), await flash(p));
await p.goto(nuUrl);
check(
  'Haftpflicht jetzt gültig',
  (await p.locator('.list .row', { hasText: 'Betriebshaftpflicht' }).innerText()).includes('31.08.2027'),
);
await p.screenshot({ path: `${out}/n2-nachweise.png`, fullPage: true });

console.log('5. Auftrag');
await p.click('a:has-text("+ Auftrag")');
await p.waitForLoadState();
await p.selectOption('#site', { index: 1 });
await p.fill('#price', '1.250,00');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('Auftrag gespeichert', (await flash(p)).includes('Gespeichert'), await flash(p));
await p.click('button:has-text("Auftrag erteilen")');
await p.waitForLoadState();
check('Erteilen ohne Nachweise gesperrt', (await flash(p)).includes('Pflicht-Nachweise'), await flash(p));
const apdf = await p.request.get(p.url().split('?')[0] + '/auftrag.pdf');
check('Auftrags-PDF', apdf.ok() && (await apdf.body()).subarray(0, 4).toString() === '%PDF');

console.log('6. Übersicht / Zahlungslauf');
await p.goto(B + '/nachunternehmer');
check(
  'in der Übersicht',
  (await p.locator('.list .row', { hasText: `E2E Reinigung ${stamp}` }).count()) === 1,
);
await p.screenshot({ path: `${out}/n3-uebersicht.png`, fullPage: true });
check('Zahlungsliste lädt', (await p.goto(B + '/zahlungsliste')).ok());
check('Soll/Ist lädt', (await p.goto(B + '/nachunternehmer/monat')).ok());

await browser.close();
console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
