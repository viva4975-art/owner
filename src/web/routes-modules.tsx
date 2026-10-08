import { siteCosting } from '../services/costing.js';
import { collectReminders } from '../services/reminders.js';
import { fullName } from '../services/users.js';
import { missingDocs } from '../services/hr-required-docs.js';
import { hoursHistory } from '../services/employee-hours.js';
import { absentBetween } from '../services/absences.js';
import { OpenLegacyCard } from './routes-legacy-invoices.js';
import { openLegacyInvoices } from '../services/fortytools-xml-import.js';
import { followups } from '../services/prospects.js';
import { canAccess } from './permissions.js';
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
  countWithoutShift,
  listTemplates,
  listWageLevels,
  employmentHistory,
  exitEmployee,
  reenterEmployee,
  revokeExit,
  saveEmployee,
  suggestPersonnelNo,
} from '../services/employees.js';
import { sollPlanIst } from '../services/hr-month.js';
import { addDays, todayBerlin } from '../domain/invoice/calc.js';
import { MonthBox } from './pages-hr.js';
import { BusinessError } from '../services/errors.js';
import { parseEuro } from '../domain/money/money.js';
import { assigneeOptions } from '../services/crm.js';
import { listInvoices } from '../services/invoices.js';
import { listBalances, openItemLedger, settleOpenItem } from '../services/payments.js';
import { upcomingEvents } from '../services/tenders.js';
import { proposals } from '../services/dunning.js';
import { listArticles, listDevices, supplierWarnings } from '../services/inventory.js';
import { SEARCH_TYPES, type SearchType, search } from '../services/search.js';
import { type AppEnv, type Ctx, UUID } from './app.js';
import { NEW_OPTIONS, PageHead, dateDe, euro } from './layout.js';
import { homeFor } from './permissions.js';
import {
  DASH_CARDS,
  type DashCardKey,
  Dashboard,
  normalizeDash,
  type DashboardTodo,
  PlannedPage,
  PLANNED,
  SearchResults,
  TaskBox,
  TaskForm,
} from './pages-crm.js';
import { EmployeeForm, EmployeeList, EmployeeOverview, EmployeeShell } from './pages-hr-finance.js';
import { lastMonth } from './routes-invoices.js';
import { registerNoteRoutes } from './routes-notes.js';

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
    const today = todayBerlin();
    const mStart = `${today.slice(0, 7)}-01`;
    const pd = new Date(`${mStart}T00:00:00Z`);
    pd.setUTCMonth(pd.getUTCMonth() - 1);
    const pStart = pd.toISOString().slice(0, 10);
    const [rev] = await sql<{ cur: bigint; prev: bigint }[]>`
      select coalesce(sum(net_cents) filter (where issue_date >= ${mStart}::date), 0)::bigint as cur,
             coalesce(sum(net_cents) filter (where issue_date >= ${pStart}::date and issue_date < ${mStart}::date
               and extract(day from issue_date) <= extract(day from ${today}::date)), 0)::bigint as prev
        from app.invoices where status = 'issued' and issue_date >= ${pStart}::date`;
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
    const kpi = {
      monthNet: rev!.cur,
      prevNet: rev!.prev,
      monthLabel: MONTHS[Number(today.slice(5, 7)) - 1]!,
      today,
    };
    const [absent, signOverdue] = await Promise.all([
      absentBetween(sql, todayBerlin(), addDays(todayBerlin(), 14), null),
      sql<{ id: string; title: string; open: number }[]>`
        select d.id, d.title, count(*)::int as open from app.sign_documents d
          join app.sign_requests r on r.document_id = d.id and r.status = 'offen'
         where d.due_date is not null and d.due_date < ${todayBerlin()}
         group by d.id, d.title order by d.title`,
    ]);
    return page(
      c,
      'Übersicht',
      'home',
      <Dashboard
        layout={normalizeDash(
          (
            await sql<
              { dashboard: unknown }[]
            >`select dashboard from app.user_prefs where user_id = ${c.get('user').id}`
          )[0]?.dashboard,
        )}
        showAkquise={canAccess(role, '/akquise')}
        absent={absent}
        absentHref={canAccess(role, '/urlaub/kalender') ? '/urlaub/kalender' : undefined}
        signOverdue={signOverdue}
        ampel={await (async () => {
          const m = lastMonth();
          const { rows, targetBp } = await siteCosting(sql, m);
          const withRev = rows.filter((r) => r.revenue !== 0n);
          const red = withRev.filter((r) => r.margin < 0n);
          const yellow = withRev.filter((r) => r.margin >= 0n && (r.margin_bp ?? 0) < targetBp);
          return {
            month: m,
            targetBp,
            green: withRev.length - red.length - yellow.length,
            yellow: yellow.length,
            red: red.length,
            worst: [...red, ...yellow].sort((a, b) => (a.margin_bp ?? 0) - (b.margin_bp ?? 0)).slice(0, 5),
          };
        })()}
        reminders={await collectReminders(sql).then((l) => ({
          n: l.length,
          red: l.filter((r) => r.level === 'rot').length,
        }))}
        missingDocs={
          canAccess(role, '/personal/unterlagen')
            ? (await missingDocs(sql, { siteIds: c.get('sites') })).length
            : 0
        }
        noShift={
          canAccess(role, '/einsatzplanung')
            ? {
                n: await countWithoutShift(sql, c.get('sites')),
                href: canAccess(role, '/personal')
                  ? '/personal?status=aktiv&einsatz=ohne'
                  : '/einsatzplanung',
              }
            : { n: 0, href: '' }
        }
        appRequests={{
          nu: canAccess(role, '/lieferanten')
            ? Number(
                (
                  await sql<{ n: number }[]>`
                    select count(*)::int as n from app.subcontracts where status = 'entwurf' and requested_by is not null`
                )[0]!.n,
              )
            : 0,
          bogen: canAccess(role, '/personal/personalboegen')
            ? Number(
                (
                  await sql<
                    { n: number }[]
                  >`select count(*)::int as n from app.personnel_forms where status = 'neu'`
                )[0]!.n,
              )
            : 0,
        }}
        user={fullName(c.get('user'))}
        tasks={tasks}
        drafts={drafts}
        balances={balances}
        unsent={unsent[0]!}
        hr={hr}
        month={lastMonth()}
        todo={todo}
        kpi={kpi}
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

  /** Suche mit Rechten: nur Treffer, deren Seite die Rolle öffnen darf; Objektleitung nur eigene Objekte. */
  const searchFor = async (c: Context<AppEnv>, q: string, limit: number, type: SearchType | null) => {
    const role = c.get('user')?.role;
    const res = await search(sql, q, {
      limit,
      siteScope: c.get('sites') ?? null,
      ...(type ? { types: [type] } : {}),
    });
    const DOC_GUARD: Record<string, string> = {
      customer: '/kunden/x',
      site: '/objekte/x',
      employee: '/personal/x/dokumente',
      supplier: '/lieferanten/x',
      offer: '/angebote/x',
      incoming_invoice: '/rechnungseingang/x',
      note: '/kunden/x',
    };
    for (const g of res.groups) {
      g.hits = g.hits.filter((h) => {
        if (!role) return false;
        const guard =
          h.type === 'Dokument'
            ? (DOC_GUARD[(h as { etype?: string }).etype ?? ''] ?? '/transfer/dokumente')
            : h.href;
        return canAccess(role, guard.split('?')[0]!.split('#')[0]!);
      });
    }
    res.groups = res.groups.filter((g) => g.hits.length > 0);
    return res;
  };

  app.get('/suche', async (c) => {
    const q = c.req.query('q') ?? '';
    const t = c.req.query('typ');
    const type = t && (SEARCH_TYPES as readonly string[]).includes(t) ? (t as SearchType) : null;
    const res = await searchFor(c, q, type ? 300 : 25, type);
    const all = res.groups.flatMap((g) => g.hits);
    if (all.length === 1 && !res.groups[0]!.more) return c.redirect(all[0]!.href);
    return page(c, 'Suche', '', <SearchResults result={res} type={type} />);
  });

  // Vorschau unter dem Suchfeld (wie Fortytools): je Bereich 5 Treffer, „… und einige weitere“
  app.get('/suche.json', async (c) => {
    const res = await searchFor(c, c.req.query('q') ?? '', 5, null);
    c.header('Cache-Control', 'private, no-store');
    return c.json(res);
  });

  // ------------------------------------------------------------------ Startseite anpassen (je Benutzer)
  app.get('/startseite/anpassen', async (c) => {
    const [p] = await sql<
      { dashboard: unknown }[]
    >`select dashboard from app.user_prefs where user_id = ${c.get('user').id}`;
    const lay = normalizeDash(p?.dashboard);
    return page(
      c,
      'Übersicht anpassen',
      'home',
      <>
        <PageHead title="Übersicht anpassen" crumbs={[['Übersicht', '/']]} />
        <form method="post" action="/startseite/anpassen" class="card" style="max-width:760px">
          <p class="small mut" style="margin-top:0">
            Welche Karten sollen auf Ihrer Startseite stehen, in welcher Spalte und in welcher Reihenfolge?
            Gilt nur für Ihren Benutzer.
          </p>
          <div class="tbl">
            <table>
              <thead>
                <tr>
                  <th>anzeigen</th>
                  <th>Karte</th>
                  <th>Spalte</th>
                  <th>Reihenfolge</th>
                </tr>
              </thead>
              <tbody>
                {lay.map((x, i) => (
                  <tr>
                    <td>
                      <input
                        type="checkbox"
                        name={`show_${x.key}`}
                        checked={!x.hidden}
                        aria-label="anzeigen"
                      />
                    </td>
                    <td>{DASH_CARDS[x.key]}</td>
                    <td>
                      <select name={`col_${x.key}`} data-nosearch aria-label="Spalte">
                        <option value="1" selected={x.col === 1}>
                          links
                        </option>
                        <option value="2" selected={x.col === 2}>
                          rechts
                        </option>
                      </select>
                    </td>
                    <td>
                      <input
                        name={`ord_${x.key}`}
                        type="number"
                        min="1"
                        max="20"
                        value={String(i + 1)}
                        style="max-width:80px"
                        aria-label="Reihenfolge"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div class="formfoot">
            <button class="btn sec" name="reset" value="1">
              Standard wiederherstellen
            </button>
            <button class="btn">Speichern</button>
          </div>
        </form>
      </>,
    );
  });

  app.post('/startseite/anpassen', async (c) => {
    const b = await c.req.parseBody();
    const uid = c.get('user').id;
    if (b.reset === '1') {
      await sql`delete from app.user_prefs where user_id = ${uid}`;
      return back(c, '/', { ok: 'Startseite auf Standard zurückgesetzt.' });
    }
    const lay = (Object.keys(DASH_CARDS) as DashCardKey[])
      .map((key) => ({
        key,
        col: b[`col_${key}`] === '2' ? (2 as const) : (1 as const),
        hidden: b[`show_${key}`] !== 'on',
        ord: Number(b[`ord_${key}`]) || 99,
      }))
      .sort((a, z) => a.ord - z.ord)
      .map(({ ord: _o, ...x }) => x);
    await sql`insert into app.user_prefs (user_id, dashboard) values (${uid}, ${sql.json(lay as never)})
              on conflict (user_id) do update set dashboard = excluded.dashboard, updated_at = now()`;
    return back(c, '/', { ok: 'Startseite gespeichert.' });
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

  app.post('/offene-posten/zahlungen', async (c) => {
    const b = await c.req.parseBody();
    const batch = typeof b.batch === 'string' && /^[0-9a-f-]{36}$/.test(b.batch) ? b.batch : randomUUID();
    const date = String(b.datum ?? '');
    const reference = typeof b.referenz === 'string' && b.referenz.trim() ? b.referenz.trim() : null;
    let n = 0;
    let paid = 0n;
    let skonto = 0n;
    const errors: string[] = [];
    for (const k of Object.keys(b)) {
      const m = /^pay_([0-9a-f-]{36})$/.exec(k);
      if (!m) continue;
      const raw = String(b[k] ?? '').trim();
      const rest = b[`rest_${m[1]}`] === 'skonto' ? 'skonto' : 'offen';
      if (!raw && rest !== 'skonto') continue;
      let amount: bigint;
      try {
        amount = raw ? parseEuro(raw) : 0n;
      } catch {
        errors.push(`Betrag „${raw}“ ungültig`);
        continue;
      }
      try {
        const r = await settleOpenItem(sql, {
          batchId: batch,
          invoiceId: m[1]!,
          legacy: b[`lg_${m[1]}`] === '1',
          amount,
          date,
          rest,
          reference,
          actor: c.get('actor'),
        });
        n++;
        paid += r.paid;
        skonto += r.skonto;
      } catch (e) {
        if (!(e instanceof BusinessError)) throw e;
        errors.push(e.message);
      }
    }
    if (!n && !errors.length)
      throw new BusinessError('Bitte bei mindestens einer Rechnung einen Betrag eintragen');
    const msg = `${n} Rechnung(en): ${euro(paid)} Zahlung${skonto ? `, ${euro(skonto)} als Skonto ausgebucht` : ''}`;
    return back(c, '/offene-posten', errors.length ? { fehler: [msg, ...errors].join('\n') } : { ok: msg });
  });

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
        <form method="post" action="/offene-posten/zahlungen" id="op-form">
          <input type="hidden" name="batch" value={randomUUID()} />
          <div class="card actions op-paybar" style="margin-top:0">
            <b>Zahlungseingang erfassen</b>
            <span class="small mut">
              Betrag je Rechnung eintragen – Rest bleibt offen (Teilzahlung) oder wird als Skonto ausgebucht.
            </span>
            <label for="op-date" style="margin:0 0 0 auto">
              Zahlungsdatum
            </label>
            <input id="op-date" type="date" name="datum" value={todayBerlin()} style="max-width:170px" />
            <input name="referenz" placeholder="Verwendungszweck (optional)" style="max-width:220px" />
          </div>
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
                        <a
                          href={
                            i.legacy
                              ? `/rechnungen/fortytools/${i.invoice_id}`
                              : `/rechnungen/${i.invoice_id}`
                          }
                        >
                          <b>{i.number}</b>
                        </a>{' '}
                        {i.legacy && <span class="badge">Fortytools</span>}{' '}
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
                    <div class="op-pay">
                      <span class="small mut">Zahlung</span>
                      <input
                        name={`pay_${i.invoice_id}`}
                        inputmode="decimal"
                        placeholder="0,00"
                        aria-label={`Zahlbetrag ${i.number}`}
                      />
                      <button
                        type="button"
                        class="btn sm ghost"
                        data-fill={(Number(i.open_cents) / 100).toFixed(2).replace('.', ',')}
                        onclick="this.previousElementSibling.value=this.dataset.fill"
                      >
                        voll
                      </button>
                      <select name={`rest_${i.invoice_id}`} aria-label={`Rest ${i.number}`}>
                        <option value="offen">Rest bleibt offen</option>
                        <option value="skonto">Rest als Skonto</option>
                      </select>
                      {i.legacy && <input type="hidden" name={`lg_${i.invoice_id}`} value="1" />}
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
              <button class="btn">Zahlungen buchen</button>
              <span class="small mut" style="margin-left:12px">
                Ausgewählte Rechnungen:
              </span>
              <button
                class="btn sec"
                formaction="/mahnungen/stapel"
                onclick="return confirm('Für die ausgewählten Rechnungen je Kunde eine Mahnung erstellen? (Regeln: Stufe, Mindestabstand, Mahnsperre werden geprüft)')"
              >
                Mahnung erstellen
              </button>
              <label class="chk" style="margin:0">
                <input type="checkbox" name="send" value="1" /> gleich per E-Mail senden
              </label>
              <span class="small faint hint-desk" style="margin-left:auto">
                Bankabgleich mit Vorschlägen: Transfer → Kontoumsätze
              </span>
            </div>
          )}
        </form>
        <OpenLegacyCard rows={await openLegacyInvoices(sql)} />
      </>,
    );
  });

  // ------------------------------------------------------------------ Auswertungen

  // Netto-Umsatz je Monat steckt jetzt in den Statistiken
  app.get('/auswertungen/umsatz', (c) => c.redirect('/auswertungen/statistik?grundlage=rechnung', 301));

  // ------------------------------------------------------------------ Personal

  app.get('/personal', async (c) => {
    const status = c.req.query('status') ?? 'aktiv';
    const q = c.req.query('q')?.trim() || null;
    const tag = c.req.query('tag')?.trim() || null;
    const ohne = c.req.query('einsatz') === 'ohne';
    const [rows, tags, templates, noShift] = await Promise.all([
      listEmployees(sql, {
        ...(status === 'aktiv' || status === 'ausgetreten' ? { status } : {}),
        ...(q ? { q } : {}),
        ...(tag ? { tag } : {}),
        ...(ohne ? { withoutShift: true } : {}),
      }),
      allTags(sql),
      listTemplates(sql),
      countWithoutShift(sql),
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
        ohne={ohne}
        noShift={noShift}
        page={Number(c.req.query('seite')) || 1}
        sort={c.req.query('sortierung') ?? 'name'}
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
      // Aktuelle Einsätze wie Fortytools (laufende und künftige Planung)
      const plans = await sql<
        {
          site_id: string;
          site_name: string;
          site_no: string;
          wd: number[];
          times: string;
          from: string;
          until: string | null;
        }[]
      >`
        select p.site_id, s.name as site_name, s.site_no, array_agg(distinct p.weekday order by p.weekday) as wd,
               string_agg(distinct to_char(p.start_time, 'HH24:MI') || '–' || to_char(p.end_time, 'HH24:MI'), ', ') as times,
               min(p.valid_from)::text as from, max(p.valid_until)::text as until
          from app.shift_plans p join app.sites s on s.id = p.site_id
         where p.employee_id = ${e.id} and (p.valid_until is null or p.valid_until >= ${todayBerlin()})
         group by p.site_id, s.name, s.site_no order by s.site_no`;
      const WD = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
      const einsaetze = (
        <>
          <div class="card">
            <div class="actions" style="margin:0 0 8px;justify-content:space-between">
              <h2 style="margin:0">Aktuelle Einsätze</h2>
              <a
                class="btn sm"
                href={`/einsatzplanung/${randomUUID()}?mitarbeiter=${e.id}&zurueck=${encodeURIComponent(`/personal/${e.id}`)}`}
              >
                + Einsatz planen
              </a>
            </div>
            {plans.length === 0 ? (
              e.status === 'aktiv' ? (
                <div class="flash warn" style="margin:0">
                  <span>
                    <b>Kein Einsatz geplant.</b> Ohne Einsatz gibt es kein Soll, keinen Einsatzkalender und in
                    der Handy-App keine Einsätze zum Stempeln – bitte einen Einsatz planen (Büro: Objekt
                    „Büro“ unter „Viva-Deluxe intern“).
                  </span>
                </div>
              ) : (
                <div class="empty">Keine aktuellen Einsätze geplant.</div>
              )
            ) : (
              <div class="tbl stack-m">
                <table>
                  <thead>
                    <tr>
                      <th>Objekt</th>
                      <th>Tage / Zeit</th>
                      <th>Einsatzbeginn</th>
                      <th>Einsatzende</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plans.map((p) => (
                      <tr>
                        <td>
                          <a href={`/objekte/${p.site_id}/einsaetze`}>{p.site_name}</a>
                          <div class="small mut">{p.site_no}</div>
                        </td>
                        <td>
                          {p.wd.map((d) => WD[d]).join(', ')}
                          <div class="small mut">{p.times}</div>
                        </td>
                        <td data-l="Beginn">{dateDe(p.from)}</td>
                        <td data-l="Ende">{p.until ? dateDe(p.until) : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      );
      const beschaeftigung = (
        <>
          <div>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Eintritt</th>
                    <th>Austritt</th>
                    <th>Grund</th>
                  </tr>
                </thead>
                <tbody>
                  {(await employmentHistory(sql, e.id)).map((p) => (
                    <tr>
                      <td>{dateDe(p.entry_date)}</td>
                      <td>{p.exit_date ? dateDe(p.exit_date) : <span class="badge ok">laufend</span>}</td>
                      <td class="small">{p.exit_reason ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {e.exit_date ? (
              <>
                <form method="post" action={`/personal/${e.id}/wiedereintritt`} class="actions">
                  <label for="re" style="margin:0">
                    Wiedereintritt am
                  </label>
                  <input id="re" type="date" name="date" required style="max-width:180px" />
                  <button class="btn sm">Wiedereintritt erfassen</button>
                </form>
                <form
                  method="post"
                  action={`/personal/${e.id}/austritt-zuruecknehmen`}
                  class="actions"
                  onsubmit="return confirm('Austritt zurücknehmen? Der Mitarbeiter ist danach wieder aktiv (ohne Austrittsdatum).')"
                >
                  <button class="btn sm sec">Austritt zurücknehmen (falsch erfasst)</button>
                </form>
              </>
            ) : (
              <details>
                <summary class="btn sm sec" style="margin-top:10px">
                  Austritt erfassen
                </summary>
                <form
                  method="post"
                  action={`/personal/${e.id}/austritt`}
                  class="grid"
                  style="margin-top:10px"
                >
                  <div>
                    <label for="ex">Letzter Arbeitstag (Austritt)</label>
                    <input id="ex" type="date" name="date" required />
                  </div>
                  <div>
                    <label for="rs">Grund</label>
                    <select id="rs" name="reason">
                      {[
                        'Kündigung durch Arbeitnehmer',
                        'Kündigung durch Arbeitgeber',
                        'Aufhebungsvertrag',
                        'Befristung ausgelaufen',
                        'Rente',
                        'Sonstiges',
                      ].map((r) => (
                        <option value={r}>{r}</option>
                      ))}
                    </select>
                  </div>
                  <p class="small mut">
                    Kündigung und Aufhebungsvertrag nur schriftlich mit Originalunterschrift (§ 623 BGB) –
                    Kopie unter Dokumente ablegen. Schlüssel, Kleidung und Geräte unter „Übergaben“
                    zurücknehmen.
                  </p>
                  <div class="actions">
                    <button class="btn sm">Austritt speichern</button>
                  </div>
                </form>
              </details>
            )}
          </div>
        </>
      );
      return (
        <>
          <EmployeeOverview
            e={e}
            priv={data.priv}
            sites={data.sites}
            showPrivate
            wage={{ level: lvl?.name ?? null, cents: wage }}
            month={await monthBox(e.id)}
            afterHead={einsaetze}
            employment={beschaeftigung}
            hours={await hoursHistory(sql, e.id)}
          />
        </>
      );
    }),
  );

  app.get(`/personal/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const data = await getEmployee(sql, id);
    const wageLevels = await listWageLevels(sql);
    // Personalbogen aus der App (Objektleitung) → neues Stammdatenformular vorausfüllen
    const bogenId = c.req.query('bogen');
    const [bogen] =
      !data && bogenId && /^[0-9a-f-]{36}$/.test(bogenId)
        ? await sql<
            { data: Record<string, string> }[]
          >`select data from app.personnel_forms where id = ${bogenId}`
        : [];
    const bd = bogen?.data ?? {};
    const form = (
      <EmployeeForm
        wageLevels={wageLevels}
        id={id}
        e={
          data?.employee ?? {
            personnel_no: await suggestPersonnelNo(sql),
            ...(bogen
              ? {
                  first_name: bd.first_name ?? '',
                  last_name: bd.last_name ?? '',
                  salutation: (bd.salutation as 'Herr' | 'Frau' | 'divers' | undefined) ?? null,
                  mobile: bd.mobile ?? null,
                  email_private: bd.email_private ?? null,
                  languages: bd.languages
                    ? bd.languages
                        .split(/[,;/]+/)
                        .map((x) => x.trim())
                        .filter(Boolean)
                    : [],
                  info:
                    [bd.emergency_contact ? `Notfallkontakt: ${bd.emergency_contact}` : '', bd.notes ?? '']
                      .filter(Boolean)
                      .join('\n') || null,
                }
              : {}),
          }
        }
        priv={
          data?.priv ??
          (bogen
            ? {
                birth_date: bd.birth_date ?? null,
                birth_place: bd.birth_place ?? null,
                birth_country: bd.birth_country ?? null,
                nationality: bd.nationality ?? null,
                marital_status: bd.marital_status ?? null,
                street: bd.street ?? null,
                postal_code: bd.postal_code ?? null,
                city: bd.city ?? null,
                iban: bd.iban ?? null,
                tax_id: bd.tax_id ?? null,
                social_security_no: bd.social_security_no ?? null,
                health_insurance: bd.health_insurance ?? null,
                residence_permit_until: bd.residence_permit_until ?? null,
                work_permit_until: bd.work_permit_until ?? null,
              }
            : {})
        }
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
          {bogen && (
            <div class="flash ok">
              Aus dem Personalbogen vorausgefüllt – bitte Beschäftigungsart, Vergütung und Eintritt ergänzen.
              Danach den Bogen unter <a href="/personal/personalboegen">Personalbögen</a> als erledigt
              markieren.
            </div>
          )}
          <div class="card">{form}</div>
        </>,
      );
    }
    // Bearbeiten wie Fortytools: eigene Seite ohne Reiter, nur Kopf mit Brotkrumen
    const name = `${data.employee.first_name} ${data.employee.last_name}`;
    return page(
      c,
      `${name} – Stammdaten`,
      'personal',
      <>
        <PageHead
          title={`${data.employee.last_name}, ${data.employee.first_name}`}
          no={data.employee.personnel_no}
          crumbs={[
            ['Mitarbeiter', '/personal'],
            [name, `/personal/${id}`],
          ]}
        />
        <div class="card form-card">{form}</div>
      </>,
    );
  });

  app.post(`/personal/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const body = await c.req.parseBody({ all: true });
    // Tags und Sprachen kommen als Auswahl (mehrere Werte) – zu einer Liste zusammenfassen
    const flat = Object.fromEntries(
      Object.entries(body).map(([k, v]) => [
        k,
        Array.isArray(v) ? (k === 'tags' || k === 'languages' ? v.map(String).join(',') : v[0]) : v,
      ]),
    );
    const parsed = employeeInput.safeParse(flat);
    if (!parsed.success) throw new BusinessError(parsed.error.issues.map((i) => i.message).join('\n'));
    // Pflicht im Formular (Ahmed 06.10.): Beschäftigungsart, Vergütung, Wochenstunden bei Teilzeit/Minijob
    if (!parsed.data.pay_model)
      throw new BusinessError(
        'Bitte die Vergütung wählen: Tariflohn, individueller Stundenlohn oder Festgehalt.',
      );
    if (['teilzeit', 'minijob'].includes(parsed.data.employment_type) && !parsed.data.weekly_hours)
      throw new BusinessError('Bitte die Wochenstunden angeben (Teilzeit/Minijob).');
    await saveEmployee(sql, id, parsed.data, c.get('actor'));
    // Objekt-Zuordnung nicht mehr im Stammdatenformular (Ahmed 06.10.) – entsteht über Planung/Einsätze
    return back(c, `/personal/${id}`, { ok: 'Mitarbeiter gespeichert.' });
  });

  app.post(`/personal/:id{${UUID}}/austritt`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    await exitEmployee(sql, id, {
      date: String(b.date ?? ''),
      reason: typeof b.reason === 'string' ? b.reason : null,
    });
    return back(c, `/personal/${id}`, { ok: 'Austritt gespeichert.' });
  });

  app.post(`/personal/:id{${UUID}}/austritt-zuruecknehmen`, async (c) => {
    const id = c.req.param('id');
    await revokeExit(sql, id);
    return back(c, `/personal/${id}`, { ok: 'Austritt zurückgenommen – der Mitarbeiter ist wieder aktiv.' });
  });

  app.post(`/personal/:id{${UUID}}/wiedereintritt`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    await reenterEmployee(sql, id, { date: String(b.date ?? ''), actor: c.get('actor') });
    return back(c, `/personal/${id}`, {
      ok: 'Wiedereintritt gespeichert – frühere Beschäftigungszeit bleibt festgehalten.',
    });
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
