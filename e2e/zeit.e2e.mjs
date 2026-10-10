// Browser-Test Zeiterfassung: Büro plant ein + setzt PIN → Mitarbeiter am Handy (QR, Stempeln, Soll bestätigen,
// Nachtrag, Urlaub, Sprache) → Büro gibt frei → Prüfbericht. Legt Testdaten an → nur gegen lokale Instanz.
// Start: npm run dev (anderes Terminal), dann npm run e2e:zeit
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('E2E nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const out = process.env.E2E_SCREENSHOTS ?? 'var/e2e';
mkdirSync(out, { recursive: true });
const SITE = '00000000-0000-4000-8000-000000000011'; // Demo: Grundschule Musterweg

const browser = await chromium.launch({
  args: ['--lang=de-DE'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const office = await browser.newContext({
  extraHTTPHeaders: { Authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}` },
  viewport: { width: 1280, height: 900 },
  locale: 'de-DE',
});
// Handy: kein Büro-Login
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
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
// Handy-Formulare senden per fetch und navigieren danach → auf die Navigation warten
const nav = (p, sel) => Promise.all([p.waitForNavigation({ waitUntil: 'load' }), p.click(sel)]);
const flash = async (p) => (await p.locator('.flash').allInnerTexts()).join(' | ');
const o = await office.newPage();
o.on('dialog', (d) => d.accept());
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });

// ---------- 1. Büro: Mitarbeiter, Einsatz, PIN ----------
console.log('1. Büro richtet ein');
await o.goto(B + '/neu?typ=mitarbeiter');
const pno = await o.inputValue('#personnel_no');
const stamp = Date.now().toString().slice(-5);
await o.fill('#first_name', 'Mara');
await o.fill('#last_name', `Test${stamp}`);
await o.fill('#entry_date', '2026-01-01');
await o.selectOption('#employment_type', 'vollzeit');
await o.check('input[name=pay_model][value=individuell]');
await o.fill('#hourly_wage', '15,00');
await o.click('button:has-text("Speichern")');
await o.waitForLoadState();
const empId = o.url().match(/personal\/([0-9a-f-]{36})/)[1];
check('Mitarbeiter angelegt', !!empId);

await o.goto(B + `/personal/${empId}/einsaetze`);
await o.click('a:has-text("Einsatz planen")');
await o.selectOption('select[name=site_id]', SITE);
check('Mitarbeiter vorbelegt', (await o.locator('.emp-row select').first().inputValue()) === empId);
for (const d of [1, 2, 3, 4, 5, 6, 7])
  await o.locator(`input[name=weekday][value="${d}"]`).check({ force: true });
await o.fill('input[name=start]', '00:05');
await o.fill('input[name=end]', '00:35');
await o.fill('input[name=valid_from]', '2026-01-01');
await o.click('button:has-text("Planung erstellen")');
await o.waitForLoadState();
check('Einsatz gespeichert', (await flash(o)).includes('Planung erstellt'), await flash(o));
await o.screenshot({ path: `${out}/z1-wochenplan.png`, fullPage: true });

await o.goto(B + `/personal/${empId}/app-zugang`);
await o.fill('#pin', '4829');
await o.click('button:has-text("PIN setzen")');
await o.waitForLoadState();
check('PIN gesetzt', (await flash(o)).includes('PIN gesetzt'));

await o.goto(B + `/objekte/${SITE}/qr`);
const qrUrl = (await o.locator('text=/\\/m\\/o\\/[0-9a-f]{32}/').first().innerText()).trim();
check('QR-Aushang mit Link', /\/m\/o\/[0-9a-f]{32}$/.test(qrUrl), qrUrl);
await o.screenshot({ path: `${out}/z2-qr-aushang.png`, fullPage: true });

// ---------- 2. Handy: QR scannen, anmelden, stempeln ----------
console.log('2. Handy: QR, Anmeldung, Stempeln');
const m = await phone.newPage();
m.on('dialog', (d) => d.accept());
await m.goto(B + new URL(qrUrl).pathname);
check('ohne Anmeldung → Login', (await m.locator('#pin').count()) === 1);
await m.screenshot({ path: `${out}/z3-handy-login.png` });
await m.fill('#pn', pno);
await m.fill('#pin', '0000');
await nav(m, 'button:has-text("Anmelden")');
await m.waitForLoadState();
check('falsche PIN abgelehnt', (await flash(m)).includes('falsch'));
await m.fill('#pn', pno);
await m.fill('#pin', '4829');
await nav(m, 'button:has-text("Anmelden")');
check('nach Login zurück am Objekt', (await m.locator('h1').innerText()).includes('Grundschule'));
// ---------- 3. Soll als Ist bestätigen ----------
console.log('3. Soll als Ist (vor dem Stempeln)');
await m.goto(B + '/m');
const confirmCards = m.locator('form[action="/m/bestaetigen"]');
check(
  'heutiger Einsatz (00:05–00:35) zu bestätigen',
  (await confirmCards.count()) >= 1,
  String(await confirmCards.count()),
);
await m.screenshot({ path: `${out}/z5-handy-start.png`, fullPage: true });
if ((await confirmCards.count()) > 0) {
  const card = confirmCards.first();
  await card.locator('button').click();
  check(
    'ohne Häkchen nicht absendbar',
    (await m.url()).endsWith('/m') || !(await flash(m)).includes('bestätigt'),
  );
  await card.locator('input[type=checkbox]').check();
  await Promise.all([m.waitForNavigation({ waitUntil: 'load' }), card.locator('button').click()]);
  check('bestätigt', (await flash(m)).includes('bestätigt'), await flash(m));
}

await m.goto(B + new URL(qrUrl).pathname);
await nav(m, 'button:has-text("Arbeit beginnen")');
check('eingestempelt', (await flash(m)).includes('Eingestempelt um'), await flash(m));
check('Laufende Zeit sichtbar', (await m.locator('.run').count()) === 1);
await m.screenshot({ path: `${out}/z4-handy-laeuft.png`, fullPage: true });
// zweimal tippen / erneut senden → kein zweiter Eintrag
await m.goBack();
await m.goBack();
await m.waitForLoadState();
await m.goto(B + new URL(qrUrl).pathname);
check(
  'am Objekt: Beenden statt Beginnen',
  (await m.locator('button:has-text("Arbeit beenden")').count()) === 1,
);
check(
  'Pause automatisch angezeigt (nach 4 Std.)',
  (await m.locator('.brk').innerText()).includes('Pause automatisch'),
);
await nav(m, 'button:has-text("Arbeit beenden")');
check('ausgestempelt', (await flash(m)).includes('Ausgestempelt'), await flash(m));

// ---------- 4. Nachtrag + Urlaub ----------
console.log('4. Nachtrag und Urlaub');
await m.click('.quick a[href="/m/nachtrag"]');
const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
await m.fill('#date', yesterday);
await m.fill('#from', '17:00');
await m.fill('#to', '19:30');
await m.fill('#reason', 'Handy-Akku leer');
await nav(m, 'button:has-text("Absenden")');
check('Nachtrag gesendet', (await flash(m)).includes('Gesendet'), await flash(m));
await m.click('.quick a[href="/m/abwesenheit"]');
await m.fill('#from', '2026-12-21');
await m.fill('#to', '2026-12-23');
await nav(m, 'button:has-text("Absenden")');
await m.waitForLoadState();
check('Urlaubsantrag gesendet', (await flash(m)).includes('Antrag gesendet'), await flash(m));
await m.screenshot({ path: `${out}/z6-handy-urlaub.png`, fullPage: true });

// Sprache
await m.goto(B + '/m/sprache?l=ro&next=/m');
check('Rumänisch', (await m.locator('button:has-text("Încep lucrul")').count()) === 1);
await m.screenshot({ path: `${out}/z7-handy-rumaenisch.png`, fullPage: true });
await m.goto(B + '/m/sprache?l=de&next=/m');

// ---------- 5. Büro: Freigaben, Urlaub, Prüfbericht ----------
console.log('5. Büro gibt frei');
await o.goto(B + '/zeiterfassung/freigaben');
const card = o.locator('.card', { hasText: `Test${stamp}` }).first();
check('Nachtrag in Freigaben', (await card.count()) === 1);
await o.screenshot({ path: `${out}/z8-freigaben.png`, fullPage: true });
await card.locator('button:has-text("Freigeben")').click();
await o.waitForLoadState();
check('freigegeben', (await flash(o)).includes('Freigegeben'));

await o.goto(B + '/urlaub');
const row = o.locator('tr', { hasText: `Test${stamp}` }).first();
await row.locator('button:has-text("Genehmigen")').click();
await o.waitForLoadState();
check('Urlaub genehmigt', (await flash(o)).includes('genehmigt'));
await o.goto(B + '/urlaub/kalender?monat=2026-12');
await o.screenshot({ path: `${out}/z9-urlaubskalender.png`, fullPage: true });

await o.goto(B + `/zeiterfassung?datum=${today}`);
check('Tagesübersicht zeigt Mitarbeiter', (await o.content()).includes(`Test${stamp}`));
await o.screenshot({ path: `${out}/z10-tagesuebersicht.png`, fullPage: true });

// Prüfbericht Zoll entfällt – die Stundenliste je Mitarbeiter enthält Beginn/Ende/Dauer
await o.goto(B + `/personal/${empId}/stundenzettel?monat=${yesterday.slice(0, 7)}`);
const rep = await o.content();
check('Stundenliste enthält Nachtrag 17:00–19:30', rep.includes('17:00') && rep.includes('19:30'));
await o.screenshot({ path: `${out}/z11-stundenliste.png`, fullPage: true });
check(
  'Prüfbericht leitet um',
  (await o.request.get(B + '/zeiterfassung/pruefbericht', { maxRedirects: 0 })).status() === 301,
);

// Korrektur mit Pflicht-Begründung + Protokoll
await o.goto(B + `/personal/${empId}/zeiten?ansicht=liste&datum=${yesterday}`);
await o.locator('.ec-list a[href^="/zeiterfassung/"]').first().click();
await o.fill('#break_minutes', '0');
await o.fill('#reason', 'E2E Korrektur');
await o.click('button:has-text("Speichern")');
await o.waitForLoadState();
check('Korrektur protokolliert', (await o.content()).includes('E2E Korrektur'));

console.log(`\n${ok} ok, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
