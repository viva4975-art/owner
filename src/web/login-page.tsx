import type { Child } from 'hono/jsx';

/*
 * Gemeinsame Anmeldeseite. Fassung 2 (Ahmed 12.11.: „schöner, mit Effekten, wie die Website erst die Zahlen“):
 * dunkler Bordeaux-Hintergrund mit langsam ziehenden Lichtbahnen, zuerst zählen die Kennzahlen hoch, dann
 * schweben sie nach oben und die Glaskarte mit dem Formular erscheint. Ohne JavaScript, bei Fehlermeldung,
 * beim zweiten Aufruf im selben Tab und bei „Bewegung reduzieren“ sofort das Formular (kein Warten).
 * Feld-IDs/Namen unverändert (Browser-Tests, Passwort-Manager).
 */
const CSS = `
@font-face{font-family:Inter;src:url(/static/inter-latin.woff2) format('woff2');font-weight:100 900;font-display:swap}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;-webkit-font-smoothing:antialiased;
  background:#14040b;overflow-x:hidden}
/* Hintergrund: Verlauf + schwebende Lichtflecken + diagonale Lichtbahnen */
.lg-bg{position:fixed;inset:0;z-index:0;overflow:hidden;
  background:radial-gradient(120% 80% at 15% 0%,#5c0e27 0%,transparent 55%),
    radial-gradient(90% 70% at 100% 100%,#4a0b20 0%,transparent 60%),linear-gradient(160deg,#2a0713,#12030a 70%)}
.lg-blob{position:absolute;border-radius:50%;filter:blur(60px);opacity:.55;will-change:transform}
.lg-blob.b1{width:520px;height:520px;left:-140px;top:-120px;background:#9b1d45;animation:lgFloat1 18s ease-in-out infinite alternate}
.lg-blob.b2{width:460px;height:460px;right:-160px;bottom:-140px;background:#7d1435;animation:lgFloat2 22s ease-in-out infinite alternate}
.lg-blob.b3{width:300px;height:300px;left:55%;top:30%;background:#c0396a;opacity:.25;animation:lgFloat1 26s ease-in-out infinite alternate-reverse}
.lg-streaks{position:absolute;inset:-50%;opacity:.5;will-change:transform;
  background:repeating-linear-gradient(118deg,transparent 0 80px,rgba(255,255,255,.035) 80px 82px,transparent 82px 150px,
    rgba(233,120,160,.06) 150px 153px,transparent 153px 260px);animation:lgDrift 40s linear infinite}
.lg-grain{position:absolute;inset:0;background:radial-gradient(rgba(255,255,255,.06) 1px,transparent 1px) 0 0/22px 22px;
  mask-image:radial-gradient(ellipse at center,#000 30%,transparent 80%);-webkit-mask-image:radial-gradient(ellipse at center,#000 30%,transparent 80%)}
@keyframes lgFloat1{to{transform:translate(120px,90px) scale(1.15)}}
@keyframes lgFloat2{to{transform:translate(-110px,-80px) scale(1.1)}}
@keyframes lgDrift{to{transform:translate(260px,0)}}

.lg{position:relative;z-index:1;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;
  justify-content:center;padding:calc(28px + env(safe-area-inset-top)) 16px calc(28px + env(safe-area-inset-bottom))}
.lg-logo{width:210px;height:auto;margin-bottom:22px}
/* Kurzbeschreibung unter dem Logo (statt Kennzahlen, Ahmed 12.11.) */
.lg-tag{max-width:440px;text-align:center;margin:-6px 0 24px;font-size:15px;line-height:1.5;color:rgba(255,255,255,.72)}
.lg-tag b{display:block;font-size:19px;font-weight:700;letter-spacing:-.01em;margin-bottom:2px;
  background-image:linear-gradient(180deg,#fff 30%,#f0b4c7);-webkit-background-clip:text;background-clip:text;color:transparent}
/* Glaskarte */
.lg-card{position:relative;width:100%;max-width:420px;padding:30px 28px 24px;border-radius:22px;
  background:linear-gradient(160deg,rgba(255,255,255,.13),rgba(255,255,255,.04));
  border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(22px) saturate(140%);-webkit-backdrop-filter:blur(22px) saturate(140%);
  box-shadow:0 30px 80px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.18)}
.lg-card::before{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;
  background:linear-gradient(135deg,rgba(255,255,255,.5),transparent 35%,transparent 65%,rgba(233,120,160,.45));
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude}
.lg-card h1{font-size:26px;font-weight:700;margin:0 0 4px;letter-spacing:-.01em}
.lg-sub{color:rgba(255,255,255,.68);margin:0 0 22px;font-size:14.5px}
.lg-f{margin-bottom:15px}
.lg-f label{display:block;font-size:13.5px;font-weight:600;margin-bottom:6px;color:rgba(255,255,255,.88)}
.lg-in{position:relative}
.lg-in svg{position:absolute;left:14px;top:50%;transform:translateY(-50%);width:18px;height:18px;color:rgba(255,255,255,.55);pointer-events:none}
.lg-in input{width:100%;font:inherit;font-size:16px;padding:13px 44px 13px 42px;border-radius:12px;color:#fff;
  background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);transition:border-color .2s,box-shadow .2s,background .2s}
.lg-in input::placeholder{color:rgba(255,255,255,.4)}
.lg-in input:focus{outline:none;background:rgba(255,255,255,.11);border-color:#f0a3bc;box-shadow:0 0 0 4px rgba(240,120,160,.18)}
.lg-in input:-webkit-autofill{-webkit-text-fill-color:#fff;-webkit-box-shadow:0 0 0 40px #3a0d1d inset;caret-color:#fff}
.lg-eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;background:none;padding:8px;cursor:pointer;color:rgba(255,255,255,.6);border-radius:8px}
.lg-eye:hover{color:#fff;background:rgba(255,255,255,.1)}
.lg-eye svg{position:static;transform:none;width:18px;height:18px;color:inherit}
.lg-btn{position:relative;overflow:hidden;width:100%;margin-top:10px;font:inherit;font-size:16px;font-weight:700;color:#fff;
  border:0;border-radius:12px;padding:14px;cursor:pointer;background:linear-gradient(135deg,#b3285a,#7d1435 60%,#5f0e29);
  box-shadow:0 10px 26px rgba(125,20,53,.55),inset 0 1px 0 rgba(255,255,255,.25);transition:transform .15s,box-shadow .2s}
.lg-btn::after{content:"";position:absolute;top:0;left:-60%;width:40%;height:100%;
  background:linear-gradient(100deg,transparent,rgba(255,255,255,.35),transparent);transform:skewX(-20deg);animation:lgShine 4.5s ease-in-out 2.4s infinite}
.lg-btn:hover{box-shadow:0 14px 32px rgba(160,30,75,.65),inset 0 1px 0 rgba(255,255,255,.3)}.lg-btn:active{transform:translateY(1px) scale(.995)}
@keyframes lgShine{0%{left:-60%}35%,100%{left:130%}}
.lg-err{display:flex;gap:10px;align-items:flex-start;background:rgba(220,60,80,.16);border:1px solid rgba(255,140,150,.4);color:#ffd9dd;border-radius:12px;padding:12px 14px;margin-bottom:16px;font-size:14px}
.lg-ok{background:rgba(70,180,110,.16);border:1px solid rgba(140,220,170,.4);color:#d6f5e1;border-radius:12px;padding:12px 14px;margin-bottom:16px;font-size:14px}
.lg-rem{display:flex;align-items:center;gap:8px;margin:2px 0 6px;font-size:13.5px;color:rgba(255,255,255,.78);cursor:pointer}
.lg-rem input{width:18px;height:18px;accent-color:#c0396a;margin:0}
.lg-help{margin-top:18px;border-top:1px solid rgba(255,255,255,.12);padding-top:14px;font-size:13.5px;color:rgba(255,255,255,.7);line-height:1.55}
.lg-help summary{cursor:pointer;font-weight:600;color:rgba(255,255,255,.9)}
.lg-help a{color:#f3b6c9}.lg-help b{color:#fff}
.lg-seals{width:100%;max-width:420px;margin-top:22px;opacity:1}
.lg-seals img{display:block;width:100%;height:auto}
.lg-foot{margin-top:14px;font-size:12px;color:rgba(255,255,255,.45);text-align:center}
.lg-env{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;background:#fff3cd;color:#7a5b00;font-weight:700;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase}

/* Ablauf: Logo + Zahlen erscheinen und zählen, dann Karte (nur mit JS, Klasse .intro am <html>) */
.intro .lg-logo{animation:lgIn .7s cubic-bezier(.2,.8,.2,1) both}
.intro .lg-tag{animation:lgPop .7s cubic-bezier(.2,.8,.2,1) .2s both}
.intro .lg-card{animation:lgCard .7s cubic-bezier(.2,.8,.2,1) .45s both}
.intro .lg-seals,.intro .lg-foot{animation:lgIn .6s ease .8s both}
@keyframes lgIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes lgPop{from{opacity:0;transform:translateY(12px);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
@keyframes lgCard{from{opacity:0;transform:translateY(40px) scale(.96);filter:blur(8px)}to{opacity:1;transform:none;filter:none}}
@media (max-width:560px){
  .lg-logo{width:170px;margin-bottom:16px}
  .lg-tag{font-size:14px;margin:-4px 0 18px}.lg-tag b{font-size:17px}
  .lg-card{padding:24px 18px 18px;border-radius:18px}.lg-card h1{font-size:23px}
}
@media (prefers-reduced-motion:reduce){
  .lg-blob,.lg-streaks,.lg-btn::after{animation:none}
}
/* Fassung 4 (Ahmed 12.11.: „vorher war besser mit dem dunklen, aber bisschen gläserner, damit es nicht in den Augen
   weh tut“): dunkler Hintergrund wie Fassung 2, Karte durchsichtiger und weicher, gedämpfter Kontrast, sanft umlaufender
   Lichtrand, schwacher Lichtschein folgt Maus/Finger. */
@property --lg-a{syntax:'<angle>';inherits:false;initial-value:0deg}
.lg-bg::after{content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(380px circle at var(--mx,50%) var(--my,35%),rgba(233,120,160,.10),transparent 60%)}
.lg-card{background:linear-gradient(160deg,rgba(255,255,255,.08),rgba(255,255,255,.02));border-color:rgba(255,255,255,.10);
  backdrop-filter:blur(30px) saturate(130%);-webkit-backdrop-filter:blur(30px) saturate(130%);
  box-shadow:0 30px 80px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.10);transition:transform .25s ease-out}
.lg-card::before{padding:1px;background:conic-gradient(from var(--lg-a),rgba(255,255,255,.04),rgba(233,120,160,.45),
  rgba(255,255,255,.04) 40%,rgba(255,255,255,.25) 70%,rgba(255,255,255,.04));animation:lgRing 9s linear infinite}
@keyframes lgRing{to{--lg-a:360deg}}
.lg-card h1{color:rgba(255,255,255,.94)}
.lg-sub{color:rgba(255,255,255,.66)}
.lg-f label{color:rgba(255,255,255,.88)}
.lg-in input{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.18);color:#fff}
.lg-in input::placeholder{color:rgba(255,255,255,.5)}
.lg-in input:focus{background:rgba(255,255,255,.08);border-color:rgba(240,163,188,.7);box-shadow:0 0 0 4px rgba(240,120,160,.12)}
.lg-btn{background:linear-gradient(135deg,rgba(179,40,90,.92),rgba(125,20,53,.92) 60%,rgba(95,14,41,.92));
  box-shadow:0 10px 26px rgba(125,20,53,.4),inset 0 1px 0 rgba(255,255,255,.18)}
.lg-seals{opacity:1}.lg-seals img{filter:brightness(0) invert(1)}
@media (prefers-reduced-motion:reduce){.lg-card::before{animation:none}.lg-card{transition:none}}`;

/**
 * Startet den kurzen Ablauf (Beschreibung, dann Karte, ~1,2 s) vor dem ersten Zeichnen: höchstens einmal am Tag
 * je Gerät, nicht bei Meldungen, nicht bei „Bewegung reduzieren“.
 */
const INTRO_HEAD = `(function(){try{var d=document.documentElement;
var t=new Date().toISOString().slice(0,10);
if(d.getAttribute('data-msg')||localStorage.getItem('vd_intro')===t||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
localStorage.setItem('vd_intro',t);d.classList.add('intro');}catch(e){}})();`;
const INTRO_BODY = `(function(){var bg=document.querySelector('.lg-bg'),card=document.querySelector('.lg-card'),
fine=matchMedia('(pointer:fine) and (min-width:900px)').matches&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
function mv(x,y){if(bg){bg.style.setProperty('--mx',x+'px');bg.style.setProperty('--my',y+'px');}
if(fine&&card&&!document.documentElement.classList.contains('intro')){var r=card.getBoundingClientRect(),dx=(x-r.left-r.width/2)/r.width,dy=(y-r.top-r.height/2)/r.height;
card.style.transform='perspective(900px) rotateY('+(Math.max(-1,Math.min(1,dx))*5)+'deg) rotateX('+(Math.max(-1,Math.min(1,dy))*-5)+'deg)';}}
addEventListener('pointermove',function(e){mv(e.clientX,e.clientY);},{passive:true});
addEventListener('touchmove',function(e){var t=e.touches[0];if(t)mv(t.clientX,t.clientY);},{passive:true});
document.addEventListener('mouseleave',function(){if(card)card.style.transform='';});})();
(function(){var d=document.documentElement;if(!d.classList.contains('intro'))return;
setTimeout(function(){d.classList.remove('intro');},1500);})();`;

const USER = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
  </svg>
);
const LOCK = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);
const EYE = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const ALERT = (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    style="flex:none;margin-top:1px"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4M12 16h.01" />
  </svg>
);

export interface LoginField {
  id: string;
  name: string;
  label: Child;
  type?: 'text' | 'password';
  value?: string;
  autocomplete: string;
  autofocus?: boolean;
}

export function loginHtml(p: {
  title: string;
  sub: string;
  action: string;
  fields: LoginField[];
  hidden?: Record<string, string>;
  err?: string | undefined;
  ok?: string | undefined;
  help: Child;
  env?: string;
  /** Häkchen „Angemeldet bleiben“ (Name `bleiben`) */
  remember?: boolean;
  /** zusätzliche Kopfzeilen (Manifest, App-Symbole) */
  head?: Child;
}): string {
  return (
    '<!doctype html>' +
    String(
      <html lang="de" data-msg={p.err || p.ok ? '1' : undefined}>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <meta name="theme-color" content="#2a0713" />
          <title>{`${p.title} · Viva-Deluxe`}</title>
          <link rel="icon" type="image/png" href="/static/favicon.png" />
          <link rel="apple-touch-icon" href="/static/apple-touch-icon.png?v=2" />
          <meta name="apple-mobile-web-app-title" content="Viva-Deluxe" />
          <link
            rel="preload"
            href="/static/inter-latin.woff2"
            as="font"
            type="font/woff2"
            crossorigin="anonymous"
          />
          {p.head}
          <style dangerouslySetInnerHTML={{ __html: CSS }} />
          <script dangerouslySetInnerHTML={{ __html: INTRO_HEAD }} />
        </head>
        <body>
          <div class="lg-bg" aria-hidden="true">
            <div class="lg-blob b1" />
            <div class="lg-blob b2" />
            <div class="lg-blob b3" />
            <div class="lg-streaks" />
            <div class="lg-grain" />
          </div>
          <div class="lg">
            <img
              class="lg-logo"
              src="/static/logo-hell.png"
              alt="Viva-Deluxe Gebäudereinigung GmbH"
              width="210"
              height="48"
            />
            <p class="lg-tag">
              <b>Eine App für den ganzen Betrieb.</b>
              Zeiten, Einsätze, Objekte und Abrechnung – im Büro und unterwegs.
            </p>
            <main class="lg-card">
              <h1>{p.title}</h1>
              <p class="lg-sub">{p.sub}</p>
              {p.err && (
                <div class="lg-err flash err" role="alert">
                  {ALERT}
                  <span>{p.err}</span>
                </div>
              )}
              {p.ok && (
                <div class="lg-ok flash ok" role="status">
                  {p.ok}
                </div>
              )}
              <form method="post" action={p.action}>
                {Object.entries(p.hidden ?? {}).map(([k, v]) => (
                  <input type="hidden" name={k} value={v} />
                ))}
                {p.fields.map((f) => (
                  <div class="lg-f">
                    <label for={f.id}>{f.label}</label>
                    <div class="lg-in">
                      {f.type === 'password' ? LOCK : USER}
                      <input
                        id={f.id}
                        name={f.name}
                        type={f.type ?? 'text'}
                        value={f.value ?? ''}
                        autocomplete={f.autocomplete}
                        autocapitalize="none"
                        spellcheck={false}
                        autofocus={f.autofocus}
                        required
                      />
                      {f.type === 'password' && (
                        <button
                          type="button"
                          class="lg-eye"
                          aria-label="Passwort anzeigen"
                          onclick={`var i=document.getElementById('${f.id}');i.type=i.type==='password'?'text':'password'`}
                        >
                          {EYE}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {p.remember && (
                  <label class="lg-rem">
                    <input type="checkbox" name="bleiben" value="1" checked /> Angemeldet bleiben (30 Tage,
                    nur auf eigenem Gerät)
                  </label>
                )}
                <button class="lg-btn">Anmelden</button>
              </form>
              <details class="lg-help">
                <summary>Wie melde ich mich an?</summary>
                {p.help}
              </details>
            </main>
            <div class="lg-seals">
              <img
                src="/static/siegel-hell.png"
                alt="Meisterbetrieb, ISO 9001, ISO 14001, Gebäudereiniger-Handwerk, Die Gebäudedienstleister, Umwelt- und Klimapakt Bayern"
                width="454"
                height="40"
              />
            </div>
            <div class="lg-foot">
              © Viva-Deluxe Gebäudereinigung GmbH · München
              {p.env && p.env !== 'live' && <span class="lg-env">{p.env === 'dev' ? 'Lokal' : 'Test'}</span>}
            </div>
          </div>
          <script dangerouslySetInnerHTML={{ __html: INTRO_BODY }} />
        </body>
      </html>,
    )
  );
}
