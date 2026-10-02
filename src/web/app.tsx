import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { sha256 } from '../archive/store.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { renderInvoicePdf } from '../pdf/render.js';
import {
  BusinessError,
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
import {
  customerInput,
  getCustomer,
  getSite,
  listCustomers,
  listServices,
  listSites,
  saveCustomer,
  saveService,
  saveSite,
  serviceInput,
  setServiceActive,
  siteInput,
  suggestCustomerNo,
  suggestSiteNo,
} from '../services/masterdata.js';
import {
  type Deps,
  type PreflightResult,
  addAttachment,
  issueInvoice,
  listDeliveries,
  listDocuments,
  preflight,
  sendInvoice,
} from '../services/workflow.js';
import { parseLines, str } from './forms.js';
import { Layout } from './layout.js';
import { CustomerForm, CustomerList, SiteForm, SiteTable } from './pages-masterdata.js';
import {
  CorrectionEditor,
  Dashboard,
  InvoiceDetail,
  InvoiceEditor,
  InvoiceTable,
  toEditorLine,
} from './pages-invoices.js';
import type { Child } from 'hono/jsx';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

type Env = { Variables: { actor: string } };

export function createApp(deps: Deps) {
  const { sql, env } = deps;
  const app = new Hono<Env>();
  const [user, ...pw] = env.APP_BASIC_AUTH.split(':');

  app.use(secureHeaders());
  app.use(basicAuth({ username: user!, password: pw.join(':'), realm: 'Viva-Deluxe' }));
  app.use(csrf());
  app.use(async (c, next) => {
    c.set('actor', user!);
    await next();
  });

  const page = (c: Context<Env>, title: string, nav: string, body: Child) =>
    c.html(
      '<!doctype html>' +
        String(
          <Layout
            title={title}
            nav={nav}
            env={env.APP_ENV}
            flash={{ ok: c.req.query('ok'), err: c.req.query('fehler') }}
          >
            {body}
          </Layout>,
        ),
    );

  const back = (c: Context<Env>, path: string, msg: { ok?: string; fehler?: string }) => {
    const q = new URLSearchParams(msg as Record<string, string>).toString();
    return c.redirect(`${path}${q ? `?${q}` : ''}`, 303);
  };

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof BusinessError) {
      const ref = c.req.header('referer');
      const target = ref ? new URL(ref).pathname : '/';
      return back(c, target, { fehler: err.message });
    }
    console.error(err);
    return c.html(
      <Layout title="Fehler" nav="" env={env.APP_ENV} flash={{ err: `Unerwarteter Fehler: ${err.message}` }}>
        <a href="/">Zur Übersicht</a>
      </Layout>,
      500,
    );
  });

  // ------------------------------------------------------------------ Übersicht

  app.get('/', async (c) => {
    const [drafts, issued, counts] = await Promise.all([
      listInvoices(sql, { status: 'draft' }),
      listInvoices(sql, { status: 'issued' }),
      sql`select (select count(*)::int from app.customers where active) as customers,
                 (select count(*)::int from app.sites where active) as sites,
                 (select count(*)::int from app.invoices where status = 'draft') as drafts,
                 (select count(*)::int from app.invoices i where status = 'issued'
                    and not exists (select 1 from app.invoice_deliveries d where d.invoice_id = i.id and d.status = 'sent')) as unsent`,
    ]);
    const today = todayBerlin();
    const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    const lastMonth = d.toISOString().slice(0, 7);
    const k = counts[0]!;
    return page(
      c,
      'Übersicht',
      'home',
      <Dashboard
        drafts={drafts}
        issued={issued}
        month={lastMonth}
        stats={{ customers: k.customers, sites: k.sites, openDrafts: k.drafts, unsent: k.unsent }}
      />,
    );
  });

  app.post('/monatslauf', async (c) => {
    const body = await c.req.parseBody();
    const month = String(body.month ?? '');
    const res = await runMonthly(sql, month, c.get('actor'));
    const msg =
      `Monatslauf ${month}: ${res.created.length} Entwurf/Entwürfe erzeugt.` +
      (res.skipped.length
        ? `\nÜbersprungen: ${res.skipped.map((s) => `${s.siteName} (${s.reason})`).join('; ')}`
        : '');
    return back(c, '/', { ok: msg });
  });

  // ------------------------------------------------------------------ Kunden

  app.get('/kunden', async (c) =>
    page(c, 'Kunden', 'kunden', <CustomerList customers={await listCustomers(sql)} />),
  );

  app.get('/kunden/neu', (c) => c.redirect(`/kunden/${randomUUID()}?neu=1`));

  app.get(`/kunden/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const customer = await getCustomer(sql, id);
    const sites = customer ? await listSites(sql, id) : [];
    return page(
      c,
      customer?.name ?? 'Neuer Kunde',
      'kunden',
      <CustomerForm
        id={id}
        c={
          customer ?? {
            payment_terms_days: 30,
            invoice_format: 'zugferd',
            customer_no: await suggestCustomerNo(sql),
          }
        }
        sites={sites}
        isNew={!customer}
      />,
    );
  });

  app.post(`/kunden/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const parsed = customerInput.safeParse(await c.req.parseBody());
    if (!parsed.success) {
      return back(c, `/kunden/${id}`, { fehler: parsed.error.issues.map((i) => i.message).join('\n') });
    }
    try {
      await saveCustomer(sql, id, parsed.data, c.get('actor'));
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return back(c, `/kunden/${id}`, { fehler: 'Kundennummer ist bereits vergeben' });
      }
      throw err;
    }
    return back(c, `/kunden/${id}`, { ok: 'Kunde gespeichert.' });
  });

  // ------------------------------------------------------------------ Objekte

  app.get('/objekte', async (c) =>
    page(
      c,
      'Objekte',
      'objekte',
      <>
        <div class="actions">
          <h1 style="margin:0">Objekte</h1>
          <a class="btn" href="/objekte/neu" style="margin-left:auto">
            + Neues Objekt
          </a>
        </div>
        <SiteTable sites={await listSites(sql)} showCustomer />
      </>,
    ),
  );

  app.get('/objekte/neu', (c) => {
    const kunde = c.req.query('kunde');
    return c.redirect(`/objekte/${randomUUID()}${kunde ? `?kunde=${encodeURIComponent(kunde)}` : ''}`);
  });

  app.get(`/objekte/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const [site, customers, services] = await Promise.all([
      getSite(sql, id),
      listCustomers(sql),
      listServices(sql, id),
    ]);
    return page(
      c,
      site?.name ?? 'Neues Objekt',
      'objekte',
      <SiteForm
        id={id}
        s={
          site ?? {
            customer_id: c.req.query('kunde') ?? '',
            site_no: (c.req.query('kunde') && (await suggestSiteNo(sql, c.req.query('kunde')!))) || '',
          }
        }
        customers={customers}
        services={services}
        isNew={!site}
        newServiceId={randomUUID()}
      />,
    );
  });

  app.post(`/objekte/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const parsed = siteInput.safeParse(await c.req.parseBody());
    if (!parsed.success)
      return back(c, `/objekte/${id}`, { fehler: parsed.error.issues.map((i) => i.message).join('\n') });
    try {
      await saveSite(sql, id, parsed.data, c.get('actor'));
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        return back(c, `/objekte/${id}`, { fehler: 'Objektnummer ist bereits vergeben' });
      throw err;
    }
    return back(c, `/objekte/${id}`, { ok: 'Objekt gespeichert.' });
  });

  app.post(`/objekte/:id{${UUID}}/leistungen/:sid{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const parsed = serviceInput.safeParse(await c.req.parseBody());
    if (!parsed.success)
      return back(c, `/objekte/${id}`, { fehler: parsed.error.issues.map((i) => i.message).join('\n') });
    await saveService(sql, c.req.param('sid'), id, parsed.data, c.get('actor'));
    return back(c, `/objekte/${id}`, { ok: 'Leistung gespeichert.' });
  });

  app.post(`/leistungen/:sid{${UUID}}/aktiv`, async (c) => {
    const body = await c.req.parseBody();
    await setServiceActive(sql, c.req.param('sid'), body.active === 'true', c.get('actor'));
    return back(c, `/objekte/${String(body.site_id)}`, { ok: 'Leistung aktualisiert.' });
  });

  // ------------------------------------------------------------------ Rechnungen

  app.get('/rechnungen', async (c) => {
    const [range] = await sql<{ prefix: string; next_value: bigint }[]>`
      select prefix, next_value from app.number_ranges where key = 'invoice'`;
    return page(
      c,
      'Rechnungen',
      'rechnungen',
      <>
        <div class="actions">
          <h1 style="margin:0">Rechnungen</h1>
          <span class="mut small">Nächste Nr.: {range ? `${range.prefix}${range.next_value}` : '–'}</span>
          <a class="btn" href={`/rechnungen/${randomUUID()}/bearbeiten`} style="margin-left:auto">
            + Einzelrechnung
          </a>
        </div>
        <InvoiceTable rows={await listInvoices(sql)} />
      </>,
    );
  });

  app.get(`/rechnungen/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const data = await getInvoice(sql, id);
    if (data && data.invoice.status !== 'draft')
      return back(c, `/rechnungen/${id}`, { fehler: 'Ausgestellte Rechnungen sind unveränderbar.' });
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
      },
      c.get('actor'),
    );
    return back(c, `/rechnungen/${id}`, { ok: 'Entwurf gespeichert.' });
  });

  const detail = async (c: Context<Env>, id: string, pre: PreflightResult | null = null) => {
    const data = await getInvoice(sql, id);
    if (!data) return c.notFound();
    const [customer, site, docs, deliveries] = await Promise.all([
      getCustomer(sql, data.invoice.customer_id),
      data.invoice.site_id ? getSite(sql, data.invoice.site_id) : Promise.resolve(undefined),
      listDocuments(sql, id),
      listDeliveries(sql, id),
    ]);
    const redirectNote =
      env.APP_ENV !== 'live' || env.MAIL_TEST_RECIPIENT
        ? `TESTBETRIEB: Die Mail geht nur an ${env.MAIL_TEST_RECIPIENT}.`
        : '';
    return page(
      c,
      data.invoice.number ?? 'Entwurf',
      'rechnungen',
      <InvoiceDetail
        inv={data.invoice}
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
      />,
    );
  };

  app.get(`/rechnungen/:id{${UUID}}`, (c) => detail(c, c.req.param('id')));

  app.post(`/rechnungen/:id{${UUID}}/pruefen`, async (c) =>
    detail(c, c.req.param('id'), await preflight(deps, c.req.param('id'))),
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
    return back(c, '/rechnungen', { ok: 'Entwurf gelöscht.' });
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

  app.get('/health', (c) => c.text('ok'));

  return app;
}
