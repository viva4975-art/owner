// Baut die Klick-Demo: eine einzelne HTML-Datei mit allen Seiten der laufenden App (nur Demodaten!).
// Navigation, Reiter, Menüs, Auswahlfelder und PDFs funktionieren offline; Speichern/Versenden/Hochladen
// sind ausgeschaltet und zeigen einen Hinweis.
// Start: Demo-Instanz mit Demo-DB starten, dann: E2E_BASE_URL=http://127.0.0.1:3001 node e2e/klick-demo.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const B = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3001';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) throw new Error('Nur gegen lokale Demo-Instanz');
const [USER, PASS] = (process.env.E2E_AUTH ?? 'ahmed:prototyp2026').split(':');
const OUT = process.env.DEMO_OUT ?? 'var/klick-demo/viva-deluxe-klick-demo.html';
const MAX_PAGES = Number(process.env.DEMO_MAX_PAGES ?? 400);
const MAX_PDFS = 3; // je ~1,8 MB (Briefpapier) – eine Rechnung, ein Angebot, eine Mahnung

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const ctx = await browser.newContext({
  httpCredentials: { username: USER, password: PASS },
  locale: 'de-DE',
});
const page = await ctx.newPage();

/** Einheitlicher Schlüssel: Pfad + sortierte Parameter (ohne Meldungen). */
const keyOf = (u) => {
  const url = new URL(u, B);
  const q = [...url.searchParams]
    .filter(([k]) => k !== 'ok' && k !== 'fehler')
    .sort(([a], [b]) => a.localeCompare(b));
  const qs = new URLSearchParams(q).toString();
  return url.pathname + (qs ? `?${qs}` : '');
};
const skip = (k) =>
  /^\/(api|static|dateien)\//.test(k) ||
  /\.(csv)$/.test(k) ||
  /pruefen=1/.test(k) ||
  k.startsWith('/health') ||
  /\/vorschau\.pdf/.test(k);

const pages = {}; // key → { t: title, b: body-HTML }
const alias = {}; // angefragter Schlüssel → Ziel (Weiterleitungen, z. B. /neu?typ=angebot)
const pdfs = {}; // key → base64
const pdfKinds = new Set();
const variantRoots = new Set(); // nur neu angelegte Editoren bekommen Auswahl-Varianten (Kunde → Objekt)
let css = '';
const queue = ['/'];
const seen = new Set();

while (queue.length && Object.keys(pages).length < MAX_PAGES) {
  const k = queue.shift();
  if (seen.has(k) || skip(k)) continue;
  seen.add(k);
  if (/\.pdf$/.test(new URL(k, B).pathname) || k.startsWith('/dokumente/')) {
    const kind = k.startsWith('/dokumente/') ? 'rechnung' : k.includes('angebot') ? 'angebot' : 'mahnung';
    if (Object.keys(pdfs).length >= MAX_PDFS || pdfKinds.has(kind)) continue;
    const r = await ctx.request.get(B + k);
    if (r.ok() && r.headers()['content-type']?.includes('pdf')) {
      pdfs[k] = (await r.body()).toString('base64');
      pdfKinds.add(kind);
    }
    continue;
  }
  const res = await page.goto(B + k).catch(() => null);
  if (!res || !res.ok() || !(res.headers()['content-type'] ?? '').includes('text/html')) continue;
  const finalKey = keyOf(page.url());
  if (finalKey !== k) alias[k] = finalKey;
  if (/^\/neu\?typ=(rechnung|angebot)$/.test(k)) variantRoots.add(finalKey.split('?')[0]);
  const path = finalKey.split('?')[0];
  const withVariants = variantRoots.has(path) && [...new URL(finalKey, B).searchParams].length < 2;
  if (pages[finalKey]) continue;
  seen.add(finalKey);
  const data = await page.evaluate((withVariants) => {
    const links = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    // GET-Formulare mit Auswahlfeldern (z. B. Kunde → Objekt im Editor): Varianten vorab erzeugen
    const variants = [];
    for (const f of document.querySelectorAll('form')) {
      if ((f.getAttribute('method') ?? 'get').toLowerCase() !== 'get') continue;
      const action = f.getAttribute('action') || location.pathname;
      const sels = withVariants ? [...f.querySelectorAll('select[onchange]')] : [];
      for (const s of sels) {
        if (s.disabled) continue;
        const opts = [...s.options].filter((o) => o.value).slice(0, 4);
        for (const o of opts) {
          const fd = new FormData(f);
          fd.set(s.name, o.value);
          variants.push(
            action + '?' + new URLSearchParams([...fd].map(([a, b]) => [a, String(b)])).toString(),
          );
        }
      }
      // Suche / Neu-anlegen: alle Optionen
      if (action === '/neu' && location.pathname === '/') {
        const s = f.querySelector('select[name=typ]');
        for (const o of s?.options ?? []) {
          const fd = new FormData(f);
          fd.set('typ', o.value);
          variants.push('/neu?' + new URLSearchParams([...fd].map(([a, b]) => [a, String(b)])).toString());
        }
      }
    }
    const style = document.querySelector('head style')?.textContent ?? '';
    // Server-Meldungen entfernen (die Demo speichert nichts)
    document.querySelectorAll('main > .flash').forEach((e) => e.remove());
    // App- und Upload-Skript nicht in jede Seite kopieren (die Demo hat eine eigene Laufzeit)
    document.querySelectorAll('body script').forEach((sc) => {
      const t = sc.textContent ?? '';
      if (t.includes('vd-form:') || t.includes('__vdUploader')) sc.remove();
    });
    return { links, variants, style, title: document.title, body: document.body.innerHTML };
  }, withVariants);
  css ||= data.style;
  pages[finalKey] = { t: data.title, b: data.body };
  for (const h of [...data.links, ...data.variants]) {
    if (!h || !h.startsWith('/')) continue;
    const nk = keyOf(h);
    if (!seen.has(nk)) queue.push(nk);
  }
  if (Object.keys(pages).length % 25 === 0) console.log(`  ${Object.keys(pages).length} Seiten …`);
}
// Suche: ein paar Beispiele
for (const q of ['Muster', 'Grundschule', 'Rathaus', 'Popescu']) {
  const k = keyOf(`/suche?q=${encodeURIComponent(q)}`);
  if (pages[k] || alias[k]) continue;
  await page.goto(B + k);
  const fk = keyOf(page.url());
  if (fk !== k) alias[k] = fk;
  if (!pages[fk]) pages[fk] = await page.evaluate(() => ({ t: document.title, b: document.body.innerHTML }));
}
await browser.close();

// Statische Dateien einbetten
const dataUri = (path, type) => `data:${type};base64,${readFileSync(path).toString('base64')}`;
const assets = {
  '/static/inter-latin.woff2': dataUri('assets/web/inter-latin.woff2', 'font/woff2'),
  '/static/inter-latin-ext.woff2': dataUri('assets/web/inter-latin-ext.woff2', 'font/woff2'),
  '/static/logo.png': dataUri('assets/web/logo.png', 'image/png'),
  '/static/favicon.png': dataUri('assets/web/favicon.png', 'image/png'),
};
const embed = (s) => {
  for (const [k, v] of Object.entries(assets)) s = s.split(k).join(v);
  return s;
};
// Logo nur einmal einbetten: in den Seiten Platzhalter, beim Anzeigen ersetzt
for (const p of Object.values(pages)) p.b = p.b.split('/static/logo.png').join('__LOGO__');

const RUNTIME = String.raw`
(function () {
  var D = JSON.parse(document.getElementById('demo-data').textContent);
  var LOGO = ${JSON.stringify(assets['/static/logo.png'])};
  function norm(u) {
    var url = new URL(u, 'http://x');
    var q = []; url.searchParams.forEach(function (v, k) { if (k !== 'ok' && k !== 'fehler') q.push([k, v]); });
    q.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
    var qs = new URLSearchParams(q).toString();
    return url.pathname + (qs ? '?' + qs : '');
  }
  function resolve(k) {
    k = norm(k);
    if (D.alias[k]) k = D.alias[k];
    if (D.pages[k]) return k;
    var p = k.split('?')[0];
    if (D.alias[p]) p = D.alias[p];
    if (D.pages[p]) return p;
    return null;
  }
  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'demo-toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3800);
  }
  function render() {
    var k = location.hash.slice(1) || '/';
    var r = resolve(k);
    if (!r) {
      var b = D.pages['/'];
      document.body.innerHTML = b.b.replace(/__LOGO__/g, LOGO);
      var m = document.querySelector('main');
      if (m) m.innerHTML = '<div class="card"><h2 style="margin-top:0">In der Klick-Demo nicht enthalten</h2><p>Diese Seite entsteht in der echten App erst durch eine Eingabe (z. B. nach dem Speichern). <a href="/">Zur Übersicht</a></p></div>';
    } else {
      var pg = D.pages[r];
      document.title = pg.t + ' (Demo)';
      document.body.innerHTML = pg.b.replace(/__LOGO__/g, LOGO);
    }
    var bar = document.createElement('div');
    bar.className = 'demo-bar';
    bar.innerHTML = '<b>Klick-Demo</b> mit Beispieldaten · alles anklickbar · Speichern, Versenden und Hochladen sind ausgeschaltet';
    document.body.insertBefore(bar, document.body.firstChild);
    // Seitenskripte ausführen (Positionseditor usw.), nicht aber die App-/Upload-Skripte
    Array.prototype.forEach.call(document.body.querySelectorAll('script'), function (old) {
      var src = old.textContent || '';
      if (src.indexOf('vd-form:') >= 0 || src.indexOf('__vdUploader') >= 0) { old.remove(); return; }
      var s = document.createElement('script'); s.textContent = src; old.replaceWith(s);
    });
    window.scrollTo(0, 0);
  }
  function go(href) {
    var k = norm(href);
    if (D.pdfs[k]) {
      var bin = atob(D.pdfs[k]); var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      window.open(URL.createObjectURL(new Blob([arr], { type: 'application/pdf' })), '_blank');
      return;
    }
    if (/\.pdf$/.test(k.split('?')[0])) { toast('PDF: in der Demo nur für ausgewählte Belege enthalten.'); return; }
    if (/^\/(dateien|dokumente)\//.test(k) || /\.csv$/.test(k)) { toast('Download in der Demo ausgeschaltet.'); return; }
    if (location.hash.slice(1) !== k) history.pushState(null, '', '#' + k);
    render();
  }
  document.addEventListener('click', function (e) {
    var dz = e.target.closest && e.target.closest('.drop-zone');
    if (dz) { e.preventDefault(); e.stopPropagation(); toast('Demo: Hochladen nur in der echten App (große ZIP-Dateien, fortsetzbar).'); return; }
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var h = a.getAttribute('href');
    if (h.charAt(0) !== '/') return;
    e.preventDefault();
    go(h);
  }, true);
  function submitForm(f, submitter) {
    var method = (f.getAttribute('method') || 'get').toLowerCase();
    if (method !== 'get') { toast('Demo: Speichern ist ausgeschaltet – in der echten App wird jetzt gespeichert.'); return; }
    var fd = new FormData(f, submitter || undefined);
    var qs = new URLSearchParams(); fd.forEach(function (v, k) { qs.append(k, String(v)); });
    go((f.getAttribute('action') || location.hash.slice(1).split('?')[0]) + '?' + qs.toString());
  }
  document.addEventListener('submit', function (e) { e.preventDefault(); submitForm(e.target, e.submitter); }, true);
  HTMLFormElement.prototype.submit = function () { submitForm(this); };
  document.addEventListener('toggle', function (e) {
    if (e.target.matches && e.target.matches('details.dd') && e.target.open) {
      document.querySelectorAll('details.dd[open]').forEach(function (d) { if (d !== e.target) d.open = false; });
    }
  }, true);
  document.addEventListener('click', function (e) {
    if (!e.target.closest('details.dd')) document.querySelectorAll('details.dd[open]').forEach(function (d) { d.open = false; });
  });
  window.confirm = function () { return true; };
  window.addEventListener('popstate', render);
  render();
})();`;

const DEMO_CSS = `
.demo-bar{background:#1b1f24;color:#e5e7eb;font-size:13px;padding:8px 16px;text-align:center}
.demo-bar b{color:#fff;margin-right:6px}
.demo-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1b1f24;color:#fff;padding:12px 18px;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.25);z-index:99;font-size:14px;max-width:90vw}
`;

const json = JSON.stringify({ pages, alias, pdfs }).replace(/</g, '\\u003c');
const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Viva-Deluxe Betriebs-App – Klick-Demo</title>
<link rel="icon" type="image/png" href="${assets['/static/favicon.png']}">
<style>${embed(css)}${DEMO_CSS}</style></head>
<body><p style="padding:24px">Lade Demo …</p>
<script id="demo-data" type="application/json">${json}</script>
<script>${RUNTIME}</script>
</body></html>`;
mkdirSync(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
writeFileSync(OUT, html);
console.log(
  `${Object.keys(pages).length} Seiten, ${Object.keys(pdfs).length} PDFs → ${OUT} (${(html.length / 1e6).toFixed(1)} MB)`,
);
