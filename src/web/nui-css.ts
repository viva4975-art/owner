// Neue Oberfläche (Ahmed 13.11.2026, Vorbild Blink Manager). Gilt nur mit <body class="nui">, also nur wenn im Konto
// „Neue Oberfläche“ gewählt ist (Standard). Ohne die Klasse bleibt alles wie bisher – Rücksprung jederzeit möglich.
// Steht ganz am Ende des Stylesheets und überschreibt die älteren Schichten gezielt.
export const NUI_CSS = `
body.nui{--n-b:#811D40;--n-bh:#F7EDF1;--n-t:#1D1D1F;--n-t2:#6E6E73;--n-l:#E5E5EA;--n-bg:#F6F6F8}
body.nui,html.glas body.nui{background:var(--n-bg)!important;background-image:none!important}
body.nui .mainc{background:none!important}
html body.nui .appside.nside,html.glas body.shell.nui .appside.nside{position:fixed;inset:0 auto 0 0;width:248px;background:#fff!important;background-image:none!important;border-right:1px solid var(--n-l);color:var(--n-t);display:flex;flex-direction:column;z-index:40;overflow:hidden;padding:14px 12px 10px;box-shadow:none!important;border-radius:0!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
body.nui .nlogo{display:block;padding:2px 8px 12px}
body.nui .nlogo img{height:34px;width:auto;display:block}
body.nui .nrole{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid var(--n-l);border-radius:10px;padding:8px 10px;margin-bottom:10px;color:var(--n-t);text-decoration:none;font-size:13px;line-height:1.25}
body.nui .nrole small{display:block;color:var(--n-t2);font-size:11.5px}
body.nui .nrole:hover{border-color:#d0d0d6;text-decoration:none}
body.nui .nmenu{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:1px;margin:0 -4px;padding:0 4px}
body.nui .nmenu a{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;color:var(--n-t);text-decoration:none;font-size:14px;font-weight:500;line-height:1.25}
body.nui .nmenu a .ic{color:var(--n-t2);flex:none}
body.nui .nmenu a:hover{background:#f2f2f5;text-decoration:none}
body.nui .nmenu a.on{background:var(--n-bh);color:var(--n-b);font-weight:600}
body.nui .nmenu a.on .ic{color:var(--n-b)}
body.nui .nbadge{margin-left:auto;background:var(--n-b);color:#fff;border-radius:10px;font-size:11px;padding:1px 7px;font-weight:600}
body.nui .ngrp{margin-top:2px}
body.nui .ngrp>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;cursor:pointer;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--n-t2);padding:12px 10px 5px;border-radius:6px}
body.nui .ngrp>summary::-webkit-details-marker{display:none}
body.nui .ngrp>summary .ic{transform:rotate(-90deg);transition:transform .15s;opacity:.7}
body.nui .ngrp[open]>summary .ic{transform:none}
body.nui .ngrp>summary:hover{color:var(--n-t)}
body.nui .ngrp>a{padding:7px 10px 7px 12px;font-size:13.5px;font-weight:450}
body.nui .side-foot{padding:8px 6px 0}
body.nui .side-foot .env{color:var(--n-t2)}
body.nui .mainc{margin-left:248px}
body.nui .top{background:#fff!important;border-bottom:1px solid var(--n-l)!important;box-shadow:none!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
body.nui .top::before{display:none!important}
/* Übersicht als Cockpit: schmaler Bordeaux-Balken, Kennzahlen als weiße Karten darunter */
html body.nui .dhero{background:none!important;box-shadow:none!important;padding:0!important;border-radius:0!important;overflow:visible;color:var(--n-t);margin:0 0 16px}
html body.nui .hx-top{background:linear-gradient(110deg,#6c1130,var(--n-b) 55%,#9b2348);border-radius:16px;padding:18px 22px;align-items:center;color:#fff}
html body.nui .hx-tiles{margin-top:16px;gap:16px}
html body.nui .hx-k{background:#fff!important;border:1px solid var(--n-l)!important;color:var(--n-t)!important;border-radius:16px;padding:16px 18px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
html body.nui a.hx-k:hover{border-color:#cfcfd6!important;box-shadow:0 6px 18px -8px rgba(0,0,0,.18)}
html body.nui .hx-l{color:var(--n-t);font-size:13.5px}
html body.nui .hx-v{font-size:28px;color:var(--n-t)}
html body.nui .hx-s{color:var(--n-t2)}
html body.nui .hx-s.ok{color:#1F9D55}html body.nui .hx-s.bad{color:#D23B3B}html body.nui .hx-s.warn{color:#9A6400}
html body.nui .hx-bar{background:#EEEEF1}html body.nui .hx-bar i{background:var(--n-b)}
html body.nui .hx-spark polyline{stroke:var(--n-b)}html body.nui .hx-spark polygon{fill:rgba(129,29,64,.08)}
@media print{html body.nui .hx-top{background:#fff!important;color:#000}}
/* Cockpit-Zeile (Eingang, Personal, Objekte) */
body.nui .ck-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin:0 0 16px}
body.nui .ck{background:#fff;border:1px solid var(--n-l);border-radius:16px;padding:16px 18px}
body.nui .ck h3{display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:15px;font-weight:600}
body.nui .ck h3 a.go{margin-left:auto;color:var(--n-t2)}
body.nui .ck-rings{display:grid;grid-template-columns:1fr 1fr;gap:12px 10px}
body.nui .ck-r{display:flex;align-items:center;gap:10px;color:var(--n-t);text-decoration:none;font-size:13.5px;line-height:1.25}
body.nui .ck-r small{display:block;color:var(--n-t2);font-size:12px}
body.nui .ck-r:hover{text-decoration:none}
body.nui .ring{--p:0;--c:var(--n-b);width:52px;height:52px;border-radius:50%;flex:none;background:conic-gradient(var(--c) calc(var(--p)*1%),#EEEEF1 0);display:grid;place-items:center}
body.nui .ring>span{width:41px;height:41px;border-radius:50%;background:#fff;display:grid;place-items:center;font-weight:650;font-size:15px}
body.nui .ck-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
body.nui .ck-t{border:1px solid var(--n-l);border-radius:12px;padding:12px 8px;text-align:center;color:var(--n-t);text-decoration:none}
body.nui .ck-t b{display:block;font-size:24px;font-weight:650}
body.nui .ck-t small{color:var(--n-t2);font-size:12px}
body.nui .ck-t:hover{border-color:#cfcfd6;text-decoration:none}
body.nui .ck-list a{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--n-l);color:var(--n-t);text-decoration:none;font-size:13.5px}
body.nui .ck-list a:first-child{border-top:0}
body.nui .ck-list a:hover{text-decoration:none;color:var(--n-b)}
body.nui .ck-dot{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;flex:none}
body.nui .ck-list .n{margin-left:auto;font-weight:650}
/* Eingang (auch in der bisherigen Oberfläche erreichbar) */
.ib-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 14px}
.ib-bar .chip{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:#EFEFF2;color:#3a3a3f;text-decoration:none;font-size:13.5px;font-weight:500}
.ib-bar .chip .n{font-weight:650;opacity:.8}
.ib-bar .chip.on,html .ib-bar a.chip.on{background:#811D40!important;color:#fff!important;border-color:#811D40!important}
.ib-list{padding:4px 18px!important}
.ib-row{display:flex;align-items:center;gap:14px;padding:12px 0;border-top:1px solid #E5E5EA}
.ib-row:first-child{border-top:0}
.ib-dot{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;flex:none}
.ib-main{flex:1;min-width:0}
.ib-meta{font-size:12px;color:#6E6E73}
.ib-title{display:block;font-weight:600;color:#1D1D1F;text-decoration:none;font-size:14.5px;margin:1px 0 2px}
.ib-title:hover{color:#811D40;text-decoration:none}
.ib-sub{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12.5px;color:#6E6E73}
.ib-tag{background:#F1F1F4;border-radius:6px;padding:1px 7px;font-size:11.5px;color:#55555a}
.ib-tag.err{background:#FBE5E5;color:#B42323}.ib-tag.warn{background:#FDF2DC;color:#8a5a00}
.ib-who{font-size:12px;color:#55555a;background:#F1F1F4;border-radius:999px;padding:3px 9px;white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis}
.ib-st{font-size:11.5px;font-weight:600;border-radius:999px;padding:2px 9px;white-space:nowrap}
.ib-st.new{background:#E6EEFB;color:#2F6FDB}.ib-st.work{background:#FDF2DC;color:#9A6400}
.ib-act{display:flex;gap:6px;align-items:center;flex:none}
.ib-act form{margin:0}
@media (max-width:760px){.ib-row{flex-wrap:wrap}.ib-main{flex-basis:calc(100% - 50px)}.ib-act{width:100%;justify-content:flex-end}.ib-who{display:none}}
/* „⋮“-Menü in Zeilen */
body.nui details.kb{position:relative;display:inline-block}
body.nui details.kb>summary{list-style:none;cursor:pointer;width:32px;height:32px;border-radius:8px;display:grid;place-items:center;font-size:20px;line-height:1;color:var(--n-t2);border:1px solid transparent}
body.nui details.kb>summary::-webkit-details-marker{display:none}
body.nui details.kb>summary:hover,body.nui details.kb[open]>summary{background:#f2f2f5;border-color:var(--n-l)}
body.nui details.kb .kb-pop{position:absolute;right:0;top:36px;z-index:30;min-width:200px;background:#fff;border:1px solid var(--n-l);border-radius:12px;box-shadow:0 14px 34px rgba(0,0,0,.14);padding:6px;display:flex;flex-direction:column;gap:2px}
body.nui details.kb .kb-pop form{margin:0}
body.nui details.kb .kb-pop .btn{width:100%;justify-content:flex-start;border:0;background:none;color:var(--n-t);box-shadow:none;font-weight:500}
body.nui details.kb .kb-pop .btn:hover{background:#f2f2f5}
body.nui details.kb .kb-pop .btn.danger{color:#D23B3B}
/* Mitarbeiter: Status-Schild, Aktionen, Checkliste (auch bisherige Oberfläche) */
.stage-pill{display:inline-flex;align-items:center;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600;vertical-align:middle;margin-left:10px}
.stage-pill.st-ok{background:#E3F4EA;color:#1F7A45}.stage-pill.st-warn{background:#FDF2DC;color:#8a5a00}
.stage-pill.st-info{background:#E6EEFB;color:#2F6FDB}.stage-pill.st-err{background:#FBE5E5;color:#B42323}
.stage-pill.st-grey{background:#EFEFF2;color:#55555a}
.emp-head-r{display:flex;gap:8px;align-items:center;margin-left:auto}
.emp-actions .drop{min-width:250px}
.emp-actions .drop a{display:flex!important;align-items:center;gap:9px;justify-content:flex-start!important;text-align:left!important}
.eh-chips .stage-pill,.emp-tags .stage-pill{margin-left:0}
.emp-actions .drop a.danger{color:#B42323}
.emp-actions .stage-form{padding:6px 10px;margin:0}
.emp-actions .stage-form label{font-size:12px;color:#6E6E73;margin:0 0 3px}
.emp-actions .stage-form select{width:100%}
.cl-card .cl-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.cl-card h2{display:flex;align-items:center;gap:8px;font-size:17px}
.cl-bar{height:7px;border-radius:9px;background:#EEEEF1;overflow:hidden;margin-bottom:6px}
.cl-bar i{display:block;height:100%;background:#811D40;border-radius:9px}
.cl-list{list-style:none;margin:0;padding:0}
.cl-list li{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid #EEEEF1;font-size:14px}
.cl-list li:first-child{border-top:0}
.cl-list li.ok .cl-l{color:#8a8a90;text-decoration:line-through}
.cl-f{margin:0;display:inline}
.cl-box{width:20px;height:20px;border-radius:6px;border:1.5px solid #C8C8CE;background:#fff;display:inline-grid;place-items:center;flex:none;padding:0;cursor:pointer;color:#fff}
span.cl-box{cursor:default}
.cl-list li.ok .cl-box{background:#1F9D55;border-color:#1F9D55}
.cl-l{flex:1;min-width:0}
.cl-i{font-size:12px;color:#8a8a90;white-space:nowrap}
.cl-new{display:flex;gap:8px;margin-top:10px}
.cl-new input{flex:1}
/* Stand je Leistung */
.svc-steps{display:flex;flex-wrap:wrap;gap:6px;margin:5px 0 2px}
.svc-step{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:500;border-radius:7px;padding:2px 8px}
.svc-step.ok{background:#E3F4EA;color:#1F7A45}.svc-step.now{background:#FDF2DC;color:#8a5a00}
.svc-step.open{background:#F1F1F4;color:#55555a}.svc-step.err{background:#FBE5E5;color:#B42323}
/* Leistungsarten / Preis-Orientierung */
.price-hint{margin-top:6px;background:#F7EDF1;color:#64152F;border-radius:8px;padding:6px 10px}
.lt-text{margin-top:4px}.lt-text summary{cursor:pointer;color:#6E6E73}.lt-text textarea{margin-top:4px;width:100%}
/* Planung: Soll/Ist je Person, Warnungen */
.pb-soll{display:block;font-size:12px;color:#55555a;margin-top:2px}
.pb-soll.lo b{color:#B42323}.pb-soll.hi b{color:#8a5a00}.pb-soll.ok b{color:#1F7A45}
.pb-sbar{display:block;height:4px;border-radius:4px;background:#EEEEF1;margin-top:3px;overflow:hidden}
.pb-sbar i{display:block;height:100%;background:#1F9D55}
.pb-sbar.lo i{background:#D23B3B}.pb-sbar.hi i{background:#E8A317}
.pb-warn{display:block;margin-top:4px;font-size:11px;line-height:1.25;background:#FBE5E5;color:#B42323;border-radius:6px;padding:2px 6px}
/* Qualifikationen */
.ql-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.ql-chip{display:inline-flex;align-items:center;gap:4px;background:#F1F1F4;border-radius:8px;padding:3px 4px 3px 9px;font-size:13px}
.ql-chip small{color:#6E6E73}.ql-chip.warn{background:#FDF2DC}.ql-chip.err{background:#FBE5E5;color:#B42323}
.ql-x{border:0;background:none;color:#8a8a90;cursor:pointer;font-size:15px;line-height:1;padding:0 4px}
html body form.ql-new{display:flex!important;gap:8px;flex-wrap:wrap;align-items:center}html body form.ql-new>*{margin:0!important}html body form.ql-new input{width:auto!important}html body form.ql-new input[name=name]{flex:1 1 220px!important;min-width:180px}html body form.ql-new input[type=date]{flex:0 0 170px}
/* Formular-Baukasten */
.fb-list{padding:4px 18px!important}
.fb-item{display:flex;align-items:center;gap:14px;padding:12px 0;border-top:1px solid #E5E5EA}
.fb-item:first-child{border-top:0}.fb-item.off{opacity:.55}
.fb-page{margin-top:14px}
.fb-ph{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.fb-ph input{flex:1;font-weight:600}
.fb-pn{font-size:12px;color:#6E6E73;white-space:nowrap}
.fb-row{display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-top:1px solid #EEEEF1}
.fb-row select{width:190px;flex:none}
.fb-main{flex:1;display:flex;flex-direction:column;gap:6px;min-width:0}
.fb-drag{color:#C8C8CE;padding-top:9px}
.fb-req{white-space:nowrap;padding-top:8px}
.ff{margin:0 0 14px}.ff-l{font-weight:500;margin-bottom:6px}
.ff-opts{display:flex;flex-wrap:wrap;gap:6px 16px}
.ff-info{background:#F7EDF1;color:#64152F;border-radius:10px;padding:10px 12px}
.ff-sig{width:100%;max-width:520px;height:170px;display:block;border:1.5px dashed #C8C8CE;border-radius:10px;background:#fff;touch-action:none;margin-bottom:4px}
@media (max-width:760px){.fb-row{flex-wrap:wrap}.fb-row select{width:100%}.fb-item{flex-wrap:wrap}.fb-item .ib-act{width:100%;justify-content:flex-end}}
@media (max-width:1024px){
  body.nui .mainc{margin-left:0}
  body.nui .appside.nside{transform:translateX(-100%);transition:transform .2s ease}
  body.nui .burger-cb:checked~.appside.nside{transform:none;box-shadow:0 20px 50px rgba(0,0,0,.25)!important}
}
@media print{body.nui .appside.nside{display:none!important}body.nui .mainc{margin-left:0}}

/* Detailseiten: Kopf als Profilkarte (Mitarbeiter), Inhalt der Reiter ohne weißen Rahmen – Karten liegen auf dem Grund */
html body.nui .ent-head{display:block!important;background:#fff;border:1px solid var(--n-l);border-radius:16px;padding:20px 22px 0;margin:0 0 16px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
body.nui .ent-top{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:16px;align-items:center;padding-bottom:16px}
@media (max-width:760px){body.nui .ent-top{grid-template-columns:auto minmax(0,1fr)}body.nui .ent-acts{grid-column:1/-1;margin-left:0}}
body.nui .ent-av{width:58px;height:58px;border-radius:50%;background:var(--n-bh);color:var(--n-b);display:grid;place-items:center;font-weight:650;font-size:20px;flex:none}
body.nui .ent-name{min-width:0}
html body.nui .ent-name h1{margin:0;font-size:24px;line-height:1.2;font-weight:650;color:var(--n-t)}
body.nui .ent-name h1 .no{color:var(--n-t2);font-weight:500;font-size:15px;margin-left:10px}
body.nui .ent-sub{color:var(--n-t2);font-size:13.5px;margin-top:3px}
body.nui .ent-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px}
body.nui .ent-chips .eh-tag{background:#F2F2F5;color:var(--n-t);border-radius:999px;padding:2px 10px;font-size:12.5px}
body.nui .ent-acts{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto}
body.nui .ent-acts>.stage-pill{display:none}
body.nui .ent-acts .emp-head-r{margin:0}
html body.nui .ent-head .tabs{border-bottom:0!important;background:none!important;border-top:1px solid var(--n-l)!important;margin:0 -22px!important;padding:0 10px!important;width:auto!important;max-width:none!important}
body.nui .ent-chips .stage-pill{margin:0}
html body.nui .entity-layout .tabs a,html body.nui .entity-layout .tabs summary{padding-left:10px;padding-right:10px}
body.nui .emp-hero .eh-top{display:none}
body.nui .emp-hero{padding-top:0}
html body.nui main .tabbody,html.glas body.nui main .tabbody{background:transparent!important;border:0!important;box-shadow:none!important;border-radius:0!important;padding:0!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}
html body.nui main .tabbody>.tbl,html body.nui main .tabbody>div>.tbl{background:#fff!important;border:1px solid var(--n-l)!important;border-radius:14px!important;overflow:auto}
html body.nui main .tabbody>.card,html body.nui main .tabbody .cols>.card,html body.nui main .tabbody .cols>div>.card{box-shadow:0 1px 2px rgba(0,0,0,.03)!important}
body.nui .tabs a,body.nui .tabs summary{font-size:14px}

/* Objekt-Übersicht schlicht: Gruppen als Karten in zwei Spalten (Ahmed 13.11.: „Objektübersicht alles einfach“) */
body.nui .ent-av-ic{color:var(--n-b)}
body.nui .ent-sub a{color:inherit;text-decoration:underline;text-decoration-color:#d0d0d6;text-underline-offset:2px}
body.nui .ent-chips .eh-tag a{color:inherit}
html body.nui .site-ov{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start}
html body.nui .site-ov>*{margin:0!important;min-width:0}
html body.nui .site-ov>:first-child{grid-column:1/-1}
html body.nui .site-ov>section,html body.nui .site-ov>div:not(.tbl){background:#fff;border:1px solid var(--n-l);border-radius:16px;padding:16px 18px!important;box-shadow:0 1px 2px rgba(0,0,0,.03)}
html body.nui .site-ov .panel-title,html body.nui .site-ov .ov-tasks>h2{font-size:15px;margin:0 0 8px!important}
html body.nui .site-ov .ov-tasks .tbl{border:0!important;margin:0 -18px -16px!important;border-radius:0 0 16px 16px!important}
html body.nui .site-ov .calm-cols{grid-template-columns:1fr 1fr}
@media (max-width:900px){html body.nui .site-ov{grid-template-columns:minmax(0,1fr)}}

/* Eingabefelder im neuen Design (Ahmed 13.11.): Beschriftung über dem Feld, zwei Spalten, ruhige graue Felder */
html body.nui main form[method="post" i] .grid{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:14px 18px!important;max-width:940px}
html body.nui main form[method="post" i] .grid>div:not(.chk){display:flex!important;flex-direction:column;gap:6px;align-items:stretch;grid-column:auto!important}
html body.nui main form[method="post" i] .grid>div:not(.chk)>:not(label){grid-column:auto}
html body.nui main form[method="post" i] .grid>div:has(textarea),html body.nui main form[method="post" i] .grid>div:has(fieldset),html body.nui main form[method="post" i] .grid>div:has(.chips),html body.nui main form[method="post" i] .grid>div:has(table),html body.nui main form[method="post" i] .grid>.full,html body.nui main form[method="post" i] .grid>.formfoot{grid-column:1/-1!important}
html body.nui main form[method="post" i] .grid>.chk{padding-left:0!important;align-self:end;min-height:42px;display:flex;align-items:center;gap:8px}
html body.nui main form[method="post" i] label{font-size:13px;font-weight:600;color:var(--n-t2);margin:0;letter-spacing:.005em}
html body.nui main form[method="post" i] .chk label,html body.nui main form[method="post" i] label:has(input[type=checkbox]),html body.nui main form[method="post" i] label:has(input[type=radio]){font-size:14.5px;font-weight:500;color:var(--n-t)}
html body.nui main form input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]):not([type=submit]):not([type=range]),html body.nui main form select,html body.nui main form textarea{min-height:42px;border-radius:10px!important;border:1px solid #e3e3e8!important;background:#f7f7f9!important;font-size:15px;padding:9px 12px;box-shadow:none!important;transition:background .15s,border-color .15s,box-shadow .15s;width:100%}
html body.nui main form textarea{min-height:92px;line-height:1.45}
html body.nui main form input:hover:not(:focus):not([type=checkbox]):not([type=radio]),html body.nui main form select:hover:not(:focus),html body.nui main form textarea:hover:not(:focus){border-color:#d2d2d8!important}
html body.nui main form input:focus:not([type=checkbox]):not([type=radio]),html body.nui main form select:focus,html body.nui main form textarea:focus{background:#fff!important;border-color:var(--n-b)!important;box-shadow:0 0 0 3px color-mix(in srgb,var(--n-b) 16%,transparent)!important;outline:0}
html body.nui main form input[type=checkbox],html body.nui main form input[type=radio]{accent-color:var(--n-b);width:18px;height:18px}
html body.nui main form h2.form-section,html body.nui main form[method="post" i]>h3{font-size:16px;font-weight:650;color:var(--n-t);margin:26px 0 12px;padding:0;border:0}
html body.nui main form h2.form-section:first-of-type,html body.nui main form[method="post" i]>h3:first-of-type{margin-top:2px}
html body.nui main form .help,html body.nui main form .hint{font-size:13px;color:var(--n-t2)}
html body.nui main form[method="post" i]>.actions,html body.nui main form[method="post" i]>.formfoot{position:sticky;bottom:0;z-index:5;background:#fff!important;border-top:1px solid var(--n-l)!important;margin:22px -22px -22px!important;padding:14px 22px!important;border-radius:0 0 16px 16px;display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-start}
@media (max-width:760px){html body.nui main form[method="post" i] .grid{grid-template-columns:minmax(0,1fr)!important}html body.nui main form[method="post" i]>.actions,html body.nui main form[method="post" i]>.formfoot{margin:18px -16px -16px!important;padding:12px 16px!important}}

/* Schritt für Schritt (Neu anlegen) */
html body.nui main form .wz-off,html body.nui main form[method] .grid>div.wz-off.wz-off,html body.nui main form[method]>.wz-off,html body.nui main form[method] .wz-off{display:none!important}
body.nui .wz-bar{margin:0 0 18px}
body.nui .wz-top{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
body.nui .wz-top b{font-size:18px;color:var(--n-t)}
body.nui .wz-top .wz-n{font-size:13px;color:var(--n-t2);font-weight:600;letter-spacing:.02em;text-transform:uppercase}
body.nui .wz-all{background:none;border:0;color:var(--n-b);font-size:13.5px;cursor:pointer;padding:0;text-decoration:underline;text-underline-offset:2px}
body.nui .wz-prog{height:6px;background:#efeff2;border-radius:6px;overflow:hidden;margin:10px 0 12px}
body.nui .wz-prog span{display:block;height:100%;background:var(--n-b);border-radius:6px;transition:width .25s}
body.nui .wz-dots{display:flex;gap:6px;flex-wrap:wrap;list-style:none;margin:0;padding:0}
body.nui .wz-dots button{border:1px solid var(--n-l);background:#fff;color:var(--n-t2);border-radius:999px;padding:4px 11px 4px 6px;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
body.nui .wz-dots button i{font-style:normal;width:20px;height:20px;border-radius:50%;background:#efeff2;display:grid;place-items:center;font-size:11.5px;font-weight:650}
body.nui .wz-dots button.on{border-color:var(--n-b);color:var(--n-b);background:var(--n-bh)}
body.nui .wz-dots button.on i,body.nui .wz-dots button.done i{background:var(--n-b);color:#fff}
body.nui .wz-nav{display:flex;gap:8px;margin-left:auto}
body.nui .wz-switch{margin:0 0 14px;font-size:13.5px}
@media (max-width:760px){body.nui .wz-dots button span{display:none}body.nui .wz-dots button{padding:4px}body.nui .wz-nav:not(.wz-last){margin-left:0;width:100%}body.nui .wz-nav .btn{flex:1}}

/* Kopfkarte am Handy kompakt (Ahmed 13.11.: „Objekte beim Namen komisch“) */
@media (max-width:760px){
html body.nui .ent-head{padding:14px 16px 0}
body.nui .ent-top{grid-template-columns:auto minmax(0,1fr)!important;gap:10px 12px;align-items:start;padding-bottom:12px}
body.nui .ent-av{width:42px;height:42px;font-size:15px}
body.nui .ent-av svg{width:20px;height:20px}
html body.nui .ent-name h1{font-size:19px;line-height:1.25}
body.nui .ent-name h1 .no{display:block;margin:2px 0 0;font-size:13px}
body.nui .ent-sub{font-size:13px;margin-top:4px}
body.nui .ent-chips{gap:5px;margin-top:8px}
body.nui .ent-chips .eh-tag,body.nui .ent-chips .tag,body.nui .ent-chips .pill{font-size:12px;padding:2px 8px}
body.nui .ent-acts{grid-column:1/-1;margin:0!important;display:flex;flex-wrap:nowrap;gap:6px;justify-content:flex-start}
body.nui .ent-acts>*{flex:0 1 auto}
body.nui .ent-acts .btn,body.nui .ent-acts summary{min-height:36px;padding:6px 12px;font-size:14px;white-space:nowrap}
body.nui .ent-acts>details:last-child,body.nui .ent-acts>.newmenu{margin-left:auto}
html body.nui .ent-head .tabs{margin:0 -16px!important;padding:10px 12px!important;display:flex!important;flex-wrap:wrap!important;gap:6px!important}
html body.nui .ent-head .tabs>a,html body.nui .ent-head .tabs>details>summary{border:1px solid var(--n-l)!important;border-radius:999px!important;padding:5px 11px!important;font-size:13.5px!important;margin:0!important;background:#fff}
html body.nui .ent-head .tabs>a.on{background:var(--n-bh)!important;border-color:var(--n-b)!important;color:var(--n-b)!important;box-shadow:none!important}
html body.nui .ent-head .tabs>a::after{display:none!important}
}

html body.nui main form[method]>.wz-hh,html body.nui main form[method] h2.wz-hh{display:none!important}
html body.nui main form[method="post" i]>label{display:block;margin:16px 0 6px}
html body.nui main form[method="post" i]>input:not([type=hidden]),html body.nui main form[method="post" i]>textarea,html body.nui main form[method="post" i]>select{max-width:940px}
`;
