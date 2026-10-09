import { PDFDocument } from '@cantoo/pdf-lib';
import { renderLetterPdf } from '../pdf/render.js';
import { formatDateDe } from '../domain/invoice/calc.js';
import { getSeller } from '../services/masterdata.js';
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { sha256 } from '../archive/store.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { renderInvoicePdf } from '../pdf/render.js';
import { BusinessError } from '../services/errors.js';
import {
  type InvoiceRow,
  copyInvoice,
  createCancellation,
  createCorrection,
  deleteDraft,
  getInvoice,
  listInvoices,
  draftListInfo,
  loadDraftPreview,
  markReviewed,
  parseBillAddress,
  patchDraft,
  type DraftPatch,
  runMonthly,
  saveDraft,
  setPlannedIssueDate,
} from '../services/invoices.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import {
  buildBuyerSnapshot,
  effectiveBilling,
  getCustomer,
  getSite,
  listCustomers,
  listServiceTypes,
  listServices,
  listSites,
} from '../services/masterdata.js';
import { bookPayment, listPayments, paymentInput, reversePayment } from '../services/payments.js';
import {
  addAttachment,
  issueInvoice,
  listDeliveries,
  listDocuments,
  preflight,
  reviseInvoiceAddress,
  sendInvoice,
  deliveryChannel,
  recordPortalUpload,
  recordManualDelivery,
} from '../services/workflow.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { arr, parseLines, str } from './forms.js';
import { DRAFTS_CSS, DraftsBox, OpenExecutionsBox } from './pages-drafts.js';
import { DraftLetter } from './pages-invoice-letter.js';
import {
  billableOrders,
  dropWorkReportRequirement,
  invoiceWorkReports,
  orderToInvoice,
  workReportFromInvoice,
} from '../services/orders.js';
import { draftsFromExecutions, listOpenExecutions } from '../services/executions.js';
import { NEW_OPTIONS, PageHead, dateDe, euro } from './layout.js';
import { archiveMonthZip, archiveYear } from '../services/invoice-archive.js';
import { KIND_TITLES } from '../domain/invoice/types.js';
import { FileArea } from './files.js';
import { legacyInvoicePage, legacyInvoicePdf } from './routes-legacy-invoices.js';
import { PaymentsSection } from './pages-hr-finance.js';
import {
  type ArticleOption,
  CorrectionEditor,
  CustomerNotice,
  InvoiceDetail,
  InvoiceEditor,
  toEditorLine,
} from './pages-invoices.js';

export function lastMonth(): string {
  const d = new Date(`${todayBerlin().slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

export function registerInvoiceRoutes({ app, deps, page, back }: Ctx) {
  const { sql, env } = deps;

  // ------------------------------------------------------------------ Listen

  // ------------------------------------------------------------------ Archiv nach Leistungszeitraum
  const MONTHS = [
    'Januar',
    'Februar',
    'März',
    'April',
    'Mai',
    'Juni',
    'Juli',
    'August',
    'September',
    'Oktober',
    'November',
    'Dezember',
  ];
  const DOC_LABEL: Record<string, string> = {
    pdf: 'PDF',
    zugferd_pdf: 'ZUGFeRD',
    xrechnung_xml: 'XRechnung',
    attachment: 'Anlage',
  };
  // „Archiv“ ist in „Alle Rechnungen“ aufgegangen
  app.get('/rechnungen/archiv', (c) => {
    const u = new URL(c.req.url);
    return c.redirect(`/rechnungen${u.search}`, 301);
  });

  const allInvoices = async (c: Context<AppEnv>) => {
    const year = Number(c.req.query('jahr') ?? todayBerlin().slice(0, 4));
    const q = c.req.query('q')?.trim() || null;
    const by = c.req.query('nach') === 'datum' ? 'datum' : 'leistung';
    const { months, years } = await archiveYear(sql, year, q, by);
    const [range] = await sql<{ prefix: string; next_value: bigint }[]>`
      select prefix, next_value from app.number_ranges where key = 'invoice'`;
    const qs = (over: Record<string, string>) =>
      `/rechnungen?${new URLSearchParams({ jahr: String(year), ...(by === 'datum' ? { nach: 'datum' } : {}), ...(q ? { q } : {}), ...over }).toString()}`;
    if (!years.includes(year)) years.unshift(year);
    return page(
      c,
      'Rechnungsarchiv',
      'rechnungen',
      <>
        <PageHead title="Rechnungen" create={{ options: NEW_OPTIONS, selected: 'rechnung' }}>
          <span class="mut">Nächste Nr.: {range ? `${range.prefix}${range.next_value}` : '–'}</span>
        </PageHead>
        <form method="get" action="/rechnungen" class="actions" style="margin-top:0">
          <div class="chips" style="margin:0">
            {years.map((y) => (
              <a href={qs({ jahr: String(y) })} class={y === year ? 'on' : ''}>
                {y}
              </a>
            ))}
          </div>
          <div class="chips" style="margin:0">
            <a href={qs({ nach: 'leistung' })} class={by === 'leistung' ? 'on' : ''}>
              nach Leistungszeitraum
            </a>
            <a href={qs({ nach: 'datum' })} class={by === 'datum' ? 'on' : ''}>
              nach Rechnungsdatum
            </a>
          </div>
          <input type="hidden" name="jahr" value={String(year)} />
          {by === 'datum' && <input type="hidden" name="nach" value="datum" />}
          <input
            name="q"
            value={q ?? ''}
            placeholder="Rechnungsnr., Kunde, Objekt, Bestellnr."
            style="max-width:280px"
          />
          <button class="btn sec sm">Suchen</button>
          {q && (
            <span class="small">
              Treffer aus <b>allen Jahren</b> ·{' '}
              <a href={qs({ q: '' }).replace(/&?q=(&|$)/, '$1')}>Suche aufheben</a>
            </span>
          )}
          <span class="small mut" style="margin-left:auto">
            Belege unveränderbar, 10 Jahre aufbewahrt
          </span>
        </form>
        {(() => {
          const all = months.flatMap((m) => m.rows);
          const today = todayBerlin();
          const net = all.reduce((a, r) => a + r.net_cents, 0n);
          const open = all.reduce((a, r) => a + (r.open_cents ?? 0n), 0n);
          const overdue = all
            .filter((r) => r.open_cents && r.due_date && r.due_date < today)
            .reduce((a, r) => a + (r.open_cents ?? 0n), 0n);
          const unsent = all.filter((r) => !r.legacy && r.delivery !== 'sent').length;
          return (
            <div class="stat-kpis">
              <div class="skpi c1">
                <div class="l">Netto {year}</div>
                <div class="v">{euro(net)}</div>
                <div class="s">{all.length} Belege</div>
              </div>
              <a class="skpi c5" href="/offene-posten" style="text-decoration:none;color:inherit">
                <div class="l">davon offen</div>
                <div class="v">{euro(open)}</div>
                <div class="s">
                  überfällig <b style="color:var(--err)">{euro(overdue)}</b>
                </div>
              </a>
              <a class="skpi c2" href="/rechnungen/versand" style="text-decoration:none;color:inherit">
                <div class="l">nicht versendet</div>
                <div class="v">{unsent}</div>
                <div class="s">eigene Rechnungen</div>
              </a>
              <a class="skpi c3" href="/auswertungen/statistik" style="text-decoration:none;color:inherit">
                <div class="l">Statistik</div>
                <div class="v">→</div>
                <div class="s">Diagramme, Kunden, Leistungsarten</div>
              </a>
            </div>
          );
        })()}
        {months.map((m, i) => (
          <details class="card" open={i === 0 || months.length <= 2 || !!q}>
            <summary style="display:flex;align-items:center;gap:14px;cursor:pointer;list-style:none">
              <b style="font-size:16px">
                {MONTHS[Number(m.month.slice(5)) - 1]} {m.month.slice(0, 4)}
              </b>
              <span class="badge">
                {m.rows.length} {m.rows.length === 1 ? 'Beleg' : 'Belege'}
              </span>
              <span class="mut small">
                netto {euro(m.net)} · brutto {euro(m.gross)}
              </span>
              {by === 'leistung' && m.rows.some((r) => !r.legacy) && (
                <a
                  class="btn sec sm"
                  href={`/rechnungen/archiv/zip/${m.month}`}
                  style="margin-left:auto"
                  onclick="event.stopPropagation()"
                >
                  ZIP herunterladen
                </a>
              )}
            </summary>
            <div class="tbl" style="margin-top:12px">
              <table>
                <thead>
                  <tr>
                    <th>Nr.</th>
                    <th>Art</th>
                    <th>Kunde / Objekt</th>
                    <th>Leistungszeitraum</th>
                    <th class="r">Netto</th>
                    <th class="r">Brutto</th>
                    <th>Fällig</th>
                    <th>Status</th>
                    <th>Belege</th>
                  </tr>
                </thead>
                <tbody>
                  {m.rows.map((r) => (
                    <tr>
                      <td>
                        <a href={`/rechnungen/${r.id}`}>{r.number}</a>
                        <div class="small faint">{dateDe(r.issue_date)}</div>
                      </td>
                      <td class="small">
                        {r.legacy
                          ? r.gross_cents < 0n
                            ? 'Storno/Korrektur'
                            : 'Rechnung'
                          : (KIND_TITLES[r.kind as keyof typeof KIND_TITLES] ?? r.kind)}
                      </td>
                      <td>
                        {r.customer_name}
                        {r.site_name && <div class="small mut">{r.site_name}</div>}
                      </td>
                      <td class="small">
                        {r.period_start ? `${dateDe(r.period_start)} – ${dateDe(r.period_end)}` : '–'}
                      </td>
                      <td class="r num">{euro(r.net_cents)}</td>
                      <td class="r num">
                        <b>{euro(r.gross_cents)}</b>
                      </td>
                      <td class="small">{r.due_date ? dateDe(r.due_date) : '–'}</td>
                      <td class="small">
                        {r.cancelled ? (
                          <span class="badge err">storniert</span>
                        ) : r.gross_cents <= 0n ? (
                          <span class="badge">verrechnet</span>
                        ) : r.open_cents ? (
                          r.due_date && r.due_date < todayBerlin() ? (
                            <span class="badge err">überfällig · {euro(r.open_cents)}</span>
                          ) : (
                            <span class="badge warn">offen · {euro(r.open_cents)}</span>
                          )
                        ) : (
                          <span class="badge ok">bezahlt</span>
                        )}
                        {
                          <div class="faint" style="margin-top:2px">
                            {r.legacy || r.delivery === 'sent'
                              ? 'versendet'
                              : r.delivery === 'failed'
                                ? 'Versand-Fehler'
                                : 'nicht versendet'}
                          </div>
                        }
                      </td>
                      <td class="small">
                        {r.legacy && (
                          <a href={`/rechnungen/${r.id}/pdf`} target="_blank">
                            PDF
                          </a>
                        )}
                        {r.docs.map((d) => (
                          <a href={`/dokumente/${d.id}`} target="_blank" style="margin-right:8px">
                            {DOC_LABEL[d.kind] ?? d.kind}
                          </a>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}
        {!months.length && <div class="card empty">Keine Rechnungen in {year}.</div>}
      </>,
    );
  };

  app.get('/rechnungen/archiv/zip/:month{[0-9]{4}-[0-9]{2}}', async (c) => {
    const month = c.req.param('month');
    const zip = await archiveMonthZip(deps, month);
    return c.body(zip as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="Rechnungen_Leistungszeitraum_${month}.zip"`,
      'Cache-Control': 'private, no-store',
    });
  });

  app.get('/rechnungen', async (c) => {
    // „Nicht versendet“ ist eine eigene Seite wie Fortytools (Ahmed 09.10.)
    if (c.req.query('filter') === 'unversendet') return c.redirect('/rechnungen/versand');
    return allInvoices(c);
  });

  app.get('/rechnungen/entwuerfe', async (c) => {
    const [range] = await sql<{ prefix: string; next_value: bigint }[]>`
      select prefix, next_value from app.number_ranges where key = 'invoice'`;
    const monat = /^\d{4}-\d{2}$/.test(c.req.query('monat') ?? '') ? c.req.query('monat')! : '';
    const [allDrafts, monthly] = await Promise.all([
      listInvoices(sql, { status: 'draft' }),
      sql<{ month: string; net: bigint; gross: bigint }[]>`
        select to_char(period_start, 'YYYY-MM') as month, sum(net_cents)::bigint as net, sum(gross_cents)::bigint as gross
          from app.invoices where status = 'draft' and period_start is not null group by 1 order by 1 desc`,
    ]);
    const drafts = monat ? allDrafts.filter((i) => (i.period_start ?? '').slice(0, 7) === monat) : allDrafts;
    const months = [...new Set(allDrafts.map((i) => (i.period_start ?? '').slice(0, 7)).filter(Boolean))]
      .sort()
      .reverse();
    return page(
      c,
      'Rechnungsentwürfe',
      'rechnungen',
      <>
        <PageHead
          title="Rechnungsentwürfe / Vorfaktura"
          create={{ options: NEW_OPTIONS, selected: 'rechnung' }}
        >
          <span class="mut">Nächste Nr.: {range ? `${range.prefix}${range.next_value}` : '–'}</span>
        </PageHead>
        <style dangerouslySetInnerHTML={{ __html: DRAFTS_CSS }} />
        <div class="dr-grid">
          <div>
            <form method="get" action="/rechnungen/entwuerfe" class="actions" style="margin:0 0 8px">
              <label for="dm" style="margin:0">
                Abrechnungsmonat
              </label>
              <select
                id="dm"
                name="monat"
                data-nosearch
                onchange="this.form.submit()"
                style="max-width:220px"
              >
                <option value="">alle Monate ({allDrafts.length})</option>
                {months.map((m) => (
                  <option value={m} selected={m === monat}>
                    {m.split('-').reverse().join('/')} (
                    {allDrafts.filter((i) => (i.period_start ?? '').startsWith(m)).length})
                  </option>
                ))}
              </select>
              {drafts.length > 0 && (
                <a
                  class="btn sec sm"
                  href={`/rechnungen/entwuerfe.pdf${monat ? `?monat=${monat}` : ''}`}
                  target="_blank"
                >
                  PDF aller {monat ? 'Entwürfe dieses Monats' : 'Entwürfe'} ({drafts.length})
                </a>
              )}
            </form>
            <DraftsBox
              rows={drafts}
              today={todayBerlin()}
              info={await draftListInfo(
                sql,
                drafts.map((d) => d.id),
              )}
            />
          </div>
          <aside>
            <div class="card dr-side">
              <h3>Entwürfe je Monat</h3>
              {monthly.length === 0 ? (
                <p class="mut small" style="margin:0">
                  Keine Entwürfe mit Leistungszeitraum.
                </p>
              ) : (
                <table class="dr-list">
                  <tbody>
                    {monthly.map((m) => (
                      <tr>
                        <td>
                          <a href={`/rechnungen/entwuerfe?monat=${m.month}`}>
                            {new Date(`${m.month}-15`).toLocaleDateString('de-DE', {
                              month: 'long',
                              year: 'numeric',
                            })}
                          </a>
                        </td>
                        <td class="r">{euro(m.net)}</td>
                        <td class="r faint">{euro(m.gross)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <OpenExecutionsBox
              rows={await listOpenExecutions(sql)}
              orders={await billableOrders(sql)}
              today={todayBerlin()}
            />
            <form method="post" action="/monatslauf" class="card dr-side">
              <h3>Aus Objektleistungen erstellen</h3>
              <p class="mut small" style="margin-top:0">
                Monatslauf: alle fälligen regelmäßigen Leistungen, je Objekt bzw. Rechnungsgruppe ein Entwurf.
                Mehrfach ausführen erzeugt keine Dubletten.
              </p>
              <div class="dr-side-f">
                <label for="month">Abrechnungsmonat</label>
                <input id="month" type="month" name="month" value={lastMonth()} required />
                <label for="mr_date">Rechnungsdatum</label>
                <input id="mr_date" type="date" name="invoice_date" title="leer = Tag des Ausstellens" />
                <button class="btn">Entwürfe erstellen</button>
              </div>
            </form>
          </aside>
        </div>
      </>,
    );
  });

  // Entwürfe aus vorgemerkten Ausführungen (Auswahl je Kunde/Objekt oder alle)
  app.post('/rechnungen/entwuerfe/aus-ausfuehrungen', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const ids = arr(b, 'exec');
    const created = ids.length
      ? await draftsFromExecutions(sql, ids, str(b, 'invoice_date'), c.get('actor'))
      : [];
    // Einzelaufträge: je Auftrag ein Entwurf (feste ID → doppelt absenden legt nichts doppelt an)
    const date = str(b, 'invoice_date');
    for (const oid of arr(b, 'order')) {
      const inv = await orderToInvoice(deps, oid, c.get('actor'));
      if (date) await setPlannedIssueDate(sql, inv, date, c.get('actor'));
      created.push(inv);
    }
    const backTo = str(b, 'back');
    const target =
      backTo && /^\/objekte\/[0-9a-f-]{36}\/leistungen$/.test(backTo) ? backTo : '/rechnungen/entwuerfe';
    if (created.length === 1 && target !== '/rechnungen/entwuerfe')
      return back(c, `/rechnungen/${created[0]}`, { ok: 'Rechnungsentwurf erstellt.' });
    return back(c, target, {
      ok: created.length
        ? `${created.length} Rechnungsentwurf/-entwürfe erstellt.`
        : 'Nichts erstellt – die Ausführungen stehen schon auf einem Entwurf.',
    });
  });

  // Mehrere Entwürfe: Rechnungsdatum setzen, ausstellen oder löschen
  app.post('/rechnungen/entwuerfe/auswahl', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const ids = arr(b, 'inv');
    if (!ids.length) throw new BusinessError('Bitte mindestens einen Entwurf ankreuzen');
    const action = str(b, 'aktion');
    const actor = c.get('actor');
    if (action === 'pdf') {
      if (ids.length > 300) throw new BusinessError('Höchstens 300 Entwürfe auf einmal');
      return c.body((await draftsPdf(ids)) as Uint8Array<ArrayBuffer>, 200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="Entwuerfe_Auswahl.pdf"',
      });
    }
    if (action === 'datum') {
      const d = str(b, 'invoice_date');
      for (const id of ids) await setPlannedIssueDate(sql, id, d, actor);
      return back(c, '/rechnungen/entwuerfe', {
        ok: `Rechnungsdatum ${d ? d.split('-').reverse().join('.') : '(Tag des Ausstellens)'} für ${ids.length} Entwurf/Entwürfe gesetzt.`,
      });
    }
    if (action === 'loeschen') {
      for (const id of ids) await deleteDraft(sql, id, actor);
      return back(c, str(b, 'zurueck') === '/' ? '/' : '/rechnungen/entwuerfe', {
        ok: `${ids.length} Entwurf/Entwürfe gelöscht.`,
      });
    }
    if (action === 'ausstellen') {
      const d = str(b, 'invoice_date');
      if (d) for (const id of ids) await setPlannedIssueDate(sql, id, d, actor);
      const ok: string[] = [];
      const errors: string[] = [];
      for (const id of ids) {
        try {
          await issueInvoice(deps, id, actor);
          const inv = (await getInvoice(sql, id))!.invoice;
          ok.push(inv.number ?? id);
        } catch (e) {
          if (!(e instanceof BusinessError)) throw e;
          const [who] = await sql<{ label: string }[]>`
            select c.name || coalesce(' / ' || s.name, '') as label from app.invoices i
              join app.customers c on c.id = i.customer_id left join app.sites s on s.id = i.site_id
             where i.id = ${id}`;
          errors.push(`${who?.label ?? id}: ${e.message.split('\n')[0]}`);
        }
      }
      return back(c, '/rechnungen/entwuerfe', {
        ...(ok.length ? { ok: `${ok.length} Rechnung(en) ausgestellt: ${ok.join(', ')}` } : {}),
        ...(errors.length ? { fehler: `Nicht ausgestellt:\n${errors.join('\n')}` } : {}),
      });
    }
    throw new BusinessError('Unbekannte Aktion');
  });

  app.post('/monatslauf', async (c) => {
    const body = await c.req.parseBody();
    const month = String(body.month ?? '');
    const invoiceDate = typeof body.invoice_date === 'string' && body.invoice_date ? body.invoice_date : null;
    const res = await runMonthly(sql, month, c.get('actor'), { invoiceDate });
    const msg =
      `Monatslauf ${month}: ${res.created.length} Entwurf/Entwürfe erstellt.` +
      (res.skipped.length
        ? `\nÜbersprungen: ${res.skipped.map((s) => `${s.siteName} (${s.reason})`).join('; ')}`
        : '');
    return back(c, '/rechnungen/entwuerfe', { ok: msg });
  });

  // ------------------------------------------------------------------ Erfassen

  app.get(`/rechnungen/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const data = await getInvoice(sql, id);
    if (data && data.invoice.status !== 'draft') {
      return back(c, `/rechnungen/${id}`, { fehler: 'Ausgestellte Rechnungen sind unveränderbar.' });
    }
    const inv: Partial<InvoiceRow> = { ...(data?.invoice ?? { kind: 'invoice' as const }) };
    const q = c.req.query();
    if (q.kunde !== undefined) inv.customer_id = q.kunde;
    if (q.objekt !== undefined) inv.site_id = q.objekt || null;
    if (q.art) inv.kind = q.art as 'invoice';
    const customers = await listCustomers(sql);
    const sites = inv.customer_id ? await listSites(sql, inv.customer_id) : [];
    if (inv.site_id && !sites.some((s) => s.id === inv.site_id)) inv.site_id = null;
    const site = inv.site_id ? sites.find((s) => s.id === inv.site_id) : undefined;
    if (!data && site?.order_reference) inv.order_reference = site.order_reference;
    const services = inv.site_id ? await listServices(sql, inv.site_id) : [];
    const partials = inv.customer_id
      ? await sql`
          select i.*, c.name as customer_name from app.invoices i join app.customers c on c.id = i.customer_id
           where i.customer_id = ${inv.customer_id} and i.kind = 'partial' and i.status = 'issued'
             and not exists (select 1 from app.invoices s where s.original_invoice_id = i.id and s.kind = 'cancellation')
             and not exists (select 1 from app.invoice_prepayments p where p.partial_invoice_id = i.id and p.final_invoice_id <> ${id})
           order by i.number`
      : [];
    return page(
      c,
      'Rechnung erfassen',
      'rechnungen',
      <InvoiceEditor
        id={id}
        inv={inv}
        lines={(data?.lines ?? []).map(toEditorLine)}
        customers={customers.filter((x) => x.active)}
        sites={sites}
        services={services}
        partials={partials as never}
        selectedPartials={(data?.prepayments ?? []).map((p) => p.partial_invoice_id)}
        types={await listServiceTypes(sql)}
        articles={await sql<ArticleOption[]>`
          select id, article_no, name, description, sales_price_cents from app.articles
           where active order by name`}
        defaultAddress={
          inv.customer_id
            ? await buildBuyerSnapshot(
                sql,
                inv.customer_id,
                inv.site_id ?? null,
                inv.invoice_group_id ?? null,
              )
                .then((b) => ({
                  name: b.name,
                  name2: b.name2,
                  contactName: b.contactName,
                  street: b.street,
                  postalCode: b.postalCode,
                  city: b.city,
                }))
                .catch(() => undefined)
            : undefined
        }
      />,
    );
  });

  app.post(`/rechnungen/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody({ all: true });
    const kind = (str(body, 'kind') ?? 'invoice') as 'invoice' | 'partial' | 'final';
    if (!['invoice', 'partial', 'final'].includes(kind)) throw new BusinessError('Ungültige Rechnungsart');
    const lines = parseLines(body, { allowNegative: kind === 'invoice' });
    if (!lines.length) throw new BusinessError('Bitte mindestens eine Position erfassen');
    const prepayments = body.prepayments;
    const ptd = str(body, 'payment_terms_days');
    await saveDraft(
      sql,
      id,
      {
        customerId: str(body, 'customer_id') ?? '',
        siteId: str(body, 'site_id'),
        kind,
        periodStart: str(body, 'period_start'),
        periodEnd: str(body, 'period_end'),
        orderReference: str(body, 'order_reference'),
        introText: str(body, 'intro_text'),
        closingText: str(body, 'closing_text'),
        lines,
        prepaymentIds: (Array.isArray(prepayments) ? prepayments : prepayments ? [prepayments] : []).map(
          String,
        ),
        ...(str(body, 'reverse_charge_shown') ? { reverseCharge: str(body, 'reverse_charge') === 'on' } : {}),
        expectedVersion: str(body, 'version') ? Number(str(body, 'version')) : null,
        ...(str(body, 'bill_shown')
          ? {
              billAddress:
                str(body, 'bill_custom') === 'on' ? parseBillAddress(body as Record<string, unknown>) : null,
              customerReference: str(body, 'customer_reference'),
              paymentTermsDays: ptd && /^\d{1,3}$/.test(ptd) ? Number(ptd) : null,
              noSkonto: str(body, 'no_skonto') === 'on',
            }
          : {}),
      },
      c.get('actor'),
    );
    return back(c, `/rechnungen/${id}`, { ok: 'Entwurf gespeichert.' });
  });

  app.post(`/rechnungen/:id{${UUID}}/kopieren`, async (c) => {
    const body = await c.req.parseBody();
    const newId =
      typeof body.new_id === 'string' && /^[0-9a-f-]{36}$/.test(body.new_id) ? body.new_id : randomUUID();
    await copyInvoice(sql, c.req.param('id'), newId, c.get('actor'));
    return back(c, `/rechnungen/${newId}/bearbeiten`, { ok: 'Kopie als Entwurf angelegt – bitte prüfen.' });
  });

  app.post(`/rechnungen/:id{${UUID}}/adresse`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody();
    const revId =
      typeof body.rev_id === 'string' && /^[0-9a-f-]{36}$/.test(body.rev_id) ? body.rev_id : randomUUID();
    await reviseInvoiceAddress(
      deps,
      id,
      parseBillAddress(body as Record<string, unknown>),
      String(body.reason ?? ''),
      c.get('actor'),
      revId,
    );
    return back(c, `/rechnungen/${id}`, {
      ok: 'Berichtigte Fassung erstellt (KoSIT geprüft, Original bleibt im Archiv). Jetzt erneut senden, falls nötig.',
    });
  });

  // Entwurf direkt in der Briefansicht ändern (Anschrift, Texte, einzelne Position)
  app.post(`/rechnungen/:id{${UUID}}/direkt`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const v = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
    const version = /^\d+$/.test(v('version')) ? Number(v('version')) : null;
    const what = v('what');
    let patch: DraftPatch;
    try {
      if (what === 'anschrift')
        patch = {
          what,
          billAddress: v('reset') === '1' ? null : parseBillAddress(b as Record<string, unknown>),
        };
      else if (what === 'einleitung' || what === 'schluss') patch = { what, text: v('text').trim() || null };
      else if (what === 'position') {
        const index = /^\d+$/.test(v('index')) ? Number(v('index')) : null;
        if (v('loeschen') === '1' && index != null) patch = { what: 'position_loeschen', index };
        else {
          let quantity, unitPrice;
          try {
            quantity = parseQuantity(v('qty') || '1');
          } catch {
            throw new BusinessError(`Menge „${v('qty')}“ ist ungültig (max. 3 Nachkommastellen)`);
          }
          try {
            unitPrice = parseEuro(v('price'));
          } catch {
            throw new BusinessError(`Einzelpreis „${v('price')}“ ist ungültig (max. 2 Nachkommastellen)`);
          }
          patch = {
            what,
            index,
            line: { description: v('desc').trim(), quantity, unitCode: v('unit') || 'C62', unitPrice },
          };
        }
      } else throw new BusinessError('Unbekannte Änderung');
      await patchDraft(sql, id, patch, version, c.get('actor'));
    } catch (e) {
      if (e instanceof BusinessError) return back(c, `/rechnungen/${id}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/rechnungen/${id}`, { ok: 'Gespeichert.' });
  });

  // ------------------------------------------------------------------ Detail

  const detail = async (c: Context<AppEnv>, id: string, withPreflight: boolean) => {
    const data = await getInvoice(sql, id);
    if (!data) return c.notFound();
    const pre = withPreflight && data.invoice.status === 'draft' ? await preflight(deps, id) : null;
    const [customer, site, docs, deliveries, payments, openRow, billing] = await Promise.all([
      getCustomer(sql, data.invoice.customer_id),
      data.invoice.site_id ? getSite(sql, data.invoice.site_id) : Promise.resolve(undefined),
      listDocuments(sql, id),
      listDeliveries(sql, id),
      listPayments(sql, id),
      sql<{ open_cents: bigint; skonto_date: string | null }[]>`
        select open_cents, skonto_date from app.open_items where invoice_id = ${id}`,
      effectiveBilling(sql, data.invoice.customer_id, data.invoice.site_id, data.invoice.invoice_group_id),
    ]);
    const channel = await deliveryChannel(sql, id);
    const redirectNote =
      env.APP_ENV !== 'live' || env.MAIL_TEST_RECIPIENT
        ? `TESTBETRIEB: Die Mail geht nur an ${env.MAIL_TEST_RECIPIENT}.`
        : '';
    const inv = data.invoice;
    const skontoAmount =
      inv.skonto_percent_bp && inv.payable_cents > 0n
        ? (inv.payable_cents * BigInt(inv.skonto_percent_bp) + 5000n) / 10000n
        : null;
    if (inv.status === 'draft' && ['invoice', 'partial', 'final'].includes(inv.kind)) {
      return page(
        c,
        'Entwurf',
        'rechnungen',
        <DraftLetter
          inv={inv}
          doc={await loadDraftPreview(sql, id)}
          billing={billing}
          portal={channel.channel === 'portal' ? (channel.portal ?? '') : null}
          newId={randomUUID()}
          preflight={pre}
          attachments={docs.filter((d) => d.kind === 'attachment')}
          workReports={await invoiceWorkReports(sql, id)}
          notice={<CustomerNotice c={customer!} />}
          uploadSlot={
            <FileArea
              link={{ type: 'invoice', id }}
              files={[]}
              category="Anlage zur Rechnung"
              title="Anlagen hierher ziehen"
              hint="Leistungsnachweise, Stundenzettel, Arbeitsscheine – PDF, PNG oder JPG bis 20 MB."
              maxBytes={20 * 1024 * 1024}
            />
          }
        />,
      );
    }
    return page(
      c,
      inv.number ?? 'Entwurf',
      'rechnungen',
      <>
        <InvoiceDetail
          inv={inv}
          lines={data.lines}
          customer={customer!}
          site={site}
          original={data.original}
          derived={data.derived}
          prepayments={data.prepayments}
          docs={docs}
          deliveries={deliveries}
          preflight={pre}
          redirectNote={redirectNote}
          billing={billing}
          portal={channel.channel === 'portal' ? (channel.portal ?? '') : null}
          newId={randomUUID()}
          revisions={await sql`
            select id, revision, reason, created_by, created_at, buyer_snapshot from app.invoice_revisions
             where invoice_id = ${id} order by revision`.then((r) => r as never)}
          uploadSlot={
            <FileArea
              link={{ type: 'invoice', id }}
              files={[]}
              category="Anlage zur Rechnung"
              title="Anlagen hierher ziehen"
              hint="Leistungsnachweise, Stundenzettel, Arbeitsscheine – PDF, PNG oder JPG bis 20 MB. Gehen mit der Rechnung per E-Mail raus."
              maxBytes={20 * 1024 * 1024}
            />
          }
        />
        {inv.status === 'issued' && ['invoice', 'partial', 'final'].includes(inv.kind) && (
          <PaymentsSection
            invoiceId={id}
            payments={payments}
            open={openRow[0]}
            skontoAmount={skontoAmount}
            newId={randomUUID()}
            today={todayBerlin()}
          />
        )}
      </>,
    );
  };

  // Rechnungen von vor der Umstellung: gleiche Adresse, eigene (nur lesende) Ansicht
  const legacyId = async (id: string) =>
    !(await sql`select 1 from app.invoices where id = ${id}`).length &&
    (await sql`select 1 from app.legacy_invoices where id = ${id}`).length > 0;
  app.get(`/rechnungen/:id{${UUID}}`, async (c) =>
    (await legacyId(c.req.param('id')))
      ? legacyInvoicePage(sql, page, c, c.req.param('id'))
      : detail(c, c.req.param('id'), c.req.query('pruefen') === '1'),
  );
  // alte Form (POST) bleibt erreichbar, leitet aber auf die GET-Variante um
  app.post(`/rechnungen/:id{${UUID}}/pruefen`, (c) =>
    c.redirect(`/rechnungen/${c.req.param('id')}?pruefen=1`, 303),
  );

  // Sammel-PDF aller (bzw. der markierten) Entwürfe zur Durchsicht vor dem Ausstellen (Ahmed 08.10.)
  const draftsPdf = async (ids: string[]) => {
    const out = await PDFDocument.create();
    for (const id of ids) {
      const doc = await loadDraftPreview(sql, id);
      const src = await PDFDocument.load(await renderInvoicePdf(doc, { watermark: 'ENTWURF' }));
      for (const pg of await out.copyPages(src, src.getPageIndices())) out.addPage(pg);
    }
    return out.save();
  };
  app.get('/rechnungen/entwuerfe.pdf', async (c) => {
    const m = /^\d{4}-\d{2}$/.test(c.req.query('monat') ?? '') ? c.req.query('monat')! : null;
    const ids = (await listInvoices(sql, { status: 'draft' }))
      .filter((i) => !m || (i.period_start ?? '').slice(0, 7) === m)
      .map((i) => i.id);
    if (!ids.length) throw new BusinessError('Keine Entwürfe');
    if (ids.length > 300)
      throw new BusinessError('Zu viele Entwürfe auf einmal (höchstens 300) – bitte Monat wählen');
    return c.body((await draftsPdf(ids)) as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="Entwuerfe_${m ?? 'alle'}.pdf"`,
    });
  });

  app.get(`/rechnungen/:id{${UUID}}/vorschau.pdf`, async (c) => {
    const id = c.req.param('id');
    const doc = await loadDraftPreview(sql, id);
    const pdf = await renderInvoicePdf(doc, { watermark: 'ENTWURF' });
    return c.body(pdf as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="entwurf.pdf"',
    });
  });

  app.post(`/rechnungen/:id{${UUID}}/ausstellen`, async (c) => {
    const id = c.req.param('id');
    await issueInvoice(deps, id, c.get('actor'));
    const data = await getInvoice(sql, id);
    return back(c, `/rechnungen/${id}`, {
      ok: `Rechnung ${data!.invoice.number} ausgestellt, geprüft und archiviert.`,
    });
  });

  app.post(`/rechnungen/:id{${UUID}}/geprueft`, async (c) => {
    const id = c.req.param('id');
    await markReviewed(sql, id, c.get('actor'));
    return back(c, `/rechnungen/${id}`, { ok: 'Als geprüft markiert – Ausstellen ist jetzt möglich.' });
  });

  // Arbeitsschein aus dem Entwurf: danach Ausstellen erst mit Kundenunterschrift
  app.post(`/rechnungen/:id{${UUID}}/arbeitsschein`, async (c) => {
    const wr = await workReportFromInvoice(sql, c.req.param('id'), c.get('actor'));
    return back(c, `/arbeitsscheine/${wr}`, {
      ok: 'Arbeitsschein angelegt – Mitarbeiter, Zeiten prüfen und vom Kunden unterschreiben lassen.',
    });
  });

  app.post(`/rechnungen/:id{${UUID}}/arbeitsschein-pflicht`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    await dropWorkReportRequirement(sql, id, str(b, 'grund') ?? '', c.get('actor'));
    return back(c, `/rechnungen/${id}`, { ok: 'Arbeitsschein-Pflicht aufgehoben (im Protokoll vermerkt).' });
  });

  app.post(`/rechnungen/:id{${UUID}}/rechnungsdatum`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    await setPlannedIssueDate(sql, id, typeof b.date === 'string' && b.date ? b.date : null, c.get('actor'));
    return back(c, `/rechnungen/${id}`, { ok: 'Rechnungsdatum gespeichert.' });
  });

  app.post(`/rechnungen/:id{${UUID}}/portal`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody();
    const ref =
      typeof body.reference === 'string' && body.reference.trim()
        ? body.reference.trim().slice(0, 200)
        : null;
    const res = await recordPortalUpload(deps, id, { reference: ref, actor: c.get('actor') });
    return back(c, `/rechnungen/${id}`, {
      ok: res.alreadySent ? 'Upload war schon vermerkt.' : 'Als im Portal hochgeladen vermerkt.',
    });
  });

  app.post(`/rechnungen/:id{${UUID}}/versandt`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const r = await recordManualDelivery(deps, id, {
      way: String(b.way ?? ''),
      note: typeof b.note === 'string' ? b.note : null,
      actor: c.get('actor'),
    });
    return back(c, `/rechnungen/${id}`, {
      ok: r.alreadySent ? 'War schon als versendet vermerkt.' : 'Als versendet vermerkt.',
    });
  });

  app.post(`/rechnungen/:id{${UUID}}/versenden`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody();
    const res = await sendInvoice(deps, id, c.get('actor'), { retryFailed: body.retry === '1' });
    return back(c, `/rechnungen/${id}`, {
      ok: res.alreadySent
        ? 'Diese Rechnung wurde bereits versendet – kein zweiter Versand.'
        : `Versendet an ${res.delivery.actual_recipients.join(', ')}.`,
    });
  });

  app.post(`/rechnungen/:id{${UUID}}/storno`, async (c) => {
    const id = await createCancellation(sql, c.req.param('id'), c.get('actor'));
    return back(c, `/rechnungen/${id}`, {
      ok: 'Stornorechnung als Entwurf angelegt. Bitte prüfen und ausstellen.',
    });
  });

  app.get(`/rechnungen/:id{${UUID}}/korrektur`, async (c) => {
    const data = await getInvoice(sql, c.req.param('id'));
    if (!data || data.invoice.status !== 'issued') return c.notFound();
    return page(
      c,
      'Rechnungskorrektur',
      'rechnungen',
      <CorrectionEditor
        id={data.invoice.id}
        original={data.invoice}
        newId={randomUUID()}
        types={await listServiceTypes(sql)}
      />,
    );
  });

  app.post(`/rechnungen/:id{${UUID}}/korrektur`, async (c) => {
    const body = await c.req.parseBody({ all: true });
    const lines = parseLines(body, { allowNegative: true });
    const id = await createCorrection(sql, c.req.param('id'), lines, str(body, 'intro_text'), c.get('actor'));
    return back(c, `/rechnungen/${id}`, { ok: 'Korrekturentwurf angelegt. Bitte prüfen und ausstellen.' });
  });

  app.post(`/rechnungen/:id{${UUID}}/loeschen`, async (c) => {
    await deleteDraft(sql, c.req.param('id'), c.get('actor'));
    return back(c, '/rechnungen/entwuerfe', { ok: 'Entwurf gelöscht.' });
  });

  app.post(`/rechnungen/:id{${UUID}}/anlage`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File) || file.size === 0) throw new BusinessError('Bitte eine Datei auswählen');
    await addAttachment(
      deps,
      id,
      file.name,
      file.type,
      new Uint8Array(await file.arrayBuffer()),
      c.get('actor'),
    );
    return back(c, `/rechnungen/${id}`, { ok: `Anlage „${file.name}“ archiviert.` });
  });

  // ------------------------------------------------------------------ Zahlungen

  app.post(`/rechnungen/:id{${UUID}}/zahlung`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody();
    const parsed = paymentInput.safeParse(body);
    if (!parsed.success) throw new BusinessError(parsed.error.issues.map((i) => i.message).join('\n'));
    const payId = typeof body.id === 'string' && /^[0-9a-f-]{36}$/.test(body.id) ? body.id : randomUUID();
    await bookPayment(sql, payId, id, parsed.data, c.get('actor'));
    return back(c, `/rechnungen/${id}#zahlungen`, { ok: 'Zahlung gebucht.' });
  });

  app.post(`/zahlungen/:id{${UUID}}/korrigieren`, async (c) => {
    const [p] = await sql<
      { invoice_id: string }[]
    >`select invoice_id from app.payments where id = ${c.req.param('id')}`;
    if (!p) return c.notFound();
    await reversePayment(sql, c.req.param('id'), c.get('actor'), 'Fehlbuchung korrigiert');
    return back(c, `/rechnungen/${p.invoice_id}`, { ok: 'Zahlung durch Gegenbuchung korrigiert.' });
  });

  // ------------------------------------------------------------------ Archiv

  /** Lieferschein (wie Fortytools): Positionen ohne Preise, z. B. zum Unterschreiben beim Kunden. */
  app.get(`/rechnungen/:id{${UUID}}/lieferschein.pdf`, async (c) => {
    const id = c.req.param('id');
    const data = await getInvoice(sql, id);
    if (!data) return c.notFound();
    const inv = data.invoice;
    const UNIT: Record<string, string> = {
      HUR: 'Std.',
      C62: 'Stk.',
      LS: 'psch.',
      MTK: 'm²',
      DAY: 'Tag',
      MON: 'Monat',
      MTR: 'lfm',
    };
    const qty = (m: bigint) => (Number(m) / 1000).toLocaleString('de-DE', { maximumFractionDigits: 3 });
    const pdf = await renderLetterPdf({
      title: `Lieferschein${inv.number ? ` zu Rechnung ${inv.number}` : ''}`,
      date: todayBerlin(),
      info: [
        ['Datum', formatDateDe(todayBerlin())],
        ...(inv.number ? ([['Rechnung', inv.number]] as [string, string][]) : []),
        ...(inv.period_start
          ? ([
              [
                'Leistung',
                `${formatDateDe(inv.period_start)}${inv.period_end && inv.period_end !== inv.period_start ? ` – ${formatDateDe(inv.period_end)}` : ''}`,
              ],
            ] as [string, string][])
          : []),
      ],
      seller: await getSeller(sql),
      buyer:
        inv.buyer_snapshot ??
        (await buildBuyerSnapshot(sql, inv.customer_id, inv.site_id, inv.invoice_group_id)),
      greeting: null,
      intro: 'Folgende Leistungen/Waren wurden erbracht bzw. geliefert:',
      columns: [
        { label: 'Pos', x: 62.3, align: 'left' },
        { label: 'Leistung / Artikel', x: 90, align: 'left' },
        { label: 'Menge', x: 470 },
        { label: 'Einheit', x: 538.8 },
      ],
      rows: data.lines.map((l, i) => [
        String(i + 1),
        l.description.slice(0, 64),
        qty(l.quantity_milli < 0n ? -l.quantity_milli : l.quantity_milli),
        UNIT[l.unit_code] ?? l.unit_code,
      ]),
      sums: [],
      total: null,
      paragraphs: ['Ware/Leistung vollständig und ordnungsgemäß erhalten:'],
      signature: { label: 'Empfangen:', png: null, name: '', at: '' },
    });
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Lieferschein_${inv.number ?? 'Entwurf'}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });

  /** PDF einer Rechnung (z. B. aus den Offenen Posten): archiviertes PDF, bei Entwürfen die Vorschau. */
  app.get(`/rechnungen/:id{${UUID}}/pdf`, async (c) => {
    const id = c.req.param('id');
    if (await legacyId(id)) return legacyInvoicePdf(sql, c, id);
    const [doc] = await sql<{ id: string }[]>`
      select id from app.invoice_documents where invoice_id = ${id} and kind = 'pdf' order by created_at desc limit 1`;
    return c.redirect(doc ? `/dokumente/${doc.id}` : `/rechnungen/${id}/vorschau.pdf`);
  });

  app.get(`/dokumente/:id{${UUID}}`, async (c) => {
    const [doc] = await sql<
      { storage_path: string; sha256: string; filename: string; content_type: string }[]
    >`
      select storage_path, sha256, filename, content_type from app.invoice_documents where id = ${c.req.param('id')}`;
    if (!doc) return c.notFound();
    const bytes = await deps.archive.get(doc.storage_path);
    if (sha256(bytes) !== doc.sha256) {
      throw new Error(
        `Integritätsfehler: Archivdatei ${doc.filename} wurde verändert (SHA-256 stimmt nicht)`,
      );
    }
    return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': doc.content_type,
      // ?download=1: als Datei speichern (z. B. E-Rechnung für ein Portal), sonst im Browser anzeigen
      'Content-Disposition': `${c.req.query('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
    });
  });
}
