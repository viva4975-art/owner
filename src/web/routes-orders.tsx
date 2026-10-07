import { randomUUID } from 'node:crypto';
import { SiteOptions } from './site-options.js';
import type { Child, FC } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { UNIT_LABELS } from '../domain/invoice/types.js';
import { parseQuantity } from '../domain/money/money.js';
import { BusinessError } from '../services/errors.js';
import { listCustomers, listSites } from '../services/masterdata.js';
import {
  type OrderStatus,
  type WorkReportRow,
  type WorkReportStatus,
  ORDER_STATUS,
  WR_STATUS,
  closeWithoutSignature,
  executionNotes,
  getOrder,
  getWorkReport,
  listOrders,
  listWorkReports,
  orderToInvoice,
  renderOrderConfirmation,
  reportsToInvoice,
  saveOrder,
  saveWorkReport,
  setOrderStatus,
  signWorkReport,
  workReportPdf,
} from '../services/orders.js';
import { listFiles } from '../services/uploads.js';
import { type Ctx, UUID, assertSite, inScope } from './app.js';
import { FileArea } from './files.js';
import { arr, milliToInput, parseLines, str } from './forms.js';
import { Icon } from './icons.js';
import { PageHead, type Tab, Tabs, dateDe, euro } from './layout.js';
import { type EditorLine, LineEditor, toEditorLine } from './pages-invoices.js';
import { canAccess } from './permissions.js';

const versionOf = (v: unknown) => (typeof v === 'string' && v !== '' ? Number(v) : null);
const ORDER_CLASS: Record<OrderStatus, string> = {
  offen: 'draft',
  in_arbeit: 'info',
  erledigt: 'ok',
  abgerechnet: 'ok',
  storniert: '',
};
const WR_CLASS: Record<WorkReportStatus, string> = {
  entwurf: 'draft',
  unterschrieben: 'ok',
  ohne_unterschrift: 'warn',
};
const WR_UNITS: [string, string][] = [
  ['HUR', 'Std.'],
  ['LS', 'pauschal'],
  ['C62', 'Stk.'],
  ['MTK', 'm²'],
  ['DAY', 'Tag'],
];

// Unterschriftsfeld: Finger/Stift/Maus, hochauflösend, „Löschen“; PNG wird beim Absenden eingesetzt.
/** Unterschrift auf dem Canvas; `data-optional="1"` am Canvas erlaubt Absenden ohne Zeichnung. */
export const SIGN_JS = `
(function(){
  var c=document.getElementById('sig'), f=c.closest('form'), ctx=c.getContext('2d'), drawn=false, last=null;
  function size(){var r=c.getBoundingClientRect(), d=window.devicePixelRatio||1; var img=drawn?c.toDataURL():null; c.width=r.width*d; c.height=r.height*d; ctx.setTransform(d,0,0,d,0,0); ctx.lineWidth=2.4; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.strokeStyle='#111'; if(img){var i=new Image(); i.onload=function(){ctx.drawImage(i,0,0,r.width,r.height)}; i.src=img;}}
  size(); window.addEventListener('resize', size);
  function pos(e){var r=c.getBoundingClientRect(); return {x:e.clientX-r.left, y:e.clientY-r.top};}
  c.addEventListener('pointerdown',function(e){e.preventDefault(); c.setPointerCapture(e.pointerId); last=pos(e); ctx.beginPath(); ctx.arc(last.x,last.y,1.1,0,7); ctx.fill(); drawn=true; var hh=document.getElementById('sig-hint'); if(hh)hh.hidden=true;});
  c.addEventListener('pointermove',function(e){if(!last)return; var p=pos(e); ctx.beginPath(); ctx.moveTo(last.x,last.y); ctx.lineTo(p.x,p.y); ctx.stroke(); last=p;});
  ['pointerup','pointercancel','pointerleave'].forEach(function(t){c.addEventListener(t,function(){last=null;});});
  document.getElementById('sig-clear').addEventListener('click',function(){ctx.clearRect(0,0,c.width,c.height); drawn=false;});
  f.addEventListener('submit',function(e){ if(!drawn){ if(c.dataset.optional==='1')return; e.preventDefault(); e.stopImmediatePropagation(); document.getElementById('sig-hint').hidden=false; return;} document.getElementById('sig-png').value=c.toDataURL('image/png'); }, true);
})();`;

// Positionen im Arbeitsschein: Zeile hinzufügen / entfernen
const WR_LINES_JS = `
(function(){
  var tb=document.querySelector('#wr-lines tbody'), tpl=document.getElementById('wr-line-tpl');
  function wire(tr){tr.querySelector('.del').addEventListener('click',function(){tr.remove()});}
  Array.prototype.forEach.call(tb.querySelectorAll('tr'),wire);
  document.getElementById('wr-add').addEventListener('click',function(){var tr=tpl.content.firstElementChild.cloneNode(true);tb.appendChild(tr);wire(tr);tr.querySelector('input').focus();});
  var s=document.getElementById('start'), e=document.getElementById('end');
  function hours(){var n=document.querySelectorAll('input[name=employee]:checked').length||1; if(!s.value||!e.value)return; var a=s.value.split(':'),b=e.value.split(':'); var h=((+b[0]*60+ +b[1])-(+a[0]*60+ +a[1]))/60*n; if(h<=0)return; var q=tb.querySelector('tr [name=line_unit] option[value=HUR]:checked'); if(q){var inp=q.closest('tr').querySelector('[name=line_qty]'); if(!inp.dataset.touched) inp.value=(Math.round(h*100)/100).toString().replace('.',',');}}
  [s,e].forEach(function(x){x&&x.addEventListener('change',hours)}); document.querySelectorAll('input[name=employee]').forEach(function(x){x.addEventListener('change',hours)});
  tb.addEventListener('input',function(ev){if(ev.target.name==='line_qty')ev.target.dataset.touched='1'});
})();`;

export const WorkReportTable: FC<{ rows: WorkReportRow[]; select?: boolean }> = ({ rows, select }) => (
  <div class="tbl">
    <table>
      <thead>
        <tr>
          {select && <th></th>}
          <th>Nr.</th>
          <th>Datum</th>
          <th>Objekt</th>
          <th>Arbeiten</th>
          <th>Status</th>
          <th>Rechnung</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colspan={7}>
              <div class="empty">Keine Arbeitsscheine.</div>
            </td>
          </tr>
        )}
        {rows.map((w) => (
          <tr>
            {select && (
              <td>
                {w.status !== 'entwurf' && !w.invoice_id && (
                  <input type="checkbox" name="report" value={w.id} checked aria-label="abrechnen" />
                )}
              </td>
            )}
            <td>
              <a href={`/arbeitsscheine/${w.id}`}>
                <b>{w.number}</b>
              </a>
              {w.order_number && <div class="small mut">{w.order_number}</div>}
            </td>
            <td>{dateDe(w.work_date)}</td>
            <td>{w.site_name}</td>
            <td class="small">{(w.description ?? '').slice(0, 80)}</td>
            <td>
              <span class={`badge ${WR_CLASS[w.status]}`}>{WR_STATUS[w.status]}</span>
              {w.signed_by_name && <div class="small mut">{w.signed_by_name}</div>}
            </td>
            <td class="small">
              {w.invoice_id ? <a href={`/rechnungen/${w.invoice_id}`}>abgerechnet</a> : '–'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export function registerOrderRoutes({ app, deps, page, back, shells }: Ctx) {
  const { sql, env } = deps;

  // ================================================================== Aufträge

  app.get('/auftraege', async (c) => {
    const st = c.req.query('status') as OrderStatus | 'alle' | undefined;
    const all = await listOrders(sql);
    const rows =
      st === 'alle'
        ? all
        : st && st in ORDER_STATUS
          ? all.filter((o) => o.status === st)
          : all.filter((o) => ['offen', 'in_arbeit', 'erledigt'].includes(o.status));
    const tabs: Tab[] = [
      {
        key: '',
        label: 'Offen',
        href: '/auftraege',
        count: all.filter((o) => ['offen', 'in_arbeit', 'erledigt'].includes(o.status)).length,
      },
      {
        key: 'erledigt',
        label: 'Erledigt, abzurechnen',
        href: '/auftraege?status=erledigt',
        count: all.filter((o) => o.status === 'erledigt').length,
      },
      {
        key: 'abgerechnet',
        label: 'Abgerechnet',
        href: '/auftraege?status=abgerechnet',
        count: all.filter((o) => o.status === 'abgerechnet').length,
      },
      { key: 'alle', label: 'Alle', href: '/auftraege?status=alle', count: all.length },
    ];
    return page(
      c,
      'Aufträge',
      'angebote',
      <>
        <PageHead title="Aufträge">
          <a class="btn" href={`/auftraege/${randomUUID()}/bearbeiten`} style="margin-left:auto">
            <Icon name="plus" /> Auftrag anlegen
          </a>
        </PageHead>
        <Tabs tabs={tabs} active={st ?? ''} />
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Nr.</th>
                <th>Titel</th>
                <th>Kunde / Objekt</th>
                <th>geplant</th>
                <th class="r">Netto</th>
                <th class="r">Arbeitsscheine</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colspan={7}>
                    <div class="empty">Keine Aufträge.</div>
                  </td>
                </tr>
              )}
              {rows.map((o) => (
                <tr>
                  <td>
                    <a href={`/auftraege/${o.id}`}>
                      <b>{o.number}</b>
                    </a>
                  </td>
                  <td>{o.title}</td>
                  <td>
                    <a href={`/kunden/${o.customer_id}`}>{o.customer_name}</a>
                    {o.site_name && <div class="small mut">{o.site_name}</div>}
                  </td>
                  <td>{dateDe(o.planned_date)}</td>
                  <td class="r">{euro(o.net_cents)}</td>
                  <td class="r">
                    {o.signed}/{o.reports}
                  </td>
                  <td>
                    <span class={`badge ${ORDER_CLASS[o.status]}`}>{ORDER_STATUS[o.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>,
    );
  });

  app.get(`/auftraege/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const data = await getOrder(sql, id);
    if (data && ['abgerechnet', 'storniert'].includes(data.order.status))
      return back(c, `/auftraege/${id}`, { fehler: 'Auftrag ist abgeschlossen.' });
    const q = c.req.query();
    const o = data?.order;
    const customerId = o?.customer_id ?? q.kunde ?? '';
    const siteId = o?.site_id ?? q.objekt ?? '';
    const [customers, sites] = await Promise.all([
      listCustomers(sql),
      customerId ? listSites(sql, customerId) : Promise.resolve([]),
    ]);
    const lines: EditorLine[] = (data?.lines ?? []).map((l) =>
      toEditorLine({ ...l, source_service_id: null } as unknown as Parameters<typeof toEditorLine>[0]),
    );
    return page(
      c,
      o ? `Auftrag ${o.number}` : 'Neuer Auftrag',
      'angebote',
      <>
        <PageHead
          title={o ? `Auftrag ${o.number} bearbeiten` : 'Neuer Auftrag'}
          crumbs={[['Aufträge', '/auftraege']]}
        />
        <form method="get" action={`/auftraege/${id}/bearbeiten`} class="card">
          <div class="grid">
            <div>
              <label for="kunde">Kunde</label>
              <select id="kunde" name="kunde" onchange="this.form.submit()">
                <option value="">– bitte wählen –</option>
                {customers
                  .filter((k) => k.active)
                  .map((k) => (
                    <option value={k.id} selected={k.id === customerId}>
                      {k.customer_no} · {k.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label for="objekt">Objekt</label>
              <select id="objekt" name="objekt" onchange="this.form.submit()" disabled={!customerId}>
                <option value="">–</option>
                <SiteOptions sites={sites} selected={siteId} />
              </select>
            </div>
          </div>
        </form>
        {customerId && (
          <form
            method="post"
            action={`/auftraege/${id}`}
            class="card"
            data-autosave={`/auftraege/${id}`}
            data-version={String(o?.version ?? '')}
          >
            <input type="hidden" name="version" value={String(o?.version ?? '')} />
            <input type="hidden" name="customer_id" value={customerId} />
            <input type="hidden" name="site_id" value={siteId} />
            <input type="hidden" name="offer_id" value={o?.offer_id ?? ''} />
            <div class="grid">
              <div style="grid-column:1/-1">
                <label for="title">Titel</label>
                <input
                  id="title"
                  name="title"
                  value={o?.title ?? ''}
                  required
                  placeholder="z. B. Grundreinigung Turnhalle nach Umbau"
                />
              </div>
              <div>
                <label for="order_reference">Bestellnummer des Kunden</label>
                <input id="order_reference" name="order_reference" value={o?.order_reference ?? ''} />
              </div>
              <div>
                <label for="planned_date">Ausführung geplant am</label>
                <input id="planned_date" type="date" name="planned_date" value={o?.planned_date ?? ''} />
              </div>
            </div>
            <div style="margin:14px 0">
              <label for="description">Beschreibung / Hinweise für das Team</label>
              <textarea id="description" name="description">
                {o?.description ?? ''}
              </textarea>
            </div>
            <h2>Positionen (für die Abrechnung)</h2>
            <LineEditor lines={lines} />
            <div class="formfoot">
              <a class="btn sec" href={o ? `/auftraege/${id}` : '/auftraege'}>
                Abbrechen
              </a>
              <button class="btn">Auftrag speichern</button>
            </div>
          </form>
        )}
      </>,
    );
  });

  app.post(`/auftraege/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    await saveOrder(
      sql,
      id,
      {
        customerId: str(b, 'customer_id') ?? '',
        siteId: str(b, 'site_id'),
        offerId: str(b, 'offer_id'),
        title: str(b, 'title') ?? '',
        description: str(b, 'description'),
        orderReference: str(b, 'order_reference'),
        plannedDate: str(b, 'planned_date'),
        lines: parseLines(b),
        expectedVersion: versionOf(b.version),
      },
      c.get('actor'),
    );
    return back(c, `/auftraege/${id}`, { ok: 'Auftrag gespeichert.' });
  });

  app.get(`/auftraege/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const data = await getOrder(sql, id);
    if (!data) return c.redirect(`/auftraege/${id}/bearbeiten`);
    const { order: o, lines } = data;
    const [reports, files] = await Promise.all([
      listWorkReports(sql, { orderId: id }),
      listFiles(sql, { type: 'order', id }),
    ]);
    const done = !['abgerechnet', 'storniert'].includes(o.status);
    const post = (path: string, label: Child, cls = 'sec', confirm?: string) => (
      <form
        method="post"
        action={`/auftraege/${id}/${path}`}
        onsubmit={confirm ? `return confirm(${JSON.stringify(confirm)})` : undefined}
      >
        <button class={`btn ${cls}`}>{label}</button>
      </form>
    );
    return page(
      c,
      `Auftrag ${o.number}`,
      'angebote',
      <>
        <PageHead title={o.title} no={`Auftrag ${o.number}`} crumbs={[['Aufträge', '/auftraege']]}>
          <span class={`badge ${ORDER_CLASS[o.status]}`}>{ORDER_STATUS[o.status]}</span>
        </PageHead>
        <div class="actions" style="margin-top:-8px">
          {done && (
            <a class="btn sec" href={`/auftraege/${id}/bearbeiten`}>
              Bearbeiten
            </a>
          )}
          <a class="btn sec" href={`/auftraege/${id}/auftragsbestaetigung.pdf`} target="_blank">
            <Icon name="pdf" /> Auftragsbestätigung
          </a>
          {done && o.site_id && (
            <a class="btn" href={`/arbeitsscheine/${randomUUID()}?auftrag=${id}`}>
              <Icon name="plus" /> Arbeitsschein
            </a>
          )}
          {done && o.status !== 'erledigt' && post('status?s=erledigt', 'Als erledigt markieren')}
          {done &&
            post(
              'rechnung',
              <>
                <Icon name="euro" /> Rechnung erstellen
              </>,
              '',
              'Rechnungsentwurf aus diesem Auftrag erstellen? Abgeschlossene Arbeitsscheine werden angehängt.',
            )}
          {o.invoice_id && (
            <a class="btn sec" href={`/rechnungen/${o.invoice_id}`}>
              Zur Rechnung
            </a>
          )}
          {done && post('status?s=storniert', 'Stornieren', 'ghost', 'Auftrag stornieren?')}
        </div>
        <div class="cols">
          <div>
            <div class="card">
              <h3>
                Arbeitsscheine <span class="cnt">({reports.length})</span>
              </h3>
              <WorkReportTable rows={reports} />
            </div>
            <div class="card flush">
              <div class="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Pos.</th>
                      <th>Leistung</th>
                      <th class="r">Menge</th>
                      <th class="r">Einzelpreis</th>
                      <th class="r">Netto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.length === 0 && (
                      <tr>
                        <td colspan={5}>
                          <div class="empty">Noch keine Positionen – vor der Abrechnung ergänzen.</div>
                        </td>
                      </tr>
                    )}
                    {lines.map((l) => (
                      <tr>
                        <td>{l.position}</td>
                        <td>
                          {l.description}
                          {l.detail && <div class="small mut">{l.detail}</div>}
                        </td>
                        <td class="r">
                          {milliToInput(l.quantity_milli)} {UNIT_LABELS[l.unit_code] ?? ''}
                        </td>
                        <td class="r">{euro(l.unit_price_cents)}</td>
                        <td class="r">{euro(l.net_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colspan={4} class="r">
                        <b>Summe netto</b>
                      </td>
                      <td class="r">
                        <b>{euro(o.net_cents)}</b>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </div>
          <div>
            <div class="card">
              <dl class="kv">
                <dt>Kunde</dt>
                <dd>
                  <a href={`/kunden/${o.customer_id}`}>Kunde öffnen</a>
                </dd>
                <dt>Objekt</dt>
                <dd>{o.site_id ? <a href={`/objekte/${o.site_id}`}>Objekt öffnen</a> : '–'}</dd>
                <dt>Bestellnummer</dt>
                <dd>{o.order_reference ?? '–'}</dd>
                <dt>geplant</dt>
                <dd>{dateDe(o.planned_date)}</dd>
                {o.offer_id && (
                  <>
                    <dt>Angebot</dt>
                    <dd>
                      <a href={`/angebote/${o.offer_id}`}>öffnen</a>
                    </dd>
                  </>
                )}
              </dl>
              {o.description && <p style="white-space:pre-line">{o.description}</p>}
            </div>
            <div class="card">
              <h3>Unterlagen</h3>
              <FileArea
                link={{ type: 'order', id }}
                files={files}
                category="Auftrag"
                maxBytes={env.UPLOAD_MAX_BYTES}
              />
            </div>
          </div>
        </div>
      </>,
    );
  });

  app.get(`/auftraege/:id{${UUID}}/auftragsbestaetigung.pdf`, async (c) => {
    const { pdf, filename } = await renderOrderConfirmation(sql, c.req.param('id'));
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'private, no-cache',
      },
    });
  });

  app.post(`/auftraege/:id{${UUID}}/status`, async (c) => {
    const id = c.req.param('id');
    const s = c.req.query('s');
    if (s !== 'erledigt' && s !== 'storniert' && s !== 'in_arbeit')
      throw new BusinessError('Status ungültig');
    await setOrderStatus(sql, id, s, c.get('actor'));
    return back(c, `/auftraege/${id}`, { ok: `Auftrag ${ORDER_STATUS[s]}.` });
  });

  app.post(`/auftraege/:id{${UUID}}/rechnung`, async (c) => {
    const inv = await orderToInvoice(deps, c.req.param('id'), c.get('actor'));
    return back(c, `/rechnungen/${inv}`, { ok: 'Rechnungsentwurf erstellt, Arbeitsscheine angehängt.' });
  });

  // ================================================================== Arbeitsscheine

  app.get('/arbeitsscheine', async (c) => {
    const st = c.req.query('status');
    const all = inScope(c, await listWorkReports(sql));
    const rows =
      st === 'offen'
        ? all.filter((w) => w.status === 'entwurf')
        : st === 'abzurechnen'
          ? all.filter((w) => w.status !== 'entwurf' && !w.invoice_id)
          : all;
    const tabs: Tab[] = [
      { key: '', label: 'Alle', href: '/arbeitsscheine', count: all.length },
      {
        key: 'offen',
        label: 'Ohne Unterschrift',
        href: '/arbeitsscheine?status=offen',
        count: all.filter((w) => w.status === 'entwurf').length,
      },
      {
        key: 'abzurechnen',
        label: 'Nicht abgerechnet',
        href: '/arbeitsscheine?status=abzurechnen',
        count: all.filter((w) => w.status !== 'entwurf' && !w.invoice_id).length,
      },
    ];
    return page(
      c,
      'Arbeitsscheine',
      'rechnungen',
      <>
        <PageHead title="Arbeitsscheine / Leistungsnachweise">
          <a class="btn" href={`/arbeitsscheine/${randomUUID()}`} style="margin-left:auto">
            <Icon name="plus" /> Arbeitsschein
          </a>
        </PageHead>
        <Tabs tabs={tabs} active={st ?? ''} />
        <WorkReportTable rows={rows} />
        <p class="small mut">
          Abrechnung: über den Auftrag oder im Objekt unter „Arbeitsscheine“ → „Regiearbeiten abrechnen“.
          Unterschriebene Scheine werden als PDF an die Rechnung gehängt.
        </p>
      </>,
    );
  });

  app.get(`/arbeitsscheine/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const data = await getWorkReport(sql, id);
    if (data) assertSite(c, data.report.site_id);
    const q = c.req.query();
    const order = !data && q.auftrag ? (await getOrder(sql, q.auftrag))?.order : undefined;
    const w = data?.report;
    const siteId = w?.site_id ?? order?.site_id ?? q.objekt ?? '';
    const scope = c.get('sites');
    const sites = (await listSites(sql)).filter((s) => !scope || scope.includes(s.id));
    const emps = siteId
      ? await sql<{ id: string; name: string }[]>`
          select e.id, e.last_name || ', ' || e.first_name as name from app.employees e
           where e.status = 'aktiv' and (e.id in (select employee_id from app.employee_sites where site_id = ${siteId})
                 or e.id = any(${w?.employee_ids ?? []}::uuid[]))
           order by e.last_name`
      : [];
    const files = w ? await listFiles(sql, { type: 'work_report', id }) : [];

    if (w && w.status !== 'entwurf') {
      // Abgeschlossen: nur ansehen
      return page(
        c,
        `Arbeitsschein ${w.number}`,
        'rechnungen',
        <>
          <PageHead title={`Arbeitsschein ${w.number}`} crumbs={[['Arbeitsscheine', '/arbeitsscheine']]}>
            <span class={`badge ${WR_CLASS[w.status]}`}>{WR_STATUS[w.status]}</span>
          </PageHead>
          <div class="actions" style="margin-top:-8px">
            <a class="btn" href={`/arbeitsscheine/${id}/arbeitsschein.pdf`} target="_blank">
              <Icon name="pdf" /> PDF mit Unterschrift
            </a>
            {w.invoice_id && canAccess(c.get('user').role, '/rechnungen') && (
              <a class="btn sec" href={`/rechnungen/${w.invoice_id}`}>
                Zur Rechnung
              </a>
            )}
          </div>
          <div class="cols">
            <div class="card">
              <dl class="kv">
                <dt>Objekt</dt>
                <dd>{w.site_name}</dd>
                <dt>Datum, Zeit</dt>
                <dd>
                  {dateDe(w.work_date)} {w.start_time && `${w.start_time}–${w.end_time} Uhr`}
                </dd>
                <dt>Mitarbeiter</dt>
                <dd>{data!.employees.map((e) => e.name).join(', ') || '–'}</dd>
                <dt>Arbeiten</dt>
                <dd style="white-space:pre-line">{w.description ?? '–'}</dd>
                <dt>Leistungen</dt>
                <dd>
                  {data!.lines.map((l) => (
                    <div>
                      {milliToInput(l.quantity_milli)} {UNIT_LABELS[l.unit_code] ?? l.unit_code}{' '}
                      {l.description}
                    </div>
                  ))}
                </dd>
                {w.materials && (
                  <>
                    <dt>Material</dt>
                    <dd>{w.materials}</dd>
                  </>
                )}
                {w.remarks && (
                  <>
                    <dt>Bemerkungen</dt>
                    <dd>{w.remarks}</dd>
                  </>
                )}
                <dt>Abnahme</dt>
                <dd>
                  {w.status === 'unterschrieben'
                    ? `${w.signed_by_name}, ${w.signed_at!.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' })}`
                    : `ohne Unterschrift: ${w.no_signature_reason}`}
                </dd>
                <dt>PDF (SHA-256)</dt>
                <dd class="small" style="word-break:break-all">
                  {w.pdf_sha256}
                </dd>
              </dl>
            </div>
            <div class="card">
              <h3>Fotos / Anlagen</h3>
              <FileArea
                link={{ type: 'work_report', id }}
                files={files}
                category="Foto"
                title="Fotos hierher ziehen"
                maxBytes={env.UPLOAD_MAX_BYTES}
              />
            </div>
          </div>
        </>,
      );
    }

    const lines = data?.lines.length
      ? data.lines.map((l) => ({
          desc: l.description,
          qty: milliToInput(l.quantity_milli),
          unit: l.unit_code,
        }))
      : [{ desc: 'Regiestunden', qty: '', unit: 'HUR' }];
    const Row: FC<{ l?: { desc: string; qty: string; unit: string } }> = ({ l }) => (
      <tr>
        <td>
          <input name="line_desc" value={l?.desc ?? ''} placeholder="Leistung" />
        </td>
        <td style="width:110px">
          <input name="line_qty" value={l?.qty ?? ''} class="right" inputmode="decimal" />
        </td>
        <td style="width:120px">
          <select name="line_unit">
            {WR_UNITS.map(([k, v]) => (
              <option value={k} selected={k === (l?.unit ?? 'HUR')}>
                {v}
              </option>
            ))}
          </select>
        </td>
        <td style="width:40px">
          <button type="button" class="btn sm sec del" title="entfernen">
            ×
          </button>
        </td>
      </tr>
    );
    const notes = siteId ? await executionNotes(sql, siteId, w?.work_date ?? todayBerlin()) : [];
    return page(
      c,
      w ? `Arbeitsschein ${w.number}` : 'Neuer Arbeitsschein',
      'rechnungen',
      <>
        <PageHead
          title={w ? `Arbeitsschein ${w.number}` : 'Neuer Arbeitsschein'}
          crumbs={[['Arbeitsscheine', '/arbeitsscheine']]}
        >
          {w && <span class="badge draft">noch nicht unterschrieben</span>}
        </PageHead>
        {!siteId ? (
          <form method="get" action={`/arbeitsscheine/${id}`} class="card" style="max-width:520px">
            <label for="objekt">Objekt</label>
            <select id="objekt" name="objekt" onchange="this.form.submit()" required>
              <option value="">– bitte wählen –</option>
              <SiteOptions sites={sites} />
            </select>
          </form>
        ) : (
          <div class="cols">
            <form
              method="post"
              action={`/arbeitsscheine/${id}`}
              class="card"
              data-version={String(w?.version ?? '')}
            >
              <input type="hidden" name="version" value={String(w?.version ?? '')} />
              <input type="hidden" name="site_id" value={siteId} />
              <input type="hidden" name="order_id" value={w?.order_id ?? order?.id ?? ''} />
              <p class="mut small" style="margin-top:0">
                Objekt: <b>{sites.find((s) => s.id === siteId)?.name}</b>
                {(w?.order_number ?? order?.number) && <> · Auftrag {w?.order_number ?? order?.number}</>}
              </p>
              {notes.length > 0 && (
                <div class="flash" style="background:var(--warn-50,#fffbeb);border:1px solid #fde68a">
                  <b>Ausführungshinweise</b>
                  {notes.map((n) => (
                    <div class="small" style="white-space:pre-line">
                      {n.description}: {n.execution_notes}
                    </div>
                  ))}
                </div>
              )}
              <div class="grid">
                <div>
                  <label for="work_date">Datum</label>
                  <input
                    id="work_date"
                    type="date"
                    name="work_date"
                    value={w?.work_date ?? todayBerlin()}
                    required
                  />
                </div>
                <div>
                  <label for="start">Beginn</label>
                  <input id="start" type="time" name="start" value={w?.start_time ?? ''} />
                </div>
                <div>
                  <label for="end">Ende</label>
                  <input id="end" type="time" name="end" value={w?.end_time ?? ''} />
                </div>
              </div>
              {emps.length > 0 && (
                <>
                  <label style="margin-top:12px">Eingesetzte Mitarbeiter</label>
                  <div class="actions" style="margin-top:0">
                    {emps.map((e) => (
                      <span class="chk">
                        <input
                          type="checkbox"
                          id={`e-${e.id}`}
                          name="employee"
                          value={e.id}
                          checked={w?.employee_ids.includes(e.id) ?? false}
                        />
                        <label for={`e-${e.id}`}>{e.name}</label>
                      </span>
                    ))}
                  </div>
                </>
              )}
              <div style="margin-top:12px">
                <label for="description">Ausgeführte Arbeiten</label>
                <textarea
                  id="description"
                  name="description"
                  placeholder="z. B. Grundreinigung Turnhalle, Bodenbeschichtung erneuert"
                >
                  {w?.description ?? ''}
                </textarea>
              </div>
              <h3 style="margin-top:14px">Leistungen</h3>
              <div class="tbl">
                <table id="wr-lines" class="lines">
                  <thead>
                    <tr>
                      <th>Leistung</th>
                      <th class="r">Menge</th>
                      <th>Einheit</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <Row l={l} />
                    ))}
                  </tbody>
                </table>
              </div>
              <template id="wr-line-tpl">
                <Row />
              </template>
              <div class="actions">
                <button type="button" class="btn sm sec" id="wr-add">
                  + Position
                </button>
                <span class="small mut">Stunden werden aus Beginn/Ende × Mitarbeitern vorgeschlagen.</span>
              </div>
              <div class="grid">
                <div>
                  <label for="materials">Material</label>
                  <input id="materials" name="materials" value={w?.materials ?? ''} />
                </div>
                <div>
                  <label for="remarks">Bemerkungen des Kunden</label>
                  <input id="remarks" name="remarks" value={w?.remarks ?? ''} />
                </div>
              </div>
              <div class="formfoot">
                <button class="btn sec" name="next" value="stay">
                  Speichern
                </button>
                <button class="btn" name="next" value="sign">
                  Speichern und unterschreiben lassen
                </button>
              </div>
              <script dangerouslySetInnerHTML={{ __html: WR_LINES_JS }} />
            </form>
            <div>
              {w && (
                <>
                  <div class="card">
                    <h3>Abschließen</h3>
                    <div class="actions" style="margin-top:0">
                      <a class="btn" href={`/arbeitsscheine/${id}/unterschrift`}>
                        Kunde unterschreibt jetzt
                      </a>
                      <a class="btn sec" href={`/arbeitsscheine/${id}/arbeitsschein.pdf`} target="_blank">
                        PDF-Vorschau
                      </a>
                    </div>
                    <form method="post" action={`/arbeitsscheine/${id}/ohne-unterschrift`} class="actions">
                      <input
                        name="reason"
                        placeholder="Grund, z. B. kein Ansprechpartner vor Ort"
                        required
                        style="flex:1;min-width:200px"
                      />
                      <button class="btn ghost">Ohne Unterschrift abschließen</button>
                    </form>
                  </div>
                  <div class="card">
                    <h3>Fotos</h3>
                    <FileArea
                      link={{ type: 'work_report', id }}
                      files={files}
                      category="Foto"
                      title="Fotos (vorher/nachher)"
                      maxBytes={env.UPLOAD_MAX_BYTES}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </>,
    );
  });

  app.post(`/arbeitsscheine/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const siteId = str(b, 'site_id') ?? '';
    assertSite(c, siteId);
    const cur = await getWorkReport(sql, id);
    if (cur) assertSite(c, cur.report.site_id);
    const desc = arr(b, 'line_desc');
    const qty = arr(b, 'line_qty');
    const unit = arr(b, 'line_unit');
    const lines = desc
      .map((d, i) => ({ d: d.trim(), i }))
      .filter((x) => x.d && (qty[x.i] ?? '').trim())
      .map(({ d, i }) => {
        let quantity;
        try {
          quantity = parseQuantity(qty[i] ?? '');
        } catch {
          throw new BusinessError(`Menge bei „${d}“ ungültig`);
        }
        if (quantity <= 0n) throw new BusinessError(`Menge bei „${d}“ muss größer 0 sein`);
        return {
          description: d,
          quantity,
          unitCode: WR_UNITS.some(([k]) => k === unit[i]) ? unit[i]! : 'HUR',
        };
      });
    await saveWorkReport(
      sql,
      id,
      {
        orderId: str(b, 'order_id'),
        siteId,
        workDate: str(b, 'work_date') ?? todayBerlin(),
        startTime: str(b, 'start'),
        endTime: str(b, 'end'),
        employeeIds: arr(b, 'employee').filter((x) => /^[0-9a-f-]{36}$/.test(x)),
        description: str(b, 'description'),
        materials: str(b, 'materials'),
        remarks: str(b, 'remarks'),
        lines,
        expectedVersion: versionOf(b.version),
      },
      c.get('actor'),
    );
    if (str(b, 'next') === 'sign') return c.redirect(`/arbeitsscheine/${id}/unterschrift`, 303);
    return back(c, `/arbeitsscheine/${id}`, { ok: 'Arbeitsschein gespeichert.' });
  });

  // Unterschriftsseite: groß, ohne Ablenkung, auch fürs Handy des Kunden
  app.get(`/arbeitsscheine/:id{${UUID}}/unterschrift`, async (c) => {
    const id = c.req.param('id');
    const data = await getWorkReport(sql, id);
    if (!data) return c.notFound();
    assertSite(c, data.report.site_id);
    const { report: w, lines, employees } = data;
    if (w.status !== 'entwurf') return c.redirect(`/arbeitsscheine/${id}`);
    return page(
      c,
      'Unterschrift',
      'rechnungen',
      <div style="max-width:720px;margin:0 auto">
        <h1 style="margin-bottom:6px">Leistungsnachweis {w.number}</h1>
        <p class="mut" style="margin-top:0">
          {w.site_name} · {dateDe(w.work_date)} {w.start_time && `· ${w.start_time}–${w.end_time} Uhr`}
        </p>
        <div class="card">
          {w.description && <p style="margin-top:0;white-space:pre-line">{w.description}</p>}
          {lines.map((l) => (
            <div>
              <b>
                {milliToInput(l.quantity_milli)} {UNIT_LABELS[l.unit_code] ?? l.unit_code}
              </b>{' '}
              {l.description}
            </div>
          ))}
          {employees.length > 0 && (
            <p class="small mut">Eingesetzt: {employees.map((e) => e.name).join(', ')}</p>
          )}
        </div>
        <form method="post" action={`/arbeitsscheine/${id}/unterschrift`} class="card">
          <label for="name">Name des Unterzeichners (Kunde)</label>
          <input id="name" name="name" required autocomplete="name" style="font-size:18px;height:46px" />
          <label style="margin-top:14px">Unterschrift</label>
          <canvas
            id="sig"
            style="width:100%;height:200px;border:1.5px dashed var(--line-2);border-radius:var(--r);background:#fff;touch-action:none;display:block"
          ></canvas>
          <input type="hidden" id="sig-png" name="png" />
          <div class="actions">
            <button type="button" class="btn sec sm" id="sig-clear">
              Löschen
            </button>
            <span class="small" id="sig-hint" style="color:var(--err)" hidden>
              Bitte im Feld unterschreiben.
            </span>
          </div>
          <p class="small mut">
            Mit der Unterschrift bestätigen Sie, dass die oben genannten Leistungen erbracht wurden. Der
            Leistungsnachweis wird danach als PDF unveränderbar gespeichert.
          </p>
          <div class="formfoot">
            <a class="btn sec" href={`/arbeitsscheine/${id}`}>
              Zurück
            </a>
            <button class="btn">Unterschreiben</button>
          </div>
        </form>
        <script dangerouslySetInnerHTML={{ __html: SIGN_JS }} />
      </div>,
    );
  });

  app.post(`/arbeitsscheine/:id{${UUID}}/unterschrift`, async (c) => {
    const id = c.req.param('id');
    const data = await getWorkReport(sql, id);
    if (!data) return c.notFound();
    assertSite(c, data.report.site_id);
    const b = await c.req.parseBody();
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.png ?? ''));
    if (!m) throw new BusinessError('Unterschrift fehlt – bitte im Feld unterschreiben');
    await signWorkReport(
      deps,
      id,
      { name: String(b.name ?? ''), png: new Uint8Array(Buffer.from(m[1]!, 'base64')) },
      c.get('actor'),
    );
    return back(c, `/arbeitsscheine/${id}`, { ok: 'Unterschrieben. Das PDF ist gespeichert.' });
  });

  app.post(`/arbeitsscheine/:id{${UUID}}/ohne-unterschrift`, async (c) => {
    const id = c.req.param('id');
    const data = await getWorkReport(sql, id);
    if (!data) return c.notFound();
    assertSite(c, data.report.site_id);
    const b = await c.req.parseBody();
    await closeWithoutSignature(deps, id, String(b.reason ?? ''), c.get('actor'));
    return back(c, `/arbeitsscheine/${id}`, { ok: 'Arbeitsschein ohne Unterschrift abgeschlossen.' });
  });

  app.get(`/arbeitsscheine/:id{${UUID}}/arbeitsschein.pdf`, async (c) => {
    const id = c.req.param('id');
    const data = await getWorkReport(sql, id);
    if (!data) return c.notFound();
    assertSite(c, data.report.site_id);
    const pdf = await workReportPdf(deps, id);
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Arbeitsschein_${data.report.number}.pdf"`,
        'Cache-Control': 'private, no-cache',
      },
    });
  });

  // Reiter im Objekt: Arbeitsscheine + Regiearbeiten abrechnen
  app.get(`/objekte/:id{${UUID}}/arbeitsscheine`, (c) =>
    shells.site!(c, 'arbeitsscheine', async (s) => {
      const rows = await listWorkReports(sql, { siteId: s.id });
      const billable = rows.filter((w) => w.status !== 'entwurf' && !w.invoice_id);
      const office = canAccess(c.get('user').role, '/rechnungen');
      return (
        <>
          <div class="actions" style="margin-top:0">
            <a class="btn sm" href={`/arbeitsscheine/${randomUUID()}?objekt=${s.id}`}>
              + Arbeitsschein
            </a>
          </div>
          {office && billable.length > 0 ? (
            <form method="post" action={`/objekte/${s.id}/regie-abrechnen`}>
              <WorkReportTable rows={rows} select />
              <div class="actions">
                <button class="btn">
                  <Icon name="euro" /> Ausgewählte Regiearbeiten abrechnen ({billable.length})
                </button>
                <span class="small mut">
                  Stunden mit dem Regiestundensatz des Objekts; PDFs werden angehängt.
                </span>
              </div>
            </form>
          ) : (
            <WorkReportTable rows={rows} />
          )}
        </>
      );
    }),
  );

  app.post(`/objekte/:id{${UUID}}/regie-abrechnen`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    const inv = await reportsToInvoice(deps, c.req.param('id'), arr(b, 'report'), c.get('actor'));
    return back(c, `/rechnungen/${inv}`, {
      ok: 'Rechnungsentwurf aus Arbeitsscheinen erstellt. Pauschalen bitte bepreisen.',
    });
  });
}
