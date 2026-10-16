import type { FC } from 'hono/jsx';

/**
 * Knopf „Benachrichtigungen einschalten“ für die App (Mitarbeiter-Ansicht /m und Objektleitung/Büro /qm).
 * Erscheint nur, wo der Browser Web Push kann (Android/Chrome, iPhone ab iOS 16.4 als Home-Bildschirm-App).
 */
export const PushCard: FC<{ save: string; on: string; done: string; blocked: string; later?: string }> = (
  p,
) => (
  <div class="card" id="push" hidden data-save={p.save}>
    <button type="button" class="big sec" hidden>
      {p.on}
    </button>
    <button type="button" class="pl" hidden>
      {p.later ?? 'Später'}
    </button>
    <p class="st" hidden style="margin:0;color:#15803d;font-weight:600">
      ✓ {p.done}
    </p>
    <p class="bl hint" hidden style="margin:8px 0 0">
      {p.blocked}
    </p>
  </div>
);

/** Aussehen des automatischen Fensters (in /m und /qm eingebunden) */
const PUSH_CSS_TEXT = `#push.pushask{position:fixed;left:12px;right:12px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:60;
  box-shadow:0 10px 40px rgba(60,10,30,.28);border:1px solid #ecc3d0;background:#fff;padding:18px}
#push .pl{display:block;width:100%;margin-top:8px;background:none;border:0;color:#6b5a61;font-size:15px;padding:8px}
#push .pl[hidden]{display:none}`;

/**
 * Browser-Teil: Service Worker (/m/sw.js) registrieren, Erlaubnis holen, Abo an den Server schicken.
 * Automatisch (Ahmed 16.10.): Erlaubnis schon erteilt → still abonnieren, kein Knopf; noch nicht gefragt → Fenster
 * „Benachrichtigungen erlauben?“ erscheint von selbst (iPhone verlangt dafür einen Fingertipp), „Später“ = heute nicht mehr.
 */
export const PUSH_JS = `(function(){
  var pb=document.getElementById('push');
  if(!pb||!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))return;
  var css=document.createElement('style');css.textContent=${JSON.stringify(PUSH_CSS_TEXT)};document.head.appendChild(css);
  var btn=pb.querySelector('button.big'),later=pb.querySelector('button.pl'),st=pb.querySelector('.st'),bl=pb.querySelector('.bl');
  function b64(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var r=atob(s),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a;}
  function save(s){return fetch(pb.dataset.save,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(s)});}
  function today(){return new Date().toISOString().slice(0,10);}
  function ask(){var d='';try{d=localStorage.getItem('vd_push_later')||'';}catch(e){}if(d===today())return;
    pb.hidden=false;pb.classList.add('pushask');btn.hidden=false;later.hidden=false;}
  function done(){pb.classList.remove('pushask');pb.hidden=true;}
  navigator.serviceWorker.register('/m/sw.js',{scope:'/m'}).then(function(reg){
    function sub(){return fetch('/m/push/key',{credentials:'same-origin'}).then(function(r){return r.text();})
      .then(function(k){return reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(k.trim())});})
      .then(function(s){return save(s);});}
    return reg.pushManager.getSubscription().then(function(s){
      if(Notification.permission==='granted'){if(s)save(s);else sub().catch(function(){});done();return;}
      if(Notification.permission==='denied'){pb.hidden=false;bl.hidden=false;return;}
      ask();
      later.onclick=function(){try{localStorage.setItem('vd_push_later',today());}catch(e){}done();};
      btn.onclick=function(){
        btn.disabled=true;
        Notification.requestPermission().then(function(p){
          if(p!=='granted'){pb.classList.remove('pushask');later.hidden=true;btn.hidden=true;bl.hidden=false;return;}
          return sub().then(function(){pb.classList.remove('pushask');btn.hidden=true;later.hidden=true;st.hidden=false;
            setTimeout(done,2500);});
        }).catch(function(){bl.hidden=false;btn.disabled=false;});
      };
    });
  }).catch(function(){});
})();`;

/** Zusätze für den Service Worker: Nachricht anzeigen, beim Antippen die passende Seite öffnen. */
export const SW_PUSH = `
self.addEventListener('push',function(e){var d={};try{d=e.data.json();}catch(x){d={body:e.data?e.data.text():''};}
  e.waitUntil(self.registration.showNotification(d.title||'Viva-Deluxe',{body:d.body||'',tag:d.tag||undefined,icon:'/static/app-icon-192.png',badge:'/static/favicon.png',data:{url:d.url||'/app'}}));});
self.addEventListener('notificationclick',function(e){e.notification.close();var u=(e.notification.data&&e.notification.data.url)||'/app';
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(l){for(var i=0;i<l.length;i++){if(l[i].url.indexOf(self.location.origin)===0&&'focus' in l[i]){if(l[i].navigate)l[i].navigate(u);return l[i].focus();}}return self.clients.openWindow(u);}));});`;

/**
 * PDFs in der installierten Web-App (Ahmed 16.10.: Lohnabrechnung ließ sich nicht drucken, teilen, zurück): im
 * Home-Bildschirm-Modus öffnen PDF-Links in der eigenen Ansicht /m/pdf mit „Zurück“ und „Teilen / Drucken“. Die Store-App (Capacitor) behandelt PDFs selbst.
 */
export const PDF_JS =
  "try{if(!window.Capacitor&&((window.matchMedia&&matchMedia('(display-mode: standalone)').matches)||navigator.standalone)){document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a||a.hasAttribute('download'))return;var l;try{l=new URL(a.getAttribute('href')||'',location.href);}catch(x){return;}if(l.origin!==location.origin)return;var p=l.pathname;if(!/\\.pdf$|^\\/m\\/lohn\\/|^\\/dateien\\//.test(p)||l.searchParams.get('download')==='1')return;e.preventDefault();var t=(a.getAttribute('data-title')||a.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80);location.href='/m/pdf?u='+encodeURIComponent(p+l.search)+'&t='+encodeURIComponent(t);},true);}}catch(e){}\n";

/**
 * App-Rahmen (Büro-Seiten in der App, Ahmed 16.10.: „sieht aus wie am PC“): Reiter als wischbare Leiste in einer Zeile
 * („Mehr“ aufgelöst), Tabellen als Karten mit Beschriftung je Wert. Tabellen mit Klasse `keep` bleiben Tabellen.
 */
export const APPMODE_JS = `(function(){
  document.querySelectorAll('.tabs').forEach(function(t){
    t.querySelectorAll('details.dd').forEach(function(d){d.querySelectorAll('.drop a').forEach(function(a){t.insertBefore(a,d);});d.remove();});
    var on=t.querySelector('a.on');if(on&&on.scrollIntoView)try{t.scrollLeft=on.offsetLeft-t.clientWidth/2+on.clientWidth/2;}catch(e){}
  });
  document.querySelectorAll('.tbl table').forEach(function(tb){
    if(tb.classList.contains('keep')||tb.closest('.keep'))return;
    var hs=[].slice.call(tb.querySelectorAll('thead th')).map(function(h){return (h.textContent||'').trim();});
    if(!hs.length||hs.length>10)return;
    tb.closest('.tbl').classList.add('appstack');
    tb.querySelectorAll('tbody tr').forEach(function(tr){var c=0;[].slice.call(tr.children).forEach(function(td){
      var l=hs[c]||'';if(!td.colSpan||td.colSpan<2){if(l&&!td.hasAttribute('data-l'))td.setAttribute('data-l',l);}c+=td.colSpan||1;});});
  });
})();`;
