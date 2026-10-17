/* global localStorage, window, getComputedStyle, Event */
// Bilder für die App-Anleitung „Objektleitung & Büro“ (Beispieldaten der Entwicklungs-DB):
// OUT=<ordner> SITE=<objekt-id> EMP=<mitarbeiter-id> node e2e/_guide-shots-buero.mjs
// Voraussetzung: Benutzer LOGIN (Standard Demo-Objektleitung „olga“) ist für die Aufnahmen mit der Beispiel-Mitarbeiterin verknüpft (Meine Zeit),
// das Objekt SITE hat ein Raumbuch.
import { chromium } from 'playwright-core';
const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const { OUT: out, SITE: site, EMP: emp } = process.env;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--lang=de-DE'] });
const ctx = await b.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  permissions: ['geolocation'],
  geolocation: { latitude: 48.137, longitude: 11.575 },
  locale: 'de-DE',
  timezoneId: 'Europe/Berlin',
});
await ctx.addInitScript(() => {
  try {
    localStorage.setItem('vd_tour_qm', '1');
    localStorage.setItem('vd_tour_m', '1');
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
const noPush = async () => {
  if (
    await m
      .locator('#push .pl')
      .isVisible()
      .catch(() => false)
  )
    await m.click('#push .pl');
};
// Seite (bzw. den scrollenden Inhaltsbereich der App) nach unten schieben
const scroll = (y) =>
  m.evaluate((y) => {
    window.scrollTo(0, y);
    document.querySelectorAll('main, .app-main, body *').forEach((e) => {
      if (e.scrollHeight > e.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(e).overflowY))
        e.scrollTop = y;
    });
  }, y);
const go = async (p, n) => {
  await m.goto(B + p);
  await noPush();
  await m.waitForTimeout(300);
  if (n) await shot(n);
};

await m.goto(B + '/app');
await m.fill('#k', process.env.LOGIN ?? 'olga');
await m.fill('#p', process.env.PASS ?? 'DemoPasswort1');
await nav('.lg-btn');
console.log('nach Anmeldung:', m.url());

// Meine Zeit
await go('/m', 'b-01-meine-zeit');
await m.click('details.appswitch summary');
await m.waitForTimeout(200);
await shot('b-02-bereich-wechseln');

// Verwaltung
await go('/qm', 'b-03-verwaltung');
await scroll(560);
await m.waitForTimeout(200);
await shot('b-04-verwaltung-bereiche');
await go('/qm/team', 'b-05-team');
await go(`/qm/team/${emp}`, 'b-06-team-person');
await go('/qm/zeiten', 'b-07-zeiten-heute');
await go('/qm/abwesenheit/neu', 'b-08-abwesenheit');
await go('/qm/objekte', 'b-09-objekte');
await go(`/qm/objekt/${site}`, 'b-10-objekt');
if (process.env.UNTERWEISUNG) await go('/qm/unterweisungen/neu', 'b-11-unterweisung');
await go('/qm/personalbogen', 'b-12-personalbogen');
await go('/qm/nu-auftrag', 'b-13-nu-auftrag');
await go('/qm/profil', 'b-14-profil');

// Qualität
await go('/qm/qualitaet', 'q-01-qualitaet');
await m.click('summary.fab');
await m.waitForTimeout(300);
await shot('q-02-plus');
await go('/qm/objekte?start=1', 'q-03-objekt-waehlen');
await go(`/qm/objekt/${site}`);
await m.click('summary.fab');
await m.waitForTimeout(300);
await nav('.qm-sheet form[action="/qm/audit/neu"] button');
await noPush();
await m.waitForTimeout(300);
await shot('q-04-raeume');
await nav('a.qm-room');
await m.waitForTimeout(300);
await shot('q-05-raum');
await m.evaluate(() => {
  const vals = ['2', '1', '2', '3', '1', '2', '1', '2'];
  document.querySelectorAll('input[type=range]').forEach((r, i) => {
    r.value = vals[i % vals.length];
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
  });
});
await m.waitForTimeout(300);
await shot('q-06-raum-bewertet');
await scroll(99999);
await m.waitForTimeout(300);
await shot('q-07-raum-speichern');
const saveRoom = m.locator('button', { hasText: 'Raumübersicht' }).first();
await Promise.all([m.waitForNavigation({ waitUntil: 'load' }), saveRoom.click()]);
await m.waitForTimeout(300);
await shot('q-08-raeume-ergebnis');
await go(`/qm/tickets/neu?objekt=${site}`, 'q-09-ticket');
console.log('Audit:', m.url());
await b.close();
