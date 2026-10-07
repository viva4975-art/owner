// Browser-Test Mitarbeiter-App: installierbar (Manifest, Service Worker), Büro verteilt ein Dokument,
// Mitarbeiter/in unterschreibt am Handy, Büro sieht den Nachweis. Legt Testdaten an → nur lokal.
import { mkdirSync } from 'node:fs';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { chromium, devices } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('E2E nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const out = process.env.E2E_SCREENSHOTS ?? 'var/e2e';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const office = await browser.newContext({
  extraHTTPHeaders: { Authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}` },
  viewport: { width: 1280, height: 900 },
  locale: 'de-DE',
});
const phone = await browser.newContext({ ...devices['Pixel 7'], locale: 'de-DE' });
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
const nav = (p, sel) => Promise.all([p.waitForNavigation({ waitUntil: 'load' }), p.click(sel)]);
const flash = async (p) => (await p.locator('.flash').allInnerTexts()).join(' | ');
const o = await office.newPage();
o.on('dialog', (d) => d.accept());
const stamp = Date.now().toString().slice(-5);

console.log('1. Installierbare App');
const man = await (await o.request.get(B + '/m/manifest.webmanifest')).json();
check(
  'Manifest mit Start /m und Icons',
  man.start_url === '/m' && man.icons.length === 3 && man.display === 'standalone',
);
const sw = await o.request.get(B + '/m/sw.js');
check('Service Worker mit Scope /m', sw.ok() && sw.headers()['service-worker-allowed'] === '/m');
check('Icon erreichbar', (await o.request.get(B + '/static/app-icon-512.png')).ok());

console.log('2. Büro: Mitarbeiterin mit PIN, Dokument verteilen');
await o.goto(B + '/neu?typ=mitarbeiter');
const pno = await o.inputValue('#personnel_no');
await o.fill('#first_name', 'Ilinca');
await o.fill('#last_name', `Doc${stamp}`);
await o.fill('#entry_date', '2026-01-01');
await o.selectOption('#employment_type', 'vollzeit');
await o.check('input[name=pay_model][value=individuell]');
await o.fill('#hourly_wage', '15,00');
await o.click('button:has-text("Speichern")');
await o.waitForLoadState();
const empId = o.url().match(/personal\/([0-9a-f-]{36})/)[1];
await o.goto(B + `/personal/${empId}/app-zugang`);
await o.fill('#pin', '5173');
await o.click('button:has-text("PIN setzen")');
await o.waitForLoadState();

const d = await PDFDocument.create();
const f = await d.embedFont(StandardFonts.Helvetica);
d.addPage().drawText('Unterweisung Arbeitsschutz – Testdokument', { x: 50, y: 780, size: 14, font: f });
const pdfBytes = Buffer.from(await d.save());

await o.goto(B + '/personal/dokumente');
check('Hinweis Schriftform sichtbar', (await o.locator('body').innerText()).includes('§ 623 BGB'));
await o.fill('#title', 'Kündigung Test');
await o.setInputFiles('#file', { name: 'k.pdf', mimeType: 'application/pdf', buffer: pdfBytes });
await o.check(`input[name=employee][value="${empId}"]`);
await o.click('button:has-text("Freigeben")');
await o.waitForLoadState();
check('Kündigung abgelehnt', (await flash(o)).includes('Schriftform'), await flash(o));

await o.goto(B + '/personal/dokumente');
await o.fill('#title', `Unterweisung ${stamp}`);
await o.selectOption('#category', 'unterweisung');
await o.setInputFiles('#file', { name: 'unterweisung.pdf', mimeType: 'application/pdf', buffer: pdfBytes });
await o.check(`input[name=employee][value="${empId}"]`);
await o.click('button:has-text("Freigeben")');
await o.waitForLoadState();
check('Dokument verteilt', (await flash(o)).includes('verteilt'), await flash(o));
const docUrl = o.url().split('?')[0];
check('Status offen', (await o.locator('body').innerText()).includes('offen'));

console.log('3. Handy: unterschreiben');
const m = await phone.newPage();
await m.goto(B + '/m');
await m.fill('#pn', pno);
await m.fill('#pin', '5173');
await nav(m, 'button:has-text("Anmelden")');
check(
  'App öffnet neues Dokument direkt',
  m.url().includes('/m/dokumente/') &&
    (await m.locator('body').innerText()).includes('Neues Dokument für Sie'),
  m.url(),
);
await nav(m, 'button:has-text("Später erinnern")');
const home = await m.locator('body').innerText();
check(
  '„Später“: Startseite, Dokument bleibt offen',
  home.includes('Zu unterschreiben: 1'),
  home.slice(0, 300),
);
await m.click('a:has-text("Zu unterschreiben")');
await m.click(`a:has-text("Unterweisung ${stamp}")`);
await m.waitForLoadState();
const pdfLink = await m.locator('a:has-text("PDF")').getAttribute('href');
const pr = await m.request.get(B + pdfLink);
check('PDF für Mitarbeiterin abrufbar', pr.ok() && (await pr.body()).subarray(0, 5).toString() === '%PDF-');
// ohne Häkchen / ohne Unterschrift
await m.click('button:has-text("Unterschreiben")');
check(
  'ohne „gelesen“ kein Absenden',
  /\/m\/dokumente\/[0-9a-f-]{36}$/.test(m.url()) &&
    (await m.evaluate(() => !document.getElementById('read').checkValidity())),
);
await m.check('#read');
await m.click('button:has-text("Unterschreiben")');
check('ohne Zeichnung Hinweis', await m.locator('#sig-hint').isVisible());
const box = await m.locator('#sig').boundingBox();
await m.mouse.move(box.x + 30, box.y + 120);
await m.mouse.down();
for (let i = 1; i <= 24; i++)
  await m.mouse.move(box.x + 30 + i * 11, box.y + 120 + Math.sin(i / 2) * 35, { steps: 2 });
await m.mouse.up();
await m.screenshot({ path: `${out}/app1-unterschrift.png` });
const docPage = m.url().split('?')[0];
await nav(m, 'button:has-text("Unterschreiben")');
check('unterschrieben', (await flash(m)).includes('unterschrieben'), await flash(m));
await m.goto(docPage);
check('Dokument: unterschrieben am', (await m.locator('body').innerText()).includes('Unterschrieben am'));
await m.screenshot({ path: `${out}/app2-unterschrieben.png` });
// fremde Anforderung nicht sichtbar
const foreign = await m.request.get(B + '/m/dokumente/00000000-0000-4000-8000-000000000999/dokument.pdf');
check('fremdes Dokument gesperrt', foreign.status() === 404);

console.log('4. Büro: Nachweis');
await o.goto(docUrl);
check('Status unterschrieben', (await o.locator('body').innerText()).includes('unterschrieben'));
const nw = await o.locator('a:has-text("Nachweis-PDF")').getAttribute('href');
const nb = await o.request.get(B + nw);
const loaded = await PDFDocument.load(await nb.body());
check('Nachweis-PDF: Original + Nachweisblatt', loaded.getPageCount() === 2);
await o.screenshot({ path: `${out}/app3-buero.png`, fullPage: true });

console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
