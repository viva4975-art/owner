import { getCookie } from 'hono/cookie';
import { verifySession } from '../services/employee-auth.js';
import { OFFICE_COOKIE, type Ctx, officeSecret } from './app.js';
import { CSS as MCSS } from './m/routes-mobile.js';

/**
 * Gemeinsame App (App Store / Google Play / Home-Bildschirm): Startbildschirm mit Auswahl
 * „Mitarbeiter“ (Personalnummer + PIN → /m) oder „Objektleitung & Büro“ (Benutzer + Passwort → /qm).
 * Wer schon angemeldet ist, landet direkt in seinem Bereich; `?wahl=1` zeigt die Auswahl immer.
 */
export function registerStartAppRoutes({ app, deps }: Ctx) {
  const secret = officeSecret(deps.env);

  app.get('/app', (c) => {
    if (c.req.query('wahl') !== '1') {
      if (verifySession(secret, getCookie(c, OFFICE_COOKIE))) return c.redirect('/qm', 302);
      if (getCookie(c, 'vd_m')) return c.redirect('/m', 302);
    }
    const css = `${MCSS}
.start{max-width:460px;margin:0 auto;padding:40px 18px;display:flex;flex-direction:column;gap:16px}
.start img{align-self:center;margin:10px 0 18px}
.start h1{text-align:center;font-size:24px;margin:0 0 8px}
.choice{display:flex;align-items:center;gap:16px;padding:20px;border-radius:18px;background:#fff;border:1px solid #efe3e7;color:#3b0a1c;text-decoration:none;box-shadow:0 2px 10px rgba(125,20,53,.06)}
.choice svg{width:30px;height:30px;color:#7d1435;flex:none}
.choice b{display:block;font-size:19px}
.choice small{color:#8a7a80;font-size:14px}
.foot{text-align:center;color:#8a7a80;font-size:13px;margin-top:8px}
.login{display:flex;flex-direction:column;gap:8px;padding:20px}
.login label{font-weight:600}
.login input{font:inherit;font-size:18px;padding:14px;border:1px solid #e3d6db;border-radius:12px}
.login button{margin-top:10px}`;
    return c.html(
      '<!doctype html>' +
        String(
          <html lang="de">
            <head>
              <meta charset="utf-8" />
              <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
              <meta name="theme-color" content="#f8edf1" />
              <title>Viva-Deluxe</title>
              <link rel="icon" type="image/png" href="/static/favicon.png" />
              <link rel="manifest" href="/app/manifest.webmanifest" />
              <link rel="apple-touch-icon" href="/static/apple-touch-icon.png" />
              <meta name="apple-mobile-web-app-capable" content="yes" />
              <meta name="mobile-web-app-capable" content="yes" />
              <meta name="apple-mobile-web-app-title" content="Viva-Deluxe" />
              <style dangerouslySetInnerHTML={{ __html: css }} />
            </head>
            <body>
              <main class="start">
                <img src="/static/logo-transparent.png" alt="Viva-Deluxe" width="220" height="44" />
                <h1>Anmelden</h1>
                {c.req.query('fehler') && (
                  <div class="flash err" role="alert">
                    {c.req.query('fehler')}
                  </div>
                )}
                <form method="post" action="/app/anmelden" class="card login">
                  <label for="k">Personalnummer oder Benutzername</label>
                  <input
                    id="k"
                    name="kennung"
                    value={c.req.query('k') ?? ''}
                    autocomplete="username"
                    autocapitalize="none"
                    required
                  />
                  <label for="p">PIN oder Passwort</label>
                  <input id="p" name="geheim" type="password" autocomplete="current-password" required />
                  <button class="big go">Anmelden</button>
                </form>
                <p class="foot">
                  Mitarbeiter: Personalnummer und PIN (am Anfang Ihr Geburtsdatum TTMMJJ).
                  <br />
                  Objektleitung &amp; Büro: Benutzername und Passwort.
                </p>
                <div class="foot">Viva-Deluxe Gebäudereinigung GmbH</div>
              </main>
            </body>
          </html>,
        ),
    );
  });

  /**
   * Eine Anmeldung für alle: nur Ziffern = Personalnummer + PIN (Mitarbeiter-Ansicht), sonst Benutzername + Passwort
   * (Objektleitung & Büro). Geprüft wird von den bestehenden Anmeldungen (/m/anmelden, /anmelden) – gleiche Sperren.
   */
  app.post('/app/anmelden', async (c) => {
    const b = await c.req.parseBody();
    const kennung = String(b.kennung ?? '').trim();
    const geheim = String(b.geheim ?? '');
    const employee = /^\d+$/.test(kennung);
    const body = new URLSearchParams(
      employee
        ? { personnel_no: kennung, pin: geheim, next: '/m' }
        : { login: kennung.toLowerCase(), password: geheim, next: '/qm' },
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
      return c.redirect(`/app?wahl=1&fehler=${err[1]}&k=${encodeURIComponent(kennung)}`, 303);
    }
    return res;
  });

  app.get('/app/manifest.webmanifest', (c) =>
    c.body(
      JSON.stringify({
        name: 'Viva-Deluxe',
        short_name: 'Viva-Deluxe',
        description: 'App der Viva-Deluxe Gebäudereinigung GmbH für Mitarbeitende, Objektleitung und Büro',
        lang: 'de',
        start_url: '/app',
        scope: '/',
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
}
