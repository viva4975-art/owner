import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { addNote, listNotes, listTasks, saveTask, setTaskDone, taskInput } from '../services/crm.js';
import {
  type Employee,
  employeeInput,
  exportEmployeesCsv,
  getEmployee,
  hrReminders,
  listEmployees,
  saveEmployee,
  setEmployeeSites,
  suggestPersonnelNo,
} from '../services/employees.js';
import { BusinessError } from '../services/errors.js';
import { listInvoices } from '../services/invoices.js';
import { listSites } from '../services/masterdata.js';
import { listBalances, listOpenItems } from '../services/payments.js';
import { search } from '../services/search.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { NEW_OPTIONS, PageHead } from './layout.js';
import {
  Dashboard,
  NotesPanel,
  PlannedPage,
  PLANNED,
  SearchResults,
  TaskBox,
  TaskForm,
} from './pages-crm.js';
import {
  EmployeeForm,
  EmployeeList,
  EmployeeOverview,
  EmployeeShell,
  OpenItemsTable,
} from './pages-hr-finance.js';
import { RevenueBars } from './pages-masterdata.js';
import { lastMonth } from './routes-invoices.js';
import { revenueByMonth } from './routes-masterdata.js';

const uuidOr = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) ? v : randomUUID());

export function registerModuleRoutes({ app, deps, page, back }: Ctx) {
  const { sql } = deps;

  // ------------------------------------------------------------------ Übersicht

  app.get('/', async (c) => {
    const [tasks, drafts, balances, unsent, hr] = await Promise.all([
      listTasks(sql, { status: 'open', withinDays: 7 }),
      listInvoices(sql, { status: 'draft' }),
      listBalances(sql),
      sql<{ invoices: number; corrections: number }[]>`
        select count(*) filter (where kind in ('invoice', 'partial', 'final'))::int as invoices,
               count(*) filter (where kind in ('cancellation', 'correction'))::int as corrections
          from app.invoices i where status = 'issued'
           and not exists (select 1 from app.invoice_deliveries d where d.invoice_id = i.id and d.status = 'sent')`,
      hrReminders(sql),
    ]);
    return page(
      c,
      'Übersicht',
      'home',
      <Dashboard
        user={c.get('actor').charAt(0).toUpperCase() + c.get('actor').slice(1)}
        tasks={tasks}
        drafts={drafts}
        balances={balances}
        unsent={unsent[0]!}
        hr={hr}
        month={lastMonth()}
      />,
    );
  });

  // ------------------------------------------------------------------ Neu anlegen (wie Fortytools „Neu anlegen: … Los“)

  app.get('/neu', (c) => {
    const typ = c.req.query('typ');
    const kunde = c.req.query('kunde');
    const objekt = c.req.query('objekt');
    const qs = (o: Record<string, string | undefined>) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
      const s = p.toString();
      return s ? `?${s}` : '';
    };
    switch (typ) {
      case 'rechnung':
        return c.redirect(`/rechnungen/${randomUUID()}/bearbeiten${qs({ kunde, objekt })}`);
      case 'kunde':
        return c.redirect(`/kunden/${randomUUID()}/bearbeiten`);
      case 'objekt':
        return c.redirect(`/objekte/${randomUUID()}/bearbeiten${qs({ kunde })}`);
      case 'mitarbeiter':
        return c.redirect(`/personal/${randomUUID()}/bearbeiten`);
      case 'kontakt':
        return c.redirect(kunde ? `/kunden/${kunde}/kontakte` : '/kunden');
      case 'aufgabe': {
        const m = c.req.query('mitarbeiter');
        if (objekt) return c.redirect(`/objekte/${objekt}/aufgaben`);
        if (kunde) return c.redirect(`/kunden/${kunde}/aufgaben`);
        if (m) return c.redirect(`/personal/${m}/aufgaben`);
        return c.redirect('/aufgaben');
      }
      default:
        return c.redirect('/');
    }
  });

  // ------------------------------------------------------------------ Suche

  app.get('/suche', async (c) => {
    const q = c.req.query('q') ?? '';
    const hits = await search(sql, q);
    if (hits.length === 1) return c.redirect(hits[0]!.href);
    return page(c, 'Suche', '', <SearchResults q={q} hits={hits} />);
  });

  // ------------------------------------------------------------------ Geplante Bereiche

  app.get('/geplant/:key', (c) => {
    const key = c.req.param('key');
    return page(c, PLANNED[key]?.title ?? 'Geplant', '', <PlannedPage key2={key} />);
  });

  // ------------------------------------------------------------------ Aufgaben

  app.get('/aufgaben', async (c) => {
    const status = c.req.query('status') === 'done' ? 'done' : 'open';
    return page(
      c,
      'Aufgaben',
      'kunden',
      <>
        <PageHead title="Aufgaben" create={{ options: NEW_OPTIONS, selected: 'aufgabe' }} />
        <div class="cols">
          <div class="card">
            <TaskBox
              tasks={await listTasks(sql, { status })}
              title={status === 'done' ? 'Erledigte Aufgaben' : 'Offene Aufgaben'}
              doneLink="/aufgaben?status=done"
            />
            {status === 'done' && <a href="/aufgaben">← offene Aufgaben</a>}
          </div>
          <TaskForm newId={randomUUID()} back="/aufgaben" />
        </div>
      </>,
    );
  });

  app.post('/aufgaben', async (c) => {
    const body = await c.req.parseBody();
    const parsed = taskInput.safeParse(body);
    if (!parsed.success) throw new BusinessError(parsed.error.issues.map((i) => i.message).join('\n'));
    await saveTask(sql, uuidOr(body.id), parsed.data, c.get('actor'));
    const target = typeof body.back === 'string' && body.back.startsWith('/') ? body.back : '/aufgaben';
    return back(c, target, { ok: 'Aufgabe angelegt.' });
  });

  app.post(`/aufgaben/:id{${UUID}}/erledigt`, async (c) => {
    const body = await c.req.parseBody();
    await setTaskDone(sql, c.req.param('id'), body.done === '1', c.get('actor'));
    const ref = c.req.header('referer');
    const target = ref ? new URL(ref).pathname + new URL(ref).search : '/aufgaben';
    return back(c, target, { ok: body.done === '1' ? 'Aufgabe erledigt.' : 'Aufgabe wieder geöffnet.' });
  });

  // ------------------------------------------------------------------ Offene Posten

  app.get('/offene-posten', async (c) => {
    const items = await listOpenItems(sql);
    return page(
      c,
      'Offene Posten',
      'rechnungen',
      <>
        <PageHead title="Offene Posten" />
        <div class="card">
          <p class="mut small" style="margin-top:0">
            Rechnung abzüglich Storno/Korrektur und gebuchter Zahlungen. Zahlungseingänge bucht man in der
            jeweiligen Rechnung unter „Zahlungen“.
          </p>
          <OpenItemsTable items={items} showCustomer />
        </div>
      </>,
    );
  });

  // ------------------------------------------------------------------ Auswertungen

  app.get('/auswertungen/umsatz', async (c) =>
    page(
      c,
      'Netto-Umsatz',
      'auswertungen',
      <>
        <PageHead title="Netto-Umsatz je Monat" />
        <div class="card">
          <p class="mut small" style="margin-top:0">
            Nach Rechnungsdatum, alle ausgestellten Belege (Stornos mindern den Umsatz).
          </p>
          <RevenueBars rows={await revenueByMonth(sql)} />
        </div>
      </>,
    ),
  );

  // ------------------------------------------------------------------ Personal

  app.get('/personal', async (c) => {
    const status = c.req.query('status') ?? 'aktiv';
    const q = c.req.query('q')?.trim() || null;
    const rows = await listEmployees(sql, {
      ...(status === 'aktiv' || status === 'ausgetreten' ? { status } : {}),
      ...(q ? { q } : {}),
    });
    return page(c, 'Mitarbeiter', 'personal', <EmployeeList rows={rows} status={status} q={q} canExport />);
  });

  app.get('/personal/export.csv', async (c) => {
    const csv = await exportEmployeesCsv(sql);
    await sql`insert into app.audit_log (actor, action, entity, details)
              values (${c.get('actor')}, 'export', 'employees', ${sql.json({ format: 'lexware-csv' })})`;
    return c.body(csv, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="mitarbeiter-lexware-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    });
  });

  const employeePage = async (
    c: Context<AppEnv>,
    active: string,
    body: (e: Employee) => Promise<Child> | Child,
  ) => {
    const id = c.req.param('id')!;
    const data = await getEmployee(sql, id);
    if (!data) return c.redirect(`/personal/${id}/bearbeiten`);
    const [cnt] = await sql<{ notes: number; tasks: number }[]>`
      select (select count(*)::int from app.notes where entity_type = 'employee' and entity_id = ${id}) as notes,
             (select count(*)::int from app.tasks where entity_type = 'employee' and entity_id = ${id} and status = 'open') as tasks`;
    return page(
      c,
      `${data.employee.first_name} ${data.employee.last_name}`,
      'personal',
      <EmployeeShell e={data.employee} active={active} notes={cnt!.notes} tasks={cnt!.tasks}>
        {await body(data.employee)}
      </EmployeeShell>,
    );
  };

  app.get(`/personal/:id{${UUID}}`, (c) =>
    employeePage(c, 'uebersicht', async (e) => {
      const data = (await getEmployee(sql, e.id))!;
      return <EmployeeOverview e={e} priv={data.priv} sites={data.sites} showPrivate />;
    }),
  );

  app.get(`/personal/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const data = await getEmployee(sql, id);
    const sites = await listSites(sql);
    const form = (
      <EmployeeForm
        id={id}
        e={data?.employee ?? { personnel_no: await suggestPersonnelNo(sql), employment_type: 'teilzeit' }}
        priv={data?.priv ?? {}}
        isNew={!data}
        sites={sites.filter((s) => s.active)}
        selectedSites={(data?.sites ?? []).map((s) => s.id)}
      />
    );
    if (!data) {
      return page(
        c,
        'Neuer Mitarbeiter',
        'personal',
        <>
          <PageHead title="Neuer Mitarbeiter" />
          <div class="card">{form}</div>
        </>,
      );
    }
    return employeePage(c, 'bearbeiten', () => form);
  });

  app.post(`/personal/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody({ all: true });
    const flat = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
    const parsed = employeeInput.safeParse(flat);
    if (!parsed.success) throw new BusinessError(parsed.error.issues.map((i) => i.message).join('\n'));
    await saveEmployee(sql, id, parsed.data, c.get('actor'));
    const sites = body.sites;
    await setEmployeeSites(sql, id, (Array.isArray(sites) ? sites : sites ? [sites] : []).map(String));
    return back(c, `/personal/${id}`, { ok: 'Mitarbeiter gespeichert.' });
  });

  app.get(`/personal/:id{${UUID}}/notizen`, (c) =>
    employeePage(c, 'notizen', async (e) => (
      <NotesPanel
        action={`/personal/${e.id}/notizen`}
        notes={await listNotes(sql, 'employee', e.id)}
        newId={randomUUID()}
      />
    )),
  );

  app.post(`/personal/:id{${UUID}}/notizen`, async (c) => {
    const body = await c.req.parseBody();
    await addNote(
      sql,
      uuidOr(body.id),
      'employee',
      c.req.param('id'),
      String(body.body ?? ''),
      c.get('actor'),
    );
    return back(c, `/personal/${c.req.param('id')}/notizen`, { ok: 'Notiz gespeichert.' });
  });

  app.get(`/personal/:id{${UUID}}/aufgaben`, (c) =>
    employeePage(c, 'aufgaben', async (e) => (
      <>
        <TaskBox tasks={await listTasks(sql, { status: 'open', entity: { type: 'employee', id: e.id } })} />
        <TaskForm
          newId={randomUUID()}
          entity={{ type: 'employee', id: e.id, label: `${e.first_name} ${e.last_name}` }}
          back={`/personal/${e.id}/aufgaben`}
        />
      </>
    )),
  );
}
