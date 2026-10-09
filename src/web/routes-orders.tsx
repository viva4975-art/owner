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
  cancelWorkReport,
  closeWithoutSignature,
  deleteWorkReport,
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
import { fullName } from '../services/users.js';
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
  function setup(tbId,tplId,addId){var tb=document.querySelector('#'+tbId+' tbody'),tpl=document.getElementById(tplId);if(!tb||!tpl)return null;
    function wire(tr){var d=tr.querySelector('.del');if(d)d.addEventListener('click',function(){tr.remove()});
      var cp=tr.querySelector('.copy');if(cp)cp.addEventListener('click',function(){var n=tr.cloneNode(true);var src=tr.querySelectorAll('input,select'),dst=n.querySelectorAll('input,select');for(var i=0;i<src.length;i++)dst[i].value=src[i].value;
        var dt=n.querySelector('[name=line_date]');var to=document.getElementById('work_date_to');if(dt&&dt.value){var x=new Date(dt.value+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+1);var nx=x.toISOString().slice(0,10);if(!to||!to.value||nx<=to.value)dt.value=nx;}
        tr.parentNode.insertBefore(n,tr.nextSibling);wire(n);var q=n.querySelector('[name=line_date]')||n.querySelector('input');if(q)q.focus();});var sv=tr.querySelector('[name=line_svc]');if(sv)sv.addEventListener('change',function(){var o=sv.options[sv.selectedIndex];var di=tr.querySelector('[name=line_desc]');if(sv.value&&di&&!di.value.trim())di.value=o.dataset.desc||'';var u=tr.querySelector('[name=line_unit]');if(sv.value&&u&&o.dataset.unit)u.value=o.dataset.unit;})}
    Array.prototype.forEach.call(tb.querySelectorAll('tr'),wire);
    document.getElementById(addId).addEventListener('click',function(){var tr=tpl.content.firstElementChild.cloneNode(true);var ld=tr.querySelector('input[type=date][name=line_date]');var wd=document.getElementById('work_date');if(ld&&!ld.value&&wd)ld.value=wd.value;tb.appendChild(tr);wire(tr);var f=tr.querySelector('input,select');if(f)f.focus();});
    return tb;}
  setup('wr-lines','wr-line-tpl','wr-add');
  var rt=setup('wr-regie','wr-regie-tpl','wr-regie-add');
  // Regie: Stunden aus Beginn/Ende vorschlagen (je Person)
  var s=document.getElementById('start'), e=document.getElementById('end');
  function hours(){if(!rt||!s.value||!e.value)return;var a=s.value.split(':'),b=e.value.split(':');var h=((+b[0]*60+ +b[1])-(+a[0]*60+ +a[1]))/60;if(h<=0)return;rt.querySelectorAll('[name=line_qty]').forEach(function(inp){if(!inp.dataset.touched&&!inp.value)inp.value=(Math.round(h*100)/100).toString().replace('.',',')})}
  [s,e].forEach(function(x){x&&x.addEventListener('change',hours)});
  var wd=document.getElementById('work_date'),wt=document.getElementById('work_date_to');
  function range(){if(!wd)return;var to=(wt&&wt.value)||wd.value;document.querySelectorAll('#wr-regie [name=line_date]').forEach(function(i){i.min=wd.value;i.max=to;if(!i.value||i.value<wd.value||i.value>to)i.value=wd.value;});}
  [wd,wt].forEach(function(x){x&&x.addEventListener('change',range)});
  document.addEventListener('input',function(ev){if(ev.target.name==='line_qty')ev.target.dataset.touched='1'});
  // Mitarbeiter angehakt → Regie-Zeile mit Namen anlegen
  document.querySelectorAll('input[name=employee]').forEach(function(x){x.addEventListener('change',function(){if(!x.checked||!rt)return;var n=x.dataset.name;var have=Array.prototype.some.call(rt.querySelectorAll('[name=line_person]'),function(p){return p.value===n});if(have)return;var empty=Array.prototype.find.call(rt.querySelectorAll('[name=line_person]'),function(p){return !p.value});if(!empty){document.getElementById('wr-regie-add').click();empty=rt.querySelector('tr:last-child [name=line_person]')}empty.value=n;hours()})});
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
                {w.status !== 'entwurf' && !w.invoice_id && !w.cancelled_at && (
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
            <td>
              {dateDe(w.work_date)}
              {w.work_date_to && <div class="small mut">bis {dateDe(w.work_date_to)}</div>}
            </td>
            <td>{w.site_name}</td>
            <td class="small">{(w.description ?? '').slice(0, 80)}</td>
            <td>
              {w.cancelled_at ? (
                <span class="badge err" title={w.cancel_reason ?? ''}>
                  storniert
                </span>
              ) : (
                <span class={`badge ${WR_CLASS[w.status]}`}>{WR_STATUS[w.status]}</span>
              )}
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
          ? all.filter((w) => w.status !== 'entwurf' && !w.invoice_id && !w.cancelled_at)
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
        count: all.filter((w) => w.status !== 'entwurf' && !w.invoice_id && !w.cancelled_at).length,
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
            {w.cancelled_at ? (
              <span class="badge err">storniert</span>
            ) : (
              <span class={`badge ${WR_CLASS[w.status]}`}>{WR_STATUS[w.status]}</span>
            )}
          </PageHead>
          {w.cancelled_at && (
            <div class="flash err">
              Storniert am {w.cancelled_at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })} von{' '}
              {fullName({ login: w.cancelled_by ?? '' })}: {w.cancel_reason}. Zählt nicht mehr und kann nicht
              abgerechnet werden.
            </div>
          )}
          <div class="actions" style="margin-top:-8px">
            <a class="btn" href={`/arbeitsscheine/${id}/arbeitsschein.pdf`} target="_blank">
              <Icon name="pdf" /> PDF
            </a>
            {!w.invoice_id &&
              !w.order_id &&
              !w.cancelled_at &&
              canAccess(c.get('user').role, '/rechnungen') && (
                <form method="post" action={`/objekte/${w.site_id}/regie-abrechnen`}>
                  <input type="hidden" name="report" value={id} />
                  <button class="btn sec">Rechnung erstellen</button>
                </form>
              )}
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
                  {dateDe(w.work_date)}
                  {w.work_date_to && ` – ${dateDe(w.work_date_to)}`}{' '}
                  {w.start_time && `${w.start_time}–${w.end_time} Uhr`}
                </dd>
                <dt>Mitarbeiter</dt>
                <dd>{data!.employees.map((e) => e.name).join(', ') || '–'}</dd>
                <dt>Arbeiten</dt>
                <dd style="white-space:pre-line">{w.description ?? '–'}</dd>
                <dt>Leistungen</dt>
                <dd>
                  {data!.lines.map((l) => (
                    <div>
                      {l.person && w.work_date_to && `${dateDe(l.line_date ?? w.work_date)}: `}
                      {milliToInput(l.quantity_milli)} {UNIT_LABELS[l.unit_code] ?? l.unit_code}{' '}
                      {l.description}
                      {l.person && ` – ${l.person}`}
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
            <div>
              {!w.cancelled_at && (
                <details class="card">
                  <summary style="cursor:pointer">
                    <b>Arbeitsschein stornieren …</b>
                  </summary>
                  {w.invoice_id ? (
                    <p class="small mut">
                      Schon abgerechnet – zuerst die Rechnung stornieren bzw. den Rechnungsentwurf löschen.
                    </p>
                  ) : (
                    <form
                      method="post"
                      action={`/arbeitsscheine/${id}/stornieren`}
                      onsubmit="return confirm('Arbeitsschein stornieren? Er bleibt sichtbar, zählt aber nicht mehr.')"
                    >
                      <p class="small mut" style="margin-top:6px">
                        Abgeschlossene Arbeitsscheine werden nicht gelöscht (Nachweis), sondern mit Grund
                        storniert.
                      </p>
                      <label for="grund">Grund</label>
                      <input
                        id="grund"
                        name="grund"
                        required
                        placeholder="z. B. doppelt erfasst, falsches Objekt"
                      />
                      <div class="actions">
                        <button class="btn sec danger">Stornieren</button>
                      </div>
                    </form>
                  )}
                </details>
              )}
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
          </div>
        </>,
      );
    }

    // Leistungen des Objekts (am Arbeitsdatum gültig); hat das Objekt keine eigenen, die der anderen Objekte des Kunden
    const wrDate = w?.work_date ?? todayBerlin();
    type WrSvc = {
      id: string;
      description: string;
      unit_code: string;
      unit_price_cents: bigint;
      type_name: string | null;
      own: boolean;
      site_label: string;
    };
    const services: WrSvc[] = siteId
      ? await sql<WrSvc[]>`
          with me as (select customer_id from app.sites where id = ${siteId}),
          own as (select count(*) as n from app.site_services where site_id = ${siteId} and active
                    and valid_from <= ${wrDate} and (valid_to is null or valid_to >= ${wrDate}))
          select ss.id, ss.description, ss.unit_code, ss.unit_price_cents, t.name as type_name,
                 ss.site_id = ${siteId} as own, s.site_no || ' · ' || s.name as site_label
            from app.site_services ss
            join app.sites s on s.id = ss.site_id
            left join app.service_types t on t.id = ss.service_type_id
           where ss.active and ss.valid_from <= ${wrDate} and (ss.valid_to is null or ss.valid_to >= ${wrDate})
             and (ss.site_id = ${siteId}
                  or ((select n from own) = 0 and s.customer_id = (select customer_id from me) and s.active))
           order by (ss.site_id = ${siteId}) desc, s.site_no, ss.sort_order, ss.description`
      : [];
    // bereits gewählte (inzwischen beendete) Leistungen bleiben wählbar
    const chosen = (data?.lines ?? []).map((l) => l.service_id).filter((x): x is string => !!x);
    const missingChosen = chosen.filter((x) => !services.some((s) => s.id === x));
    if (missingChosen.length)
      services.push(
        ...(await sql<WrSvc[]>`
          select ss.id, ss.description, ss.unit_code, ss.unit_price_cents, t.name as type_name,
                 ss.site_id = ${siteId} as own, s.site_no || ' · ' || s.name as site_label
            from app.site_services ss join app.sites s on s.id = ss.site_id
            left join app.service_types t on t.id = ss.service_type_id
           where ss.id in ${sql(missingChosen)}`),
      );
    const svcGroups = new Map<string, WrSvc[]>();
    for (const x of services) {
      const k = x.own ? '' : x.site_label;
      svcGroups.set(k, [...(svcGroups.get(k) ?? []), x]);
    }
    const unitLabel = (u: string) => WR_UNITS.find(([k]) => k === u)?.[1] ?? u;
    const showPrices = canAccess(c.get('user').role, '/rechnungen');
    type L = { desc: string; qty: string; unit: string; svc: string; person: string; date: string };
    const all: L[] = (data?.lines ?? []).map((l) => ({
      desc: l.description,
      qty: milliToInput(l.quantity_milli),
      unit: l.unit_code,
      svc: l.service_id ?? '',
      person: l.person ?? '',
      date: l.line_date ?? wrDate,
    }));
    const leistungen = all.filter((l) => !l.person);
    const regie = all.filter((l) => l.person);
    if (!data) leistungen.push({ desc: '', qty: '1', unit: 'LS', svc: '', person: '', date: '' });
    if (!regie.length)
      regie.push({ desc: 'Regiestunden', qty: '', unit: 'HUR', svc: '', person: '', date: wrDate });
    const wrTo = w?.work_date_to ?? '';
    const Row: FC<{ l?: L }> = ({ l }) => (
      <tr>
        <td>
          <select name="line_svc" aria-label="Leistung aus dem Katalog" data-nosearch>
            <option value="">
              {services.length ? '– Leistung wählen oder frei –' : '– freie Leistung –'}
            </option>
            {[...svcGroups.entries()].map(([g, list]) => {
              const opts = list.map((x) => (
                <option
                  value={x.id}
                  selected={x.id === l?.svc}
                  data-desc={x.description}
                  data-unit={x.unit_code}
                >
                  {x.type_name && x.type_name !== x.description ? `${x.type_name}: ` : ''}
                  {x.description.split('\n')[0]} ({unitLabel(x.unit_code)})
                  {showPrices ? ` – ${euro(x.unit_price_cents)}` : ''}
                </option>
              ));
              return g ? <optgroup label={`Objekt ${g}`}>{opts}</optgroup> : opts;
            })}
          </select>
          <input name="line_desc" value={l?.desc ?? ''} placeholder="Leistung / Beschreibung" />
          <input type="hidden" name="line_person" value="" />
          <input type="hidden" name="line_kind" value="l" />
          <input type="hidden" name="line_date" value="" />
        </td>
        <td style="width:110px">
          <input name="line_qty" value={l?.qty ?? '1'} class="right" inputmode="decimal" />
        </td>
        <td style="width:120px">
          <select name="line_unit">
            {WR_UNITS.map(([k, v]) => (
              <option value={k} selected={k === (l?.unit ?? 'LS')}>
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
    const RegieRow: FC<{ l?: L }> = ({ l }) => (
      <tr>
        <td style="width:160px">
          <input
            type="date"
            name="line_date"
            value={l?.date ?? ''}
            min={wrDate}
            max={wrTo || wrDate}
            aria-label="Datum"
          />
        </td>
        <td>
          <input type="hidden" name="line_svc" value="" />
          <input type="hidden" name="line_desc" value={l?.desc || 'Regiestunden'} />
          <input type="hidden" name="line_unit" value="HUR" />
          <input type="hidden" name="line_kind" value="r" />
          <input name="line_person" value={l?.person ?? ''} placeholder="Name" list="wr-names" />
        </td>
        <td style="width:110px">
          <input name="line_qty" value={l?.qty ?? ''} class="right" inputmode="decimal" placeholder="Std." />
        </td>
        <td style="width:120px;white-space:nowrap">
          <button type="button" class="btn sm sec copy" title="Zeile kopieren (nächster Tag)">
            Kopieren
          </button>{' '}
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
                  <label for="work_date">Datum von</label>
                  <input
                    id="work_date"
                    type="date"
                    name="work_date"
                    value={w?.work_date ?? todayBerlin()}
                    required
                  />
                </div>
                <div>
                  <label for="work_date_to">bis (bei mehreren Tagen)</label>
                  <input id="work_date_to" type="date" name="work_date_to" value={wrTo} />
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
                          data-name={e.name.split(', ').reverse().join(' ')}
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
              {services.length === 0 ? (
                <p class="small mut" style="margin-top:0">
                  Für dieses Objekt (und die anderen Objekte des Kunden) sind am {dateDe(wrDate)} keine
                  Leistungen hinterlegt – Leistung frei eintragen
                  {showPrices && (
                    <>
                      {' '}
                      oder unter <a href={`/objekte/${siteId}/leistungen`}>Leistungen &amp; Preise</a> anlegen
                    </>
                  )}
                  .
                </p>
              ) : (
                !services.some((x) => x.own) && (
                  <p class="small mut" style="margin-top:0">
                    Das Objekt hat keine eigenen Leistungen – zur Auswahl stehen die Leistungen der anderen
                    Objekte des Kunden.
                  </p>
                )
              )}
              <div class="tbl">
                <table id="wr-lines" class="lines">
                  <thead>
                    <tr>
                      <th>Leistung (aus dem Objekt oder frei)</th>
                      <th class="r">Menge</th>
                      <th>Einheit</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {leistungen.map((l) => (
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
                  + Leistung
                </button>
              </div>
              <h3 style="margin-top:14px">Regiestunden je Person</h3>
              <datalist id="wr-names">
                {emps.map((e) => (
                  <option value={e.name.split(', ').reverse().join(' ')} />
                ))}
              </datalist>
              <div class="tbl">
                <table id="wr-regie" class="lines">
                  <thead>
                    <tr>
                      <th>Datum</th>
                      <th>Name</th>
                      <th class="r">Stunden</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {regie.map((l) => (
                      <RegieRow l={l} />
                    ))}
                  </tbody>
                </table>
              </div>
              <template id="wr-regie-tpl">
                <RegieRow />
              </template>
              <div class="actions">
                <button type="button" class="btn sm sec" id="wr-regie-add">
                  + Person
                </button>
                <span class="small mut">
                  Angehakte Mitarbeiter werden als Zeile übernommen, Stunden aus Beginn/Ende vorgeschlagen.
                  „Kopieren“ legt dieselbe Zeile für den nächsten Tag an. Abgerechnet mit dem Regiestundensatz
                  des Objekts.
                </span>
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
                <button
                  class="btn"
                  name="next"
                  value="pdf"
                  onclick="return confirm('Arbeitsschein abschließen und PDF erstellen? Danach ist er unveränderbar.')"
                >
                  Speichern und PDF erstellen
                </button>
              </div>
              <script dangerouslySetInnerHTML={{ __html: WR_LINES_JS }} />
            </form>
            <div>
              {w && (
                <>
                  <div class="card">
                    <h3>Abschließen</h3>
                    <p class="small mut" style="margin-top:0">
                      „Speichern und PDF erstellen“ schließt den Arbeitsschein ab (ohne Unterschrift).
                      Unterschrift des Kunden ist optional.
                    </p>
                    <div class="actions" style="margin-top:0">
                      <a class="btn sec" href={`/arbeitsscheine/${id}/arbeitsschein.pdf`} target="_blank">
                        PDF-Vorschau
                      </a>
                      <a class="btn ghost" href={`/arbeitsscheine/${id}/unterschrift`}>
                        Kunde unterschreibt (optional)
                      </a>
                    </div>
                  </div>
                  <form
                    method="post"
                    action={`/arbeitsscheine/${id}/loeschen`}
                    class="card"
                    onsubmit="return confirm('Diesen Arbeitsschein-Entwurf löschen?')"
                  >
                    <h3>Entwurf löschen</h3>
                    <p class="small mut" style="margin-top:0">
                      Noch nicht abgeschlossen – wird ganz entfernt (Nummer {w.number} bleibt unbenutzt).
                    </p>
                    <button class="btn sec danger">Arbeitsschein löschen</button>
                  </form>
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
    const svc = arr(b, 'line_svc');
    const person = arr(b, 'line_person');
    const kind = arr(b, 'line_kind');
    const ldate = arr(b, 'line_date');
    const lines = desc
      .map((d, i) => ({ d: d.trim(), i }))
      // leere Zeilen weglassen; Regie-Zeilen nur mit Namen
      .filter(
        (x) =>
          (x.d || svc[x.i]) && (qty[x.i] ?? '').trim() && !(kind[x.i] === 'r' && !(person[x.i] ?? '').trim()),
      )
      .map(({ d, i }) => {
        let quantity;
        try {
          quantity = parseQuantity(qty[i] ?? '');
        } catch {
          throw new BusinessError(`Menge bei „${d || 'Leistung'}“ ungültig`);
        }
        if (quantity <= 0n) throw new BusinessError(`Menge bei „${d || 'Leistung'}“ muss größer 0 sein`);
        return {
          description: d,
          quantity,
          unitCode: WR_UNITS.some(([k]) => k === unit[i]) ? unit[i]! : 'HUR',
          serviceId: /^[0-9a-f-]{36}$/.test(svc[i] ?? '') ? svc[i]! : null,
          person: (person[i] ?? '').trim() || null,
          lineDate: kind[i] === 'r' && /^\d{4}-\d{2}-\d{2}$/.test(ldate[i] ?? '') ? ldate[i]! : null,
        };
      });
    await saveWorkReport(
      sql,
      id,
      {
        orderId: str(b, 'order_id'),
        siteId,
        workDate: str(b, 'work_date') ?? todayBerlin(),
        workDateTo: str(b, 'work_date_to'),
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
    if (str(b, 'next') === 'pdf') {
      await closeWithoutSignature(deps, id, '', c.get('actor'));
      return back(c, `/arbeitsscheine/${id}`, { ok: 'Arbeitsschein abgeschlossen, PDF erstellt.' });
    }
    return back(c, `/arbeitsscheine/${id}`, { ok: 'Arbeitsschein gespeichert.' });
  });

  app.post(`/arbeitsscheine/:id{${UUID}}/loeschen`, async (c) => {
    const id = c.req.param('id');
    const cur = await getWorkReport(sql, id);
    if (!cur) return c.redirect('/arbeitsscheine');
    assertSite(c, cur.report.site_id);
    try {
      await deleteWorkReport(sql, id, c.get('actor'));
    } catch (e) {
      if (e instanceof BusinessError) return back(c, `/arbeitsscheine/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, '/arbeitsscheine', { ok: `Arbeitsschein ${cur.report.number} gelöscht.` });
  });

  app.post(`/arbeitsscheine/:id{${UUID}}/stornieren`, async (c) => {
    const id = c.req.param('id');
    const cur = await getWorkReport(sql, id);
    if (!cur) return c.redirect('/arbeitsscheine');
    assertSite(c, cur.report.site_id);
    const b = await c.req.parseBody();
    try {
      await cancelWorkReport(sql, id, String(b.grund ?? ''), c.get('actor'));
    } catch (e) {
      if (e instanceof BusinessError) return back(c, `/arbeitsscheine/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/arbeitsscheine/${id}`, { ok: `Arbeitsschein ${cur.report.number} storniert.` });
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
      const billable = rows.filter((w) => w.status !== 'entwurf' && !w.invoice_id && !w.cancelled_at);
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
