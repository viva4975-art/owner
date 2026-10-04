import type { Child, FC } from 'hono/jsx';
import { formatEuro, type Cents } from '../domain/money/money.js';
import { formatDateDe } from '../domain/invoice/calc.js';
import { CLIENT_JS } from './client.js';
import type { Role } from '../services/users.js';
import { Icon } from './icons.js';
import { canAccess, canOpen } from './permissions.js';

/*
 * Erscheinungsbild „Unternehmenssoftware“: Schrift Inter (lokal), ruhige Grautöne, Bordeaux nur als Akzent
 * (Navigation, Hauptaktion, aktive Zustände), klare Hierarchie, Tabellen mit tabellarischen Ziffern.
 * Aufbau weiterhin wie Fortytools (Hauptmenü mit Untermenüs, „Neu anlegen“, Reiter).
 */
const CSS = `
@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url(/static/inter-latin.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url(/static/inter-latin-ext.woff2) format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
:root{
  --brand:#7D1435;--brand-2:#8B2332;--brand-d:#5c0e27;--brand-50:#faf3f5;--brand-100:#f3e1e7;
  --ink:#1b1f24;--ink-2:#424852;--mut:#6b7280;--faint:#9aa1ab;
  --line:#e4e7eb;--line-2:#d5d9df;--bg:#f5f6f8;--panel:#fff;--head:#f8f9fb;
  --ok:#15803d;--ok-50:#ecfdf3;--warn:#b45309;--warn-50:#fffbeb;--err:#b42318;--err-50:#fef3f2;--info:#1d4ed8;--info-50:#eff6ff;
  --r:8px;--r-sm:6px;--sh:0 1px 2px rgba(16,24,40,.05);--sh-2:0 12px 32px rgba(16,24,40,.14);
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font:14px/1.55 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-feature-settings:"cv11","ss01";color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased}
a{color:var(--brand-2);text-decoration:none}a:hover{text-decoration:underline}
.ic{flex:none;vertical-align:-3px}
/* ---- Kopf ---- */
.top{background:#fff;border-bottom:1px solid var(--line)}
.top .in{max-width:1360px;margin:0 auto;padding:0 24px;display:flex;align-items:center;gap:24px;height:64px}
.top .logo{display:flex;align-items:center;gap:12px;color:var(--ink)}
.top .logo img{height:36px;width:auto;display:block}
.top .logo:hover{text-decoration:none}
.search{display:flex;align-items:center;flex:1;max-width:520px;margin:0 auto;position:relative}
.search .ic{position:absolute;left:11px;color:var(--faint)}
.search input{height:38px;padding:0 12px 0 36px;border:1px solid var(--line-2);border-radius:var(--r);background:var(--head)}
.search input:focus{background:#fff}
.search kbd{position:absolute;right:10px;font:600 11px Inter,sans-serif;color:var(--faint);border:1px solid var(--line-2);border-radius:4px;padding:1px 6px;background:#fff}
.top .right{display:flex;align-items:center;gap:14px;margin-left:auto}
.env{font-size:11px;font-weight:700;letter-spacing:.06em;padding:3px 8px;border-radius:999px;background:var(--warn-50);color:var(--warn);border:1px solid #fde68a}
.env.live{background:var(--ok-50);color:var(--ok);border-color:#bbf7d0}
.usr{display:flex;align-items:center;gap:8px;color:var(--ink-2);font-weight:500}
.usr .av{width:30px;height:30px;border-radius:50%;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700}
/* ---- Navigation ---- */
nav.menu{background:var(--brand);position:sticky;top:0;z-index:20;box-shadow:0 1px 0 rgba(0,0,0,.08)}
nav.menu .in{max-width:1360px;margin:0 auto;padding:0 16px;display:flex;flex-wrap:wrap}
nav.menu .item>summary,nav.menu a.item{display:flex;align-items:center;gap:4px;height:44px;padding:0 14px;color:#f5e6eb;font-weight:500;cursor:pointer;list-style:none;white-space:nowrap;text-decoration:none;font-size:14px}
nav.menu .item>summary::-webkit-details-marker{display:none}
nav.menu .item>summary .ic{opacity:.7}
nav.menu .item>summary:hover,nav.menu a.item:hover,nav.menu details[open]>summary{background:rgba(255,255,255,.1);color:#fff}
nav.menu .item.on>summary,nav.menu a.item.on{color:#fff;box-shadow:inset 0 -3px 0 #fff}
details.dd{position:relative}
details.dd>summary{list-style:none}details.dd>summary::-webkit-details-marker{display:none}
details.dd>.drop{position:absolute;left:0;top:100%;min-width:270px;background:#fff;border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh-2);padding:6px;z-index:30;margin-top:4px}
details.dd>.drop.right{left:auto;right:0}
.drop a{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:8px 10px;border-radius:var(--r-sm);color:var(--ink);text-decoration:none;font-weight:450}
.drop a:hover{background:var(--brand-50);color:var(--brand)}
.drop .soon{font-size:11px;font-weight:600;color:var(--faint);background:var(--head);border:1px solid var(--line);border-radius:999px;padding:0 8px}
.drop .sep{border-top:1px solid var(--line);margin:6px 4px}
.drop .cnt{font-size:12px;color:var(--mut)}
/* ---- Seite ---- */
main{max-width:1360px;margin:0 auto;padding:24px 24px 72px}
.crumbs{font-size:13px;color:var(--mut);margin-bottom:6px}.crumbs a{color:var(--mut)}
.pagehead{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;margin-bottom:20px}
h1{font-size:24px;line-height:1.25;margin:0;color:var(--ink);font-weight:650;letter-spacing:-.01em}
h1 .no{font-weight:500;color:var(--faint);font-size:.75em;margin-left:4px}
.newform{display:flex;gap:8px;align-items:center;margin-left:auto}
.newform select{width:auto;min-width:150px}
.newform label{margin:0;color:var(--mut);font-size:13px;font-weight:500}
h2{font-size:16px;font-weight:650;margin:28px 0 12px;color:var(--ink)}
h3{font-size:14px;font-weight:650;margin:0 0 10px;color:var(--ink)}
h2 .cnt,h3 .cnt{font-weight:500;color:var(--faint)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:20px;margin-bottom:16px;box-shadow:var(--sh)}
.card>h2:first-child,.card>h3:first-child,.card>div>h2:first-child{margin-top:0}
.card.flush{padding:0}.card.flush>.tbl{border:0;border-radius:var(--r)}
.cols{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:16px;align-items:start}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px 16px}
.cols>*,.grid>*{min-width:0}
.section-title{font-size:12px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin:24px 0 10px}
/* ---- Reiter ---- */
.tabs{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--line);margin-bottom:20px}
.tabs a,.tabs summary{display:flex;align-items:center;gap:6px;padding:10px 12px;color:var(--mut);font-weight:550;text-decoration:none;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs a:hover,.tabs summary:hover{color:var(--ink)}
.tabs a.on{color:var(--brand);border-bottom-color:var(--brand)}
.tabs .cnt{font-size:11.5px;font-weight:600;background:var(--head);border:1px solid var(--line);color:var(--ink-2);border-radius:999px;padding:0 7px;line-height:18px}
.tabbody{}
/* ---- Tabellen ---- */
table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;font-variant-numeric:tabular-nums}
th,td{padding:10px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;font-weight:600;color:var(--mut);background:var(--head);white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
td.r,th.r{text-align:right;white-space:nowrap}
tbody tr:hover td{background:#fafbfc}
.tbl{border:1px solid var(--line);border-radius:var(--r);overflow:auto;background:#fff;box-shadow:var(--sh)}
.card .tbl{box-shadow:none}
td b,td strong{font-weight:600}
/* ---- Formulare ---- */
label{display:block;font-size:12.5px;color:var(--ink-2);margin-bottom:6px;font-weight:550}
input,select,textarea{width:100%;height:38px;padding:0 12px;border:1px solid var(--line-2);border-radius:var(--r-sm);font:inherit;background:#fff;color:var(--ink);transition:border-color .12s,box-shadow .12s}
textarea{height:auto;min-height:84px;padding:9px 12px;resize:vertical}
input[type=checkbox],input[type=radio]{width:16px;height:16px;accent-color:var(--brand)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--brand-2);box-shadow:0 0 0 3px var(--brand-100)}
input::placeholder,textarea::placeholder{color:var(--faint)}
.chk{display:flex;gap:8px;align-items:center}.chk label{margin:0;font-weight:500;color:var(--ink)}
.formfoot{display:flex;gap:8px;justify-content:flex-end;border-top:1px solid var(--line);margin:20px -20px -20px;padding:14px 20px;background:var(--head);border-radius:0 0 var(--r) var(--r)}
/* ---- Schaltflächen ---- */
.btn{display:inline-flex;align-items:center;gap:6px;height:38px;background:var(--brand);color:#fff;border:1px solid var(--brand);border-radius:var(--r-sm);padding:0 16px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap;box-shadow:var(--sh)}
.btn:hover{background:var(--brand-d);border-color:var(--brand-d);text-decoration:none}
.btn.sec{background:#fff;color:var(--ink);border-color:var(--line-2)}
.btn.sec:hover{background:var(--head);border-color:var(--faint)}
.btn.danger{background:#fff;color:var(--err);border-color:#fecdca}
.btn.danger:hover{background:var(--err-50)}
.btn.ghost{background:transparent;border-color:transparent;color:var(--ink-2);box-shadow:none}
.btn.ghost:hover{background:var(--head)}
.btn.sm{height:30px;padding:0 10px;font-size:13px}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:14px 0}
.actions form{margin:0}
/* ---- Status ---- */
.badge{display:inline-flex;align-items:center;gap:4px;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:600;background:var(--head);color:var(--ink-2);border:1px solid var(--line);line-height:20px;white-space:nowrap}
.badge.draft,.badge.warn{background:var(--warn-50);color:var(--warn);border-color:#fde68a}
.badge.issued,.badge.ok{background:var(--ok-50);color:var(--ok);border-color:#bbf7d0}
.badge.sent,.badge.info{background:var(--info-50);color:var(--info);border-color:#bfdbfe}
.badge.failed,.badge.err{background:var(--err-50);color:var(--err);border-color:#fecdca}
.badge.kind{background:var(--brand-50);color:var(--brand);border-color:var(--brand-100)}
.badge.tag{font-weight:550}
.flash{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:var(--r);margin-bottom:16px;white-space:pre-wrap;border:1px solid}
.flash.ok{background:var(--ok-50);color:#14532d;border-color:#bbf7d0}
.flash.err{background:var(--err-50);color:#7a271a;border-color:#fecdca}
.restore{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--warn-50);border:1px solid #fde68a;color:#78350f;border-radius:var(--r);padding:10px 14px;margin-bottom:14px;font-size:13.5px}
.restore span{flex:1;min-width:220px}
.empty{background:var(--head);border:1px dashed var(--line-2);border-radius:var(--r);padding:16px;color:var(--mut);text-align:center}
.warnbox{background:var(--warn-50);border:1px solid #fde68a;border-radius:var(--r);padding:16px 18px;margin-bottom:16px}
.warnbox h3{color:var(--warn)}
.mut{color:var(--mut)}.small{font-size:12.5px}.faint{color:var(--faint)}
.num{font-variant-numeric:tabular-nums}
.big{font-size:22px;font-weight:650}
.sum{font-weight:650;color:var(--ink)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px;margin-bottom:16px}
.kpi{background:#fff;border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;box-shadow:var(--sh)}
.kpi .l{font-size:12.5px;color:var(--mut);font-weight:550}
.kpi .v{font-size:24px;font-weight:650;margin-top:4px;font-variant-numeric:tabular-nums}
.kpi .s{font-size:12.5px;color:var(--mut)}
.kpi a{color:inherit}
/* ---- Rechnungseditor / Summen ---- */
.lines input,.lines select{height:34px;padding:0 8px}
.lines td{padding:6px 8px}
.right{text-align:right}
.totals{margin-left:auto;max-width:380px;box-shadow:none}
.totals td{border:0;padding:4px 14px}
.totals tr.sum td{font-weight:700;color:var(--ink);border-top:1px solid var(--line);padding-top:8px}
.hint{background:var(--info-50);border:1px solid #bfdbfe;color:#1e3a8a;padding:12px 14px;border-radius:var(--r);font-size:13.5px}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:0}.kv dt{color:var(--mut)}.kv dd{margin:0}
/* ---- Diagramm ---- */
.bars{display:flex;align-items:flex-end;gap:6px;height:160px;border-bottom:1px solid var(--line);padding-top:8px}
.bars div{flex:1;background:var(--brand-100);border-radius:3px 3px 0 0;min-width:6px}
.bars div:hover{background:var(--brand)}
.barlabels{display:flex;gap:6px;font-size:11px;color:var(--mut);margin-top:4px}.barlabels span{flex:1;text-align:center;white-space:nowrap;overflow:visible;min-width:6px}
.planned{max-width:720px}
.person{display:flex;gap:12px;align-items:center;padding:6px 0}
.avatar{width:36px;height:36px;border-radius:50%;background:var(--brand-50);color:var(--brand);display:flex;align-items:center;justify-content:center;font-weight:650;font-size:13px;flex:none;border:1px solid var(--brand-100)}
/* ---- Dateien / Upload ---- */
.drop-zone{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;border:1.5px dashed var(--line-2);border-radius:var(--r);background:var(--head);padding:24px 16px;text-align:center;color:var(--mut);cursor:pointer;transition:background .12s,border-color .12s}
.drop-zone:hover,.drop-zone.over{border-color:var(--brand-2);background:var(--brand-50);color:var(--brand)}
.drop-zone .ic{color:var(--brand)}
.drop-zone b{color:var(--ink)}
.drop-zone input{display:none}
.files{list-style:none;margin:12px 0 0;padding:0;border:1px solid var(--line);border-radius:var(--r);background:#fff}
.files:empty{display:none}
.files li{display:grid;grid-template-columns:auto 1fr auto;gap:4px 12px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line)}
.files li:last-child{border-bottom:0}
.files .fic{width:34px;height:34px;border-radius:6px;background:var(--brand-50);color:var(--brand);display:flex;align-items:center;justify-content:center}
.files .nm{font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.files .meta{font-size:12px;color:var(--mut)}
.files .bar{grid-column:2/4;height:6px;border-radius:999px;background:var(--line);overflow:hidden}
.files .bar>i{display:block;height:100%;width:0;background:var(--brand);transition:width .2s}
.files li.done .bar>i{background:var(--ok)}
.files li.error .bar>i{background:var(--err)}
.files .act{display:flex;gap:4px}
/* ---- Handy ---- */
#burger{display:none}
.burgerbtn{display:none}
@media (max-width:900px){.cols{grid-template-columns:1fr}}
@media (max-width:760px){
  .top .in{height:auto;flex-wrap:wrap;padding:10px 14px;gap:10px}
  .top .logo img{height:30px}
  .search{order:3;flex-basis:100%;max-width:none}
  .search kbd,.usr span{display:none}
  .burgerbtn{display:flex;align-items:center;gap:8px;height:44px;padding:0 16px;font-weight:600;cursor:pointer;color:#fff}
  nav.menu .in{display:none;flex-direction:column;padding:0 0 8px}
  #burger:checked~.in{display:flex}
  details.dd>.drop{position:static;box-shadow:none;border:0;margin:0 12px 8px;border-radius:var(--r)}
  nav.menu{position:static}
  main{padding:16px 14px 56px}
  h1{font-size:21px}
  .newform{margin-left:0}
  .formfoot{margin:16px -16px -16px;padding:12px 16px}
  .card{padding:16px}
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
      { label: 'Kundenliste', href: '/kunden' },
      { label: 'Objekte', href: '/objekte' },
      { label: 'Aufgaben', href: '/aufgaben' },
    ],
  },
  {
    key: 'angebote',
    label: 'Angebote',
    items: [
      { label: 'Alle Angebote', href: '/angebote' },
      { label: 'Abgabefristen', href: '/angebote?ansicht=fristen' },
      { label: 'Angebot anlegen', href: '/neu?typ=angebot' },
      { label: 'Aufträge', href: '/auftraege', sep: true },
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
      { label: 'Mahnwesen', href: '/mahnungen' },
      { label: 'Leistungsarten', href: '/einstellungen/leistungsarten', sep: true },
    ],
  },
  {
    key: 'lieferanten',
    label: 'Lieferanten',
    items: [
      { label: 'Lieferanten & Nachunternehmer', href: '/lieferanten' },
      { label: 'Bestellungen (BE-JJJJ-NNNN)', href: '/bestellungen' },
      { label: 'Rechnungseingang', href: '/rechnungseingang' },
      { label: 'Zahlungslauf SEPA', href: '/zahlungslauf' },
    ],
  },
  {
    key: 'personal',
    label: 'Personal',
    items: [
      { label: 'Mitarbeiter', href: '/personal' },
      { label: 'Mitarbeiter anlegen', href: '/neu?typ=mitarbeiter' },
      { label: 'Zeiterfassung', href: '/zeiterfassung', sep: true },
      { label: 'Nachträge freigeben', href: '/zeiterfassung/freigaben' },
      { label: 'Prüfbericht Zoll (§ 17 MiLoG)', href: '/zeiterfassung/pruefbericht' },
      { label: 'Urlaub & Abwesenheiten', href: '/urlaub' },
      { label: 'Mitarbeiter-Handyansicht', href: '/m' },
      { label: 'Dokumente digital unterschreiben', href: '/personal/dokumente' },
      { label: 'Dokumentvorlagen / Serienbriefe', href: '/personal/vorlagen' },
      { label: 'Lohnstufen', href: '/personal/lohnstufen' },
    ],
  },
  {
    key: 'inventar',
    label: 'Inventar',
    items: [
      { label: 'Artikel & Nachbestellung', href: '/artikel' },
      { label: 'Geräte & Prüftermine', href: '/geraete' },
      { label: 'Schlüsselbuch', href: '/schluessel' },
    ],
  },
  {
    key: 'disposition',
    label: 'Disposition',
    items: [
      { label: 'Einsatzplanung (Wochenplan)', href: '/einsatzplanung' },
      { label: 'Planung Monatstafel', href: '/einsatzplanung/monat' },
      { label: 'Einsätze für abwesende Mitarbeiter', href: '/einsatzplanung/vertretungen' },
      { label: 'Arbeitsscheine (Unterschrift vor Ort)', href: '/arbeitsscheine' },
      { label: 'Qualitätskontrollen', href: '/qualitaet' },
      { label: 'Zählerstände', href: '/zaehler' },
      { label: 'Leistungswerte je Raumart', href: '/raumbuch/leistungswerte' },
      { label: 'Heute: Soll/Ist', href: '/zeiterfassung' },
      { label: 'Monat: Soll/Ist je Mitarbeiter', href: '/zeiterfassung/monat' },
      { label: 'Urlaubskalender', href: '/urlaub/kalender' },
      { label: 'Glasreinigung / Tiefgarage', href: '/geplant/sonderdienste', soon: true },
    ],
  },
  {
    key: 'transfer',
    label: 'Transfer',
    items: [
      { label: 'Kontoumsätze (Bankabgleich)', href: '/transfer/kontoumsaetze' },
      { label: 'SEPA-Lastschriften', href: '/transfer/lastschriften' },
      { label: 'Dokumentenversand', href: '/transfer/dokumentenversand' },
      { label: 'Dokumenteneingang', href: '/transfer/dokumenteneingang' },
      { label: 'Export Lexware Lohn (Stammdaten)', href: '/personal/export.csv' },
      { label: 'DATEV-Export', href: '/datev' },
      { label: 'Import aus Fortytools', href: '/geplant/import', soon: true },
    ],
  },
  {
    key: 'auswertungen',
    label: 'Auswertungen',
    items: [
      { label: 'Übersicht Auswertungen', href: '/auswertungen' },
      { label: 'Rechnungs-Statistik', href: '/auswertungen/rechnungen' },
      { label: 'Netto-Umsatz je Monat', href: '/auswertungen/umsatz' },
      { label: 'Umsatz-Vorschau', href: '/auswertungen/vorschau' },
      { label: 'Nachkalkulation je Objekt', href: '/auswertungen/nachkalkulation' },
      { label: 'Ø Stundensätze je Objekt', href: '/auswertungen/stundensaetze' },
      { label: 'Stundenkontrolle Soll/Ist', href: '/auswertungen/stunden' },
      { label: 'Urlaubskonten', href: '/auswertungen/urlaub' },
      { label: 'Krankheitstage', href: '/auswertungen/krankheit' },
      { label: 'Dienste-Liste', href: '/auswertungen/dienste' },
    ],
  },
];

export function initials(name: string): string {
  return name
    .split(/[\s,]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export const Layout: FC<{
  title: string;
  nav: string;
  env: string;
  user?: string;
  role?: Role;
  /** ohne Menü/Suche (Anmeldeseite) */
  bare?: boolean;
  flash?: { ok?: string | undefined; err?: string | undefined };
  children?: Child;
}> = ({ title, nav, env, user, role, bare, flash, children }) => {
  const menu = role
    ? MENU.map((m) => ({
        ...m,
        items: m.items?.filter(
          (i) =>
            canOpen(role, i.href) &&
            // geplante Bereiche und Handy-Ansicht nur fürs Büro einblenden
            (!(i.soon || i.href === '/m') ||
              role === 'admin' ||
              role === 'buchhaltung' ||
              (i.href === '/m' && role === 'personal')),
        ),
      })).filter((m) => (m.href ? canAccess(role, m.href) : (m.items?.length ?? 0) > 0))
    : [];
  const search = !!role && canAccess(role, '/suche');
  return (
    <html lang="de">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${title} · Viva-Deluxe`}</title>
        <link rel="icon" type="image/png" href="/static/favicon.png" />
        <link
          rel="preload"
          href="/static/inter-latin.woff2"
          as="font"
          type="font/woff2"
          crossorigin="anonymous"
        />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <header class="top">
          <div class="in">
            <a class="logo" href="/" aria-label="Viva-Deluxe – Übersicht">
              <img src="/static/logo.png" alt="Viva-Deluxe GmbH" width="179" height="36" />
            </a>
            {search ? (
              <form class="search" action="/suche" method="get" role="search">
                <Icon name="search" />
                <input
                  id="q"
                  name="q"
                  placeholder="Kunden, Objekte, Rechnungen, Angebote, Mitarbeiter suchen…"
                  minlength={3}
                  aria-label="Suchen"
                />
                <kbd>/</kbd>
              </form>
            ) : (
              <span style="flex:1" />
            )}
            <div class="right">
              <span class={`env${env === 'live' ? ' live' : ''}`}>
                {env === 'live' ? 'LIVE' : env === 'test' ? 'TEST' : 'LOKAL'}
              </span>
              {user && (
                <details class="dd">
                  <summary class="usr" style="cursor:pointer">
                    <span class="av">{initials(user)}</span>
                    <span>{user}</span>
                  </summary>
                  <div class="drop right">
                    <a href="/konto">Mein Konto / Passwort</a>
                    {role === 'admin' && <a href="/benutzer">Benutzer & Rechte</a>}
                    <div class="sep" />
                    <form method="post" action="/abmelden" style="margin:0">
                      <button class="btn ghost" style="width:100%;justify-content:flex-start">
                        Abmelden
                      </button>
                    </form>
                  </div>
                </details>
              )}
            </div>
          </div>
        </header>
        {!bare && (
          <nav class="menu" aria-label="Hauptmenü">
            <input type="checkbox" id="burger" />
            <label for="burger" class="burgerbtn">
              <Icon name="menu" /> Menü
            </label>
            <div class="in">
              {menu.map((m) =>
                m.href ? (
                  <a class={`item${nav === m.key ? ' on' : ''}`} href={m.href}>
                    {m.label}
                  </a>
                ) : (
                  <details class={`dd item${nav === m.key ? ' on' : ''}`}>
                    <summary>
                      {m.label} <Icon name="chevron" size={14} />
                    </summary>
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
        )}
        <main>
          {flash?.ok && (
            <div class="flash ok" role="status">
              <Icon name="check" />
              <span>{flash.ok}</span>
            </div>
          )}
          {flash?.err && (
            <div class="flash err" role="alert">
              <Icon name="alert" />
              <span>{flash.err}</span>
            </div>
          )}
          {children}
        </main>
        <script dangerouslySetInnerHTML={{ __html: CLIENT_JS }} />
      </body>
    </html>
  );
};

/** Seitentitel + „Neu anlegen: [Auswahl] Los“ wie Fortytools. */
export const PageHead: FC<{
  title: string;
  no?: string | null | undefined;
  crumbs?: [string, string][];
  create?: {
    options: [string, string][];
    selected?: string;
    suffix?: string;
    context?: Record<string, string>;
  };
  children?: Child;
}> = ({ title, no, crumbs, create, children }) => (
  <>
    {crumbs && crumbs.length > 0 && (
      <div class="crumbs">
        {crumbs.map(([label, href], i) => (
          <>
            {i > 0 && ' / '}
            <a href={href}>{label}</a>
          </>
        ))}
      </div>
    )}
    <div class="pagehead">
      <h1>
        {title}
        {no && <span class="no">{no}</span>}
      </h1>
      {children}
      {create && (
        <form class="newform" action="/neu" method="get">
          <label for="neu-typ">Neu anlegen</label>
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
          {create.suffix && <span class="mut small">{create.suffix}</span>}
          <button class="btn">
            <Icon name="plus" /> Anlegen
          </button>
        </form>
      )}
    </div>
  </>
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
          <summary>
            Mehr <Icon name="chevron" size={14} />
          </summary>
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
  ['angebot', 'Angebot'],
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
  monthly_flat: 'Pauschale (regelmäßig)',
  special: 'Sonderleistung',
  hourly: 'Regiestunden',
};

/** 1536 → "1,5 KB", 2.3e9 → "2,1 GB" */
export function fileSize(bytes: number): string {
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString('de-DE', { maximumFractionDigits: i === 0 ? 0 : 1 })} ${u[i]}`;
}
