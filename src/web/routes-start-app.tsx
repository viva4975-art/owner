import { getCookie } from 'hono/cookie';
import { verifySession } from '../services/employee-auth.js';
import { linkedEmployee } from '../services/users.js';
import { OFFICE_COOKIE, type Ctx, officeSecret } from './app.js';
import { loginHtml } from './login-page.js';

/**
 * Gemeinsame App (App Store / Google Play / Home-Bildschirm): Startbildschirm mit Auswahl
 * „Mitarbeiter“ (Personalnummer + PIN → /m) oder „Objektleitung & Büro“ (Benutzer + Passwort → /qm).
 * Wer schon angemeldet ist, landet direkt in seinem Bereich; `?wahl=1` zeigt die Auswahl immer.
 */
/** Die eine Anmeldemaske (Handy-App, PC, Mitarbeiter-Ansicht nach dem Abmelden). Feld-IDs `k`/`p`. */
export function unifiedLoginHtml(
  env: string,
  o: {
    from: 'app' | 'pc';
    next?: string;
    err?: string | undefined;
    ok?: string | undefined;
    k?: string | undefined;
  },
): string {
  return loginHtml({
    title: 'Anmelden',
    sub: 'Mitarbeitende, Objektleitung und Büro',
    action: '/app/anmelden',
    hidden: { from: o.from, next: o.next ?? '' },
    err: o.err,
    ok: o.ok,
    env,
    remember: true,
    head: (
      <>
        <link rel="manifest" href="/app/manifest.webmanifest" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
      </>
    ),
    fields: [
      {
        id: 'k',
        name: 'kennung',
        label: 'Personalnummer oder Benutzername',
        value: o.k ?? '',
        autocomplete: 'username',
        autofocus: !o.k,
      },
      {
        id: 'p',
        name: 'geheim',
        label: 'PIN oder Passwort',
        type: 'password',
        autocomplete: 'current-password',
        autofocus: !!o.k,
      },
    ],
    help: (
      <p>
        Mit <b>Personalnummer und PIN</b> (am Anfang Ihr Geburtsdatum TTMMJJ, z. B. 120390 – danach bitte eine
        eigene PIN vergeben) oder mit <b>Benutzername und Passwort</b>. Die App erkennt selbst, welcher Zugang
        es ist.
        <br />
        Nach 5 Fehlversuchen ist die Anmeldung 15 Minuten gesperrt.
      </p>
    ),
  });
}

export function registerStartAppRoutes({ app, deps }: Ctx) {
  const secret = officeSecret(deps.env);

  app.get('/app', async (c) => {
    const next = c.req.query('next') ?? '';
    if (c.req.query('wahl') !== '1') {
      const uid = verifySession(secret, getCookie(c, OFFICE_COOKIE));
      // Objektleitung/Büro: zuerst die eigene Zeit (wie Mitarbeitende), oben umschalten auf Qualität/Verwaltung
      if (uid) return c.redirect((await linkedEmployee(deps.sql, uid)) ? '/m' : '/qm', 302);
      if (getCookie(c, 'vd_m')) return c.redirect('/m', 302);
    }
    return c.html(
      unifiedLoginHtml(deps.env.APP_ENV, {
        from: 'app',
        next,
        err: c.req.query('fehler'),
        ok: c.req.query('ok'),
        k: c.req.query('k'),
      }),
    );
  });

  /**
   * Eine Anmeldung für alle (Ahmed 16.10.: „nur eine Eingabeform“ – auch am PC und nach dem Abmelden in der App):
   * nur Ziffern = Personalnummer + PIN (Mitarbeiter-Ansicht), sonst Benutzername + Passwort (Objektleitung & Büro).
   * Geprüft wird von den bestehenden Anmeldungen (/m/anmelden, /anmelden) – gleiche Sperren.
   * `from` = Herkunft (app: Handy-App, pc: Büro-Anmeldung) entscheidet über Ziel und Rücksprung bei Fehlern.
   */
  app.post('/app/anmelden', async (c) => {
    const b = await c.req.parseBody();
    const kennung = String(b.kennung ?? b.login ?? b.personnel_no ?? '').trim();
    const geheim = String(b.geheim ?? b.password ?? b.pin ?? '');
    const from = b.from === 'pc' ? 'pc' : 'app';
    const rawNext = typeof b.next === 'string' ? b.next : '';
    const employee = /^\d+$/.test(kennung);
    const okNext = rawNext.startsWith('/') && !rawNext.startsWith('//');
    const mNext = okNext && /^\/m(\/[\w/-]*)?$/.test(rawNext) ? rawNext : '/m';
    const officeNext =
      okNext && !rawNext.startsWith('/m') && !rawNext.startsWith('/app')
        ? rawNext
        : from === 'app'
          ? '/app'
          : '';
    const body = new URLSearchParams(
      employee
        ? { personnel_no: kennung, pin: geheim, next: mNext }
        : {
            login: kennung.toLowerCase(),
            password: geheim,
            next: officeNext,
            bleiben: b.bleiben === '1' ? '1' : '',
          },
    );
    const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' });
    for (const h of ['origin', 'cookie', 'user-agent', 'x-forwarded-for', 'x-forwarded-proto', 'host'])
      if (c.req.header(h)) headers.set(h, c.req.header(h)!);
    const res = await app.request(new URL(employee ? '/m/anmelden' : '/anmelden', c.req.url), {
      method: 'POST',
      headers,
      body,
    });
    const loc = res.headers.get('location') ?? '';
    const err = /[?&]fehler=([^&]*)/.exec(loc);
    if (err) {
      const q = `fehler=${err[1]}&k=${encodeURIComponent(kennung)}${rawNext && okNext ? `&next=${encodeURIComponent(rawNext)}` : ''}`;
      return c.redirect(from === 'pc' ? `/anmelden?${q}` : `/app?wahl=1&${q}`, 303);
    }
    return res;
  });

  /**
   * PDF-Ansicht in der installierten Web-App (Ahmed 16.10.: Lohnabrechnung/Dokumente ohne Zurück, Drucken, Teilen –
   * iOS zeigt PDFs im Home-Bildschirm-Modus ohne jede Leiste). Kopfzeile mit „Zurück“ und „Teilen / Drucken“
   * (iOS-Teilenmenü: Drucken, In Dateien sichern, Mail, WhatsApp), darunter das PDF. Nur eigene Pfade; die Rechte
   * prüft die PDF-Adresse selbst (gleiche Anmeldung).
   */
  app.get('/m/pdf', (c) => {
    const u = c.req.query('u') ?? '';
    if (!u.startsWith('/') || u.startsWith('//') || u.startsWith('/m/pdf')) return c.redirect('/m', 302);
    const esc = (v: string) =>
      v.replace(
        /[&<>"']/g,
        (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
      );
    const title = (c.req.query('t') ?? '').slice(0, 120) || 'Dokument';
    c.header('Cache-Control', 'no-store');
    return c.html(`<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#7D1435"><title>${esc(title)}</title>
<style>
html,body{margin:0;height:100%;background:#525659;font-family:Inter,system-ui,-apple-system,sans-serif}
body{display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:8px;background:#7D1435;color:#fff;flex:none;
  padding:calc(10px + env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) 10px max(12px,env(safe-area-inset-left))}
header .t{flex:1;min-width:0;font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}
header button{flex:none;background:rgba(255,255,255,.16);color:#fff;border:0;border-radius:8px;padding:9px 12px;line-height:1.2;
  font-size:15px;font-weight:600;font-family:inherit;white-space:nowrap;cursor:pointer}
main{flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;padding:10px 8px calc(16px + env(safe-area-inset-bottom))}
@media (max-width:360px){header button{padding:8px 10px;font-size:14px}}
main canvas,main img{display:block;width:100%;height:auto;margin:0 auto 10px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.35)}
main iframe{display:block;width:100%;height:100%;border:0;background:#fff}
main.frame{padding:0}
.wait,#msg{color:#fff;text-align:center;padding:30px 16px;font-size:15px}
#msg{display:none;background:#fff3cd;color:#5c4400;padding:10px 14px;text-align:left}
</style></head><body>
<header><button type="button" id="back">‹ Zurück</button><div class="t">${esc(title)}</div>
<button type="button" id="share">Teilen / Drucken</button></header>
<div id="msg"></div>
<main id="view"><div class="wait">Wird geladen …</div></main>
<script>
window.__pdfu=${JSON.stringify(u).replace(/</g, '\\u003c')};
window.__pdfn=${JSON.stringify(title.replace(/[^\w äöüÄÖÜß.-]/g, '_')).replace(/</g, '\\u003c')};
(function(){
var u=window.__pdfu,name=window.__pdfn,view=document.getElementById('view');
var msg=document.getElementById('msg');function say(t){msg.textContent=t;msg.style.display='block';}
document.getElementById('back').onclick=function(){if(history.length>1)history.back();else location.href='/m';};
function frame(){view.className='frame';view.innerHTML='';var f=document.createElement('iframe');f.src=u;f.title=name;view.appendChild(f);}
window.__pdfFrame=frame;
window.__pdfBlob=fetch(u,{credentials:'same-origin'}).then(function(r){if(!r.ok)throw new Error(r.status);return r.blob();});
window.__pdfBlob.then(function(b){
  if(b.type.indexOf('image/')===0){view.innerHTML='';var im=new Image();im.src=URL.createObjectURL(b);im.alt=name;view.appendChild(im);return;}
  if(b.type!=='application/pdf'){view.innerHTML='<div class="wait">Vorschau nicht möglich – über „Teilen“ öffnen oder sichern.</div>';return;}
  (window.__pdfRender?window.__pdfRender(b):new Promise(function(res){window.__pdfReady=res;}).then(function(){return window.__pdfRender(b);})).catch(frame);
}).catch(function(){view.innerHTML='<div class="wait">Datei konnte nicht geladen werden.</div>';});
document.getElementById('share').onclick=function(){
  window.__pdfBlob.then(function(b){
    var fn=/\\.\\w{2,4}$/.test(name)?name:name+(b.type==='application/pdf'?'.pdf':'');
    var file=null;try{file=new File([b],fn,{type:b.type||'application/pdf'});}catch(e){}
    if(file&&navigator.canShare&&navigator.canShare({files:[file]})){navigator.share({files:[file],title:name}).catch(function(){});return;}
    var w=window.open(URL.createObjectURL(b),'_blank');if(!w)say('Teilen wird auf diesem Gerät nicht unterstützt.');
  }).catch(function(){say('Datei konnte nicht geladen werden.');});
};
})();
</script>
<script type="module">
// Seiten als Bilder zeichnen (iOS zeigt PDFs in einem Rahmen nur unvollständig, ohne Blättern)
window.__pdfRender=async function(b){
  const pdfjs=await import('/static/vendor/pdfjs.mjs');
  const doc=await pdfjs.getDocument({data:new Uint8Array(await b.arrayBuffer()),isEvalSupported:false,useSystemFonts:false,
    standardFontDataUrl:'/static/vendor/pdfjs/standard_fonts/',cMapUrl:'/static/vendor/pdfjs/cmaps/',cMapPacked:true}).promise;
  const view=document.getElementById('view');view.innerHTML='';
  // schärfer als der Bildschirm, damit Heranzoomen (zwei Finger) lesbar bleibt; je Seite höchstens ~10 Mio. Pixel
  const w=Math.min(view.clientWidth-16,1000),dpr=Math.min((window.devicePixelRatio||1)*1.5,4);
  for(let i=1;i<=doc.numPages;i++){
    const page=await doc.getPage(i);const v0=page.getViewport({scale:1});
    let sc=(w/v0.width)*dpr;const area=v0.width*v0.height*sc*sc;if(area>1e7)sc*=Math.sqrt(1e7/area);
    const vp=page.getViewport({scale:sc});
    const cv=document.createElement('canvas');cv.width=Math.floor(vp.width);cv.height=Math.floor(vp.height);view.appendChild(cv);
    await page.render({canvasContext:cv.getContext('2d'),viewport:vp}).promise;
  }
};
if(window.__pdfReady)window.__pdfReady();
</script></body></html>`);
  });

  app.get('/app/manifest.webmanifest', (c) =>
    c.body(
      JSON.stringify({
        name: 'Viva-Deluxe',
        short_name: 'Viva-Deluxe',
        description: 'App der Viva-Deluxe Gebäudereinigung GmbH für Mitarbeitende, Objektleitung und Büro',
        lang: 'de',
        // gleiche App wie /m/manifest.webmanifest (Adresse für alle: app.viva-deluxe-reinigung.de/m)
        id: '/m',
        start_url: '/m',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f4f5f7',
        theme_color: '#7D1435',
        icons: [
          { src: '/static/app-icon-192.png?v=2', sizes: '192x192', type: 'image/png' },
          { src: '/static/app-icon-512.png?v=2', sizes: '512x512', type: 'image/png' },
          {
            src: '/static/app-icon-maskable-512.png?v=2',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      }),
      200,
      { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' },
    ),
  );
}
