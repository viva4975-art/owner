import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { sha256 } from '../archive/store.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { renderInvoicePdf } from '../pdf/render.js';
import { BusinessError } from '../services/errors.js';
import {
  type InvoiceRow,
  createCancellation,
  createCorrection,
  deleteDraft,
  getInvoice,
  listInvoices,
  loadDocument,
  runMonthly,
  saveDraft,
} from '../services/invoices.js';
import { getCustomer, getSite, listCustomers, listServices, listSites } from '../services/masterdata.js';
import { bookPayment, listPayments, paymentInput, reversePayment } from '../services/payments.js';
import {
  addAttachment,
  issueInvoice,
  listDeliveries,
  listDocuments,
  preflight,
  sendInvoice,
} from '../services/workflow.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { parseLines, str } from './forms.js';
import { NEW_OPTIONS, PageHead, type Tab, Tabs } from './layout.js';
import { FileArea } from './files.js';
import { PaymentsSection } from './pages-hr-finance.js';
import {
  CorrectionEditor,
  InvoiceDetail,
  InvoiceEditor,
  InvoiceTable,
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

  const invoiceTabs = (_active: string, counts: { drafts: number; all: number; unsent: number }): Tab[] => [
    { key: 'entwuerfe', label: 'Entwürfe / Vorfaktura', href: '/rechnungen/entwuerfe', count: counts.drafts },
    { key: 'alle', label: 'Alle Rechnungen', href: '/rechnungen', count: counts.all },
    {
      key: 'unversendet',
      label: 'Nicht versendet',
      href: '/rechnungen?filter=unversendet',
      count: counts.unsent,
    },
    { key: 'op', label: 'Offene Posten', href: '/offene-posten' },
  ];

  const counts = async () => {
    const [r] = await sql<{ drafts: number; all: number; unsent: number }[]>`
      select (select count(*)::int from app.invoices where status = 'draft') as drafts,
             (select count(*)::int from app.invoices where status = 'issued') as all,
             (select count(*)::int from app.invoices i where status = 'issued'
                and not exists (select 1 from app.invoice_deliveries d where d.invoice_id = i.id and d.status = 'sent')) as unsent`;
    return r!;
  };

  app.get('/rechnungen', async (c) => {
    const filter = c.req.query('filter');
    const [range] = await sql<{ prefix: string; next_value: bigint }[]>`
      select prefix, next_value from app.number_ranges where key = 'invoice'`;
    let rows = [...(await listInvoices(sql, { status: 'issued' }))];
    if (filter === 'unversendet') rows = rows.filter((r) => r.delivery_status !== 'sent');
    const active = filter === 'unversendet' ? 'unversendet' : 'alle';
    return page(
      c,
      'Rechnungen',
      'rechnungen',
      <>
        <PageHead title="Rechnungen" create={{ options: NEW_OPTIONS, selected: 'rechnung' }}>
          <span class="mut">Nächste Nr.: {range ? `${range.prefix}${range.next_value}` : '–'}</span>
        </PageHead>
        <Tabs tabs={invoiceTabs(active, await counts())} active={active} />
        <div class="tabbody">
          <InvoiceTable rows={rows} />
        </div>
      </>,
    );
  });

  app.get('/rechnungen/entwuerfe', async (c) => {
    const [range] = await sql<{ prefix: string; next_value: bigint }[]>`
      select prefix, next_value from app.number_ranges where key = 'invoice'`;
    const [drafts, monthly] = await Promise.all([
      listInvoices(sql, { status: 'draft' }),
      sql<{ month: string; net: bigint; gross: bigint }[]>`
        select to_char(period_start, 'YYYY-MM') as month, sum(net_cents)::bigint as net, sum(gross_cents)::bigint as gross
          from app.invoices where status = 'draft' and period_start is not null group by 1 order by 1 desc`,
    ]);
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
        <Tabs tabs={invoiceTabs('entwuerfe', await counts())} active="entwuerfe" />
        <div class="tabbody">
          <InvoiceTable rows={drafts} />
          <p class="mut small">
            Entwürfe lassen sich bearbeiten, bis sie ausgestellt sind. Beim Ausstellen wird die E-Rechnung
            gegen KoSIT geprüft und die nächste Nummer vergeben.
          </p>
        </div>
        <div class="cols">
          <form method="post" action="/monatslauf" class="card">
            <h3>Aus Objektleistungen erstellen (Monatslauf)</h3>
            <p class="mut small" style="margin-top:0">
              Je aktivem Objekt ein Entwurf aus den Monatspauschalen. Mehrfaches Ausführen erzeugt keine
              Dubletten.
            </p>
            <label for="month">Abrechnungsmonat</label>
            <div class="actions" style="margin-top:4px">
              <input
                id="month"
                type="month"
                name="month"
                value={lastMonth()}
                style="max-width:200px"
                required
              />
              <button class="btn">Entwürfe erstellen</button>
            </div>
          </form>
          <div class="card">
            <h3>Entwürfe je Monat</h3>
            {monthly.length === 0 ? (
              <div class="empty">Keine Entwürfe mit Leistungszeitraum.</div>
            ) : (
              <div class="tbl">
                <table>
                  <thead>
                    <tr>
                      <th>Monat</th>
                      <th class="r">Netto</th>
                      <th class="r">Brutto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthly.map((m) => (
                      <tr>
                        <td>{m.month.split('-').reverse().join('/')}</td>
                        <td class="r">
                          {(Number(m.net) / 100).toLocaleString('de-DE', {
                            style: 'currency',
                            currency: 'EUR',
                          })}
                        </td>
                        <td class="r">
                          {(Number(m.gross) / 100).toLocaleString('de-DE', {
                            style: 'currency',
                            currency: 'EUR',
                          })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </>,
    );
  });

  app.post('/monatslauf', async (c) => {
    const body = await c.req.parseBody();
    const month = String(body.month ?? '');
    const res = await runMonthly(sql, month, c.get('actor'));
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
      />,
    );
  });

  app.post(`/rechnungen/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody({ all: true });
    const kind = (str(body, 'kind') ?? 'invoice') as 'invoice' | 'partial' | 'final';
    if (!['invoice', 'partial', 'final'].includes(kind)) throw new BusinessError('Ungültige Rechnungsart');
    const lines = parseLines(body);
    if (!lines.length) throw new BusinessError('Bitte mindestens eine Position erfassen');
    const prepayments = body.prepayments;
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
        expectedVersion: str(body, 'version') ? Number(str(body, 'version')) : null,
      },
      c.get('actor'),
    );
    return back(c, `/rechnungen/${id}`, { ok: 'Entwurf gespeichert.' });
  });

  // ------------------------------------------------------------------ Detail

  const detail = async (c: Context<AppEnv>, id: string, withPreflight: boolean) => {
    const data = await getInvoice(sql, id);
    if (!data) return c.notFound();
    const pre = withPreflight && data.invoice.status === 'draft' ? await preflight(deps, id) : null;
    const [customer, site, docs, deliveries, payments, openRow] = await Promise.all([
      getCustomer(sql, data.invoice.customer_id),
      data.invoice.site_id ? getSite(sql, data.invoice.site_id) : Promise.resolve(undefined),
      listDocuments(sql, id),
      listDeliveries(sql, id),
      listPayments(sql, id),
      sql<{ open_cents: bigint; skonto_date: string | null }[]>`
        select open_cents, skonto_date from app.open_items where invoice_id = ${id}`,
    ]);
    const redirectNote =
      env.APP_ENV !== 'live' || env.MAIL_TEST_RECIPIENT
        ? `TESTBETRIEB: Die Mail geht nur an ${env.MAIL_TEST_RECIPIENT}.`
        : '';
    const inv = data.invoice;
    const skontoAmount =
      inv.skonto_percent_bp && inv.payable_cents > 0n
        ? (inv.payable_cents * BigInt(inv.skonto_percent_bp) + 5000n) / 10000n
        : null;
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

  app.get(`/rechnungen/:id{${UUID}}`, (c) => detail(c, c.req.param('id'), c.req.query('pruefen') === '1'));
  // alte Form (POST) bleibt erreichbar, leitet aber auf die GET-Variante um
  app.post(`/rechnungen/:id{${UUID}}/pruefen`, (c) =>
    c.redirect(`/rechnungen/${c.req.param('id')}?pruefen=1`, 303),
  );

  app.get(`/rechnungen/:id{${UUID}}/vorschau.pdf`, async (c) => {
    const id = c.req.param('id');
    const today = todayBerlin();
    const doc = await loadDocument(sql, id, { number: 'ENTWURF', issueDate: today, dueDate: today });
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
      <CorrectionEditor id={data.invoice.id} original={data.invoice} newId={randomUUID()} />,
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
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
    });
  });
}
