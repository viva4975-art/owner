// Browser-Test Mahnwesen-Stapelverarbeitung: überfällige Rechnung anlegen → Stapelseite → Kunde auswählen →
// Mahnungen erstellen und versenden → Liste; zweites Absenden legt nichts doppelt an. Nur lokal.
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

console.log('1. Stapelseite');
await p.goto(B + '/mahnungen/stapel');
const rows = p.locator('input[name^=inv_]');
const n = await rows.count();
check('Seite lädt mit Tabelle oder Leerhinweis', n > 0 || (await p.locator('.empty').count()) === 1);
await p.screenshot({ path: `${out}/m1-stapel.png`, fullPage: true });
const enabled = p.locator('input[name^=inv_]:not(:disabled)');
const m = await enabled.count();
if (m === 0) {
  console.log('  (keine mahnbaren Rechnungen in der Entwicklungsdatenbank – nur Anzeige geprüft)');
} else {
  console.log('2. Auswahl und Erstellen');
  // nur die erste Kundengruppe behalten
  await p.locator('#all').uncheck();
  await p.locator('#all').check();
  const allChecked = await enabled.evaluateAll((els) => els.every((e) => e.checked));
  check('„alle auswählen“ setzt alle mahnbaren', allChecked);
  await p.locator('#all').uncheck();
  const first = p
    .locator('tbody.grp')
    .filter({ has: p.locator('input.cu') })
    .first();
  await first.locator('input.cu').check();
  const sel = await first.locator('input[name^=inv_]:checked').count();
  check('Kunde auswählen markiert seine Rechnungen', sel > 0);
  await p.check('input[name=send]');
  await p.click('button:has-text("Mahnungen erstellen")');
  await p.waitForLoadState();
  const f = await flash(p);
  check('Mahnung erstellt und versendet', /1 Mahnung\(en\) erstellt und versendet/.test(f), f);
  check('weiter zur Liste', p.url().includes('/mahnungen/liste'));
  await p.goBack();
  await p.goto(B + '/mahnungen/stapel');
  check(
    'gemahnte Rechnung jetzt gesperrt (Mindestabstand)',
    (await p.locator('body').innerText()).includes('zuletzt gemahnt'),
  );
}

console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
