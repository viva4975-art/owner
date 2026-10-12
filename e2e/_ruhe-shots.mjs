// Bildschirmfotos wichtiger Seiten (PC + Handy) zum Vorher/Nachher-Vergleich beim Design-Aufräumen.
// OUT=<ordner> node e2e/_ruhe-shots.mjs
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const B = 'http://localhost:3000';
const OUT = process.env.OUT;
mkdirSync(OUT, { recursive: true });
const auth = { Authorization: `Basic ${Buffer.from('ahmed:prototyp2026').toString('base64')}` };
const PAGES = (
  process.env.PAGES ??
  `start=/
kunden=/kunden
kunde=/kunden/00000000-0000-4000-8000-000000000001
objekte=/objekte
objekt=/objekte/00000000-0000-4000-8000-000000000011
objekt-leist=/objekte/00000000-0000-4000-8000-000000000011/leistungen
personal=/personal
ma=/personal/e6e398eb-0013-422a-bfa4-ad90f50555a2
ma-form=/personal/e6e398eb-0013-422a-bfa4-ad90f50555a2/bearbeiten
rechnung=/rechnungen/a9d82a14-590f-4e63-b110-e65bca638a77
entwurf=/rechnungen/c152db81-c667-45d3-b162-fcf55d617e46
rechnungen=/rechnungen
entwuerfe=/rechnungen/entwuerfe
op=/offene-posten
umsaetze=/transfer/kontoumsaetze
planung=/einsatzplanung
zeit=/zeiterfassung/mitarbeiter
nu=/nachunternehmer
nu1=/lieferanten/00000000-0000-4000-8000-000000000222
einst=/einstellungen
re-eingang=/rechnungseingang
angebote=/angebote`
).split('\n');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const [dev, vp] of [
  ['pc', { width: 1366, height: 860 }],
  ['handy', { width: 390, height: 844 }],
]) {
  const ctx = await browser.newContext({
    extraHTTPHeaders: auth,
    locale: 'de-DE',
    viewport: vp,
    isMobile: dev === 'handy',
  });
  const p = await ctx.newPage();
  for (const line of PAGES) {
    const [name, path] = line.split('=');
    const r = await p.goto(B + path, { waitUntil: 'networkidle' }).catch(() => null);
    await p.screenshot({ path: `${OUT}/${dev}-${name}.png`, fullPage: true }).catch(() => {});
    if (!r || r.status() >= 400) console.log('!', dev, name, r?.status(), p.url());
  }
  await ctx.close();
}
await browser.close();
