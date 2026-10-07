import { fullName } from '../services/users.js';
import { canAccess } from './permissions.js';
import { randomUUID } from 'node:crypto';
import { SiteOptions } from './site-options.js';
import type { Context } from 'hono';
import type { Child, FC } from 'hono/jsx';
import { hourBerlin, todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from '../services/errors.js';
import {
  type QmSite,
  TICKET_PRIO,
  QM_KIND,
  TICKET_STATUS,
  auditRooms,
  auditScore,
  itemsForRoomType,
  ratingPercent,
  QM_SCALE,
  scaleLabel,
  roomMeta,
  roomRatings,
  saveRoomRatings,
  createTicket,
  listQmItems,
  saveQmItem,
  type QmItem,
  type UsageType,
  deleteQmItem,
  deleteUsageType,
  listUsageTypes,
  qmItemUsed,
  saveUsageType,
  usageTypeItemIds,
  listTickets,
  qmAudits,
  qmSites,
  setTicketStatus,
} from '../services/qm.js';
import { type AppEnv, type Ctx, UUID, assertSite } from './app.js';
import { str } from './forms.js';
import { storeFile } from '../services/uploads.js';
import { createQualityCheck } from '../services/facility.js';
import { APP_TAB_CSS, AppTabbar, PageHead, dateDe } from './layout.js';
import { Icon } from './icons.js';
import { CSS as MCSS, Ic } from './m/routes-mobile.js';

/*
 * QM-App (Audit) für Büro und Objektleitung am Handy – Aufbau wie die Fortytools-Audit-App, in Viva-Bordeaux:
 * Übersicht (Begrüßung, Schnellzugriffe, heutige Audits, „+“ → Audit starten / Ticket erstellen), Objekte (nach Kunde
 * aufklappbar, Suche), Objekt-Details (Raumbuch, Tickets, vergangene Audits), Tickets.
 * Die Bewertung der Räume läuft vorerst über die bestehende Qualitätskontrolle (/qualitaet/…).
 */

const QM_CSS = `
.qm-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:12px 0}.qm-grid a{display:flex;align-items:center;gap:10px;padding:14px;border-radius:14px;background:#fff;border:1px solid #efe3e7;color:#3b0a1c;font-weight:600;text-decoration:none}.qm-grid a svg{width:22px;height:22px;color:#7d1435;flex:none}
.quick{flex-wrap:wrap;row-gap:14px}
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
.qm-room{display:flex;align-items:center;gap:12px;padding:16px 4px;border-bottom:1px solid #eadfe3;text-decoration:none;color:inherit}
.qm-room .t{font-size:18px;font-weight:650}.qm-room .a{font-size:14.5px;color:var(--mut);margin-top:3px}
.qm-room .r{margin-left:auto;display:flex;align-items:center;gap:10px;color:#7D1435}.qm-room .r svg{width:22px;height:22px}
.qm-room .pc{font-size:15px;font-weight:700}
.qm-item{background:rgba(255,255,255,.85);border-radius:20px;padding:16px 18px;box-shadow:0 1px 2px rgba(80,20,40,.05),0 8px 24px rgba(80,20,40,.06)}
.qm-item .hd{display:flex;align-items:center;gap:10px}.qm-item .hd b{font-size:19px;flex:1}
.qm-item .skip{display:inline-flex;align-items:center;gap:6px;color:#7D1435;font-size:15px;margin:8px 0 2px}
.qm-item .skip input{width:18px;height:18px;accent-color:#7D1435}
.scale{display:flex;justify-content:space-between;align-items:center;position:relative;margin:22px 8px 14px}
.scale::before{content:"";position:absolute;left:10px;right:10px;top:50%;height:3px;background:#ead6dd;border-radius:3px}
.scale label{position:relative;margin:0;display:flex;align-items:center;justify-content:center;width:44px;height:44px;cursor:pointer}
.scale input{position:absolute;opacity:0}
.scale span{width:16px;height:16px;border-radius:50%;background:#ddd0d5;display:flex;align-items:center;justify-content:center;font-weight:750;color:#fff;font-size:20px;transition:all .12s}
.scale input:checked+span{width:52px;height:52px;background:linear-gradient(135deg,#b34a6a,#7D1435)}
.scale input:checked+span::after{content:attr(data-v)}
.yn{display:flex;justify-content:center;gap:22px;margin:16px 0 8px}
.yn label{margin:0;cursor:pointer}.yn input{position:absolute;opacity:0}
.yn span{display:flex;align-items:center;justify-content:center;width:80px;height:80px;border-radius:50%;border:2px solid #d7c3cb;font-size:15px;font-weight:600;color:#7D1435}
.yn .no span{border-color:#e6a3b4;color:#b42318}
.yn input:checked+span{background:#7D1435;border-color:#7D1435;color:#fff}.yn .no input:checked+span{background:#b42318;border-color:#b42318}
.qm-item.skipped .scale,.qm-item.skipped .yn{opacity:.3;pointer-events:none}
.qm-item textarea{margin-top:6px;font-size:16px;border-radius:12px}
.qm-photos{display:flex;align-items:center;gap:14px;margin-top:10px}
.qm-photos label{margin:0;width:84px;height:84px;border-radius:14px;border:1px dashed #d7c3cb;display:flex;align-items:center;justify-content:center;color:#7D1435;cursor:pointer;flex:none}
.qm-photos label svg{width:34px;height:34px}.qm-photos input{display:none}.qm-photos small{color:var(--mut);font-size:13.5px}
#qmf{display:flex;flex-direction:column;gap:16px}
.qm-note{display:flex;justify-content:space-between;align-items:center;padding:4px 4px 0}.qm-note b{font-size:30px;color:#7D1435}

`;

export const QmLayout: FC<{
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
      <style dangerouslySetInnerHTML={{ __html: MCSS + QM_CSS + APP_TAB_CSS }} />
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
      <AppTabbar path={path} />
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
        <form method="post" action="/qm/audit/neu" style="margin:0">
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

export function registerQmRoutes({ app, deps, back, page }: Ctx) {
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
    const hour = hourBerlin();
    const first = fullName(u).split(' ')[0]!;
    return render(
      c,
      'Übersicht',
      <>
        <div class="hello">
          {hour < 11 ? 'Guten Morgen' : hour < 18 ? 'Guten Tag' : 'Guten Abend'}
          <b>{first.charAt(0).toUpperCase() + first.slice(1)}!</b>
        </div>
        <div class="quick">
          {(
            [
              ['/m', 'clock', 'Meine Zeiterfassung'],
              ['/qm/objekte', 'building', 'Objekte'],
              ['/einsatzplanung', 'cal', 'Planung'],
              ['/zeiterfassung', 'clock', 'Zeiten (Team)'],
              ['/personal', 'list', 'Mitarbeiter'],
              ['/personal/dokumente', 'doc', 'Dokumente'],
              ['/urlaub', 'sun', 'Urlaub'],
              ['/kunden', 'home', 'Kunden'],
              ['/qm/tickets', 'ticket', 'Tickets'],
              ['/qualitaet', 'list', 'Alle Audits'],
              ['/arbeitsscheine', 'times', 'Arbeitsscheine'],
              ['/qm/personalbogen', 'doc', 'Personalbogen'],
              ['/qm/nu-auftrag', 'building', 'NU-Auftrag'],
              ['/transfer/dokumenteneingang', 'doc', 'Posteingang'],
              ['/?pc=1', 'monitor', 'PC-Ansicht'],
            ] as const
          )
            .filter(([href]) => canAccess(u.role, href))
            .map(([href, ic, label]) => (
              <a href={href}>
                <span class="qi">
                  <Ic n={ic} />
                </span>
                {label}
              </a>
            ))}
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
              <a class="qm-audit" href={a.status === 'entwurf' ? `/qm/audit/${a.id}` : `/qualitaet/${a.id}`}>
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
                <form method="post" action="/qm/audit/neu" style="margin:0">
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
        <div class="qm-grid">
          {(
            [
              [`/objekte/${id}/einsaetze`, 'cal', 'Einsätze'],
              [`/objekte/${id}/dokumente`, 'doc', 'Dokumente'],
              [`/objekte/${id}/notizen`, 'list', 'Notizen'],
              [`/objekte/${id}/leistungen`, 'times', 'Leistungen & Preise'],
              [`/objekte/${id}`, 'monitor', 'Objekt am PC öffnen'],
              [`/objekte/${id}/zeiten`, 'clock', 'Zeiten'],
              [`/objekte/${id}/schluessel`, 'list', 'Schlüssel'],
              [`/objekte/${id}/uebergaben`, 'doc', 'Übergabe / Unterweisung'],
              [`/objekte/${id}/objektordner`, 'building', 'Objektordner'],
              [`/arbeitsscheine/${randomUUID()}?objekt=${id}`, 'times', 'Arbeitsschein'],
              [`/qm/personalbogen?objekt=${id}`, 'doc', 'Personalbogen'],
              [`/qm/nu-auftrag?objekt=${id}`, 'building', 'NU-Auftrag anfragen'],
            ] as const
          )
            .filter(([href]) => canAccess(c.get('user').role, href.split('?')[0]!))
            .map(([href, ic, label]) => (
              <a href={href}>
                <Ic n={ic} />
                <span>{label}</span>
              </a>
            ))}
        </div>
        <div class="qm-sec">
          <h2>Vergangene Audits</h2>
        </div>
        {audits.length === 0 && <div class="qm-empty">Noch keine Audits für dieses Objekt.</div>}
        {audits.map((a) => (
          <a class="qm-audit" href={a.status === 'entwurf' ? `/qm/audit/${a.id}` : `/qualitaet/${a.id}`}>
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

  // ------------------------------------------------------------ Audit Raum für Raum
  app.post('/qm/audit/neu', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const id = str(b, 'id') ?? '';
    const siteId = str(b, 'site_id') ?? '';
    if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f-]{36}$/.test(siteId))
      throw new BusinessError('Bitte Objekt wählen');
    assertSite(c, siteId);
    const u = c.get('user');
    await createQualityCheck(
      sql,
      id,
      { siteId, checkDate: todayBerlin(), inspector: u.name || u.login, attendee: null },
      c.get('actor'),
    );
    return c.redirect(`/qm/audit/${id}`, 303);
  });

  const loadAudit = async (c: Context<AppEnv>, id: string) => {
    const [qc] = await sql<
      {
        id: string;
        site_id: string;
        status: string;
        check_date: string;
        number: string;
        site_name: string;
        site_no: string;
      }[]
    >`
      select q.id, q.site_id, q.status::text, q.check_date::text, q.number, s.name as site_name, s.site_no
        from app.quality_checks q join app.sites s on s.id = q.site_id where q.id = ${id}`;
    if (qc) assertSite(c, qc.site_id);
    return qc;
  };

  app.get(`/qm/audit/:id{${UUID}}`, async (c) => {
    const qc = await loadAudit(c, c.req.param('id'));
    if (!qc) return c.notFound();
    const q = c.req.query('q') ?? '';
    const rooms = await auditRooms(sql, qc.id, qc.site_id, q);
    const score = await auditScore(sql, qc.id);
    const done = rooms.filter((r) => r.rated > 0).length;
    return render(
      c,
      qc.site_name,
      <>
        <div class="qm-top">
          <a href={`/qm/objekt/${qc.site_id}`} aria-label="zurück">
            <Ic n="back" />
          </a>
          <h1>
            {qc.site_no} - {qc.site_name}
          </h1>
          <span style="width:36px" />
        </div>
        <div class="qm-note">
          <span class="mut">
            {qc.number} · {done} von {rooms.length} Räumen
          </span>
          <b>{score != null ? `${score} %` : '–'}</b>
        </div>
        <form method="get" class="qm-search">
          <Ic n="search" />
          <input name="q" value={q} placeholder="z. B. Name, Raum, Stockwerk …" aria-label="Suche" />
        </form>
        <div class="qm-sec">
          <h2>Räume</h2>
        </div>
        {rooms.length === 0 && (
          <div class="qm-empty">
            Kein Raumbuch für dieses Objekt. Bitte am PC unter Objekt → Raumbuch die Räume anlegen.
          </div>
        )}
        <div>
          {rooms.map((r) => (
            <a class="qm-room" href={`/qm/audit/${qc.id}/raum/${r.id}`}>
              <div>
                <div class="t">{r.name}</div>
                <div class="a">{roomMeta(r)}</div>
              </div>
              <span class="r">
                {r.score != null && (
                  <span class={`pc qm-score ${r.score >= 90 ? 'hi' : r.score >= 75 ? 'mid' : 'lo'}`}>
                    {r.score} %
                  </span>
                )}
                <Ic n="arrow" />
              </span>
            </a>
          ))}
        </div>
        {qc.status === 'entwurf' && done > 0 && (
          <a class="big go" href={`/qualitaet/${qc.id}/abschliessen`}>
            Audit abschließen
          </a>
        )}
      </>,
    );
  });

  app.get(`/qm/audit/:id{${UUID}}/raum/:room{${UUID}}`, async (c) => {
    const qc = await loadAudit(c, c.req.param('id'));
    if (!qc) return c.notFound();
    const [room] = (await auditRooms(sql, qc.id, qc.site_id)).filter((r) => r.id === c.req.param('room'));
    if (!room) return c.notFound();
    const [items, existing] = await Promise.all([
      itemsForRoomType(sql, room.room_type_id),
      roomRatings(sql, qc.id, room.id),
    ]);
    const val = new Map(existing.map((e) => [e.item_id, e]));
    const locked = qc.status !== 'entwurf';
    return render(
      c,
      room.name,
      <>
        <div class="qm-top">
          <a href={`/qm/audit/${qc.id}`} aria-label="zurück">
            <Ic n="back" />
          </a>
          <h1>
            {room.name}
            <div class="small mut" style="font-weight:400">
              {roomMeta(room)}
            </div>
          </h1>
          <a
            href={`/qm/tickets/neu?objekt=${qc.site_id}&raum=${room.id}`}
            style="width:auto;color:#7D1435;font-size:15px"
          >
            + Ticket
          </a>
        </div>
        <div class="qm-note">
          <span>Gesamtnote</span>
          <b id="gnote">{room.score != null ? `${room.score} %` : '0 %'}</b>
        </div>
        <form
          method="post"
          action={`/qm/audit/${qc.id}/raum/${room.id}`}
          enctype="multipart/form-data"
          id="qmf"
        >
          {items.map((it) => {
            const e = val.get(it.id);
            return (
              <div class={`qm-item${e?.skipped ? ' skipped' : ''}`} data-item>
                <div class="hd">
                  <b>{it.name}</b>
                  {e && !e.skipped && e.value != null && (
                    <span class="mut">{scaleLabel(it.kind, e.value)}</span>
                  )}
                </div>
                <label class="skip">
                  <input
                    type="checkbox"
                    name={`s_${it.id}`}
                    value="1"
                    checked={!!e?.skipped}
                    disabled={locked}
                  />{' '}
                  Überspringen
                </label>
                {it.kind === 'note' || it.kind === 'punkte' ? (
                  <div
                    class="scale"
                    title={
                      it.kind === 'note'
                        ? 'links 6 (ungenügend) … rechts 1 (sehr gut)'
                        : 'links 1 (schlecht) … rechts 5 (sehr gut)'
                    }
                  >
                    {QM_SCALE[it.kind].map((o) => (
                      <label>
                        <input
                          type="radio"
                          name={`v_${it.id}`}
                          value={String(o.v)}
                          data-pct={String(o.pct)}
                          checked={e?.value === o.v}
                          disabled={locked}
                        />
                        <span data-v={o.label} />
                      </label>
                    ))}
                  </div>
                ) : (
                  <div class="yn">
                    {QM_SCALE[it.kind].map((o) => (
                      <label class={o.pct === 0 ? 'no' : ''}>
                        <input
                          type="radio"
                          name={`v_${it.id}`}
                          value={String(o.v)}
                          data-pct={String(o.pct)}
                          checked={e?.value === o.v}
                          disabled={locked}
                        />
                        <span>{o.label}</span>
                      </label>
                    ))}
                  </div>
                )}
                <textarea
                  name={`n_${it.id}`}
                  rows={3}
                  placeholder="Bitte geben Sie einen Grund für Ihre Bewertung an. Dies kann jedes Feedback sein, positiv oder negativ."
                  disabled={locked}
                >
                  {e?.note ?? ''}
                </textarea>
                <div class="qm-photos">
                  {!locked && (
                    <label>
                      <Ic n="plus" />
                      <input type="file" name={`f_${it.id}`} accept="image/*" multiple />
                    </label>
                  )}
                  <small>
                    {e?.photo_ids.length ? `${e.photo_ids.length} Foto(s) gespeichert · ` : ''}Laden Sie bis
                    zu 5 Fotos hoch
                  </small>
                </div>
              </div>
            );
          })}
          {!locked && <button class="big go">Speichern &amp; nächster Raum</button>}
        </form>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var f=document.getElementById('qmf');if(!f)return;
function upd(){var s=0,n=0;f.querySelectorAll('[data-item]').forEach(function(d){var sk=d.querySelector('input[type=checkbox]');d.classList.toggle('skipped',sk&&sk.checked);if(sk&&sk.checked)return;var r=d.querySelector('input[type=radio]:checked');if(r){s+=Number(r.getAttribute('data-pct'));n++}});document.getElementById('gnote').textContent=(n?Math.round(s/n):0)+' %'}
f.addEventListener('change',upd);
f.querySelectorAll('input[type=file]').forEach(function(i){i.addEventListener('change',function(){if(i.files.length>5){alert('Bitte höchstens 5 Fotos');i.value=''}var sm=i.closest('.qm-photos').querySelector('small');if(i.files.length)sm.textContent=i.files.length+' Foto(s) ausgewählt'})});})();`,
          }}
        />
      </>,
    );
  });

  app.post(`/qm/audit/:id{${UUID}}/raum/:room{${UUID}}`, async (c) => {
    const qc = await loadAudit(c, c.req.param('id'));
    if (!qc) return c.notFound();
    const roomId = c.req.param('room');
    const rooms = await auditRooms(sql, qc.id, qc.site_id);
    const room = rooms.find((r) => r.id === roomId);
    if (!room) return c.notFound();
    const items = await itemsForRoomType(sql, room.room_type_id);
    const b = await c.req.parseBody({ all: true });
    const cfg = { dir: deps.env.FILES_DIR, maxBytes: deps.env.UPLOAD_MAX_BYTES };
    const ratings = [];
    for (const it of items) {
      const skipped = str(b, `s_${it.id}`) === '1';
      const raw = str(b, `v_${it.id}`);
      const value = raw && QM_SCALE[it.kind].some((o) => String(o.v) === raw) ? Number(raw) : null;
      const note = str(b, `n_${it.id}`);
      if (!skipped && value == null && !note) continue; // nicht bewertet
      if (!skipped && value == null) throw new BusinessError(`${it.name}: bitte bewerten oder überspringen`);
      const files = ([] as unknown[])
        .concat(b[`f_${it.id}`] ?? [])
        .filter((f): f is File => f instanceof File && f.size > 0);
      if (files.length > 5) throw new BusinessError(`${it.name}: höchstens 5 Fotos`);
      const photoIds: string[] = [];
      for (const f of files) {
        if (!/^image\//.test(f.type)) throw new BusinessError('Nur Fotos (Bilder) hochladen');
        const fid = randomUUID();
        await storeFile(
          sql,
          cfg,
          {
            id: fid,
            name: f.name || 'foto.jpg',
            type: f.type,
            data: new Uint8Array(await f.arrayBuffer()),
            link: { type: 'quality_check', id: qc.id },
            category: `Audit ${room.name} – ${it.name}`.slice(0, 120),
          },
          c.get('actor'),
        );
        photoIds.push(fid);
      }
      ratings.push({ itemId: it.id, value, skipped, note, photoIds });
    }
    await saveRoomRatings(sql, { checkId: qc.id, roomId, ratings, actor: c.get('actor') });
    // nächster noch nicht bewerteter Raum
    const idx = rooms.findIndex((r) => r.id === roomId);
    const next = [...rooms.slice(idx + 1), ...rooms.slice(0, idx)].find((r) => r.rated === 0);
    const kindOf = new Map(items.map((i) => [i.id, i.kind]));
    const pct = ratings
      .filter((r) => !r.skipped && r.value)
      .map((r) => ratingPercent(r.value!, kindOf.get(r.itemId)));
    const msg = pct.length
      ? `${room.name}: ${Math.round(pct.reduce((a, x) => a + x, 0) / pct.length)} %`
      : 'Gespeichert.';
    return back(c, next ? `/qm/audit/${qc.id}/raum/${next.id}` : `/qm/audit/${qc.id}`, { ok: msg });
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
    const roomPre = c.req.query('raum') ?? '';
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
            <SiteOptions sites={sites} selected={siteId} />
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
                    <option value={r.id} selected={r.id === roomPre}>
                      {r.label}
                    </option>
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

  // ------------------------------------------------------------ Einstellungen (am PC) – wie Fortytools
  const versionOf = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
  const KG = '/einstellungen/kontrollgegenstaende';
  const NA = '/einstellungen/nutzungsarten';
  app.get('/einstellungen/qualitaet', (c) => c.redirect(KG, 301));

  const QmTabs: FC<{ on: 'kg' | 'na' }> = ({ on }) => (
    <nav class="tabs" style="margin-bottom:14px">
      <a href={KG} class={on === 'kg' ? 'on' : ''}>
        Kontrollgegenstände
      </a>
      <a href={NA} class={on === 'na' ? 'on' : ''}>
        Nutzungsarten
      </a>
    </nav>
  );

  const ItemForm: FC<{ it: QmItem | null; used: boolean }> = ({ it, used }) => (
    <form
      method="post"
      action={`${KG}/${it?.id ?? randomUUID()}`}
      class="card form-card"
      style="max-width:720px"
    >
      <h3>{it ? 'Kontrollgegenstand bearbeiten' : 'Kontrollgegenstand anlegen'}</h3>
      <div class="grid">
        <label for="kg-name">Name *</label>
        <input id="kg-name" name="name" required value={it?.name ?? ''} placeholder="z. B. Lichtschalter" />
        <label for="kg-kind">Bewertungsmodus *</label>
        <select id="kg-kind" name="kind" data-nosearch disabled={used}>
          {Object.entries(QM_KIND).map(([k, v]) => (
            <option value={k} selected={(it?.kind ?? 'note') === k}>
              {v}
            </option>
          ))}
        </select>
        {used && <input type="hidden" name="kind" value={it!.kind} />}
        {it && (
          <>
            <label for="kg-so">Reihenfolge</label>
            <input id="kg-so" name="sort_order" value={String(it.sort_order)} inputmode="numeric" />
            <label for="kg-act">aktiv</label>
            <input id="kg-act" type="checkbox" name="active" checked={it.active} style="width:auto" />
          </>
        )}
      </div>
      {used && (
        <p class="small mut">
          Bereits in Audits bewertet – der Bewertungsmodus bleibt deshalb fest (sonst stimmen alte Ergebnisse
          nicht mehr).
        </p>
      )}
      {!it && <input type="hidden" name="active" value="on" />}
      <div class="formfoot">
        {it && (
          <a class="btn ghost" href={KG}>
            Abbrechen
          </a>
        )}
        <button class="btn">{it ? 'Speichern' : 'Kontrollgegenstand hinzufügen'}</button>
      </div>
    </form>
  );

  app.get(KG, async (c) => {
    const items = await listQmItems(sql);
    const used = new Set(
      (await sql<{ item_id: string }[]>`select distinct item_id from app.quality_check_ratings`).map(
        (r) => r.item_id,
      ),
    );
    return page(
      c,
      'Kontrollgegenstände',
      'einstellungen',
      <>
        <PageHead title="Kontrollgegenstände" crumbs={[['Einstellungen', '/einstellungen']]}>
          <a class="btn" href="#anlegen">
            Kontrollgegenstand anlegen
          </a>
        </PageHead>
        <QmTabs on="kg" />
        <p class="mut" style="max-width:860px">
          Was im Audit je Raum bewertet wird. Welche Gegenstände in einem Raum geprüft werden, legen Sie unter{' '}
          <a href={NA}>Nutzungsarten</a> fest. Prozent im Ergebnis: Note 1 = 100 % … 6 = 0 %; Gut 100 %,
          Mittel 50 %, Schlecht 0 %; Ja 100 %, Nein 0 %; Punkte 5 = 100 % … 1 = 0 %.
        </p>
        <div class="tbl card" style="max-width:860px;padding:0">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Bewertungsmodus</th>
                <th class="acts"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr class={it.active ? '' : 'mut'}>
                  <td>
                    {it.name}
                    {!it.active && (
                      <span class="badge" style="margin-left:6px">
                        inaktiv
                      </span>
                    )}
                  </td>
                  <td>{QM_KIND[it.kind]}</td>
                  <td class="r acts">
                    <a
                      class="btn sm sec icon"
                      href={`${KG}/${it.id}`}
                      title="bearbeiten"
                      aria-label="bearbeiten"
                    >
                      <Icon name="pencil" size={15} />
                    </a>{' '}
                    {used.has(it.id) ? (
                      <button
                        class="btn sm sec icon"
                        disabled
                        title="in Audits verwendet – nur deaktivieren möglich"
                        aria-label="löschen nicht möglich"
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    ) : (
                      <form
                        method="post"
                        action={`${KG}/${it.id}/loeschen`}
                        style="display:inline"
                        data-confirm={`„${it.name}“ löschen?`}
                      >
                        <button class="btn sm sec icon" title="löschen" aria-label="löschen">
                          <Icon name="trash" size={15} />
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div id="anlegen" style="margin-top:22px">
          <ItemForm it={null} used={false} />
        </div>
      </>,
    );
  });

  app.get(`${KG}/:id{${UUID}}`, async (c) => {
    const it = (await listQmItems(sql)).find((i) => i.id === c.req.param('id'));
    if (!it) return c.notFound();
    return page(
      c,
      it.name,
      'einstellungen',
      <>
        <PageHead
          title={it.name}
          crumbs={[
            ['Einstellungen', '/einstellungen'],
            ['Kontrollgegenstände', KG],
          ]}
        />
        <ItemForm it={it} used={await qmItemUsed(sql, it.id)} />
      </>,
    );
  });

  app.post(`${KG}/:id{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    const so = str(b, 'sort_order');
    await saveQmItem(sql, c.req.param('id'), {
      name: str(b, 'name') ?? '',
      kind: str(b, 'kind') ?? 'note',
      active: b.active === 'on',
      sortOrder: so && /^\d{1,5}$/.test(so) ? Number(so) : null,
    });
    return back(c, KG, { ok: 'Kontrollgegenstand gespeichert.' });
  });

  app.post(`${KG}/:id{${UUID}}/loeschen`, async (c) => {
    await deleteQmItem(sql, c.req.param('id'));
    return back(c, KG, { ok: 'Kontrollgegenstand gelöscht.' });
  });

  // Nutzungsarten (= Raumarten im Raumbuch) mit ihren Kontrollgegenständen
  const UsageForm: FC<{ t: UsageType | null; items: QmItem[]; sel: string[] }> = ({ t, items, sel }) => {
    const opts = items.filter((i) => i.active || sel.includes(i.id));
    const Row: FC<{ v: string }> = ({ v }) => (
      <div class="kg-row" style="display:flex;gap:8px;margin-bottom:8px">
        <select name="item" data-nosearch style="flex:1" aria-label="Kontrollgegenstand">
          {opts.map((i) => (
            <option value={i.id} selected={i.id === v}>
              {i.name}
            </option>
          ))}
        </select>
        <button type="button" class="btn sec icon" data-kg-del title="entfernen" aria-label="entfernen">
          <Icon name="trash" size={16} />
        </button>
      </div>
    );
    return (
      <form
        method="post"
        action={`${NA}/${t?.id ?? randomUUID()}`}
        class="card form-card"
        style="max-width:720px"
      >
        <h3>{t ? 'Nutzungsart bearbeiten' : 'Nutzungsart anlegen'}</h3>
        <input type="hidden" name="version" value={t ? String(t.version) : ''} />
        <div class="grid">
          <label for="na-name">Name *</label>
          <input
            id="na-name"
            name="name"
            required
            value={t?.name ?? ''}
            placeholder="z. B. Besprechungsraum"
          />
          {t && (
            <>
              <label for="na-act">aktiv</label>
              <input id="na-act" type="checkbox" name="active" checked={t.active} style="width:auto" />
            </>
          )}
        </div>
        {!t && <input type="hidden" name="active" value="on" />}
        <h4 style="margin:18px 0 8px">Kontrollgegenstände *</h4>
        <div data-kg-list>
          {(sel.length ? sel : [opts[0]?.id ?? '']).map((v) => (
            <Row v={v} />
          ))}
        </div>
        <button type="button" class="btn sec" data-kg-add>
          Kontrollgegenstand hinzufügen
        </button>
        <div class="formfoot">
          {t && (
            <a class="btn ghost" href={NA}>
              Abbrechen
            </a>
          )}
          <button class="btn">{t ? 'Speichern' : 'Nutzungsart hinzufügen'}</button>
        </div>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(f){var l=f.querySelector('[data-kg-list]');f.querySelector('[data-kg-add]').addEventListener('click',function(){var r=l.querySelector('.kg-row');var n=r.cloneNode(true);var s=n.querySelector('select');var used={};l.querySelectorAll('select').forEach(function(x){used[x.value]=1});for(var i=0;i<s.options.length;i++){if(!used[s.options[i].value]){s.selectedIndex=i;break}}l.appendChild(n);s.focus()});l.addEventListener('click',function(e){var b=e.target.closest('[data-kg-del]');if(!b)return;if(l.querySelectorAll('.kg-row').length>1)b.closest('.kg-row').remove()})})(document.currentScript.closest('form'));`,
          }}
        />
      </form>
    );
  };

  app.get(NA, async (c) => {
    const [types, items] = await Promise.all([listUsageTypes(sql), listQmItems(sql)]);
    return page(
      c,
      'Nutzungsarten',
      'einstellungen',
      <>
        <PageHead title="Nutzungsarten" crumbs={[['Einstellungen', '/einstellungen']]}>
          <a class="btn" href="#anlegen">
            Nutzungsart anlegen
          </a>
        </PageHead>
        <QmTabs on="na" />
        <p class="mut" style="max-width:860px">
          Nutzungsart = Raumart im Raumbuch der Objekte (Klassenzimmer, Sanitäranlagen, Flur …). Je
          Nutzungsart legen Sie fest, welche Kontrollgegenstände im Audit geprüft werden.
        </p>
        <div class="tbl card" style="max-width:860px;padding:0">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th class="r">
                  <span class="hide-m">Kontrollgegenstände</span>
                  <span class="only-m">Gegenst.</span>
                </th>
                <th class="r">
                  <span class="hide-m">Anzahl Räume</span>
                  <span class="only-m">Räume</span>
                </th>
                <th class="r hide-m">Objekte</th>
                <th class="acts"></th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => (
                <tr class={t.active ? '' : 'mut'}>
                  <td>
                    {t.name}
                    {!t.active && (
                      <span class="badge" style="margin-left:6px">
                        inaktiv
                      </span>
                    )}
                  </td>
                  <td class="r">{t.items || <span class="mut">alle</span>}</td>
                  <td class="r">{t.rooms}</td>
                  <td class="r hide-m">{t.sites}</td>
                  <td class="r acts">
                    <a
                      class="btn sm sec icon"
                      href={`${NA}/${t.id}`}
                      title="bearbeiten"
                      aria-label="bearbeiten"
                    >
                      <Icon name="pencil" size={15} />
                    </a>{' '}
                    {t.rooms ? (
                      <button
                        class="btn sm sec icon"
                        disabled
                        title="im Raumbuch verwendet – nur deaktivieren möglich"
                        aria-label="löschen nicht möglich"
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    ) : (
                      <form
                        method="post"
                        action={`${NA}/${t.id}/loeschen`}
                        style="display:inline"
                        data-confirm={`Nutzungsart „${t.name}“ löschen?`}
                      >
                        <button class="btn sm sec icon" title="löschen" aria-label="löschen">
                          <Icon name="trash" size={15} />
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p class="small mut">
          „alle“ = keine Auswahl getroffen, im Audit werden dann alle aktiven Gegenstände geprüft.
        </p>
        <div id="anlegen" style="margin-top:22px">
          <UsageForm t={null} items={items} sel={[]} />
        </div>
      </>,
    );
  });

  app.get(`${NA}/:id{${UUID}}`, async (c) => {
    const t = (await listUsageTypes(sql)).find((x) => x.id === c.req.param('id'));
    if (!t) return c.notFound();
    const [items, sel] = await Promise.all([listQmItems(sql), usageTypeItemIds(sql, t.id)]);
    return page(
      c,
      t.name,
      'einstellungen',
      <>
        <PageHead
          title={t.name}
          crumbs={[
            ['Einstellungen', '/einstellungen'],
            ['Nutzungsarten', NA],
          ]}
        />
        <UsageForm t={t} items={items} sel={sel} />
      </>,
    );
  });

  app.post(`${NA}/:id{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    const v = b.item;
    await saveUsageType(sql, c.req.param('id'), {
      name: str(b, 'name') ?? '',
      active: b.active === 'on',
      itemIds: (Array.isArray(v) ? v : v ? [v] : []).map(String),
      expectedVersion: versionOf(b.version),
    });
    return back(c, NA, { ok: 'Nutzungsart gespeichert.' });
  });

  app.post(`${NA}/:id{${UUID}}/loeschen`, async (c) => {
    await deleteUsageType(sql, c.req.param('id'));
    return back(c, NA, { ok: 'Nutzungsart gelöscht.' });
  });
}
