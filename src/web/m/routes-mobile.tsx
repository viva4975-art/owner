import { createHash, randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Child, FC } from 'hono/jsx';
import { todayBerlin } from '../../domain/invoice/calc.js';
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
} from '../../services/time.js';
import type { AppEnv, Ctx } from '../app.js';
import { SIGN_JS } from '../routes-orders.js';
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
#scanner{position:fixed;inset:0;background:#000;z-index:10;display:flex;flex-direction:column}
#scanner[hidden]{display:none}
#scanner video{flex:1;width:100%;object-fit:cover}
#scanner button{margin:16px;margin-bottom:calc(16px + env(safe-area-inset-bottom,0px))}
canvas.sig{width:100%;height:200px;border:2px dashed #cfd4db;border-radius:12px;background:#fff;touch-action:none;display:block}
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

const MLayout: FC<{
  lang: Lang;
  me?: Me | null;
  flash: { ok?: string | undefined; err?: string | undefined };
  children?: Child;
}> = ({ lang, me, flash, children }) => (
  <html lang={lang}>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="theme-color" content="#7D1435" />
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
          <img src="/static/logo.png" alt="Viva-Deluxe" width="149" height="30" />
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
          <MLayout lang={lang} me={me} flash={{ ok: c.req.query('ok'), err: c.req.query('fehler') }}>
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
      <form method="post" action="/m/aus" class="card run" data-net>
        <div>{t(lang, 'running', { time: clock(running.start_at) })}</div>
        <div class="t" data-since={String(running.start_at.getTime())}>
          {hm(running.gross_minutes)}
        </div>
        <div class="mut">{t(lang, 'at_site', { site: running.site_name })}</div>
        <label for="break">{t(lang, 'break')}</label>
        <input
          id="break"
          name="break_minutes"
          type="number"
          inputmode="numeric"
          min="0"
          max="240"
          value="0"
        />
        <p class="hint">{t(lang, 'break_hint')}</p>
        <div style="height:12px" />
        <button class="big stop">{t(lang, 'clock_out')}</button>
      </form>
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
    const nowHm = new Date().toLocaleTimeString('de-DE', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
    });
    const todays = shifts.filter((s) => s.date === today && !s.absence);
    const notes = await siteNotes(todays.map((s) => s.plan.site_id));
    const toConfirm = shifts.filter(
      (s) => !s.entry && !s.absence && (s.date < today || s.plan.end_time <= nowHm),
    );
    const presetSite = todays.find((s) => !s.entry)?.plan.site_id;
    return render(
      c,
      lang,
      me,
      <>
        <h1>{t(lang, 'hello', { name: me.first_name })}</h1>
        {openDocs.length > 0 && (
          <a class="big go" href="/m/dokumente" style="font-size:18px">
            ✍ {t(lang, 'docs_open', { n: openDocs.length })}
          </a>
        )}
        <button type="button" id="scan" class="big sec" hidden>
          {t(lang, 'scan_qr')}
        </button>
        <div id="scanner" hidden>
          <video playsinline muted></video>
          <button type="button" class="big sec">
            {t(lang, 'scan_cancel')}
          </button>
        </div>
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
        <div class="card">
          <h2>{t(lang, 'today')}</h2>
          {todays.length === 0 && <div class="mut">{t(lang, 'no_plan')}</div>}
          {todays.map((s) => (
            <div class="row">
              <div>
                {s.plan.start_time}–{s.plan.end_time}
                <div class="small mut">{s.plan.site_name}</div>
                {notes.get(s.plan.site_id) && <div class="note">{notes.get(s.plan.site_id)}</div>}
              </div>
              <div class="r">
                {s.entry ? <span class="pill ok">{t(lang, `st_${s.entry.status}`)}</span> : ''}
              </div>
            </div>
          ))}
        </div>
        {toConfirm.map((s) => (
          <form method="post" action="/m/bestaetigen" class="card warn" data-net>
            <h2>{t(lang, 'confirm_open')}</h2>
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
            <button class="big sec">{t(lang, 'confirm_btn')}</button>
          </form>
        ))}
        <div class="links">
          <a class="big sec" href="/m/nachtrag">
            {t(lang, 'forgot')}
          </a>
          <a class="big sec" href="/m/abwesenheit">
            {t(lang, 'absence')}
          </a>
          {docs.length > 0 && (
            <a class="big sec" href="/m/dokumente">
              {t(lang, 'docs')}
            </a>
          )}
        </div>
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
        breakMinutes: Number(b.break_minutes ?? 0) || 0,
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
        <a class="big sec" href="/m/dokumente">
          {t(lang, 'back')}
        </a>
        {d.status === 'offen' && <script dangerouslySetInnerHTML={{ __html: SIGN_JS }} />}
      </>,
    );
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
      return back(c, `/m/dokumente/${id}`, { ok: t(lang, 'msg_signed') });
    });
  });
}
