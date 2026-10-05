// Browser-Test Transfer: Kontoauszug (CAMT.053) einlesen, Vorschlag übernehmen (Teilzahlung 0,01 € auf einen offenen
// Posten, damit die Demo-Daten erhalten bleiben), doppelt einlesen, Umsatz abhaken, Lastschrift-Seite mit Gläubiger-ID
// und Mandatsprüfung, Dokumenteneingang hochladen + zuordnen, Dokumentenversand. Nur lokal.
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

const stamp = Date.now();
const today = new Date().toISOString().slice(0, 10);
const camt = (entries) =>
  Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><GrpHdr><MsgId>${stamp}</MsgId></GrpHdr>
<Stmt><Id>1</Id><Acct><Id><IBAN>DE39701900000003297837</IBAN></Id></Acct>${entries}</Stmt></BkToCstmrStmt></Document>`);
const entry = (amount, ind, purpose) => `<Ntry><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>${ind}</CdtDbtInd>
<Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${today}</Dt></BookgDt><AcctSvcrRef>E2E${stamp}${ind}</AcctSvcrRef>
<NtryDtls><TxDtls><RltdPties><Dbtr><Pty><Nm>E2E Zahler</Nm></Pty></Dbtr></RltdPties><RmtInf><Ustrd>${purpose}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`;

console.log('1. Kontoauszug einlesen');
await p.goto(B + '/offene-posten');
const no = (
  await p
    .locator('.op-item .op-row a b')
    .first()
    .innerText()
    .catch(() => '')
).trim();
const file = camt(
  (no ? entry('0.01', 'CRDT', `RE ${no} E2E ${stamp}`) : '') +
    entry('12.34', 'DBIT', `E2E Bankgebuehr ${stamp}`),
);
await p.goto(B + '/transfer/kontoumsaetze');
await p.setInputFiles('#datei', { name: `auszug-${stamp}.xml`, mimeType: 'application/xml', buffer: file });
await p.click('button:has-text("Einlesen")');
await p.waitForLoadState();
const n = no ? 2 : 1;
check('eingelesen', (await flash(p)).includes(`${n} Umsätze gelesen, davon ${n} neu`), await flash(p));
await p.screenshot({ path: `${out}/t1-umsaetze.png`, fullPage: true });

await p.setInputFiles('#datei', {
  name: `auszug-${stamp}-kopie.xml`,
  mimeType: 'application/xml',
  buffer: file,
});
await p.click('button:has-text("Einlesen")');
await p.waitForLoadState();
check('doppelt einlesen → nichts neu', (await flash(p)).includes('davon 0 neu'), await flash(p));

if (no) {
  console.log('2. Vorschlag übernehmen (Teilzahlung)');
  const row = p.locator('tr', { hasText: `E2E ${stamp}` });
  check(
    'Vorschlag Teilzahlung',
    (await row.innerText()).includes(`Teilzahlung auf Rechnung ${no}`),
    await row.innerText(),
  );
  await row.locator('button:has-text("Übernehmen")').click();
  await p.waitForLoadState();
  check('zugeordnet', (await flash(p)).includes('Zugeordnet'), await flash(p));
} else {
  console.log('  (kein offener Posten in der Entwicklungsdatenbank – Zuordnung übersprungen)');
}

console.log('3. Umsatz ohne Zuordnung abhaken');
await p.goto(B + '/transfer/kontoumsaetze');
await p
  .locator('tr', { hasText: `Bankgebuehr ${stamp}` })
  .locator('a:has-text("Zuordnen")')
  .click();
await p.waitForLoadState();
await p.fill('input[name=note]', 'Kontoführung');
await p.click('button:has-text("Ohne Zuordnung abhaken")');
await p.waitForLoadState();
check('abgehakt', (await flash(p)).includes('abgehakt'));
await p.goto(B + '/transfer/kontoumsaetze?status=ignoriert');
check('in „ignoriert“', (await p.locator('body').innerText()).includes('Kontoführung'));

console.log('4. Lastschriften');
await p.goto(B + '/transfer/lastschriften');
await p.fill('input[name=creditor_id]', 'DE99ZZZ09999999999');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('falsche Gläubiger-ID abgelehnt', (await flash(p)).includes('ungültig'), await flash(p));
await p.goto(B + '/transfer/lastschriften');
await p.fill('input[name=creditor_id]', 'DE98ZZZ09999999999');
await p.click('form[action="/transfer/glaeubiger-id"] button');
await p.waitForLoadState();
check('Gläubiger-ID gespeichert', (await flash(p)).includes('gespeichert'));
await p.click('a:has-text("Mandat erfassen")');
await p.waitForLoadState();
await p.selectOption('#kunde', { index: 1 });
await p.fill('#ref', `E2E-${stamp}`);
await p.fill('#signed', today);
await p.fill('#holder', 'E2E Kontoinhaber');
await p.fill('#iban', 'DE02120300000000202052');
await p.click('button:has-text("Speichern")');
await p.waitForLoadState();
check('IBAN-Prüfziffer geprüft', (await flash(p)).includes('IBAN ungültig'), await flash(p));
await p.screenshot({ path: `${out}/t2-lastschrift.png`, fullPage: true });

console.log('5. Dokumenteneingang');
await p.goto(B + '/transfer/dokumenteneingang');
await p.locator('[data-uploader] input[type=file]').setInputFiles({
  name: `post-${stamp}.pdf`,
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n%E2E\n%%EOF\n'),
});
await p.waitForSelector('[data-uploader] .files li.done', { timeout: 30000 });
await p.waitForTimeout(1000);
await p.goto(B + '/transfer/dokumenteneingang');
const r = p.locator('tr', { hasText: `post-${stamp}.pdf` });
check('im Eingang', (await r.count()) === 1);
await r.locator('select[name=target]').selectOption({ index: 1 });
await r.locator('button:has-text("Zuordnen")').click();
await p.waitForLoadState();
check(
  'zugeordnet und aus dem Eingang',
  (await flash(p)).includes('Zugeordnet') &&
    (await p.locator('tr', { hasText: `post-${stamp}.pdf` }).count()) === 0,
);

console.log('6. Dokumentenversand');
const v = await p.goto(B + '/transfer/dokumentenversand?von=2020-01-01');
check('Versandprotokoll lädt', v.ok() && (await p.locator('h1').innerText()).includes('Dokumentenversand'));
await p.screenshot({ path: `${out}/t3-versand.png`, fullPage: true });

console.log(`\n${ok} bestanden, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
