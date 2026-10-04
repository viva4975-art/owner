// Browser-Test Angebote wie Fortytools: Alternativposition (nicht in der Summe, auch in der Vorschau), Statistik,
// zuletzt bearbeitete Kunden, Folgeangebot (einmalig, Original zurückgezogen nach Versand). Nur lokal.
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

console.log('1. Liste mit Statistik');
await p.goto(B + '/angebote');
check(
  'Statistik 12 Monate',
  (await p.locator('body').innerText()).includes('Statistik der letzten 12 Monate'),
);

console.log('2. Neues Angebot mit Alternativposition');
await p.goto(B + '/neu?typ=angebot');
const recent = p.locator('a.badge', { hasText: 'DEMO' });
if ((await recent.count()) > 0) {
  await recent.first().click();
  await p.waitForSelector('#title');
  check('„zuletzt bearbeitet“ wählt den Kunden', (await p.locator('#kunde').inputValue()) !== '');
} else {
  await p.selectOption('#kunde', { label: '29901 · DEMO Beispielbehörde Referat für Bildung' });
  await p.waitForSelector('#title');
}
await p.fill('#title', 'E2E Alternativen');
const r0 = p.locator('#lines tbody tr').first();
await r0.locator('[name=desc]').fill('Unterhaltsreinigung 5×/Woche');
await r0.locator('[name=price]').fill('1.000,00');
await r0.locator('[name=rec]').selectOption('1');
await p.click('#add-line');
const r1 = p.locator('#lines tbody tr').nth(1);
await r1.locator('[name=desc]').fill('Unterhaltsreinigung 3×/Woche');
await r1.locator('[name=price]').fill('700,00');
await r1.locator('[name=rec]').selectOption('3');
check(
  'Vorschau ohne Alternative',
  (await p.innerText('#t-net')).includes('1.000,00'),
  await p.innerText('#t-net'),
);
check('Alternative in Klammern', (await r1.locator('.ln').innerText()).includes('(700,00'));
await p.click('button:has-text("Angebot speichern")');
await p.waitForLoadState();
check('gespeichert', (await flash(p)).includes('Angebot gespeichert'), await flash(p));
const url = p.url().replace(/\?.*/, '');
const totals = await p.locator('.totals').innerText();
check('Summe ohne Alternative', totals.includes('1.190,00') && totals.includes('nicht in der Summe'), totals);
check('Alternative markiert', (await p.locator('tr.alt').count()) === 1);
await p.screenshot({ path: `${out}/an1-alternative.png`, fullPage: true });
const pdf = await p.request.get(url + '/angebot.pdf');
check('PDF', pdf.ok() && (await pdf.body()).subarray(0, 4).toString() === '%PDF');

console.log('3. Folgeangebot');
await p.click('button:has-text("Als abgegeben markieren")');
await p.waitForLoadState();
await p.click('button:has-text("Folgeangebot erstellen")');
await p.waitForLoadState();
check('Folgeangebot angelegt', (await flash(p)).includes('Folgeangebot angelegt'), await flash(p));
const followEdit = p.url();
await p.goto(url);
check(
  'Original verweist aufs Folgeangebot',
  (await p.locator('body').innerText()).includes('Ersetzt durch Folgeangebot'),
);
check(
  'kein zweites Folgeangebot möglich',
  (await p.locator('button:has-text("Folgeangebot erstellen")').count()) === 0,
);
await p.goto(followEdit.replace(/\/bearbeiten.*/, ''));
await p.click('button:has-text("Als abgegeben markieren")');
await p.waitForLoadState();
await p.goto(url);
check('Original nach Versand zurückgezogen', (await p.locator('body').innerText()).includes('Zurückgezogen'));

console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
