import { followups } from '../services/prospects.js';
import { canAccess } from './permissions.js';
import { ReportTabs } from './routes-reports.js';
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import { listTasks, saveTask, setTaskDone, taskInput } from '../services/crm.js';
import {
  type Employee,
  employeeInput,
  allTags,
  effectiveWage,
  exportEmployeesCsv,
  getEmployee,
  hrReminders,
  listEmployees,
  listTemplates,
  listWageLevels,
  saveEmployee,
  suggestPersonnelNo,
} from '../services/employees.js';
import { sollPlanIst } from '../services/hr-month.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { MonthBox } from './pages-hr.js';
import { BusinessError } from '../services/errors.js';
import { assigneeOptions } from '../services/crm.js';
import { listInvoices } from '../services/invoices.js';
import { listBalances, openItemLedger } from '../services/payments.js';
import { upcomingEvents } from '../services/tenders.js';
import { proposals } from '../services/dunning.js';
import { listArticles, listDevices, supplierWarnings } from '../services/inventory.js';
import { search } from '../services/search.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { NEW_OPTIONS, PageHead, dateDe, euro } from './layout.js';
import { homeFor } from './permissions.js';
import {
  Dashboard,
  type DashboardTodo,
  PlannedPage,
  PLANNED,
  SearchResults,
  TaskBox,
  TaskForm,
} from './pages-crm.js';
import { EmployeeForm, EmployeeList, EmployeeOverview, EmployeeShell } from './pages-hr-finance.js';
import { RevenueBars } from './pages-masterdata.js';
import { lastMonth } from './routes-invoices.js';
import { registerNoteRoutes } from './routes-notes.js';
import { revenueByMonth } from './routes-masterdata.js';

const uuidOr = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) ? v : randomUUID());

export function registerModuleRoutes(ctx: Ctx) {
  const { app, deps, page, back, shells } = ctx;
  const { sql } = deps;

  // ------------------------------------------------------------------ Übersicht

  app.get('/', async (c) => {
    const role = c.get('user').role;
    if (role !== 'admin' && role !== 'buchhaltung') return c.redirect(homeFor(role));
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
    const [reorder, suppliers, devices, dun, unsentDunnings] = await Promise.all([
      listArticles(sql, { reorder: true }),
      supplierWarnings(sql),
      listDevices(sql),
      proposals(sql),
      sql<{ n: number }[]>`select count(*)::int as n from app.dunnings where status = 'erstellt'`,
    ]);
    const todo: DashboardTodo = {
      deadlines: (await upcomingEvents(sql, 14)).map((e) => ({
        id: e.tender_id,
        title: e.title,
        kind: e.kind,
        authority: e.authority,
        at: e.at,
        days_left: e.days,
        required: e.required,
      })),
      reorder,
      followups: canAccess(c.get('user').role, '/akquise') ? await followups(sql) : { due: [], week: [] },
      suppliers,
      devices: devices.filter((d) => d.active && d.days !== null && d.days <= 30),
      proposals: dun.proposals.length,
      unsentDunnings: unsentDunnings[0]!.n,
    };
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
        todo={todo}
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
      case 'angebot':
        // ohne Kunde: erst Kunde suchen (wie Fortytools), dann Angebot oder Ausschreibung
        return c.redirect(
          kunde ? `/angebote/${randomUUID()}/bearbeiten${qs({ kunde, objekt })}` : '/angebote/neu',
        );
      case 'kunde':
        return c.redirect(`/kunden/${randomUUID()}/bearbeiten`);
      case 'interessent':
        return c.redirect(`/kunden/${randomUUID()}/bearbeiten?interessent=1`);
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
          <TaskForm newId={randomUUID()} back="/aufgaben" users={await assigneeOptions(sql)} />
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
    const q = c.req.query('q') ?? '';
    const overdueOnly = c.req.query('filter') === 'ueberfaellig';
    const groups = await openItemLedger(sql, { q, overdueOnly });
    const all = await openItemLedger(sql);
    const total = all.reduce((a, g) => a + g.open_cents, 0n);
    const overdue = all.flatMap((g) => g.items).filter((i) => i.overdue_days > 0);
    return page(
      c,
      'Offene Posten',
      'rechnungen',
      <>
        <PageHead title="Offene Posten" />
        <div class="kpis">
          <div class="kpi">
            <div class="l">offen gesamt</div>
            <div class="v">{euro(total)}</div>
            <div class="s">
              {all.length} Kunden · {all.reduce((a, g) => a + g.items.length, 0)} Rechnungen
            </div>
          </div>
          <a class="kpi" href="/offene-posten?filter=ueberfaellig" style="text-decoration:none">
            <div class="l">davon überfällig</div>
            <div class="v" style="color:var(--err)">
              {euro(overdue.reduce((a, i) => a + i.open_cents, 0n))}
            </div>
            <div class="s">{overdue.length} Rechnungen</div>
          </a>
        </div>
        <form method="get" class="actions">
          <div class="chips" style="margin:0">
            <a
              href={`/offene-posten${q ? `?q=${encodeURIComponent(q)}` : ''}`}
              class={overdueOnly ? '' : 'on'}
            >
              Alle
            </a>
            <a
              href={`/offene-posten?filter=ueberfaellig${q ? `&q=${encodeURIComponent(q)}` : ''}`}
              class={overdueOnly ? 'on' : ''}
            >
              Überfällig
            </a>
          </div>
          {overdueOnly && <input type="hidden" name="filter" value="ueberfaellig" />}
          <input name="q" value={q} placeholder="Kunde, Kd.-Nr., Rechnungsnr." style="max-width:280px" />
          <button class="btn sec sm">Suchen</button>
        </form>
        <form method="post" action="/mahnungen/stapel" id="op-form">
          {groups.map((g) => (
            <div class="card op">
              <div class="op-head">
                <span class="no">{g.customer_no}</span>
                <a href={`/kunden/${g.customer_id}`} class="nm">
                  {g.customer_name}
                </a>
                <span class="sum">{euro(g.open_cents)}</span>
                <input
                  type="checkbox"
                  aria-label={`alle von ${g.customer_name}`}
                  onchange={`document.querySelectorAll('input[name=inv_${g.customer_id}]').forEach(function(x){x.checked=this.checked}.bind(this))`}
                />
              </div>
              <div class="op-cols">
                <span />
                <span>Soll</span>
                <span>Haben</span>
              </div>
              {g.items.map((i) => {
                const haben = i.haben.reduce((a, h) => a + h.cents, 0n);
                return (
                  <div class="op-item">
                    <div class="op-row">
                      <span>
                        <a href={`/rechnungen/${i.invoice_id}`}>
                          <b>{i.number}</b>
                        </a>{' '}
                        <span class="mut">{dateDe(i.issue_date)}</span>
                        {i.site_name && <span class="small faint"> · {i.site_name}</span>}
                      </span>
                      <span class="r">{euro(i.payable_cents)}</span>
                      <span />
                    </div>
                    {i.haben.map((h) => (
                      <div class="op-row small">
                        <span class="mut" style="padding-left:16px">
                          {dateDe(h.date)} · {h.href ? <a href={h.href}>{h.label}</a> : h.label}
                        </span>
                        <span />
                        <span class="r">{euro(h.cents)}</span>
                      </div>
                    ))}
                    <div class="op-row op-sumline">
                      <span />
                      <span class="r">{euro(i.payable_cents)}</span>
                      <span class="r">{euro(haben)}</span>
                    </div>
                    <div class="op-saldo">
                      <span class="small">
                        fällig {dateDe(i.due_date)}
                        {i.overdue_days > 0 && (
                          <span class="badge err" style="margin-left:6px">
                            {i.overdue_days} T. überfällig
                          </span>
                        )}
                        {i.skonto_date && i.skonto_date >= todayBerlin() && (
                          <span class="badge ok" style="margin-left:6px">
                            Skonto bis {dateDe(i.skonto_date)}
                          </span>
                        )}
                      </span>
                      <span class="lbl">Saldo</span>
                      <b>{euro(i.open_cents)}</b>
                      <input
                        type="checkbox"
                        name={`inv_${g.customer_id}`}
                        value={i.invoice_id}
                        aria-label={`${i.number} auswählen`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          {!groups.length && <div class="card empty">Keine offenen Posten.</div>}
          {groups.length > 0 && (
            <div class="card actions op-bar">
              <span class="small mut">Ausgewählte Rechnungen:</span>
              <button
                class="btn"
                onclick="return confirm('Für die ausgewählten Rechnungen je Kunde eine Mahnung erstellen? (Regeln: Stufe, Mindestabstand, Mahnsperre werden geprüft)')"
              >
                Mahnung erstellen
              </button>
              <label class="chk" style="margin:0">
                <input type="checkbox" name="send" value="1" /> gleich per E-Mail senden
              </label>
              <span class="small faint hint-desk" style="margin-left:auto">
                Zahlung buchen: Rechnung öffnen → „Zahlungen“ · Bankabgleich unter Transfer → Kontoumsätze
              </span>
            </div>
          )}
        </form>
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
        <PageHead title="Netto-Umsatz je Monat" crumbs={[['Auswertungen', '/auswertungen']]} />
        <ReportTabs c={c} active="umsatz" />
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
    const tag = c.req.query('tag')?.trim() || null;
    const [rows, tags, templates] = await Promise.all([
      listEmployees(sql, {
        ...(status === 'aktiv' || status === 'ausgetreten' ? { status } : {}),
        ...(q ? { q } : {}),
        ...(tag ? { tag } : {}),
      }),
      allTags(sql),
      listTemplates(sql),
    ]);
    return page(
      c,
      'Mitarbeiter',
      'personal',
      <EmployeeList
        rows={rows}
        status={status}
        q={q}
        tag={tag}
        tags={tags}
        templates={templates}
        canExport
      />,
    );
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

  shells.employee = employeePage as NonNullable<Ctx['shells']['employee']>;

  /** Soll/Plan/Ist: Vormonat, aktueller Monat, Folgemonat (wie Fortytools). */
  const monthBox = async (employeeId: string) => {
    const cur = todayBerlin().slice(0, 7);
    const shift = (n: number) => {
      const i = Number(cur.slice(0, 4)) * 12 + Number(cur.slice(5, 7)) - 1 + n;
      return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
    };
    const rows = await Promise.all([-1, 0, 1].map((n) => sollPlanIst(sql, employeeId, shift(n))));
    return <MonthBox employeeId={employeeId} rows={rows} current={cur} />;
  };

  app.get(`/personal/:id{${UUID}}`, (c) =>
    employeePage(c, 'uebersicht', async (e) => {
      const data = (await getEmployee(sql, e.id))!;
      const [wage, [lvl]] = await Promise.all([
        effectiveWage(sql, e.id),
        sql<{ name: string }[]>`select name from app.wage_levels where id = ${e.wage_level_id}`,
      ]);
      return (
        <EmployeeOverview
          e={e}
          priv={data.priv}
          sites={data.sites}
          showPrivate
          wage={{ level: lvl?.name ?? null, cents: wage }}
          month={await monthBox(e.id)}
        />
      );
    }),
  );

  app.get(`/personal/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const data = await getEmployee(sql, id);
    const wageLevels = await listWageLevels(sql);
    const form = (
      <EmployeeForm
        wageLevels={wageLevels}
        id={id}
        e={data?.employee ?? { personnel_no: await suggestPersonnelNo(sql), employment_type: 'teilzeit' }}
        priv={data?.priv ?? {}}
        isNew={!data}
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
    // Objekt-Zuordnung nicht mehr im Stammdatenformular (Ahmed 06.10.) – entsteht über Planung/Einsätze
    return back(c, `/personal/${id}`, { ok: 'Mitarbeiter gespeichert.' });
  });

  registerNoteRoutes(ctx, '/personal', 'employee', employeePage);

  app.get(`/personal/:id{${UUID}}/aufgaben`, (c) =>
    employeePage(c, 'aufgaben', async (e) => (
      <>
        <TaskBox tasks={await listTasks(sql, { status: 'open', entity: { type: 'employee', id: e.id } })} />
        <TaskForm
          newId={randomUUID()}
          entity={{ type: 'employee', id: e.id, label: `${e.first_name} ${e.last_name}` }}
          back={`/personal/${e.id}/aufgaben`}
          users={await assigneeOptions(sql)}
          title={c.req.query('titel')}
        />
      </>
    )),
  );
}
