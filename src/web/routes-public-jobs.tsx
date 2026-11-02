// Offene Stellen für die Website (WordPress, Ahmed 02.11.): öffentlich ohne Anmeldung, nur aktive Stellen mit Häkchen
// „Auf der Website“. Stundenlohn und Straße werden nie herausgegeben.
//   /oeffentlich/stellen.json – Daten (CORS offen)
//   /oeffentlich/stellen.js   – Einbau-Skript: <div id="viva-stellen"></div><script src=".../stellen.js" async></script>
//   /oeffentlich/stellen      – eigene Seite (z. B. als iframe)
import type { Env, Hono } from 'hono';
import type { Sql } from 'postgres';
import { OBJECT_TYPES, type Posting, TIMES, workdaysText } from '../services/applicants.js';
import { waNumber } from './job-poster.js';

export interface PublicJob {
  id: string;
  titel: string;
  art: string | null;
  objektart: string | null;
  stunden_woche: number | null;
  arbeitszeit: string | null;
  arbeitstage: string | null;
  ort: string | null;
  plz: string | null;
  beginn: string | null;
  sprache: string | null;
  aufgaben: string | null;
  anforderungen: string | null;
  veroeffentlicht: string;
}

export async function publicJobs(sql: Sql) {
  const rows = await sql<Posting[]>`
    select *, hours::float8 as hours from app.job_postings
     where status = 'aktiv' and website order by created_at desc`;
  const [co] = await sql<
    { legal_name: string; email: string; phone: string | null; job_whatsapp: string | null }[]
  >`
    select legal_name, email, phone, job_whatsapp from app.company where id = 1`;
  const phone = co?.job_whatsapp ?? co?.phone ?? '';
  const jobs: PublicJob[] = rows.map((p) => ({
    id: p.id,
    titel: p.title,
    art: p.job_type,
    objektart: OBJECT_TYPES.find(([v]) => v === p.object_type)?.[1] ?? p.object_type,
    stunden_woche: p.hours,
    arbeitszeit: p.time_of_day ? (TIMES[p.time_of_day] ?? p.time_of_day) : null,
    arbeitstage: workdaysText(p.workdays ?? {}) || null,
    ort: p.city,
    plz: p.postal_code,
    beginn: p.start_on,
    sprache: p.language,
    aufgaben: p.tasks,
    anforderungen: p.requirements,
    veroeffentlicht: new Date(p.created_at).toISOString().slice(0, 10),
  }));
  return {
    firma: co?.legal_name ?? '',
    kontakt: { telefon: phone || null, whatsapp: phone ? waNumber(phone) : null, email: co?.email ?? null },
    stellen: jobs,
  };
}

/** Einbau-Skript: rendert die Liste in #viva-stellen (bzw. [data-viva-stellen]); eigene CSS-Klassen mit Präfix. */
function embedJs(origin: string) {
  return `(function(){
var O=${JSON.stringify(origin)};
function e(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function d(s){if(!s)return'';var p=s.split('-');return p[2]+'.'+p[1]+'.'+p[0];}
function ul(s){if(!s)return'';var a=String(s).split(/\\r?\\n|[\\u2022;]/).map(function(x){return x.replace(/^[\\s\\-\\u2013*\\u00b7]+/,'').trim();}).filter(Boolean);return a.length?'<ul>'+a.map(function(x){return'<li>'+e(x)+'</li>';}).join('')+'</ul>':'';}
var css='.vvs{font:inherit;color:inherit}.vvs-job{border:1px solid #e5dfe1;border-left:4px solid #7D1435;border-radius:10px;padding:16px 18px;margin:0 0 14px;background:#fff}'
+'.vvs-job h3{margin:0 0 6px;color:#7D1435;font-size:1.2em}.vvs-meta{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:.92em;color:#444;margin:0 0 8px}'
+'.vvs-job h4{margin:10px 0 4px;font-size:.95em}.vvs-job ul{margin:0 0 0 18px;padding:0}.vvs-btns{margin-top:12px;display:flex;flex-wrap:wrap;gap:8px}'
+'.vvs-btn{display:inline-block;padding:9px 16px;border-radius:8px;text-decoration:none!important;font-weight:600;color:#fff!important;background:#7D1435}'
+'.vvs-btn.wa{background:#25D366}.vvs-none{padding:14px;border:1px dashed #ccc;border-radius:10px;color:#555}';
function render(el,data){
var k=data.kontakt||{};var j=data.stellen||[];
if(!j.length){el.innerHTML='<div class="vvs"><div class="vvs-none">Derzeit sind keine Stellen ausgeschrieben. Initiativbewerbungen sind jederzeit willkommen'+(k.email?': <a href="mailto:'+e(k.email)+'">'+e(k.email)+'</a>':'.')+'</div></div>';return;}
el.innerHTML='<div class="vvs">'+j.map(function(s){
var m=[];if(s.ort)m.push('\\ud83d\\udccd '+e((s.plz?s.plz+' ':'')+s.ort));if(s.stunden_woche)m.push(e(String(s.stunden_woche).replace('.',','))+' Std./Woche');
if(s.arbeitszeit)m.push(e(s.arbeitszeit));if(s.arbeitstage)m.push(e(s.arbeitstage));m.push(s.beginn?'ab '+d(s.beginn):'ab sofort');if(s.objektart)m.push(e(s.objektart));
var wt=encodeURIComponent('Hallo, ich interessiere mich f\\u00fcr die Stelle \\u201e'+s.titel+'\\u201c'+(s.ort?' in '+s.ort:'')+'.');
var b=[];if(k.whatsapp)b.push('<a class="vvs-btn wa" target="_blank" rel="noopener" href="https://wa.me/'+e(k.whatsapp)+'?text='+wt+'">Per WhatsApp bewerben</a>');
if(k.email)b.push('<a class="vvs-btn" href="mailto:'+e(k.email)+'?subject='+encodeURIComponent('Bewerbung: '+s.titel)+'">Per E-Mail bewerben</a>');
if(k.telefon)b.push('<a class="vvs-btn" href="tel:'+e(String(k.telefon).replace(/[^+\\d]/g,''))+'">Anrufen</a>');
return'<div class="vvs-job"><h3>'+e(s.titel)+'</h3><div class="vvs-meta">'+m.map(function(x){return'<span>'+x+'</span>';}).join('')+'</div>'
+(s.aufgaben?'<h4>Ihre Aufgaben</h4>'+ul(s.aufgaben):'')+(s.anforderungen?'<h4>Was wir erwarten</h4>'+ul(s.anforderungen):'')
+'<div class="vvs-btns">'+b.join('')+'</div></div>';}).join('')+'</div>';}
function go(){
var els=document.querySelectorAll('#viva-stellen,[data-viva-stellen]');if(!els.length)return;
if(!document.getElementById('vvs-css')){var st=document.createElement('style');st.id='vvs-css';st.textContent=css;document.head.appendChild(st);}
fetch(O+'/oeffentlich/stellen.json',{credentials:'omit'}).then(function(r){return r.json();}).then(function(data){
for(var i=0;i<els.length;i++)render(els[i],data);}).catch(function(){for(var i=0;i<els.length;i++)els[i].innerHTML='<div class="vvs-none">Stellen konnten nicht geladen werden.</div>';});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);else go();
})();`;
}

/** Adresse der App von außen (hinter Caddy https). */
export function publicOrigin(host: string | undefined, proto: string | undefined) {
  const h = host ?? 'app.viva-deluxe-reinigung.de';
  const p = proto ?? (/^(localhost|127\.)/.test(h) ? 'http' : 'https');
  return `${p}://${h}`;
}

export const EMBED_SNIPPET = (origin: string) =>
  `<div id="viva-stellen"></div>\n<script src="${origin}/oeffentlich/stellen.js" async></script>`;

export function registerPublicJobRoutes<E extends Env>(app: Hono<E>, sql: Sql) {
  const cors = (c: { header: (k: string, v: string) => void }) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Cross-Origin-Resource-Policy', 'cross-origin');
    c.header('Cache-Control', 'public, max-age=300');
  };
  const origin = (c: { req: { header: (k: string) => string | undefined } }) =>
    publicOrigin(c.req.header('x-forwarded-host') ?? c.req.header('host'), c.req.header('x-forwarded-proto'));

  app.get('/oeffentlich/stellen.json', async (c) => {
    cors(c);
    return c.json(await publicJobs(sql));
  });
  app.get('/oeffentlich/stellen.js', (c) => {
    cors(c);
    c.header('Content-Type', 'application/javascript; charset=utf-8');
    return c.body(embedJs(origin(c)));
  });
  app.get('/oeffentlich/stellen', (c) => {
    cors(c);
    return c.html(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offene Stellen</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:16px;color:#1a171a}</style></head>
<body><div id="viva-stellen">Stellen werden geladen …</div><script src="/oeffentlich/stellen.js"></script></body></html>`);
  });
}
