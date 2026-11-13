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
@media (max-width:1024px){
  body.nui .mainc{margin-left:0}
  body.nui .appside.nside{transform:translateX(-100%);transition:transform .2s ease}
  body.nui .burger-cb:checked~.appside.nside{transform:none;box-shadow:0 20px 50px rgba(0,0,0,.25)!important}
}
@media print{body.nui .appside.nside{display:none!important}body.nui .mainc{margin-left:0}}
`;
