// Menü oben/links: Umschalten über das Benutzermenü, Aufklapp-Menü, Rücksprung (lokal)
import { chromium } from 'playwright-core';
const B = 'http://localhost:3000';
const OUT = process.env.OUT ?? 'var/e2e';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({
  extraHTTPHeaders: { Authorization: `Basic ${Buffer.from('ahmed:prototyp2026').toString('base64')}` },
  viewport: { width: 1366, height: 860 },
});
const p = await ctx.newPage();
let fails = 0;
const check = (n, c) => {
  console.log(`${c ? '✓' : '✗'} ${n}`);
  if (!c) fails++;
};
await p.goto(B + '/konto');
await p.click('button:has-text("Oben (Menüleiste)")'); // Ausgangslage: Standard „oben“
await p.goto(B + '/kunden');
check('Standard: Menü oben', await p.evaluate(() => document.body.classList.contains('menu-top')));
await p.click('details.dd summary');
await p.click('button:has-text("Menü links anzeigen")');
await p.waitForLoadState();
check('zurück auf derselben Seite', p.url().endsWith('/kunden'));
check('jetzt Seitenleiste links', !(await p.evaluate(() => document.body.classList.contains('menu-top'))));
// gilt für das Benutzerkonto: neuer Browser (ohne Cookies) zeigt dieselbe Wahl
const ctx2 = await browser.newContext({
  extraHTTPHeaders: { Authorization: `Basic ${Buffer.from('ahmed:prototyp2026').toString('base64')}` },
  viewport: { width: 1366, height: 860 },
});
const p2 = await ctx2.newPage();
await p2.goto(B + '/kunden');
check(
  'anderer Browser: ebenfalls links',
  !(await p2.evaluate(() => document.body.classList.contains('menu-top'))),
);
await ctx2.close();
await p.click('details.dd summary');
await p.click('button:has-text("Menü oben anzeigen")');
await p.waitForLoadState();
check('Menü oben aktiv', await p.evaluate(() => document.body.classList.contains('menu-top')));
const box = await p.locator('.appside').boundingBox();
check(
  'Leiste oben einzeilig über die ganze Breite',
  !!box && box.y === 0 && box.width > 1300 && box.height <= 64,
);
await p.click('.appside .grp:has(> summary span:text-is("Rechnungen")) > summary');
check(
  'Aufklapp-Menü sichtbar',
  await p.locator('.appside .grp:has(> summary span:text-is("Rechnungen")) .sub').isVisible(),
);
await p.screenshot({ path: `${OUT}/menu-oben.png` });
await p.click('.appside .grp:has(> summary span:text-is("Personal")) > summary');
check(
  'nur ein Menü offen',
  !(await p.locator('.appside .grp:has(> summary span:text-is("Rechnungen")) .sub').isVisible()),
);
await p.click('main');
check(
  'Klick daneben schließt',
  !(await p.locator('.appside .grp:has(> summary span:text-is("Personal")) .sub').isVisible()),
);
await p.click('.appside .grp:has(> summary span:text-is("Rechnungen")) > summary');
await p.click('.appside .grp:has(> summary span:text-is("Rechnungen")) .sub a:has-text("Offene Posten")');
await p.waitForLoadState();
check('Navigation über das Aufklapp-Menü', p.url().includes('/offene-posten'));
const hd = await p.locator('header.top').boundingBox();
check('Suchleiste unter der Menüleiste', !!hd && hd.y >= 50);
await p.setViewportSize({ width: 390, height: 844 });
await p.reload();
check('Handy: Schublade wie bisher', await p.locator('.burgerbtn').isVisible());
await p.setViewportSize({ width: 1366, height: 860 });
await p.goto(B + '/konto');
await p.click('button:has-text("Links (Seitenleiste)")');
await p.waitForLoadState();
check('über Mein Konto auf links', !(await p.evaluate(() => document.body.classList.contains('menu-top'))));
await p.click('button:has-text("Oben (Menüleiste)")');
await p.waitForLoadState();
check('über Mein Konto wieder oben', await p.evaluate(() => document.body.classList.contains('menu-top')));
await browser.close();
console.log(`${fails ? 'FEHLER' : 'ok'}: ${fails} fehlgeschlagen`);
process.exit(fails ? 1 : 0);
