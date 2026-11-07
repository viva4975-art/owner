// Vorschau „Glas“ (Ahmed 07.11.: „Liquid Glass wie beim iPhone“). Nur aktiv, wenn der Benutzer sie über /design/glas
// einschaltet (Cookie vd_design=glas → Klasse `glas` am <html>). Wirkt am PC (Layout), im App-Rahmen, in /m und /qm.
// Alles ist auf `html.glas` beschränkt – ohne die Klasse ändert sich nichts.

/** Setzt die Klasse vor dem ersten Zeichnen (kein Aufblitzen der alten Gestaltung). */
export const GLASS_HEAD_JS = `(function(){try{if(/(?:^|; )vd_design=glas(?:;|$)/.test(document.cookie))document.documentElement.classList.add('glas')}catch(e){}})();`;

export const GLASS_CSS = `
html.glas{--glass:rgba(255,255,255,.58);--glass-2:rgba(255,255,255,.42);--glass-line:rgba(255,255,255,.75);--glass-edge:rgba(125,20,53,.10);--glass-shadow:0 1px 0 rgba(255,255,255,.9) inset,0 10px 30px -12px rgba(76,18,38,.22),0 2px 6px rgba(76,18,38,.06);--blur:saturate(180%) blur(22px)}
/* Hintergrund: weiche Farbflächen, damit das Glas etwas zu brechen hat */
html.glas body.shell,html.glas body.appmode,html.glas body.mshell,html.glas body.bare,html.glas body{background:#f3eef1 fixed!important;background-image:radial-gradient(900px 600px at 8% -6%,rgba(196,74,112,.30),transparent 60%),radial-gradient(800px 600px at 96% 4%,rgba(214,170,96,.26),transparent 60%),radial-gradient(900px 700px at 70% 105%,rgba(125,20,53,.20),transparent 60%),radial-gradient(700px 500px at -5% 85%,rgba(120,140,200,.18),transparent 60%)!important;background-attachment:fixed!important}
html.glas .shell .mainc,html.glas main{background:transparent!important}
/* Glasflächen */
html.glas .card,html.glas .panel,html.glas .kpi,html.glas .bs-kpi,html.glas .tile,html.glas .info-col .panel,html.glas .flash,html.glas details.box,html.glas .drop,html.glas .cbx-pop,html.glas dialog{background:var(--glass)!important;-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border:1px solid var(--glass-line)!important;box-shadow:var(--glass-shadow)!important;border-radius:20px!important}
html.glas .card .card,html.glas .panel .card{background:var(--glass-2)!important;box-shadow:0 1px 0 rgba(255,255,255,.8) inset!important;border-radius:16px!important}
/* Kopfzeile + Menü schweben als Glas */
html.glas .shell .top,html.glas .menu-top .top{position:sticky;top:0;z-index:61;background:rgba(255,255,255,.55)!important;-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border-bottom:1px solid var(--glass-line)!important;box-shadow:0 1px 0 rgba(125,20,53,.06)}
html.glas .menu-top .appside{top:64px!important;margin:8px 16px 0;border-radius:999px;background:linear-gradient(180deg,rgba(150,32,70,.80),rgba(110,16,46,.84))!important;-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border:1px solid rgba(255,255,255,.28);box-shadow:0 1px 0 rgba(255,255,255,.35) inset,0 12px 30px -12px rgba(76,18,38,.45)!important}
html.glas .menu-top .appside .item.on>summary,html.glas .menu-top .appside a.item.on{background:rgba(255,255,255,.18)!important;border-radius:999px;box-shadow:0 1px 0 rgba(255,255,255,.3) inset}
html.glas .menu-top .appside .sub{background:rgba(255,255,255,.72)!important;-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border:1px solid var(--glass-line)!important;border-radius:18px!important;box-shadow:var(--glass-shadow)!important}
html.glas body.shell:not(.menu-top) .appside{background:linear-gradient(180deg,rgba(140,28,64,.86),rgba(100,14,42,.9))!important;-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur)}
html.glas .search{background:rgba(255,255,255,.6)!important;border:1px solid var(--glass-line)!important;border-radius:999px!important;box-shadow:0 1px 0 rgba(255,255,255,.9) inset,0 2px 8px rgba(76,18,38,.06)}
html.glas .search input{background:transparent!important;border:0!important}
/* Knöpfe: Pillen mit Lichtkante */
html.glas .btn,html.glas button.btn{border-radius:999px!important;box-shadow:0 1px 0 rgba(255,255,255,.35) inset,0 6px 14px -6px rgba(125,20,53,.55)!important;background:linear-gradient(180deg,#9a2a52,#7d1435)!important;border-color:rgba(255,255,255,.18)!important}
html.glas .btn.secondary,html.glas .btn.ghost,html.glas .btn.sec,html.glas a.btn.light,html.glas .btn.outline{background:rgba(255,255,255,.6)!important;color:#5a1027!important;border:1px solid var(--glass-line)!important;box-shadow:0 1px 0 rgba(255,255,255,.95) inset,0 4px 12px -6px rgba(76,18,38,.25)!important;-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur)}
html.glas .btn.danger{background:linear-gradient(180deg,#d4504f,#b0302f)!important}
/* Felder */
html.glas input:not([type=checkbox]):not([type=radio]):not([type=range]),html.glas select,html.glas textarea{background:rgba(255,255,255,.62)!important;border:1px solid rgba(255,255,255,.85)!important;border-radius:12px!important;box-shadow:0 1px 2px rgba(76,18,38,.06) inset}
html.glas input:focus,html.glas select:focus,html.glas textarea:focus{box-shadow:0 0 0 4px rgba(125,20,53,.14)!important;border-color:rgba(125,20,53,.35)!important}
/* Tabellen: durchscheinend, Kopf ohne Fläche */
html.glas table,html.glas .tbl{background:transparent!important}
html.glas .tbl thead th,html.glas table thead th,html.glas .info-col .panel-head,html.glas .svc-head,html.glas .empty,html.glas .empty-line{background:rgba(255,255,255,.35)!important;border-color:rgba(125,20,53,.08)!important}
html.glas table td,html.glas table th{border-color:rgba(125,20,53,.07)!important}
html.glas table tbody tr:hover td{background:rgba(255,255,255,.45)}
/* Reiter als Segment-Steuerung */
html.glas .tabs,html.glas .ls-tabs{background:rgba(255,255,255,.45);-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border:1px solid var(--glass-line)!important;border-radius:999px;padding:4px!important;gap:2px;width:max-content;max-width:100%}
html.glas .tabs a,html.glas .ls-tabs a{border:0!important;border-radius:999px!important;padding:6px 14px!important}
html.glas .tabs a.on,html.glas .ls-tabs a.on,html.glas .tabs a[aria-current]{background:rgba(255,255,255,.92)!important;box-shadow:0 2px 8px rgba(76,18,38,.12),0 1px 0 #fff inset;color:#7d1435!important}
html.glas .badge,html.glas .pill,html.glas .chip{-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
/* App-Rahmen und Handy-Apps: Kopf + schwebende Leiste unten wie iOS */
html.glas .appmode .apphead,html.glas body.mshell>header,html.glas body>header{background:rgba(255,255,255,.5)!important;-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border-bottom:1px solid var(--glass-line)!important}
html.glas .apptabs,html.glas .tabbar{margin:0 14px calc(10px + env(safe-area-inset-bottom));padding-bottom:0!important;border-radius:28px;background:rgba(255,255,255,.55)!important;-webkit-backdrop-filter:saturate(200%) blur(26px);backdrop-filter:saturate(200%) blur(26px);border:1px solid var(--glass-line)!important;box-shadow:0 1px 0 rgba(255,255,255,.9) inset,0 14px 34px -10px rgba(76,18,38,.35)!important}
html.glas .apptabs a.on i,html.glas .tabbar a.on i{background:rgba(255,255,255,.95)!important;box-shadow:0 2px 8px rgba(76,18,38,.15)}
html.glas body.mshell main .card,html.glas body.mshell .card{background:var(--glass)!important}
@media (prefers-reduced-transparency:reduce){html.glas .card,html.glas .panel,html.glas .kpi,html.glas .shell .top,html.glas .apptabs,html.glas .tabbar{background:rgba(255,255,255,.94)!important;-webkit-backdrop-filter:none;backdrop-filter:none}}
@media print{html.glas body{background:#fff!important}html.glas .card,html.glas .panel{background:#fff!important;box-shadow:none!important;backdrop-filter:none!important}}
`;
