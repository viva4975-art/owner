import { registerPayslipRoutes } from './routes-payslips.js';
import { registerLetterRoutes } from './routes-letters.js';
import { registerTimeAccountRoutes } from './routes-time-account.js';
import { registerMonthCloseRoutes } from './routes-month-close.js';
import { registerReminderRoutes } from './routes-reminders.js';
import { registerPriceAdjustmentRoutes } from './routes-price-adjustment.js';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import type { Child } from 'hono/jsx';
import { secureHeaders } from 'hono/secure-headers';
import { createHash } from 'node:crypto';
import { verifySession } from '../services/employee-auth.js';
import { BusinessError } from '../services/errors.js';
import {
  type User,
  authenticate,
  ensureBootstrapAdmin,
  fullName,
  getUser,
  managedSites,
} from '../services/users.js';
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
import { registerFacilityRoutes } from './routes-facility.js';
import { registerSiteExtraRoutes } from './routes-site-extra.js';
import { registerSignRoutes } from './routes-sign.js';
import { registerHrRoutes } from './routes-hr.js';
import { registerPlanningMonthRoutes } from './routes-planning-month.js';
import { registerReportRoutes } from './routes-reports.js';
import { registerTransferRoutes } from './routes-transfer.js';
import { registerBankRoutes } from './routes-bank.js';
import { registerImportRoutes } from './routes-import.js';
import { registerHandoverRoutes } from './routes-handovers.js';
import { registerVehicleRoutes } from './routes-vehicles.js';
import { registerWordTemplateRoutes } from './routes-word-templates.js';
import { registerLegacyInvoiceRoutes } from './routes-legacy-invoices.js';
import { registerCalendarFeedRoutes } from './routes-calendar-feed.js';
import { registerHrRequiredRoutes } from './routes-hr-required.js';
import { registerSubcontractorRoutes } from './routes-subcontractors.js';
import { registerSettingsRoutes } from './routes-settings.js';
import { registerTenderRoutes } from './routes-tenders.js';
import { registerCashbookRoutes } from './routes-cashbook.js';
import { registerLegacyRoutes } from './routes-legacy.js';
import { registerProspectRoutes } from './routes-prospects.js';
import { registerApplicantRoutes } from './routes-applicants.js';
import { registerGlassRoutes } from './routes-glass.js';
import { registerGarageRoutes } from './routes-garage.js';
import { registerDeepCleaningRoutes } from './routes-deep-cleaning.js';
import { registerEigenComplianceRoutes } from './routes-eigen-compliance.js';
import { registerCostCenterRoutes } from './routes-costcenters.js';
import { registerPlanningRoutes } from './routes-planning.js';
import { registerPlanningBoardRoutes } from './routes-planning-board.js';
import { registerPurchasingRoutes } from './routes-purchasing.js';
import { registerTimeRoutes } from './routes-time.js';
import { registerTimesheetRoutes } from './routes-timesheet.js';
import { registerQmRoutes } from './routes-qm.js';
import { sortCsv } from './csv-sort.js';
import { registerStartAppRoutes } from './routes-start-app.js';
import { registerMyTimeRoutes } from './routes-my-time.js';
import { registerQmTeamRoutes } from './routes-qm-team.js';
import { registerOlAppRoutes } from './routes-ol-app.js';

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
export const APP_COOKIE = 'vd_app';
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

  // html2canvas (Plakat als JPG) aus node_modules, ohne fremdes CDN.
  const H2C = fileURLToPath(
    new URL('../../node_modules/html2canvas/dist/html2canvas.min.js', import.meta.url),
  );
  app.get('/static/vendor/html2canvas.min.js', async (c) => {
    const { readFile } = await import('node:fs/promises');
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=604800');
    return c.body(await readFile(H2C));
  });

  // Referer nur innerhalb der App (nötig, um nach einem Eingabefehler ins Formular zurückzukehren).
  app.use(secureHeaders({ referrerPolicy: 'same-origin' }));
  app.use(csrf());

  // CSV-Exporte in der Sortierung der Bildschirm-Tabelle (?sort=<Spalte>&dir=asc|desc, siehe client.ts).
  app.use(async (c, next) => {
    await next();
    const label = c.req.query('sort');
    const type = c.res.headers.get('content-type') ?? '';
    if (!label || c.req.method !== 'GET' || c.res.status !== 200 || !/text\/csv/i.test(type)) return;
    if (/charset=(windows-1252|iso-8859)/i.test(type)) return; // DATEV o. ä.: festes Format, nicht umsortieren
    const text = await c.res.text();
    const headers = new Headers(c.res.headers);
    headers.delete('content-length');
    c.res = new Response(sortCsv(text, label, c.req.query('dir') === 'desc' ? 'desc' : 'asc'), {
      status: 200,
      headers,
    });
  });

  // Büro-Anmeldung: Sitzungs-Cookie (Formular /anmelden). Basic Auth mit denselben Zugangsdaten nur für
  // automatische Tests/Werkzeuge. Mitarbeiter-Ansicht /m hat eine eigene PIN-Anmeldung.
  const { sql } = deps;
  const secret = officeSecret(env);
  let boot: Promise<unknown> | null = null;
  const basicCache = new Map<string, { id: string; until: number }>();
  const open = (path: string) =>
    path === '/m' ||
    path.startsWith('/m/') ||
    path.startsWith('/np/') ||
    path.startsWith('/kalender/abo/') ||
    path === '/anmelden' ||
    path === '/app' ||
    path === '/app/anmelden' ||
    path === '/app/manifest.webmanifest' ||
    path === '/health' ||
    path.startsWith('/static/');
  app.use(async (c, next) => {
    const path = c.req.path;
    if (open(path)) return next();
    // Fehlschlag nicht dauerhaft merken – beim nächsten Aufruf erneut versuchen
    boot ??= ensureBootstrapAdmin(sql, env.APP_BASIC_AUTH).catch((e: unknown) => {
      boot = null;
      throw e;
    });
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

  // App-Rahmen: Wer die App (/qm) öffnet, sieht danach jede Büro-Seite im App-Design; „?pc=1“ schaltet zurück.
  app.use(async (c, next) => {
    const p = c.req.path;
    const opts = { path: '/', sameSite: 'Lax' as const, secure: env.APP_ENV !== 'dev', maxAge: 365 * 86400 };
    if (c.req.query('pc') === '1') setCookie(c, APP_COOKIE, '0', opts);
    else if (c.req.method === 'GET' && (p === '/qm' || p.startsWith('/qm/') || p === '/app'))
      setCookie(c, APP_COOKIE, '1', opts);
    await next();
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
            {...(u ? { user: fullName(u), role: u.role } : {})}
            app={c.req.query('pc') !== '1' && getCookie(c, APP_COOKIE) === '1'}
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
  registerTimesheetRoutes(ctx);
  registerOlAppRoutes(ctx);
  registerStartAppRoutes(ctx);
  registerMyTimeRoutes(ctx);
  registerQmTeamRoutes(ctx);
  registerQmRoutes(ctx);
  registerTimeRoutes(ctx);
  registerPlanningBoardRoutes(ctx);
  registerPlanningRoutes(ctx);
  registerPurchasingRoutes(ctx);
  registerOrderRoutes(ctx);
  registerFacilityRoutes(ctx);
  registerSiteExtraRoutes(ctx);
  registerSignRoutes(ctx);
  registerHrRoutes(ctx);
  registerPlanningMonthRoutes(ctx);
  registerReportRoutes(ctx);
  registerTransferRoutes(ctx);
  registerBankRoutes(ctx);
  registerImportRoutes(ctx);
  registerHandoverRoutes(ctx);
  registerVehicleRoutes(ctx);
  registerWordTemplateRoutes(ctx);
  registerLegacyInvoiceRoutes(ctx);
  registerCalendarFeedRoutes(ctx);
  registerHrRequiredRoutes(ctx);
  registerSubcontractorRoutes(ctx);
  registerSettingsRoutes(ctx);
  registerTenderRoutes(ctx);
  registerCostCenterRoutes(ctx);
  registerPriceAdjustmentRoutes(ctx);
  registerReminderRoutes(ctx);
  registerMonthCloseRoutes(ctx);
  registerTimeAccountRoutes(ctx);
  registerLetterRoutes(ctx);
  registerPayslipRoutes(ctx);
  registerCashbookRoutes(ctx);
  registerLegacyRoutes(ctx);
  registerProspectRoutes(ctx);
  registerApplicantRoutes(ctx);
  registerGlassRoutes(ctx);
  registerGarageRoutes(ctx);
  registerDeepCleaningRoutes(ctx);
  registerEigenComplianceRoutes(ctx);

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
