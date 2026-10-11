import type { FC } from 'hono/jsx';

/**
 * Knopf „Benachrichtigungen einschalten“ für die App (Mitarbeiter-Ansicht /m und Objektleitung/Büro /qm).
 * Erscheint nur, wo der Browser Web Push kann (Android/Chrome, iPhone ab iOS 16.4 als Home-Bildschirm-App).
 */
export const PushCard: FC<{ save: string; on: string; done: string; blocked: string }> = (p) => (
  <div class="card" id="push" hidden data-save={p.save}>
    <button type="button" class="big sec" hidden>
      {p.on}
    </button>
    <p class="st" hidden style="margin:0;color:#15803d;font-weight:600">
      ✓ {p.done}
    </p>
    <p class="bl hint" hidden style="margin:8px 0 0">
      {p.blocked}
    </p>
  </div>
);

/** Browser-Teil: Service Worker (/m/sw.js) registrieren, Erlaubnis holen, Abo an den Server schicken. */
export const PUSH_JS = `(function(){
  var pb=document.getElementById('push');
  if(!pb||!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))return;
  var btn=pb.querySelector('button'),st=pb.querySelector('.st'),bl=pb.querySelector('.bl');
  function b64(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';var r=atob(s),a=new Uint8Array(r.length);for(var i=0;i<r.length;i++)a[i]=r.charCodeAt(i);return a;}
  function save(s){return fetch(pb.dataset.save,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(s)});}
  function show(on){pb.hidden=false;btn.hidden=on;st.hidden=!on;}
  navigator.serviceWorker.register('/m/sw.js',{scope:'/m'}).then(function(reg){
    return reg.pushManager.getSubscription().then(function(s){
      if(s&&Notification.permission==='granted'){show(true);save(s);}else{show(false);}
      if(Notification.permission==='denied')bl.hidden=false;
      btn.onclick=function(){
        btn.disabled=true;
        Notification.requestPermission().then(function(p){
          if(p!=='granted'){bl.hidden=false;btn.disabled=false;return;}
          return fetch('/m/push/key',{credentials:'same-origin'}).then(function(r){return r.text();})
            .then(function(k){return reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(k.trim())});})
            .then(function(s){return save(s);}).then(function(){show(true);});
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
