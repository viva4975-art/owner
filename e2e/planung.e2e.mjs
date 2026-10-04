// Browser-Test Planung: Monatstafel, Einsatzgruppen-Filter, Umplanen eines Einsatzes (Wochenplan → Tag → zurück),
// Zurücksetzen, Vertretungsliste. Nur lokal.
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

console.log('1. Monatstafel');
await p.goto(B + '/einsatzplanung/monat');
check('Tafel mit Tagesspalten', (await p.locator('table.tafel thead th').count()) >= 29);
await p.screenshot({ path: `${out}/pl1-monat.png`, fullPage: true });
const groups = await p.locator('select[name=gruppe] option').count();
check('Einsatzgruppen-Auswahl vorhanden', groups >= 1);

console.log('2. Wochenplan nächste Woche → Einsatz umplanen');
const next = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
await p.goto(B + `/einsatzplanung?woche=${next}`);
const link = p.locator('table.plan a[href*="/tag/"]').first();
if ((await link.count()) === 0) {
  console.log('  (nächste Woche nichts geplant – nur Anzeige geprüft)');
} else {
  const week = p.url();
  await link.click();
  await p.waitForLoadState();
  check('Tagesseite „Einsatz umplanen“', (await p.locator('h1').innerText()).includes('umplanen'));
  await p.selectOption('select[name=kind]', 'umgeplant');
  await p.fill('input[name=start]', '04:00');
  await p.fill('input[name=end]', '05:00');
  await p.screenshot({ path: `${out}/pl2-tag.png`, fullPage: true });
  await p.click('button:has-text("Speichern")');
  await p.waitForLoadState();
  const f = await flash(p);
  check('umgeplant gespeichert', /umgeplant gespeichert/.test(f), f);
  check('zurück im Wochenplan', /\/einsatzplanung\?woche=\d{4}-\d{2}-\d{2}/.test(p.url()), p.url());
  check('Einsatz zeigt neue Zeit', (await p.locator('table.plan').innerText()).includes('04:00–05:00'));
  await p.locator('table.plan a', { hasText: '04:00–05:00' }).first().click();
  await p.waitForLoadState();
  await p.click('button:has-text("Wie geplant")');
  await p.waitForLoadState();
  check('zurückgesetzt', /Wieder wie geplant/.test(await flash(p)));
  await p.goto(week);
  check('Wochenplan wieder ohne 04:00', !(await p.locator('table.plan').innerText()).includes('04:00–05:00'));
}

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
