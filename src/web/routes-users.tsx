import { randomUUID } from 'node:crypto';
import { deleteCookie, setCookie } from 'hono/cookie';
import { signSession } from '../services/employee-auth.js';
import { BusinessError } from '../services/errors.js';
import { listSites } from '../services/masterdata.js';
import type { Context } from 'hono';
import {
  type Role,
  ROLE_HINT,
  ROLE_LABEL,
  authenticate,
  changePassword,
  createUser,
  getUser,
  listUsers,
  oneTimePassword,
  resetPassword,
  updateUser,
} from '../services/users.js';
import { type AppEnv, type Ctx, OFFICE_COOKIE, UUID, officeSecret } from './app.js';
import { arr } from './forms.js';
import { Icon } from './icons.js';
import { Layout, PageHead, initials } from './layout.js';
import { homeFor } from './permissions.js';

const SESSION_HOURS = 12;
const safeNext = (n: unknown) =>
  typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/m') ? n : null;

export function registerAuthRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;
  const secret = officeSecret(env);
  const secure = env.APP_ENV !== 'dev';

  // ------------------------------------------------------------------ Anmeldung

  app.get('/anmelden', (c) =>
    c.html(
      '<!doctype html>' +
        String(
          <Layout
            title="Anmelden"
            nav=""
            env={env.APP_ENV}
            bare
            flash={{ err: c.req.query('fehler'), ok: c.req.query('ok') }}
          >
            <div style="max-width:420px;margin:40px auto">
              <form method="post" action="/anmelden" class="card">
                <h1 style="margin-bottom:4px">Anmelden</h1>
                <p class="mut small" style="margin-top:0">
                  Viva-Deluxe Betriebs-App · Büro
                </p>
                <input type="hidden" name="next" value={c.req.query('next') ?? ''} />
                <label for="login">Benutzername</label>
                <input id="login" name="login" autocomplete="username" required autofocus />
                <label for="password" style="margin-top:12px">
                  Passwort
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autocomplete="current-password"
                  required
                />
                <div class="formfoot">
                  <button class="btn" style="width:100%;justify-content:center">
                    Anmelden
                  </button>
                </div>
              </form>
              <p class="small mut" style="text-align:center">
                Mitarbeitende im Objekt: <a href="/m">Zeiterfassung am Handy</a>
              </p>
            </div>
          </Layout>,
        ),
    ),
  );

  app.post('/anmelden', async (c) => {
    const b = await c.req.parseBody();
    const next = safeNext(b.next);
    try {
      const u = await authenticate(sql, String(b.login ?? ''), String(b.password ?? ''));
      setCookie(c, OFFICE_COOKIE, signSession(secret, u.id, Date.now(), SESSION_HOURS / 24), {
        httpOnly: true,
        secure,
        sameSite: 'Lax',
        path: '/',
        maxAge: SESSION_HOURS * 3600,
      });
      await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${u.login}, 'login', 'user', ${u.id})`;
      return c.redirect(u.must_change_password ? '/konto' : (next ?? homeFor(u.role)), 303);
    } catch (err) {
      if (err instanceof BusinessError) {
        return c.redirect(
          `/anmelden?fehler=${encodeURIComponent(err.message)}${next ? `&next=${encodeURIComponent(next)}` : ''}`,
          303,
        );
      }
      throw err;
    }
  });

  app.post('/abmelden', (c) => {
    deleteCookie(c, OFFICE_COOKIE, { path: '/' });
    return c.redirect('/anmelden?ok=Abgemeldet.', 303);
  });

  // ------------------------------------------------------------------ Mein Konto

  app.get('/konto', (c) => {
    const u = c.get('user');
    return page(
      c,
      'Mein Konto',
      '',
      <>
        <PageHead title="Mein Konto" />
        <div class="cols">
          <form method="post" action="/konto" class="card">
            <h3>Passwort ändern</h3>
            {u.must_change_password && (
              <div class="hint" style="margin-bottom:12px">
                Bitte ein eigenes Passwort festlegen, bevor es weitergeht.
              </div>
            )}
            <label for="current">Aktuelles Passwort</label>
            <input id="current" name="current" type="password" autocomplete="current-password" required />
            <label for="next" style="margin-top:12px">
              Neues Passwort (mind. 10 Zeichen, Buchstaben und Ziffern)
            </label>
            <input
              id="next"
              name="next"
              type="password"
              autocomplete="new-password"
              minlength={10}
              required
            />
            <label for="next2" style="margin-top:12px">
              Neues Passwort wiederholen
            </label>
            <input
              id="next2"
              name="next2"
              type="password"
              autocomplete="new-password"
              minlength={10}
              required
            />
            <div class="formfoot">
              <button class="btn">Passwort speichern</button>
            </div>
          </form>
          <div class="card">
            <div class="person">
              <span class="avatar">{initials(u.name)}</span>
              <div>
                <b>{u.name}</b>
                <div class="small mut">
                  {u.login} · {ROLE_LABEL[u.role]}
                </div>
              </div>
            </div>
            <p class="small mut">{ROLE_HINT[u.role]}</p>
          </div>
        </div>
      </>,
    );
  });

  app.post('/konto', async (c) => {
    const b = await c.req.parseBody();
    if (b.next !== b.next2) throw new BusinessError('Die neuen Passwörter stimmen nicht überein');
    const u = c.get('user');
    await changePassword(sql, u.id, String(b.current ?? ''), String(b.next ?? ''));
    return back(c, homeFor(u.role), { ok: 'Passwort geändert.' });
  });

  // ------------------------------------------------------------------ Benutzerverwaltung (Admin)

  app.get('/benutzer', async (c) => {
    const users = await listUsers(sql);
    return page(
      c,
      'Benutzer',
      '',
      <>
        <PageHead title="Benutzer & Rechte">
          <a class="btn" href={`/benutzer/${randomUUID()}`} style="margin-left:auto">
            <Icon name="plus" /> Benutzer anlegen
          </a>
        </PageHead>
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Benutzername</th>
                <th>Rolle</th>
                <th class="r">Objekte</th>
                <th>Letzte Anmeldung</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr style={u.active ? '' : 'opacity:.55'}>
                  <td>
                    <a href={`/benutzer/${u.id}`}>
                      <b>{u.name}</b>
                    </a>
                    {u.email && <div class="small mut">{u.email}</div>}
                  </td>
                  <td>{u.login}</td>
                  <td>{ROLE_LABEL[u.role]}</td>
                  <td class="r">{u.role === 'objektleitung' ? u.sites : '–'}</td>
                  <td class="small">
                    {u.last_login_at
                      ? u.last_login_at.toLocaleString('de-DE', {
                          timeZone: 'Europe/Berlin',
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })
                      : 'noch nie'}
                  </td>
                  <td>
                    {!u.active ? (
                      <span class="badge">deaktiviert</span>
                    ) : u.locked_until && u.locked_until > new Date() ? (
                      <span class="badge err">gesperrt</span>
                    ) : u.must_change_password ? (
                      <span class="badge warn">Erstpasswort</span>
                    ) : (
                      <span class="badge ok">aktiv</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div class="card" style="margin-top:16px">
          <h3>Rollen</h3>
          <dl class="kv">
            {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
              <>
                <dt>{ROLE_LABEL[r]}</dt>
                <dd class="small">{ROLE_HINT[r]}</dd>
              </>
            ))}
          </dl>
        </div>
      </>,
    );
  });

  const userPage = async (c: Context<AppEnv>, id: string, pw: string | null, note: string | null = null) => {
    const [u, sites] = await Promise.all([getUser(sql, id), listSites(sql)]);
    const mine = u
      ? sites
          .filter((s) => (s as { manager_user_id?: string | null }).manager_user_id === id)
          .map((s) => s.id)
      : [];
    const managerName = new Map(
      (
        await sql<{ user_id: string; display_name: string }[]>`select user_id, display_name from app.profiles`
      ).map((p) => [p.user_id, p.display_name]),
    );
    const byCust = new Map<string, (typeof sites)[number][]>();
    for (const s of sites.filter((x) => x.active !== false || mine.includes(x.id))) {
      const k = s.customer_name;
      if (!byCust.has(k)) byCust.set(k, []);
      byCust.get(k)!.push(s);
    }
    const groups = [...byCust.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de'));
    const res = await page(
      c,
      u ? u.name : 'Neuer Benutzer',
      '',
      <>
        <PageHead title={u ? u.name : 'Neuer Benutzer'} crumbs={[['Benutzer', '/benutzer']]} />
        {note && (
          <div class="flash ok">
            <span>{note}</span>
          </div>
        )}
        {pw && (
          <div class="flash ok">
            <span>
              Einmal-Passwort: <b style="font-family:monospace;font-size:16px">{pw}</b> – jetzt notieren und
              persönlich übergeben. Es wird nicht erneut angezeigt; bei der ersten Anmeldung muss ein eigenes
              Passwort gewählt werden.
            </span>
          </div>
        )}
        <div class="cols">
          <form method="post" action={`/benutzer/${id}`} class="card" data-version={String(u?.version ?? '')}>
            <input type="hidden" name="version" value={String(u?.version ?? '')} />
            <div class="grid">
              <div>
                <label for="name">Name</label>
                <input id="name" name="name" value={u?.name ?? ''} required />
              </div>
              <div>
                <label for="login">Benutzername</label>
                <input
                  id="login"
                  name="login"
                  value={u?.login ?? ''}
                  required
                  disabled={!!u}
                  pattern="[a-z0-9._@\-]{3,64}"
                />
              </div>
              <div>
                <label for="email">E-Mail</label>
                <input id="email" name="email" type="email" value={u?.email ?? ''} />
              </div>
              <div>
                <label for="phone">Telefon (wird bei Objekten angezeigt)</label>
                <input id="phone" name="phone" type="tel" value={u?.phone ?? ''} />
              </div>
              <div>
                <label for="role">Rolle</label>
                <select id="role" name="role">
                  {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                    <option value={r} selected={(u?.role ?? 'buchhaltung') === r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </div>
              {u && (
                <div class="chk" style="align-self:end;height:38px">
                  <input type="checkbox" id="active" name="active" checked={u.active} />
                  <label for="active">aktiv</label>
                </div>
              )}
            </div>
            <h3 style="margin-top:16px">Objekte (nur für Objektleitung)</h3>
            <p class="small mut" style="margin-top:0">
              Häkchen setzen = diese Person ist Objektleitung des Objekts (sieht nur diese Objekte). Ein
              Objekt hat genau eine Objektleitung – wer bisher zuständig war, steht dahinter.
            </p>
            <div class="site-pick" data-site-pick>
              <div class="actions" style="margin:0 0 8px;align-items:center">
                <input
                  type="search"
                  placeholder="Objekt, Nummer oder Kunde suchen …"
                  data-site-q
                  style="max-width:320px"
                  aria-label="Objekte filtern"
                />
                <button type="button" class="btn sm sec" data-site-all="1">
                  Alle angezeigten markieren
                </button>
                <button type="button" class="btn sm ghost" data-site-all="0">
                  Alle angezeigten entfernen
                </button>
                <span class="small mut">
                  <b data-site-n>{mine.length}</b> ausgewählt
                </span>
              </div>
              <div style="max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:var(--r-sm);padding:6px 12px">
                {groups.map(([cust, list]) => (
                  <div class="site-grp" style="padding:6px 0;border-bottom:1px solid var(--line)">
                    <div class="chk" style="font-weight:600">
                      <input type="checkbox" data-grp aria-label={`Alle Objekte von ${cust}`} />
                      <span>{cust}</span>
                    </div>
                    {list.map((s) => (
                      <div
                        class="chk site-row"
                        style="padding:2px 0 2px 26px"
                        data-text={`${s.site_no} ${s.name} ${cust} ${s.city ?? ''}`.toLowerCase()}
                      >
                        <input
                          type="checkbox"
                          id={`s-${s.id}`}
                          name="site"
                          value={s.id}
                          checked={mine.includes(s.id)}
                        />
                        <label for={`s-${s.id}`}>
                          {s.site_no} · {s.name}
                          {s.manager_user_id && s.manager_user_id !== id && (
                            <span class="small mut">
                              {' '}
                              (bisher: {managerName.get(s.manager_user_id) ?? '–'})
                            </span>
                          )}
                        </label>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <script
                dangerouslySetInnerHTML={{
                  __html: `(function(){var r=document.querySelector('[data-site-pick]');if(!r)return;
var q=r.querySelector('[data-site-q]'),n=r.querySelector('[data-site-n]');
function cnt(){n.textContent=r.querySelectorAll('input[name=site]:checked').length;
r.querySelectorAll('.site-grp').forEach(function(g){var b=g.querySelectorAll('input[name=site]'),c=g.querySelectorAll('input[name=site]:checked');var h=g.querySelector('[data-grp]');h.checked=b.length>0&&c.length===b.length;h.indeterminate=c.length>0&&c.length<b.length;});}
function norm(x){return x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');}
q.addEventListener('input',function(){var t=norm(q.value).split(/\\s+/).filter(Boolean);
r.querySelectorAll('.site-grp').forEach(function(g){var any=false;g.querySelectorAll('.site-row').forEach(function(row){var ok=t.every(function(w){return norm(row.dataset.text).indexOf(w)>=0});row.hidden=!ok;if(ok)any=true;});g.hidden=!any;});});
r.addEventListener('change',function(e){var t=e.target;if(t.hasAttribute('data-grp')){t.closest('.site-grp').querySelectorAll('.site-row:not([hidden]) input[name=site]').forEach(function(b){b.checked=t.checked});}cnt();});
r.querySelectorAll('[data-site-all]').forEach(function(btn){btn.addEventListener('click',function(){var v=btn.dataset.siteAll==='1';r.querySelectorAll('.site-grp:not([hidden]) .site-row:not([hidden]) input[name=site]').forEach(function(b){b.checked=v});cnt();});});
cnt();})();`,
                }}
              />
            </div>
            {!u && <p class="small mut">Nach dem Anlegen wird ein Einmal-Passwort angezeigt.</p>}
            <div class="formfoot">
              <a class="btn sec" href="/benutzer">
                Abbrechen
              </a>
              <button class="btn">{u ? 'Speichern' : 'Benutzer anlegen'}</button>
            </div>
          </form>
          {u && (
            <form
              method="post"
              action={`/benutzer/${id}/passwort`}
              class="card"
              onsubmit="return confirm('Neues Einmal-Passwort erzeugen? Das alte gilt dann nicht mehr.')"
            >
              <h3>Passwort vergessen / gesperrt?</h3>
              <p class="small mut" style="margin-top:0">
                Erzeugt ein Einmal-Passwort und hebt eine Sperre auf.
              </p>
              <button class="btn sec">Einmal-Passwort erzeugen</button>
            </form>
          )}
        </div>
      </>,
    );
    // Seite mit Einmal-Passwort nicht zwischenspeichern
    if (pw) res.headers.set('Cache-Control', 'no-store');
    return res;
  };

  app.get(`/benutzer/:id{${UUID}}`, (c) => userPage(c, c.req.param('id'), null));

  app.post(`/benutzer/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const one = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '');
    const role = one('role') as Role;
    if (!(role in ROLE_LABEL)) throw new BusinessError('Rolle ungültig');
    const existing = await getUser(sql, id);
    if (!existing) {
      const tmp = oneTimePassword();
      const r = await createUser(
        sql,
        {
          id,
          login: one('login'),
          name: one('name'),
          email: one('email') || null,
          role,
          password: tmp,
          mustChange: true,
        },
        c.get('actor'),
      );
      if (!r.created)
        return back(c, `/benutzer/${id}`, {
          ok: 'Benutzer war schon angelegt. Bei Bedarf Einmal-Passwort neu erzeugen.',
        });
      await updateUser(
        sql,
        id,
        {
          name: one('name'),
          email: one('email') || null,
          phone: one('phone') || null,
          role,
          active: true,
          siteIds: arr(b, 'site'),
          expectedVersion: null,
        },
        c.get('actor'),
      );
      return userPage(c, id, tmp, 'Benutzer angelegt.');
    }
    await updateUser(
      sql,
      id,
      {
        name: one('name'),
        email: one('email') || null,
        phone: one('phone') || null,
        role,
        active: b.active === 'on',
        siteIds: arr(b, 'site'),
        expectedVersion: typeof b.version === 'string' && b.version ? Number(b.version) : null,
      },
      c.get('actor'),
    );
    return back(c, `/benutzer/${id}`, { ok: 'Gespeichert.' });
  });

  app.post(`/benutzer/:id{${UUID}}/passwort`, async (c) => {
    const id = c.req.param('id');
    const pw = await resetPassword(sql, id, c.get('actor'));
    return userPage(c, id, pw, 'Einmal-Passwort erzeugt, Sperre aufgehoben.');
  });
}
