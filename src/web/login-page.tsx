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
/* Kennzahlen */
.lg-stats{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-bottom:26px}
.lg-stat{min-width:118px;text-align:center;padding:14px 16px;border-radius:16px;background:rgba(255,255,255,.06);
  border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.lg-num{display:block;font-size:34px;font-weight:800;letter-spacing:-.02em;line-height:1.05;font-variant-numeric:tabular-nums;
  background:linear-gradient(180deg,#fff 30%,#f3b6c9);-webkit-background-clip:text;background-clip:text;color:transparent}
.lg-lbl{display:block;margin-top:5px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:rgba(255,255,255,.65)}
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
.lg-seals{width:100%;max-width:420px;margin-top:22px;opacity:.75}
.lg-seals img{display:block;width:100%;height:auto}
.lg-foot{margin-top:14px;font-size:12px;color:rgba(255,255,255,.45);text-align:center}
.lg-env{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;background:#fff3cd;color:#7a5b00;font-weight:700;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase}

/* Ablauf: Logo + Zahlen erscheinen und zählen, dann Karte (nur mit JS, Klasse .intro am <html>) */
.intro .lg-logo{animation:lgIn .7s cubic-bezier(.2,.8,.2,1) both}
.intro .lg-stat{animation:lgPop .7s cubic-bezier(.2,.9,.25,1.2) both}
.intro .lg-stat:nth-child(1){animation-delay:.15s}.intro .lg-stat:nth-child(2){animation-delay:.3s}.intro .lg-stat:nth-child(3){animation-delay:.45s}
.intro .lg-stats{animation:lgLift .8s cubic-bezier(.2,.8,.2,1) 1.9s both}
.intro .lg-card{animation:lgCard .9s cubic-bezier(.2,.8,.2,1) 2.1s both}
.intro .lg-seals,.intro .lg-foot{animation:lgIn .8s ease 2.5s both}
@keyframes lgIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes lgPop{from{opacity:0;transform:translateY(24px) scale(.85);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
@keyframes lgLift{from{transform:translateY(90px) scale(1.12)}to{transform:none}}
@keyframes lgCard{from{opacity:0;transform:translateY(40px) scale(.96);filter:blur(8px)}to{opacity:1;transform:none;filter:none}}
.lg-skip{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:3;font:inherit;font-size:13px;color:rgba(255,255,255,.7);
  background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:7px 14px;cursor:pointer;display:none}
.intro .lg-skip{display:block;animation:lgOut .3s ease 2.4s forwards}
@keyframes lgOut{to{opacity:0;visibility:hidden}}
@media (max-width:560px){
  .lg-logo{width:170px;margin-bottom:16px}
  .lg-stats{gap:8px;margin-bottom:18px}
  .lg-stat{min-width:0;flex:1 1 auto;padding:10px 8px;border-radius:14px}
  .lg-num{font-size:24px}.lg-lbl{font-size:9.5px;letter-spacing:.02em}
  .lg-card{padding:24px 18px 18px;border-radius:18px}.lg-card h1{font-size:23px}
  @keyframes lgLift{from{transform:translateY(60px) scale(1.15)}to{transform:none}}
}
@media (prefers-reduced-motion:reduce){
  .lg-blob,.lg-streaks,.lg-btn::after{animation:none}
}
/* Fassung 3 (Ahmed 12.11.: „unsere Farben sollen bleiben, muss nicht gleich sein, einfach was Geiles“):
   heller Viva-Bordeaux statt Fast-Schwarz, wandernder Farbschleier, Lichtpunkt folgt Maus/Finger,
   weiße Karte mit umlaufendem Bordeaux-Leuchtrand, am PC leicht kippend. */
@property --lg-a{syntax:'<angle>';inherits:false;initial-value:0deg}
body{background:#7d1435}
.lg-bg{background:linear-gradient(150deg,#9b2348 0%,#7d1435 38%,#5c0e27 100%)}
.lg-bg::before{content:"";position:absolute;inset:-30%;opacity:.55;will-change:transform;
  background:conic-gradient(from 0deg at 50% 50%,#7d1435,#b8325f,#8b2332,#e0708f,#7d1435,#5c0e27,#7d1435);
  filter:blur(90px);animation:lgSpin 28s linear infinite}
.lg-bg::after{content:"";position:absolute;inset:0;pointer-events:none;transition:background .15s;
  background:radial-gradient(420px circle at var(--mx,50%) var(--my,35%),rgba(255,255,255,.16),transparent 60%)}
@keyframes lgSpin{to{transform:rotate(360deg)}}
.lg-blob.b1{background:#c4436d;opacity:.45}.lg-blob.b2{background:#4d0a20;opacity:.6}.lg-blob.b3{background:#fff;opacity:.08}
.lg-streaks{opacity:.7;background:repeating-linear-gradient(118deg,transparent 0 90px,rgba(255,255,255,.06) 90px 92px,
  transparent 92px 170px,rgba(255,255,255,.035) 170px 171px,transparent 171px 280px)}
.lg-grain{background:radial-gradient(rgba(255,255,255,.09) 1px,transparent 1px) 0 0/24px 24px}
.lg-stat{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.28);box-shadow:0 8px 24px rgba(60,6,24,.25)}
.lg-num{background-image:linear-gradient(180deg,#fff 40%,#ffd6e2)}
.lg-lbl{color:rgba(255,255,255,.85)}
/* weiße Karte mit umlaufendem Leuchtrand */
.lg-card{color:#1d1a1c;background:rgba(255,255,255,.94);border:0;backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
  box-shadow:0 30px 70px rgba(50,4,20,.45),0 0 0 1px rgba(255,255,255,.6);
  transition:transform .25s ease-out}
.lg-card::before{inset:-2px;padding:2px;border-radius:24px;z-index:-1;
  background:conic-gradient(from var(--lg-a),#7d1435,#e0708f,#fff,#b8325f,#7d1435);animation:lgRing 6s linear infinite;
  filter:drop-shadow(0 0 10px rgba(224,112,143,.55))}
@keyframes lgRing{to{--lg-a:360deg}}
.lg-card h1{color:#7d1435}
.lg-sub{color:#6d6468}
.lg-f label{color:#3a3236}
.lg-in svg{color:#a1959a}
.lg-in input{color:#1d1a1c;background:#f7f3f5;border:1px solid #e6dce1}
.lg-in input::placeholder{color:#b3a8ad}
.lg-in input:focus{background:#fff;border-color:#7d1435;box-shadow:0 0 0 4px rgba(125,20,53,.14)}
.lg-in input:-webkit-autofill{-webkit-text-fill-color:#1d1a1c;-webkit-box-shadow:0 0 0 40px #fbf3f6 inset;caret-color:#1d1a1c}
.lg-eye{color:#8a8085}.lg-eye:hover{color:#7d1435;background:#f6eef1}
.lg-btn{background:linear-gradient(135deg,#a3214a,#7d1435 55%,#5c0e27);box-shadow:0 12px 28px rgba(125,20,53,.45),inset 0 1px 0 rgba(255,255,255,.25)}
.lg-err{background:#fdf0f1;border-color:#f2c9cf;color:#8b1d2c}
.lg-ok{background:#eef8f1;border-color:#c6e6d0;color:#1c6b3a}
.lg-rem{color:#4a4246}.lg-rem input{accent-color:#7d1435}
.lg-help{border-top-color:#eee5e9;color:#6d6468}.lg-help summary{color:#3a3236}.lg-help a{color:#7d1435}.lg-help b{color:#1d1a1c}
.lg-seals{opacity:.9}.lg-foot{color:rgba(255,255,255,.7)}
@media (prefers-reduced-motion:reduce){.lg-bg::before,.lg-card::before{animation:none}.lg-card{transition:none}}`;

/** Kennzahlen wie auf der Website (Werte aus dem Briefing; bei Änderung hier anpassen) */
const STATS: { n: number; suffix: string; label: string; text?: string }[] = [
  { n: 120, suffix: '+', label: 'Mitarbeitende' },
  { n: 150, suffix: '+', label: 'Objekte' },
  { n: 0, suffix: '', label: '9001 · 14001', text: 'ISO' },
];

/**
 * Startet den Ablauf vor dem ersten Zeichnen: nur einmal je Tab, nicht bei Meldungen, nicht bei
 * „Bewegung reduzieren“. Zählt die Zahlen hoch; Tippen/Taste überspringt.
 */
const INTRO_HEAD = `(function(){try{var d=document.documentElement;
if(d.getAttribute('data-msg')||sessionStorage.getItem('vd_intro')||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
sessionStorage.setItem('vd_intro','1');d.classList.add('intro');}catch(e){}})();`;
const INTRO_BODY = `(function(){var bg=document.querySelector('.lg-bg'),card=document.querySelector('.lg-card'),
fine=matchMedia('(pointer:fine) and (min-width:900px)').matches&&!matchMedia('(prefers-reduced-motion: reduce)').matches;
function mv(x,y){if(bg){bg.style.setProperty('--mx',x+'px');bg.style.setProperty('--my',y+'px');}
if(fine&&card&&!document.documentElement.classList.contains('intro')){var r=card.getBoundingClientRect(),dx=(x-r.left-r.width/2)/r.width,dy=(y-r.top-r.height/2)/r.height;
card.style.transform='perspective(900px) rotateY('+(Math.max(-1,Math.min(1,dx))*5)+'deg) rotateX('+(Math.max(-1,Math.min(1,dy))*-5)+'deg)';}}
addEventListener('pointermove',function(e){mv(e.clientX,e.clientY);},{passive:true});
addEventListener('touchmove',function(e){var t=e.touches[0];if(t)mv(t.clientX,t.clientY);},{passive:true});
document.addEventListener('mouseleave',function(){if(card)card.style.transform='';});})();
(function(){var d=document.documentElement;if(!d.classList.contains('intro'))return;
var els=document.querySelectorAll('.lg-num[data-n]');
els.forEach(function(el,i){var n=+el.getAttribute('data-n'),s=el.getAttribute('data-s')||'',t0=null,dur=1300,delay=250+i*150;
el.textContent='0'+s;function f(t){if(t0===null)t0=t;var p=Math.min(1,Math.max(0,(t-t0-delay)/dur));var e=1-Math.pow(1-p,3);
el.textContent=Math.round(n*e).toLocaleString('de-DE')+s;if(p<1)requestAnimationFrame(f);}requestAnimationFrame(f);});
function skip(){d.classList.remove('intro');els.forEach(function(el){el.textContent=(+el.getAttribute('data-n')).toLocaleString('de-DE')+(el.getAttribute('data-s')||'');});
document.removeEventListener('keydown',skip);}
var b=document.querySelector('.lg-skip');if(b)b.addEventListener('click',skip);
document.addEventListener('keydown',skip);setTimeout(function(){document.removeEventListener('keydown',skip);d.classList.remove('intro');},3400);})();`;

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
            <div class="lg-stats">
              {STATS.map((s) => (
                <div class="lg-stat">
                  {s.text ? (
                    <span class="lg-num">{s.text}</span>
                  ) : (
                    <span class="lg-num" data-n={String(s.n)} data-s={s.suffix}>
                      {s.n.toLocaleString('de-DE') + s.suffix}
                    </span>
                  )}
                  <span class="lg-lbl">{s.label}</span>
                </div>
              ))}
            </div>
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
          <button type="button" class="lg-skip">
            Überspringen
          </button>
          <script dangerouslySetInnerHTML={{ __html: INTRO_BODY }} />
        </body>
      </html>,
    )
  );
}
