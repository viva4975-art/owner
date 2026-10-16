// Bilder für die App-Anleitungen (Beispieldaten der Entwicklungs-DB): OUT=<ordner> node e2e/_guide-shots.mjs
// Voraussetzung: Mitarbeiterin 7701 „Maria Beispiel“, Geburtsdatum 12.04.1990, ohne PIN, mit Einsatz heute.
import { chromium } from 'playwright-core';
const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const out = process.env.OUT;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
  permissions: ['geolocation'],
  geolocation: { latitude: 48.137, longitude: 11.575 },
});
const m = await ctx.newPage();
m.on('dialog', (d) => d.accept());
const shot = (n) => m.screenshot({ path: `${out}/${n}.jpg`, type: 'jpeg', quality: 82 });
const nav = (sel) => Promise.all([m.waitForNavigation({ waitUntil: 'load' }), m.click(sel)]);

if (process.env.OFFICE) {
  // Objektleitung/Büro: Objekt suchen in der Stoppuhr
  await m.goto(B + '/app');
  await m.fill('#k', 'ahmed');
  await m.fill('#p', 'prototyp2026');
  await nav('.lg-btn');
  await m.goto(B + '/m');
  if (await m.locator('#push .pl').isVisible()) await m.click('#push .pl');
  await m.click('summary.fab');
  await m.waitForTimeout(300);
  if (await m.locator('.pk-back').isVisible()) await m.click('.pk-back');
  await m.waitForTimeout(200);
  await shot('m-11-objekt-waehlen');
  await m.fill('#site-q', 'schule');
  await m.waitForTimeout(200);
  await shot('m-12-objekt-suchen');
  await b.close();
  process.exit(0);
}

await m.goto(B + '/app');
await m.fill('#k', '7701');
await m.fill('#p', '120490');
await shot('m-01-anmelden');
await nav('.lg-btn');
console.log('nach Anmeldung:', m.url());
await m.fill('#pin1', '4826');
await m.fill('#pin2', '4826');
await shot('m-02-neue-pin');
await nav('#pin-save');
console.log('nach PIN:', m.url());
if (await m.locator('#push .pl').isVisible()) await m.click('#push .pl');
await m.waitForTimeout(300);
await shot('m-03-startseite');
await m.click('summary.fab');
await m.waitForTimeout(300);
await shot('m-04-stoppuhr-start');
await nav('#clock-start');
if (await m.locator('#push .pl').isVisible()) await m.click('#push .pl');
await m.waitForTimeout(1500);
await shot('m-05-stoppuhr-laeuft');
await m.click('summary.fab');
await m.waitForTimeout(300);
await shot('m-06-stoppuhr-stopp');
await nav('#clock-stop');
await m.waitForTimeout(300);
await shot('m-07-gestoppt');
for (const [p, n] of [
  ['/m/abwesenheit', 'm-08-urlaub'],
  ['/m/dokumente', 'm-09-dokumente'],
  ['/m/profil', 'm-10-profil'],
]) {
  await m.goto(B + p);
  await m.waitForTimeout(300);
  await shot(n);
}
await b.close();
