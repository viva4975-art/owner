// Browser-Test Planung wie Fortytools: Tafel, Terminserie mit offenem Termin + Mitarbeiter, besetzen, einen Tag
// umplanen und zurücksetzen, Monatsansicht, einmaliger Termin, Vertretungsliste. Nur lokal.
import { randomUUID } from 'node:crypto';
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

const iso = (d) => d.toISOString().slice(0, 10);
const now = new Date();
const nextMonday = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + ((8 - now.getUTCDay()) % 7 || 7)),
);
const mon = iso(nextMonday);
const wed = iso(new Date(nextMonday.getTime() + 2 * 864e5));
const stamp = Date.now().toString().slice(-5);

console.log('1. Planungstafel wie Fortytools');
await p.goto(B + `/einsatzplanung?datum=${mon}`);
const body1 = await p.locator('body').innerText();
check(
  'Abschnitte „Zu planende Einsätze“ und „Geplante Einsätze“',
  /Zu planende Einsätze/.test(body1) && /Geplante Einsätze/.test(body1),
);
check('Ansichten Tag / 5 Tage / Woche / Monat', (await p.locator('.toolbar .seg a').count()) >= 6);
check('Titel mit KW', /Planung \(KW \d+\)/.test(await p.locator('h1').innerText()));

console.log('2. Termin oder Terminserie planen');
await p.click('a:has-text("Einsatz planen")');
await p.waitForLoadState();
check(
  'Formular „Termin oder Terminserie planen“',
  (await p.locator('h1').innerText()).includes('Terminserie planen'),
);
check('Objekte nach Kunden gruppiert', (await p.locator('select[name=site_id] optgroup').count()) > 0);
await p.selectOption('select[name=site_id]', { index: 1 });
await p.check('input[name=recurrence][value=woechentlich]', { force: true });
await p.fill('input[name=valid_from]', mon);
await p.fill('input[name=start]', '17:00');
await p.fill('input[name=end]', '19:15');
check(
  'Dauer wird berechnet',
  (await p.locator('#tp-dur').innerText()).includes('2,25'),
  await p.locator('#tp-dur').innerText(),
);
for (const d of ['1', '2', '3', '4', '5', '6', '7'])
  await p.locator(`input[name=weekday][value="${d}"]`).setChecked(d === '1' || d === '3', { force: true });
// erste Zeile „offen“, zweite Zeile ein Mitarbeiter
await p.click('#emp-add');
await p.locator('.emp-row select').nth(1).selectOption({ index: 1 });
await p.fill('textarea[name=note]', `E2E Serie ${stamp}`);
await p.click('button:has-text("Planung erstellen")');
await p.waitForLoadState();
check('Planung erstellt', (await flash(p)).includes('Planung erstellt'), await flash(p));
const openBlocks = p.locator('.pb-sec').first().locator(`.pb-ev[title*="E2E Serie ${stamp}"]`);
check(
  'offener Termin unter „Zu planende Einsätze“ (Mo + Mi)',
  (await openBlocks.count()) === 2,
  String(await openBlocks.count()),
);
const planned = p.locator('.pb-sec').nth(1).locator(`.pb-ev[title*="E2E Serie ${stamp}"]`);
check(
  'Mitarbeiter-Termine in „Geplante Einsätze“',
  (await planned.count()) === 2,
  String(await planned.count()),
);
await p.screenshot({ path: `${out}/pl1-tafel.png`, fullPage: true });

console.log('3. Offenen Termin besetzen');
await openBlocks.first().click();
await p.waitForLoadState();
check('Serie öffnet sich zum Ändern', (await p.locator('h1').innerText()).includes('Terminserie ändern'));
check('Wochentage übernommen', (await p.locator('input[name=weekday]:checked').count()) === 2);
await p.locator('.emp-row select').first().selectOption({ index: 2 });
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('gespeichert', (await flash(p)).includes('Terminserie gespeichert'), await flash(p));
check(
  'nichts mehr offen',
  (await p.locator('.pb-sec').first().locator(`.pb-ev[title*="E2E Serie ${stamp}"]`).count()) === 0,
);
check(
  'jetzt 4 geplante Termine (2 Mitarbeiter × Mo/Mi)',
  (await p.locator('.pb-sec').nth(1).locator(`.pb-ev[title*="E2E Serie ${stamp}"]`).count()) === 4,
);

console.log('4. Einen Tag umplanen');
const week = p.url();
await p.locator('.pb-sec').nth(1).locator(`.pb-ev[title*="E2E Serie ${stamp}"]`).first().click();
await p.waitForLoadState();
check('Tagesseite „Einsatz umplanen“', (await p.locator('h1').innerText()).includes('umplanen'));
await p.selectOption('select[name=kind]', 'umgeplant');
await p.fill('input[name=start]', '04:00');
await p.fill('input[name=end]', '05:00');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('umgeplant gespeichert', /umgeplant gespeichert/.test(await flash(p)), await flash(p));
check('zurück in der Tafel', p.url().includes('/einsatzplanung'), p.url());
const moved = p.locator(`.pb-ev.changed[title*="E2E Serie ${stamp}"]`, { hasText: '04:00–05:00' });
check('Termin zeigt neue Zeit (lila = umgeplant)', (await moved.count()) >= 1);
await moved.first().click();
await p.waitForLoadState();
await Promise.all([p.waitForURL(/\/einsatzplanung\?/), p.click('button:has-text("Umplanung entfernen")')]);
check('zurückgesetzt', /Wieder wie geplant/.test(await flash(p)), (await flash(p)) + ' ' + p.url());
await p.goto(week);

console.log('5. Monatsansicht, Einsatzgruppen, einmaliger offener Termin');
await p.goto(B + `/einsatzplanung?ansicht=monat&datum=${mon}`);
check('Monat mit ≥ 28 Tagesspalten', (await p.locator('.pb-sec').first().locator('.pb-dh').count()) >= 28);
check('Einsatzgruppen-Auswahl', (await p.locator('select[name=gruppe] option').count()) >= 1);
await p.screenshot({ path: `${out}/pl2-monat.png`, fullPage: true });
await p.goto(B + `/einsatzplanung/${randomUUID()}?datum=${wed}`);
await p.selectOption('select[name=site_id]', { index: 1 });
await p.check('input[name=recurrence][value=einmalig]', { force: true });
await p.fill('input[name=start]', '06:00');
await p.fill('input[name=end]', '07:00');
await p.fill('textarea[name=note]', `E2E einmalig ${stamp}`);
await p.click('button:has-text("Planung erstellen")');
await p.waitForLoadState();
check(
  'einmaliger offener Termin genau einmal',
  (await p.locator(`.pb-ev[title*="E2E einmalig ${stamp}"]`).count()) === 1,
);
await p.goto(B + '/einsatzplanung/monat');
check('alte Monatstafel leitet auf die Monatsansicht', p.url().includes('ansicht=monat'), p.url());

console.log('3. Vertretungen');
await p.goto(B + '/einsatzplanung/vertretungen');
check(
  'Liste oder „Alles geregelt“',
  (await p.locator('.empty').count()) === 1 || (await p.locator('select[name=sub]').count()) > 0,
);
const sel = p.locator('select[name=sub]').first();
if ((await sel.count()) > 0) {
  await p.locator('button:has-text("Übernehmen")').first().click();
  check('ohne Auswahl kein Absenden (Pflichtfeld)', p.url().includes('/vertretungen'));
}
await p.screenshot({ path: `${out}/pl3-vertretungen.png`, fullPage: true });

console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
