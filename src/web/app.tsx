import { Hono, type Context } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import type { Child } from 'hono/jsx';
import { secureHeaders } from 'hono/secure-headers';
import { BusinessError } from '../services/errors.js';
import type { Deps } from '../services/workflow.js';
import { Layout } from './layout.js';
import { registerInvoiceRoutes } from './routes-invoices.js';
import { registerMasterdataRoutes } from './routes-masterdata.js';
import { registerModuleRoutes } from './routes-modules.js';

export const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export type AppEnv = { Variables: { actor: string } };

export interface Ctx {
  app: Hono<AppEnv>;
  deps: Deps;
  page: (
    c: Context<AppEnv>,
    title: string,
    nav: string,
    body: Child,
    status?: 200 | 404,
  ) => Response | Promise<Response>;
  /** Post/Redirect/Get: nach jedem Speichern auf eine GET-Seite umleiten → Zurück/Neu laden sendet nichts doppelt. */
  back: (c: Context<AppEnv>, path: string, msg: { ok?: string; fehler?: string }) => Response;
}

export function createApp(deps: Deps) {
  const { env } = deps;
  const app = new Hono<AppEnv>();
  const [user, ...pw] = env.APP_BASIC_AUTH.split(':');

  // Referer nur innerhalb der App (nötig, um nach einem Eingabefehler ins Formular zurückzukehren).
  app.use(secureHeaders({ referrerPolicy: 'same-origin' }));
  app.use(basicAuth({ username: user!, password: pw.join(':'), realm: 'Viva-Deluxe' }));
  app.use(csrf());
  app.use(async (c, next) => {
    c.set('actor', user!);
    await next();
    // Seiten dürfen im Zurück-Speicher (bfcache) bleiben, müssen aber beim normalen Aufruf frisch sein.
    if (c.res.headers.get('Content-Type')?.startsWith('text/html')) {
      c.res.headers.set('Cache-Control', 'private, no-cache');
    }
  });

  const page: Ctx['page'] = (c, title, nav, body, status = 200) =>
    c.html(
      '<!doctype html>' +
        String(
          <Layout
            title={title}
            nav={nav}
            env={env.APP_ENV}
            user={user!}
            flash={{ ok: c.req.query('ok'), err: c.req.query('fehler') }}
          >
            {body}
          </Layout>,
        ),
      status,
    );

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

  const ctx: Ctx = { app, deps, page, back };
  registerModuleRoutes(ctx);
  registerMasterdataRoutes(ctx);
  registerInvoiceRoutes(ctx);

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
