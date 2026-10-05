import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import {
  addNote,
  contactInput,
  deleteContact,
  listContacts,
  listNotes,
  listTasks,
  saveContact,
} from '../services/crm.js';
import { BusinessError } from '../services/errors.js';
import { monthBounds, todayBerlin } from '../domain/invoice/calc.js';
import { billingPreview, listInvoices, runMonthly } from '../services/invoices.js';
import { listInvoiceGroups, saveInvoiceGroup } from '../services/invoice-groups.js';
import {
  type Customer,
  customerInput,
  getCustomer,
  getSite,
  listCustomers,
  getService,
  listServiceTypes,
  listServices,
  saveServiceType,
  listSites,
  saveCustomer,
  saveService,
  saveSite,
  serviceInput,
  setServiceActive,
  siteInput,
  resolveBilling,
  saveSiteBilling,
  siteBillingInput,
  type Site,
  type SiteBilling,
  suggestCustomerNo,
  suggestSiteNo,
} from '../services/masterdata.js';
import { listDunnings } from '../services/dunning.js';
import { listOffers } from '../services/offers.js';
import { listOpenItems } from '../services/payments.js';
import { listFiles } from '../services/uploads.js';
import {
  CUSTOMER_STATUS,
  CUSTOMER_TEMPLATE_FIELDS,
  type CustomerFilter,
  type CustomerStatus,
  customerSerialLetter,
  customersCsv,
  filteredCustomers,
  PAGE_SIZE,
  sitesOf,
} from '../services/customer-list.js';
import { listTemplates, saveTemplate } from '../services/employees.js';
import { uploadConfig } from './routes-files.js';
import { filteredSites, managers, parseSiteFilter, sitesCsv, SITE_PAGE_SIZE } from '../services/site-list.js';
import { type AppEnv, type Ctx, UUID, assertSite } from './app.js';
import { FileArea } from './files.js';
import { arr, str } from './forms.js';
import { PageHead, dateDe, euro } from './layout.js';
import { OfferTable } from './pages-offers.js';
import { ContactsPanel, NotesPanel, TaskBox, TaskForm } from './pages-crm.js';
import { OpenItemsTable } from './pages-hr-finance.js';
import { InvoiceTable } from './pages-invoices.js';
import { ServiceForm, ServicesPanel } from './pages-services.js';
import {
  type CustomerCounts,
  CustomerCard,
  CustomerForm,
  CustomerList,
  SiteList,
  SiteBillingForm,
  CustomerShell,
  RevenueBars,
  SiteForm,
  SiteOverview,
  SiteShell,
  SiteTable,
} from './pages-masterdata.js';

const versionOf = (v: unknown) => (typeof v === 'string' && v !== '' ? Number(v) : null);

/** Netto-Umsatz je Monat der letzten 16 Monate (ausgestellte Belege inkl. Storno). */
export async function revenueByMonth(sql: Ctx['deps']['sql'], filter: { customerId?: string } = {}) {
  return sql<{ month: string; net_cents: bigint }[]>`
    with months as (
      select to_char(d, 'YYYY-MM') as month
        from generate_series(date_trunc('month', current_date) - interval '15 months', date_trunc('month', current_date), interval '1 month') d
    )
    select m.month, coalesce(sum(i.net_cents), 0)::bigint as net_cents
      from months m
      left join app.invoices i on i.status = 'issued' and to_char(i.issue_date, 'YYYY-MM') = m.month
                              and ${filter.customerId ? sql`i.customer_id = ${filter.customerId}` : sql`true`}
     group by m.month order by m.month`;
}

export function registerMasterdataRoutes(ctx: Ctx) {
  const { app, deps, page, back, shells } = ctx;
  const { sql } = deps;

  // ------------------------------------------------------------------ Kunden

  const customerFilter = (get: (k: string) => string | undefined): CustomerFilter => {
    const st = get('status');
    const l = get('buchstabe')?.toUpperCase();
    return {
      status: st && st in CUSTOMER_STATUS ? (st as CustomerStatus) : null,
      letter: l && /^[A-Z#]$/.test(l) ? l : null,
      q: get('q')?.trim() || null,
    };
  };

  app.get('/kunden', async (c) => {
    const filter = customerFilter((k) => c.req.query(k));
    const { rows, counts, total } = await filteredCustomers(sql, filter);
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const pageNo = Math.min(pages, Math.max(1, Number(c.req.query('seite') ?? 1) || 1));
    const shown = rows.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE);
    const [sites, templates] = await Promise.all([
      sitesOf(
        sql,
        shown.map((x) => x.id),
      ),
      listTemplates(sql, false, 'kunde'),
    ]);
    return page(
      c,
      'Kunden',
      'kunden',
      <CustomerList
        rows={shown}
        filtered={rows.length}
        counts={counts}
        total={total}
        filter={filter}
        page={pageNo}
        sites={sites}
        templates={templates}
      />,
    );
  });

  app.get('/kunden/export.csv', async (c) => {
    const { rows } = await filteredCustomers(
      sql,
      customerFilter((k) => c.req.query(k)),
    );
    return new Response(customersCsv(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="Kunden_${todayBerlin()}.csv"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });

  app.post('/kunden/serienbrief', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const filter = customerFilter((k) => str(b, k) ?? undefined);
    const { rows } = await filteredCustomers(sql, filter);
    try {
      const pdf = await customerSerialLetter(deps, uploadConfig(ctx), {
        runId: str(b, 'run') ?? randomUUID(),
        templateId: str(b, 'vorlage') ?? '',
        customerIds: rows.map((r) => r.id),
        actor: c.get('actor'),
      });
      return new Response(pdf, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="Serienbrief_${todayBerlin()}.pdf"`,
          'Cache-Control': 'private, no-store',
        },
      });
    } catch (e) {
      if (e instanceof BusinessError) return back(c, '/kunden', { fehler: e.message });
      throw e;
    }
  });

  app.get('/kunden/vorlagen', async (c) => {
    const list = await listTemplates(sql, true, 'kunde');
    const t = list.find((x) => x.id === c.req.query('bearbeiten')) ?? null;
    const formId = t?.id ?? randomUUID();
    return page(
      c,
      'Briefvorlagen Kunden',
      'kunden',
      <>
        <PageHead title="Briefvorlagen für Kunden" crumbs={[['Kunden', '/kunden']]} />
        <div class="cols">
          <form
            method="post"
            action={`/kunden/vorlagen/${formId}`}
            class="card"
            data-version={String(t?.version ?? '')}
          >
            <h3>{t ? `„${t.title}“ bearbeiten` : 'Neue Vorlage'}</h3>
            <input type="hidden" name="version" value={String(t?.version ?? '')} />
            <label for="title">Betreff</label>
            <input id="title" name="title" value={t?.title ?? ''} required />
            <label for="body" style="margin-top:12px">
              Text (Anrede, Gruß und Briefkopf werden automatisch gesetzt; Leerzeile = neuer Absatz)
            </label>
            <textarea id="body" name="body" rows={12} required>
              {t?.body ?? ''}
            </textarea>
            <p class="small mut">
              Platzhalter:{' '}
              {CUSTOMER_TEMPLATE_FIELDS.map(([k, v]) => (
                <span title={v} style="margin-right:6px">
                  <code>{`{{${k}}}`}</code>
                </span>
              ))}
            </p>
            <div class="chk">
              <input type="checkbox" id="active" name="active" checked={t ? t.active : true} />
              <label for="active">aktiv</label>
            </div>
            <div class="formfoot">
              {t && (
                <a class="btn sec" href="/kunden/vorlagen">
                  Neue Vorlage
                </a>
              )}
              <button class="btn">Speichern</button>
            </div>
          </form>
          <div class="card">
            <h3>Vorlagen</h3>
            <div class="list">
              {list.map((x) => (
                <div class="row">
                  <div class="main">
                    <a href={`/kunden/vorlagen?bearbeiten=${x.id}`}>
                      <b style="color:var(--ink)">{x.title}</b>
                    </a>
                    {!x.active && <span class="small faint"> · inaktiv</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </>,
    );
  });

  app.post(`/kunden/vorlagen/:tid{${UUID}}`, async (c) => {
    const b = await c.req.parseBody({ all: true });
    const tid = c.req.param('tid');
    const [cur] = await sql<
      { audience: string }[]
    >`select audience from app.document_templates where id = ${tid}`;
    if (cur && cur.audience !== 'kunde')
      return back(c, '/kunden/vorlagen', { fehler: 'Keine Kundenvorlage' });
    try {
      await saveTemplate(sql, tid, {
        title: str(b, 'title') ?? '',
        category: 'Schriftverkehr',
        body: typeof b.body === 'string' ? b.body : '',
        active: b.active === 'on',
        expectedVersion: typeof b.version === 'string' && b.version ? Number(b.version) : null,
        audience: 'kunde',
      });
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `/kunden/vorlagen?bearbeiten=${tid}`, { fehler: e.message });
      throw e;
    }
    return back(c, `/kunden/vorlagen?bearbeiten=${tid}`, { ok: 'Vorlage gespeichert.' });
  });

  app.get('/kunden/neu', (c) =>
    c.redirect(
      `/kunden/${randomUUID()}/bearbeiten${c.req.query('interessent') === '1' ? '?interessent=1' : ''}`,
    ),
  );

  const customerCounts = async (id: string): Promise<CustomerCounts> => {
    const [r] = await sql<CustomerCounts[]>`
      select (select count(*)::int from app.contacts where customer_id = ${id}) as contacts,
             (select count(*)::int from app.notes where entity_type = 'customer' and entity_id = ${id}) as notes,
             (select count(*)::int from app.invoices where customer_id = ${id} and status = 'issued') as invoices,
             (select count(*)::int from app.sites where customer_id = ${id}) as sites,
             (select count(*)::int from app.tasks where entity_type = 'customer' and entity_id = ${id} and status = 'open') as tasks,
             (select count(*)::int from app.open_items where customer_id = ${id} and open_cents <> 0) as "openItems",
             (select count(*)::int from app.offers where customer_id = ${id}) as offers,
             (select count(*)::int from app.dunnings where customer_id = ${id}) as dunnings,
             (select count(*)::int from app.file_links l join app.files f on f.id = l.file_id
               where l.entity_type = 'customer' and l.entity_id = ${id} and f.status = 'complete') as files`;
    return r!;
  };

  /** Rendert eine Kundenseite mit Reitern; unbekannte ID → Neuanlage. */
  const customerPage = async (
    c: Context<AppEnv>,
    active: string,
    body: (cust: Customer) => Promise<Child> | Child,
  ) => {
    const id = c.req.param('id')!;
    const cust = await getCustomer(sql, id);
    if (!cust) return c.redirect(`/kunden/${id}/bearbeiten`);
    return page(
      c,
      cust.name,
      'kunden',
      <CustomerShell c={cust} counts={await customerCounts(id)} active={active}>
        {await body(cust)}
      </CustomerShell>,
    );
  };

  app.get(`/kunden/:id{${UUID}}`, (c) =>
    customerPage(c, 'uebersicht', async (cust) => {
      const [tasks, items, revenue] = await Promise.all([
        listTasks(sql, { status: 'open', entity: { type: 'customer', id: cust.id } }),
        listOpenItems(sql, cust.id),
        revenueByMonth(sql, { customerId: cust.id }),
      ]);
      return (
        <div class="cols">
          <div>
            <TaskBox tasks={tasks} doneLink={`/kunden/${cust.id}/aufgaben?status=done`} />
            <h2>Offene Posten</h2>
            <OpenItemsTable items={items} />
            <h2>Netto-Umsatz</h2>
            <RevenueBars rows={revenue} />
          </div>
          <div>
            <CustomerCard c={cust} />
          </div>
        </div>
      );
    }),
  );

  app.get(`/kunden/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const cust = await getCustomer(sql, id);
    const form = (
      <CustomerForm
        id={id}
        c={
          cust ?? {
            payment_terms_days: 30,
            invoice_format: 'zugferd',
            customer_no: await suggestCustomerNo(sql),
            status: c.req.query('interessent') === '1' ? 'interessent' : 'kunde',
          }
        }
        isNew={!cust}
      />
    );
    if (!cust) {
      return page(
        c,
        'Neuer Kunde',
        'kunden',
        <>
          <PageHead title="Neuer Kunde" />
          <div class="card">{form}</div>
        </>,
      );
    }
    return customerPage(c, 'bearbeiten', () => form);
  });

  app.post(`/kunden/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody();
    const parsed = customerInput.safeParse(body);
    if (!parsed.success) throw new BusinessError(parsed.error.issues.map((i) => i.message).join('\n'));
    try {
      await saveCustomer(sql, id, parsed.data, c.get('actor'), versionOf(body.version));
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        throw new BusinessError('Kundennummer ist bereits vergeben');
      throw err;
    }
    return back(c, `/kunden/${id}`, { ok: 'Kunde gespeichert.' });
  });

  app.get(`/kunden/:id{${UUID}}/kontakte`, (c) =>
    customerPage(c, 'kontakte', async (cust) => {
      const contacts = await listContacts(sql, cust.id);
      const editId = c.req.query('bearbeiten');
      return (
        <ContactsPanel
          customerId={cust.id}
          contacts={contacts}
          edit={contacts.find((k) => k.id === editId) ?? null}
          newId={randomUUID()}
        />
      );
    }),
  );

  app.post(`/kunden/:id{${UUID}}/kontakte/:kid{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const parsed = contactInput.safeParse(await c.req.parseBody());
    if (!parsed.success) throw new BusinessError(parsed.error.issues.map((i) => i.message).join('\n'));
    await saveContact(sql, c.req.param('kid'), id, parsed.data);
    return back(c, `/kunden/${id}/kontakte`, { ok: 'Kontakt gespeichert.' });
  });

  app.post(`/kunden/:id{${UUID}}/kontakte/:kid{${UUID}}/loeschen`, async (c) => {
    await deleteContact(sql, c.req.param('kid'));
    return back(c, `/kunden/${c.req.param('id')}/kontakte`, { ok: 'Kontakt gelöscht.' });
  });

  const notesRoutes = (base: string, type: 'customer' | 'site', shell: typeof customerPage) => {
    app.get(`${base}/:id{${UUID}}/notizen`, (c) =>
      shell(c, 'notizen', async (e: { id: string }) => (
        <NotesPanel
          action={`${base}/${e.id}/notizen`}
          notes={await listNotes(sql, type, e.id)}
          newId={randomUUID()}
        />
      )),
    );
    app.post(`${base}/:id{${UUID}}/notizen`, async (c) => {
      const body = await c.req.parseBody();
      const noteId = typeof body.id === 'string' && /^[0-9a-f-]{36}$/.test(body.id) ? body.id : randomUUID();
      await addNote(sql, noteId, type, c.req.param('id'), String(body.body ?? ''), c.get('actor'));
      return back(c, `${base}/${c.req.param('id')}/notizen`, { ok: 'Notiz gespeichert.' });
    });
  };

  const tasksRoute = (
    base: string,
    type: 'customer' | 'site',
    shell: typeof customerPage,
    label: (e: never) => string,
  ) => {
    app.get(`${base}/:id{${UUID}}/aufgaben`, (c) =>
      shell(c, 'aufgaben', async (e: { id: string }) => {
        const status = c.req.query('status') === 'done' ? 'done' : 'open';
        return (
          <>
            <TaskBox
              tasks={await listTasks(sql, { status, entity: { type, id: e.id } })}
              title={status === 'done' ? 'Erledigte Aufgaben' : 'Offene Aufgaben'}
              doneLink={`${base}/${e.id}/aufgaben?status=done`}
            />
            <TaskForm
              newId={randomUUID()}
              entity={{ type, id: e.id, label: label(e as never) }}
              back={`${base}/${e.id}/aufgaben`}
            />
          </>
        );
      }),
    );
  };

  notesRoutes('/kunden', 'customer', customerPage);
  tasksRoute('/kunden', 'customer', customerPage, (e: Customer) => e.name);

  app.get(`/kunden/:id{${UUID}}/rechnungen`, (c) =>
    customerPage(c, 'rechnungen', async (cust) => (
      <>
        <div class="actions" style="margin-top:0">
          <a class="btn sm" href={`/neu?typ=rechnung&kunde=${cust.id}`}>
            + Rechnung für diesen Kunden
          </a>
        </div>
        <InvoiceTable rows={(await listInvoices(sql)).filter((i) => i.customer_id === cust.id)} />
      </>
    )),
  );

  app.get(`/kunden/:id{${UUID}}/objekte`, (c) =>
    customerPage(c, 'objekte', async (cust) => (
      <>
        <div class="actions" style="margin-top:0">
          <a class="btn sm" href={`/neu?typ=objekt&kunde=${cust.id}`}>
            + Objekt anlegen
          </a>
        </div>
        <SiteTable sites={await listSites(sql, cust.id)} />
      </>
    )),
  );

  // Rechnungsgruppen: mehrere Objekte → eine Sammelrechnung im Monatslauf
  app.get(`/kunden/:id{${UUID}}/rechnungsgruppen`, (c) =>
    customerPage(c, 'rechnungsgruppen', async (cust) => {
      const [groups, sites] = await Promise.all([listInvoiceGroups(sql, cust.id), listSites(sql, cust.id)]);
      const editId = c.req.query('bearbeiten');
      const g = groups.find((x) => x.id === editId) ?? null;
      const formId = g?.id ?? randomUUID();
      const groupOf = new Map(groups.flatMap((x) => x.site_ids.map((sid) => [sid, x] as const)));
      return (
        <>
          <p class="mut" style="max-width:820px;margin-top:0">
            Objekte einer Rechnungsgruppe werden im Monatslauf auf <b>einer</b> Rechnung abgerechnet (je
            Objekt eigene Positionen mit Objektname und Adresse). Leitweg-ID und Bestellnummer der Gruppe
            gehen vor denen des Kunden bzw. Objekts.
          </p>
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>Rechnungsgruppe</th>
                  <th>Objekte</th>
                  <th>Leitweg-ID</th>
                  <th>Bestellnummer</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((x) => (
                  <tr>
                    <td>
                      <a href={`/kunden/${cust.id}/rechnungsgruppen?bearbeiten=${x.id}`}>{x.name}</a>
                    </td>
                    <td class="small">{x.site_names.join(', ') || '–'}</td>
                    <td>{x.buyer_reference ?? <span class="mut">wie Kunde</span>}</td>
                    <td>{x.order_reference}</td>
                    <td>
                      {x.active ? <span class="badge ok">aktiv</span> : <span class="badge">inaktiv</span>}
                    </td>
                  </tr>
                ))}
                {!groups.length && (
                  <tr>
                    <td colspan={5} class="mut">
                      Keine Rechnungsgruppen – jedes Objekt bekommt eine eigene Monatsrechnung.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <form
            method="post"
            action={`/kunden/${cust.id}/rechnungsgruppen/${formId}`}
            class="card"
            style="max-width:820px"
            data-version={String(g?.version ?? '')}
          >
            <h3 style="margin-top:0">
              {g ? `Rechnungsgruppe „${g.name}“ bearbeiten` : 'Neue Rechnungsgruppe'}
            </h3>
            <input type="hidden" name="version" value={String(g?.version ?? '')} />
            <div class="grid">
              <div>
                <label for="g-name">Name</label>
                <input
                  id="g-name"
                  name="name"
                  value={g?.name ?? ''}
                  required
                  placeholder="z. B. Schulen Süd"
                />
              </div>
              <div>
                <label for="g-leitweg">Leitweg-ID (abweichend)</label>
                <input
                  id="g-leitweg"
                  name="buyer_reference"
                  value={g?.buyer_reference ?? ''}
                  placeholder={cust.leitweg_id ?? ''}
                />
              </div>
              <div>
                <label for="g-order">Bestellnummer</label>
                <input id="g-order" name="order_reference" value={g?.order_reference ?? ''} />
              </div>
            </div>
            <label>Objekte in dieser Gruppe</label>
            <div class="grid" style="gap:6px 16px">
              {sites.map((st) => {
                const other = groupOf.get(st.id);
                return (
                  <label class="chk" style="margin:0">
                    <input type="checkbox" name="site" value={st.id} checked={!!g && other?.id === g.id} />
                    {st.name} <span class="mut small">{st.site_no}</span>
                    {other && other.id !== g?.id && <span class="badge tag">jetzt: {other.name}</span>}
                  </label>
                );
              })}
            </div>
            <label for="g-intro">Kopftext der Sammelrechnung (leer = Standard)</label>
            <textarea
              id="g-intro"
              name="intro_text"
              rows={3}
              placeholder="Sehr geehrte Damen und Herren, wir danken für Ihren Auftrag und berechnen unsere Leistungen wie folgt:"
            >
              {g?.intro_text ?? ''}
            </textarea>
            <label for="g-closing">Fußtext (leer = Standard)</label>
            <textarea
              id="g-closing"
              name="closing_text"
              rows={3}
              placeholder="Wir bitten um Überweisung auf unser Konto. Für Rückfragen zu dieser Rechnung stehen wir jederzeit gerne zur Verfügung."
            >
              {g?.closing_text ?? ''}
            </textarea>
            <label for="g-note">Notiz</label>
            <input id="g-note" name="note" value={g?.note ?? ''} />
            <div class="chk" style="margin-top:10px">
              <input type="checkbox" id="g-active" name="active" checked={g ? g.active : true} />
              <label for="g-active">aktiv (inaktive Gruppe: Objekte werden wieder einzeln abgerechnet)</label>
            </div>
            <div class="formfoot">
              {g && (
                <a class="btn sec" href={`/kunden/${cust.id}/rechnungsgruppen`}>
                  Abbrechen
                </a>
              )}
              <button class="btn">{g ? 'Speichern' : 'Rechnungsgruppe anlegen'}</button>
            </div>
          </form>
        </>
      );
    }),
  );

  app.post(`/kunden/:id{${UUID}}/rechnungsgruppen/:gid{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    await saveInvoiceGroup(
      sql,
      c.req.param('gid'),
      {
        customerId: id,
        name: str(b, 'name') ?? '',
        buyerReference: str(b, 'buyer_reference'),
        orderReference: str(b, 'order_reference'),
        note: str(b, 'note'),
        introText: str(b, 'intro_text'),
        closingText: str(b, 'closing_text'),
        active: b.active === 'on',
        siteIds: arr(b, 'site').filter((x) => /^[0-9a-f-]{36}$/.test(x)),
        expectedVersion: typeof b.version === 'string' && b.version !== '' ? Number(b.version) : null,
      },
      c.get('actor'),
    );
    return back(c, `/kunden/${id}/rechnungsgruppen`, { ok: 'Rechnungsgruppe gespeichert.' });
  });

  app.get(`/kunden/:id{${UUID}}/offene-posten`, (c) =>
    customerPage(c, 'op', async (cust) => <OpenItemsTable items={await listOpenItems(sql, cust.id)} />),
  );

  app.get(`/kunden/:id{${UUID}}/angebote`, (c) =>
    customerPage(c, 'angebote', async (cust) => (
      <>
        <div class="actions" style="margin-top:0">
          <a class="btn sm" href={`/neu?typ=angebot&kunde=${cust.id}`}>
            + Angebot für diesen Kunden
          </a>
        </div>
        <OfferTable rows={await listOffers(sql, { customerId: cust.id })} showCustomer={false} />
      </>
    )),
  );

  app.get(`/kunden/:id{${UUID}}/mahnungen`, (c) =>
    customerPage(c, 'mahnungen', async (cust) => {
      const list = await listDunnings(sql, cust.id);
      return (
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Nr.</th>
                <th>Stufe</th>
                <th>Datum</th>
                <th class="r">Betrag</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr>
                  <td colspan={5}>
                    <div class="empty">
                      Keine Mahnungen{cust.dunning_block ? ' – Mahnsperre gesetzt' : ''}.
                    </div>
                  </td>
                </tr>
              )}
              {list.map((d) => (
                <tr>
                  <td>
                    <a href={`/mahnungen/${d.id}`}>{d.number}</a>
                  </td>
                  <td>{d.title}</td>
                  <td>{dateDe(d.issue_date)}</td>
                  <td class="r">{euro(d.total_cents)}</td>
                  <td>{d.status === 'versendet' ? 'Versendet' : 'Erstellt'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }),
  );

  app.get(`/kunden/:id{${UUID}}/dokumente`, (c) =>
    customerPage(c, 'dokumente', async (cust) => (
      <div class="card">
        <h3>Verträge, Leistungsverzeichnisse, Schriftverkehr</h3>
        <FileArea
          link={{ type: 'customer', id: cust.id }}
          files={await listFiles(sql, { type: 'customer', id: cust.id })}
          category="Kundendokument"
          maxBytes={deps.env.UPLOAD_MAX_BYTES}
        />
      </div>
    )),
  );

  // ------------------------------------------------------------------ Objekte

  const siteFilter = parseSiteFilter;

  app.get('/objekte', async (c) => {
    const filter = siteFilter((k) => c.req.query(k));
    const { rows, counts, total } = await filteredSites(sql, c.get('sites'), filter);
    const pages = Math.max(1, Math.ceil(rows.length / SITE_PAGE_SIZE));
    const pageNo = Math.min(pages, Math.max(1, Number(c.req.query('seite') ?? 1) || 1));
    return page(
      c,
      'Objekte',
      'kunden',
      <SiteList
        rows={rows.slice((pageNo - 1) * SITE_PAGE_SIZE, pageNo * SITE_PAGE_SIZE)}
        filtered={rows.length}
        counts={counts}
        total={total}
        filter={filter}
        page={pageNo}
        managers={await managers(sql)}
        showManagerFilter={c.get('sites') === null}
      />,
    );
  });

  app.get('/objekte/export.csv', async (c) => {
    const { rows } = await filteredSites(
      sql,
      c.get('sites'),
      siteFilter((k) => c.req.query(k)),
    );
    return new Response(sitesCsv(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="Objekte_${todayBerlin()}.csv"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });

  app.get('/objekte/neu', (c) => {
    const kunde = c.req.query('kunde');
    return c.redirect(
      `/objekte/${randomUUID()}/bearbeiten${kunde ? `?kunde=${encodeURIComponent(kunde)}` : ''}`,
    );
  });

  const sitePage = async (
    c: Context<AppEnv>,
    active: string,
    body: (s: NonNullable<Awaited<ReturnType<typeof getSite>>>) => Promise<Child> | Child,
  ) => {
    const id = c.req.param('id')!;
    assertSite(c, id);
    // Objektleitung sieht keine Preise → statt Übersicht direkt den Einsatzplan
    if (active === 'uebersicht' && c.get('user').role === 'objektleitung')
      return c.redirect(`/objekte/${id}/einsaetze`);
    const s = await getSite(sql, id);
    if (!s) return c.redirect(`/objekte/${id}/bearbeiten`);
    const [counts] = await sql<
      { services: number; notes: number; invoices: number; employees: number; tasks: number }[]
    >`
      select (select count(*)::int from app.site_services where site_id = ${id} and active) as services,
             (select count(*)::int from app.notes where entity_type = 'site' and entity_id = ${id}) as notes,
             (select count(*)::int from app.invoices where site_id = ${id} and status = 'issued') as invoices,
             (select count(*)::int from app.employee_sites where site_id = ${id}) as employees,
             (select count(*)::int from app.tasks where entity_type = 'site' and entity_id = ${id} and status = 'open') as tasks`;
    return page(
      c,
      s.name,
      'kunden',
      <SiteShell s={s} counts={counts!} active={active}>
        {await body(s)}
      </SiteShell>,
    );
  };

  shells.site = sitePage as unknown as NonNullable<Ctx['shells']['site']>;

  app.get(`/objekte/:id{${UUID}}`, (c) =>
    sitePage(c, 'uebersicht', async (s) => {
      const [customer, services, employees, tasks] = await Promise.all([
        getCustomer(sql, s.customer_id),
        listServices(sql, s.id),
        sql<{ id: string; name: string }[]>`
          select e.id, e.last_name || ', ' || e.first_name as name from app.employee_sites es
            join app.employees e on e.id = es.employee_id where es.site_id = ${s.id} and e.status = 'aktiv' order by 2`,
        listTasks(sql, { status: 'open', entity: { type: 'site', id: s.id } }),
      ]);
      return (
        <SiteOverview
          s={s}
          customer={customer!}
          services={services}
          employees={employees}
          tasksSlot={<TaskBox tasks={tasks} doneLink={`/objekte/${s.id}/aufgaben?status=done`} />}
        />
      );
    }),
  );

  app.get(`/objekte/:id{${UUID}}/rechnungsangaben`, (c) =>
    sitePage(c, 'rechnungsangaben', async (s) => {
      const [site] = await sql<(Site & SiteBilling)[]>`select * from app.sites where id = ${s.id}`;
      const customer = (await getCustomer(sql, s.customer_id))!;
      return <SiteBillingForm site={site!} customer={customer} eff={resolveBilling(customer, site)} />;
    }),
  );

  app.post(`/objekte/:id{${UUID}}/rechnungsangaben`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody();
    const parsed = siteBillingInput.safeParse(body);
    if (!parsed.success)
      return back(c, `/objekte/${id}/rechnungsangaben`, {
        fehler: parsed.error.issues.map((i) => i.message).join('\n'),
      });
    try {
      await saveSiteBilling(sql, id, parsed.data, c.get('actor'), versionOf(body.version));
    } catch (e) {
      if (e instanceof BusinessError)
        return back(c, `/objekte/${id}/rechnungsangaben`, { fehler: e.message });
      throw e;
    }
    return back(c, `/objekte/${id}/rechnungsangaben`, { ok: 'Rechnungsangaben gespeichert.' });
  });

  app.get(`/objekte/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const s = await getSite(sql, id);
    const customers = await listCustomers(sql);
    const kunde = c.req.query('kunde') ?? '';
    const form = (
      <SiteForm
        id={id}
        s={s ?? { customer_id: kunde, site_no: (kunde && (await suggestSiteNo(sql, kunde))) || '' }}
        customers={customers}
        isNew={!s}
        managers={await managers(sql)}
      />
    );
    if (!s) {
      return page(
        c,
        'Neues Objekt',
        'kunden',
        <>
          <PageHead title="Neues Objekt" />
          <div class="card">{form}</div>
        </>,
      );
    }
    return sitePage(c, 'bearbeiten', () => form);
  });

  app.post(`/objekte/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody();
    const parsed = siteInput.safeParse(body);
    if (!parsed.success) throw new BusinessError(parsed.error.issues.map((i) => i.message).join('\n'));
    try {
      await saveSite(sql, id, parsed.data, c.get('actor'), versionOf(body.version));
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        throw new BusinessError('Objektnummer ist bereits vergeben');
      throw err;
    }
    return back(c, `/objekte/${id}`, { ok: 'Objekt gespeichert.' });
  });

  app.get(`/objekte/:id{${UUID}}/leistungen`, (c) =>
    sitePage(c, 'leistungen', async (s) => {
      const today = todayBerlin();
      const qm = c.req.query('monat');
      const month = qm && /^\d{4}-\d{2}$/.test(qm) ? qm : today.slice(0, 7);
      const qd = c.req.query('datum');
      const monthEnd = monthBounds(month).end;
      const invoiceDate = qd && /^\d{4}-\d{2}-\d{2}$/.test(qd) ? qd : monthEnd <= today ? monthEnd : '';
      const [services, preview, [grp]] = await Promise.all([
        listServices(sql, s.id),
        billingPreview(sql, s.id, month),
        sql<
          { name: string }[]
        >`select g.name from app.sites x join app.invoice_groups g on g.id = x.invoice_group_id
                                where x.id = ${s.id} and g.active`,
      ]);
      return (
        <ServicesPanel
          siteId={s.id}
          services={services}
          newServiceId={randomUUID()}
          siteGroup={grp?.name ?? null}
          month={month}
          invoiceDate={invoiceDate}
          preview={preview}
        />
      );
    }),
  );

  app.get(`/objekte/:id{${UUID}}/leistungen/:sid{${UUID}}`, (c) =>
    sitePage(c, 'leistungen', async (s) => {
      const sv = (await getService(sql, c.req.param('sid'))) ?? null;
      if (sv && sv.site_id !== s.id) throw new BusinessError('Leistung gehört zu einem anderen Objekt');
      const [types, groups] = await Promise.all([
        listServiceTypes(sql),
        listInvoiceGroups(sql, s.customer_id),
      ]);
      return (
        <ServiceForm
          siteId={s.id}
          id={c.req.param('sid')}
          sv={sv}
          types={types}
          groups={groups}
          today={todayBerlin()}
        />
      );
    }),
  );

  app.post(`/objekte/:id{${UUID}}/abrechnen`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const month = String(b.monat ?? '');
    if (!/^\d{4}-\d{2}$/.test(month)) throw new BusinessError('Abrechnungsmonat ungültig');
    const date = typeof b.datum === 'string' && b.datum ? b.datum : null;
    const r = await runMonthly(sql, month, c.get('actor'), { siteIds: [id], invoiceDate: date });
    if (r.created.length === 1) {
      return back(c, `/rechnungen/${r.created[0]!.invoiceId}`, { ok: 'Rechnungsentwurf erstellt.' });
    }
    return back(c, `/objekte/${id}/leistungen?monat=${month}`, {
      ok: r.created.length ? `${r.created.length} Rechnungsentwürfe erstellt.` : 'Nichts mehr abzurechnen.',
    });
  });

  // Leistungsarten (Stammliste)
  app.get('/einstellungen/leistungsarten', async (c) => {
    const types = await listServiceTypes(sql, true);
    return page(
      c,
      'Leistungsarten',
      'rechnungen',
      <>
        <PageHead title="Leistungsarten" />
        <p class="mut" style="max-width:780px">
          Leistungsarten ordnen die Leistungen an den Objekten (Auswertung, Nachkalkulation). Der
          Lohnkostenanteil ist die Vorgabe, wenn an der Leistung nichts eingetragen ist.
        </p>
        <div class="tbl" style="max-width:780px">
          <table>
            <thead>
              <tr>
                <th>Leistungsart</th>
                <th class="r">Lohnkostenanteil %</th>
                <th>aktiv</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {[...types, null].map((t) => {
                const tid = t?.id ?? randomUUID();
                const f = `st-${tid.slice(0, 8)}`;
                return (
                  <tr>
                    <td>
                      <form id={f} method="post" action={`/einstellungen/leistungsarten/${tid}`}></form>
                      <input type="hidden" form={f} name="version" value={String(t?.version ?? '')} />
                      <input
                        form={f}
                        name="name"
                        value={t?.name ?? ''}
                        placeholder="neue Leistungsart"
                        aria-label="Leistungsart"
                      />
                    </td>
                    <td style="width:150px">
                      <input
                        form={f}
                        name="labor_share"
                        class="right"
                        value={
                          t?.labor_share_bp != null ? String(t.labor_share_bp / 100).replace('.', ',') : ''
                        }
                        aria-label="Lohnkostenanteil"
                      />
                    </td>
                    <td style="width:70px">
                      <input
                        type="checkbox"
                        form={f}
                        name="active"
                        checked={t ? t.active : true}
                        aria-label="aktiv"
                      />
                    </td>
                    <td style="width:110px">
                      <button class="btn sm sec" form={f}>
                        {t ? 'Speichern' : 'Anlegen'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>,
    );
  });

  app.post(`/einstellungen/leistungsarten/:tid{${UUID}}`, async (c) => {
    const b = await c.req.parseBody();
    const ls =
      typeof b.labor_share === 'string' && b.labor_share.trim()
        ? Number(b.labor_share.replace(',', '.'))
        : null;
    if (ls != null && (!Number.isFinite(ls) || ls < 0 || ls > 100))
      throw new BusinessError('Lohnkostenanteil bitte in % (0–100)');
    await saveServiceType(sql, c.req.param('tid'), {
      name: String(b.name ?? ''),
      laborShareBp: ls == null ? null : Math.round(ls * 100),
      active: b.active === 'on',
      expectedVersion: typeof b.version === 'string' && b.version ? Number(b.version) : null,
    });
    return back(c, '/einstellungen/leistungsarten', { ok: 'Gespeichert.' });
  });

  app.post(`/objekte/:id{${UUID}}/leistungen/:sid{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const parsed = serviceInput.safeParse(await c.req.parseBody());
    if (!parsed.success) throw new BusinessError(parsed.error.issues.map((i) => i.message).join('\n'));
    await saveService(sql, c.req.param('sid'), id, parsed.data, c.get('actor'));
    return back(c, `/objekte/${id}/leistungen`, { ok: 'Leistung gespeichert.' });
  });

  app.post(`/leistungen/:sid{${UUID}}/aktiv`, async (c) => {
    const body = await c.req.parseBody();
    await setServiceActive(sql, c.req.param('sid'), body.active === 'true', c.get('actor'));
    return back(c, `/objekte/${String(body.site_id)}/leistungen`, { ok: 'Leistung aktualisiert.' });
  });

  notesRoutes('/objekte', 'site', sitePage as unknown as typeof customerPage);
  tasksRoute('/objekte', 'site', sitePage as unknown as typeof customerPage, (s: { name: string }) => s.name);

  app.get(`/objekte/:id{${UUID}}/rechnungen`, (c) =>
    sitePage(c, 'rechnungen', async (s) => (
      <>
        <div class="actions" style="margin-top:0">
          <a class="btn sm" href={`/neu?typ=rechnung&kunde=${s.customer_id}&objekt=${s.id}`}>
            + Rechnung für dieses Objekt
          </a>
        </div>
        <InvoiceTable rows={(await listInvoices(sql)).filter((i) => i.site_id === s.id)} />
      </>
    )),
  );
}
