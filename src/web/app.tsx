import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import type { Child } from 'hono/jsx';
import { secureHeaders } from 'hono/secure-headers';
import { createHash } from 'node:crypto';
import { verifySession } from '../services/employee-auth.js';
import { BusinessError } from '../services/errors.js';
import { type User, authenticate, ensureBootstrapAdmin, getUser, managedSites } from '../services/users.js';
import type { Deps } from '../services/workflow.js';
import { Layout } from './layout.js';
import { canAccess, homeFor } from './permissions.js';
import { registerAuthRoutes } from './routes-users.js';
import { registerFileRoutes } from './routes-files.js';
import { registerInvoiceRoutes } from './routes-invoices.js';
import { registerMasterdataRoutes } from './routes-masterdata.js';
import { registerMobileRoutes } from './m/routes-mobile.js';
import { registerModuleRoutes } from './routes-modules.js';
import { registerDunningRoutes } from './routes-dunning.js';
import { registerInventoryRoutes } from './routes-inventory.js';
import { registerOfferRoutes } from './routes-offers.js';
import { registerOrderRoutes } from './routes-orders.js';
import { registerPlanningRoutes } from './routes-planning.js';
import { registerPurchasingRoutes } from './routes-purchasing.js';
import { registerTimeRoutes } from './routes-time.js';

export const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export type AppEnv = { Variables: { actor: string; user: User; sites: string[] | null } };

/** Objektleitung: nur eigene Objekte. Wirft 403, wenn das Objekt nicht dazugehört. */
export function assertSite(c: Context<AppEnv>, siteId: string | null | undefined) {
  const sites = c.get('sites');
  if (sites && (!siteId || !sites.includes(siteId)))
    throw new HTTPException(403, { message: 'Kein Zugriff auf dieses Objekt' });
}
/** Filtert Zeilen auf die eigenen Objekte (Objektleitung), sonst unverändert. */
export function inScope<T extends { site_id?: string | null }>(c: Context<AppEnv>, rows: T[]): T[] {
  const sites = c.get('sites');
  return sites ? rows.filter((r) => !!r.site_id && sites.includes(r.site_id)) : rows;
}
export const OFFICE_COOKIE = 'vd_s';
export const officeSecret = (env: Deps['env']) =>
  createHash('sha256')
    .update(`office:${env.SESSION_SECRET ?? `dev-session:${env.APP_BASIC_AUTH}`}`)
    .digest('hex');

export interface Ctx {
  app: Hono<AppEnv>;
  deps: Deps;
  page: (
    c: Context<AppEnv>,
    title: string,
    nav: string,
    body: Child,
    status?: 200 | 403 | 404,
  ) => Response | Promise<Response>;
  /** Post/Redirect/Get: nach jedem Speichern auf eine GET-Seite umleiten → Zurück/Neu laden sendet nichts doppelt. */
  back: (c: Context<AppEnv>, path: string, msg: { ok?: string; fehler?: string }) => Response;
  /** Seitenrahmen mit Reitern, damit andere Module eigene Reiter ergänzen können. */
  shells: {
    employee?: (
      c: Context<AppEnv>,
      active: string,
      body: (e: {
        id: string;
        first_name: string;
        last_name: string;
        personnel_no: string;
      }) => Promise<Child> | Child,
    ) => Promise<Response>;
    site?: (
      c: Context<AppEnv>,
      active: string,
      body: (s: {
        id: string;
        name: string;
        site_no: string;
        customer_id: string;
        clock_token: string;
      }) => Promise<Child> | Child,
    ) => Promise<Response>;
  };
}

export function createApp(deps: Deps) {
  const { env } = deps;
  const app = new Hono<AppEnv>();

  // Schrift, Logo: ohne Anmeldung, lange zwischenspeicherbar (keine Geheimnisse).
  const STATIC_ROOT = fileURLToPath(new URL('../../assets/web/', import.meta.url));
  app.use('/static/*', async (c, next) => {
    await next();
    if (c.res.status === 200) c.res.headers.set('Cache-Control', 'public, max-age=604800');
  });
  app.use(
    '/static/*',
    serveStatic({ root: STATIC_ROOT, rewriteRequestPath: (p) => p.replace(/^\/static/, '') }),
  );

  // Referer nur innerhalb der App (nötig, um nach einem Eingabefehler ins Formular zurückzukehren).
  app.use(secureHeaders({ referrerPolicy: 'same-origin' }));
  app.use(csrf());

  // Büro-Anmeldung: Sitzungs-Cookie (Formular /anmelden). Basic Auth mit denselben Zugangsdaten nur für
  // automatische Tests/Werkzeuge. Mitarbeiter-Ansicht /m hat eine eigene PIN-Anmeldung.
  const { sql } = deps;
  const secret = officeSecret(env);
  let boot: Promise<unknown> | null = null;
  const basicCache = new Map<string, { id: string; until: number }>();
  const open = (path: string) =>
    path === '/m' ||
    path.startsWith('/m/') ||
    path === '/anmelden' ||
    path === '/health' ||
    path.startsWith('/static/');
  app.use(async (c, next) => {
    const path = c.req.path;
    if (open(path)) return next();
    boot ??= ensureBootstrapAdmin(sql, env.APP_BASIC_AUTH);
    await boot;
    let user: User | undefined;
    const sid = verifySession(secret, getCookie(c, OFFICE_COOKIE));
    if (sid) user = await getUser(sql, sid);
    const auth = c.req.header('Authorization');
    if (!user && auth?.startsWith('Basic ')) {
      const key = createHash('sha256').update(auth).digest('hex');
      const hit = basicCache.get(key);
      if (hit && hit.until > Date.now()) user = await getUser(sql, hit.id);
      else {
        const [login, ...pw] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
        try {
          user = await authenticate(sql, login ?? '', pw.join(':'));
          basicCache.set(key, { id: user.id, until: Date.now() + 5 * 60_000 });
        } catch {
          /* falsch → wie nicht angemeldet */
        }
      }
    }
    if (!user || !user.active) {
      if (c.req.method === 'GET' && !path.startsWith('/api/')) {
        const u = new URL(c.req.url);
        return c.redirect(`/anmelden?next=${encodeURIComponent(u.pathname + u.search)}`, 303);
      }
      return c.text('Anmeldung erforderlich', 401);
    }
    if (user.must_change_password && path !== '/konto' && path !== '/abmelden') {
      return c.redirect(
        `/konto?fehler=${encodeURIComponent('Bitte zuerst ein eigenes Passwort festlegen.')}`,
        303,
      );
    }
    c.set('user', user);
    c.set('actor', user.login);
    c.set('sites', await managedSites(sql, user));
    if (!canAccess(user.role, path)) {
      return page(
        c,
        'Keine Berechtigung',
        '',
        <div class="card">
          <h2 style="margin-top:0">Keine Berechtigung</h2>
          <p>
            Diese Seite ist für Ihre Rolle nicht freigegeben. Bitte bei Bedarf die Geschäftsführung fragen.
          </p>
          <a class="btn sec" href={homeFor(user.role)}>
            Zur Startseite
          </a>
        </div>,
        403,
      );
    }
    await next();
  });
  app.use(async (c, next) => {
    await next();
    // Seiten dürfen im Zurück-Speicher (bfcache) bleiben, müssen aber beim normalen Aufruf frisch sein.
    if (c.res.headers.get('Content-Type')?.startsWith('text/html')) {
      c.res.headers.set('Cache-Control', 'private, no-cache');
    }
  });

  function page(c: Context<AppEnv>, title: string, nav: string, body: Child, status: 200 | 403 | 404 = 200) {
    const u = c.get('user') as User | undefined;
    return c.html(
      '<!doctype html>' +
        String(
          <Layout
            title={title}
            nav={nav}
            env={env.APP_ENV}
            {...(u ? { user: u.name, role: u.role } : {})}
            flash={{ ok: c.req.query('ok'), err: c.req.query('fehler') }}
          >
            {body}
          </Layout>,
        ),
      status,
    );
  }

  const back: Ctx['back'] = (c, path, msg) => {
    const [beforeHash, hash] = path.split('#');
    const [p, existing] = beforeHash!.split('?');
    const q = new URLSearchParams(existing ?? '');
    q.delete('ok');
    q.delete('fehler');
    for (const [k, v] of Object.entries(msg)) if (v) q.set(k, v);
    const qs = q.toString();
    return c.redirect(`${p}${qs ? `?${qs}` : ''}${hash ? `#${hash}` : ''}`, 303);
  };

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof BusinessError) {
      // Zurück auf die Seite, von der das Formular kam (inkl. Parameter). Eingaben stellt das
      // Browser-Skript aus dem Tab-Speicher wieder her.
      const ref = c.req.header('referer');
      const target = ref
        ? (() => {
            const u = new URL(ref);
            return u.pathname + u.search;
          })()
        : '/';
      return back(c, target, { fehler: err.message });
    }
    console.error(err);
    return c.html(
      '<!doctype html>' +
        String(
          <Layout
            title="Fehler"
            nav=""
            env={env.APP_ENV}
            flash={{ err: `Unerwarteter Fehler: ${err.message}` }}
          >
            <p>
              Ihre Eingaben sind im Formular noch gespeichert – mit „Zurück“ kommen Sie wieder dorthin.{' '}
              <a href="/">Zur Übersicht</a>
            </p>
          </Layout>,
        ),
      500,
    );
  });

  const ctx: Ctx = { app, deps, page, back, shells: {} };
  registerAuthRoutes(ctx);
  registerMobileRoutes(ctx);
  registerFileRoutes(ctx);
  registerModuleRoutes(ctx);
  registerMasterdataRoutes(ctx);
  registerInvoiceRoutes(ctx);
  registerOfferRoutes(ctx);
  registerDunningRoutes(ctx);
  registerInventoryRoutes(ctx);
  registerTimeRoutes(ctx);
  registerPlanningRoutes(ctx);
  registerPurchasingRoutes(ctx);
  registerOrderRoutes(ctx);

  app.notFound((c) =>
    page(
      c,
      'Nicht gefunden',
      '',
      <div class="card">
        Diese Seite gibt es nicht (mehr). <a href="/">Zur Übersicht</a>
      </div>,
      404,
    ),
  );

  app.get('/health', (c) => c.text('ok'));
  return app;
}
