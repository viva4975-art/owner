// Gestaltung „Glas“ (Ahmed 07.11.: „Liquid Glass wie beim iPhone“). Seit 07.11. Standard für alle; aus nur mit
// Cookie vd_design=standard (Mein Konto → Darstellung). Klasse `glas` am <html>. Wirkt am PC (Layout), im App-Rahmen, in /m und /qm.
// Alles ist auf `html.glas` beschränkt – ohne die Klasse ändert sich nichts.

/** Farbe (Hex ohne #) und Durchsichtigkeit (0 = ganz klar … 100 = milchig) je Browser, Cookie vd_glas="c=7d1435&t=60". */
export const GLASS_DEFAULT = { color: '811d40', tint: 0 } as const;

/** Farbvorschläge (Bordeaux = Hausfarbe). */
export const GLASS_PRESETS = [
  { c: '811d40', label: 'Bordeaux' },
  { c: '8b2332', label: 'Bordeaux hell' },
  { c: '64152f', label: 'Bordeaux dunkel' },
  { c: '1d1d1f', label: 'Graphit' },
  { c: '0071e3', label: 'Blau' },
  { c: '1f7a5a', label: 'Grün' },
  { c: 'a0612b', label: 'Bronze' },
] as const;

/** Glas-Werte aus Farbe/Stufe – dieselbe Rechnung im Kopf-Skript und in der Live-Vorschau (/konto/darstellung). */
export const GLASS_APPLY_JS = `function vdGlasApply(c,t){var r=document.documentElement.style;t=Math.max(0,Math.min(100,+t||0))/100;if(/^[0-9a-f]{6}$/i.test(c))r.setProperty('--g-acc','#'+c);r.setProperty('--g-a1',(.32+.66*t).toFixed(3));r.setProperty('--g-a2',(.1+.6*t).toFixed(3));r.setProperty('--g-bl',Math.round(14+16*t)+'px')}`;

/** Setzt Klasse und Werte vor dem ersten Zeichnen (kein Aufblitzen der alten Gestaltung). */
export const GLASS_HEAD_JS = `(function(){try{var k=document.cookie;if(/(?:^|; )vd_design=standard(?:;|$)/.test(k))return;document.documentElement.classList.add('glas');var de=document.documentElement,sc=function(){de.classList.toggle('scrolled',(window.scrollY||0)>6)};addEventListener('scroll',sc,{passive:true});sc();var m=/(?:^|; )vd_glas=([^;]*)/.exec(k);var q=m?decodeURIComponent(m[1]):'',c=/c=([0-9a-fA-F]{6})/.exec(q),t=/t=(\\d{1,3})/.exec(q);${GLASS_APPLY_JS};vdGlasApply(c?c[1]:'${GLASS_DEFAULT.color}',t?t[1]:${GLASS_DEFAULT.tint})}catch(e){}})();`;

export const GLASS_CSS = `
/* Fassung 2 (Ahmed 07.11.: „wie auf Apple“): hell und klar wie iOS/macOS 26 – Systemschrift, neutrales Glas mit
   Lichtkante, schwebende Glas-Kapseln für Menü und Leiste, Farbe (Bordeaux) nur als Tönung aktiver Elemente. */
html.glas{--g-acc:#7d1435;--g-a1:.32;--g-a2:.1;--g-fill:linear-gradient(135deg,rgba(255,255,255,var(--g-a1)),rgba(255,255,255,var(--g-a2)));--g-fill-2:rgba(255,255,255,.5);--g-rim:inset 0 1px 0 rgba(255,255,255,.95),inset 0 -1px 0 rgba(255,255,255,.35),inset 1px 0 0 rgba(255,255,255,.45),inset -1px 0 0 rgba(255,255,255,.45);--g-ring:0 0 0 .5px rgba(0,0,0,.08);--g-drop:0 8px 32px -8px rgba(0,0,0,.14),0 2px 6px rgba(0,0,0,.04);--g-bl:14px;--g-blur:saturate(190%) blur(var(--g-bl)) brightness(1.04);--g-tint:color-mix(in srgb,var(--g-acc) 88%,transparent);--ink:#1d1d1f;--mut:#6e6e73}
html.glas body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display",Inter,"Helvetica Neue",Arial,sans-serif!important;-webkit-font-smoothing:antialiased;color:#1d1d1f;letter-spacing:-.01em}
html.glas h1,html.glas h2,html.glas h3{letter-spacing:-.022em}
html.glas .faint{color:#86868b!important}html.glas .mut,html.glas .muted{color:#6e6e73}
/* Logo ohne weißen Kasten (transparent), wie in den Apps */
html.glas .top .logo img,html.glas .top-logo img{content:url(/static/logo-transparent.png)}
/* Hintergrund: hell, wie ein iOS-Hintergrundbild mit sanften Farben */
html.glas body,html.glas body.shell,html.glas body.appmode,html.glas body.mshell,html.glas body.bare{background-color:#f6f4f6!important;background-image:radial-gradient(1100px 700px at 0% 0%,color-mix(in srgb,var(--g-acc) 15%,rgba(255,255,255,.5)),transparent 60%),radial-gradient(900px 700px at 100% 0%,color-mix(in srgb,var(--g-acc) 6%,rgba(240,238,246,.6)),transparent 60%),radial-gradient(1000px 800px at 85% 100%,color-mix(in srgb,var(--g-acc) 8%,rgba(255,255,255,.6)),transparent 60%),radial-gradient(800px 700px at 0% 100%,color-mix(in srgb,var(--g-acc) 5%,rgba(244,242,246,.6)),transparent 60%)!important;background-attachment:fixed!important}
html.glas .shell .mainc,html.glas main{background:transparent!important}
/* Glasflächen */
html.glas .card,html.glas .panel,html.glas .kpi,html.glas .bs-kpi,html.glas .tile,html.glas .flash,html.glas details.box,html.glas dialog,html.glas .vw-grid a,html.glas .vw-stats .vs,html.glas body.mshell .shift,html.glas .qm-audit{background:var(--g-fill)!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);border:0!important;box-shadow:var(--g-rim),var(--g-ring),var(--g-drop)!important;border-radius:26px!important}
html.glas .vw-grid .vi{background:color-mix(in srgb,var(--g-acc) 10%,transparent)!important}
html.glas .card .card,html.glas .panel .card,html.glas .card .kpi{background:rgba(255,255,255,.45)!important;box-shadow:var(--g-rim),var(--g-ring)!important;border-radius:18px!important}
html.glas .drop,html.glas .cbx-pop,html.glas .menu-top .appside nav.menu .sub{background:rgba(250,250,252,.78)!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);border:0!important;border-radius:18px!important;box-shadow:var(--g-rim),var(--g-ring),0 18px 48px -12px rgba(0,0,0,.25)!important;padding:6px!important}
html.glas .menu-top .appside nav.menu .sub a{border-radius:10px;color:#1d1d1f}
html.glas .menu-top .appside nav.menu .sub a:hover,html.glas .menu-top .appside nav.menu .sub a.on{background:color-mix(in srgb,var(--g-acc) 10%,transparent)!important;color:var(--g-acc)!important;box-shadow:none!important}
/* Kopfzeile: ohne Fläche, nur Glas beim Scrollen darunter */
html.glas .shell .top,html.glas .menu-top .top{position:sticky;top:0;z-index:61;background:rgba(246,247,250,.55)!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);border-bottom:0!important;box-shadow:0 .5px 0 rgba(0,0,0,.08)!important}
html.glas .search{background:rgba(118,118,128,.12)!important;border:0!important;border-radius:999px!important;box-shadow:none!important}
html.glas .search input{background:transparent!important;border:0!important;box-shadow:none!important}
html.glas .search kbd{background:rgba(255,255,255,.7);border:0;box-shadow:var(--g-ring)}
/* Menü oben: helle Glas-Kapsel, aktiver Punkt als Bordeaux-getönte Pille */
@media (min-width:1025px){
html.glas .menu-top .appside{top:72px!important;margin:10px auto 0;width:max-content!important;max-width:calc(100% - 32px);border-radius:999px;padding:5px!important;background:var(--g-fill)!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);border:0;box-shadow:var(--g-rim),var(--g-ring),var(--g-drop)!important;--side-ink:#1d1d1f;--side-mut:#6e6e73;--side-2:rgba(0,0,0,.05)}
html.glas .menu-top .appside nav.menu{padding:0!important;gap:0;flex-wrap:nowrap!important}
html.glas .menu-top .appside nav.menu a.item,html.glas .menu-top .appside nav.menu .grp>summary{min-height:38px!important;border-radius:999px!important;color:#1d1d1f!important;padding:0 9px!important;font-size:13px!important;box-shadow:none!important}
html.glas .menu-top .appside nav.menu a.item:hover,html.glas .menu-top .appside nav.menu .grp>summary:hover{background:rgba(0,0,0,.05)!important}
html.glas .menu-top .appside nav.menu a.item.on,html.glas .menu-top .appside nav.menu .grp.on>summary{background:var(--g-tint)!important;color:#fff!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 4px 12px -4px color-mix(in srgb,var(--g-acc) 55%,transparent)!important}
html.glas .menu-top .appside .ic{color:inherit!important}
}
/* Handy/Tablet: Menü als Glas-Schublade (nicht als Kapsel – Ahmed 07.11., Bild „Menü als Riesen-Pille“) */
@media (max-width:1024px){html.glas body.menu-top .appside{background:rgba(250,250,252,.82)!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);border-radius:0 24px 24px 0!important;border:0!important;box-shadow:var(--g-rim),0 24px 60px -12px rgba(0,0,0,.35)!important;--side-ink:#1d1d1f;--side-mut:#6e6e73;--side-2:rgba(0,0,0,.05)}
html.glas body.menu-top .appside nav.menu a.item,html.glas body.menu-top .appside nav.menu .grp>summary{border-radius:14px!important;color:#1d1d1f!important}
html.glas body.menu-top .appside nav.menu a.item.on,html.glas body.menu-top .appside nav.menu .grp.on>summary{background:var(--g-tint)!important;color:#fff!important}
html.glas body.menu-top .appside .sub a{color:#1d1d1f!important;border-radius:10px}html.glas body.menu-top .appside .sub a.on{background:color-mix(in srgb,var(--g-acc) 12%,transparent)!important;color:var(--g-acc)!important}
html.glas body.menu-top .appside .side-logo img{content:url(/static/logo-transparent.png)}
html.glas body.menu-top .scrim{background:rgba(20,16,20,.22)!important;-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}}
html.glas body.shell:not(.menu-top) .appside{background:linear-gradient(180deg,rgba(130,21,56,.86),rgba(100,14,42,.9))!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur)}
/* Knöpfe: Hauptaktion = getöntes Glas, sonst klares Glas */
html.glas .btn,html.glas button.btn{border-radius:999px!important;border:0!important;background:var(--g-tint)!important;color:#fff!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);box-shadow:inset 0 1px 0 rgba(255,255,255,.4),inset 0 -1px 0 rgba(0,0,0,.12),0 6px 16px -6px color-mix(in srgb,var(--g-acc) 50%,transparent)!important;font-weight:600}
html.glas .btn:active{transform:scale(.97)}
html.glas .btn.secondary,html.glas .btn.ghost,html.glas .btn.sec,html.glas a.btn.light,html.glas .btn.outline,html.glas .btn.subtle{background:var(--g-fill)!important;color:#1d1d1f!important;box-shadow:var(--g-rim),var(--g-ring),0 4px 12px -6px rgba(0,0,0,.18)!important}
html.glas .btn.danger{background:rgba(215,0,21,.85)!important}
/* Felder wie iOS: grau gefüllt, keine Linie */
html.glas input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]),html.glas select,html.glas textarea{background:rgba(118,118,128,.10)!important;border:0!important;border-radius:12px!important;box-shadow:none!important}
html.glas input:focus,html.glas select:focus,html.glas textarea:focus{background:rgba(255,255,255,.85)!important;box-shadow:0 0 0 3.5px color-mix(in srgb,var(--g-acc) 22%,transparent)!important;outline:0}
html.glas input[type=checkbox],html.glas input[type=radio],html.glas input[type=range]{accent-color:var(--g-acc)}
/* Tabellen */
html.glas table,html.glas .tbl{background:transparent!important}
html.glas .tbl thead th,html.glas table thead th,html.glas .info-col .panel-head,html.glas .svc-head,html.glas .empty,html.glas .empty-line{background:transparent!important;color:#6e6e73!important;border-color:rgba(0,0,0,.06)!important}
html.glas .empty,html.glas .empty-line{background:rgba(118,118,128,.07)!important;border:0!important;border-radius:14px}
html.glas table td,html.glas table th{border-color:rgba(0,0,0,.06)!important}
html.glas table tbody tr:hover td{background:rgba(255,255,255,.4)}
/* Reiter als Segment-Steuerung */
html.glas .tabs,html.glas .ls-tabs{background:rgba(118,118,128,.12);border:0!important;border-radius:22px;padding:3px!important;gap:2px;width:max-content;max-width:100%}
html.glas .tabs a,html.glas .ls-tabs a{border:0!important;border-radius:999px!important;padding:6px 14px!important;color:#1d1d1f!important;box-shadow:none!important}
html.glas .tabs .badge,html.glas .tabs .cnt{background:rgba(255,255,255,.7)!important}
html.glas .tabs a.on,html.glas .ls-tabs a.on,html.glas .tabs a[aria-current]{background:#fff!important;box-shadow:0 3px 8px rgba(0,0,0,.12),0 0 0 .5px rgba(0,0,0,.04)!important;color:#1d1d1f!important;font-weight:600}
/* Aktionsblock rechts (Angebot, Rechnung, Arbeitsschein …): helle Glas-Karte mit Zeilen, erste Aktion getönt */
html.glas .actstack{background:var(--g-fill)!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);border-radius:22px!important;padding:6px;gap:3px;box-shadow:var(--g-rim),var(--g-ring),var(--g-drop)!important}
html.glas .actstack.actstack>:is(a,button),html.glas .actstack.actstack>form>button,html.glas .actstack.actstack>details>summary{background:transparent!important;color:#1d1d1f!important;border:0!important;border-radius:14px!important;box-shadow:none!important;-webkit-backdrop-filter:none;backdrop-filter:none;min-height:44px;font-weight:600}
html.glas .actstack.actstack>:is(a,button):hover,html.glas .actstack.actstack>form>button:hover,html.glas .actstack.actstack>details>summary:hover{background:rgba(0,0,0,.05)!important;color:#1d1d1f!important}
html.glas .actstack.actstack>:first-child:is(a,button),html.glas .actstack.actstack>form:first-child>button{background:var(--g-tint)!important;color:#fff!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 6px 16px -6px color-mix(in srgb,var(--g-acc) 50%,transparent)!important}
html.glas .actstack.actstack>:not(:first-child):not(:last-child):is(a,button,form,details){box-shadow:0 .5px 0 rgba(0,0,0,.08)!important}
html.glas .actstack.actstack :is(a,button,summary) .ic{color:inherit!important}
html.glas .actstack.actstack>:is(.del,.ghost,.quiet),html.glas .actstack.actstack>form>button:is(.del,.ghost,.quiet){color:#6e6e73!important;font-weight:500}
html.glas .actstack.actstack>:is(.del,.danger),html.glas .actstack.actstack>form>button:is(.del,.danger){color:#c4001a!important}
html.glas .actstack>details>:not(summary){background:rgba(255,255,255,.6)!important;border-radius:14px!important}
/* Planungstafel: Kopf „Zu planende Einsätze“ hell statt Bordeaux-Balken, Tafel als Glas */
html.glas .pb-sec{background:var(--g-fill)!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);border:0!important;border-radius:22px!important;box-shadow:var(--g-rim),var(--g-ring),var(--g-drop)!important}
html.glas .pb-bar,html.glas .pb-bar.light{background:transparent!important;color:#1d1d1f!important;border-bottom:.5px solid rgba(0,0,0,.08)!important}
html.glas .pb-bar:not(.light) b{color:var(--g-acc)}
/* Umschalter (Tag/Woche/Monat, Kalender/Liste, ← →) als Segment-Steuerung wie iOS */
html.glas .seg{background:rgba(118,118,128,.12)!important;border:0!important;border-radius:12px!important;padding:3px;gap:2px;overflow:visible}
html.glas .seg>a,html.glas .seg>label>span{border:0!important;border-radius:9px;background:transparent;color:#1d1d1f;padding:6px 12px}
html.glas .seg>a:hover{background:rgba(255,255,255,.5)}
html.glas .seg>a.on,html.glas .seg>label>input:checked+span{background:#fff!important;box-shadow:0 3px 8px rgba(0,0,0,.12),0 0 0 .5px rgba(0,0,0,.04)!important;color:#1d1d1f!important;border-bottom:0!important}
html.glas .rng{background:rgba(255,255,255,.6);border:0!important;border-radius:12px;box-shadow:var(--g-ring)}
/* App-Rahmen und Handy-Apps */
html.glas .appmode .apphead,html.glas body.mshell>header,html.glas body>header{background:rgba(246,247,250,.55)!important;-webkit-backdrop-filter:var(--g-blur);backdrop-filter:var(--g-blur);border-bottom:0!important;box-shadow:0 .5px 0 rgba(0,0,0,.08)!important}
html.glas .apptabs,html.glas .tabbar{margin:0 16px calc(8px + env(safe-area-inset-bottom));padding:4px!important;border-radius:999px;background:var(--g-fill)!important;-webkit-backdrop-filter:saturate(200%) blur(28px);backdrop-filter:saturate(200%) blur(28px);border:0!important;box-shadow:var(--g-rim),var(--g-ring),0 16px 40px -10px rgba(0,0,0,.28)!important}
html.glas .apptabs a,html.glas .tabbar a{border-radius:999px;padding:6px 2px 7px!important;color:#1d1d1f}
html.glas .apptabs a.on,html.glas .tabbar a.on{background:color-mix(in srgb,var(--g-acc) 12%,transparent);color:var(--g-acc)}
html.glas .apptabs a.on i,html.glas .tabbar a.on i{background:transparent!important;box-shadow:none}
/* Fassung 3 „ruhig“ (Ahmed 07.11.: weniger Farbverläufe, neutraler Hintergrund, Bordeaux gezielt, größere klare Schrift
   Inter, hochwertigere Infokarten mit weniger Effekten). Steht zuletzt und gilt vor den Glas-Regeln oben. */
html.glas{--ink:#1c1a1d;--mut:#666069;--line-c:#e6e3e7}
html.glas body{font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif!important;font-size:15px;line-height:1.55;letter-spacing:-.006em;color:var(--ink)}
html.glas h1{font-size:26px;font-weight:700;letter-spacing:-.02em}html.glas h2{font-size:19px;font-weight:650}html.glas h3{font-size:16px;font-weight:650}
html.glas .faint{color:#7c7680!important}html.glas .mut,html.glas .muted{color:var(--mut)}
html.glas body,html.glas body.shell,html.glas body.appmode,html.glas body.mshell,html.glas body.bare{background:#f6f6f7!important;background-image:none!important}
html.glas .card,html.glas .panel,html.glas .kpi,html.glas .bs-kpi,html.glas .tile,html.glas details.box,html.glas dialog,html.glas .vw-grid a,html.glas .vw-stats .vs,html.glas body.mshell .shift,html.glas .qm-audit,html.glas .pb-sec,html.glas .actstack{background:#fff!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;border:1px solid var(--line-c)!important;box-shadow:0 1px 2px rgba(20,10,15,.04)!important;border-radius:14px!important}
html.glas .flash{-webkit-backdrop-filter:none!important;backdrop-filter:none!important;box-shadow:none!important;border-radius:12px!important}
html.glas .card .card,html.glas .panel .card,html.glas .card .kpi{background:#fafafa!important;box-shadow:none!important;border:1px solid var(--line-c)!important;border-radius:12px!important}
html.glas .drop,html.glas .cbx-pop,html.glas .menu-top .appside nav.menu .sub{background:#fff!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;border:1px solid var(--line-c)!important;border-radius:12px!important;box-shadow:0 12px 32px -10px rgba(20,10,15,.18)!important}
html.glas .menu-top .appside nav.menu .sub a{font-size:14.5px;padding:8px 12px}
html.glas .menu-top .appside nav.menu .sub a:hover,html.glas .menu-top .appside nav.menu .sub a.on{background:#f7edf1!important;color:var(--g-acc)!important}
html.glas .shell .top,html.glas .menu-top .top{background:#fff!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;box-shadow:0 1px 0 var(--line-c)!important}
html.glas .search{background:#f3f2f4!important}
@media (min-width:1025px){
html.glas .menu-top .appside{position:sticky!important;top:64px!important;margin:0!important;width:auto!important;max-width:none!important;border-radius:0!important;padding:0 24px!important;background:#fff!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;box-shadow:0 1px 0 var(--line-c)!important}
html.glas .menu-top .appside nav.menu{justify-content:flex-start;gap:4px}
html.glas .menu-top .appside nav.menu a.item,html.glas .menu-top .appside nav.menu .grp>summary{min-height:48px!important;border-radius:0!important;padding:0 14px!important;font-size:15px!important;font-weight:550;color:#3b363d!important;background:transparent!important;box-shadow:inset 0 -2px 0 transparent!important}
html.glas .menu-top .appside nav.menu a.item:hover,html.glas .menu-top .appside nav.menu .grp>summary:hover{background:transparent!important;color:var(--g-acc)!important}
html.glas .menu-top .appside nav.menu a.item.on,html.glas .menu-top .appside nav.menu .grp.on>summary{background:transparent!important;color:var(--g-acc)!important;font-weight:650;box-shadow:inset 0 -3px 0 var(--g-acc)!important}
}
@media (max-width:1024px){html.glas body.menu-top .appside{background:#fff!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
html.glas body.menu-top .appside nav.menu a.item.on,html.glas body.menu-top .appside nav.menu .grp.on>summary{background:#f7edf1!important;color:var(--g-acc)!important}}
html.glas .btn,html.glas button.btn{border-radius:10px!important;background:var(--g-acc)!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;box-shadow:none!important;font-weight:600}
html.glas .btn:hover{filter:brightness(1.08)}
html.glas .btn.secondary,html.glas .btn.ghost,html.glas .btn.sec,html.glas a.btn.light,html.glas .btn.outline,html.glas .btn.subtle{background:#fff!important;color:var(--ink)!important;border:1px solid #d9d5da!important;box-shadow:none!important;filter:none}
html.glas .btn.ghost{border-color:transparent!important;color:var(--mut)!important}
html.glas .btn.danger{background:#b4142a!important}
html.glas input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]),html.glas select,html.glas textarea{background:#fff!important;border:1px solid #d9d5da!important;border-radius:10px!important;font-size:15px}
html.glas input:focus,html.glas select:focus,html.glas textarea:focus{border-color:var(--g-acc)!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--g-acc) 15%,transparent)!important}
html.glas table td{font-size:14.5px}
html.glas .tbl thead th,html.glas table thead th{font-size:13px!important;font-weight:600!important;color:var(--mut)!important}
html.glas .tabs,html.glas .ls-tabs{background:transparent!important;border-radius:0!important;padding:0!important;gap:4px;border-bottom:1px solid var(--line-c)!important;width:auto}
html.glas .tabs a,html.glas .ls-tabs a{border-radius:0!important;padding:10px 12px!important;font-size:15px!important;color:var(--mut)!important;background:transparent!important}
html.glas .tabs a:hover,html.glas .ls-tabs a:hover{color:var(--ink)!important}
html.glas .tabs a.on,html.glas .ls-tabs a.on,html.glas .tabs a[aria-current]{background:transparent!important;color:var(--g-acc)!important;font-weight:650;box-shadow:inset 0 -2px 0 var(--g-acc)!important}
html.glas .tabs .badge,html.glas .tabs .cnt{background:#f0eef1!important;color:var(--mut)}
html.glas .seg{background:#f0eef1!important}
html.glas .actstack{padding:6px}
html.glas .actstack.actstack>:first-child:is(a,button),html.glas .actstack.actstack>form:first-child>button{background:var(--g-acc)!important;box-shadow:none!important}
html.glas .pb-bar,html.glas .pb-bar.light{border-bottom:1px solid var(--line-c)!important}
html.glas .appmode .apphead,html.glas body.mshell>header,html.glas body>header{background:#fff!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;box-shadow:0 1px 0 var(--line-c)!important}
html.glas .apptabs,html.glas .tabbar{background:rgba(255,255,255,.96)!important;border:1px solid var(--line-c)!important;box-shadow:0 8px 24px -10px rgba(20,10,15,.2)!important}
/* Infokarten links (Objekt): Kopfzeile mit Nummer + Status, Name groß, Angaben untereinander, Aktionen unten */
html.glas .info-col>.panel{margin-bottom:16px}
html.glas .info-col .sc{padding:18px 0 0!important}
html.glas .info-col .sc>*{margin-left:18px!important;margin-right:18px!important}
.sc-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.sc-cap{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#7c7680}
.sc-title{display:block;font-size:17px;font-weight:650;line-height:1.35;letter-spacing:-.01em}
.sc-title a{color:inherit}.sc-title a:hover{color:var(--g-acc,#7d1435)}
.sc-addr{color:#666069;margin-top:4px;line-height:1.5}
.sc-kv{margin:14px 0 0;padding:0;border-top:1px solid #eeecef}
.sc-kv>div{padding:10px 0;border-bottom:1px solid #eeecef}.sc-kv>div:last-child{border-bottom:0}
.sc-kv dt{font-size:12.5px;color:#7c7680;margin:0}.sc-kv dd{margin:2px 0 0;font-weight:500}
html.glas .info-col .sc>.sc-foot,.info-col .sc>.sc-foot{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0!important;padding:12px 18px 14px;border-top:1px solid #eeecef;background:#fafafa;border-radius:0 0 14px 14px}
.info-col .sc>:last-child:not(.sc-foot){margin-bottom:18px!important}
.sc-foot form{margin:0}
html.glas .tag{border-radius:999px;font-weight:600}
@media (max-width:1024px){html.glas body.menu-top .burger-cb:not(:checked)~.appside{box-shadow:none!important}}
/* Fassung 4 „Apple Business“ (Ahmed 07.11., Vorgabe mit Palette): 85–90 % ruhige neutrale Fläche, Bordeaux #811D40 nur als
   Akzent, dezentes Liquid Glass nur für Kopfzeile, Menüleiste, Suche, Klappmenüs, Popover und Dialoge – nie hinter Tabellen.
   Karten weiß, Radius 16, Knöpfe Radius 10, Übergänge 160 ms, Fokus deutlich sichtbar. Steht zuletzt. */
html.glas{--g-acc:#811d40;--acc-d:#64152f;--acc-soft:#f7edf1;--ink:#1d1d1f;--mut:#6e6e73;--line-c:#e5e5ea;
  --lg-bg:rgba(255,255,255,.78);--lg-blur:blur(18px) saturate(150%);--lg-line:rgba(255,255,255,.65);
  --lg-shadow:0 4px 24px rgba(20,20,30,.045),inset 0 1px 0 rgba(255,255,255,.65);
  --card-shadow:0 1px 2px rgba(20,20,30,.04),0 1px 0 rgba(20,20,30,.02)}
html.glas body,html.glas body.shell,html.glas body.appmode,html.glas body.mshell,html.glas body.bare{background:#f8f9fa!important;background-image:none!important;color:var(--ink)}
html.glas .faint{color:#86868b!important}
/* Liquid Glass: Kopfzeile + Menüleiste (schweben über dem Inhalt) */
html.glas .shell .top,html.glas .menu-top .top{background:var(--lg-bg)!important;-webkit-backdrop-filter:var(--lg-blur)!important;backdrop-filter:var(--lg-blur)!important;box-shadow:0 1px 0 rgba(229,229,234,.9)!important;border-bottom:0!important}
@media (min-width:1025px){
html.glas .menu-top .appside{background:var(--lg-bg)!important;-webkit-backdrop-filter:var(--lg-blur)!important;backdrop-filter:var(--lg-blur)!important;box-shadow:0 1px 0 rgba(229,229,234,.9),0 4px 24px rgba(20,20,30,.03)!important}
html.glas .menu-top .appside nav.menu a.item,html.glas .menu-top .appside nav.menu .grp>summary{color:#3a3a3c!important;transition:color .16s ease,box-shadow .16s ease}
html.glas .menu-top .appside nav.menu a.item.on,html.glas .menu-top .appside nav.menu .grp.on>summary{color:var(--g-acc)!important;box-shadow:inset 0 -2.5px 0 var(--g-acc)!important}
}
/* Liquid Glass: Suche, Suchvorschläge, Klappmenüs, Popover, Dialoge */
html.glas .search{background:rgba(118,118,128,.1)!important;border:1px solid transparent!important;border-radius:12px!important;transition:background .16s ease,border-color .16s ease,box-shadow .16s ease}
html.glas .search:focus-within{background:#fff!important;border-color:color-mix(in srgb,var(--g-acc) 40%,#e5e5ea)!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--g-acc) 14%,transparent)!important}
html.glas .sdrop,html.glas .drop,html.glas .cbx-pop,html.glas .menu-top .appside nav.menu .sub,html.glas dialog,html.glas .ev-dlg .box,html.glas details.dd>.drop{background:rgba(252,252,253,.8)!important;-webkit-backdrop-filter:blur(26px) saturate(170%)!important;backdrop-filter:blur(26px) saturate(170%)!important;border:1px solid var(--lg-line)!important;outline:1px solid rgba(229,229,234,.7);outline-offset:-1px;border-radius:14px!important;box-shadow:var(--lg-shadow),0 16px 40px -12px rgba(20,20,30,.16)!important}
html.glas .sdrop a:hover,html.glas .drop a:hover,html.glas .cbx-pop .on,html.glas .cbx-pop [aria-selected=true]{background:var(--acc-soft)!important;color:var(--g-acc)!important}
html.glas dialog::backdrop{background:rgba(20,20,30,.18);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}
/* Karten: weiß, Radius 16, sehr dezente Linie und Schatten – kein Glas */
html.glas .card,html.glas .panel,html.glas .kpi,html.glas .bs-kpi,html.glas .tile,html.glas details.box,html.glas .vw-grid a,html.glas .vw-stats .vs,html.glas body.mshell .shift,html.glas .qm-audit,html.glas .pb-sec,html.glas .actstack{background:#fff!important;border:1px solid var(--line-c)!important;box-shadow:var(--card-shadow)!important;border-radius:16px!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
html.glas .card h2,html.glas .panel h2{font-size:18px;font-weight:650;letter-spacing:-.015em}
html.glas table td,html.glas table th{border-color:#efeff2!important}
html.glas table tbody tr:hover td{background:#fafafb}
/* Knöpfe: primär Bordeaux, sekundär weiß mit Linie; ruhige Übergänge */
html.glas .btn,html.glas button.btn{border-radius:10px!important;background:var(--g-acc)!important;color:#fff!important;border:1px solid transparent!important;transition:background-color .16s ease,box-shadow .16s ease,border-color .16s ease,color .16s ease;filter:none!important}
html.glas .btn:hover{background:var(--acc-d)!important;box-shadow:0 2px 8px -2px color-mix(in srgb,var(--g-acc) 45%,transparent)!important}
html.glas .btn:active{transform:none}
html.glas .btn.secondary,html.glas .btn.ghost,html.glas .btn.sec,html.glas a.btn.light,html.glas .btn.outline,html.glas .btn.subtle{background:#fff!important;color:var(--ink)!important;border:1px solid var(--line-c)!important;box-shadow:0 1px 1px rgba(20,20,30,.03)!important}
html.glas .btn.secondary:hover,html.glas .btn.sec:hover,html.glas a.btn.light:hover,html.glas .btn.outline:hover,html.glas .btn.subtle:hover{background:#f5f5f7!important;border-color:#d8d8de!important}
html.glas .btn.ghost{border-color:transparent!important;background:transparent!important;color:var(--mut)!important}
html.glas .btn.ghost:hover{background:#f2f2f4!important;color:var(--ink)!important}
/* Fokus immer sichtbar (Tastatur) */
html.glas :is(a,button,summary,.btn,input,select,textarea,[tabindex]):focus-visible{outline:2px solid var(--g-acc)!important;outline-offset:2px!important}
html.glas input:focus,html.glas select:focus,html.glas textarea:focus{border-color:var(--g-acc)!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--g-acc) 14%,transparent)!important}
html.glas input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]),html.glas select,html.glas textarea{border-color:#dcdce1!important;transition:border-color .16s ease,box-shadow .16s ease}
/* Reiter: Unterstrich in Bordeaux, leicht */
html.glas .tabs a.on,html.glas .ls-tabs a.on,html.glas .tabs a[aria-current]{box-shadow:inset 0 -2px 0 var(--g-acc)!important;color:var(--g-acc)!important}
html.glas .tabs,html.glas .ls-tabs{border-bottom-color:var(--line-c)!important}
/* Aktive Filter/Chips */
html.glas .chip.on,html.glas .chips a.on,html.glas .pill.on,html.glas .seg>a.on{color:var(--g-acc)!important}
html.glas .chip.on,html.glas .chips a.on,html.glas .pill.on{background:var(--acc-soft)!important;border-color:color-mix(in srgb,var(--g-acc) 30%,#e5e5ea)!important}
/* Status ruhiger: kritische Hinweise klar, aber nicht grell */
html.glas .flash.err,html.glas .warnbox,html.glas .alert{border-radius:12px!important}
/* Infokarten am Objekt: Abstand 20–24 px */
html.glas .info-col .sc{padding:20px 0 0!important}
html.glas .info-col .sc>*{margin-left:20px!important;margin-right:20px!important}
html.glas .info-col .sc>.sc-foot{padding:12px 20px 14px!important;border-radius:0 0 16px 16px!important;background:#fafafb!important}
.sc-cap{color:#86868b}.sc-addr{color:#6e6e73}.sc-kv{border-top-color:#efeff2}.sc-kv>div{border-bottom-color:#efeff2}
/* Ahmed 07.11. Nachtrag: Kopf/Menü oben deckend, beim Scrollen leicht durchsichtig mit feinem Schatten; ausgewählte Karten
   mit 2-px-Bordeaux-Kante; sanftes Hover (180 ms) für Karten und Knöpfe. */
html.glas .shell .top,html.glas .menu-top .top,html.glas .menu-top .appside{transition:background-color .2s ease,box-shadow .2s ease}
html.glas:not(.scrolled) .shell .top,html.glas:not(.scrolled) .menu-top .top{background:rgba(255,255,255,.96)!important}
@media (min-width:1025px){html.glas:not(.scrolled) .menu-top .appside{background:rgba(255,255,255,.96)!important;box-shadow:0 1px 0 rgba(229,229,234,.9)!important}
html.glas.scrolled .menu-top .appside{background:rgba(255,255,255,.7)!important;box-shadow:0 1px 0 rgba(229,229,234,.6),0 8px 24px -12px rgba(20,20,30,.14)!important}}
html.glas.scrolled .shell .top,html.glas.scrolled .menu-top .top{background:rgba(255,255,255,.7)!important}
html.glas.scrolled body:not(.menu-top) .top{box-shadow:0 1px 0 rgba(229,229,234,.6),0 8px 24px -12px rgba(20,20,30,.14)!important}
html.glas .accent:is(.card,.panel,.kpi),html.glas .bs-kpi.on,html.glas .info-col .sc:first-child{box-shadow:inset 0 2px 0 var(--g-acc),var(--card-shadow)!important}
html.glas .card.accent .dash-head h2,html.glas .card.accent h2{color:var(--ink)}
html.glas .accent:is(.card,.panel,.kpi) :is(h2,h3)>.ic,html.glas .accent:is(.card,.panel,.kpi) .dash-head .ic{color:var(--g-acc)}
html.glas .card,html.glas .tile,html.glas .vw-grid a,html.glas .kpi,html.glas .bs-kpi{transition:box-shadow .18s ease,border-color .18s ease,background-color .18s ease}
html.glas .card:hover,html.glas .tile:hover,html.glas .kpi:hover,html.glas .bs-kpi:hover{border-color:#dcdce2!important;box-shadow:0 2px 10px -4px rgba(20,20,30,.1),var(--card-shadow)!important}
html.glas .accent:is(.card,.panel,.kpi):hover,html.glas .bs-kpi.on:hover,html.glas .info-col .sc:first-child:hover{box-shadow:inset 0 2px 0 var(--g-acc),0 2px 10px -4px rgba(20,20,30,.1)!important}
html.glas a.card:hover,html.glas .vw-grid a:hover,html.glas a.tile:hover{background:#fdfcfd!important;border-color:color-mix(in srgb,var(--g-acc) 22%,#e5e5ea)!important}
html.glas .btn,html.glas button.btn,html.glas .tabs a,html.glas .ls-tabs a,html.glas .chip,html.glas .chips a{transition:background-color .18s ease,box-shadow .18s ease,border-color .18s ease,color .18s ease!important}
html.glas table tbody tr td{transition:background-color .15s ease}
/* Einheitlich (Ahmed 07.11.): Radien 16 Karten · 14 Klappmenüs/Popover · 10 Knöpfe/Felder · 8 Einträge in Menüs ·
   999 Schilder/Chips; Schatten 3 Stufen (Karte, Karte-Hover, Schwebend); Hover überall 180 ms. */
html.glas{--r-card:16px;--r-pop:14px;--r-ctl:10px;--r-item:8px;--sh-card:0 1px 2px rgba(20,20,30,.04);--sh-hover:0 2px 10px -4px rgba(20,20,30,.1),0 1px 2px rgba(20,20,30,.04);--sh-float:0 4px 24px rgba(20,20,30,.05),0 16px 40px -12px rgba(20,20,30,.16)}
html.glas :is(.card,.panel,.kpi,.bs-kpi,.tile,details.box,.vw-grid a,.qm-audit,.pb-sec,.actstack){border-radius:var(--r-card)!important}
html.glas .card .card,html.glas .panel .card,html.glas .card .kpi{border-radius:12px!important}
html.glas :is(.sdrop,.drop,.cbx-pop,dialog,details.dd>.drop),html.glas .menu-top .appside nav.menu .sub{border-radius:var(--r-pop)!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.7),var(--sh-float)!important;background:rgba(252,252,253,.88)!important;-webkit-backdrop-filter:blur(26px) saturate(170%)!important;backdrop-filter:blur(26px) saturate(170%)!important}
html.glas :is(.sdrop,.drop,.cbx-pop,details.dd>.drop) :is(a,button,li,.opt),html.glas .menu-top .appside nav.menu .sub a{border-radius:var(--r-item)!important;transition:background-color .18s ease,color .18s ease}
html.glas :is(.btn,button.btn,select,textarea,.search){border-radius:var(--r-ctl)!important}
html.glas input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]){border-radius:var(--r-ctl)!important}
html.glas .btn.sm{border-radius:8px!important}
html.glas :is(.tag,.badge,.chip,.pill,.cnt){border-radius:999px!important}
html.glas :is(.card,.panel,.kpi,.tile):hover{box-shadow:var(--sh-hover)!important}
html.glas .accent:is(.card,.panel,.kpi):hover,html.glas .bs-kpi.on:hover,html.glas .info-col .sc:first-child:hover{box-shadow:inset 0 2px 0 var(--g-acc),var(--sh-hover)!important}
html.glas .accent:is(.card,.panel,.kpi),html.glas .bs-kpi.on,html.glas .info-col .sc:first-child{box-shadow:inset 0 2px 0 var(--g-acc),var(--sh-card)!important}
/* Menü: aktive Seite = Unterstrich; nur geöffnet = Bordeaux-Text + Pfeil gedreht, ohne Unterstrich */
@media (min-width:1025px){
html.glas .menu-top .appside nav.menu .grp>summary .ic:last-child{transition:transform .18s ease,color .18s ease}
html.glas .menu-top .appside nav.menu .grp[open]>summary .ic:last-child{transform:rotate(180deg);color:var(--g-acc)}
html.glas .menu-top .appside nav.menu .grp[open]:not(.on)>summary{color:var(--g-acc)!important;box-shadow:none!important;background:transparent!important}
html.glas .menu-top .appside nav.menu .grp.on[open]>summary{box-shadow:inset 0 -2.5px 0 var(--g-acc)!important}
}
html.glas{--faint:#7d7d84}
html.glas .faint{color:#7d7d84!important}
html.glas .pill.on span,html.glas .chips a.on span,html.glas .chip.on span{color:var(--g-acc)!important}
/* Lesbarkeit: sekundärer Text nie heller als #6e6e73 auf Weiß; schwebende Flächen über Tabellen deckend genug */
html.glas :is(.mut,.muted,.small.mut,.sc-addr){color:#6e6e73}
html.glas .sticky-clone{background:rgba(255,255,255,.97)!important}
html.glas .search input:focus-visible{outline:0!important;box-shadow:none!important}
/* Verschachteltes backdrop-filter wirkt nicht: hätten Kopf/Menüleiste selbst den Filter, könnten die Klappmenüs darin den
   Inhalt darunter nicht verwischen (Text schien scharf durch). Deshalb liegt das Glas von Kopf und Leiste auf ::before. */
html.glas .shell .top,html.glas .menu-top .top{-webkit-backdrop-filter:none!important;backdrop-filter:none!important;isolation:isolate}
html.glas .shell .top::before,html.glas .menu-top .top::before{content:"";position:absolute;inset:0;z-index:-1;background:inherit;-webkit-backdrop-filter:var(--lg-blur);backdrop-filter:var(--lg-blur);pointer-events:none}
@media (min-width:1025px){
html.glas .menu-top .appside{-webkit-backdrop-filter:none!important;backdrop-filter:none!important;isolation:isolate}
html.glas .menu-top .appside::before{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;background:inherit;-webkit-backdrop-filter:var(--lg-blur);backdrop-filter:var(--lg-blur);pointer-events:none}
}
/* Fassung 5 „Feinschliff“ (Ahmed 07.11.): gemeinsame Tokens für Typografie, Kennzahlen, Tabellen, Leer-Hinweise, Meldungen
   und ruhigere Kalender. Gemessen über 71 Seiten (Ausreißer: Titel 24/26 px, Kennzahlen 12,5–28 px, Tabellenköpfe,
   vier Stile für Leer-Hinweise). Nur Darstellung. */
html.glas{--fs-h1:26px;--fs-h2:18px;--fs-h3:16px;--fs-kpi:24px;--fs-label:12.5px;--c-soft:#f7f7f9;--c-ok:#1f7a4d;--c-warn:#8a5a00;--c-err:#b42318}
html.glas main h1{font-size:var(--fs-h1)!important;font-weight:700!important;letter-spacing:-.02em}
html.glas main h2{font-size:var(--fs-h2)!important;font-weight:650!important;letter-spacing:-.015em}
html.glas main h3{font-size:var(--fs-h3)!important;font-weight:650!important}
html.glas main td,html.glas main .kpi,html.glas main .bs-kpi{font-variant-numeric:tabular-nums}
/* Kennzahlen: ein Maß für Wert und Beschriftung */
html.glas main .kpi .v,html.glas main .bs-kpi .bs-kv{font-size:var(--fs-kpi)!important;font-weight:700!important;letter-spacing:-.02em;line-height:1.2;color:var(--ink)}
html.glas main .kpi .l,html.glas main .bs-kpi .bs-kl{font-size:var(--fs-label)!important;font-weight:600;color:#6e6e73;text-transform:none!important;letter-spacing:.01em}
/* Tabellenköpfe überall gleich: ruhig, ohne Fläche, feine Linie */
html.glas main table th{font-size:13px!important;font-weight:600!important;color:#6e6e73!important;background:transparent!important;text-transform:none!important;border-bottom:1px solid var(--line-c)!important}
html.glas main table tfoot td,html.glas main table tr.sum td,html.glas main table tr.total td{font-weight:650;border-top:1px solid #d9d9df!important}
/* Leer-Hinweise: ein Stil */
html.glas main :is(.empty,.empty-line,.dash-empty){background:var(--c-soft)!important;border:1px dashed #e0e0e6!important;border-radius:12px!important;padding:14px 16px!important;color:#6e6e73!important;font-size:14.5px!important;text-align:left}
/* Meldungen: weiche Fläche, feine Linie, farbige Kante links */
html.glas .flash{border-radius:12px!important;border:1px solid!important;border-left-width:3px!important;padding:12px 16px!important;box-shadow:none!important;background-image:none!important}
html.glas .flash.ok{background:#f1f8f4!important;color:#14532d!important;border-color:#cfe8da!important;border-left-color:var(--c-ok)!important}
html.glas .flash.warn{background:#fdf8ee!important;color:#6b4600!important;border-color:#f0dfb6!important;border-left-color:#c58a12!important}
html.glas .flash.err{background:#fdf3f2!important;color:#7a271a!important;border-color:#f6d2ce!important;border-left-color:var(--c-err)!important}
html.glas .flash.info{background:#f4f6fb!important;color:#2b3a55!important;border-color:#dbe2f0!important;border-left-color:#5b6b8c!important}
/* Ruhigere Kalender und Planung: erfasste Einsätze hell-bordeaux mit Kante statt Vollfläche, „Heute“ hell statt gelb */
html.glas .ev.ok,html.glas .pb-ev.done,html.glas .sh.done{background:#f7edf1!important;color:#5a1229!important;border-color:#ead2db!important;box-shadow:inset 3px 0 0 var(--g-acc)!important}
html.glas .sh.done :is(.mut,small,.s){color:#7a4a5a!important}
html.glas .ev.ok .ic,html.glas .ev.ok svg{color:var(--g-acc)!important}
html.glas .pb-ev{border-radius:6px!important;transition:box-shadow .18s ease,background-color .18s ease}
html.glas .pb-ev:hover{filter:none!important;box-shadow:inset 0 0 0 1px #b9b3b6,0 2px 6px -2px rgba(20,20,30,.12)!important}
html.glas .pb-ev.done:hover{box-shadow:inset 3px 0 0 var(--g-acc),0 2px 6px -2px rgba(20,20,30,.12)!important}
html.glas .pb-ev.open{background:#eceef1!important;color:#3a4049!important;box-shadow:inset 0 0 0 1px #d6d9de!important}
html.glas .ec .dc.today,html.glas .eg .gh.today,html.glas .pb-dh.today{background:#fbf3f6!important;color:var(--g-acc)!important}
html.glas .pb-c.today{background:#fdf9fa!important}
html.glas .today:not(.dc):not(.gh):not(.pb-dh):not(.pb-c){background:#fbf3f6}
html.glas .pl-days span.on{background:var(--g-acc)!important}
/* Listenzeilen: sanftes Hover */
html.glas main :is(.list>li,.emp-card,.dash-list>li){transition:background-color .18s ease}
html.glas main :is(.list>li,.emp-card):hover{background:#fafafb}
/* Kennzahl-Kacheln ruhig: keine Farbkante links (.kpi::before) und keine bunten Kanten oben (.skpi c1–c5);
   nur die erste Kachel einer Reihe bzw. .accent trägt die feine Bordeaux-Linie. */
html.glas .kpi::before{display:none!important}
html.glas .skpi{background:#fff!important;border:1px solid var(--line-c)!important;border-top-width:1px!important;border-radius:var(--r-card)!important;box-shadow:var(--sh-card)!important;transition:box-shadow .18s ease,border-color .18s ease}
html.glas .skpi.c1{box-shadow:inset 0 2px 0 var(--g-acc),var(--sh-card)!important}
html.glas a.skpi:hover{box-shadow:var(--sh-hover)!important;border-color:#dcdce2!important}
html.glas .skpi .l{text-transform:none!important;letter-spacing:.01em!important;font-weight:600;font-size:var(--fs-label)!important;color:#6e6e73!important}
html.glas .skpi .v{font-size:var(--fs-kpi)!important;letter-spacing:-.02em}
/* Gefahr-Knöpfe (Löschen, Ablehnen, Stornieren): roter Umriss statt roter Fläche – erkennbar, aber nicht das lauteste
   Element der Seite; beim Darüberfahren hellrot. Die Rückfrage vor dem Löschen bleibt. */
html.glas .btn.danger,html.glas button.btn.danger,html.glas .btn.del{background:#fff!important;color:var(--c-err)!important;border:1px solid #efc4bf!important;box-shadow:none!important}
html.glas .btn.danger:hover,html.glas button.btn.danger:hover,html.glas .btn.del:hover{background:#fdf3f2!important;border-color:#e3a39b!important;color:#912018!important}
@media (max-width:760px){html.glas{--fs-kpi:19px}
html.glas main .kpis{grid-template-columns:repeat(2,minmax(0,1fr))!important}
html.glas main :is(.kpi,.skpi,.bs-kpi){min-width:0;overflow-wrap:anywhere}
html.glas main form[method=get] :is(select,input[type=text],input[type=search],input[type=date],input:not([type])):not(.mpick-s){width:100%!important;max-width:none!important;margin-left:0!important;margin-right:0!important}
html.glas main form[method=get] .cbx{width:100%!important;max-width:none!important;margin-left:0!important}}
/* Fassung 6 – gezielte Verbesserungen (08.11.): Kalender, Kalkulation, Rechte, Formulare, Status */
html.glas a.plain{color:inherit!important;text-decoration:none;border-bottom:1px dotted transparent}
html.glas a.plain:hover{color:var(--g-acc)!important;border-bottom-color:var(--g-acc)}
html.glas main td.r,html.glas main td.num,html.glas main th.r,html.glas main th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
html.glas main td.r .small,html.glas main td.r div{white-space:normal}
html.glas .cost-flag{display:table;margin-top:5px;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;background:#fff6e5;color:#8a5a00;box-shadow:inset 0 0 0 1px #f1dcae}
html.glas details.calc-how>summary{cursor:pointer;color:var(--mut);font-weight:500;list-style-position:inside}
html.glas details.calc-how[open]{background:var(--c-soft);border-radius:10px;padding:8px 12px;line-height:1.5}
html.glas .pb-legend{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0 6px}
html.glas .pb-legend .pb-ev{display:inline-block;font-size:12px;padding:3px 10px;cursor:default}
html.glas .pb-legend .pb-lh{font-size:12px;color:var(--mut);padding:3px 10px;border-radius:6px;background:#e8f0f8}
html.glas .pb-ev .m{font-variant-numeric:tabular-nums}
html.glas .ec .ev .tm{color:inherit}
html.glas .eg .blk div{font-variant-numeric:tabular-nums}
@media (max-width:700px){html.glas .ec .ev .tm{display:inline!important;font-weight:600}html.glas .ec .ev .t{display:none}html.glas .ec .ev .ic{display:none}html.glas .ec .dc .hn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9.5px}html.glas .ec .ev{justify-content:center;padding:2px 2px}}
/* Rechte: kompakte Matrix, Abweichung hinterlegt, Speichern immer sichtbar */
html.glas table.perm td,html.glas table.perm th{padding:7px 12px!important}
html.glas table.perm th:not(:first-child),html.glas table.perm td.perm-c{text-align:center;width:150px}
html.glas table.perm tr.perm-grp td{background:var(--c-soft)!important;font-weight:650;color:var(--ink);padding-top:12px!important;font-size:13px;letter-spacing:.02em;text-transform:uppercase}
html.glas table.perm tbody tr:not(.perm-grp):hover td{background:#faf7f8}
html.glas table.perm td.perm-c.dev,html.glas .perm-key{background:#f7edf1!important;box-shadow:inset 0 0 0 1px #ead2db}
html.glas .perm-key{padding:0 6px;border-radius:6px;font-weight:600;color:#5a1229}
html.glas .perm-foot{position:sticky;bottom:0;z-index:4;background:rgba(255,255,255,.94);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-top:1px solid var(--line-c);margin:0 -24px -24px;padding:12px 24px!important;border-radius:0 0 16px 16px}
/* Formulare: Abbrechen rechts, verständliche Fehlerfelder */
html.glas .cancel-back{margin-left:auto}
html.glas main :is(input,select,textarea):user-invalid{border-color:#d9534f!important;box-shadow:0 0 0 3px rgba(217,83,79,.12)!important}
/* Leere Zustände: Hinweis mit kleinem Symbol */
html.glas main div:is(.empty,.empty-line),html.glas main p:is(.empty,.empty-line){position:relative;padding-left:44px!important}
html.glas main div:is(.empty,.empty-line)::before,html.glas main p:is(.empty,.empty-line)::before{content:'';position:absolute;left:16px;top:calc(50% - 9px);width:18px;height:18px;border-radius:50%;background:radial-gradient(circle at 50% 50%,#fff 0 3px,transparent 3.5px),#c7c7cc;box-shadow:inset 0 0 0 1px #b8b8bf}
/* Fassung 7 – letzter Feinschliff (08.11.) */
html.glas .card[style*="padding:0"]>.tbl{margin:0!important}
html.glas select.cbx-native{min-width:0!important}
html.glas main td.r .hh{display:block;white-space:nowrap;font-variant-numeric:tabular-nums;line-height:1.35}
html.glas main td.r .hh-l{display:inline-block;min-width:30px;text-align:left;font-size:11.5px;color:var(--mut);font-weight:500}
html.glas main td.r .hh:not(.hh-ist){color:var(--mut)}
html.glas main td.r .hh-ist{font-weight:600;color:var(--ink)}
html.glas main td.neg{color:var(--c-err)!important;background:#fdf3f2!important;box-shadow:inset 3px 0 0 #e3a39b}
html.glas main tr.sum td.neg,html.glas main tr:first-child td.neg{box-shadow:inset 3px 0 0 #e3a39b}
html.glas table.perm input[type=checkbox]{width:18px;height:18px;cursor:pointer}
html.glas table.perm td.perm-c label{justify-content:center;padding:4px 8px;border-radius:6px}
/* Lesbarkeit vor Glas: schwebende Listen fast deckend, Hintergrund nur noch als Unschärfe */
html.glas :is(.drop,.cbx-pop,details.dd>.drop),html.glas .menu-top .appside nav.menu .sub{background:rgba(253,253,254,.96)!important}
/* ===== Fassung 8: Bedienlogik (Ahmed 08.11.) ===== */
html.glas .vh{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;border:0!important;white-space:nowrap!important}
html.glas .req{color:var(--brand,#811d40);font-weight:600}
html.glas th.sortable:focus-visible,html.glas a.sorth:focus-visible{outline:2px solid var(--brand,#811d40);outline-offset:-2px;border-radius:4px}
html.glas a.sorth{color:inherit;text-decoration:none;cursor:pointer;white-space:nowrap}
html.glas a.sorth:hover{color:var(--brand,#811d40)}
html.glas a.sorth.asc,html.glas a.sorth.desc{color:var(--brand,#811d40);text-decoration:underline;text-underline-offset:4px}
html.glas .chips.in-status{margin:12px 0 10px}
html.glas .filter-reset{white-space:nowrap}
html.glas details.doc-cat.drop-over{outline:2px dashed var(--brand,#811d40);outline-offset:2px;background:#f7edf1}
html.glas details.doc-cat.drop-over>summary::after{content:'Datei hier ablegen';margin-left:auto;font-size:13px;color:var(--brand,#811d40);font-weight:600}
html.glas details.more-filters{display:inline-block;position:relative}
html.glas details.more-filters>summary{list-style:none;cursor:pointer}
html.glas details.more-filters>summary::-webkit-details-marker{display:none}
html.glas details.more-filters[open]>.mf-body{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}
html.glas .actstack>details>.act-menu{display:flex;flex-direction:column;padding:4px!important;background:rgba(255,255,255,.7)!important;border-radius:12px!important}
html.glas .act-menu>a,html.glas .act-menu>form>button{display:block;width:100%;text-align:left;padding:9px 12px;border:0;background:transparent;color:#1d1d1f;font:inherit;font-size:14px;font-weight:500;border-radius:8px;text-decoration:none;cursor:pointer;box-shadow:none;min-height:0;height:auto}
html.glas .act-menu>a:hover,html.glas .act-menu>form>button:hover{background:rgba(0,0,0,.05);color:var(--brand,#811d40);text-decoration:none}
html.glas .act-menu>form{margin:0}
html.glas .act-menu>form>button.quiet{color:#b42318}
html.glas .issued-flash{align-items:center;justify-content:space-between;flex-wrap:wrap;white-space:normal}
html.glas .issued-flash form{margin:0}
html.glas details.tool-box:not([open]){display:none}
html.glas details.fold-sec>summary{cursor:pointer;padding:2px 0}
html.glas details.fold-sec[open]>summary{margin-bottom:10px}
html.glas details.poster-box.fold-sec:not([open]){padding-top:12px;padding-bottom:12px}
html.glas .actstack>details>summary::before{content:none!important;display:none!important}
html.glas details.fold-sec>summary,html.glas details.tool-box>summary{list-style:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;user-select:none}
html.glas details.fold-sec>summary::-webkit-details-marker,html.glas details.tool-box>summary::-webkit-details-marker{display:none}
html.glas details.fold-sec>summary::before,html.glas details.tool-box>summary::before{content:"";width:7px;height:7px;flex:none;border-right:1.7px solid var(--mut);border-bottom:1.7px solid var(--mut);transform:rotate(-45deg);transition:transform .15s;margin:0 3px 0 1px}
html.glas details.fold-sec[open]>summary::before,html.glas details.tool-box[open]>summary::before{transform:rotate(45deg) translate(-1px,-1px)}
/* Fassung 9 (Ahmed 09.11.: „Bordeaux bei der Menüleiste und leicht im Hintergrund mit dem Glas-Design wieder“):
   Menüleiste als Bordeaux-Glas mit weißer Schrift, aktiver Punkt weiß unterstrichen; Hintergrund mit leichtem
   Bordeaux-Schimmer oben und zarten Farbflächen, Karten bleiben weiß. Klappmenüs bleiben hell. */
html.glas body,html.glas body.shell,html.glas body.appmode,html.glas body.mshell,html.glas body.bare{background:#f6f3f5!important;background-image:radial-gradient(1100px 520px at 12% -8%,color-mix(in srgb,var(--g-acc) 16%,transparent),transparent 70%),radial-gradient(900px 480px at 100% 0%,color-mix(in srgb,var(--g-acc) 9%,transparent),transparent 70%),radial-gradient(1000px 600px at 85% 105%,color-mix(in srgb,var(--g-acc) 7%,transparent),transparent 70%),radial-gradient(800px 500px at 0% 100%,color-mix(in srgb,var(--g-acc) 5%,transparent),transparent 70%)!important;background-attachment:fixed!important}
@media (min-width:1025px){
html.glas .menu-top .appside,html.glas:not(.scrolled) .menu-top .appside{background:color-mix(in srgb,var(--g-acc) 92%,transparent)!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 6px 22px -10px color-mix(in srgb,var(--g-acc) 60%,transparent)!important}
html.glas.scrolled .menu-top .appside{background:color-mix(in srgb,var(--g-acc) 80%,transparent)!important}
html.glas .menu-top .appside>nav.menu>a.item,html.glas .menu-top .appside>nav.menu>.grp>summary,html.glas .menu-top .appside>nav.menu>.grp>summary .ic{color:rgba(255,255,255,.9)!important}
html.glas .menu-top .appside>nav.menu>a.item:hover,html.glas .menu-top .appside>nav.menu>.grp>summary:hover{background:rgba(255,255,255,.12)!important;color:#fff!important}
html.glas .menu-top .appside>nav.menu>a.item.on,html.glas .menu-top .appside>nav.menu>.grp.on>summary{color:#fff!important;background:rgba(255,255,255,.14)!important;box-shadow:inset 0 -2.5px 0 #fff!important}
html.glas .menu-top .appside>nav.menu>.grp[open]>summary,html.glas .menu-top .appside>nav.menu>.grp[open]>summary .ic{color:#fff!important}
html.glas .menu-top .appside>nav.menu>.grp[open]:not(.on)>summary{color:#fff!important;background:rgba(255,255,255,.12)!important}
html.glas .menu-top .appside>nav.menu>.grp>summary .ic{background:transparent!important}
html.glas .menu-top .appside>nav.menu>.grp[open]:not(.on)>summary .ic{color:#fff!important}
}
/* Ohne backdrop-filter: deckend weiß */
@supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){html.glas .shell .top,html.glas .menu-top .appside,html.glas .sdrop,html.glas .drop,html.glas .cbx-pop,html.glas dialog,html.glas .menu-top .appside nav.menu .sub{background:#fff!important}}
@media (prefers-reduced-transparency:reduce){html.glas .shell .top,html.glas .menu-top .appside,html.glas .sdrop,html.glas .drop,html.glas .cbx-pop,html.glas dialog,html.glas .menu-top .appside nav.menu .sub{background:#fff!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}}
@media (prefers-reduced-motion:reduce){html.glas *{transition:none!important;animation:none!important}}
@media (prefers-reduced-transparency:reduce){html.glas .card,html.glas .panel,html.glas .kpi,html.glas .shell .top,html.glas .menu-top .appside,html.glas .apptabs,html.glas .tabbar{background:rgba(255,255,255,.96)!important;-webkit-backdrop-filter:none;backdrop-filter:none}}
@media (prefers-reduced-transparency:reduce) and (min-width:1025px){html.glas .menu-top .appside{background:var(--g-acc)!important}}
@supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){@media (min-width:1025px){html.glas .menu-top .appside{background:var(--g-acc)!important}}}
@media print{html.glas body{background:#fff!important;background-image:none!important}html.glas .card,html.glas .panel{background:#fff!important;box-shadow:none!important;backdrop-filter:none!important}}
/* Übersicht: Bordeaux-Kopf mit Kennzahlen je Rolle (Ahmed 12.11., Vorschlag C) */
html .dhero{position:relative;overflow:hidden;color:#fff;border-radius:20px;padding:22px 24px 20px;margin:4px 0 18px;
  background:radial-gradient(620px 300px at 12% 0%,rgba(182,52,98,.55),transparent 70%),
    radial-gradient(520px 260px at 100% 100%,rgba(40,4,16,.55),transparent 70%),
    linear-gradient(135deg,#5c0e27,var(--g-acc,#811d40) 58%,#3d0a1b);
  box-shadow:0 14px 34px rgba(92,14,39,.22)}
html .hx-top{display:flex;align-items:flex-end;gap:14px 20px;flex-wrap:wrap}
html .hx-top>div:first-child{flex:1;min-width:220px}
html .hx-date{font-size:13px;color:rgba(255,255,255,.72)}
html .dhero h1{margin:2px 0 0;font-size:27px;font-weight:700;letter-spacing:-.01em;color:#fff}
html .hx-quick{display:flex;flex-wrap:wrap;gap:8px}
html .hx-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:10px;font-weight:600;font-size:13.5px;
  color:#fff;text-decoration:none;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.22);transition:background .16s}
html .hx-btn:hover{background:rgba(255,255,255,.18);color:#fff}
html .hx-btn.p{background:#fff;color:var(--g-acc,#811d40);border-color:#fff}
html .hx-btn.p:hover{background:#f7edf1;color:var(--g-acc,#811d40)}
html .hx-btn.ic{padding:8px 10px}
html .hx-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:18px}
html .hx-k{display:block;color:#fff;text-decoration:none;border-radius:14px;padding:13px 15px;
  background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);transition:background .16s,border-color .16s}
html a.hx-k:hover{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.28);color:#fff}
html .hx-l{font-size:12.5px;font-weight:600;color:rgba(255,255,255,.72)}
html .hx-row{display:flex;align-items:flex-end;justify-content:space-between;gap:8px}
html .hx-v{font-size:25px;font-weight:700;margin:3px 0 2px;letter-spacing:-.01em;white-space:nowrap}
html .hx-spark{flex:none;margin-bottom:4px}
html .hx-s{font-size:12.5px;color:rgba(255,255,255,.75)}
html .hx-s.ok{color:#a8e6c0}html .hx-s.bad{color:#ffb8b8}html .hx-s.warn{color:#ffe0a0}
html .hx-bar{height:7px;border-radius:9px;background:rgba(255,255,255,.16);margin:6px 0 6px;overflow:hidden}
html .hx-bar i{display:block;height:100%;border-radius:9px;background:#fff}
@media (max-width:760px){html .dhero{padding:18px 16px;border-radius:16px}html .dhero h1{font-size:22px}
  html .hx-tiles{grid-template-columns:1fr 1fr;gap:8px}html .hx-k{padding:11px 12px}html .hx-v{font-size:19px}
  html .hx-spark{display:none}html .hx-quick{width:100%}}
@media print{html .dhero{background:#fff!important;color:#000;box-shadow:none}html .dhero *{color:#000!important}html .hx-quick{display:none}}
`;
