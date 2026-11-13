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
@media (max-width:1024px){
  body.nui .mainc{margin-left:0}
  body.nui .appside.nside{transform:translateX(-100%);transition:transform .2s ease}
  body.nui .burger-cb:checked~.appside.nside{transform:none;box-shadow:0 20px 50px rgba(0,0,0,.25)!important}
}
@media print{body.nui .appside.nside{display:none!important}body.nui .mainc{margin-left:0}}
`;
