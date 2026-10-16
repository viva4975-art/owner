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
