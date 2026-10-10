import type { Child } from 'hono/jsx';

/*
 * Gemeinsame Anmeldeseite (Ahmed 10.10.: „Anmeldemaske verschönern“): links Bordeaux-Fläche mit hellem Logo,
 * Leitsatz und Siegeln, rechts das Formular. Am Handy Bordeaux-Kopf mit Logo, Formular als Karte darunter.
 * Eigenständige Seite (ohne App-Menü), Schrift Inter lokal, kein JavaScript nötig (Passwort-Auge optional).
 */
const CSS = `
@font-face{font-family:Inter;src:url(/static/inter-latin.woff2) format('woff2');font-weight:100 900;font-display:swap}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d1a1c;background:#f6f4f5;-webkit-font-smoothing:antialiased}
.lg{min-height:100%;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr)}
.lg-brand{position:relative;overflow:hidden;background:linear-gradient(155deg,#8b2332 0%,#7d1435 45%,#5c0e27 100%);color:#fff;padding:48px 56px;display:flex;flex-direction:column;justify-content:space-between}
.lg-brand::after{content:"";position:absolute;right:-180px;bottom:-180px;width:520px;height:520px;border-radius:50%;border:1px solid rgba(255,255,255,.12);box-shadow:0 0 0 70px rgba(255,255,255,.035),0 0 0 140px rgba(255,255,255,.025)}
.lg-brand img{width:220px;height:auto}
.lg-claim{position:relative;z-index:1;max-width:440px}
.lg-claim h2{font-size:34px;line-height:1.15;font-weight:700;margin:0 0 14px;letter-spacing:-.01em}
.lg-claim p{margin:0;font-size:16px;line-height:1.55;color:rgba(255,255,255,.82)}
.lg-seals{position:relative;z-index:1;display:inline-flex;align-self:flex-start;background:#fff;border-radius:10px;padding:10px 14px;box-shadow:0 6px 18px rgba(0,0,0,.18)}.lg-seals img{display:block;width:100%;max-width:454px;height:auto}
.lg-seals span{font-size:12px;font-weight:600;letter-spacing:.02em;padding:6px 11px;border-radius:999px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18)}
.lg-main{display:flex;align-items:center;justify-content:center;padding:40px 24px}
.lg-box{width:100%;max-width:400px}
.lg-box h1{font-size:28px;font-weight:700;margin:0 0 6px;letter-spacing:-.01em}
.lg-sub{color:#6d6468;margin:0 0 28px;font-size:15px}
.lg-f{margin-bottom:16px}
.lg-f label{display:block;font-size:14px;font-weight:600;margin-bottom:6px}
.lg-f label small{font-weight:400;color:#8a8085}
.lg-in{position:relative}
.lg-in svg{position:absolute;left:14px;top:50%;transform:translateY(-50%);width:18px;height:18px;color:#a1959a;pointer-events:none}
.lg-in input{width:100%;font:inherit;font-size:16px;padding:13px 44px 13px 42px;border:1px solid #ddd3d7;border-radius:10px;background:#fff;color:inherit;transition:border-color .15s,box-shadow .15s}
.lg-in input:focus{outline:none;border-color:#7d1435;box-shadow:0 0 0 4px rgba(125,20,53,.12)}
.lg-eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;background:none;padding:8px;cursor:pointer;color:#8a8085;border-radius:8px}
.lg-eye:hover{color:#7d1435;background:#f6eef1}
.lg-eye svg{position:static;transform:none;width:18px;height:18px;color:inherit}
.lg-btn{width:100%;margin-top:8px;font:inherit;font-size:16px;font-weight:600;color:#fff;background:#7d1435;border:0;border-radius:10px;padding:14px;cursor:pointer;transition:background .15s,transform .05s}
.lg-btn:hover{background:#6a1030}.lg-btn:active{transform:translateY(1px)}
.lg-err{display:flex;gap:10px;align-items:flex-start;background:#fdf0f1;border:1px solid #f2c9cf;color:#8b1d2c;border-radius:10px;padding:12px 14px;margin-bottom:18px;font-size:14px}
.lg-ok{background:#eef8f1;border:1px solid #c6e6d0;color:#1c6b3a;border-radius:10px;padding:12px 14px;margin-bottom:18px;font-size:14px}
.lg-help{margin-top:22px;border-top:1px solid #e8e1e4;padding-top:16px;font-size:13.5px;color:#6d6468;line-height:1.55}
.lg-help summary{cursor:pointer;font-weight:600;color:#3a3236}
.lg-help a{color:#7d1435}
.lg-foot{margin-top:28px;font-size:12px;color:#a1959a}
.lg-env{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;background:#fff3cd;color:#7a5b00;font-weight:700;font-size:10.5px;letter-spacing:.04em;text-transform:uppercase}
@media (max-width:860px){
  .lg{grid-template-columns:1fr;grid-template-rows:auto 1fr}
  .lg-brand{padding:28px 22px 64px;gap:18px}
  .lg-brand img{width:180px}
  .lg-claim h2{font-size:22px;margin-bottom:6px}
  .lg-claim p{font-size:14px}
  .lg-seals{display:none}
  .lg-main{align-items:flex-start;padding:0 16px 32px;margin-top:-44px;position:relative;z-index:2}
  .lg-box{background:#fff;border-radius:16px;padding:24px 20px;box-shadow:0 10px 30px rgba(60,10,28,.12)}
  .lg-box h1{font-size:24px}
  .lg-sub{margin-bottom:20px}
}`;

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
  /** zusätzliche Kopfzeilen (Manifest, App-Symbole) */
  head?: Child;
}): string {
  return (
    '<!doctype html>' +
    String(
      <html lang="de">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <meta name="theme-color" content="#7D1435" />
          <title>{`${p.title} · Viva-Deluxe`}</title>
          <link rel="icon" type="image/png" href="/static/favicon.png" />
          <link
            rel="preload"
            href="/static/inter-latin.woff2"
            as="font"
            type="font/woff2"
            crossorigin="anonymous"
          />
          {p.head}
          <style dangerouslySetInnerHTML={{ __html: CSS }} />
        </head>
        <body>
          <div class="lg">
            <aside class="lg-brand">
              <img src="/static/logo-hell.png" alt="Viva-Deluxe GmbH" width="220" height="50" />
              <div class="lg-claim">
                <h2>Qualität, die Vertrauen schafft.</h2>
                <p>
                  Betriebs-App der Viva-Deluxe Gebäudereinigung – Objekte, Einsätze, Zeiten und Rechnungen an
                  einem Ort.
                </p>
              </div>
              <div class="lg-seals">
                <img
                  src="/static/siegel.png"
                  alt="Meisterbetrieb, ISO 9001, ISO 14001, Gebäudereiniger-Handwerk, Die Gebäudedienstleister, Umwelt- und Klimapakt Bayern"
                  width="454"
                  height="40"
                />
              </div>
            </aside>
            <main class="lg-main">
              <div class="lg-box">
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
                  <button class="lg-btn">Anmelden</button>
                </form>
                <details class="lg-help">
                  <summary>Wie melde ich mich an?</summary>
                  {p.help}
                </details>
                <div class="lg-foot">
                  © Viva-Deluxe Gebäudereinigung GmbH · München
                  {p.env && p.env !== 'live' && (
                    <span class="lg-env">{p.env === 'dev' ? 'Lokal' : 'Test'}</span>
                  )}
                </div>
              </div>
            </main>
          </div>
        </body>
      </html>,
    )
  );
}
