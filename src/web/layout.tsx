import type { Child, FC } from 'hono/jsx';
import { formatEuro, type Cents } from '../domain/money/money.js';
import { formatDateDe } from '../domain/invoice/calc.js';
import { CLIENT_JS } from './client.js';
import type { Role } from '../services/users.js';
import { Icon } from './icons.js';
import { canAccess, canOpen } from './permissions.js';

/*
 * Erscheinungsbild „Unternehmenssoftware“ (Grundlage, überlagert vom klassischen Stil am Ende), Bordeaux als Akzent
 * (Navigation, Hauptaktion, aktive Zustände), klare Hierarchie, Tabellen mit tabellarischen Ziffern.
 * Aufbau weiterhin wie Fortytools (Hauptmenü mit Untermenüs, „Neu anlegen“, Reiter).
 */
const CSS = `
@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url(/static/inter-latin.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url(/static/inter-latin-ext.woff2) format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
:root{
  --brand:#7D1435;--brand-2:#8B2332;--brand-d:#5c0e27;--brand-50:#faf3f5;--brand-100:#f3e1e7;
  --ink:#1a1a1a;--ink-2:#3d3a36;--mut:#6b6862;--faint:#9a9690;
  --line:#ece9e5;--line-2:#ddd8d2;--bg:#fafaf9;--panel:#fff;--head:#f7f6f3;
  --ok:#2d7a4f;--ok-50:#eaf5ee;--warn:#9a6b0c;--warn-50:#fff7e6;--err:#b03030;--err-50:#fdeeee;--info:#1a56cc;--info-50:#eaf1fc;
  --r:12px;--r-sm:8px;--sh:0 1px 2px rgba(26,20,16,.04),0 1px 3px rgba(26,20,16,.04);--sh-2:0 12px 32px rgba(26,20,16,.12);
}
*{box-sizing:border-box}
[hidden]{display:none!important}
.sel-wrap{display:flex;flex-direction:column;gap:4px;min-width:0}.sel-wrap>select{width:100%}
.sel-search{font-size:13px!important;padding:5px 9px!important;background:var(--panel)!important;border-style:dashed!important}.sel-search.none{border-color:var(--err)!important}
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
nav.menu{background:rgba(255,255,255,.92);backdrop-filter:saturate(1.4) blur(8px);-webkit-backdrop-filter:saturate(1.4) blur(8px);position:sticky;top:0;z-index:20;border-bottom:1px solid var(--line)}
nav.menu .in{max-width:1360px;margin:0 auto;padding:6px 16px;display:flex;flex-wrap:wrap;gap:2px}
nav.menu .item>summary,nav.menu a.item{display:flex;align-items:center;gap:4px;height:36px;padding:0 12px;border-radius:var(--r-sm);color:var(--ink-2);font-weight:550;cursor:pointer;list-style:none;white-space:nowrap;text-decoration:none;font-size:14px}
nav.menu .item>summary::-webkit-details-marker{display:none}
nav.menu .item>summary .ic{opacity:.55}
nav.menu .item>summary:hover,nav.menu a.item:hover,nav.menu details[open]>summary{background:var(--head);color:var(--ink)}
nav.menu .item.on>summary,nav.menu a.item.on{color:var(--brand);background:var(--brand-50)}
details.dd{position:relative}
details.dd>summary{list-style:none}details.dd>summary::-webkit-details-marker{display:none}
details.dd>.drop{position:absolute;left:0;top:100%;min-width:280px;background:#fff;border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh-2);padding:6px;z-index:30;margin-top:6px}
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
h1{font-size:26px;line-height:1.2;margin:0;color:var(--ink);font-weight:700;letter-spacing:-.02em}
h1 .no{font-weight:500;color:var(--faint);font-size:.75em;margin-left:4px}
.newform{display:flex;gap:8px;align-items:center;margin-left:auto}
.newform select{width:auto;min-width:150px}
.newform label{margin:0;color:var(--mut);font-size:13px;font-weight:500}
h2{font-size:16px;font-weight:650;margin:28px 0 12px;color:var(--ink)}
h3{font-size:14px;font-weight:650;margin:0 0 10px;color:var(--ink)}
h2 .cnt,h3 .cnt{font-weight:500;color:var(--faint)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:22px;margin-bottom:16px;box-shadow:var(--sh)}
.card>h2:first-child,.card>h3:first-child,.card>div>h2:first-child{margin-top:0}
.card.flush{padding:0}.card.flush>.tbl{border:0;border-radius:var(--r);margin:0}
.cols{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:16px;align-items:start}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px 16px}
.cols>*,.grid>*{min-width:0}
/* Formulare wie Fortytools: ein Feld pro Zeile untereinander, Beschriftung links (Ahmed 06.10.2026) */
form .grid{grid-template-columns:minmax(0,1fr);gap:10px;max-width:820px}
form .grid>div:not(.chk){display:grid;grid-template-columns:220px minmax(0,1fr);gap:4px 16px;align-items:center}
form .grid>div:not(.chk)>label{margin:0}
form .grid>div:not(.chk)>:not(label){grid-column:2}
form .grid>div:not(.chk)>textarea{min-height:76px}
form .grid>.chk{padding-left:236px}
form .grid>[style*="grid-column"]{grid-column:auto!important}
.pop form .grid>div:not(.chk),form.inline .grid>div:not(.chk){grid-template-columns:minmax(0,1fr)}
.pop form .grid>div:not(.chk)>:not(label),form.inline .grid>div:not(.chk)>:not(label){grid-column:1}
.pop form .grid>.chk,form.inline .grid>.chk{padding-left:0}
@media (max-width:700px){form .grid>div:not(.chk){grid-template-columns:minmax(0,1fr)}form .grid>div:not(.chk)>:not(label){grid-column:1}form .grid>.chk{padding-left:0}}
.section-title{font-size:12px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin:24px 0 10px}
/* ---- Reiter ---- */
.tabs{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--line);margin-bottom:20px}
.tabs a,.tabs summary{display:flex;align-items:center;gap:6px;padding:10px 12px;color:var(--mut);font-weight:550;text-decoration:none;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs a:hover,.tabs summary:hover{color:var(--ink)}
.tabs a.on{color:var(--ink);border-bottom-color:var(--brand)}
.tabs .cnt{font-size:11.5px;font-weight:600;background:var(--head);border:1px solid var(--line);color:var(--ink-2);border-radius:999px;padding:0 7px;line-height:18px}
.tabbody{}
/* ---- Tabellen ---- */
table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;font-variant-numeric:tabular-nums}
th,td{padding:12px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:11.5px;font-weight:600;color:var(--faint);background:#fff;white-space:nowrap;text-transform:uppercase;letter-spacing:.05em;padding-top:10px;padding-bottom:10px}
tbody tr:last-child td{border-bottom:0}
td.r,th.r{text-align:right;white-space:nowrap}
tbody tr:hover td{background:#fcfbfa}
.tbl{border:1px solid var(--line);border-radius:var(--r);overflow:auto;background:#fff;box-shadow:var(--sh)}
.card .tbl{box-shadow:none;border:0;border-radius:0;margin:0 -22px}
.card .tbl th:first-child,.card .tbl td:first-child{padding-left:22px}.card .tbl th:last-child,.card .tbl td:last-child{padding-right:22px}
td b,td strong{font-weight:600}
/* ---- Formulare ---- */
label{display:block;font-size:12.5px;color:var(--ink-2);margin-bottom:6px;font-weight:550}
input,select,textarea{width:100%;height:38px;padding:0 12px;border:1px solid var(--line-2);border-radius:var(--r-sm);font:inherit;background:#fff;color:var(--ink);transition:border-color .12s,box-shadow .12s}
textarea{height:auto;min-height:84px;padding:9px 12px;resize:vertical}
input[type=checkbox],input[type=radio]{width:16px;height:16px;accent-color:var(--brand)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--brand-2);box-shadow:0 0 0 3px var(--brand-100)}
input::placeholder,textarea::placeholder{color:var(--faint)}
.chk{display:flex;gap:8px;align-items:center}.chk label{margin:0;font-weight:500;color:var(--ink)}
.formfoot{display:flex;gap:8px;justify-content:flex-end;border-top:1px solid var(--line);margin:22px -22px -22px;padding:14px 22px;background:var(--head);border-radius:0 0 var(--r) var(--r)}
/* ---- Schaltflächen ---- */
.btn{display:inline-flex;align-items:center;gap:6px;height:38px;background:var(--brand);color:#fff;border:1px solid var(--brand);border-radius:var(--r-sm);padding:0 16px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap;box-shadow:0 1px 2px rgba(125,20,53,.18);transition:background .12s,border-color .12s,transform .06s}
.btn:active{transform:translateY(1px)}
.btn:hover{background:var(--brand-d);border-color:var(--brand-d);text-decoration:none}
.btn.sec{background:#fff;color:var(--ink);border-color:var(--line-2);box-shadow:var(--sh)}
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
.badge{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;background:var(--head);color:var(--ink-2);border:1px solid transparent;line-height:20px;white-space:nowrap}
.badge.draft,.badge.warn,.badge.issued,.badge.ok,.badge.sent,.badge.info,.badge.failed,.badge.err{padding-left:8px}
.badge.draft::before,.badge.warn::before,.badge.issued::before,.badge.ok::before,.badge.sent::before,.badge.info::before,.badge.failed::before,.badge.err::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.badge.draft,.badge.warn{background:var(--warn-50);color:var(--warn)}
.badge.issued,.badge.ok{background:var(--ok-50);color:var(--ok)}
.badge.sent,.badge.info{background:var(--info-50);color:var(--info)}
.badge.failed,.badge.err{background:var(--err-50);color:var(--err)}
.badge.kind{background:var(--brand-50);color:var(--brand)}
.badge.tag{font-weight:550}
.flash{display:flex;gap:10px;align-items:flex-start;padding:12px 16px;border-radius:var(--r);margin-bottom:16px;white-space:pre-wrap;border:1px solid}
.flash.ok{background:var(--ok-50);color:#14532d;border-color:#bbf7d0}
.flash.warn{background:#fff8e6;color:#7a4b00;border-color:#f3d48a}
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
.kpi{background:#fff;border:1px solid var(--line);border-radius:var(--r);padding:18px 20px;box-shadow:var(--sh)}
.kpi .l{font-size:12.5px;color:var(--mut);font-weight:550}
.kpi .v{font-size:28px;font-weight:700;margin-top:4px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi .s{font-size:12.5px;color:var(--mut)}
.kpi a{color:inherit}
/* ---- Rechnungseditor / Summen ---- */
.lines input,.lines select{height:34px;padding:0 8px}
.lines td{padding:6px 8px}
.right{text-align:right}
.totals{margin-left:auto;max-width:380px;box-shadow:none}
.totals td{border:0;padding:4px 14px}
.totals tr.sum td{font-weight:700;color:var(--ink);border-top:1px solid var(--line);padding-top:8px}
.help{font-size:12.5px;color:var(--mut);margin-top:2px}
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
/* ---- Moderne Bausteine: Kopfkarte, Fortschritt, Listen ---- */
.hero{display:flex;flex-wrap:wrap;gap:16px 28px;align-items:center}
.hero .facts{display:flex;flex-wrap:wrap;gap:6px 24px;color:var(--mut);font-size:13px}
.hero .facts b{color:var(--ink);font-weight:600}
.hero .acts{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
.status-xl{display:inline-flex;align-items:center;gap:8px;font-weight:650;font-size:14px;padding:6px 14px;border-radius:999px}
.status-xl::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.status-xl.ok{background:var(--ok-50);color:var(--ok)}.status-xl.warn{background:var(--warn-50);color:var(--warn)}
.status-xl.err{background:var(--err-50);color:var(--err)}.status-xl.off{background:var(--head);color:var(--mut)}
.progress{height:8px;border-radius:999px;background:var(--head);overflow:hidden;min-width:120px}
.progress>i{display:block;height:100%;border-radius:999px;background:var(--ok)}
.progress.warn>i{background:#d39b24}.progress.err>i{background:var(--err)}
.list{border-top:1px solid var(--line);margin:0 -22px}
.list>.row{display:flex;gap:14px;align-items:center;padding:14px 22px;border-bottom:1px solid var(--line)}
.list>.row:last-child{border-bottom:0}
.list>.row:hover{background:#fcfbfa}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;flex:none;background:var(--line-2);vertical-align:middle}
.dot.ok{background:var(--ok)}.dot.warn{background:#d39b24}.dot.err{background:var(--err)}.dot.info{background:var(--info)}
.list .main{flex:1;min-width:0}.list .main b{font-weight:600}
.list .side{display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.list .when{font-size:12.5px;color:var(--mut);min-width:110px;text-align:right}
.group-title{font-size:11.5px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);margin:22px 0 8px}
.group-title:first-child{margin-top:0}
details.pop{position:relative}
details.pop>summary{list-style:none}details.pop>summary::-webkit-details-marker{display:none}
details.pop>.panel{position:absolute;right:0;top:calc(100% + 6px);z-index:15;background:#fff;border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh-2);padding:16px;width:min(340px,86vw)}
details.pop>.panel label{margin-top:10px}
details.pop>.panel .btn{margin-top:12px;width:100%;justify-content:center}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
.chips a{padding:6px 12px;border-radius:999px;border:1px solid var(--line-2);background:#fff;color:var(--ink-2);font-size:13px;font-weight:550;text-decoration:none}
.chips a.on{background:var(--ink);border-color:var(--ink);color:#fff}
.chips a .n{opacity:.6;margin-left:4px}
.letters{display:flex;flex-wrap:wrap;gap:2px}
.letters a{min-width:30px;height:30px;padding:0 6px;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--r-sm);color:var(--ink-2);font-weight:550;font-size:13px;text-decoration:none}
.letters a:hover{background:var(--head)}
.letters a.on{background:var(--ink);color:#fff}
.pager{display:flex;gap:4px;align-items:center;justify-content:center;flex-wrap:wrap;margin-top:18px}
.pager a{min-width:36px;height:36px;padding:0 10px;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--r-sm);border:1px solid var(--line-2);background:#fff;color:var(--ink-2);font-weight:550;text-decoration:none}
.pager a:hover{background:var(--head)}
.pager a.on{background:var(--ink);border-color:var(--ink);color:#fff}
.pager .gap{color:var(--faint);padding:0 4px}
.menuitem{display:block;padding:8px 10px;border-radius:var(--r-sm);color:var(--ink);text-decoration:none}
.menuitem:hover{background:var(--brand-50);color:var(--brand);text-decoration:none}
.list.sites .no{width:78px;flex:none;font-weight:600;color:var(--mut);font-variant-numeric:tabular-nums}
.list.sites .cust{width:260px;flex:none}
.list.sites .ol{width:210px;flex:none}
.person-chip{display:inline-flex;align-items:center;gap:6px;font-weight:550}
.person-chip .av{width:24px;height:24px;border-radius:50%;background:var(--brand-50);color:var(--brand);font-size:10.5px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}
.gear{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;color:var(--ink-2)}
.gear:hover{background:var(--head);color:var(--brand)}
.settings-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.settings-grid .card{margin:0}
.settings-grid a.set{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--line);color:var(--ink);text-decoration:none}
.settings-grid a.set:first-of-type{border-top:0}
.settings-grid a.set:hover b{color:var(--brand)}
.settings-grid a.set span{color:var(--mut);font-size:12.5px}
.op{padding:0;overflow:hidden}
.op-head{display:flex;align-items:center;gap:12px;padding:14px 22px;background:var(--head);border-bottom:1px solid var(--line)}
.op-head .no{font-size:18px;font-weight:700}
.op-head .nm{color:var(--mut);font-size:15px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.op-head .sum{background:#fff7c2;color:var(--ink);font-weight:700;padding:4px 12px;border-radius:var(--r-sm)}
.op-cols,.op-row{display:grid;grid-template-columns:1fr 130px 130px;gap:8px;padding:6px 22px;align-items:baseline}
.op-cols{font-size:11.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);text-align:right;padding-top:8px}
.op-row .r{text-align:right;font-variant-numeric:tabular-nums}
.op-item{border-top:1px solid var(--line);padding:6px 0 10px}
.op-sumline{border-top:1px dashed var(--line);margin:2px 22px 0;padding:6px 0;color:var(--mut)}
.op-saldo{display:flex;align-items:center;gap:12px;justify-content:flex-end;padding:4px 22px 0}
.op-saldo>span.small{margin-right:auto}
.op-saldo .lbl{font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.op input[type=checkbox]{width:20px;height:20px}
.op-bar{position:sticky;bottom:12px;z-index:5;box-shadow:var(--sh-2)}
.danger-zone{border-color:#f3d4d4}
.danger-zone>summary{cursor:pointer;font-weight:600;color:var(--err);list-style:none}
.danger-zone>summary::-webkit-details-marker{display:none}
/* ---- Handy ---- */
#burger{display:none}
.burgerbtn{display:none}
@media (max-width:900px){.cols{grid-template-columns:1fr}}
@media (max-width:760px){
  .top .in{height:auto;flex-wrap:wrap;padding:10px 14px;gap:10px}
  .top .logo img{height:30px}
  .search{order:3;flex-basis:100%;max-width:none}
  .search kbd,.usr span{display:none}
  .burgerbtn{display:flex;align-items:center;gap:8px;height:44px;padding:0 16px;font-weight:600;cursor:pointer;color:var(--ink)}
  nav.menu .in{display:none;flex-direction:column;padding:0 0 8px}
  #burger:checked~.in{display:flex}
  details.dd>.drop{position:static;box-shadow:none;border:0;margin:0 12px 8px;border-radius:var(--r)}
  nav.menu{position:static}
  main{padding:16px 14px 56px}
  h1{font-size:21px}
  .newform{margin-left:0}
  .formfoot{margin:16px -16px -16px;padding:12px 16px}
  .card{padding:16px}
  .card .tbl,.list{margin:0 -16px}
  .card .tbl th:first-child,.card .tbl td:first-child,.list>.row{padding-left:16px}
  .list>.row{padding-right:16px;flex-wrap:wrap}
  .list .main{flex:1 1 calc(100% - 30px)}
  .list .side{flex:1 1 100%;justify-content:flex-start;padding-left:24px}
  .list .when{text-align:left;min-width:0}
  .list.sites .no{width:auto}
  .list.sites .cust,.list.sites .ol{width:auto;flex:1 1 45%;padding-left:0}
  .kpis{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
  .kpi{padding:12px}.kpi .v{font-size:22px}.kpi .s{display:none}
  .op-cols,.op-row{grid-template-columns:1fr 92px 92px;padding-left:16px;padding-right:16px}
  .op-head,.op-saldo{padding-left:16px;padding-right:16px;flex-wrap:wrap}
  .op-sumline{margin:2px 16px 0}
  .op-bar{position:static}.hint-desk{display:none}
  .kpi .v{font-size:19px}
  .hero .acts{margin-left:0}
}
/* ===================================================================================================
   Klassisches Erscheinungsbild (Ahmed 06.10.2026: „modern wie Fortytools, soll nicht nach KI aussehen“):
   Systemschrift, dunkle Bordeaux-Kopfzeile, weiße Menüleiste, Karteireiter, eckigere Kästen ohne Schatten,
   Tabellenköpfe normal geschrieben, kantige Schilder statt runder Pillen.
   =================================================================================================== */
:root{--r:4px;--r-sm:3px;--bg:#e9ecf0;--line:#dde1e6;--line-2:#c8ced6;--head:#f3f4f6;--panel:#fff;
  --ink:#1f2933;--ink-2:#323f4b;--mut:#5f6b7a;--faint:#8a96a3;--sh:none;--sh-2:0 6px 18px rgba(16,24,40,.16)}
body{font:14px/1.5 "Segoe UI",-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;font-feature-settings:normal;-webkit-font-smoothing:auto;background:var(--bg)}
.top{background:#5c0e27;border-bottom:0}
.top .in{height:56px}
.top .logo{background:#fff;padding:4px 8px;border-radius:3px}
.top .logo img{height:30px}
.search input{background:#fff;border-color:#fff;border-radius:3px;height:34px}
.search kbd{font-family:inherit}
.usr,.top .right a{color:#fff}
.usr .av{background:#fff;color:#5c0e27}
.gear{color:#fff;border-radius:3px}.gear:hover{background:rgba(255,255,255,.12);color:#fff}
.env{border-radius:3px;background:#fff3c4;border-color:#fff3c4;color:#6b4e00}
nav.menu{background:#fff;backdrop-filter:none;-webkit-backdrop-filter:none;border-bottom:1px solid var(--line-2)}
nav.menu .in{padding:0 16px;gap:0}
nav.menu .item>summary,nav.menu a.item{border-radius:0;height:44px;color:var(--brand);font-weight:500;padding:0 14px}
nav.menu .item>summary .ic{opacity:.7}
nav.menu .item>summary:hover,nav.menu a.item:hover,nav.menu details[open]>summary{background:#f3f4f6;color:var(--brand-d)}
nav.menu .item.on>summary,nav.menu a.item.on{background:#e9ecf0;color:var(--ink)}
details.dd>.drop{border-radius:3px;margin-top:0;padding:4px 0}
.drop a{border-radius:0;padding:7px 14px;font-weight:400}
.drop a:hover{background:#f3f4f6;color:var(--brand)}
.drop .soon{border-radius:3px}
main{padding-top:28px}
h1{font-size:30px;font-weight:600;letter-spacing:0;color:#22303f}
h1 .no{font-weight:400;font-size:.72em}
h2{font-size:20px;font-weight:600;color:#22303f}
h3{font-size:15px;font-weight:600}
.card{border-radius:3px;box-shadow:none;border-color:var(--line)}
.formfoot{border-radius:0 0 3px 3px}
.btn{border-radius:3px;font-weight:500;height:34px}
.btn.sm{height:28px}
.btn.sec{box-shadow:none}
.badge{border-radius:3px;font-weight:600;padding:1px 7px}
.badge.draft::before,.badge.warn::before,.badge.issued::before,.badge.ok::before,.badge.sent::before,.badge.info::before,.badge.failed::before,.badge.err::before{display:none}
.badge.draft,.badge.warn,.badge.issued,.badge.ok,.badge.sent,.badge.info,.badge.failed,.badge.err{padding-left:7px}
.chips a{border-radius:3px}
.chips a.on{background:#5c0e27;border-color:#5c0e27}
.kpi{border-radius:3px}
.kpi .v{font-weight:600;letter-spacing:0}
input,select,textarea{border-radius:3px;height:36px}
input:focus,select:focus,textarea:focus{box-shadow:0 0 0 2px var(--brand-100)}
th{text-transform:none;letter-spacing:0;font-size:13px;color:var(--ink-2);background:#f3f4f6;font-weight:600}
.tbl{border-radius:3px;box-shadow:none}
tbody tr:hover td{background:#f8f9fb}
.empty{border-radius:3px;border-style:solid;background:#f3f4f6;text-align:left}
.list .row:hover{background:#f8f9fb}
.flash{border-radius:3px}
/* Karteireiter wie Fortytools */
.tabs{gap:2px;border-bottom:1px solid var(--line-2);margin-bottom:0}
.tabs a,.tabs summary{border:1px solid transparent;border-bottom:0;border-radius:3px 3px 0 0;color:var(--brand);font-weight:500;padding:9px 16px;margin-bottom:-1px}
.tabs a:hover,.tabs summary:hover{color:var(--brand-d);background:rgba(255,255,255,.55)}
.tabs a.on{background:#fff;border-color:var(--line-2);border-bottom:1px solid #fff;color:var(--ink)}
.tabs .cnt{border-radius:3px;background:#eef0f3}
.tabbody{background:#fff;border:1px solid var(--line-2);border-top:0;border-radius:0 0 3px 3px;padding:20px}
.tabbody>.card:last-child{margin-bottom:0}
/* Formular-Abschnitte */
h2.form-section{font-size:17px;margin:26px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h2.form-section:first-of-type{margin-top:4px}
/* Kundenübersicht */
.cust-overview{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:24px;align-items:start}
.cust-overview .main-col>*{margin-bottom:26px}
.panel-title{font-size:22px;font-weight:600;margin:0 0 10px;color:#22303f}
.panel-title .cnt{font-size:14px;font-weight:400;color:var(--faint)}
.empty-line{background:#f3f4f6;border:1px solid var(--line);border-radius:3px;padding:12px 16px;color:var(--ink-2)}
.side-col>.panel{background:#fff;border:1px solid var(--line-2);border-radius:3px;margin-bottom:16px}
.side-col .panel-head{margin:0;padding:10px 14px;font-size:16px;background:#f3f4f6;border-bottom:1px solid var(--line);font-weight:600}
.side-col .panel>:not(.panel-head){margin-left:14px;margin-right:14px}
.side-col .panel>:last-child{margin-bottom:14px}
.side-card{padding:14px}
.side-card .side-actions{float:right}
.side-card .addr{line-height:1.45;margin-bottom:8px}
.side-card .pin{font-size:12px;margin-left:4px}
.tag{display:inline-block;padding:1px 7px;border-radius:3px;font-size:12px;font-weight:600;color:#fff;background:#8a96a3}
.tag.ok{background:#2f8a3e}.tag.warn{background:#c98a00}.tag.err{background:#b03030}
.map{margin-top:12px;display:grid;gap:6px;justify-items:start}
.map iframe{width:100%;height:240px;border:0;display:block}
.map:has(iframe){margin:0!important}
.bank{position:relative;padding:10px 0;border-bottom:1px solid var(--line);margin-top:6px}
.bank .bank-del{position:absolute;right:0;top:8px;margin:0}
.bank-add{margin-top:12px}
.bank-add>summary{list-style:none;cursor:pointer}.bank-add>summary::-webkit-details-marker{display:none}
.bank-add form{margin-top:10px}
.linkbtn{background:none;border:0;padding:0;color:var(--brand-2);font:inherit;cursor:pointer}
.linkbtn:hover{text-decoration:underline}
.panel-foot{text-align:right;margin-top:8px}
.ledger table{background:#fff}
.ledger th.r .total{background:#fff3b0;padding:3px 8px;border-radius:3px;color:var(--ink)}
.ledger tbody.ledger-item td{border-bottom:0;padding-top:6px;padding-bottom:4px}
.ledger tbody.ledger-item tr.sub td{font-size:13px;padding-top:2px;padding-bottom:2px}
.ledger tbody.ledger-item tr.sum td{border-top:1px solid var(--line);border-bottom:1px solid var(--line-2);padding-bottom:10px}
.ledger .pdf{font-size:11px;font-weight:600;margin-left:8px;color:var(--mut);border:1px solid var(--line-2);border-radius:3px;padding:0 4px}
.ledger td.neg{color:var(--err);font-weight:600}.ledger td.pos{color:var(--ok)}
.revenue{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:20px;align-items:start}
.revchart{width:100%;height:auto;display:block}
.revchart .grid-line{stroke:#e3e6ea;stroke-width:1}
.revchart .axis{font-size:11px;fill:#5f6b7a}
.revchart .bar{fill:#c98a9e;stroke:#7D1435;stroke-width:1.2}
.revtable td,.revtable th{padding:6px 10px}
.revtable tr.sum td{background:#f3f4f6}
@media (max-width:1000px){.cust-overview,.revenue{grid-template-columns:minmax(0,1fr)}}
@media (max-width:700px){.tabbody{padding:12px}.tabs a,.tabs summary{padding:8px 10px}}

/* Kunde/Objekt: Infospalte links, Reiter rechts (auf jeder Unterseite sichtbar) */
.entity-layout{display:grid;grid-template-columns:290px minmax(0,1fr);gap:20px;align-items:start}
.info-col>.panel{background:#fff;border:1px solid var(--line-2);border-radius:3px;margin-bottom:14px}
.info-col .panel-head{margin:0;padding:9px 14px;font-size:15px;background:#f3f4f6;border-bottom:1px solid var(--line);font-weight:600}
.info-col .panel>:not(.panel-head):not(.side-actions){margin-left:14px;margin-right:14px}
.info-col .panel>:last-child{margin-bottom:12px}
.info-col .side-card{padding:12px 0}
.info-col .side-card>*{margin-left:14px;margin-right:14px}
.info-col .side-actions{float:right;margin-right:12px}
.info-col .kv{grid-template-columns:auto 1fr;gap:4px 10px;margin-top:8px}
.content-col{min-width:0}
.main-col>*{margin-bottom:26px}
@media (max-width:1000px){.entity-layout{grid-template-columns:minmax(0,1fr)}}

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
      { label: 'Ausschreibungen & Fristen', href: '/ausschreibungen' },
      { label: 'Ausschreibung erfassen', href: '/ausschreibungen/neu' },
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
      { label: 'Archiv (nach Leistungszeitraum)', href: '/rechnungen/archiv' },
      { label: 'Einzelrechnung anlegen', href: '/neu?typ=rechnung' },
      { label: 'Offene Posten', href: '/offene-posten', sep: true },
      { label: 'Mahnwesen', href: '/mahnungen' },
    ],
  },
  {
    key: 'lieferanten',
    label: 'Lieferanten',
    items: [
      { label: 'Lieferanten & Nachunternehmer', href: '/lieferanten' },
      { label: 'Nachunternehmer: Nachweise & Fristen', href: '/nachunternehmer' },
      { label: 'Nachunternehmer: Aufträge', href: '/nachunternehmer/auftraege' },
      { label: 'Nachunternehmer: Soll/Ist je Monat', href: '/nachunternehmer/monat' },
      { label: 'Bestellungen (BE-JJJJ-NNNN)', href: '/bestellungen' },
      { label: 'Rechnungseingang & Zahlungsliste', href: '/rechnungseingang' },
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
    ],
  },
  {
    key: 'inventar',
    label: 'Inventar',
    items: [
      { label: 'Artikel & Nachbestellung', href: '/artikel' },
      { label: 'Geräte & Prüftermine', href: '/geraete' },
      { label: 'Schlüsselbuch', href: '/schluessel' },
      { label: 'Übergaben mit Unterschrift', href: '/uebergaben', sep: true },
      { label: 'Arbeitskleidung: Bestand', href: '/arbeitskleidung' },
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
      { label: 'Heute: Soll/Ist', href: '/zeiterfassung' },
      { label: 'Monat: Soll/Ist je Mitarbeiter', href: '/zeiterfassung/monat' },
      { label: 'Urlaubskalender', href: '/urlaub/kalender' },
      { label: 'Sonderdienste (Glas, Tiefgarage …)', href: '/sonderdienste' },
    ],
  },
  {
    key: 'transfer',
    label: 'Transfer',
    items: [
      { label: 'Kontoumsätze (Bankabgleich)', href: '/transfer/kontoumsaetze' },
      { label: 'Dokumentenversand', href: '/transfer/dokumentenversand' },
      { label: 'Dokumenteneingang', href: '/transfer/dokumenteneingang' },
      { label: 'Export Lexware Lohn (Stammdaten)', href: '/personal/export.csv' },
      { label: 'DATEV-Export', href: '/datev' },
      { label: 'Import aus Fortytools (CSV)', href: '/transfer/import' },
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
      { label: 'Kosten je Kostenstelle', href: '/auswertungen/kostenstellen' },
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
              {user && role && canOpen(role as Role, '/einstellungen') && (
                <a href="/einstellungen" class="gear" title="Einstellungen" aria-label="Einstellungen">
                  <Icon name="settings" size={20} />
                </a>
              )}
              {user && (
                <details class="dd">
                  <summary class="usr" style="cursor:pointer">
                    <span class="av">{initials(user)}</span>
                    <span>{user}</span>
                  </summary>
                  <div class="drop right">
                    <a href="/konto">Mein Konto / Passwort</a>
                    {role === 'admin' && <a href="/benutzer">Benutzer & Rechte</a>}
                    {role && canOpen(role as Role, '/einstellungen') && (
                      <a href="/einstellungen">Einstellungen</a>
                    )}
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
