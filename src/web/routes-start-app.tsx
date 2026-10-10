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
export function registerStartAppRoutes({ app, deps }: Ctx) {
  const secret = officeSecret(deps.env);

  app.get('/app', async (c) => {
    if (c.req.query('wahl') !== '1') {
      const uid = verifySession(secret, getCookie(c, OFFICE_COOKIE));
      // Objektleitung/Büro: zuerst die eigene Zeit (wie Mitarbeitende), oben umschalten auf Qualität/Verwaltung
      if (uid) return c.redirect((await linkedEmployee(deps.sql, uid)) ? '/m' : '/qm', 302);
      if (getCookie(c, 'vd_m')) return c.redirect('/m', 302);
    }
    return c.html(
      loginHtml({
        title: 'Anmelden',
        sub: 'Mitarbeitende, Objektleitung und Büro',
        action: '/app/anmelden',
        err: c.req.query('fehler'),
        env: deps.env.APP_ENV,
        head: (
          <>
            <link rel="manifest" href="/app/manifest.webmanifest" />
            <link rel="apple-touch-icon" href="/static/apple-touch-icon.png" />
            <meta name="apple-mobile-web-app-capable" content="yes" />
            <meta name="mobile-web-app-capable" content="yes" />
            <meta name="apple-mobile-web-app-title" content="Viva-Deluxe" />
          </>
        ),
        fields: [
          {
            id: 'k',
            name: 'kennung',
            label: 'Personalnummer oder Benutzername',
            value: c.req.query('k') ?? '',
            autocomplete: 'username',
          },
          {
            id: 'p',
            name: 'geheim',
            label: (
              <>
                PIN oder Passwort <small>(PIN anfangs = Geburtsdatum TTMMJJ)</small>
              </>
            ),
            type: 'password',
            autocomplete: 'current-password',
          },
        ],
        help: (
          <p>
            <b>Mitarbeitende:</b> Personalnummer und PIN – am Anfang Ihr Geburtsdatum (TTMMJJ, z. B. 120390).
            Danach bitte eine eigene PIN vergeben.
            <br />
            <b>Objektleitung &amp; Büro:</b> Benutzername und Passwort.
            <br />
            Nach 5 Fehlversuchen ist die Anmeldung 15 Minuten gesperrt.
          </p>
        ),
      }),
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
        : { login: kennung.toLowerCase(), password: geheim, next: '/app' },
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
