import { vehiclesWithoutRegistration } from '../services/vehicles.js';
import { accountOverview } from '../services/bank-feed.js';
import { timeAnomalies } from '../services/time-anomalies.js';
import { monthlyRevenue } from '../services/statistics.js';
import { plannedShifts } from '../services/time.js';
import { collectReminders } from '../services/reminders.js';
import { fullName } from '../services/users.js';
import { missingDocs } from '../services/hr-required-docs.js';
import { hoursHistory, plannedDaysPerWeek } from '../services/employee-hours.js';
import { absentBetween, leaveBalance, listAbsences, plannedAtSites } from '../services/absences.js';
import { permitWarningsForSites } from '../services/employees.js';
import { AbsentCard, DashHero, PermitCard, type HeroTile } from './pages-crm.js';
import { canAccess, canOpen } from './permissions.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { type FileRow, filePath } from '../services/uploads.js';
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import {
  getTask,
  listTasks,
  saveTask,
  setTaskDone,
  taskEditInput,
  taskInput,
  taskVisibleTo,
  updateTask,
} from '../services/crm.js';
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
  markNotStarted,
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
import { type AppEnv, type Ctx, UUID, taskViewerOf } from './app.js';
import { NEW_OPTIONS, PageHead, dateDe, euro, anz } from './layout.js';
import { homeFor } from './permissions.js';
import { CockpitRow } from './cockpit.js';
import { uncoveredShifts } from '../services/planning.js';
import { inboxItems } from './routes-inbox.js';
import {
  DASH_CARDS,
  type DashCardKey,
  Dashboard,
  LeaveRequestsBox,
  DashHead,
  normalizeDash,
  type DashboardTodo,
  PlannedPage,
  PLANNED,
  SearchResults,
  TaskBox,
  TaskEditForm,
  TaskForm,
} from './pages-crm.js';
import { EmployeeForm, EmployeeList, EmployeeOverview, EmployeeShell } from './pages-hr-finance.js';
import { lastMonth } from './routes-invoices.js';
import { registerNoteRoutes } from './routes-notes.js';
import { uploadConfig } from './routes-files.js';
import { createReductionVoucher, listReductionVouchers } from '../services/reduction-vouchers.js';

const uuidOr = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) ? v : randomUUID());

/** Betrag kurz für die Kennzahlen der Übersicht: ganze Euro, ab 1 Mio. „3,31 Mio. €“ */
function euroShort(c: bigint): string {
  const e = Number(c) / 100;
  if (Math.abs(e) >= 1_000_000)
    return `${(e / 1_000_000).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Mio. €`;
  return `${Math.round(e).toLocaleString('de-DE')} €`;
}

export function registerModuleRoutes(ctx: Ctx) {
  const { app, deps, page, back, shells } = ctx;
  const { sql } = deps;

  // ------------------------------------------------------------------ Übersicht

  /**
   * Übersicht der Objektleitung (Ahmed 14.10.): Aufenthaltstitel/Arbeitserlaubnis ihrer eingeplanten Leute 6 Wochen
   * vorher, Abwesenheiten (heute, 7 und 14 Tage), eigene Aufgaben und die wichtigsten Wege.
   */
  /**
   * Offene Urlaubs-/Abwesenheitsanträge für die Übersicht. Objektleitung: nur Personen, die im Antragszeitraum an
   * ihren Objekten eingeplant sind (wie unter Urlaub & Abwesenheiten).
   */
  async function openLeaveRequests(c: Context<AppEnv>) {
    const sites = c.get('sites');
    const rows = await listAbsences(sql, { status: ['beantragt'] });
    rows.sort((a, b) => a.start_date.localeCompare(b.start_date));
    if (!sites) return rows;
    if (!sites.length || !rows.length) return [];
    const ok = await sql<{ id: string }[]>`
      select a.id from app.absences a where a.id = any(${rows.map((r) => r.id)}::uuid[])
         and ${plannedAtSites(sql, sql`a.employee_id`, sites, sql`a.start_date`, sql`a.end_date`)}`;
    const set = new Set(ok.map((r) => r.id));
    return rows.filter((r) => set.has(r.id));
  }

  async function olHome(c: Context<AppEnv>) {
    const sites = c.get('sites') ?? [];
    const today = todayBerlin();
    const inScope = (id: string) => sites.includes(id);
    const [permits, absent, tasks, odd, leave, shifts, pending, qm] = await Promise.all([
      permitWarningsForSites(sql, sites, 42),
      absentBetween(sql, today, addDays(today, 14), sites),
      listTasks(sql, { status: 'open', withinDays: 14, onlyFor: taskViewerOf(c) }),
      timeAnomalies(sql, { managerUserId: c.get('user').id }),
      canAccess('objektleitung', '/urlaub') ? openLeaveRequests(c) : Promise.resolve([]),
      sites.length ? plannedShifts(sql, { from: today, to: today }) : Promise.resolve([]),
      sites.length
        ? sql<{ n: number }[]>`select count(*)::int as n from app.time_entries
            where status = 'beantragt' and site_id = any(${sites}::uuid[])`
        : Promise.resolve([{ n: 0 }]),
      sites.length
        ? sql<
            {
              id: string;
              site_no: string;
              name: string;
              last_date: string | null;
              last_score: number | null;
              avg30: number | null;
              n30: number;
              tickets: number;
            }[]
          >`
            select s.id, s.site_no, s.name,
                   (select q.check_date::text from app.quality_checks q where q.site_id = s.id and q.status <> 'entwurf'
                     order by q.check_date desc limit 1) as last_date,
                   (select q.score_percent from app.quality_checks q where q.site_id = s.id and q.status <> 'entwurf'
                     order by q.check_date desc limit 1) as last_score,
                   (select round(avg(q.score_percent))::int from app.quality_checks q where q.site_id = s.id
                     and q.status <> 'entwurf' and q.check_date >= current_date - 30) as avg30,
                   (select count(*)::int from app.quality_checks q where q.site_id = s.id
                     and q.status <> 'entwurf' and q.check_date >= current_date - 30) as n30,
                   (select count(*)::int from app.site_tickets t where t.site_id = s.id and t.status <> 'erledigt') as tickets
              from app.sites s where s.id = any(${sites}::uuid[]) and s.active
             order by s.name`
        : Promise.resolve([]),
    ]);
    const nowHm = new Date().toLocaleTimeString('de-DE', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const mine = shifts.filter(
      (s) => inScope(s.plan.site_id) && s.exception?.kind !== 'ausfall' && !s.holiday,
    );
    const st = (s: (typeof mine)[number]) =>
      s.absence
        ? 'abwesend'
        : s.entry && !s.entry.end_at
          ? 'läuft'
          : s.entry
            ? 'erledigt'
            : s.plan.start_time.slice(0, 5) <= nowHm
              ? 'fehlt'
              : 'geplant';
    const counted = mine.filter((s) => !s.absence);
    const done = counted.filter((s) => st(s) === 'erledigt').length;
    const running = counted.filter((s) => st(s) === 'läuft').length;
    const missing = counted.filter((s) => st(s) === 'fehlt').length;
    const absToday = absent.filter((a) => a.start_date <= today).length;
    const absWeek = absent.filter((a) => a.start_date > today && a.start_date <= addDays(today, 7)).length;
    const qn = qm.reduce((a, q) => a + q.n30, 0);
    const qavg = qn ? Math.round(qm.reduce((a, q) => a + (q.avg30 ?? 0) * q.n30, 0) / qn) : null;
    const tickets = qm.reduce((a, q) => a + q.tickets, 0);
    const tiles = (
      [
        {
          label: 'Einsätze heute',
          value: `${done} / ${counted.length}`,
          bar: counted.length ? done / counted.length : 0,
          sub: counted.length ? `${done} erledigt · ${running} laufen` : 'heute keine Einsätze geplant',
          href: `/zeiterfassung?datum=${today}`,
        },
        {
          label: 'Nicht gestempelt',
          value: String(missing),
          sub: missing ? 'Einsatz hat begonnen, keine Zeit' : 'alles in Ordnung',
          tone: missing ? 'bad' : 'ok',
          href: `/zeiterfassung?datum=${today}`,
        },
        {
          label: 'Abwesend',
          value: `${absToday} heute`,
          sub: `${absWeek} in den nächsten 7 Tagen`,
          href: '/urlaub/kalender',
        },
        {
          label: 'Qualität Ø 30 Tage',
          value: qavg === null ? '–' : `${qavg} %`,
          sub: `${anz(qn, 'Audit', 'Audits')} · ${anz(tickets, 'Ticket', 'Tickets')} offen`,
          tone: qavg === null ? undefined : qavg >= 88 ? 'ok' : qavg >= 80 ? 'warn' : 'bad',
          href: '/qualitaet',
        },
      ] as HeroTile[]
    ).filter((t) => canOpen('objektleitung', t.href!));
    const rank: Record<string, number> = { fehlt: 0, abwesend: 1, läuft: 2, geplant: 3, erledigt: 4 };
    const list = [...mine].sort(
      (a, b) => rank[st(a)]! - rank[st(b)]! || a.plan.start_time.localeCompare(b.plan.start_time),
    );
    const todo: { tone: string; text: string; href: string }[] = [
      ...(leave.length
        ? [
            {
              tone: 'warn',
              text: anz(leave.length, 'Urlaubsantrag', 'Urlaubsanträge') + ' genehmigen',
              href: '/urlaub',
            },
          ]
        : []),
      ...(pending[0]!.n
        ? [
            {
              tone: 'warn',
              text: anz(pending[0]!.n, 'Nachtrag', 'Nachträge') + ' freigeben',
              href: `/zeiterfassung?datum=${today}#nachtraege`,
            },
          ]
        : []),
      ...(odd.length
        ? [
            {
              tone: 'warn',
              text: anz(odd.length, 'auffällige Zeit', 'auffällige Zeiten') + ' prüfen',
              href: '/zeiterfassung/auffaellig',
            },
          ]
        : []),
      ...(tickets
        ? [{ tone: 'warn', text: anz(tickets, 'Ticket', 'Tickets') + ' offen', href: '/qualitaet' }]
        : []),
      ...qm
        .filter((q) => !q.last_date || q.last_date < addDays(today, -60))
        .slice(0, 3)
        .map((q) => ({
          tone: 'info',
          text: `Audit fällig: ${q.name}`,
          href: `/objekte/${q.id}`,
        })),
    ].filter((x) => canOpen('objektleitung', x.href.split('#')[0]!));
    const overdueT = tasks.filter((t) => t.due_date && t.due_date < today).length;
    const STATE: Record<string, [string, string]> = {
      fehlt: ['err', 'nicht gestempelt'],
      abwesend: ['warn', 'abwesend'],
      läuft: ['warn', 'läuft'],
      geplant: ['', 'geplant'],
      erledigt: ['ok', 'erledigt'],
    };
    const olInbox = c.get('uiNew') ? await inboxItems(deps, c) : null;
    return page(
      c,
      'Übersicht',
      'home',
      <div class="dash">
        <DashHero
          name={c.get('user').name || c.get('user').login}
          today={today}
          quick={(
            [
              [`/zeiterfassung?datum=${today}`, 'Zeiten heute'],
              ['/einsatzplanung', 'Planung'],
              ['/arbeitsscheine', 'Arbeitsscheine'],
              ['/urlaub/kalender', 'Abwesenheiten'],
            ] as [string, string][]
          ).filter(([h]) => canOpen('objektleitung', h.split('?')[0]!))}
          tiles={tiles}
        />
        {olInbox && <CockpitRow d={{ inbox: olInbox }} />}
        <LeaveRequestsBox rows={leave} />
        <div class="dash-grid">
          <div class="dash-col">
            <section class="card dash-card">
              <DashHead
                title="Einsätze heute"
                count={mine.length || undefined}
                href={`/zeiterfassung?datum=${today}`}
                more="Alle Zeiten"
              />
              {list.length === 0 ? (
                <div class="dash-empty">Heute sind an Ihren Objekten keine Einsätze geplant.</div>
              ) : (
                <ul class="dash-list">
                  {list.slice(0, 8).map((s) => {
                    const [tone, label] = STATE[st(s)]!;
                    return (
                      <li>
                        <span class={`dot ${tone}`} />
                        <div class="dl-main">
                          {s.plan.employee_name}
                          <div class="dl-sub">
                            {s.plan.site_name} · {s.plan.start_time.slice(0, 5)}–{s.plan.end_time.slice(0, 5)}
                            {s.exception?.kind === 'vertretung' ? ' · Vertretung' : ''}
                          </div>
                        </div>
                        <span class="dl-r">
                          {s.entry && !s.entry.end_at
                            ? `seit ${new Date(s.entry.start_at).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })}`
                            : label}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {list.length > 8 && (
                <a class="dash-more" href={`/zeiterfassung?datum=${today}`}>
                  + {list.length - 8} weitere
                </a>
              )}
            </section>
            <section class="card dash-card">
              <DashHead
                title="Meine Aufgaben"
                count={tasks.length || undefined}
                href="/aufgaben"
                more="Alle Aufgaben"
              />
              {overdueT > 0 && (
                <div class="dash-alert">
                  {overdueT} Aufgabe{overdueT === 1 ? '' : 'n'} überfällig
                </div>
              )}
              {tasks.length === 0 ? (
                <div class="dash-empty">Keine offenen Aufgaben.</div>
              ) : (
                <ul class="dash-list">
                  {tasks.slice(0, 6).map((t) => (
                    <li>
                      <span
                        class={`dot ${t.due_date && t.due_date < today ? 'err' : t.due_date === today ? 'warn' : ''}`}
                      />
                      <div class="dl-main">
                        <a href={`/aufgaben/${t.id}/bearbeiten`}>{t.title}</a>
                        {t.entity_label && <div class="dl-sub">{t.entity_label}</div>}
                      </div>
                      <span class="dl-r">
                        {t.due_date ? (t.due_date === today ? 'heute' : dateDe(t.due_date)) : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {qm.length > 0 && (
              <section class="card dash-card">
                <DashHead title="Meine Objekte" count={qm.length} href="/objekte" more="Alle Objekte" />
                <ul class="dash-list">
                  {qm.slice(0, 8).map((q) => (
                    <li>
                      <div class="dl-main">
                        <a href={`/objekte/${q.id}`}>{q.name}</a>
                        <div class="dl-sub">
                          {q.last_date
                            ? `letztes Audit ${dateDe(q.last_date)}${q.last_score != null ? ` · ${q.last_score} %` : ''}`
                            : 'noch kein Audit'}
                        </div>
                      </div>
                      <span class="dl-r">{q.tickets ? anz(q.tickets, 'Ticket', 'Tickets') : ''}</span>
                    </li>
                  ))}
                </ul>
                {qm.length > 8 && <div class="dash-more">+ {qm.length - 8} weitere</div>}
              </section>
            )}
          </div>
          <div class="dash-col">
            {todo.length > 0 && (
              <section class="card dash-card accent">
                <DashHead title="Zu erledigen" count={todo.length} />
                <ul class="dash-list">
                  {todo.map((x) => (
                    <li>
                      <span class={`dot ${x.tone}`} />
                      <div class="dl-main">
                        <a href={x.href}>{x.text}</a>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <PermitCard rows={permits} today={today} link={false} days={42} />
            <AbsentCard absent={absent} today={today} href="/urlaub/kalender" />
          </div>
        </div>
      </div>,
    );
  }

  app.get('/', async (c) => {
    const role = c.get('user').role;
    if (role === 'objektleitung') return olHome(c);
    if (role !== 'admin' && role !== 'buchhaltung' && role !== 'personal') return c.redirect(homeFor(role));
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
      followups: { due: [], week: [] },
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
    const bank = canAccess(role, '/transfer/kontoumsaetze') ? await accountOverview(sql) : null;
    const leaveRequests = canAccess(role, '/urlaub') ? await openLeaveRequests(c) : [];
    const missingN = canAccess(role, '/personal/unterlagen')
      ? (await missingDocs(sql, { siteIds: c.get('sites'), limited: false })).length
      : 0;
    const [absent, signOverdue] = await Promise.all([
      absentBetween(sql, todayBerlin(), addDays(todayBerlin(), 14), null),
      sql<{ id: string; title: string; open: number }[]>`
        select d.id, d.title, count(*)::int as open from app.sign_documents d
          join app.sign_requests r on r.document_id = d.id and r.status = 'offen'
         where d.due_date is not null and d.due_date < ${todayBerlin()} and d.archived_at is null
         group by d.id, d.title order by d.title`,
    ]);
    let hero: HeroTile[];
    let quick: [string, string][] | undefined;
    let allowed: DashCardKey[] | undefined;
    if (role === 'personal') {
      const [st] = await sql<{ aktiv: number; ein: number; aus: number }[]>`
        select count(*) filter (where status = 'aktiv')::int as aktiv,
               count(*) filter (where to_char(entry_date, 'YYYY-MM') = ${today.slice(0, 7)})::int as ein,
               count(*) filter (where to_char(exit_date, 'YYYY-MM') = ${today.slice(0, 7)})::int as aus
          from app.employees`;
      const now = absent.filter((a) => a.start_date <= today);
      const sick = now.filter((a) => a.kind === 'krank' || a.kind === 'kind_krank').length;
      hero = [
        {
          label: 'Mitarbeitende aktiv',
          value: String(st!.aktiv),
          sub: `${anz(st!.ein, 'Eintritt', 'Eintritte')} · ${anz(st!.aus, 'Austritt', 'Austritte')} im Monat`,
          href: '/personal',
        },
        {
          label: 'Abwesend heute',
          value: String(now.length),
          sub: now.length ? `${sick} krank · ${now.length - sick} Urlaub/sonstiges` : 'alle da',
          href: '/urlaub/kalender',
        },
        {
          label: 'Offene Anträge',
          value: String(leaveRequests.length),
          sub: leaveRequests.length ? 'zum Genehmigen' : 'nichts offen',
          tone: leaveRequests.length ? 'warn' : undefined,
          href: '/urlaub',
        },
        {
          label: 'Unterlagen fehlen',
          value: String(missingN),
          sub: missingN ? 'Mitarbeitende mit Lücken' : 'vollständig',
          tone: missingN ? 'bad' : 'ok',
          href: '/personal/unterlagen',
        },
      ];
      quick = (
        [
          ['/neu?typ=mitarbeiter', '+ Mitarbeiter'],
          ['/urlaub/kalender', 'Urlaub & Abwesenheiten'],
          ['/zeiterfassung/stundenzettel', 'Stundenliste'],
          ['/bewerber', 'Bewerber'],
          ['/neu?typ=aufgabe', '+ Aufgabe'],
        ] as [string, string][]
      ).filter(([h]) => canOpen(role, h));
      allowed = ['aufgaben', 'abwesend', 'hinweise', 'aufenthalt', 'geburtstage'];
    } else {
      // Umsatz nach Leistungszeitraum (wie Auswertungen → Statistiken), eigene + übernommene Rechnungen
      const lm = lastMonth();
      const lmEnd = addDays(`${today.slice(0, 7)}-01`, -1);
      const sd = new Date(`${lm}-01T12:00:00Z`);
      sd.setUTCMonth(sd.getUTCMonth() - 11);
      const y = Number(today.slice(0, 4));
      const [series, ytd, ytdPrev] = await Promise.all([
        monthlyRevenue(sql, sd.toISOString().slice(0, 10), lmEnd),
        monthlyRevenue(sql, `${y}-01-01`, today),
        monthlyRevenue(sql, `${y - 1}-01-01`, `${y - 1}${today.slice(4)}`),
      ]);
      const months: string[] = [];
      for (const d = new Date(sd); d.toISOString().slice(0, 7) <= lm; d.setUTCMonth(d.getUTCMonth() + 1))
        months.push(d.toISOString().slice(0, 7));
      const val = (m: string) => series.get(m) ?? 0n;
      const prevM = months[months.length - 2] ?? lm;
      const sum = (mp: Map<string, bigint>) => [...mp.values()].reduce((a, b) => a + b, 0n);
      const pct = (a: bigint, b: bigint): HeroTile['sub'] => {
        if (b <= 0n) return 'kein Vergleichswert';
        const p = (Number(a - b) / Number(b)) * 100;
        return `${p >= 0 ? '▲' : '▼'} ${Math.abs(p).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`;
      };
      const tone = (a: bigint, b: bigint) =>
        b <= 0n ? undefined : a >= b ? ('ok' as const) : ('bad' as const);
      const opTotal = balances.reduce((s2, b) => s2 + b.open_cents, 0n);
      const opOver = balances.reduce((s2, b) => s2 + b.overdue_cents, 0n);
      const bankSum = bank?.some((b) => b.balance_cents != null)
        ? bank.reduce((a, b) => a + (b.balance_cents ?? 0n), 0n)
        : null;
      const bankNew = (bank ?? []).reduce((a, b) => a + b.open, 0);
      const yCur = sum(ytd);
      const yPrev = sum(ytdPrev);
      hero = (
        [
          {
            label: `Umsatz ${MONTHS[Number(lm.slice(5, 7)) - 1]} (netto)`,
            value: euroShort(val(lm)),
            sub:
              val(prevM) > 0n ? <>{pct(val(lm), val(prevM))} ggü. Vormonat</> : 'kein Vergleich zum Vormonat',
            tone: tone(val(lm), val(prevM)),
            spark: months.some((m) => val(m) !== 0n) ? months.map((m) => Number(val(m))) : undefined,
            href: '/auswertungen/statistik',
          },
          {
            label: `Umsatz ${y} bis heute`,
            value: euroShort(yCur),
            sub: yPrev > 0n ? <>{pct(yCur, yPrev)} ggü. Vorjahr</> : 'kein Vergleich zum Vorjahr',
            tone: tone(yCur, yPrev),
            href: '/auswertungen/statistik',
          },
          {
            label: 'Offene Posten',
            value: euroShort(opTotal),
            sub: opOver ? `${euroShort(opOver)} überfällig` : 'nichts überfällig',
            tone: opOver ? 'bad' : 'ok',
            href: '/offene-posten',
          },
          bankSum !== null
            ? {
                label: 'Kontostand',
                value: euroShort(bankSum),
                sub: bankNew ? `${bankNew} neue Umsätze zuordnen` : 'alles zugeordnet',
                tone: bankNew ? 'warn' : undefined,
                href: '/transfer/kontoumsaetze',
              }
            : {
                label: 'Noch nicht versendet',
                value: String(unsent[0]!.invoices + unsent[0]!.corrections),
                sub: 'Rechnungen & Korrekturen',
                href: '/rechnungen/versand',
              },
        ] as HeroTile[]
      ).filter((t) => canOpen(role, t.href!));
    }
    // Neue Oberfläche: Cockpit-Zeile (Eingang, Personal, Objekte)
    let cockpit: Child | undefined;
    if (c.get('uiNew')) {
      const inbox = await inboxItems(deps, c);
      const nowAbs = absent.filter((a) => a.start_date <= today);
      const personal =
        canAccess(role, '/personal') || canAccess(role, '/urlaub')
          ? {
              absent: nowAbs.length,
              sick: nowAbs.filter((a) => a.kind === 'krank' || a.kind === 'kind_krank').length,
              noShift: canAccess(role, '/einsatzplanung') ? await countWithoutShift(sql, c.get('sites')) : 0,
              permits: inbox.filter((i) => i.key.startsWith('p:')).length,
              missing: missingN,
            }
          : undefined;
      const objects =
        canAccess(role, '/objekte') || canAccess(role, '/einsatzplanung')
          ? await Promise.all([
              uncoveredShifts(sql, today, addDays(today, 7)),
              sql<{ tickets: number; audit: number }[]>`
                select (select count(*)::int from app.site_tickets where status <> 'erledigt') as tickets,
                       (select count(*)::int from app.sites s where s.active and s.manager_user_id is not null
                          and not exists (select 1 from app.quality_checks q where q.site_id = s.id
                                            and q.status <> 'entwurf' and q.check_date >= current_date - 60)) as audit`,
            ]).then(([u, [x]]) => ({ uncovered: u.length, tickets: x!.tickets, auditDue: x!.audit }))
          : undefined;
      cockpit = <CockpitRow d={{ inbox, personal, objects }} />;
    }
    return page(
      c,
      'Übersicht',
      'home',
      <Dashboard
        cockpit={cockpit}
        layout={normalizeDash(
          (
            await sql<
              { dashboard: unknown }[]
            >`select dashboard from app.user_prefs where user_id = ${c.get('user').id}`
          )[0]?.dashboard,
        )}
        absent={absent}
        absentHref={canAccess(role, '/urlaub/kalender') ? '/urlaub/kalender' : undefined}
        leaveRequests={leaveRequests}
        signOverdue={signOverdue}
        hero={hero}
        quick={quick}
        allowed={allowed}
        reminders={
          !canAccess(role, '/erinnerungen')
            ? { n: 0, red: 0 }
            : await collectReminders(sql).then((l) => ({
                n: l.length,
                red: l.filter((r) => r.level === 'rot').length,
              }))
        }
        missingDocs={missingN}
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
        bank={bank}
        appRequests={{
          fahrzeugschein: canAccess(role, '/fahrzeuge') ? (await vehiclesWithoutRegistration(sql)).length : 0,
          auffaellig: canAccess(role, '/zeiterfassung/auffaellig') ? (await timeAnomalies(sql)).length : 0,
          zeit: canAccess(role, '/zeiterfassung')
            ? Number(
                (
                  await sql<{ n: number }[]>`
                    select count(*)::int as n from app.time_entries where status = 'beantragt'
                       and ${c.get('sites') ? sql`site_id = any(${c.get('sites')!}::uuid[])` : sql`true`}`
                )[0]!.n,
              )
            : 0,
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
      case 'reinigungsvertrag':
      case 'aue-vertrag': {
        const art = typ === 'aue-vertrag' ? 'aue' : 'reinigung';
        if (objekt) return c.redirect(`/objekte/${objekt}/vertrag?art=${art}`);
        if (kunde) return c.redirect(`/kunden/${kunde}/vertrag?art=${art}`);
        return c.redirect('/kunden');
      }
      case 'material':
        return c.redirect(`/materialausgabe/neu${qs({ objekt })}`);
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
      ...(taskViewerOf(c) ? { taskViewer: taskViewerOf(c)! } : {}),
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
      // nur die Startseite zurücksetzen – andere Einstellungen (Menü-Position) bleiben
      await sql`update app.user_prefs set dashboard = null, updated_at = now() where user_id = ${uid}`;
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
              tasks={await listTasks(sql, { status, onlyFor: taskViewerOf(c) })}
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

  /** Objektleitung: nur ihr zugeordnete bzw. selbst angelegte Aufgaben */
  const assertTaskVisible = async (c: Context<AppEnv>, id: string) => {
    const viewer = taskViewerOf(c);
    if (!viewer) return;
    const [ok] = await sql`select 1 from app.tasks t where t.id = ${id} and ${taskVisibleTo(sql, viewer)}`;
    if (!ok) throw new BusinessError('Diese Aufgabe ist Ihnen nicht zugeordnet');
  };
  const safeBack = (v: unknown, fallback: string) =>
    typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : fallback;

  app.get(`/aufgaben/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    await assertTaskVisible(c, id);
    const task = await getTask(sql, id);
    if (!task) return c.notFound();
    const ref = c.req.header('referer');
    let backTo = safeBack(c.req.query('zurueck'), '');
    if (!backTo && ref) {
      const u = new URL(ref);
      if (u.host === new URL(c.req.url).host && !u.pathname.endsWith('/bearbeiten'))
        backTo = u.pathname + u.search;
    }
    return page(
      c,
      'Aufgabe bearbeiten',
      'kunden',
      <>
        <PageHead title="Aufgabe bearbeiten" />
        <TaskEditForm task={task} back={backTo || '/aufgaben'} users={await assigneeOptions(sql)} />
      </>,
    );
  });

  app.post(`/aufgaben/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    await assertTaskVisible(c, id);
    const body = await c.req.parseBody();
    const parsed = taskEditInput.safeParse(body);
    if (!parsed.success) throw new BusinessError(parsed.error.issues.map((i) => i.message).join('\n'));
    await updateTask(sql, id, parsed.data, c.get('actor'));
    return back(c, safeBack(body.back, '/aufgaben'), { ok: 'Aufgabe gespeichert.' });
  });

  app.post(`/aufgaben/:id{${UUID}}/erledigt`, async (c) => {
    const body = await c.req.parseBody();
    const viewer = taskViewerOf(c);
    if (viewer) {
      const [ok] =
        await sql`select 1 from app.tasks t where t.id = ${c.req.param('id')} and ${taskVisibleTo(sql, viewer)}`;
      if (!ok) throw new BusinessError('Diese Aufgabe ist Ihnen nicht zugeordnet');
    }
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
    const vouchers: string[] = [];
    for (const k of Object.keys(b)) {
      const m = /^pay_([0-9a-f-]{36})$/.exec(k);
      if (!m) continue;
      const raw = String(b[k] ?? '').trim();
      const rv = b[`rest_${m[1]}`];
      const rest = rv === 'skonto' ? 'skonto' : rv === 'kuerzung' ? 'kuerzung' : 'offen';
      if (!raw && rest === 'offen') continue;
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
          reason: typeof b[`grund_${m[1]}`] === 'string' ? String(b[`grund_${m[1]}`]) : null,
          actor: c.get('actor'),
        });
        n++;
        paid += r.paid;
        skonto += r.skonto;
        // Kürzung: interner Buchungsbeleg für den Steuerberater (Ahmed 15.10.)
        if (rest === 'kuerzung' && r.skonto > 0n) {
          const v = await createReductionVoucher(sql, uploadConfig(ctx), {
            key: `${batch}:${m[1]}`,
            invoiceId: m[1]!,
            legacy: b[`lg_${m[1]}`] === '1',
            grossCents: r.skonto,
            date,
            reason: String(b[`grund_${m[1]}`] ?? ''),
            actor: c.get('actor'),
          });
          vouchers.push(v.number);
        }
      } catch (e) {
        if (!(e instanceof BusinessError)) throw e;
        errors.push(e.message);
      }
    }
    if (!n && !errors.length)
      throw new BusinessError('Bitte bei mindestens einer Rechnung einen Betrag eintragen');
    const msg = `${anz(n, 'Rechnung', 'Rechnungen')}: ${euro(paid)} Zahlung${skonto ? `, ${euro(skonto)} ausgebucht` : ''}${vouchers.length ? ` · Kürzungsbeleg ${vouchers.join(', ')} erstellt (Kunde → Dokumente, Rechnungen → Kürzungsbelege)` : ''}`;
    return back(c, '/offene-posten', errors.length ? { fehler: [msg, ...errors].join('\n') } : { ok: msg });
  });

  // Ein Klick: offenen Betrag einer Rechnung als bezahlt buchen (Ahmed 09.10.: „einfach abhaken“)
  app.post('/offene-posten/bezahlt', async (c) => {
    const b = await c.req.parseBody();
    const [id, cents, lg] = String(b.voll ?? '').split('|');
    if (!id || !/^[0-9a-f-]{36}$/.test(id) || !/^\d+$/.test(cents ?? ''))
      throw new BusinessError('Rechnung nicht erkannt');
    const r = await settleOpenItem(sql, {
      batchId: typeof b.batch === 'string' && /^[0-9a-f-]{36}$/.test(b.batch) ? b.batch : randomUUID(),
      invoiceId: id,
      legacy: lg === '1',
      amount: BigInt(cents!),
      date: String(b.datum ?? '') || todayBerlin(),
      rest: 'offen',
      reference:
        typeof b.referenz === 'string' && b.referenz.trim() ? b.referenz.trim() : 'als bezahlt abgehakt',
      actor: c.get('actor'),
    });
    return back(c, '/offene-posten', { ok: `${euro(r.paid)} als bezahlt gebucht.` });
  });

  // Kürzungsbelege (interne Buchungsbelege, Ahmed 15.10.): Liste für den Steuerberater, CSV
  app.get('/rechnungen/kuerzungen', async (c) => {
    const year = /^\d{4}$/.test(c.req.query('jahr') ?? '') ? c.req.query('jahr')! : todayBerlin().slice(0, 4);
    const rows = await listReductionVouchers(sql, { from: `${year}-01-01`, to: `${year}-12-31` });
    if (c.req.query('format') === 'zip') {
      // alle Kürzungsbelege des Jahres als PDF für die Buchhaltung / den Steuerberater
      const files: Record<string, Uint8Array> = {};
      for (const r of rows.filter((x) => x.file_id)) {
        const [f] = await sql<
          FileRow[]
        >`select * from app.files where id = ${r.file_id} and status = 'complete'`;
        if (f)
          files[`${r.number}_Rechnung_${r.invoice_number}.pdf`] = new Uint8Array(
            await readFile(filePath(uploadConfig(ctx), f)),
          );
      }
      if (!Object.keys(files).length) throw new BusinessError(`Keine Kürzungsbelege in ${year}`);
      return new Response(zipSync(files, { level: 0 }), {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="Kuerzungsbelege_${year}.zip"`,
        },
      });
    }
    if (c.req.query('format') === 'csv') {
      const q = (v: string) => `"${v.replace(/"/g, '""').replace(/^[=+@-]/, "'$&")}"`;
      const cents = (v: bigint) => (Number(v) / 100).toFixed(2).replace('.', ',');
      const csv = [
        'Belegnr.;Belegdatum;Kundennr.;Kunde;Rechnung;Rechnungsdatum;Brutto;Netto;USt;Grund',
        ...rows.map((r) =>
          [
            r.number,
            r.voucher_date,
            r.customer_no ?? '',
            q(r.customer_name ?? ''),
            r.invoice_number,
            r.invoice_date ?? '',
            cents(r.gross_cents),
            cents(r.net_cents),
            cents(r.vat_cents),
            q(r.reason),
          ].join(';'),
        ),
      ].join('\r\n');
      return c.body(`\ufeff${csv}`, 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="Kuerzungsbelege_${year}.csv"`,
      });
    }
    const sum = rows.reduce((a, r) => a + r.gross_cents, 0n);
    return page(
      c,
      'Kürzungsbelege',
      'rechnungen',
      <>
        <PageHead title="Kürzungsbelege" crumbs={[['Offene Posten', '/offene-posten']]} />
        <p class="mut small" style="max-width:760px">
          Eigene Belege (KB-…) für Kürzungen und Verrechnungen zu Rechnungen – an der Rechnung „Kürzung /
          Verrechnung“ oder in den Offenen Posten „Rest als Kürzung ausbuchen“. Sie gehen nicht an den Kunden,
          sondern an die Buchhaltung: im DATEV-Export als Erlösminderung gebucht, PDFs hier als ZIP, Liste als
          CSV. Die Umsatzsteuer mindert sich, sobald die Kürzung endgültig ist (§ 17 UStG).
        </p>
        <form method="get" class="actions" style="margin:8px 0">
          <label for="jahr" class="small mut">
            Jahr
          </label>
          <input id="jahr" name="jahr" value={year} style="width:90px" inputmode="numeric" />
          <button class="btn sm sec">Anzeigen</button>
          <a class="btn sm sec" href={`/rechnungen/kuerzungen?jahr=${year}&format=csv`}>
            CSV
          </a>
          <a class="btn sm sec" href={`/rechnungen/kuerzungen?jahr=${year}&format=zip`}>
            Alle PDFs (ZIP)
          </a>
        </form>
        <div class="card" style="padding:0;overflow-x:auto">
          <table>
            <thead>
              <tr>
                <th>Beleg</th>
                <th>Datum</th>
                <th>Kunde</th>
                <th>Rechnung</th>
                <th class="r">Brutto</th>
                <th class="r">Netto</th>
                <th class="r">USt</th>
                <th>Grund</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colspan={8} class="mut">
                    Keine Kürzungsbelege in {year}.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr>
                  <td>{r.file_id ? <a href={`/dateien/${r.file_id}`}>{r.number}</a> : r.number}</td>
                  <td>{dateDe(r.voucher_date)}</td>
                  <td>
                    <a href={`/kunden/${r.customer_id}`}>{r.customer_name}</a>{' '}
                    <span class="mut small">{r.customer_no}</span>
                  </td>
                  <td>
                    <a href={`/rechnungen/${r.invoice_id ?? r.legacy_invoice_id}`}>{r.invoice_number}</a>
                  </td>
                  <td class="r">{euro(r.gross_cents)}</td>
                  <td class="r">{euro(r.net_cents)}</td>
                  <td class="r">{euro(r.vat_cents)}</td>
                  <td class="small">{r.reason}</td>
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr>
                  <td colspan={4}>
                    <b>Summe {year}</b>
                  </td>
                  <td class="r">
                    <b>{euro(sum)}</b>
                  </td>
                  <td colspan={3}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </>,
    );
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
        <PageHead title="Offene Posten">
          <a class="btn sm sec" href="/rechnungen/kuerzungen">
            Kürzungsbelege
          </a>
        </PageHead>
        <div class="kpis">
          <div class="kpi accent">
            <div class="l">offen gesamt</div>
            <div class="v">{euro(total)}</div>
            <div class="s">
              {anz(all.length, 'Kunde', 'Kunden')} ·{' '}
              {anz(
                all.reduce((a, g) => a + g.items.length, 0),
                'Rechnung',
                'Rechnungen',
              )}
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
          {!groups.length && <div class="card empty">Keine offenen Posten.</div>}
          <div class="op2">
            {groups.map((g) => {
              const od = g.items.filter((i) => i.overdue_days > 0);
              const maxDays = Math.max(0, ...g.items.map((i) => i.overdue_days));
              return (
                <details class="op2-g" open={groups.length <= 3 || !!q}>
                  <summary>
                    <input
                      type="checkbox"
                      aria-label={`alle von ${g.customer_name}`}
                      onclick={`event.stopPropagation();document.querySelectorAll('input[name=inv_${g.customer_id}]').forEach(function(x){x.checked=this.checked}.bind(this))`}
                    />
                    <span class="no">{g.customer_no}</span>
                    <span class="nm">{g.customer_name}</span>
                    <span class="cnt">{g.items.length} Rechn.</span>
                    {od.length > 0 ? (
                      <span class="od">
                        überfällig {euro(od.reduce((a2, i) => a2 + i.open_cents, 0n))} · bis {maxDays} T.
                      </span>
                    ) : (
                      <span class="ok2">nicht überfällig</span>
                    )}
                    <span class="sum">{euro(g.open_cents)}</span>
                  </summary>
                  <div class="tbl">
                    <table class="op2-t stack-m">
                      <thead>
                        <tr>
                          <th style="width:28px" />
                          <th>Rechnung</th>
                          <th>Datum</th>
                          <th>Fällig</th>
                          <th class="r">Fälligkeit</th>
                          <th class="r">Betrag</th>
                          <th class="r">bezahlt / verrechnet</th>
                          <th class="r">Offen</th>
                          <th>Zahlung</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.items.map((i) => {
                          const haben = i.haben.reduce((a2, h) => a2 + h.cents, 0n);
                          return (
                            <tr>
                              <td>
                                <input
                                  type="checkbox"
                                  name={`inv_${g.customer_id}`}
                                  value={i.invoice_id}
                                  aria-label={`${i.number} auswählen`}
                                />
                              </td>
                              <td data-l="Rechnung">
                                <a
                                  href={
                                    i.legacy ? `/rechnungen/${i.invoice_id}` : `/rechnungen/${i.invoice_id}`
                                  }
                                >
                                  <b>{i.number}</b>
                                </a>
                                {i.site_name && <div class="small faint">{i.site_name}</div>}
                                {i.haben.map((h) => (
                                  <div class="small mut">
                                    {dateDe(h.date)} · {h.href ? <a href={h.href}>{h.label}</a> : h.label}:{' '}
                                    {euro(h.cents)}
                                  </div>
                                ))}
                              </td>
                              <td data-l="Datum">{dateDe(i.issue_date)}</td>
                              <td data-l="Fällig">
                                {dateDe(i.due_date)}
                                {i.skonto_date && i.skonto_date >= todayBerlin() && (
                                  <div class="small" style="color:var(--ok)">
                                    Skonto bis {dateDe(i.skonto_date)}
                                  </div>
                                )}
                              </td>
                              <td class="r" data-l="Tage">
                                {/* eindeutig statt „0“ (Bedientest 10.10.: widersprach der Startseite) */}
                                {i.overdue_days > 0 ? (
                                  <span class="badge err">{i.overdue_days} T. überfällig</span>
                                ) : i.due_date ? (
                                  <span class="mut">
                                    fällig in{' '}
                                    {Math.max(
                                      0,
                                      Math.round(
                                        (Date.parse(`${i.due_date}T12:00:00Z`) -
                                          Date.parse(`${todayBerlin()}T12:00:00Z`)) /
                                          86400000,
                                      ),
                                    )}{' '}
                                    T.
                                  </span>
                                ) : (
                                  <span class="mut">–</span>
                                )}
                              </td>
                              <td class="r" data-l="Betrag">
                                {euro(i.payable_cents)}
                              </td>
                              <td class="r" data-l="bezahlt">
                                {haben > 0n ? euro(haben) : '–'}
                              </td>
                              <td class="r" data-l="Offen">
                                <b>{euro(i.open_cents)}</b>
                              </td>
                              <td data-l="Zahlung">
                                <button
                                  class="btn sm sec op2-ok"
                                  formaction="/offene-posten/bezahlt"
                                  name="voll"
                                  value={`${i.invoice_id}|${i.open_cents}|${i.legacy ? 1 : 0}`}
                                  title="Offenen Betrag als bezahlt buchen (Datum oben)"
                                  onclick={`return confirm('${i.number}: ${euro(i.open_cents)} als bezahlt buchen?')`}
                                >
                                  ✓ bezahlt
                                </button>{' '}
                                <details class="op2-p">
                                  <summary class="btn sm sec">Zahlung</summary>
                                  <div class="op2-pf">
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
                                      <option value="kuerzung">Rest als Kürzung ausbuchen</option>
                                    </select>
                                    <input
                                      name={`grund_${i.invoice_id}`}
                                      placeholder="Grund der Kürzung (bei Kürzung Pflicht)"
                                      aria-label={`Grund Kürzung ${i.number}`}
                                      style="min-width:220px"
                                    />
                                    {i.legacy && (
                                      <input type="hidden" name={`lg_${i.invoice_id}`} value="1" />
                                    )}
                                  </div>
                                </details>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </details>
              );
            })}
          </div>
          {groups.length > 0 && (
            <div class="op2-bar">
              <div class="part">
                <b>Zahlungen</b>
                <label for="op-date" class="small">
                  Datum
                </label>
                <input id="op-date" type="date" name="datum" value={todayBerlin()} style="max-width:160px" />
                <input name="referenz" placeholder="Verwendungszweck (optional)" style="max-width:200px" />
                <button class="btn">Eingetragene Zahlungen buchen</button>
              </div>
              <div class="part">
                <b>Markierte</b>
                <button class="btn sec" formaction="/mahnungen/stapel/vorschau" formtarget="_blank">
                  Mahnung als Vorschau (PDF)
                </button>
                <button
                  class="btn sec"
                  formaction="/mahnungen/stapel"
                  onclick="return confirm('Für die markierten Rechnungen je Kunde eine Mahnung erstellen? (Stufe, Mindestabstand und Mahnsperre werden geprüft)')"
                >
                  Mahnung erstellen
                </button>
                <label class="chk" style="margin:0">
                  <input type="checkbox" name="send" value="1" /> gleich per E-Mail
                </label>
              </div>
            </div>
          )}
          <style
            dangerouslySetInnerHTML={{
              __html: `.op2-g{background:#fff;border:1px solid var(--line);border-radius:8px;margin:0 0 8px}
.op2-g>summary{display:flex;align-items:center;gap:12px;padding:11px 14px;cursor:pointer;list-style:none;flex-wrap:wrap}
.op2-g>summary::-webkit-details-marker{display:none}
.op2-g>summary .no{color:var(--mut);font-variant-numeric:tabular-nums;width:52px}
.op2-g>summary .nm{font-weight:600;flex:1;min-width:180px}
.op2-g>summary .cnt{color:var(--mut);font-size:13px}
.op2-g>summary .od{color:#b42318;font-size:13px;font-weight:600}
.op2-g>summary .ok2{color:var(--mut);font-size:13px}
.op2-g>summary .sum{font-weight:700;min-width:120px;text-align:right;font-variant-numeric:tabular-nums}
.op2-g[open]>summary{border-bottom:1px solid var(--line);background:#f8f9fa}
.op2-t td,.op2-t th{padding:7px 10px}.op2-t td{vertical-align:top}
.op2-p>summary{list-style:none;display:inline-flex}.op2-p>summary::-webkit-details-marker{display:none}
.op2-pf{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.op2-pf input{width:110px}
.op2-bar{position:sticky;bottom:0;z-index:5;background:#fff;border:1px solid var(--line);border-radius:8px;padding:10px 14px;display:flex;gap:18px;flex-wrap:wrap;box-shadow:0 -4px 14px rgba(0,0,0,.06)}
.op2-bar .part{display:flex;gap:8px;align-items:center;flex-wrap:wrap}`,
            }}
          />
        </form>
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
                class="btn sec sm"
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
            sites={await sql<{ id: string; site_no: string; name: string }[]>`
              -- nur aktuelle Objekte (Ahmed 10.10.): aktives Objekt mit laufendem oder künftigem Einsatz
              select distinct s.id, s.site_no, s.name from app.shift_plans p join app.sites s on s.id = p.site_id
               where p.employee_id = ${e.id} and s.active
                 and (p.valid_until is null or p.valid_until >= ${todayBerlin()})
               order by s.site_no`}
            showPrivate
            wage={{ level: lvl?.name ?? null, cents: wage }}
            month={await monthBox(e.id)}
            afterHead={einsaetze}
            employment={beschaeftigung}
            hours={await hoursHistory(sql, e.id)}
            plannedDays={await plannedDaysPerWeek(
              sql,
              e.id,
              `${todayBerlin().slice(0, 7)}-01`,
              // Monatsende: Tag 28 + 4 liegt immer im Folgemonat
              addDays(`${addDays(`${todayBerlin().slice(0, 7)}-28`, 4).slice(0, 7)}-01`, -1),
            )}
            leave={await leaveBalance(sql, e.id, Number(todayBerlin().slice(0, 4)))
              .then((b) => ({
                rest: b.rest,
                entitlement: b.entitlement + b.carried - b.carriedExpired,
                yearEntitlement: b.entitlement,
                year: Number(todayBerlin().slice(0, 4)),
              }))
              .catch(() => null)}
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
        bogenId={bogen ? bogenId : undefined}
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
    // Krankenkasse „andere …“: freier Text statt Auswahl
    if (flat.health_insurance === '__andere')
      flat.health_insurance = String(flat.health_insurance_other ?? '').trim();
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
    // Aus dem Personalbogen angelegt: Fotos der Unterlagen in die Personalakte, Bogen erledigt
    const bogen = typeof flat.bogen === 'string' && /^[0-9a-f-]{36}$/.test(flat.bogen) ? flat.bogen : null;
    if (bogen) {
      await sql`insert into app.file_links (file_id, entity_type, entity_id, category, linked_by)
                select docs_file_id, 'employee', ${id}, 'Personalunterlagen', ${c.get('actor')}
                  from app.personnel_forms where id = ${bogen} and docs_file_id is not null
                on conflict do nothing`;
      await sql`update app.personnel_forms set status = 'uebernommen', employee_id = ${id},
                       decided_by = ${c.get('actor')}, decided_at = now()
                 where id = ${bogen} and status = 'neu'`;
    }
    // Objekt-Zuordnung nicht mehr im Stammdatenformular (Ahmed 06.10.) – entsteht über Planung/Einsätze
    return back(c, `/personal/${id}`, { ok: 'Mitarbeiter gespeichert.' });
  });

  app.post(`/personal/:id{${UUID}}/austritt`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const r = await exitEmployee(sql, id, {
      date: String(b.date ?? ''),
      reason: typeof b.reason === 'string' ? b.reason : null,
      actor: c.get('actor'),
    });
    return back(c, `/personal/${id}`, {
      ok:
        'Austritt gespeichert.' +
        (r.ended ? ` ${r.ended} Einsätze enden am Austrittstag.` : '') +
        (r.opened
          ? ` ${r.opened} Einsätze beginnen erst danach – sie sind jetzt offen (bitte neu besetzen).`
          : ''),
    });
  });

  app.post(`/personal/:id{${UUID}}/nicht-angetreten`, async (c) => {
    const id = c.req.param('id');
    const r = await markNotStarted(sql, id, c.get('actor'));
    return back(c, `/personal/${id}`, {
      ok:
        'Als „nicht angetreten“ erfasst (Austritt = Eintrittstag).' +
        (r.shifts ? ` ${r.shifts} Einsätze sind wieder offen – bitte in der Planung neu besetzen.` : '') +
        (r.absences ? ` ${r.absences} Abwesenheiten storniert.` : '') +
        ' Lohnbüro: SV-Anmeldung ggf. stornieren.',
    });
  });

  app.post(`/personal/:id{${UUID}}/austritt-zuruecknehmen`, async (c) => {
    const id = c.req.param('id');
    await revokeExit(sql, id, c.get('actor'));
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
