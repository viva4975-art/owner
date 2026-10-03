import type { Child, FC } from 'hono/jsx';
import { formatEuro, type Cents } from '../domain/money/money.js';
import { formatDateDe } from '../domain/invoice/calc.js';
import { CLIENT_JS } from './client.js';

/*
 * Aufbau wie Fortytools (Firmenleiste, Suche, Hauptmenü mit Untermenüs, große Seitentitel,
 * „Neu anlegen“, Reiter mit Zählern und „Mehr“), aber in Viva-Deluxe-Bordeaux.
 */
const CSS = `
:root{--bx:#7D1435;--bx2:#8B2332;--bx-d:#5e0f28;--bx-l:#f6edf0;--ink:#1f2330;--mut:#6b6b70;--line:#e2e0e4;--bg:#f1eff2;--ok:#1f7a4a;--warn:#a15c00;--err:#b3261e;--link:#8B2332}
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.top{background:var(--bx)}
.top .in{max-width:1280px;margin:0 auto;padding:0 16px;display:flex;align-items:center;gap:16px;min-height:56px;flex-wrap:wrap}
.top .company>summary{color:#f6e4ea;font-size:18px;font-weight:600;list-style:none;cursor:pointer;white-space:nowrap}
.top .company>summary::-webkit-details-marker{display:none}
.top .company>summary::after{content:" ▾";font-size:13px}
.search{display:flex;flex:1;max-width:520px;min-width:200px}
.search input{border-radius:6px 0 0 6px;border:0;padding:8px 12px}
.search button{border:0;border-radius:0 6px 6px 0;background:var(--bx-d);color:#fff;padding:0 14px;cursor:pointer;font-size:16px}
.top .env{margin-left:auto;font-size:12px;background:#fff;color:var(--bx);padding:2px 9px;border-radius:10px;font-weight:700}
.top .user{color:#f6e4ea;font-size:14px}
nav.menu{background:#fff;border-bottom:1px solid var(--line);box-shadow:0 1px 2px rgba(0,0,0,.04);position:sticky;top:0;z-index:20}
nav.menu .in{max-width:1280px;margin:0 auto;padding:0 8px;display:flex;flex-wrap:wrap}
nav.menu .item>summary,nav.menu a.item{display:block;padding:12px 12px;color:var(--ink);font-weight:500;cursor:pointer;list-style:none;white-space:nowrap;text-decoration:none}
nav.menu .item>summary::-webkit-details-marker{display:none}
nav.menu details.item>summary::after{content:" ▾";font-size:11px;color:var(--mut)}
nav.menu .item.on>summary,nav.menu a.item.on{color:var(--bx);box-shadow:inset 0 -3px 0 var(--bx)}
nav.menu .item>summary:hover,nav.menu a.item:hover{background:var(--bx-l)}
details.dd{position:relative}
details.dd>.drop{position:absolute;left:0;top:100%;min-width:250px;background:#fff;border:1px solid var(--line);border-radius:0 0 8px 8px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:6px 0;z-index:30}
details.dd>.drop.right{left:auto;right:0}
.drop a{display:flex;justify-content:space-between;gap:16px;padding:8px 16px;color:var(--ink);text-decoration:none}
.drop a:hover{background:var(--bx-l);color:var(--bx)}
.drop .soon{font-size:11px;color:var(--mut);background:#f0eef1;border-radius:8px;padding:1px 7px;align-self:center}
.drop .sep{border-top:1px solid var(--line);margin:6px 0}
.drop .cnt{font-size:12px;color:var(--mut);background:#f0eef1;border-radius:8px;padding:0 7px}
main{max-width:1280px;margin:0 auto;padding:22px 16px 64px}
.pagehead{display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px 24px;margin-bottom:18px}
h1{font-size:34px;line-height:1.15;margin:0;color:var(--bx-d);font-weight:700}
h1 .no{font-weight:400;color:#9a9aa2;font-size:.8em}
.newform{display:flex;gap:8px;align-items:center;margin-left:auto}
.newform select{width:auto;min-width:150px}
h2{font-size:20px;margin:26px 0 10px;color:var(--ink)}
h2 .cnt,h3 .cnt{font-weight:400;color:#9a9aa2;font-size:.8em}
h3{font-size:17px;margin:0 0 10px}
.card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:18px;margin-bottom:16px}
.card>h2:first-child,.card>h3:first-child{margin-top:0}
.cols{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:16px;align-items:start}
@media (max-width:900px){.cols{grid-template-columns:1fr}h1{font-size:28px}}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px 16px}
.tabs{display:flex;flex-wrap:wrap;gap:2px;margin-bottom:-1px;position:relative;z-index:2}
.tabs a,.tabs summary{display:block;padding:10px 16px;border:1px solid transparent;border-bottom:0;border-radius:8px 8px 0 0;color:var(--link);text-decoration:none;cursor:pointer;list-style:none}
.tabs summary::-webkit-details-marker{display:none}
.tabs a.on{background:#fff;border-color:var(--line);color:var(--ink)}
.tabs .cnt{font-size:12px;background:#ece9ee;color:#444;border-radius:4px;padding:1px 6px;margin-left:6px}
.tabbody{background:#fff;border:1px solid var(--line);border-radius:0 8px 8px 8px;padding:18px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;background:#fff}
th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:13px;color:var(--ink);font-weight:700;background:#f4f2f5}
td.r,th.r{text-align:right;white-space:nowrap}
tr:hover td{background:#fbf8fa}
.tbl{border:1px solid var(--line);border-radius:8px;overflow:auto}
.tabbody .tbl,.card .tbl{border-radius:6px}
label{display:block;font-size:13px;color:var(--mut);margin-bottom:4px;font-weight:500}
input,select,textarea{width:100%;padding:8px 10px;border:1px solid #cfc8ca;border-radius:6px;font:inherit;background:#fff;color:var(--ink)}
input:focus,select:focus,textarea:focus{outline:2px solid var(--bx-l);border-color:var(--bx)}
textarea{min-height:60px}
.chk{display:flex;gap:8px;align-items:center}.chk input{width:auto}
.btn{display:inline-block;background:var(--bx);color:#fff;border:0;border-radius:6px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap}
.btn:hover{background:var(--bx2);text-decoration:none}
.btn.sec{background:#fff;color:var(--bx);border:1px solid var(--bx)}
.btn.danger{background:#fff;color:var(--err);border:1px solid var(--err)}
.btn.sm{padding:5px 10px;font-size:13px}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0}
.actions form{margin:0}
.badge{display:inline-block;padding:1px 8px;border-radius:4px;font-size:12px;font-weight:700;background:#eee;color:#444}
.badge.draft{background:#fff4e0;color:var(--warn)}
.badge.issued,.badge.ok{background:#2f7d32;color:#fff}
.badge.sent{background:#e7eefb;color:#2856a5}
.badge.failed,.badge.err{background:#fde8e7;color:var(--err)}
.badge.kind{background:var(--bx-l);color:var(--bx)}
.badge.tag{background:#ece9ee;color:#555;font-weight:600}
.flash{padding:12px 14px;border-radius:8px;margin-bottom:16px;white-space:pre-wrap}
.flash.ok{background:#e6f4ec;color:#145232;border:1px solid #b7dcc6}
.flash.err{background:#fde8e7;color:#7a1712;border:1px solid #f2b8b5}
.restore{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#fff8e1;border:1px solid #f0d58a;color:#5c4300;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:14px}
.restore span{flex:1;min-width:220px}
.empty{background:#f4f2f5;border:1px solid var(--line);border-radius:6px;padding:14px 16px;color:#444}
.warnbox{background:#fff8e1;border:1px solid #f0d58a;border-radius:8px;padding:14px 16px}
.warnbox h3{color:#8a6100}
.mut{color:var(--mut)}.small{font-size:13px}
.big{font-size:22px;font-weight:700;color:var(--bx-d)}
.sum{background:#fff6b3;padding:2px 10px;border-radius:4px;font-weight:700}
.lines input,.lines select{padding:6px 8px}
.lines td{padding:6px}
.right{text-align:right}
.totals{margin-left:auto;max-width:360px}
.totals td{border:0;padding:3px 10px}
.totals tr.sum td{font-weight:700;color:var(--bx);border-top:1px solid var(--line)}
.hint{background:var(--bx-l);border-left:3px solid var(--bx);padding:10px 12px;border-radius:4px;font-size:14px}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px}.kv dt{color:var(--mut)}.kv dd{margin:0}
.bars{display:flex;align-items:flex-end;gap:6px;height:160px;border-bottom:1px solid var(--line);padding-top:8px}
.bars div{flex:1;background:#c98da2;border:1px solid var(--bx);border-bottom:0;min-width:6px;position:relative}
.bars div:hover{background:var(--bx)}
.barlabels{display:flex;gap:6px;font-size:11px;color:var(--mut)}.barlabels span{flex:1;text-align:center;white-space:nowrap;overflow:visible;min-width:6px}
.planned{max-width:720px}
.person{display:flex;gap:12px;align-items:center;padding:6px 0}
.avatar{width:38px;height:38px;border-radius:50%;background:var(--bx-l);color:var(--bx);display:flex;align-items:center;justify-content:center;font-weight:700;flex:none}
/* Spalten dürfen schmaler werden als ihr Inhalt (Tabellen scrollen dann in sich) */
.cols>*,.grid>*{min-width:0}
/* Klappmenü auf dem Handy */
#burger{display:none}
.burgerbtn{display:none}
@media (max-width:760px){
  .top .company>summary{font-size:15px}
  .newform{margin-left:0}
  .search{order:3;flex-basis:100%;max-width:none}
  .burgerbtn{display:block;padding:10px 14px;font-weight:600;cursor:pointer;color:var(--bx)}
  nav.menu .in{display:none;flex-direction:column}
  #burger:checked~.in{display:flex}
  nav.menu .item>summary,nav.menu a.item{padding:10px 14px}
  details.dd>.drop{position:static;box-shadow:none;border:0;border-left:3px solid var(--bx-l);margin-left:14px;border-radius:0}
  nav.menu{position:static}
  h1{font-size:26px}
  main{padding:16px 12px 48px}
  .tabbody{padding:12px}
}
`;

export const euro = (c: bigint) => formatEuro(c as Cents);
export const dateDe = (d: string | null | undefined) => (d ? formatDateDe(d) : '–');

interface MenuEntry {
  label: string;
  href: string;
  soon?: boolean;
  sep?: boolean;
}

/** Hauptmenü wie Fortytools. `soon` = geplant (Seite erklärt, was kommt). */
export const MENU: { key: string; label: string; href?: string; items?: MenuEntry[] }[] = [
  { key: 'home', label: 'Übersicht', href: '/' },
  {
    key: 'kunden',
    label: 'Kunden',
    items: [
      { label: 'Liste', href: '/kunden' },
      { label: 'Objekte', href: '/objekte' },
      { label: 'Aufgaben', href: '/aufgaben' },
    ],
  },
  {
    key: 'angebote',
    label: 'Angebote',
    items: [
      { label: 'Angebote', href: '/geplant/angebote', soon: true },
      { label: 'Aufträge', href: '/geplant/auftraege', soon: true },
    ],
  },
  {
    key: 'rechnungen',
    label: 'Rechnungen',
    items: [
      { label: 'Rechnungsentwürfe / Vorfaktura', href: '/rechnungen/entwuerfe' },
      { label: 'Alle Rechnungen', href: '/rechnungen' },
      { label: 'Einzelrechnung anlegen', href: '/neu?typ=rechnung' },
      { label: 'Offene Posten', href: '/offene-posten', sep: true },
      { label: 'Mahnungen', href: '/geplant/mahnungen', soon: true },
      { label: 'Lieferscheine / Arbeitsscheine', href: '/geplant/lieferscheine', soon: true },
    ],
  },
  {
    key: 'lieferanten',
    label: 'Lieferanten',
    items: [
      { label: 'Lieferanten & Nachunternehmer', href: '/geplant/lieferanten', soon: true },
      { label: 'Bestellungen (BE-JJJJ-NNNN)', href: '/geplant/bestellungen', soon: true },
      { label: 'Rechnungseingang', href: '/geplant/rechnungseingang', soon: true },
      { label: 'Zahlungslauf SEPA', href: '/geplant/zahlungslauf', soon: true },
    ],
  },
  {
    key: 'personal',
    label: 'Personal',
    items: [
      { label: 'Mitarbeiter', href: '/personal' },
      { label: 'Mitarbeiter anlegen', href: '/neu?typ=mitarbeiter' },
      { label: 'Zeiterfassung', href: '/geplant/zeiterfassung', soon: true, sep: true },
      { label: 'Urlaubsanträge', href: '/geplant/urlaub', soon: true },
      { label: 'Dokumente digital unterschreiben', href: '/geplant/unterschrift', soon: true },
    ],
  },
  {
    key: 'inventar',
    label: 'Inventar',
    items: [
      { label: 'Artikel & Nachbestellung', href: '/geplant/artikel', soon: true },
      { label: 'Geräte', href: '/geplant/geraete', soon: true },
      { label: 'Schlüssel', href: '/geplant/schluessel', soon: true },
    ],
  },
  {
    key: 'disposition',
    label: 'Disposition',
    items: [
      { label: 'Einsatzplanung', href: '/geplant/einsatzplanung', soon: true },
      { label: 'Soll-/Ist-Vergleich', href: '/geplant/soll-ist', soon: true },
      { label: 'Glasreinigung / Tiefgarage', href: '/geplant/sonderdienste', soon: true },
    ],
  },
  {
    key: 'transfer',
    label: 'Transfer',
    items: [
      { label: 'Export Lexware Lohn (Stammdaten)', href: '/personal/export.csv' },
      { label: 'DATEV-Export', href: '/geplant/datev', soon: true },
      { label: 'Import aus Fortytools', href: '/geplant/import', soon: true },
    ],
  },
  {
    key: 'auswertungen',
    label: 'Auswertungen',
    items: [
      { label: 'Netto-Umsatz je Monat', href: '/auswertungen/umsatz' },
      { label: 'Nachkalkulation je Objekt', href: '/geplant/nachkalkulation', soon: true },
    ],
  },
];

export const Layout: FC<{
  title: string;
  nav: string;
  env: string;
  user?: string;
  flash?: { ok?: string | undefined; err?: string | undefined };
  children?: Child;
}> = ({ title, nav, env, user, flash, children }) => (
  <html lang="de">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{`${title} · Viva-Deluxe`}</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <header class="top">
        <div class="in">
          <details class="dd company">
            <summary>Viva-Deluxe Gebäudereinigung</summary>
            <div class="drop">
              <a href="/">Übersicht</a>
              <a href="/geplant/firmendaten">
                Firmendaten &amp; Einstellungen <span class="soon">bald</span>
              </a>
            </div>
          </details>
          <form class="search" action="/suche" method="get" role="search">
            <input
              id="q"
              name="q"
              placeholder="Suchen… ( / ), mind. 3 Zeichen"
              minlength={3}
              aria-label="Suchen"
            />
            <button aria-label="Suchen">⌕</button>
          </form>
          {user && <span class="user">{user.charAt(0).toUpperCase() + user.slice(1)}</span>}
          <span class="env">{env === 'live' ? 'LIVE' : env === 'test' ? 'TEST' : 'LOKAL'}</span>
        </div>
      </header>
      <nav class="menu" aria-label="Hauptmenü">
        <input type="checkbox" id="burger" />
        <label for="burger" class="burgerbtn">
          ☰ Menü
        </label>
        <div class="in">
          {MENU.map((m) =>
            m.href ? (
              <a class={`item${nav === m.key ? ' on' : ''}`} href={m.href}>
                {m.label}
              </a>
            ) : (
              <details class={`dd item${nav === m.key ? ' on' : ''}`}>
                <summary>{m.label}</summary>
                <div class="drop">
                  {(m.items ?? []).map((i) => (
                    <>
                      {i.sep && <div class="sep" />}
                      <a href={i.href}>
                        {i.label}
                        {i.soon && <span class="soon">bald</span>}
                      </a>
                    </>
                  ))}
                </div>
              </details>
            ),
          )}
        </div>
      </nav>
      <main>
        {flash?.ok && <div class="flash ok">{flash.ok}</div>}
        {flash?.err && <div class="flash err">{flash.err}</div>}
        {children}
      </main>
      <script dangerouslySetInnerHTML={{ __html: CLIENT_JS }} />
    </body>
  </html>
);

/** Großer Seitentitel + „Neu anlegen: [Auswahl] Los“ wie Fortytools. */
export const PageHead: FC<{
  title: string;
  no?: string | null | undefined;
  create?: {
    options: [string, string][];
    selected?: string;
    suffix?: string;
    context?: Record<string, string>;
  };
  children?: Child;
}> = ({ title, no, create, children }) => (
  <div class="pagehead">
    <h1>
      {title} {no && <span class="no">({no})</span>}
    </h1>
    {children}
    {create && (
      <form class="newform" action="/neu" method="get">
        <label for="neu-typ" style="margin:0;color:var(--ink);font-size:15px;font-weight:600">
          Neu anlegen:
        </label>
        <select id="neu-typ" name="typ">
          {create.options.map(([v, l]) => (
            <option value={v} selected={v === create.selected}>
              {l}
            </option>
          ))}
        </select>
        {Object.entries(create.context ?? {}).map(([k, v]) => (
          <input type="hidden" name={k} value={v} />
        ))}
        {create.suffix && <span>{create.suffix}</span>}
        <button class="btn">Los</button>
      </form>
    )}
  </div>
);

export interface Tab {
  label: string;
  href: string;
  count?: number | undefined;
  key: string;
}

/** Reiter wie Fortytools; weitere Reiter unter „Mehr“. */
export const Tabs: FC<{ tabs: Tab[]; more?: Tab[]; active: string }> = ({ tabs, more, active }) => {
  const activeInMore = more?.find((t) => t.key === active);
  return (
    <div class="tabs">
      {tabs.map((t) => (
        <a href={t.href} class={t.key === active ? 'on' : ''}>
          {t.label}
          {t.count !== undefined && <span class="cnt">{t.count}</span>}
        </a>
      ))}
      {activeInMore && (
        <a href={activeInMore.href} class="on">
          {activeInMore.label}
          {activeInMore.count !== undefined && <span class="cnt">{activeInMore.count}</span>}
        </a>
      )}
      {more && more.length > 0 && (
        <details class="dd">
          <summary>Mehr ▾</summary>
          <div class="drop">
            {more.map((t) => (
              <a href={t.href}>
                {t.label}
                {t.count !== undefined && <span class="cnt">{t.count}</span>}
              </a>
            ))}
          </div>
        </details>
      )}
    </div>
  );
};

export const NEW_OPTIONS: [string, string][] = [
  ['rechnung', 'Rechnung'],
  ['kunde', 'Kunde'],
  ['objekt', 'Objekt'],
  ['mitarbeiter', 'Mitarbeiter'],
  ['aufgabe', 'Aufgabe'],
];

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Entwurf',
  issued: 'Ausgestellt',
  sent: 'Versendet',
  pending: 'Versand läuft',
  failed: 'Versand fehlgeschlagen',
};

export const FORMAT_LABEL: Record<string, string> = {
  pdf: 'PDF',
  zugferd: 'ZUGFeRD',
  xrechnung: 'XRechnung + PDF',
};

export const SERVICE_KIND_LABEL: Record<string, string> = {
  monthly_flat: 'Monatspauschale',
  special: 'Sonderleistung',
  hourly: 'Regiestunden',
};

export function initials(name: string): string {
  return name
    .split(/[\s,]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}
