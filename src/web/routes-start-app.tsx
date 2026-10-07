import { getCookie } from 'hono/cookie';
import { verifySession } from '../services/employee-auth.js';
import { OFFICE_COOKIE, type Ctx, officeSecret } from './app.js';
import { CSS as MCSS, Ic } from './m/routes-mobile.js';

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
.foot{text-align:center;color:#8a7a80;font-size:13px;margin-top:8px}`;
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
                <h1>Willkommen</h1>
                <a class="choice" href="/m">
                  <Ic n="clock" />
                  <span>
                    <b>Mitarbeiter</b>
                    <small>Einsätze, Zeiten, Urlaub, Dokumente · Anmeldung mit Personalnummer und PIN</small>
                  </span>
                </a>
                <a class="choice" href="/qm">
                  <Ic n="building" />
                  <span>
                    <b>Objektleitung &amp; Büro</b>
                    <small>
                      Objekte, Audits, Mitarbeiter, Dokumente · Anmeldung mit Benutzername und Passwort
                    </small>
                  </span>
                </a>
                <div class="foot">Viva-Deluxe Gebäudereinigung GmbH</div>
              </main>
            </body>
          </html>,
        ),
    );
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
