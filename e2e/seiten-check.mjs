/* global window, getComputedStyle, CSS */
// Seiten-Prüfung: öffnet alle erreichbaren Seiten (je Seitentyp einige Beispiele) am PC und am Handy und sammelt
// Auffälligkeiten: Fehlerseiten, JavaScript-Fehler, „undefined/NaN/null“ im Text, Querscrollen am Handy,
// abgeschnittene Knöpfe/Schilder, kaputte Bilder, Felder ohne Beschriftung, tote Links.
// Start (gegen lokale Instanz): CHROMIUM_PATH=/opt/pw-browsers/chromium node e2e/seiten-check.mjs
// Ergebnis: var/seiten-check/bericht.json (+ Bildschirmfotos mit SHOTS=1)
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('Nur gegen lokale Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const OUT = process.env.OUT ?? 'var/seiten-check';
const PER_PATTERN = Number(process.env.PER_PATTERN ?? 2);
const MAX = Number(process.env.MAX_PAGES ?? 700);
const SHOTS = process.env.SHOTS === '1';
mkdirSync(`${OUT}/pc`, { recursive: true });
mkdirSync(`${OUT}/handy`, { recursive: true });

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const auth = { Authorization: `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}` };
const pc = await (
  await browser.newContext({
    extraHTTPHeaders: auth,
    locale: 'de-DE',
    viewport: { width: 1366, height: 860 },
  })
).newPage();
const handy = await (
  await browser.newContext({
    extraHTTPHeaders: auth,
    locale: 'de-DE',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
).newPage();

const keyOf = (u) => {
  const url = new URL(u, B);
  const q = [...url.searchParams]
    .filter(([k]) => k !== 'ok' && k !== 'fehler')
    .sort(([a], [b]) => a.localeCompare(b));
  const qs = new URLSearchParams(q).toString();
  return url.pathname + (qs ? `?${qs}` : '');
};
const skip = (k) =>
  /^\/(api|static|dateien|abmelden|anmelden|health)(\/|$)/.test(k) ||
  /\.(csv|zip|ics|xml|docx|webmanifest|js)(\?|$)/.test(k) ||
  /download=1|pruefen=1|\/m\/sprache|\/kalender\/abo\//.test(k);
const patternOf = (k) =>
  k
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')
    .replace(/\d{4}-\d{2}(-\d{2})?/g, ':datum')
    .replace(/\/\d+(\/|$|\?)/g, '/:n$1')
    .replace(/\?.*/, (q) => {
      const p = new URLSearchParams(q);
      return '?' + [...p.keys()].sort().join('&');
    });

const issues = [];
const add = (page, kind, detail) => issues.push({ page, kind, detail });
const seen = new Set();
const perPattern = {};
const queue = ['/', '/m', '/qm', '/app?wahl=1'];
const pdfs = new Map();
let n = 0;

async function inspect(p, k, view) {
  const errs = [];
  const onErr = (e) => errs.push(String(e.message ?? e));
  const onConsole = (m) =>
    m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errs.push(m.text());
  p.on('pageerror', onErr);
  p.on('console', onConsole);
  let res;
  // App-Rahmen (Cookie vd_app) nur für die App-Seiten – sonst würde jede Büro-Seite im schmalen App-Rahmen geprüft
  if (!/^\/(qm|m|app)(\/|$|\?)/.test(k)) await p.context().clearCookies({ name: 'vd_app' });
  try {
    res = await p.goto(B + k, { waitUntil: 'load', timeout: 30000 });
  } catch (e) {
    add(k, `${view}: lädt nicht`, String(e.message).slice(0, 200));
    p.off('pageerror', onErr);
    p.off('console', onConsole);
    return [];
  }
  await p.waitForTimeout(150);
  p.off('pageerror', onErr);
  p.off('console', onConsole);
  const status = res?.status() ?? 0;
  const ct = res?.headers()['content-type'] ?? '';
  if (status >= 400) add(k, `${view}: HTTP ${status}`, '');
  if (!ct.includes('html')) return [];
  for (const e of errs) add(k, `${view}: JS-Fehler`, e.slice(0, 300));
  const r = await p.evaluate(() => {
    const out = { words: [], overflow: 0, clipped: [], brokenImg: [], unlabeled: [], links: [], h1: '' };
    const text = document.body.innerText;
    for (const w of [
      'undefined',
      'NaN',
      '[object Object]',
      'Invalid Date',
      'Infinity',
      'null €',
      ' null',
      'null ',
    ]) {
      const i = text.indexOf(w);
      if (i >= 0)
        out.words.push(`${w.trim()}: …${text.slice(Math.max(0, i - 40), i + 40).replace(/\s+/g, ' ')}…`);
    }
    out.overflow = document.documentElement.scrollWidth - window.innerWidth;
    for (const el of document.querySelectorAll('button, .btn, .badge, .pill, .tabs a, th, .kpi, label')) {
      const s = getComputedStyle(el);
      if (el.offsetParent === null || s.overflow === 'visible') continue;
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0)
        out.clipped.push(
          `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}: ${el.innerText.slice(0, 50)}`,
        );
    }
    // Elemente, die rechts aus der Seite ragen (Ursache fürs Querscrollen)
    if (out.overflow > 2) {
      const w = window.innerWidth;
      const cand = [];
      for (const el of document.querySelectorAll('body *')) {
        const b = el.getBoundingClientRect();
        if (b.right > w + 2 && b.width > 0 && b.width < 3000) {
          let scroller = false;
          for (let q = el.parentElement; q; q = q.parentElement) {
            const ox = getComputedStyle(q).overflowX;
            if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') {
              scroller = true;
              break;
            }
          }
          if (!scroller)
            cand.push(
              `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].join('.')} (${Math.round(b.right)}px)`,
            );
        }
      }
      out.wide = cand.slice(0, 5);
    }
    for (const img of document.images)
      if (img.complete && img.naturalWidth === 0 && img.offsetParent) out.brokenImg.push(img.src);
    for (const el of document.querySelectorAll(
      'input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea',
    )) {
      if (el.offsetParent === null) continue;
      const id = el.id;
      const lab = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) || el.closest('label');
      if (
        !lab &&
        !el.getAttribute('aria-label') &&
        !el.getAttribute('placeholder') &&
        !el.getAttribute('title')
      )
        out.unlabeled.push(`${el.tagName.toLowerCase()}[name=${el.getAttribute('name')}]`);
    }
    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href');
      if (h && h.startsWith('/') && !h.startsWith('//')) out.links.push(h.split('#')[0]);
    }
    out.h1 = document.querySelector('h1')?.innerText ?? '';
    return out;
  });
  for (const w of r.words) add(k, `${view}: Text`, w);
  if (view === 'handy' && r.overflow > 2)
    add(k, 'handy: Querscrollen', `${r.overflow}px ${(r.wide ?? []).join(' | ')}`);
  if (view === 'pc' && r.overflow > 2)
    add(k, 'pc: Querscrollen', `${r.overflow}px ${(r.wide ?? []).join(' | ')}`);
  for (const c of r.clipped.slice(0, 5)) add(k, `${view}: abgeschnitten`, c);
  for (const i of r.brokenImg) add(k, `${view}: Bild fehlt`, i);
  if (view === 'pc') for (const u of r.unlabeled.slice(0, 5)) add(k, 'pc: Feld ohne Beschriftung', u);
  if (SHOTS) {
    const f = `${OUT}/${view}/${String(n).padStart(3, '0')}_${k.replace(/[^a-z0-9]+/gi, '_').slice(0, 80)}.png`;
    await p.screenshot({ path: f, fullPage: true, timeout: 20000 }).catch(() => {});
  }
  return r.links;
}

while (queue.length && n < MAX) {
  const k = keyOf(queue.shift());
  if (seen.has(k) || skip(k)) continue;
  seen.add(k);
  const pat = patternOf(k);
  if (/\.pdf$/.test(k.split('?')[0])) {
    if ((pdfs.get(pat) ?? 0) >= 1) continue;
    pdfs.set(pat, 1);
    try {
      const r = await pc.request.get(B + k, { timeout: 60000 });
      if (r.status() >= 400 || !(r.headers()['content-type'] ?? '').includes('pdf'))
        add(k, `PDF: HTTP ${r.status()}`, '');
    } catch (e) {
      add(k, 'PDF: Fehler', String(e.message ?? e).slice(0, 200));
    }
    continue;
  }
  perPattern[pat] = (perPattern[pat] ?? 0) + 1;
  if (perPattern[pat] > PER_PATTERN) continue;
  n++;
  let links = [];
  try {
    links = await inspect(pc, k, 'pc');
    await inspect(handy, k, 'handy');
  } catch (e) {
    add(k, 'Prüfung abgebrochen', String(e.message ?? e).slice(0, 200));
  }
  if (n % 10 === 0) writeFileSync(`${OUT}/bericht.json`, JSON.stringify({ pages: n, issues }, null, 1));
  for (const l of links) if (!seen.has(keyOf(l))) queue.push(l);
  if (n % 25 === 0) console.log(n, 'Seiten,', issues.length, 'Auffälligkeiten');
}
await browser.close();
writeFileSync(`${OUT}/bericht.json`, JSON.stringify({ pages: n, issues }, null, 1));
const byKind = {};
for (const i of issues)
  byKind[i.kind.replace(/^(pc|handy): /, '')] = (byKind[i.kind.replace(/^(pc|handy): /, '')] ?? 0) + 1;
console.log(`${n} Seiten geprüft, ${issues.length} Auffälligkeiten`, byKind);
