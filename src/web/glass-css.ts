// Vorschau „Glas“ (Ahmed 07.11.: „Liquid Glass wie beim iPhone“). Nur aktiv, wenn der Benutzer sie über /design/glas
// einschaltet (Cookie vd_design=glas → Klasse `glas` am <html>). Wirkt am PC (Layout), im App-Rahmen, in /m und /qm.
// Alles ist auf `html.glas` beschränkt – ohne die Klasse ändert sich nichts.

/** Setzt die Klasse vor dem ersten Zeichnen (kein Aufblitzen der alten Gestaltung). */
export const GLASS_HEAD_JS = `(function(){try{if(/(?:^|; )vd_design=glas(?:;|$)/.test(document.cookie))document.documentElement.classList.add('glas')}catch(e){}})();`;

export const GLASS_CSS = `
/* Fassung 2 (Ahmed 07.11.: „wie auf Apple“): hell und klar wie iOS/macOS 26 – Systemschrift, neutrales Glas mit
   Lichtkante, schwebende Glas-Kapseln für Menü und Leiste, Farbe (Bordeaux) nur als Tönung aktiver Elemente. */
html.glas{--g-fill:linear-gradient(135deg,rgba(255,255,255,.72),rgba(255,255,255,.46));--g-fill-2:rgba(255,255,255,.5);--g-rim:inset 0 1px 0 rgba(255,255,255,.95),inset 0 -1px 0 rgba(255,255,255,.35),inset 1px 0 0 rgba(255,255,255,.45),inset -1px 0 0 rgba(255,255,255,.45);--g-ring:0 0 0 .5px rgba(0,0,0,.08);--g-drop:0 8px 32px -8px rgba(0,0,0,.14),0 2px 6px rgba(0,0,0,.04);--g-blur:saturate(190%) blur(24px) brightness(1.04);--g-tint:rgba(125,20,53,.88);--ink:#1d1d1f;--mut:#6e6e73}
html.glas body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display",Inter,"Helvetica Neue",Arial,sans-serif!important;-webkit-font-smoothing:antialiased;color:#1d1d1f;letter-spacing:-.01em}
html.glas h1,html.glas h2,html.glas h3{letter-spacing:-.022em}
/* Hintergrund: hell, wie ein iOS-Hintergrundbild mit sanften Farben */
html.glas body,html.glas body.shell,html.glas body.appmode,html.glas body.mshell,html.glas body.bare{background-color:#eef0f5!important;background-image:radial-gradient(1100px 700px at 0% 0%,rgba(255,196,214,.55),transparent 60%),radial-gradient(900px 700px at 100% 0%,rgba(190,214,255,.55),transparent 60%),radial-gradient(1000px 800px at 85% 100%,rgba(255,226,190,.45),transparent 60%),radial-gradient(800px 700px at 0% 100%,rgba(206,232,226,.5),transparent 60%)!important;background-attachment:fixed!important}
html.glas .shell .mainc,html.glas main{background:transparent!important}
/* Glasflächen */
html.glas .card,html.glas .panel,html.glas .kpi,html.glas .bs-kpi,html.glas .tile,html.glas .flash,html.glas details.box,html.glas dialog,html.glas .vw-grid a,html.glas .vw-stats .vs,html.glas body.mshell .shift,html.glas .qm-audit{background:var(--g-fill)!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);border:0!important;box-shadow:var(--g-rim),var(--g-ring),var(--g-drop)!important;border-radius:26px!important}
html.glas .vw-grid .vi{background:rgba(125,20,53,.10)!important}
html.glas .card .card,html.glas .panel .card,html.glas .card .kpi{background:rgba(255,255,255,.45)!important;box-shadow:var(--g-rim),var(--g-ring)!important;border-radius:18px!important}
html.glas .drop,html.glas .cbx-pop,html.glas .menu-top .appside nav.menu .sub{background:rgba(250,250,252,.78)!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);border:0!important;border-radius:18px!important;box-shadow:var(--g-rim),var(--g-ring),0 18px 48px -12px rgba(0,0,0,.25)!important;padding:6px!important}
html.glas .menu-top .appside nav.menu .sub a{border-radius:10px;color:#1d1d1f}
html.glas .menu-top .appside nav.menu .sub a:hover,html.glas .menu-top .appside nav.menu .sub a.on{background:rgba(125,20,53,.10)!important;color:#7d1435!important;box-shadow:none!important}
/* Kopfzeile: ohne Fläche, nur Glas beim Scrollen darunter */
html.glas .shell .top,html.glas .menu-top .top{position:sticky;top:0;z-index:61;background:rgba(246,247,250,.55)!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);border-bottom:0!important;box-shadow:0 .5px 0 rgba(0,0,0,.08)!important}
html.glas .search{background:rgba(118,118,128,.12)!important;border:0!important;border-radius:999px!important;box-shadow:none!important}
html.glas .search input{background:transparent!important;border:0!important;box-shadow:none!important}
html.glas .search kbd{background:rgba(255,255,255,.7);border:0;box-shadow:var(--g-ring)}
/* Menü oben: helle Glas-Kapsel, aktiver Punkt als Bordeaux-getönte Pille */
html.glas .menu-top .appside{top:72px!important;margin:10px auto 0;width:max-content!important;max-width:calc(100% - 32px);border-radius:999px;padding:5px!important;background:var(--g-fill)!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);border:0;box-shadow:var(--g-rim),var(--g-ring),var(--g-drop)!important;--side-ink:#1d1d1f;--side-mut:#6e6e73;--side-2:rgba(0,0,0,.05)}
html.glas .menu-top .appside nav.menu{padding:0!important;gap:0;flex-wrap:nowrap!important}
html.glas .menu-top .appside nav.menu a.item,html.glas .menu-top .appside nav.menu .grp>summary{min-height:38px!important;border-radius:999px!important;color:#1d1d1f!important;padding:0 9px!important;font-size:13px!important;box-shadow:none!important}
html.glas .menu-top .appside nav.menu a.item:hover,html.glas .menu-top .appside nav.menu .grp>summary:hover{background:rgba(0,0,0,.05)!important}
html.glas .menu-top .appside nav.menu a.item.on,html.glas .menu-top .appside nav.menu .grp.on>summary{background:var(--g-tint)!important;color:#fff!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 4px 12px -4px rgba(125,20,53,.55)!important}
html.glas .menu-top .appside .ic{color:inherit!important}
html.glas body.shell:not(.menu-top) .appside{background:linear-gradient(180deg,rgba(130,21,56,.86),rgba(100,14,42,.9))!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur)}
/* Knöpfe: Hauptaktion = getöntes Glas, sonst klares Glas */
html.glas .btn,html.glas button.btn{border-radius:999px!important;border:0!important;background:var(--g-tint)!important;color:#fff!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);box-shadow:inset 0 1px 0 rgba(255,255,255,.4),inset 0 -1px 0 rgba(0,0,0,.12),0 6px 16px -6px rgba(125,20,53,.5)!important;font-weight:600}
html.glas .btn:active{transform:scale(.97)}
html.glas .btn.secondary,html.glas .btn.ghost,html.glas .btn.sec,html.glas a.btn.light,html.glas .btn.outline,html.glas .btn.subtle{background:var(--g-fill)!important;color:#1d1d1f!important;box-shadow:var(--g-rim),var(--g-ring),0 4px 12px -6px rgba(0,0,0,.18)!important}
html.glas .btn.danger{background:rgba(215,0,21,.85)!important}
/* Felder wie iOS: grau gefüllt, keine Linie */
html.glas input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]),html.glas select,html.glas textarea{background:rgba(118,118,128,.10)!important;border:0!important;border-radius:12px!important;box-shadow:none!important}
html.glas input:focus,html.glas select:focus,html.glas textarea:focus{background:rgba(255,255,255,.85)!important;box-shadow:0 0 0 3.5px rgba(125,20,53,.22)!important;outline:0}
html.glas input[type=checkbox],html.glas input[type=radio]{accent-color:#7d1435}
/* Tabellen */
html.glas table,html.glas .tbl{background:transparent!important}
html.glas .tbl thead th,html.glas table thead th,html.glas .info-col .panel-head,html.glas .svc-head,html.glas .empty,html.glas .empty-line{background:transparent!important;color:#6e6e73!important;border-color:rgba(0,0,0,.06)!important}
html.glas .empty,html.glas .empty-line{background:rgba(118,118,128,.07)!important;border:0!important;border-radius:14px}
html.glas table td,html.glas table th{border-color:rgba(0,0,0,.06)!important}
html.glas table tbody tr:hover td{background:rgba(255,255,255,.4)}
/* Reiter als Segment-Steuerung */
html.glas .tabs,html.glas .ls-tabs{background:rgba(118,118,128,.12);border:0!important;border-radius:999px;padding:3px!important;gap:2px;width:max-content;max-width:100%}
html.glas .tabs a,html.glas .ls-tabs a{border:0!important;border-radius:999px!important;padding:6px 14px!important;color:#1d1d1f!important;box-shadow:none!important}
html.glas .tabs a.on,html.glas .ls-tabs a.on,html.glas .tabs a[aria-current]{background:#fff!important;box-shadow:0 3px 8px rgba(0,0,0,.12),0 0 0 .5px rgba(0,0,0,.04)!important;color:#1d1d1f!important;font-weight:600}
/* App-Rahmen und Handy-Apps */
html.glas .appmode .apphead,html.glas body.mshell>header,html.glas body>header{background:rgba(246,247,250,.55)!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);border-bottom:0!important;box-shadow:0 .5px 0 rgba(0,0,0,.08)!important}
html.glas .apptabs,html.glas .tabbar{margin:0 16px calc(8px + env(safe-area-inset-bottom));padding:4px!important;border-radius:999px;background:var(--g-fill)!important;-webkit-backdrop-filter:saturate(200%) blur(28px);backdrop-filter:saturate(200%) blur(28px);border:0!important;box-shadow:var(--g-rim),var(--g-ring),0 16px 40px -10px rgba(0,0,0,.28)!important}
html.glas .apptabs a,html.glas .tabbar a{border-radius:999px;padding:6px 2px 7px!important;color:#1d1d1f}
html.glas .apptabs a.on,html.glas .tabbar a.on{background:rgba(125,20,53,.12);color:#7d1435}
html.glas .apptabs a.on i,html.glas .tabbar a.on i{background:transparent!important;box-shadow:none}
@media (prefers-reduced-transparency:reduce){html.glas .card,html.glas .panel,html.glas .kpi,html.glas .shell .top,html.glas .menu-top .appside,html.glas .apptabs,html.glas .tabbar{background:rgba(255,255,255,.96)!important;-webkit-backdrop-filter:none;backdrop-filter:none}}
@media print{html.glas body{background:#fff!important}html.glas .card,html.glas .panel{background:#fff!important;box-shadow:none!important;backdrop-filter:none!important}}
`;
