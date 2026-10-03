// Browser-Test: Angebot mit großer ZIP-Anlage (inkl. Fortsetzen nach Neuladen), Mahnwesen, Inventar.
// Legt Testdaten an → nur gegen lokale Instanz. Start: npm run dev (anderes Terminal), dann npm run e2e:module
import { createHash } from 'node:crypto';
import {
  createReadStream,
  mkdirSync,
  statSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('E2E nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const out = process.env.E2E_SCREENSHOTS ?? 'var/e2e';
const MB = Number(process.env.E2E_UPLOAD_MB ?? 300);
mkdirSync(out, { recursive: true });

// Testdatei: zufällige Bytes (nicht komprimierbar, wie echte ZIP-Inhalte)
const big = join(tmpdir(), `Ausschreibung_Los1_${MB}MB.zip`);
{
  const fd = openSync(big, 'w');
  const block = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < MB; i++) {
    for (let j = 0; j < block.length; j += 4) block.writeUInt32LE((Math.random() * 2 ** 32) >>> 0, j);
    writeSync(fd, block);
  }
  closeSync(fd);
}
const sha = await new Promise((res) => {
  const h = createHash('sha256');
  createReadStream(big)
    .on('data', (d) => h.update(d))
    .on('end', () => res(h.digest('hex')));
});

const browser = await chromium.launch({
  args: ['--lang=de-DE'],
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const ctx = await browser.newContext({
  httpCredentials: { username: USER, password: PASS },
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

// ---------- 1. Angebot anlegen ----------
console.log('1. Angebot anlegen');
await p.goto(B + '/neu?typ=angebot');
await p.selectOption('#kunde', { label: '29901 · DEMO Beispielbehörde Referat für Bildung' });
await p.waitForSelector('#title');
await p.fill('#title', 'E2E Unterhaltsreinigung Gymnasium');
await p.fill('#tender_reference', 'E2E-2026-001');
await p.fill('#tender_platform', 'Bayerischer Vergabemarktplatz');
await p.fill('#submission_deadline', '2026-10-09T10:00');
const r0 = p.locator('#lines tbody tr').first();
await r0.locator('[name=desc]').fill('Unterhaltsreinigung lt. LV');
await r0.locator('[name=price]').fill('7.450,00');
await r0.locator('[name=rec]').selectOption('1');
await p.click('#add-line');
const r1 = p.locator('#lines tbody tr').nth(1);
await r1.locator('[name=desc]').fill('Grundreinigung vor Leistungsbeginn');
await r1.locator('[name=price]').fill('2.100,00');
check('Vorschau Summe', (await p.innerText('#t-gross')).includes('11.364,50'), await p.innerText('#t-gross'));
await p.click('button:has-text("Angebot speichern")');
await p.waitForLoadState();
check('gespeichert', (await flash(p)).includes('Angebot gespeichert'), await flash(p));
const offerUrl = p.url().replace(/\?.*/, '');
check('monatlicher Anteil angezeigt', (await p.locator('.totals').innerText()).includes('7.450,00'));

// ---------- 2. Große ZIP hochladen, mittendrin neu laden, fortsetzen ----------
console.log(`2. ZIP-Upload ${MB} MB mit Unterbrechung`);
await p.locator('[data-uploader] input[type=file]').setInputFiles(big);
await p.waitForFunction(
  () => {
    const m = document.querySelector('[data-uploader] .files li .meta');
    return m && /(\d+) %/.test(m.textContent) && Number(/(\d+) %/.exec(m.textContent)[1]) >= 30;
  },
  null,
  { timeout: 120000 },
);
await p.screenshot({ path: `${out}/m1-upload-laeuft.png` });
// Seite neu laden (= Verbindungsabbruch / Browser zu)
p.removeAllListeners('dialog');
p.on('dialog', (d) => d.accept());
await p.goto(offerUrl);
const t0 = Date.now();
await p.locator('[data-uploader] input[type=file]').setInputFiles(big);
await p.waitForFunction(
  () => /Setze fort|%/.test(document.querySelector('[data-uploader] .files li .meta')?.textContent ?? ''),
  null,
  {
    timeout: 30000,
  },
);
const resumed = await p.locator('[data-uploader] .files li .meta').innerText();
await p.waitForSelector('[data-uploader] .files li.done', { timeout: 300000 });
const secs = (Date.now() - t0) / 1000;
const doneMeta = await p.locator('[data-uploader] .files li.done .meta').innerText();
check('Upload fortgesetzt statt neu begonnen', /Setze fort|[1-9]\d? %/.test(resumed), resumed);
check('Prüfsumme stimmt', doneMeta.includes(sha.slice(0, 12)), `${doneMeta} / ${sha.slice(0, 12)}`);
console.log(`     Rest in ${secs.toFixed(1)} s (${statSync(big).size / 1e6} MB gesamt)`);
await p.waitForLoadState();
await p.waitForTimeout(1500);
check('Datei steht in der Liste', (await p.locator('.filearea > ul.files li').count()) >= 1);
const href = await p.locator('.filearea > ul.files li a').first().getAttribute('href');
const head = await p.request.head(B + href);
check('Download liefert gleiche Prüfsumme', head.headers()['x-content-sha256'] === sha);
await p.screenshot({ path: `${out}/m2-angebot.png`, fullPage: true });

// ---------- 3. Abgeben, Zuschlag, ins Objekt ----------
console.log('3. Zuschlag und Übernahme');
await p.click('button:has-text("Als abgegeben markieren")');
await p.waitForLoadState();
await p.click('button:has-text("Zuschlag erhalten")');
await p.waitForLoadState();
check('Zuschlag erfasst', (await flash(p)).includes('Zuschlag'));
await p.selectOption('#site_id', { index: 0 });
await p.click('button:has-text("Ins Objekt übernehmen")');
await p.waitForLoadState();
check('Leistungen übernommen', (await flash(p)).includes('übernommen'), await flash(p));
check('Monatspauschale im Objekt', (await p.content()).includes('Unterhaltsreinigung lt. LV'));

// ---------- 4. Weitere Module ----------
console.log('4. Module');
for (const [path, name, text] of [
  ['/', 'm3-start', 'Abgabefristen'],
  ['/angebote', 'm4-angebote', 'Zuschlagsquote'],
  ['/mahnungen', 'm5-mahnwesen', 'Mahnwesen'],
  ['/mahnungen/einstellungen', 'm6-mahnstufen', 'Verzugspauschale'],
  ['/lieferanten', 'm7-lieferanten', 'Nachunternehmer'],
  ['/artikel?ansicht=nachbestellen', 'm8-nachbestellen', 'Müllbeutel'],
  ['/geraete', 'm9-geraete', 'Prüfung fällig'],
  ['/schluessel', 'm10-schluessel', 'Schlüsselbuch'],
]) {
  await p.goto(B + path);
  check(`${path} zeigt „${text}“`, (await p.content()).includes(text));
  await p.screenshot({ path: `${out}/${name}.png`, fullPage: true });
}

// Bestand buchen, Doppelklick → einmal gebucht
await p.goto(B + '/artikel/00000000-0000-4000-8000-000000000231');
const before = await p.locator('.kpi .v').first().innerText();
await p.selectOption('#dir', 'in');
await p.fill('#qty', '6');
await p.fill('#reason', 'E2E Lieferung');
await Promise.all([
  p.waitForSelector('.flash.ok', { timeout: 15000 }),
  p.dblclick('button:has-text("Buchen")'),
]);
await p.waitForTimeout(500);
await p.waitForLoadState();
const after = await p.locator('.kpi .v').first().innerText();
check(
  'Bestand genau einmal erhöht',
  parseFloat(after.replace(',', '.')) - parseFloat(before.replace(',', '.')) === 6,
  `${before} → ${after}`,
);

writeFileSync(`${out}/modules-result.txt`, `${ok} ok, ${fail} fehlgeschlagen\n`);
console.log(`\n${ok} ok, ${fail} fehlgeschlagen`);
await browser.close();
process.exit(fail ? 1 : 0);
