import { createHash, randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Child, FC } from 'hono/jsx';
import { hourBerlin, todayBerlin } from '../../domain/invoice/calc.js';
import { addDays } from '../../domain/time/holidays.js';
import {
  type AbsenceKind,
  ABSENCE_LABEL,
  leaveBalance,
  listAbsences,
  requestAbsence,
} from '../../services/absences.js';
import { login, signSession, verifySession } from '../../services/employee-auth.js';
import {
  getRequest,
  originalPdf,
  requestsForEmployee,
  signRequest,
  signedPdf,
} from '../../services/sign-documents.js';
import { BusinessError } from '../../services/errors.js';
import {
  clock,
  clockIn,
  clockOut,
  confirmPlanned,
  hm,
  listEntries,
  netMinutes,
  plannedShifts,
  requestCorrection,
  runningEntry,
  BREAK_AFTER_MINUTES,
  setRunningBreak,
} from '../../services/time.js';
import type { AppEnv, Ctx } from '../app.js';
import { SIGN_JS } from '../routes-orders.js';
import { latestSignature, monthToSign, signTimesheet, timesheet } from '../../services/timesheet.js';
import { type Lang, LANGS, LOCALE, isLang, t } from './i18n.js';

const COOKIE = 'vd_m';
const LANG_COOKIE = 'vd_lang';

interface Me {
  id: string;
  personnel_no: string;
  first_name: string;
  lang: Lang;
  sites: { id: string; name: string; site_no: string }[];
}

export const CSS = `
@font-face{font-family:Inter;font-weight:100 900;font-display:swap;src:url(/static/inter-latin.woff2) format("woff2")}
:root{--brand:#7D1435;--brand-d:#5c0e27;--brand-50:#faf3f5;--ink:#1b1f24;--mut:#5b6270;--line:#e2e5ea;--bg:#f4f5f7;--ok:#15803d;--ok-50:#ecfdf3;--err:#b42318;--err-50:#fef3f2;--warn:#b45309;--warn-50:#fffbeb}
*{box-sizing:border-box}
body{margin:0;font:17px/1.45 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg);-webkit-text-size-adjust:100%}
header{background:#fff;border-bottom:1px solid var(--line);padding:calc(10px + env(safe-area-inset-top,0px)) 16px 10px;display:flex;align-items:center;gap:12px}
header img{height:30px;width:auto}
header .sp{flex:1}
header a,header button{color:var(--mut);font-size:15px;background:none;border:0;padding:6px;font:inherit;font-size:15px;cursor:pointer;text-decoration:none}
main{max-width:560px;margin:0 auto;padding:16px 16px calc(40px + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;gap:14px}
h1{font-size:22px;margin:4px 0 0;font-weight:650}
h2{font-size:17px;margin:0 0 10px;font-weight:650}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px}
.big{display:flex;align-items:center;justify-content:center;width:100%;min-height:64px;border-radius:12px;border:0;font:inherit;font-size:20px;font-weight:650;cursor:pointer;text-decoration:none}
.go{background:var(--brand);color:#fff}.go:active{background:var(--brand-d)}
.stop{background:#1b1f24;color:#fff}
.sec{background:#fff;color:var(--ink);border:1px solid var(--line);font-size:17px;min-height:52px}
label{display:block;font-size:15px;color:var(--mut);margin:10px 0 6px;font-weight:550}
input,select,textarea{width:100%;font:inherit;font-size:18px;padding:12px;border:1px solid #cfd4db;border-radius:10px;background:#fff;color:var(--ink)}
input:focus,select:focus,textarea:focus{outline:3px solid #f3d6df;border-color:var(--brand)}
.chk{display:flex;gap:12px;align-items:flex-start;margin:12px 0}
.chk input{width:26px;height:26px;flex:none;accent-color:var(--brand);margin-top:2px}
.chk label{margin:0;color:var(--ink);font-size:17px}
.run{background:var(--ok-50);border-color:#bbf7d0}
.run .t{font-size:34px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--ok)}
.flash{border-radius:12px;padding:14px 16px;font-weight:550}
.flash.ok{background:var(--ok-50);color:#14532d;border:1px solid #bbf7d0}
.flash.err{background:var(--err-50);color:#7a271a;border:1px solid #fecdca}
.hint{font-size:15px;color:var(--mut);margin:8px 0 0}
.warn{background:var(--warn-50);border-color:#fde68a}
.row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.row .r{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.mut{color:var(--mut)}.small{font-size:14px}
.note{font-size:14px;background:#fff8e6;border-left:3px solid #d39b24;padding:6px 10px;margin-top:6px;white-space:pre-line;border-radius:4px}
.pill{display:inline-block;font-size:13px;font-weight:600;border-radius:999px;padding:1px 9px;background:#eef0f3;color:var(--mut)}
.pill.ok{background:var(--ok-50);color:var(--ok)}.pill.warn{background:var(--warn-50);color:var(--warn)}.pill.err{background:var(--err-50);color:var(--err)}
.links{display:grid;gap:10px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.langs{display:flex;flex-wrap:wrap;gap:8px}
.langs a{padding:8px 12px;border:1px solid var(--line);border-radius:999px;background:#fff;color:var(--ink);text-decoration:none;font-size:15px}
.langs a.on{border-color:var(--brand);color:var(--brand);font-weight:650}
button[disabled]{opacity:.6}
.brk{margin-top:12px;padding:12px;border-radius:12px;background:rgba(255,255,255,.65);border:1px solid #e3d9dc;text-align:left}
.brk details{margin-top:8px}.brk summary{cursor:pointer;color:#7D1435;font-weight:600}
button.link{background:none;border:0;color:#7D1435;font:inherit;font-weight:600;padding:8px 0;cursor:pointer}
#scanner{position:fixed;inset:0;background:#000;z-index:10;display:flex;flex-direction:column}
#scanner[hidden]{display:none}
#scanner video{flex:1;width:100%;object-fit:cover}
#scanner button{margin:16px;margin-bottom:calc(16px + env(safe-area-inset-bottom,0px))}
canvas.sig{width:100%;height:200px;border:2px dashed #cfd4db;border-radius:12px;background:#fff;touch-action:none;display:block}
/* ---- Runde 11: Look wie Fortytools-App, in Viva-Bordeaux ---- */
:root{--ink:#2a1420;--mut:#6f5c64;--line:#eadfe3;--bg:#f7eff2}
body{background:#f7eff2;background-image:radial-gradient(120% 60% at 110% -10%,#ecd3dc 0,rgba(236,211,220,0) 60%),radial-gradient(90% 50% at -20% 30%,#f3e1e7 0,rgba(243,225,231,0) 60%),linear-gradient(180deg,#f8edf1 0%,#fbf7f8 70%);background-attachment:fixed;min-height:100vh}
header{background:transparent;border:0}
header a,header button{color:var(--mut)}
main{padding-bottom:calc(110px + env(safe-area-inset-bottom,0px))}
.card{background:rgba(255,255,255,.82);border:0;border-radius:20px;box-shadow:0 1px 2px rgba(80,20,40,.05),0 8px 24px rgba(80,20,40,.06);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.big{border-radius:16px}
.sec{background:rgba(255,255,255,.9);border:1px solid #eadfe3}
.stop{background:#5c0e27;color:#fff}.stop:active{background:#470a1e}
.go{background:linear-gradient(135deg,#8B2332,#7D1435)}
.run{background:rgba(255,255,255,.9)}.run .t{color:#7D1435}
.hello{font-size:34px;line-height:1.1;font-weight:400;margin:8px 0 4px;color:#2a1420}.hello b{display:block;font-weight:800}
.quick{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:6px 0 2px}
.quick a,.quick button{display:flex;flex-direction:column;align-items:center;gap:6px;text-decoration:none;color:var(--mut);font:inherit;font-size:12.5px;background:none;border:0;padding:0;cursor:pointer;text-align:center}
.quick .qi{width:100%;height:54px;border-radius:999px;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 2px rgba(80,20,40,.06),0 6px 16px rgba(80,20,40,.06);color:#7D1435}
.quick .qi svg{width:24px;height:24px}
.today{display:flex;align-items:center;gap:10px;margin-top:6px}
.today h2{margin:0;font-size:19px;flex:1}
.stats{display:flex;align-items:center;gap:0;font-size:15px;font-weight:650;color:#2a1420}
.stats span{display:flex;align-items:center;gap:5px;padding:0 10px;white-space:nowrap;border-left:1px solid #e3d3d9}.stats span:first-child{border-left:0}
.stats svg{width:18px;height:18px;color:#7D1435}
.prog{height:8px;border-radius:999px;background:#ecdde3;overflow:hidden}.prog i{display:block;height:100%;background:linear-gradient(90deg,#b34a6a,#7D1435);border-radius:999px}
.shift{display:block;text-decoration:none;color:inherit;background:rgba(255,255,255,.82);border-radius:20px;padding:16px 18px;box-shadow:0 1px 2px rgba(80,20,40,.05),0 8px 24px rgba(80,20,40,.06)}
.shift .w{font-size:15px;color:var(--mut);display:flex;justify-content:space-between}
.shift .s{font-size:19px;font-weight:650;margin-top:4px}
.shift.done .w b{color:#15803d}
.shift.open{border:2px solid #f0c8d4}
.shift .confirm{margin-top:10px;padding-top:10px;border-top:1px solid #f0e4e8}
.shift .confirm .chk label{font-size:15px}
.fab{position:fixed;right:20px;bottom:calc(92px + env(safe-area-inset-bottom,0px));width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#9b2a45,#7D1435);color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 24px rgba(125,20,53,.35);z-index:20;text-decoration:none}
.fab svg{width:30px;height:30px}
.tabbar{position:fixed;left:0;right:0;bottom:0;background:rgba(255,255,255,.96);border-top:1px solid #eadfe3;display:grid;grid-template-columns:repeat(4,1fr);padding:8px 6px calc(8px + env(safe-area-inset-bottom,0px));z-index:15;-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.tabbar a{display:flex;flex-direction:column;align-items:center;gap:3px;color:#5b4650;text-decoration:none;font-size:12.5px;font-weight:550}
.tabbar a i{display:flex;align-items:center;justify-content:center;width:56px;height:30px;border-radius:999px}
.tabbar a svg{width:22px;height:22px}
.tabbar a.on{color:#7D1435}.tabbar a.on i{background:#f3dfe6}
.cal{background:rgba(255,255,255,.82);border-radius:20px;padding:14px 12px 10px;box-shadow:0 1px 2px rgba(80,20,40,.05),0 8px 24px rgba(80,20,40,.06)}
.cal-h{display:flex;align-items:center;justify-content:space-between;padding:0 6px 8px}
.cal-h b{font-size:19px}.cal-h .stats{font-size:14px}.cal-h .stats span{padding:0 7px}.cal-h .stats svg{width:16px;height:16px}
.cal-g{display:grid;grid-template-columns:repeat(7,1fr);text-align:center;row-gap:4px}
.cal-g .wd{font-size:12px;color:#a08f96;padding-bottom:6px}
.cal-g a{display:flex;flex-direction:column;align-items:center;gap:3px;padding:6px 0;border-radius:12px;color:#2a1420;text-decoration:none;font-size:17px}
.cal-g a .dt{width:6px;height:6px;border-radius:50%;background:transparent}
.cal-g a.has .dt{background:#c9b3bb}.cal-g a.done .dt{background:#15803d}.cal-g a.abs .dt{background:#d39b1c}
.cal-g a.today{color:#7D1435;font-weight:750}
.cal-g a.sel{background:#7D1435;color:#fff}.cal-g a.sel .dt{background:#fff}
.cal-g a.hol{color:#2b6cb0}
`;

// Formulare robust absenden: bei Funkloch Meldung statt Fehlerseite; gleiche ID → nichts doppelt.
const JS = `
(function(){
  document.addEventListener('submit',function(e){
    var f=e.target; if(!f.hasAttribute('data-net'))return; e.preventDefault();
    var b=f.querySelector('button[type=submit],button:not([type])'); if(b){if(b.disabled)return; b.disabled=true;}
    var ctrl=new AbortController(); var tm=setTimeout(function(){ctrl.abort()},20000);
    fetch(f.action,{method:'POST',body:new URLSearchParams(new FormData(f)),credentials:'same-origin',signal:ctrl.signal,headers:{'Content-Type':'application/x-www-form-urlencoded'}})
      .then(function(r){clearTimeout(tm); location.href=r.url;})
      .catch(function(){clearTimeout(tm); if(b)b.disabled=false; var m=document.getElementById('net'); if(m){m.hidden=false; m.scrollIntoView({block:'center'});}});
  });
  var el=document.querySelector('[data-since]');
  if(el){var s=Number(el.getAttribute('data-since'));var tick=function(){var m=Math.max(0,Math.floor((Date.now()-s)/60000));el.textContent=Math.floor(m/60)+':'+String(m%60).padStart(2,'0');};tick();setInterval(tick,15000);
    var br=document.getElementById('break'); if(br&&!br.dataset.touched){var m=(Date.now()-s)/60000; br.value=m>540?45:m>360?30:0; br.addEventListener('input',function(){br.dataset.touched='1'});}}
  // Installierbare App (Service Worker nur für Offline-Hinweis und Schrift/Logo – keine persönlichen Daten im Cache)
  if('serviceWorker' in navigator){navigator.serviceWorker.register('/m/sw.js',{scope:'/m'}).catch(function(){});}
  var standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone||window.Capacitor;
  var inst=document.getElementById('install');
  if(inst&&!standalone){
    var ios=/iphone|ipad|ipod/i.test(navigator.userAgent);
    if(ios){inst.hidden=false; inst.querySelector('.ios').hidden=false;}
    window.addEventListener('beforeinstallprompt',function(ev){ev.preventDefault(); inst.hidden=false; var b=inst.querySelector('button'); b.hidden=false; b.onclick=function(){ev.prompt(); inst.hidden=true;};});
  }
  // QR-Code am Objekt scannen: in der App nativ (Capacitor), im Browser per BarcodeDetector, sonst Kamera-App
  var scan=document.getElementById('scan');
  if(scan){
    var cap=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.BarcodeScanner;
    var web='BarcodeDetector' in window&&navigator.mediaDevices&&navigator.mediaDevices.getUserMedia;
    if(cap||web){scan.hidden=false;}
    var go=function(v){try{var u=new URL(v,location.href); if(u.origin===location.origin&&/^\\/m\\/o\\/[0-9a-f]{32}$/.test(u.pathname)){location.href=u.pathname;}}catch(e){}};
    scan.addEventListener('click',function(){
      if(cap){cap.scan({formats:['QR_CODE']}).then(function(r){if(r&&r.barcodes&&r.barcodes[0])go(r.barcodes[0].rawValue);}).catch(function(){});return;}
      var ov=document.getElementById('scanner'),v=ov.querySelector('video'),stop=false,st=null;
      var end=function(){stop=true; if(st)st.getTracks().forEach(function(t){t.stop()}); ov.hidden=true;};
      ov.querySelector('button').onclick=end; ov.hidden=false;
      navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}}).then(function(s){st=s; v.srcObject=s; return v.play();}).then(function(){
        var det=new window.BarcodeDetector({formats:['qr_code']});
        (function loop(){if(stop)return; det.detect(v).then(function(c){if(c[0]){end(); go(c[0].rawValue);} else setTimeout(loop,250);}).catch(function(){setTimeout(loop,400);});})();
      }).catch(end);
    });
  }
})();`;

/** Service Worker: Offline-Hinweis und Schrift/Logo aus dem Cache. Seiten mit persönlichen Daten werden NIE gecacht. */
const SW_JS = `
var C='vd-m-v1';
self.addEventListener('install',function(e){e.waitUntil(caches.open(C).then(function(c){return c.addAll(['/m/offline','/static/logo.png','/static/inter-latin.woff2','/static/favicon.png']);}).then(function(){return self.skipWaiting();}));});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==C;}).map(function(k){return caches.delete(k);}));}).then(function(){return self.clients.claim();}));});
self.addEventListener('fetch',function(e){
  var r=e.request; if(r.method!=='GET')return;
  var u=new URL(r.url); if(u.origin!==location.origin)return;
  if(u.pathname.indexOf('/static/')===0){e.respondWith(caches.match(r).then(function(m){return m||fetch(r);}));return;}
  if(r.mode==='navigate'&&(u.pathname==='/m'||u.pathname.indexOf('/m/')===0)){e.respondWith(fetch(r).catch(function(){return caches.match('/m/offline');}));}
});`;

const ICON: Record<string, string> = {
  building:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M3 21h18M8 8h3M8 12h3M8 16h3"/></svg>',
  ticket:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h4v4H7zM14 9h3M14 13h3M7 17h10"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 6 2 2 3-3M3 13l2 2 3-3M11 6h10M11 13h10M11 19h10"/></svg>',
  search:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  monitor:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  party:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20 9 7l8 8z"/><path d="M14 4c1 1 1 2 0 3M18 6h2M17 10l2 1M15 3l1-1"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  arrow:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg>',
  times:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M21 14v7h-4M14 21v-3"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M7 12h10"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  watch:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M10 2h4"/></svg>',
  coffee:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 8h1a4 4 0 0 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"/><path d="M6 2v3M10 2v3M14 2v3"/></svg>',
  clock:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};
export const Ic: FC<{ n: string }> = ({ n }) => (
  <span style="display:contents" dangerouslySetInnerHTML={{ __html: ICON[n] ?? '' }} />
);

const MLayout: FC<{
  lang: Lang;
  path?: string;
  me?: Me | null;
  flash: { ok?: string | undefined; err?: string | undefined };
  children?: Child;
}> = ({ lang, path = '/m', me, flash, children }) => (
  <html lang={lang}>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="theme-color" content="#f8edf1" />
      <title>{`${t(lang, 'app')} · Viva-Deluxe`}</title>
      <link rel="icon" type="image/png" href="/static/favicon.png" />
      <link rel="manifest" href="/m/manifest.webmanifest" />
      <link rel="apple-touch-icon" href="/static/apple-touch-icon.png" />
      <meta name="apple-mobile-web-app-capable" content="yes" />
      <meta name="mobile-web-app-capable" content="yes" />
      <meta name="apple-mobile-web-app-title" content="Viva-Deluxe" />
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <header>
        <a href="/m" aria-label="Start">
          <img src="/static/logo-transparent.png" alt="Viva-Deluxe" width="149" height="30" />
        </a>
        <span class="sp" />
        <a href={`/m/sprache`}>{lang.toUpperCase()}</a>
        {me && (
          <form method="post" action="/m/abmelden" style="margin:0">
            <button>{t(lang, 'logout')}</button>
          </form>
        )}
      </header>
      <main>
        {flash.ok && (
          <div class="flash ok" role="status">
            {flash.ok}
          </div>
        )}
        {flash.err && (
          <div class="flash err" role="alert">
            {flash.err}
          </div>
        )}
        <div class="flash err" id="net" role="alert" hidden>
          {t(lang, 'offline')}
        </div>
        {children}
      </main>
      {me && (
        <nav class="tabbar">
          {(
            [
              ['/m', 'home', 'nav_home'],
              ['/m/kalender', 'cal', 'nav_calendar'],
              ['/m/stundenzettel', 'times', 'nav_times'],
              ['/m/abwesenheit', 'sun', 'nav_absence'],
            ] as const
          ).map(([href, ic, key]) => (
            <a href={href} class={(href === '/m' ? path === '/m' : path.startsWith(href)) ? 'on' : ''}>
              <i>
                <Ic n={ic} />
              </i>
              {t(lang, key)}
            </a>
          ))}
        </nav>
      )}
      <script dangerouslySetInnerHTML={{ __html: JS }} />
    </body>
  </html>
);

export function registerMobileRoutes({ app, deps, back }: Ctx) {
  const { sql, env } = deps;
  const secret =
    env.SESSION_SECRET ?? createHash('sha256').update(`dev-session:${env.APP_BASIC_AUTH}`).digest('hex');
  const secure = env.APP_ENV !== 'dev';

  const langOf = (c: Context<AppEnv>, me?: Me | null): Lang => {
    const q = getCookie(c, LANG_COOKIE);
    if (isLang(q)) return q;
    return me?.lang ?? 'de';
  };

  const loadMe = async (c: Context<AppEnv>): Promise<Me | null> => {
    const id = verifySession(secret, getCookie(c, COOKIE));
    if (!id) return null;
    const [e] = await sql<
      { id: string; personnel_no: string; first_name: string; app_language: string; status: string }[]
    >`
      select id, personnel_no, first_name, app_language, status from app.employees where id = ${id}`;
    if (!e || e.status !== 'aktiv') return null;
    const sites = await sql<{ id: string; name: string; site_no: string }[]>`
      select s.id, s.name, s.site_no from app.sites s
       where s.active
         and (exists (select 1 from app.employee_sites es where es.employee_id = ${id} and es.site_id = s.id)
              -- Vertretung heute/morgen: fremdes Objekt vorübergehend auswählbar
              or exists (select 1 from app.shift_exceptions x join app.shift_plans p on p.id = x.shift_plan_id
                          where x.substitute_employee_id = ${id} and p.site_id = s.id and x.kind <> 'ausfall'
                            and x.work_date between (now() at time zone 'Europe/Berlin')::date
                                                and (now() at time zone 'Europe/Berlin')::date + 1))
       order by s.name`;
    return {
      id: e.id,
      personnel_no: e.personnel_no,
      first_name: e.first_name,
      lang: isLang(e.app_language) ? e.app_language : 'de',
      sites,
    };
  };

  const render = (c: Context<AppEnv>, lang: Lang, me: Me | null, body: Child) =>
    c.html(
      '<!doctype html>' +
        String(
          <MLayout
            lang={lang}
            path={c.req.path}
            me={me}
            flash={{ ok: c.req.query('ok'), err: c.req.query('fehler') }}
          >
            {body}
          </MLayout>,
        ),
    );

  /** Fachliche Fehler in der Sprache des Mitarbeiters zurück auf die Seite. */
  const guard = async (c: Context<AppEnv>, lang: Lang, path: string, fn: () => Promise<Response>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BusinessError) {
        const msg = err.code ? t(lang, `e_${err.code}`, err.params) : err.message;
        return back(c, path, { fehler: msg });
      }
      throw err;
    }
  };

  const safeNext = (n: unknown) => (typeof n === 'string' && /^\/m(\/[\w/-]*)?$/.test(n) ? n : '/m');
  const monthName = (lang: Lang, m: string) =>
    new Date(`${m}-15T12:00:00Z`).toLocaleDateString(LOCALE[lang], {
      timeZone: 'UTC',
      month: 'long',
      year: 'numeric',
    });
  const dayLabel = (lang: Lang, d: string) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString(LOCALE[lang], {
      timeZone: 'UTC',
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
    });

  // ---------------------------------------------------------------- Anmeldung

  const LoginForm: FC<{ lang: Lang; next: string }> = ({ lang, next }) => (
    <>
      <h1>{t(lang, 'app')}</h1>
      <form method="post" action="/m/anmelden" class="card" data-net>
        <input type="hidden" name="next" value={next} />
        <label for="pn">{t(lang, 'personnel_no')}</label>
        <input id="pn" name="personnel_no" inputmode="numeric" autocomplete="username" required />
        <label for="pin">{t(lang, 'pin')}</label>
        <input
          id="pin"
          name="pin"
          type="password"
          inputmode="numeric"
          autocomplete="current-password"
          maxlength={6}
          required
        />
        <div style="height:14px" />
        <button class="big go">{t(lang, 'login')}</button>
      </form>
      <LangPicker lang={lang} next={next} />
    </>
  );

  const LangPicker: FC<{ lang: Lang; next: string }> = ({ lang, next }) => (
    <div class="langs" aria-label={t(lang, 'language')}>
      {(Object.keys(LANGS) as Lang[]).map((l) => (
        <a
          href={`/m/sprache?l=${l}&next=${encodeURIComponent(next)}`}
          class={l === lang ? 'on' : ''}
          lang={l}
        >
          {LANGS[l]}
        </a>
      ))}
    </div>
  );

  app.post('/m/anmelden', async (c) => {
    const b = await c.req.parseBody();
    const lang = langOf(c);
    const next = safeNext(b.next);
    try {
      const e = await login(sql, String(b.personnel_no ?? ''), String(b.pin ?? ''));
      setCookie(c, COOKIE, signSession(secret, e.id), {
        httpOnly: true,
        secure,
        sameSite: 'Lax',
        path: '/',
        maxAge: 14 * 86400,
      });
      if (!getCookie(c, LANG_COOKIE) && isLang(e.language))
        setCookie(c, LANG_COOKIE, e.language, { path: '/', maxAge: 365 * 86400, sameSite: 'Lax', secure });
      return c.redirect(next, 303);
    } catch (err) {
      if (err instanceof BusinessError) {
        const msg = /Fehlversuche/.test(err.message) ? t(lang, 'e_locked') : t(lang, 'e_login');
        return c.redirect(
          `/m?fehler=${encodeURIComponent(msg)}${next !== '/m' ? `&next=${encodeURIComponent(next)}` : ''}`,
          303,
        );
      }
      throw err;
    }
  });

  app.post('/m/abmelden', (c) => {
    deleteCookie(c, COOKIE, { path: '/' });
    return c.redirect('/m', 303);
  });

  app.get('/m/sprache', async (c) => {
    const l = c.req.query('l');
    const me = await loadMe(c);
    const next = safeNext(c.req.query('next'));
    if (isLang(l)) {
      setCookie(c, LANG_COOKIE, l, { path: '/', maxAge: 365 * 86400, sameSite: 'Lax', secure });
      if (me) await sql`update app.employees set app_language = ${l} where id = ${me.id}`;
      return c.redirect(`${next}?ok=${encodeURIComponent(t(l, 'msg_lang'))}`, 303);
    }
    const lang = langOf(c, me);
    return render(
      c,
      lang,
      me,
      <>
        <h1>{t(lang, 'language')}</h1>
        <LangPicker lang={lang} next={next} />
      </>,
    );
  });

  // ---------------------------------------------------------------- Startseite

  /** „Soll als Ist“: Zeit des geplanten Einsatzes bestätigen (Häkchen Pflicht), direkt in der Einsatz-Karte. */
  const ConfirmBox: FC<{
    lang: Lang;
    s: { plan: { id: string; start_time: string; end_time: string; site_name: string }; date: string };
  }> = ({ lang, s }) => (
    <form method="post" action="/m/bestaetigen" class="confirm" data-net>
      <input type="hidden" name="plan_id" value={s.plan.id} />
      <input type="hidden" name="date" value={s.date} />
      <div class="chk">
        <input type="checkbox" id={`c-${s.plan.id}-${s.date}`} name="confirm" value="1" required />
        <label for={`c-${s.plan.id}-${s.date}`}>
          {t(lang, 'confirm_text', {
            day: dayLabel(lang, s.date),
            from: s.plan.start_time,
            to: s.plan.end_time,
            site: s.plan.site_name,
          })}
        </label>
      </div>
      <button class="big go">✓ {t(lang, 'confirm_btn')}</button>
    </form>
  );

  const Times: FC<{ lang: Lang; rows: Awaited<ReturnType<typeof listEntries>> }> = ({ lang, rows }) => (
    <div class="card">
      <h2>{t(lang, 'my_times')}</h2>
      {rows.length === 0 && <div class="mut">{t(lang, 'none')}</div>}
      {rows.map((e) => (
        <div class="row">
          <div>
            <div>
              {dayLabel(lang, e.work_date)} · {clock(e.start_at)}–{e.end_at ? clock(e.end_at) : '…'}
            </div>
            <div class="small mut">{e.site_name}</div>
          </div>
          <div class="r">
            <div>{e.end_at ? `${hm(netMinutes(e))} ${t(lang, 'hours')}` : ''}</div>
            <span
              class={`pill ${e.status === 'abgelehnt' ? 'err' : e.status === 'beantragt' ? 'warn' : e.status === 'freigegeben' ? 'ok' : ''}`}
            >
              {t(lang, `st_${e.status}`)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );

  const ClockCard: FC<{
    lang: Lang;
    me: Me;
    running: Awaited<ReturnType<typeof runningEntry>>;
    siteId?: string;
    viaQr?: boolean;
  }> = ({ lang, me, running, siteId, viaQr }) =>
    running ? (
      <div class="card run">
        <div>{t(lang, 'running', { time: clock(running.start_at) })}</div>
        <div class="t" data-since={String(running.start_at.getTime())}>
          {hm(running.gross_minutes)}
        </div>
        <div class="mut">{t(lang, 'at_site', { site: running.site_name })}</div>
        {(() => {
          // Pause: vom Mitarbeiter geändert → so; sonst automatisch nach 4 Std. (30 Min. ab 6 Std.)
          const mine = !!running.break_start_at && !running.break_auto;
          const from = mine
            ? running.break_start_at!
            : new Date(running.start_at.getTime() + BREAK_AFTER_MINUTES * 60000);
          const min = mine ? running.break_minutes : 30;
          const to = new Date(from.getTime() + min * 60000);
          return (
            <div class="brk" data-break-at={String(from.getTime())} data-break-min={String(min)}>
              <b>
                {min
                  ? t(lang, mine ? 'break_mine' : 'break_auto', {
                      from: clock(from),
                      to: clock(to),
                      min: String(min),
                    })
                  : t(lang, 'break_none')}
              </b>
              {!mine && <p class="hint">{t(lang, 'break_rule')}</p>}
              <details>
                <summary>{t(lang, 'break_change')}</summary>
                <form method="post" action="/m/pause" data-net>
                  <div class="two">
                    <div>
                      <label for="bfrom">{t(lang, 'break_from')}</label>
                      <input id="bfrom" type="time" name="start" value={clock(from)} required />
                    </div>
                    <div>
                      <label for="blen">{t(lang, 'break_len')}</label>
                      <select id="blen" name="minutes">
                        {[0, 15, 30, 45, 60].map((m) => (
                          <option value={String(m)} selected={m === min}>
                            {m ? `${m} Min.` : t(lang, 'break_none')}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <button class="big sec">{t(lang, 'break_save')}</button>
                </form>
              </details>
              <button
                type="button"
                class="link"
                id="remind"
                hidden
                data-text={t(lang, 'remind_text', { from: clock(from), min: String(min) })}
              >
                🔔 {t(lang, 'remind_on')}
              </button>
            </div>
          );
        })()}
        <form method="post" action="/m/aus" data-net>
          <div style="height:12px" />
          <button class="big stop">{t(lang, 'clock_out')}</button>
        </form>
        <script dangerouslySetInnerHTML={{ __html: REMIND_JS }} />
      </div>
    ) : (
      <form method="post" action="/m/ein" class="card" data-net>
        <input type="hidden" name="id" value={randomUUID()} />
        <input type="hidden" name="qr" value={viaQr ? '1' : ''} />
        {siteId ? (
          <>
            <input type="hidden" name="site_id" value={siteId} />
          </>
        ) : (
          <>
            <label for="site">{t(lang, 'choose_site')}</label>
            <select id="site" name="site_id" required>
              {me.sites.map((s) => (
                <option value={s.id}>{s.name}</option>
              ))}
            </select>
            <div style="height:12px" />
          </>
        )}
        <button class="big go">{t(lang, 'clock_in')}</button>
      </form>
    );

  app.get('/m', async (c) => {
    const me = await loadMe(c);
    const lang = langOf(c, me);
    if (!me) return render(c, lang, null, <LoginForm lang={lang} next={safeNext(c.req.query('next'))} />);
    const today = todayBerlin();
    const [running, shifts, times, docs] = await Promise.all([
      runningEntry(sql, me.id),
      plannedShifts(sql, { from: addDays(today, -7), to: today, employeeId: me.id }),
      listEntries(sql, { employeeId: me.id, from: addDays(today, -7) }),
      requestsForEmployee(sql, me.id),
    ]);
    const openDocs = docs.filter((d) => d.status === 'offen');
    // Neue Unterweisung/Dokument: beim Öffnen der App direkt zum Lesen und Unterschreiben (bis „Später“ für heute)
    if (openDocs.length && getCookie(c, 'm_doc_later') !== today)
      return c.redirect(`/m/dokumente/${openDocs[0]!.id}?zuerst=1`);
    // Stundenzettel zum Unterschreiben (am Monatsende bzw. Vormonat), nur wenn Zeiten da und nicht unterschrieben
    const signMonth = monthToSign(today);
    const sheet = await timesheet(sql, me.id, signMonth);
    const lastSig = await latestSignature(sql, me.id, signMonth);
    const sheetOpen =
      sheet.rows.some((r) => r.workMinutes || r.absenceMinutes) && lastSig?.sheet_hash !== sheet.hash;
    const nowHm = new Date().toLocaleTimeString('de-DE', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
    });
    const todays = shifts.filter((s) => s.date === today && !s.absence);
    const notes = await siteNotes(todays.map((s) => s.plan.site_id));
    const pastToConfirm = shifts.filter((s) => !s.entry && !s.absence && s.date < today);
    const presetSite = todays.find((s) => !s.entry)?.plan.site_id;
    const doneToday = todays.filter((s) => s.entry).length;
    const todayTimes = times.filter((e) => e.work_date === today && e.status !== 'abgelehnt');
    const workedToday = todayTimes.reduce((a, e) => a + (e.end_at ? netMinutes(e) : e.gross_minutes), 0);
    const breakToday = todayTimes.reduce((a, e) => a + (e.end_at ? e.break_minutes : 0), 0);
    const hour = hourBerlin();
    const greetKey = hour < 11 ? 'greet_morning' : hour < 18 ? 'greet_day' : 'greet_evening';
    return render(
      c,
      lang,
      me,
      <>
        <div class="hello">
          {t(lang, greetKey)}
          <b>{me.first_name}!</b>
        </div>
        <div class="quick">
          <button type="button" id="scan" hidden>
            <span class="qi">
              <Ic n="qr" />
            </span>
            {t(lang, 'q_scan')}
          </button>
          <a href="/m/nachtrag">
            <span class="qi">
              <Ic n="plus" />
            </span>
            {t(lang, 'q_later')}
          </a>
          <a href="/m/abwesenheit">
            <span class="qi">
              <Ic n="sun" />
            </span>
            {t(lang, 'q_absence')}
          </a>
          <a href="/m/dokumente">
            <span class="qi">
              <Ic n="doc" />
            </span>
            {t(lang, 'q_docs')}
          </a>
        </div>
        <div id="scanner" hidden>
          <video playsinline muted></video>
          <button type="button" class="big sec">
            {t(lang, 'scan_cancel')}
          </button>
        </div>
        {sheetOpen && (
          <a class="big go" href={`/m/stundenzettel?monat=${signMonth}`} style="font-size:18px">
            ✍ {t(lang, 'sheet_sign_open', { month: monthName(lang, signMonth) })}
          </a>
        )}
        {openDocs.length > 0 && (
          <a class="big go" href="/m/dokumente" style="font-size:18px">
            ✍ {t(lang, 'docs_open', { n: openDocs.length })}
          </a>
        )}
        {pastToConfirm.length > 0 && (
          <>
            <div class="today">
              <h2>{t(lang, 'confirm_open')}</h2>
            </div>
            {pastToConfirm.map((s) => (
              <div class="shift open">
                <div class="w">
                  <span>
                    {dayLabel(lang, s.date)} · {s.plan.start_time}–{s.plan.end_time}
                  </span>
                </div>
                <div class="s">{s.plan.site_name}</div>
                <ConfirmBox lang={lang} s={s} />
              </div>
            ))}
          </>
        )}
        <div class="today">
          <h2>{t(lang, 'today_short')}</h2>
          <div class="stats">
            <span title={t(lang, 'stat_shifts')}>
              <Ic n="watch" />
              {doneToday} / {todays.length}
            </span>
            <span title={t(lang, 'stat_hours')}>
              <Ic n="clock" />
              {hm(workedToday)}h
            </span>
            <span title={t(lang, 'stat_break')}>
              <Ic n="coffee" />
              {hm(breakToday)}h
            </span>
          </div>
        </div>
        <div class="prog">
          <i style={`width:${todays.length ? Math.round((doneToday / todays.length) * 100) : 0}%`} />
        </div>
        {todays.length === 0 && <div class="card mut">{t(lang, 'no_plan')}</div>}
        {todays.map((s) => (
          <div class={`shift${s.entry ? ' done' : ''}`}>
            <div class="w">
              <span>
                {dayLabel(lang, s.date)} · {s.plan.start_time}–{s.plan.end_time}
              </span>
              {s.entry && <b>✓ {t(lang, `st_${s.entry.status}`)}</b>}
            </div>
            <div class="s">{s.plan.site_name}</div>
            {notes.get(s.plan.site_id) && <div class="note">{notes.get(s.plan.site_id)}</div>}
            {!s.entry && s.plan.end_time <= nowHm && <ConfirmBox lang={lang} s={s} />}
          </div>
        ))}
        <div id="clock" />
        <ClockCard
          lang={lang}
          me={{
            ...me,
            sites: presetSite
              ? [...me.sites].sort((a, b) => Number(b.id === presetSite) - Number(a.id === presetSite))
              : me.sites,
          }}
          running={running}
        />
        <a class="fab" href="#clock" aria-label={t(lang, 'clock_now')}>
          <Ic n="watch" />
        </a>
        <Times lang={lang} rows={times} />
        <div class="card" id="install" hidden>
          <button type="button" class="big sec" hidden>
            {t(lang, 'install')}
          </button>
          <p class="hint ios" hidden>
            {t(lang, 'install')}: {t(lang, 'install_ios')}
          </p>
        </div>
      </>,
    );
  });

  // Seiten hinter der Anmeldung
  const requireMe = async (c: Context<AppEnv>) => {
    const me = await loadMe(c);
    if (!me) {
      const lang = langOf(c);
      return {
        me: null,
        res: c.redirect(
          `/m?next=${encodeURIComponent(c.req.path)}&fehler=${encodeURIComponent(t(lang, 'e_session'))}`,
          303,
        ),
      };
    }
    return { me, res: null };
  };

  // QR-Code am Objekt
  /** Einsatzort-Notizen des Kunden je Objekt (Kunde → Zusatzinformationen). */
  const siteNotes = async (ids: string[]) => {
    const rows = ids.length
      ? await sql<{ id: string; site_notes: string | null }[]>`
          select s.id, c.site_notes from app.sites s join app.customers c on c.id = s.customer_id
           where s.id in ${sql([...new Set(ids)])}`
      : [];
    return new Map(rows.filter((r) => r.site_notes).map((r) => [r.id, r.site_notes!] as const));
  };

  app.get('/m/o/:token{[0-9a-f]{32}}', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    const lang = langOf(c, me);
    const [site] = await sql<
      { id: string; name: string }[]
    >`select id, name from app.sites where clock_token = ${c.req.param('token')} and active`;
    if (!site) return back(c, '/m', { fehler: t(lang, 'e_unknown_site') });
    const running = await runningEntry(sql, me.id);
    return render(
      c,
      lang,
      me,
      <>
        <h1>{site.name}</h1>
        {(await siteNotes([site.id])).get(site.id) && (
          <div class="card note">{(await siteNotes([site.id])).get(site.id)}</div>
        )}
        <ClockCard lang={lang} me={me} running={running} siteId={site.id} viaQr />
        <a class="big sec" href="/m">
          {t(lang, 'back')}
        </a>
      </>,
    );
  });

  app.post('/m/ein', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    const lang = langOf(c, me);
    const b = await c.req.parseBody();
    const ref = c.req.header('referer');
    const from = ref ? new URL(ref).pathname : '/m';
    return guard(c, lang, from, async () => {
      const id = typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : randomUUID();
      await clockIn(sql, {
        id,
        employeeId: me.id,
        siteId: String(b.site_id ?? ''),
        viaQr: b.qr === '1',
        actor: `m:${me.personnel_no}`,
      });
      const e = await runningEntry(sql, me.id);
      return back(c, '/m', { ok: t(lang, 'msg_in', { time: clock(e?.start_at ?? new Date()) }) });
    });
  });

  app.post('/m/aus', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    const lang = langOf(c, me);
    const b = await c.req.parseBody();
    return guard(c, lang, '/m', async () => {
      await clockOut(sql, {
        employeeId: me.id,
        // ohne Angabe: automatische bzw. vorher in der App geänderte Pause
        breakMinutes:
          typeof b.break_minutes === 'string' && b.break_minutes.trim() !== ''
            ? Number(b.break_minutes) || 0
            : null,
        actor: `m:${me.personnel_no}`,
      });
      const today = await listEntries(sql, {
        employeeId: me.id,
        from: todayBerlin(),
        to: todayBerlin(),
        status: ['erfasst', 'freigegeben'],
      });
      return back(c, '/m', {
        ok: t(lang, 'msg_out', { dur: hm(today.reduce((s, e) => s + netMinutes(e), 0)) }),
      });
    });
  });

  // ---------------------------------------------------------------- Kalender

  app.get('/m/kalender', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    const lang = langOf(c, me);
    const today = todayBerlin();
    const q = c.req.query('tag');
    const sel = q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : today;
    const first = `${today.slice(0, 7)}-01`;
    const months = [first.slice(0, 7), addDays(addDays(first, 32).slice(0, 8) + '01', 0).slice(0, 7)];
    const end = addDays(`${addDays(`${months[1]}-01`, 32).slice(0, 7)}-01`, -1);
    const [shifts, entries] = await Promise.all([
      plannedShifts(sql, { from: first, to: end, employeeId: me.id }),
      listEntries(sql, { employeeId: me.id, from: first, to: end }),
    ]);
    const wd = Array.from({ length: 7 }, (_, i) =>
      new Date(Date.UTC(2026, 9, 5 + i)).toLocaleDateString(LOCALE[lang], {
        timeZone: 'UTC',
        weekday: 'short',
      }),
    );
    const daySel = shifts.filter((x) => x.date === sel);
    const nowHm = new Date().toLocaleTimeString('de-DE', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
    });
    return render(
      c,
      lang,
      me,
      <>
        <h1>{t(lang, 'nav_calendar')}</h1>
        {months.map((m) => {
          const ms = shifts.filter((x) => x.date.startsWith(m));
          const me2 = entries.filter(
            (e) => e.work_date.startsWith(m) && e.status !== 'abgelehnt' && e.end_at,
          );
          const startDow = (new Date(`${m}-01T12:00:00Z`).getUTCDay() + 6) % 7;
          const days = Number(addDays(`${addDays(`${m}-01`, 32).slice(0, 7)}-01`, -1).slice(8));
          return (
            <div class="cal">
              <div class="cal-h">
                <b>{monthName(lang, m).split(' ')[0]}</b>
                <div class="stats">
                  <span>
                    <Ic n="watch" />
                    {ms.filter((x) => x.entry).length} / {ms.length}
                  </span>
                  <span>
                    <Ic n="clock" />
                    {hm(me2.reduce((a, e) => a + netMinutes(e), 0))}h
                  </span>
                  <span>
                    <Ic n="coffee" />
                    {hm(me2.reduce((a, e) => a + e.break_minutes, 0))}h
                  </span>
                </div>
              </div>
              <div class="cal-g">
                {wd.map((w) => (
                  <div class="wd">{w}</div>
                ))}
                {Array.from({ length: startDow }, () => (
                  <div />
                ))}
                {Array.from({ length: days }, (_, i) => {
                  const d = `${m}-${String(i + 1).padStart(2, '0')}`;
                  const ds = ms.filter((x) => x.date === d);
                  const cls = [
                    ds.length
                      ? ds.some((x) => x.absence)
                        ? 'abs'
                        : ds.every((x) => x.entry)
                          ? 'done'
                          : 'has'
                      : '',
                    d === today ? 'today' : '',
                    d === sel ? 'sel' : '',
                    ds[0]?.holiday ? 'hol' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <a href={`/m/kalender?tag=${d}`} class={cls}>
                      {i + 1}
                      <span class="dt" />
                    </a>
                  );
                })}
              </div>
            </div>
          );
        })}
        <h2>{dayLabel(lang, sel)}</h2>
        {daySel.length === 0 && <div class="card mut">{t(lang, 'cal_none')}</div>}
        {daySel.map((s2) => (
          <div class={`shift${s2.entry ? ' done' : ''}`}>
            <div class="w">
              <span>
                {s2.plan.start_time}–{s2.plan.end_time}
              </span>
              {s2.entry ? (
                <b>✓ {t(lang, `st_${s2.entry.status}`)}</b>
              ) : s2.absence ? (
                <b style="color:#b45309">{t(lang, s2.absence)}</b>
              ) : null}
            </div>
            <div class="s">{s2.plan.site_name}</div>
            {!s2.entry &&
              !s2.absence &&
              sel >= addDays(today, -7) &&
              (sel < today || (sel === today && s2.plan.end_time <= nowHm)) && (
                <ConfirmBox lang={lang} s={s2} />
              )}
          </div>
        ))}
      </>,
    );
  });

  // ---------------------------------------------------------------- Stundenzettel

  app.get('/m/stundenzettel', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    const lang = langOf(c, me);
    const q = c.req.query('monat');
    const month = q && /^\d{4}-\d{2}$/.test(q) ? q : monthToSign();
    const sheet = await timesheet(sql, me.id, month);
    const sig = await latestSignature(sql, me.id, month);
    const signedNow = sig?.sheet_hash === sheet.hash;
    const tt = sheet.totals;
    return render(
      c,
      lang,
      me,
      <>
        <h1>{t(lang, 'sheet_title', { month: monthName(lang, month) })}</h1>
        <div class="card">
          {sheet.rows
            .filter((r) => r.workMinutes || r.absenceMinutes || r.start)
            .map((r) => (
              <div class="row">
                <div>
                  {dayLabel(lang, r.date)}
                  <div class="small mut">
                    {r.site ?? ''}
                    {r.start && ` · ${r.start}–${r.end ?? '…'}`}
                    {r.breakFrom && ` · ${t(lang, 'col_break')} ${r.breakFrom}–${r.breakTo}`}
                    {r.absence && ` · ${t(lang, r.absence)}`}
                  </div>
                </div>
                <div class="r">
                  {hm(r.workMinutes || r.absenceMinutes)} {t(lang, 'col_hours')}
                </div>
              </div>
            ))}
          <div class="row">
            <div>{t(lang, 'sum_work')}</div>
            <div class="r">
              <b>{hm(tt.work)}</b>
            </div>
          </div>
          {tt.vacation > 0 && (
            <div class="row">
              <div>{t(lang, 'sum_vac')}</div>
              <div class="r">{hm(tt.vacation)}</div>
            </div>
          )}
          {tt.sick > 0 && (
            <div class="row">
              <div>{t(lang, 'sum_sick')}</div>
              <div class="r">{hm(tt.sick)}</div>
            </div>
          )}
          {tt.unpaid > 0 && (
            <div class="row">
              <div>{t(lang, 'sum_unpaid')}</div>
              <div class="r">{hm(tt.unpaid)}</div>
            </div>
          )}
          <div class="row">
            <div>
              <b>{t(lang, 'sum_paid')}</b>
            </div>
            <div class="r">
              <b>{hm(tt.paid)}</b>
            </div>
          </div>
        </div>
        {signedNow ? (
          <div class="card run">
            <b>
              ✓{' '}
              {t(lang, 'sheet_signed', {
                date: sig!.signed_at.toLocaleString(LOCALE[lang], {
                  timeZone: 'Europe/Berlin',
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })}
            </b>
          </div>
        ) : (
          <form method="post" action={`/m/stundenzettel?monat=${month}`} class="card">
            {sig && (
              <p class="hint" style="color:var(--err)">
                {t(lang, 'sheet_changed')}
              </p>
            )}
            <div class="chk">
              <input type="checkbox" id="ok" name="read" value="1" required />
              <label for="ok">{t(lang, 'sheet_confirm')}</label>
            </div>
            <label>{t(lang, 'doc_sign_here')}</label>
            <canvas id="sig" class="sig"></canvas>
            <input type="hidden" id="sig-png" name="png" />
            <p class="hint" id="sig-hint" style="color:var(--err)" hidden>
              {t(lang, 'e_signature')}
            </p>
            <div class="two" style="margin-top:12px">
              <button type="button" class="big sec" id="sig-clear">
                {t(lang, 'doc_clear')}
              </button>
              <button class="big go">{t(lang, 'doc_sign_btn')}</button>
            </div>
          </form>
        )}
        <a class="big sec" href="/m">
          {t(lang, 'back')}
        </a>
        {!signedNow && <script dangerouslySetInnerHTML={{ __html: SIGN_JS }} />}
      </>,
    );
  });

  app.post('/m/stundenzettel', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    const lang = langOf(c, me);
    const q = c.req.query('monat') ?? '';
    const month = /^\d{4}-\d{2}$/.test(q) ? q : monthToSign();
    const b = await c.req.parseBody();
    return guard(c, lang, `/m/stundenzettel?monat=${month}`, async () => {
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.png ?? ''));
      if (!m) throw new BusinessError('Unterschrift fehlt', 'signature');
      await signTimesheet(deps, {
        employeeId: me.id,
        month,
        png: new Uint8Array(Buffer.from(m[1]!, 'base64')),
        confirmed: b.read === '1',
        ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        userAgent: c.req.header('user-agent') ?? null,
      });
      return back(c, `/m/stundenzettel?monat=${month}`, { ok: t(lang, 'msg_sheet_signed') });
    });
  });

  app.post('/m/pause', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    const lang = langOf(c, me);
    const b = await c.req.parseBody();
    return guard(c, lang, '/m', async () => {
      await setRunningBreak(sql, {
        employeeId: me.id,
        start: String(b.start ?? ''),
        minutes: Number(b.minutes ?? 0) || 0,
        actor: `m:${me.personnel_no}`,
      });
      return back(c, '/m', { ok: t(lang, 'msg_break') });
    });
  });

  app.post('/m/bestaetigen', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    const lang = langOf(c, me);
    const b = await c.req.parseBody();
    return guard(c, lang, '/m', async () => {
      await confirmPlanned(sql, {
        employeeId: me.id,
        planId: String(b.plan_id ?? ''),
        date: String(b.date ?? ''),
        confirmed: b.confirm === '1',
        actor: `m:${me.personnel_no}`,
      });
      return back(c, '/m', { ok: t(lang, 'msg_confirmed') });
    });
  });

  // ---------------------------------------------------------------- Nachtrag

  app.get('/m/nachtrag', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    const lang = langOf(c, me);
    const today = todayBerlin();
    return render(
      c,
      lang,
      me,
      <>
        <h1>{t(lang, 'correction')}</h1>
        <form method="post" action="/m/nachtrag" class="card" data-net>
          <input type="hidden" name="id" value={randomUUID()} />
          <label for="date">{t(lang, 'date')}</label>
          <input
            id="date"
            type="date"
            name="date"
            value={today}
            max={today}
            min={addDays(today, -31)}
            required
          />
          <label for="site">{t(lang, 'choose_site')}</label>
          <select id="site" name="site_id" required>
            {me.sites.map((s) => (
              <option value={s.id}>{s.name}</option>
            ))}
          </select>
          <div class="two">
            <div>
              <label for="from">{t(lang, 'from')}</label>
              <input id="from" type="time" name="start" required />
            </div>
            <div>
              <label for="to">{t(lang, 'to')}</label>
              <input id="to" type="time" name="end" required />
            </div>
          </div>
          <label for="break">{t(lang, 'break')}</label>
          <input
            id="break"
            type="number"
            inputmode="numeric"
            name="break_minutes"
            min="0"
            max="240"
            value="0"
          />
          <p class="hint">{t(lang, 'break_hint')}</p>
          <label for="reason">{t(lang, 'reason')}</label>
          <input id="reason" name="reason" placeholder={t(lang, 'reason_ph')} required />
          <div style="height:14px" />
          <button class="big go">{t(lang, 'send')}</button>
        </form>
        <a class="big sec" href="/m">
          {t(lang, 'back')}
        </a>
      </>,
    );
  });

  app.post('/m/nachtrag', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    const lang = langOf(c, me);
    const b = await c.req.parseBody();
    return guard(c, lang, '/m/nachtrag', async () => {
      await requestCorrection(sql, {
        id: typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : randomUUID(),
        employeeId: me.id,
        siteId: String(b.site_id ?? ''),
        date: String(b.date ?? ''),
        start: String(b.start ?? ''),
        end: String(b.end ?? ''),
        breakMinutes: Number(b.break_minutes ?? 0) || 0,
        reason: String(b.reason ?? ''),
        actor: `m:${me.personnel_no}`,
      });
      return back(c, '/m', { ok: t(lang, 'msg_sent') });
    });
  });

  // ---------------------------------------------------------------- Abwesenheit

  app.get('/m/abwesenheit', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    const lang = langOf(c, me);
    const year = Number(todayBerlin().slice(0, 4));
    const [bal, list] = await Promise.all([
      leaveBalance(sql, me.id, year),
      listAbsences(sql, { employeeId: me.id, from: `${year - 1}-12-01` }),
    ]);
    return render(
      c,
      lang,
      me,
      <>
        <h1>{t(lang, 'absence')}</h1>
        <div class="card">{t(lang, 'leave_rest', { year, n: String(bal.rest).replace('.', ',') })}</div>
        <form method="post" action="/m/abwesenheit" class="card" data-net>
          <input type="hidden" name="id" value={randomUUID()} />
          <label for="kind">{t(lang, 'kind')}</label>
          <select id="kind" name="kind">
            {(Object.keys(ABSENCE_LABEL) as AbsenceKind[]).map((k) => (
              <option value={k}>{t(lang, k)}</option>
            ))}
          </select>
          <div class="two">
            <div>
              <label for="from">{t(lang, 'from')}</label>
              <input id="from" type="date" name="start" required />
            </div>
            <div>
              <label for="to">{t(lang, 'to')}</label>
              <input id="to" type="date" name="end" required />
            </div>
          </div>
          <div class="chk">
            <input type="checkbox" id="half" name="half_day" value="1" />
            <label for="half">{t(lang, 'half_day')}</label>
          </div>
          <p class="hint">{t(lang, 'sick_hint')}</p>
          <div style="height:14px" />
          <button class="big go">{t(lang, 'send')}</button>
        </form>
        <div class="card">
          <h2>{t(lang, 'my_absences')}</h2>
          {list.length === 0 && <div class="mut">{t(lang, 'none')}</div>}
          {list.map((a) => (
            <div class="row">
              <div>
                {t(lang, a.kind)}
                <div class="small mut">
                  {dayLabel(lang, a.start_date)} – {dayLabel(lang, a.end_date)}
                </div>
              </div>
              <div class="r">
                <span
                  class={`pill ${a.status === 'genehmigt' ? 'ok' : a.status === 'beantragt' ? 'warn' : 'err'}`}
                >
                  {t(lang, `ab_${a.status}`)}
                </span>
              </div>
            </div>
          ))}
        </div>
        <a class="big sec" href="/m">
          {t(lang, 'back')}
        </a>
      </>,
    );
  });

  app.post('/m/abwesenheit', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    const lang = langOf(c, me);
    const b = await c.req.parseBody();
    return guard(c, lang, '/m/abwesenheit', async () => {
      const kind = String(b.kind) as AbsenceKind;
      if (!(kind in ABSENCE_LABEL)) throw new BusinessError('Art ungültig', 'bad_range');
      await requestAbsence(sql, {
        id: typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : randomUUID(),
        employeeId: me.id,
        kind,
        start: String(b.start ?? ''),
        end: String(b.end ?? ''),
        halfDay: b.half_day === '1',
        note: null,
        actor: `m:${me.personnel_no}`,
      });
      return back(c, '/m/abwesenheit', { ok: t(lang, 'msg_absence') });
    });
  });

  // ---------------------------------------------------------------- Installierbare App (PWA)

  app.get('/m/manifest.webmanifest', (c) =>
    c.body(
      JSON.stringify({
        name: 'Viva-Deluxe Mitarbeiter',
        short_name: 'Viva-Deluxe',
        description: 'Zeiterfassung, Urlaub und Dokumente für Mitarbeitende der Viva-Deluxe GmbH',
        lang: 'de',
        start_url: '/m',
        scope: '/m',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f4f5f7',
        theme_color: '#7D1435',
        icons: [
          { src: '/static/app-icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/static/app-icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/static/app-icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      }),
      200,
      { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=86400' },
    ),
  );

  app.get('/m/sw.js', (c) =>
    c.body(SW_JS, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/m',
    }),
  );

  app.get('/m/offline', (c) =>
    c.html(
      '<!doctype html>' +
        String(
          <MLayout lang="de" flash={{}}>
            <div class="card warn">
              <h2>Keine Verbindung</h2>
              <p class="mut">
                No connection · Fără conexiune · Bağlantı yok · Brak połączenia · Nema veze · Няма връзка
              </p>
              <a class="big sec" href="/m">
                ↻
              </a>
            </div>
          </MLayout>,
        ),
    ),
  );

  // ---------------------------------------------------------------- Dokumente unterschreiben

  app.get('/m/dokumente', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    const lang = langOf(c, me);
    const docs = await requestsForEmployee(sql, me.id);
    return render(
      c,
      lang,
      me,
      <>
        <h1>{t(lang, 'docs')}</h1>
        <div class="card">
          {docs.length === 0 && <div class="mut">{t(lang, 'none')}</div>}
          {docs.map((d) => (
            <a class="row" href={`/m/dokumente/${d.id}`} style="color:inherit;text-decoration:none">
              <div>
                <b>{d.title}</b>
                {d.due_date && d.status === 'offen' && (
                  <div class="small mut">{t(lang, 'doc_due', { date: dayLabel(lang, d.due_date) })}</div>
                )}
              </div>
              <div class="r">
                {d.status === 'offen' ? <span class="pill warn">✍</span> : <span class="pill ok">✓</span>}
              </div>
            </a>
          ))}
        </div>
        <a class="big sec" href="/m">
          {t(lang, 'back')}
        </a>
      </>,
    );
  });

  app.get('/m/dokumente/:id{[0-9a-f-]{36}}', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    const lang = langOf(c, me);
    const d = await getRequest(sql, c.req.param('id'));
    if (!d || d.employee_id !== me.id || d.status === 'zurueckgezogen') return c.redirect('/m/dokumente');
    const signedAt = d.signed_at?.toLocaleString(LOCALE[lang], {
      timeZone: 'Europe/Berlin',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    return render(
      c,
      lang,
      me,
      <>
        {c.req.query('zuerst') === '1' && d.status === 'offen' && (
          <div class="card" style="border-left:4px solid #7D1435">
            <b>{t(lang, 'doc_first')}</b>
          </div>
        )}
        <h1>{d.title}</h1>
        {d.description && (
          <p class="mut" style="margin:0">
            {d.description}
          </p>
        )}
        <a class="big sec" href={`/m/dokumente/${d.id}/dokument.pdf`} target="_blank" rel="noopener">
          📄 {t(lang, 'doc_open_pdf')}
        </a>
        {d.status === 'unterschrieben' ? (
          <div class="card run">
            <b>✓ {t(lang, 'doc_signed', { date: signedAt ?? '' })}</b>
          </div>
        ) : (
          <form method="post" action={`/m/dokumente/${d.id}`} class="card">
            <div class="chk">
              <input type="checkbox" id="read" name="read" value="1" required />
              <label for="read">{t(lang, 'doc_read')}</label>
            </div>
            <label>{t(lang, 'doc_sign_here')}</label>
            <canvas id="sig" class="sig"></canvas>
            <input type="hidden" id="sig-png" name="png" />
            <p class="hint" id="sig-hint" style="color:var(--err)" hidden>
              {t(lang, 'e_signature')}
            </p>
            <div class="two" style="margin-top:12px">
              <button type="button" class="big sec" id="sig-clear">
                {t(lang, 'doc_clear')}
              </button>
              <button class="big go">{t(lang, 'doc_sign_btn')}</button>
            </div>
          </form>
        )}
        {c.req.query('zuerst') === '1' && d.status === 'offen' ? (
          <form method="post" action="/m/dokumente/spaeter" style="margin:0">
            <button class="big sec">{t(lang, 'doc_later')}</button>
          </form>
        ) : (
          <a class="big sec" href="/m/dokumente">
            {t(lang, 'back')}
          </a>
        )}
        {d.status === 'offen' && <script dangerouslySetInnerHTML={{ __html: SIGN_JS }} />}
      </>,
    );
  });

  // „Später erinnern“: heute nicht mehr automatisch öffnen (morgen wieder)
  app.post('/m/dokumente/spaeter', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    setCookie(c, 'm_doc_later', todayBerlin(), {
      path: '/m',
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24,
    });
    return c.redirect('/m');
  });

  app.get('/m/dokumente/:id{[0-9a-f-]{36}}/dokument.pdf', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    const d = await getRequest(sql, c.req.param('id'));
    if (!d || d.employee_id !== me.id || d.status === 'zurueckgezogen') return c.notFound();
    const pdf = d.signed_pdf_path ? await signedPdf(deps, d.id) : await originalPdf(deps, d.document_id);
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="dokument.pdf"',
        'Cache-Control': 'private, no-store',
      },
    });
  });

  app.post('/m/dokumente/:id{[0-9a-f-]{36}}', async (c) => {
    const { me, res } = await requireMe(c);
    if (!me) return res!;
    const lang = langOf(c, me);
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    return guard(c, lang, `/m/dokumente/${id}`, async () => {
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.png ?? ''));
      if (!m) throw new BusinessError('Unterschrift fehlt', 'signature');
      await signRequest(deps, id, me.id, {
        png: new Uint8Array(Buffer.from(m[1]!, 'base64')),
        confirmed: b.read === '1',
        ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
        userAgent: c.req.header('user-agent') ?? null,
      });
      // weitere offene Dokumente gleich anschließen
      const next = (await requestsForEmployee(sql, me.id)).find((r) => r.status === 'offen');
      return back(c, next ? `/m/dokumente/${next.id}?zuerst=1` : '/m', { ok: t(lang, 'msg_signed') });
    });
  });
}

/** Erinnerung an die Pause (Browser-Benachrichtigung, solange die App offen ist). */
const REMIND_JS = `
(function(){
  var b=document.getElementById('remind'),box=document.querySelector('[data-break-at]');
  if(!b||!box||!('Notification' in window))return;
  var at=Number(box.getAttribute('data-break-at')),min=Number(box.getAttribute('data-break-min'));
  if(!min||at<Date.now())return;
  function plan(){var ms=at-Date.now()-5*60000;setTimeout(function(){
    var txt=b.getAttribute('data-text');
    if(navigator.serviceWorker&&navigator.serviceWorker.ready){navigator.serviceWorker.ready.then(function(r){r.showNotification('Viva-Deluxe',{body:txt,tag:'pause'})}).catch(function(){new Notification('Viva-Deluxe',{body:txt})})}
    else new Notification('Viva-Deluxe',{body:txt});
  },Math.max(0,ms));}
  if(Notification.permission==='granted'){plan();return;}
  if(Notification.permission==='denied')return;
  b.hidden=false;
  b.addEventListener('click',function(){Notification.requestPermission().then(function(p){if(p==='granted'){b.hidden=true;plan();}})});
})();`;
