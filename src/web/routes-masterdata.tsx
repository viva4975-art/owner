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
import { listInvoices } from '../services/invoices.js';
import {
  type Customer,
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
import { listDunnings } from '../services/dunning.js';
import { listOffers } from '../services/offers.js';
import { listOpenItems } from '../services/payments.js';
import { listFiles } from '../services/uploads.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { FileArea } from './files.js';
import { PageHead, dateDe, euro } from './layout.js';
import { OfferTable } from './pages-offers.js';
import { ContactsPanel, NotesPanel, TaskBox, TaskForm } from './pages-crm.js';
import { OpenItemsTable } from './pages-hr-finance.js';
import { InvoiceTable } from './pages-invoices.js';
import {
  type CustomerCounts,
  CustomerCard,
  CustomerForm,
  CustomerList,
  CustomerShell,
  RevenueBars,
  ServicesPanel,
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

export function registerMasterdataRoutes({ app, deps, page, back, shells }: Ctx) {
  const { sql } = deps;

  // ------------------------------------------------------------------ Kunden

  app.get('/kunden', async (c) => {
    const letter = c.req.query('buchstabe')?.toUpperCase() ?? null;
    const q = c.req.query('q')?.trim() || null;
    const open = await sql<{ customer_id: string; open_cents: bigint }[]>`
      select customer_id, sum(open_cents)::bigint as open_cents from app.open_items where open_cents <> 0 group by 1`;
    const openBy = new Map(open.map((o) => [o.customer_id, o.open_cents]));
    let customers = (await listCustomers(sql)).map((x) => ({ ...x, open_cents: openBy.get(x.id) ?? 0n }));
    if (letter) customers = customers.filter((x) => x.name.toUpperCase().startsWith(letter));
    if (q) {
      const t = q.toLowerCase();
      customers = customers.filter((x) => `${x.name} ${x.customer_no} ${x.city}`.toLowerCase().includes(t));
    }
    return page(c, 'Kunden', 'kunden', <CustomerList customers={customers} letter={letter} q={q} />);
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

  app.get('/objekte', async (c) =>
    page(
      c,
      'Objekte',
      'kunden',
      <>
        <PageHead
          title="Objekte"
          create={{
            options: [
              ['objekt', 'Objekt'],
              ['kunde', 'Kunde'],
            ],
            selected: 'objekt',
          }}
        />
        <div class="card">
          <SiteTable sites={await listSites(sql)} showCustomer />
        </div>
      </>,
    ),
  );

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
    sitePage(c, 'leistungen', async (s) => (
      <ServicesPanel siteId={s.id} services={await listServices(sql, s.id)} newServiceId={randomUUID()} />
    )),
  );

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
