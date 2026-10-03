// Browser-Test Aufträge/Arbeitsscheine: Auftrag anlegen → Arbeitsschein vor Ort → Kunde unterschreibt auf dem
// Canvas (Maus/Finger) → PDF → Rechnung aus Auftrag mit Arbeitsschein als Anlage; Regiearbeiten ohne Auftrag.
// Legt Testdaten an → nur gegen lokale Instanz.
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('E2E nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const out = process.env.E2E_SCREENSHOTS ?? 'var/e2e';
mkdirSync(out, { recursive: true });
const CUSTOMER = '00000000-0000-4000-8000-000000000001'; // Demo-Behörde
const SITE = '00000000-0000-4000-8000-000000000011'; // Grundschule Musterweg

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const auth = { Authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}` };
const ctx = await browser.newContext({
  extraHTTPHeaders: auth,
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

async function sign(page, name) {
  await page.fill('#name', name);
  const box = await page.locator('#sig').boundingBox();
  await page.mouse.move(box.x + 30, box.y + 120);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++)
    await page.mouse.move(box.x + 30 + i * 12, box.y + 120 + Math.sin(i / 3) * 40, { steps: 2 });
  await page.mouse.up();
  await page.click('button:has-text("Unterschreiben")');
  await page.waitForLoadState();
}

console.log('1. Auftrag anlegen');
const orderId = randomUUID();
await p.goto(B + `/auftraege/${orderId}/bearbeiten?kunde=${CUSTOMER}&objekt=${SITE}`);
await p.fill('#title', 'Grundreinigung Turnhalle (E2E)');
await p.fill('#order_reference', 'E2E-' + Date.now().toString().slice(-5));
const row = p.locator('#lines tbody tr').first();
await row.locator('[name=desc]').fill('Grundreinigung Turnhalle pauschal');
await row.locator('[name=qty]').fill('1');
await row.locator('[name=price]').fill('1.250,00');
await p.click('button:has-text("Auftrag speichern")');
await p.waitForLoadState();
const orderNo = (await p.locator('body').innerText()).match(/AU-\d{4}-\d{4}/)?.[0];
check('Auftragsnummer AU-JJJJ-NNNN', !!orderNo);
const ab = await p.request.get(B + `/auftraege/${orderId}/auftragsbestaetigung.pdf`);
check('Auftragsbestätigung PDF', ab.ok() && (await ab.body()).subarray(0, 5).toString() === '%PDF-');

console.log('2. Arbeitsschein vor Ort');
await p.click(`a.btn[href*="?auftrag=${orderId}"]`);
await p.waitForLoadState();
await p.fill('#start', '07:00');
await p.fill('#end', '10:30');
await p.locator('#start').dispatchEvent('change');
await p.locator('#end').dispatchEvent('change');
check(
  'Stunden aus Beginn/Ende vorbelegt',
  (await p.locator('[name=line_qty]').first().inputValue()) === '3,5',
  await p.locator('[name=line_qty]').first().inputValue(),
);
await p.fill('#description', 'Turnhalle grundgereinigt, Boden neu beschichtet');
await p.fill('#remarks', 'Keine Mängel');
await p.click('button:has-text("Speichern und unterschreiben lassen")');
await p.waitForLoadState();
check('Unterschriftsseite geöffnet', p.url().endsWith('/unterschrift'), p.url());
const wrId = p.url().match(/arbeitsscheine\/([0-9a-f-]{36})/)?.[1];

// leere Unterschrift wird abgelehnt (im Browser)
await p.fill('#name', 'Hausmeister Maier');
await p.click('button:has-text("Unterschreiben")');
check('ohne Zeichnung kein Absenden', await p.locator('#sig-hint').isVisible());
await p.screenshot({ path: `${out}/a1-unterschrift.png`, fullPage: true });
await sign(p, 'Hausmeister Maier');
check('unterschrieben', (await p.locator('body').innerText()).includes('Hausmeister Maier'), await flash(p));
check(
  'schreibgeschützt (kein Speichern-Knopf)',
  (await p.locator('button:has-text("Speichern")').count()) === 0,
);
await p.screenshot({ path: `${out}/a2-arbeitsschein.png`, fullPage: true });
const pdf = await p.request.get(B + `/arbeitsscheine/${wrId}/arbeitsschein.pdf`);
const pdfBody = await pdf.body();
check(
  'PDF mit Unterschrift',
  pdf.ok() && pdfBody.subarray(0, 5).toString() === '%PDF-' && pdfBody.length > 20000,
  String(pdfBody.length),
);
// direkter POST auf einen abgeschlossenen Schein ändert nichts
const again = await p.request.post(B + `/arbeitsscheine/${wrId}/unterschrift`, {
  form: { name: 'Fremd', png: 'data:image/png;base64,AAAA' },
  maxRedirects: 0,
});
check('zweite Unterschrift nicht möglich', again.status() < 500);
await p.reload();
check('Name unverändert', !(await p.locator('body').innerText()).includes('Fremd'));

console.log('3. Rechnung aus Auftrag');
await p.goto(B + `/auftraege/${orderId}`);
check('Status in Arbeit', (await p.locator('.badge').first().innerText()).includes('Arbeit'));
await p.click('button:has-text("Rechnung erstellen")');
await p.waitForLoadState();
check('Rechnungsentwurf geöffnet', /\/rechnungen\/[0-9a-f-]{36}/.test(p.url()), p.url());
const inv = await p.locator('body').innerText();
check('Anlage Arbeitsschein an der Rechnung', /Arbeitsschein_AS-\d{4}-\d{4}\.pdf/.test(inv));
check('Betrag 1.250,00', inv.includes('1.250,00'));
await p.screenshot({ path: `${out}/a3-rechnung.png`, fullPage: true });
await p.goto(B + `/auftraege/${orderId}`);
check('Auftrag abgerechnet', (await p.locator('.badge').first().innerText()).includes('abgerechnet'));

console.log('4. Regiearbeiten ohne Auftrag');
const r2 = randomUUID();
await p.goto(B + `/arbeitsscheine/${r2}?objekt=${SITE}`);
await p.locator('[name=line_qty]').first().fill('2,5');
await p.fill('#description', 'Wasserschaden Keller aufgenommen');
await p.click('button:has-text("Speichern")>>nth=0');
await p.waitForLoadState();
await p.fill('[name=reason]', 'Hausmeister nicht erreichbar');
await p.click('button:has-text("Ohne Unterschrift abschließen")');
await p.waitForLoadState();
check(
  'ohne Unterschrift abgeschlossen',
  (await p.locator('body').innerText()).includes('Hausmeister nicht erreichbar'),
);
await p.goto(B + `/objekte/${SITE}/arbeitsscheine`);
const box = p.locator(`input[name=report][value="${r2}"]`);
check('in Regie-Abrechnung auswählbar', (await box.count()) === 1);
await p.screenshot({ path: `${out}/a4-objekt-arbeitsscheine.png`, fullPage: true });
await p
  .locator('input[name=report]')
  .evaluateAll((els, id) => els.forEach((e) => (e.checked = e.value === id)), r2);
await p.click('button:has-text("Regiearbeiten abrechnen")');
await p.waitForLoadState();
check('Regierechnung als Entwurf', /\/rechnungen\/[0-9a-f-]{36}/.test(p.url()), p.url());
check('Positionstext mit Arbeitsschein', (await p.locator('body').innerText()).includes('Arbeitsschein AS-'));

console.log('5. Zurück/Vor');
await p.goBack();
await p.goBack();
check('Zurück ohne Fehler', !(await p.locator('body').innerText()).includes('Fehler 500'));

console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
