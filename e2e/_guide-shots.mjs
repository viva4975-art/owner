/* global localStorage */
// Bilder für die App-Anleitungen (Beispieldaten der Entwicklungs-DB): OUT=<ordner> node e2e/_guide-shots.mjs
// Voraussetzung: Mitarbeiterin 7701 „Maria Beispiel“, Geburtsdatum 12.04.1990, ohne PIN, mit Einsatz heute.
// Mit PNR=<nr> PIN=<pin>: Anmeldung mit vorhandener PIN (ohne PIN-Wechsel), z. B. Demo-Mitarbeiterin 1001.
import { chromium } from 'playwright-core';
const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const out = process.env.OUT;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--lang=de-DE'] });
const ctx = await b.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
  permissions: ['geolocation'],
  geolocation: { latitude: 48.137, longitude: 11.575 },
  locale: 'de-DE',
  timezoneId: 'Europe/Berlin',
});
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('vd_tour_m', '1');
    localStorage.setItem('vd_tour_qm', '1');
  } catch {
    /* egal */
  }
  // Hinweise, die es nur im Test-Browser gibt (Mitteilungen blockiert, „als App installieren“), ausblenden
  document.addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent = '#push,#install{display:none!important}';
    document.head.appendChild(st);
  });
});
const m = await ctx.newPage();
m.on('dialog', (d) => d.accept());
// Datum/Uhrzeit-Felder wie auf einem deutschen Handy zeigen (der Test-Browser hat kein deutsches Gebietsschema)
const deInputs = () =>
  m.evaluate(() => {
    document.querySelectorAll('input[type=date],input[type=time]').forEach((i) => {
      const v = i.value;
      const t = i.type;
      i.type = 'text';
      i.value = t === 'date' ? (v ? v.split('-').reverse().join('.') : '') : v;
      if (!v) i.placeholder = t === 'date' ? 'TT.MM.JJJJ' : '--:--';
    });
  });
const shot = async (n) => {
  await deInputs();
  await m.screenshot({ path: `${out}/${n}.jpg`, type: 'jpeg', quality: 82 });
};
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
if (process.env.PIN) {
  await m.fill('#k', process.env.PNR);
  await m.fill('#p', process.env.PIN);
  await nav('.lg-btn');
} else {
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
}
if (await m.locator('#push .pl').isVisible()) await m.click('#push .pl');
await m.waitForTimeout(300);
// Offenes Dokument erscheint nach der Anmeldung sofort zum Unterschreiben
const later = m.locator('button, a', { hasText: 'Später erinnern' }).first();
if (await later.isVisible().catch(() => false)) {
  await shot('m-17-unterschreiben');
  await Promise.all([m.waitForNavigation({ waitUntil: 'load' }), later.click()]);
  await m.waitForTimeout(300);
}
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
// Zeit bestätigen: Rückfrage „Stimmt die Zeit?“ und „Zeit bearbeiten“
await m.goto(B + '/m');
await m.waitForTimeout(300);
const conf = m.locator('summary, button', { hasText: 'Zeiten bestätigen' }).first();
if (await conf.isVisible().catch(() => false)) {
  await conf.click();
  await m.waitForTimeout(300);
  await shot('m-13-stimmt-die-zeit');
  const edit = m.locator('summary, button', { hasText: 'Zeit bearbeiten' }).first();
  if (await edit.isVisible().catch(() => false)) {
    await edit.click();
    await m.waitForTimeout(300);
    await shot('m-14-zeit-bearbeiten');
  }
}
for (const [p, n] of [
  ['/m/kalender', 'm-15-kalender'],
  ['/m/stundenzettel', 'm-16-stundenliste'],
  ['/m/abwesenheit', 'm-08-urlaub'],
  ['/m/dokumente', 'm-09-dokumente'],
  ['/m/profil', 'm-10-profil'],
]) {
  await m.goto(B + p);
  await m.waitForTimeout(300);
  await shot(n);
}
await b.close();
