import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Child, FC } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from '../services/errors.js';
import {
  type QmSite,
  TICKET_PRIO,
  TICKET_STATUS,
  createTicket,
  listTickets,
  qmAudits,
  qmSites,
  setTicketStatus,
} from '../services/qm.js';
import { type AppEnv, type Ctx, UUID, assertSite } from './app.js';
import { str } from './forms.js';
import { dateDe } from './layout.js';
import { CSS as MCSS, Ic } from './m/routes-mobile.js';

/*
 * QM-App (Audit) für Büro und Objektleitung am Handy – Aufbau wie die Fortytools-Audit-App, in Viva-Bordeaux:
 * Übersicht (Begrüßung, Schnellzugriffe, heutige Audits, „+“ → Audit starten / Ticket erstellen), Objekte (nach Kunde
 * aufklappbar, Suche), Objekt-Details (Raumbuch, Tickets, vergangene Audits), Tickets.
 * Die Bewertung der Räume läuft vorerst über die bestehende Qualitätskontrolle (/qualitaet/…).
 */

const QM_CSS = `
.qm-top{display:flex;align-items:center;gap:10px;padding:4px 0 6px}
.qm-top h1{flex:1;text-align:center;font-size:19px;margin:0;color:#2a1420}
.qm-top a{width:36px;height:36px;display:flex;align-items:center;justify-content:center;color:#2a1420}
.qm-top a svg{width:24px;height:24px}
.qm-search{display:flex;align-items:center;gap:10px;background:rgba(255,255,255,.85);border-radius:999px;padding:4px 18px;box-shadow:0 1px 2px rgba(80,20,40,.05)}
.qm-search svg{width:22px;height:22px;color:#7D1435;flex:none}
.qm-search input{border:0;background:transparent;font-size:17px;padding:12px 0;outline:0}
.qm-cust{background:rgba(255,255,255,.82);border-radius:20px;box-shadow:0 1px 2px rgba(80,20,40,.05),0 8px 24px rgba(80,20,40,.06)}
.qm-cust>summary{list-style:none;display:flex;align-items:center;gap:10px;padding:18px 20px;font-weight:650;font-size:18px;cursor:pointer}
.qm-cust>summary::-webkit-details-marker{display:none}
.qm-cust>summary span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qm-cust>summary svg{width:22px;height:22px;transition:transform .15s;flex:none}
.qm-cust[open]>summary svg{transform:rotate(180deg)}
.qm-site{display:flex;gap:14px;align-items:center;padding:10px 20px 14px;text-decoration:none;color:inherit}
.qm-site .bi{width:52px;height:52px;border-radius:50%;background:#f3dfe6;color:#7D1435;display:flex;align-items:center;justify-content:center;flex:none}
.qm-site .bi svg{width:26px;height:26px}
.qm-site .t{font-size:16px}.qm-site .a{font-size:15px;color:var(--mut);margin-top:2px}
.qm-h{font-size:28px;font-weight:750;margin:6px 0 0;line-height:1.15}
.qm-btns{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.qm-btns a{display:flex;align-items:center;justify-content:center;gap:10px;min-height:58px;border-radius:999px;background:#f3dfe6;color:#2a1420;text-decoration:none;font-size:16px}
.qm-btns a svg{width:22px;height:22px;color:#7D1435}
.qm-sec{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
.qm-sec h2{margin:0;font-size:19px}
.qm-audit{display:flex;justify-content:space-between;align-items:center;text-decoration:none;color:inherit;background:rgba(255,255,255,.82);border-radius:18px;padding:16px 18px;box-shadow:0 1px 2px rgba(80,20,40,.05),0 8px 24px rgba(80,20,40,.06)}
.qm-audit b{font-size:18px}.qm-audit .m{font-size:15px;color:var(--mut);margin-top:4px}
.qm-score{font-size:20px;font-weight:700;color:#7D1435}.qm-score.lo{color:#b42318}.qm-score.mid{color:#b45309}.qm-score.hi{color:#15803d}
.qm-empty{text-align:center;color:var(--mut);padding:40px 16px;font-size:17px}
.qm-empty svg{width:64px;height:64px;color:#9b8790;display:block;margin:0 auto 14px}
.qm-sheet{position:fixed;inset:0;z-index:30}
.qm-sheet>summary{list-style:none}.qm-sheet>summary::-webkit-details-marker{display:none}
.qm-sheet[open]::before{content:"";position:fixed;inset:0;background:rgba(60,20,35,.25)}
.qm-sheet .panel{position:fixed;left:0;right:0;bottom:0;background:#fff;border-radius:28px 28px 0 0;padding:14px 24px calc(28px + env(safe-area-inset-bottom,0px));box-shadow:0 -10px 30px rgba(60,20,35,.15)}
.qm-sheet .grip{width:56px;height:5px;border-radius:9px;background:#2a1420;margin:0 auto 22px}
.qm-sheet h3{font-size:26px;line-height:1.2;margin:0 0 18px}
.qm-sheet .panel a,.qm-sheet .panel button{display:flex;align-items:center;gap:18px;width:100%;padding:20px 0;border:0;border-bottom:1px solid #f0e4e8;background:none;font:inherit;font-size:18px;color:#2a1420;text-decoration:none;cursor:pointer}
.qm-sheet .panel a:last-child{border-bottom:0}
.qm-sheet .panel svg{width:26px;height:26px}.qm-sheet .panel .ar{margin-left:auto;color:#7D1435}
.qm-sheet[open]>summary.fab{display:none}
.qm-sheet:not([open]){position:static}.qm-sheet:not([open])>summary{position:fixed}
.qm-ticket{background:rgba(255,255,255,.82);border-radius:18px;padding:14px 18px;box-shadow:0 1px 2px rgba(80,20,40,.05),0 8px 24px rgba(80,20,40,.06)}
.qm-ticket .w{display:flex;justify-content:space-between;gap:8px;font-size:14px;color:var(--mut)}
.qm-ticket .s{font-size:17px;font-weight:650;margin-top:4px}
.qm-ticket form{display:flex;gap:8px;margin-top:10px}.qm-ticket form button{flex:1;min-height:44px;font-size:15px}
.prio-hoch{color:#b42318;font-weight:700}
`;

const QmLayout: FC<{
  path: string;
  title: string;
  flash: { ok?: string; err?: string };
  children?: Child;
}> = ({ path, title, flash, children }) => (
  <html lang="de">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="theme-color" content="#f8edf1" />
      <title>{`${title} · Qualität · Viva-Deluxe`}</title>
      <link rel="icon" type="image/png" href="/static/favicon.png" />
      <style dangerouslySetInnerHTML={{ __html: MCSS + QM_CSS }} />
    </head>
    <body>
      <main>
        {flash.ok && (
          <div class="flash ok" role="status">
            {flash.ok}
          </div>
        )}
        {flash.err && (
          <div class="flash err" role="alert">
            {flash.err}
          </div>
        )}
        {children}
      </main>
      <nav class="tabbar">
        {(
          [
            ['/qm', 'home', 'Übersicht'],
            ['/qm/objekte', 'building', 'Objekte'],
            ['/qm/tickets', 'ticket', 'Tickets'],
            ['/', 'monitor', 'Büro'],
          ] as const
        ).map(([href, ic, label]) => (
          <a
            href={href}
            class={href === '/' ? '' : (href === '/qm' ? path === '/qm' : path.startsWith(href)) ? 'on' : ''}
          >
            <i>
              <Ic n={ic} />
            </i>
            {label}
          </a>
        ))}
      </nav>
    </body>
  </html>
);

/** „+“ unten rechts mit Auswahl wie Fortytools: Audit starten / Ticket erstellen. */
const Fab: FC<{ siteId?: string }> = ({ siteId }) => (
  <details class="qm-sheet">
    <summary class="fab" aria-label="Neu">
      <Ic n="plus" />
    </summary>
    <div class="panel">
      <div class="grip" />
      <h3>Was möchten Sie als nächstes erledigen?</h3>
      {siteId ? (
        <form method="post" action="/qualitaet/neu" style="margin:0">
          <input type="hidden" name="id" value={randomUUID()} />
          <input type="hidden" name="site_id" value={siteId} />
          <button>
            <Ic n="list" /> Audit starten{' '}
            <span class="ar">
              <Ic n="arrow" />
            </span>
          </button>
        </form>
      ) : (
        <a href="/qm/objekte?start=1">
          <Ic n="list" /> Audit starten{' '}
          <span class="ar">
            <Ic n="arrow" />
          </span>
        </a>
      )}
      <a href={`/qm/tickets/neu${siteId ? `?objekt=${siteId}` : ''}`}>
        <Ic n="ticket" /> Ticket erstellen{' '}
        <span class="ar">
          <Ic n="arrow" />
        </span>
      </a>
    </div>
    <script
      dangerouslySetInnerHTML={{
        __html:
          "document.querySelectorAll('.qm-sheet').forEach(function(d){d.addEventListener('click',function(e){if(d.open&&!e.target.closest('.panel')&&!e.target.closest('summary')){d.open=false}})});",
      }}
    />
  </details>
);

const scoreCls = (p: number | null) => (p == null ? '' : p >= 90 ? 'hi' : p >= 75 ? 'mid' : 'lo');
const dayMonth = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('de-DE', { timeZone: 'UTC', day: 'numeric', month: 'short' });

export function registerQmRoutes({ app, deps, back }: Ctx) {
  const { sql } = deps;
  const render = (c: Context<AppEnv>, title: string, body: Child) =>
    c.html(
      '<!doctype html>' +
        String(
          <QmLayout
            path={c.req.path}
            title={title}
            flash={{ ok: c.req.query('ok') ?? '', err: c.req.query('fehler') ?? '' }}
          >
            {body}
          </QmLayout>,
        ),
    );

  app.get('/qm', async (c) => {
    const u = c.get('user');
    const today = todayBerlin();
    const audits = await qmAudits(sql, { siteIds: c.get('sites'), date: today });
    const hour = Number(
      new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false }),
    );
    const first = (u.name || u.login).split(/[ .]/)[0]!;
    return render(
      c,
      'Übersicht',
      <>
        <div class="hello">
          {hour < 11 ? 'Guten Morgen' : hour < 18 ? 'Guten Tag' : 'Guten Abend'}
          <b>{first.charAt(0).toUpperCase() + first.slice(1)}!</b>
        </div>
        <div class="quick">
          <a href="/einsatzplanung">
            <span class="qi">
              <Ic n="cal" />
            </span>
            Kalender
          </a>
          <a href="/qm/objekte">
            <span class="qi">
              <Ic n="search" />
            </span>
            Suche
          </a>
          <a href="/qm/tickets">
            <span class="qi">
              <Ic n="ticket" />
            </span>
            Tickets
          </a>
          <a href="/qualitaet">
            <span class="qi">
              <Ic n="list" />
            </span>
            Alle Audits
          </a>
        </div>
        {audits.length === 0 ? (
          <div class="qm-empty">
            <Ic n="party" />
            Sie haben heute keine Audits abgeschlossen. Starten Sie Ihr erstes Audit.
          </div>
        ) : (
          <>
            <div class="qm-sec">
              <h2>Heute</h2>
            </div>
            {audits.map((a) => (
              <a class="qm-audit" href={`/qualitaet/${a.id}`}>
                <div>
                  <b>{a.site_name}</b>
                  <div class="m">
                    {a.rated} von {a.items} Räumen · {a.status === 'entwurf' ? 'in Arbeit' : 'abgeschlossen'}
                  </div>
                </div>
                <span class={`qm-score ${scoreCls(a.score_percent)}`}>
                  {a.score_percent != null ? `${a.score_percent} %` : '…'}
                </span>
              </a>
            ))}
          </>
        )}
        <Fab />
      </>,
    );
  });

  app.get('/qm/objekte', async (c) => {
    const q = c.req.query('q') ?? '';
    const start = c.req.query('start') === '1';
    const sites = await qmSites(sql, c.get('sites'), q);
    const groups = new Map<string, QmSite[]>();
    for (const s of sites) groups.set(s.customer_id, [...(groups.get(s.customer_id) ?? []), s]);
    return render(
      c,
      'Einsatzorte',
      <>
        <div class="qm-top">
          <h1>{start ? 'Audit starten – Objekt wählen' : 'Einsatzorte'}</h1>
        </div>
        <form method="get" class="qm-search">
          <Ic n="search" />
          {start && <input type="hidden" name="start" value="1" />}
          <input name="q" value={q} placeholder="Kundenname, Adresse, Objekt …" aria-label="Suche" />
        </form>
        {sites.length === 0 && <div class="qm-empty">Keine Objekte gefunden.</div>}
        {[...groups.values()].map((list) => (
          <details class="qm-cust" open={!!q || groups.size === 1}>
            <summary>
              <span>
                {list[0]!.customer_no} - {list[0]!.customer_name}
              </span>
              <Ic n="chev" />
            </summary>
            {list.map((s) =>
              start ? (
                <form method="post" action="/qualitaet/neu" style="margin:0">
                  <input type="hidden" name="id" value={randomUUID()} />
                  <input type="hidden" name="site_id" value={s.id} />
                  <button
                    class="qm-site"
                    style="background:none;border:0;width:100%;text-align:left;font:inherit"
                  >
                    <span class="bi">
                      <Ic n="building" />
                    </span>
                    <span>
                      <div class="t">
                        {s.site_no} - {s.name}
                      </div>
                      <div class="a">
                        {[s.street, [s.postal_code, s.city].filter(Boolean).join(' ')]
                          .filter(Boolean)
                          .join(', ')}
                      </div>
                    </span>
                  </button>
                </form>
              ) : (
                <a class="qm-site" href={`/qm/objekt/${s.id}`}>
                  <span class="bi">
                    <Ic n="building" />
                  </span>
                  <span>
                    <div class="t">
                      {s.site_no} - {s.name}
                    </div>
                    <div class="a">
                      {[s.street, [s.postal_code, s.city].filter(Boolean).join(' ')]
                        .filter(Boolean)
                        .join(', ')}
                    </div>
                  </span>
                </a>
              ),
            )}
          </details>
        ))}
      </>,
    );
  });

  app.get(`/qm/objekt/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    assertSite(c, id);
    const [s] = await qmSites(sql, [id]);
    if (!s) return c.notFound();
    const audits = await qmAudits(sql, { siteId: id, siteIds: c.get('sites') });
    return render(
      c,
      s.name,
      <>
        <div class="qm-top">
          <a href="/qm/objekte" aria-label="zurück">
            <Ic n="back" />
          </a>
          <h1>Objekt Details</h1>
          <span style="width:36px" />
        </div>
        <div>
          <div class="qm-h">
            {s.site_no} - {s.name}
          </div>
          <div class="mut" style="margin-top:6px">
            {[s.street, [s.postal_code, s.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')}
          </div>
        </div>
        <div class="qm-btns">
          <a href={`/objekte/${id}/raumbuch`}>
            <Ic n="list" /> Raumbuch ({s.rooms})
          </a>
          <a href={`/qm/tickets?objekt=${id}`}>
            <Ic n="ticket" /> Tickets ({s.open_tickets})
          </a>
        </div>
        <div class="qm-sec">
          <h2>Vergangene Audits</h2>
        </div>
        {audits.length === 0 && <div class="qm-empty">Noch keine Audits für dieses Objekt.</div>}
        {audits.map((a) => (
          <a class="qm-audit" href={`/qualitaet/${a.id}`}>
            <div>
              <b>{dayMonth(a.check_date)}</b>
              <div class="m">
                {a.rated} von {a.items} Räumen{a.status === 'entwurf' ? ' · in Arbeit' : ''}
              </div>
            </div>
            <span class={`qm-score ${scoreCls(a.score_percent)}`}>
              {a.score_percent != null ? `${a.score_percent} %` : '…'}
            </span>
          </a>
        ))}
        <Fab siteId={id} />
      </>,
    );
  });

  // ------------------------------------------------------------ Tickets
  app.get('/qm/tickets', async (c) => {
    const siteId = c.req.query('objekt');
    if (siteId) assertSite(c, siteId);
    const all = c.req.query('status') === 'alle';
    const tickets = await listTickets(sql, {
      siteIds: c.get('sites'),
      ...(siteId && /^[0-9a-f-]{36}$/.test(siteId) ? { siteId } : {}),
      status: all ? 'alle' : 'offen',
    });
    const qs = (o: Record<string, string>) =>
      `?${new URLSearchParams({ ...(siteId ? { objekt: siteId } : {}), ...o })}`;
    return render(
      c,
      'Tickets',
      <>
        <div class="qm-top">
          {siteId ? (
            <a href={`/qm/objekt/${siteId}`} aria-label="zurück">
              <Ic n="back" />
            </a>
          ) : (
            <span style="width:36px" />
          )}
          <h1>Tickets</h1>
          <span style="width:36px" />
        </div>
        <div class="langs">
          <a href={qs({})} class={all ? '' : 'on'}>
            offen
          </a>
          <a href={qs({ status: 'alle' })} class={all ? 'on' : ''}>
            alle
          </a>
        </div>
        {tickets.length === 0 && <div class="qm-empty">Keine {all ? '' : 'offenen '}Tickets.</div>}
        {tickets.map((t) => (
          <div class="qm-ticket">
            <div class="w">
              <span>
                {t.number} · {dateDe(t.created_at.toISOString().slice(0, 10))}
              </span>
              <span class={t.priority === 'hoch' ? 'prio-hoch' : ''}>
                {TICKET_STATUS[t.status]}
                {t.priority !== 'normal' && ` · ${TICKET_PRIO[t.priority]}`}
              </span>
            </div>
            <div class="s">{t.title}</div>
            <div class="small mut">
              {t.site_no} - {t.site_name}
              {t.room_label && ` · ${t.room_label}`}
            </div>
            {t.description && (
              <div class="small" style="margin-top:6px;white-space:pre-line">
                {t.description}
              </div>
            )}
            {t.status !== 'erledigt' && (
              <form method="post" action={`/qm/tickets/${t.id}/status`}>
                {t.status === 'offen' && (
                  <button class="big sec" name="status" value="in_arbeit">
                    in Arbeit
                  </button>
                )}
                <button class="big go" name="status" value="erledigt">
                  ✓ erledigt
                </button>
              </form>
            )}
          </div>
        ))}
        <a
          class="fab"
          href={`/qm/tickets/neu${siteId ? `?objekt=${siteId}` : ''}`}
          aria-label="Ticket erstellen"
        >
          <Ic n="plus" />
        </a>
      </>,
    );
  });

  app.get('/qm/tickets/neu', async (c) => {
    const siteId = c.req.query('objekt') ?? '';
    const sites = await qmSites(sql, c.get('sites'));
    const rooms = /^[0-9a-f-]{36}$/.test(siteId)
      ? await sql<{ id: string; label: string }[]>`
          select r.id, concat_ws(' · ', nullif(r.floor, ''), concat_ws(' ', r.room_no, r.name)) as label
            from app.rooms r where r.site_id = ${siteId} and r.active
           order by r.floor nulls first, r.sort_order, r.room_no nulls last, r.name`
      : [];
    return render(
      c,
      'Ticket erstellen',
      <>
        <div class="qm-top">
          <a href={siteId ? `/qm/objekt/${siteId}` : '/qm/tickets'} aria-label="zurück">
            <Ic n="back" />
          </a>
          <h1>Ticket erstellen</h1>
          <span style="width:36px" />
        </div>
        <form method="get" class="card">
          <label for="obj">Objekt</label>
          <select id="obj" name="objekt" onchange="this.form.submit()" required>
            <option value="">– Objekt wählen –</option>
            {sites.map((s) => (
              <option value={s.id} selected={s.id === siteId}>
                {s.site_no} - {s.name}
              </option>
            ))}
          </select>
        </form>
        {siteId && (
          <form method="post" action="/qm/tickets" class="card">
            <input type="hidden" name="id" value={randomUUID()} />
            <input type="hidden" name="site_id" value={siteId} />
            {rooms.length > 0 && (
              <>
                <label for="room">Raum (optional)</label>
                <select id="room" name="room_id">
                  <option value="">– ganzes Objekt –</option>
                  {rooms.map((r) => (
                    <option value={r.id}>{r.label}</option>
                  ))}
                </select>
              </>
            )}
            <label for="title">Worum geht es? *</label>
            <input id="title" name="title" required placeholder="z. B. Papierhandtücher fehlen WC 1. OG" />
            <label for="desc">Beschreibung</label>
            <textarea id="desc" name="description" rows={4} />
            <label for="prio">Priorität</label>
            <select id="prio" name="priority">
              {Object.entries(TICKET_PRIO).map(([k, v]) => (
                <option value={k} selected={k === 'normal'}>
                  {v}
                </option>
              ))}
            </select>
            <div style="height:14px" />
            <button class="big go">Ticket speichern</button>
          </form>
        )}
      </>,
    );
  });

  app.post('/qm/tickets', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const siteId = str(b, 'site_id') ?? '';
    const id = str(b, 'id') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(siteId) || !/^[0-9a-f-]{36}$/.test(id))
      throw new BusinessError('Bitte Objekt wählen');
    assertSite(c, siteId);
    await createTicket(
      sql,
      id,
      {
        siteId,
        roomId: str(b, 'room_id'),
        title: str(b, 'title') ?? '',
        description: str(b, 'description'),
        priority: str(b, 'priority') ?? 'normal',
      },
      c.get('actor'),
    );
    return back(c, `/qm/tickets?objekt=${siteId}`, { ok: 'Ticket gespeichert.' });
  });

  app.post(`/qm/tickets/:id{${UUID}}/status`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    const [t] = await sql<
      { site_id: string }[]
    >`select site_id from app.site_tickets where id = ${c.req.param('id')}`;
    if (!t) return c.notFound();
    assertSite(c, t.site_id);
    await setTicketStatus(sql, c.req.param('id'), str(b, 'status') ?? '', c.get('actor'));
    const ref = c.req.header('referer');
    return back(c, ref ? new URL(ref).pathname + new URL(ref).search : '/qm/tickets', {
      ok: 'Ticket aktualisiert.',
    });
  });
}
