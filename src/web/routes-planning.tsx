import { EmployeePlanList, type PlanRowLite, type SiteLite } from './pages-employee-calendar.js';
import { safeReturn } from './routes-planning-board.js';
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Child, FC } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, holidayName, isoWeekday } from '../domain/time/holidays.js';
import {
  type AbsenceKind,
  type AbsenceRow,
  ABSENCE_LABEL,
  ABSENCE_STATUS_LABEL,
  decideAbsence,
  deleteAbsence,
  getAbsence,
  updateAbsence,
  leaveBalance,
  listAbsences,
  requestAbsence,
} from '../services/absences.js';
import { listEmployees } from '../services/employees.js';
import { BusinessError } from '../services/errors.js';
import {
  type ShiftPlanRow,
  WEEKDAYS,
  WEEKDAYS_SHORT,
  deleteShiftPlans,
  endShiftPlan,
  hm,
  listShiftPlans,
  plannedShifts,
} from '../services/time.js';
import { type AppEnv, type Ctx, UUID, assertSite } from './app.js';
import {
  CAL_VIEWS,
  type CalView,
  CalSummary,
  NextShifts,
  SiteCalendar,
  calRange,
} from './pages-site-calendar.js';
import { PageHead, type Tab, Tabs, dateDe } from './layout.js';
import { renderTablePdf } from '../pdf/table.js';

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v);
const ABS_CLASS: Record<AbsenceKind, string> = {
  urlaub: 'info',
  krank: 'err',
  kind_krank: 'err',
  unbezahlt: '',
  sonstiges: '',
};
const UK_CSS = `
.uk-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.uk-nav{display:flex;align-items:center;gap:8px}.uk-nav b{min-width:130px;text-align:center;font-size:17px}
.uk-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:12px}
.uk-kpis>div{background:#fff;border:1px solid var(--line);border-radius:8px;padding:10px 14px}
.uk-kpis span{display:block;font-size:12px;color:var(--mut)}.uk-kpis b{font-size:22px}
.uk-filter{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.uk-filter input[name=q]{max-width:220px}.uk-filter select{max-width:170px}
.uk-legend{display:flex;gap:10px;flex-wrap:wrap;margin-left:auto;font-size:12px;color:var(--mut)}
.uk-legend i{display:inline-block;width:14px;height:10px;border-radius:3px;margin-right:4px;vertical-align:-1px}
.uk-wrap{overflow:auto;max-height:75vh}
table.uk{border-collapse:separate;border-spacing:0;font-size:12px;width:100%}
table.uk th,table.uk td{padding:0;height:30px;vertical-align:middle;border-bottom:1px solid var(--line);text-align:center;min-width:26px}
table.uk thead th{position:sticky;top:0;background:#f7f7f9;z-index:2;font-weight:600;line-height:1.1;padding:4px 0}
table.uk thead th span{display:block;font-size:10px;font-weight:400;color:var(--mut)}
table.uk .uk-name{position:sticky;left:0;background:#fff;z-index:1;text-align:left;padding:0 10px;white-space:nowrap;min-width:190px}
table.uk thead .uk-name{z-index:3;background:#f7f7f9}
table.uk td.off,table.uk th.off{background:#f1f2f5}
table.uk th.today{background:#fff3c4}table.uk td.today{box-shadow:inset 1px 0 #e0b800,inset -1px 0 #e0b800}
table.uk td.r,table.uk th.r{padding:0 8px;text-align:right;min-width:34px}
.uk-b{display:block;height:20px;margin:0 -1px;line-height:20px;font-weight:700;font-size:11px;color:#fff;text-decoration:none}
.uk-b.s{margin-left:3px;border-top-left-radius:6px;border-bottom-left-radius:6px}
.uk-b.e{margin-right:3px;border-top-right-radius:6px;border-bottom-right-radius:6px}
.uk-b.o{opacity:.45}.uk-b.req{opacity:.5;background-image:repeating-linear-gradient(45deg,transparent 0 4px,rgba(255,255,255,.35) 4px 8px)}
.uk-urlaub{background:#3d72d6}.uk-krank{background:#d0473b}.uk-kind_krank{background:#e08a2c}
.uk-unbezahlt{background:#7b8191}.uk-sonstiges{background:#8a5cc7}
@media (max-width:760px){.uk-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.uk-legend{margin-left:0}
table.uk .uk-name{min-width:130px;max-width:130px;overflow:hidden;text-overflow:ellipsis}}
`;

const ABS_CODE: Record<AbsenceKind, string> = {
  urlaub: 'U',
  krank: 'K',
  kind_krank: 'KK',
  unbezahlt: 'UB',
  sonstiges: 'S',
};

const PlanTable: FC<{ plans: ShiftPlanRow[]; show: 'employee' | 'site' | 'both'; ret?: string }> = ({
  plans,
  show,
  ret,
}) => (
  <div class="tbl">
    <table>
      <thead>
        <tr>
          <th>Tag</th>
          <th>Zeit</th>
          <th class="r">Std.</th>
          {show !== 'site' && <th>Mitarbeiter</th>}
          {show !== 'employee' && <th>Objekt</th>}
          <th>gültig</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {plans.length === 0 && (
          <tr>
            <td colspan={7}>
              <div class="empty">Noch keine Einsätze geplant.</div>
            </td>
          </tr>
        )}
        {plans.map((p) => {
          const [sh, sm] = p.start_time.split(':').map(Number) as [number, number];
          const [eh, em] = p.end_time.split(':').map(Number) as [number, number];
          const ended = p.valid_until && p.valid_until < todayBerlin();
          return (
            <tr style={ended ? 'opacity:.5' : ''}>
              <td>{WEEKDAYS[p.weekday]}</td>
              <td>
                {p.start_time}–{p.end_time}
                {p.break_minutes > 0 && <span class="mut small"> ({p.break_minutes} Min. Pause)</span>}
              </td>
              <td class="r">{hm(eh * 60 + em - sh * 60 - sm - p.break_minutes)}</td>
              {show !== 'site' && (
                <td>
                  <a href={`/personal/${p.employee_id}/einsaetze`}>{p.employee_name}</a>
                </td>
              )}
              {show !== 'employee' && (
                <td>
                  <a href={`/objekte/${p.site_id}/einsaetze`}>{p.site_name}</a>
                </td>
              )}
              <td class="small">
                ab {dateDe(p.valid_from)}
                {p.valid_until && ` bis ${dateDe(p.valid_until)}`}
              </td>
              <td>
                <a
                  class="btn sm sec"
                  href={`/einsatzplanung/${p.id}${ret ? `?zurueck=${encodeURIComponent(ret)}` : ''}`}
                >
                  Ändern
                </a>{' '}
                <form
                  method="post"
                  action={`/einsatzplanung/${p.id}/loeschen`}
                  style="display:inline"
                  onsubmit="return confirm('Einsatz löschen? Schon erfasste Zeiten bleiben erhalten.')"
                >
                  {ret && <input type="hidden" name="zurueck" value={ret} />}
                  <button class="btn sm sec">Löschen</button>
                </form>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

export function registerPlanningRoutes({ app, deps, page, back, shells }: Ctx) {
  const { sql } = deps;

  // Tafel und „Termin oder Terminserie planen“: routes-planning-board.tsx

  app.post(`/einsatzplanung/:id{${UUID}}/beenden`, async (c) => {
    const b = await c.req.parseBody();
    if (!isDate(b.last_day)) throw new BusinessError('Datum ungültig');
    const [old] = await sql<
      { site_id: string }[]
    >`select site_id from app.shift_plans where id = ${c.req.param('id')}`;
    assertSite(c, old?.site_id);
    if (b.serie === '1') {
      // ganze Terminserie beenden
      const plans = await sql<{ id: string }[]>`
        select id from app.shift_plans
         where series_id = (select coalesce(series_id, id) from app.shift_plans where id = ${c.req.param('id')})
           and (valid_until is null or valid_until > ${b.last_day})`;
      for (const p of plans) await endShiftPlan(sql, p.id, b.last_day, c.get('actor'));
      return back(c, safeReturn(b.zurueck), { ok: 'Terminserie beendet.' });
    }
    await endShiftPlan(sql, c.req.param('id'), b.last_day, c.get('actor'));
    return back(c, safeReturn(b.zurueck), { ok: 'Einsatz beendet.' });
  });

  // Einsatz bzw. ganze Terminserie löschen (erfasste Zeiten bleiben, nur die Verknüpfung entfällt)
  // mehrere Einsätze auf einmal löschen (Einsatzliste beim Mitarbeiter: alle Wochentage einer Zeile)
  app.post('/einsatzplanung/loeschen', async (c) => {
    const b = await c.req.parseBody({ all: true });
    const ids = ([] as unknown[])
      .concat(b.ids ?? [])
      .map(String)
      .filter((x) => /^[0-9a-f-]{36}$/.test(x));
    if (!ids.length) return back(c, safeReturn(b.zurueck), { ok: 'Nichts ausgewählt.' });
    const rows = await sql<{ id: string; site_id: string }[]>`
      select id, site_id from app.shift_plans where id in ${sql(ids)}`;
    for (const r of rows) assertSite(c, r.site_id);
    const n = await deleteShiftPlans(
      sql,
      rows.map((r) => r.id),
      c.get('actor'),
    );
    return back(c, safeReturn(b.zurueck), {
      ok: `${n} Einsatz/Einsätze gelöscht – erfasste Zeiten bleiben.`,
    });
  });

  app.post(`/einsatzplanung/:id{${UUID}}/loeschen`, async (c) => {
    const b = await c.req.parseBody();
    const id = c.req.param('id');
    const [old] = await sql<
      { site_id: string; series_id: string | null }[]
    >`select site_id, series_id from app.shift_plans where id = ${id}`;
    if (!old) return back(c, safeReturn(b.zurueck), { ok: 'Einsatz war schon gelöscht.' });
    assertSite(c, old.site_id);
    const ids =
      b.serie === '1'
        ? (
            await sql<{ id: string; site_id: string }[]>`
              select id, site_id from app.shift_plans where coalesce(series_id, id) = ${old.series_id ?? id}`
          ).map((p) => {
            assertSite(c, p.site_id);
            return p.id;
          })
        : [id];
    const n = await deleteShiftPlans(sql, ids, c.get('actor'));
    return back(c, safeReturn(b.zurueck), { ok: n > 1 ? `${n} Einsätze gelöscht.` : 'Einsatz gelöscht.' });
  });

  app.get(`/personal/:id{${UUID}}/einsaetze`, (c) =>
    shells.employee!(c, 'einsaetze', async (e) => {
      const today = todayBerlin();
      const ret = `/personal/${e.id}/einsaetze`;
      const [plans, last7] = await Promise.all([
        listShiftPlans(sql, { employeeId: e.id }),
        plannedShifts(sql, { from: addDays(today, -7), to: addDays(today, -1), employeeId: e.id }),
      ]);
      const siteIds = [...new Set(plans.map((p) => p.site_id))];
      const sites = siteIds.length
        ? await sql<SiteLite[]>`
            select s.id, c.name as customer_name, s.street, s.postal_code, s.city
              from app.sites s join app.customers c on c.id = s.customer_id where s.id in ${sql(siteIds)}`
        : [];
      const recent = new Map<string, { total: number; done: number }>();
      for (const s of last7) {
        if (s.absence || s.holiday || s.exception?.kind === 'ausfall') continue;
        const r = recent.get(s.plan.site_id) ?? { total: 0, done: 0 };
        r.total++;
        if (s.entry && s.entry.status !== 'abgelehnt') r.done++;
        recent.set(s.plan.site_id, r);
      }
      return (
        <>
          <EmployeePlanList
            employeeId={e.id}
            plans={plans as unknown as PlanRowLite[]}
            sites={sites}
            recent={recent}
            today={today}
            ret={ret}
            canEdit={['admin', 'personal', 'objektleitung'].includes(c.get('user').role)}
          />
          <details style="margin-top:10px">
            <summary class="small mut">Einzelne Einträge (Ändern, Beenden, Löschen)</summary>
            <PlanTable plans={plans} show="site" ret={ret} />
          </details>
        </>
      );
    }),
  );

  app.get(`/objekte/:id{${UUID}}/einsaetze`, (c) =>
    shells.site!(c, 'einsaetze', async (s) => {
      const today = todayBerlin();
      const q = c.req.query('ansicht');
      const view: CalView = CAL_VIEWS.some(([k]) => k === q) ? (q as CalView) : 'woche';
      const datum = c.req.query('datum');
      const date = datum && /^\d{4}-\d{2}-\d{2}$/.test(datum) ? datum : today;
      const base = `/objekte/${s.id}/einsaetze`;
      const year = date.slice(0, 4);
      const [shifts, yearShifts, upcoming] = await Promise.all([
        view === 'liste'
          ? Promise.resolve([])
          : plannedShifts(sql, { siteId: s.id, ...calRange(view, date), includeCancelled: true }),
        plannedShifts(sql, { siteId: s.id, from: `${year}-01-01`, to: `${year}-12-31` }),
        plannedShifts(sql, { siteId: s.id, from: today, to: addDays(today, 60) }),
      ]);
      const now = new Date().toLocaleTimeString('de-DE', {
        timeZone: 'Europe/Berlin',
        hour: '2-digit',
        minute: '2-digit',
      });
      const next = upcoming
        .filter((x) => !x.holiday && (x.date > today || x.plan.end_time > now))
        .slice(0, 15);
      return (
        <>
          <div class="actions" style="margin-top:0">
            <a
              class="btn sm"
              href={`/einsatzplanung/${randomUUID()}?objekt=${s.id}&zurueck=${encodeURIComponent(`/objekte/${s.id}/einsaetze`)}`}
            >
              + Einsatz planen
            </a>
            <a class="btn sm sec" href={`/einsatzplanung/vertretungen`}>
              Einsätze für abwesende Mitarbeiter
            </a>
          </div>
          {view === 'liste' ? (
            <>
              <SiteCalendar base={base} view={view} date={date} today={today} shifts={[]} />
              <PlanTable
                plans={await listShiftPlans(sql, { siteId: s.id })}
                show="employee"
                ret={`/objekte/${s.id}/einsaetze`}
              />
            </>
          ) : (
            <SiteCalendar
              base={base}
              view={view}
              date={date}
              today={today}
              shifts={shifts}
              canDeleteTime={['admin', 'personal'].includes(c.get('user').role)}
            />
          )}
          <div class="cal-side">
            <CalSummary year={year} month={date.slice(0, 7)} yearShifts={yearShifts} />
            <NextShifts shifts={next} />
          </div>
        </>
      );
    }),
  );

  // ------------------------------------------------------------------ Urlaub & Abwesenheiten

  const AbsenceForm: FC<{
    employees?: { id: string; name: string }[];
    employeeId?: string;
    action: string;
  }> = ({ employees, employeeId, action }) => (
    <form method="post" action={action} class="card">
      <h3>Abwesenheit erfassen</h3>
      <input type="hidden" name="id" value={randomUUID()} />
      {employeeId && <input type="hidden" name="employee_id" value={employeeId} />}
      <div class="grid">
        {employees && (
          <div>
            <label for="employee_id">Mitarbeiter</label>
            <select id="employee_id" name="employee_id" required>
              <option value="">– bitte wählen –</option>
              {employees.map((e) => (
                <option value={e.id}>{e.name}</option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label for="kind">Art</label>
          <select id="kind" name="kind">
            {(Object.keys(ABSENCE_LABEL) as AbsenceKind[]).map((k) => (
              <option value={k}>{ABSENCE_LABEL[k]}</option>
            ))}
          </select>
        </div>
        <div>
          <label for="start">von</label>
          <input id="start" type="date" name="start" required />
        </div>
        <div>
          <label for="end">bis</label>
          <input id="end" type="date" name="end" required />
        </div>
        <div class="chk" style="align-self:end;height:38px">
          <input type="checkbox" id="half_day" name="half_day" value="1" />
          <label for="half_day">halber Tag</label>
        </div>
      </div>
      <div style="margin-top:10px">
        <label for="note">Notiz (z. B. AU liegt vor)</label>
        <input id="note" name="note" />
      </div>
      <p class="small mut">
        Vom Büro erfasste Abwesenheiten gelten sofort als genehmigt und automatisch für die geplanten Einsätze
        (geplante Stunden; unbezahlt frei = unbezahlt). Abweichende Stunden danach unter „Stunden je Einsatz“.
      </p>
      <div class="formfoot">
        <button class="btn">Erfassen</button>
      </div>
    </form>
  );

  const AbsenceTable: FC<{ rows: AbsenceRow[]; showEmployee?: boolean; decide?: boolean }> = ({
    rows,
    showEmployee = true,
    decide = true,
  }) => (
    <div class="tbl">
      <table>
        <thead>
          <tr>
            {showEmployee && <th>Mitarbeiter</th>}
            <th>Art</th>
            <th>Zeitraum</th>
            <th class="r">Arbeitstage</th>
            <th>Status</th>
            <th>Notiz</th>
            {decide && <th></th>}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colspan={7}>
                <div class="empty">Keine Einträge.</div>
              </td>
            </tr>
          )}
          {rows.map((a) => (
            <tr style={['abgelehnt', 'storniert'].includes(a.status) ? 'opacity:.55' : ''}>
              {showEmployee && (
                <td>
                  <span class="mut small">{a.personnel_no}</span>{' '}
                  <a href={`/personal/${a.employee_id}/abwesenheiten`}>{a.employee_name}</a>
                </td>
              )}
              <td>
                <span class={`badge ${ABS_CLASS[a.kind]}`}>{ABSENCE_LABEL[a.kind]}</span>
              </td>
              <td>
                {dateDe(a.start_date)}
                {a.end_date !== a.start_date && ` – ${dateDe(a.end_date)}`}
                {a.half_day && ' (halb)'}
              </td>
              <td class="r">{String(a.days).replace('.', ',')}</td>
              <td>
                <span
                  class={`badge ${a.status === 'genehmigt' ? 'ok' : a.status === 'beantragt' ? 'warn' : ''}`}
                >
                  {ABSENCE_STATUS_LABEL[a.status]}
                </span>
                {a.status === 'genehmigt' && (
                  <div>
                    <a class="small" href={`/urlaub/${a.id}/stunden`}>
                      Stunden je Einsatz
                    </a>
                  </div>
                )}
              </td>
              <td class="small">{a.note ?? ''}</td>
              {decide && (
                <td>
                  <div class="actions" style="margin:0;flex-wrap:nowrap">
                    {a.status === 'beantragt' && (
                      <>
                        <form method="post" action={`/urlaub/${a.id}/status`}>
                          <input type="hidden" name="status" value="genehmigt" />
                          <button class="btn sm">Genehmigen</button>
                        </form>
                        <form method="post" action={`/urlaub/${a.id}/status`}>
                          <input type="hidden" name="status" value="abgelehnt" />
                          <button class="btn sm danger">Ablehnen</button>
                        </form>
                      </>
                    )}
                    {['beantragt', 'genehmigt'].includes(a.status) && (
                      <a class="btn sm sec" href={`/urlaub/${a.id}/bearbeiten`}>
                        Ändern
                      </a>
                    )}
                    {['abgelehnt', 'storniert'].includes(a.status) && (
                      <a class="btn sm ghost" href={`/urlaub/${a.id}/bearbeiten`}>
                        Löschen …
                      </a>
                    )}
                    {a.status === 'genehmigt' && a.end_date >= todayBerlin() && (
                      <form
                        method="post"
                        action={`/urlaub/${a.id}/status`}
                        onsubmit="return confirm('Abwesenheit stornieren?')"
                      >
                        <input type="hidden" name="status" value="storniert" />
                        <button class="btn sm ghost">Stornieren</button>
                      </form>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const urlaubShell = async (c: Context<AppEnv>, active: string, body: Child) => {
    const open = await listAbsences(sql, { status: ['beantragt'] });
    const tabs: Tab[] = [
      { key: 'offen', label: 'Offene Anträge', href: '/urlaub', count: open.length },
      { key: 'kalender', label: 'Kalender', href: '/urlaub/kalender' },
      { key: 'alle', label: 'Alle', href: '/urlaub/alle' },
    ];
    return page(
      c,
      'Urlaub & Abwesenheiten',
      'disposition',
      <>
        <PageHead title="Urlaub & Abwesenheiten" />
        <Tabs tabs={tabs} active={active} />
        {body}
      </>,
    );
  };

  app.get('/urlaub', async (c) => {
    const [open, emps] = await Promise.all([
      listAbsences(sql, { status: ['beantragt'] }),
      listEmployees(sql, { status: 'aktiv' }),
    ]);
    return urlaubShell(
      c,
      'offen',
      <div class="cols">
        <AbsenceTable rows={open} />
        <AbsenceForm
          employees={emps.map((e) => ({ id: e.id, name: `${e.last_name}, ${e.first_name}` }))}
          action="/urlaub"
        />
      </div>,
    );
  });

  app.get('/urlaub/alle', async (c) => {
    const year = todayBerlin().slice(0, 4);
    return urlaubShell(
      c,
      'alle',
      <AbsenceTable rows={await listAbsences(sql, { from: `${Number(year) - 1}-01-01` })} />,
    );
  });

  /** Urlaubskalender-Daten (Monat, Filter Art/Suche/nur mit Abwesenheit) – auch für PDF/CSV. */
  const calendarData = async (c: Context<AppEnv>) => {
    const month = isMonth(c.req.query('monat')) ? c.req.query('monat')! : todayBerlin().slice(0, 7);
    const kind = (c.req.query('art') ?? '') as AbsenceKind | '';
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    // Standard: nur Personen mit Abwesenheit im Monat (bei 200+ Mitarbeitenden sonst eine leere Liste)
    const onlyAbsent = c.req.query('alle') !== '1' || c.req.query('nur') === '1';
    const withRequested = c.req.query('beantragt') !== '0';
    const from = `${month}-01`;
    const to = addDays(`${addDays(from, 32).slice(0, 7)}-01`, -1);
    const [allEmps, allAbs] = await Promise.all([
      listEmployees(sql, { status: 'aktiv' }),
      listAbsences(sql, { from, to, status: withRequested ? ['beantragt', 'genehmigt'] : ['genehmigt'] }),
    ]);
    const abs = allAbs.filter((a) => !kind || a.kind === kind);
    const emps = allEmps.filter(
      (e) =>
        (!q || `${e.last_name} ${e.first_name} ${e.personnel_no}`.toLowerCase().includes(q)) &&
        (!onlyAbsent || abs.some((a) => a.employee_id === e.id)),
    );
    const days: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const cell = (empId: string, d: string) =>
      abs.find((x) => x.employee_id === empId && x.start_date <= d && x.end_date >= d);
    const off = (d: string) => isoWeekday(d) >= 6 || !!holidayName(d);
    // Tage je Mitarbeiter (nur Arbeitstage)
    const totals = (empId: string) => {
      const t: Partial<Record<AbsenceKind, number>> = {};
      for (const d of days) {
        const a = cell(empId, d);
        if (a && !off(d)) t[a.kind] = (t[a.kind] ?? 0) + (a.half_day ? 0.5 : 1);
      }
      return t;
    };
    const label = new Date(`${from}T12:00:00Z`).toLocaleDateString('de-DE', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    return { month, kind, q, onlyAbsent, withRequested, from, to, emps, abs, days, cell, off, totals, label };
  };
  const qsOf = (d: Awaited<ReturnType<typeof calendarData>>, monat = d.month) => {
    const p = new URLSearchParams({ monat });
    if (d.kind) p.set('art', d.kind);
    if (d.q) p.set('q', d.q);
    if (!d.onlyAbsent) p.set('alle', '1');
    if (!d.withRequested) p.set('beantragt', '0');
    return p.toString();
  };
  const fmtDays = (n: number | undefined) => (n ? String(n).replace('.', ',') : '');

  app.get('/urlaub/kalender', async (c) => {
    const d = await calendarData(c);
    const { from, to, emps, days, cell, off, totals } = d;
    const prev = addDays(from, -1).slice(0, 7);
    const next = addDays(to, 1).slice(0, 7);
    const today = todayBerlin();
    const open = d.abs.filter((a) => a.status === 'beantragt').length;
    const sum = (k: AbsenceKind[]) =>
      emps.reduce((s, e) => s + k.reduce((x, kk) => x + (totals(e.id)[kk] ?? 0), 0), 0);
    const absentToday = new Set(
      d.abs
        .filter((a) => a.status === 'genehmigt' && a.start_date <= today && a.end_date >= today)
        .map((a) => a.employee_id),
    ).size;
    return urlaubShell(
      c,
      'kalender',
      <>
        <div class="uk-bar">
          <div class="uk-nav">
            <a class="btn sec sm" href={`/urlaub/kalender?${qsOf(d, prev)}`} aria-label="Vormonat">
              ←
            </a>
            <b>{d.label}</b>
            <a class="btn sec sm" href={`/urlaub/kalender?${qsOf(d, next)}`} aria-label="Folgemonat">
              →
            </a>
            {d.month !== today.slice(0, 7) && (
              <a class="btn sec sm" href={`/urlaub/kalender?${qsOf(d, today.slice(0, 7))}`}>
                Heute
              </a>
            )}
          </div>
          <span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">
            <a class="btn sm" href="/urlaub">
              + Abwesenheit eintragen
            </a>
            <a class="btn sec sm" href={`/urlaub/kalender.pdf?${qsOf(d)}`} target="_blank">
              PDF
            </a>
            <a class="btn sec sm" href={`/urlaub/kalender.csv?${qsOf(d)}`}>
              Excel (CSV)
            </a>
          </span>
        </div>
        <div class="uk-kpis">
          <div>
            <span>heute abwesend</span>
            <b>{absentToday}</b>
          </div>
          <div>
            <span>Urlaubstage im Monat</span>
            <b>{fmtDays(sum(['urlaub'])) || '0'}</b>
          </div>
          <div>
            <span>Krankheitstage im Monat</span>
            <b>{fmtDays(sum(['krank', 'kind_krank'])) || '0'}</b>
          </div>
          <div>
            <span>offene Anträge</span>
            <b>{open ? <a href="/urlaub">{open}</a> : '0'}</b>
          </div>
        </div>
        <form method="get" class="uk-filter">
          <input type="hidden" name="monat" value={d.month} />
          <input name="q" value={d.q} placeholder="Name oder Pers.-Nr." aria-label="Suche" />
          <select name="art" onchange="this.form.submit()" aria-label="Art" data-nosearch>
            <option value="">Alle Arten</option>
            {(Object.keys(ABSENCE_LABEL) as AbsenceKind[]).map((k) => (
              <option value={k} selected={k === d.kind}>
                {ABSENCE_LABEL[k]}
              </option>
            ))}
          </select>
          <label class="chk" style="margin:0">
            <input
              type="checkbox"
              name="alle"
              value="1"
              checked={!d.onlyAbsent}
              onchange="this.form.submit()"
            />
            alle Mitarbeitenden
          </label>
          <label class="chk" style="margin:0">
            <input
              type="checkbox"
              name="beantragt"
              value="0"
              checked={!d.withRequested}
              onchange="this.form.submit()"
            />
            nur genehmigte
          </label>
          <button class="btn sec sm">Suchen</button>
          <span class="uk-legend">
            {(Object.keys(ABSENCE_LABEL) as AbsenceKind[]).map((k) => (
              <span>
                <i class={`uk-${k}`} />
                {ABSENCE_LABEL[k]}
              </span>
            ))}
            <span>
              <i class="uk-urlaub" style="opacity:.45" />
              beantragt
            </span>
          </span>
        </form>
        {emps.length === 0 ? (
          <div class="card">
            <div class="empty">
              {d.abs.length === 0 ? (
                <>
                  Im {d.label} sind keine Abwesenheiten erfasst.
                  <div class="small mut" style="margin-top:6px">
                    Aus Fortytools kommen nur die Summen (Urlaubskonten, Krankheitstage) – einzelne Tage erst,
                    wenn sie hier oder in der Handy-App eingetragen werden.{' '}
                    <a href="/auswertungen/urlaub">Urlaubskonten ansehen</a>
                  </div>
                </>
              ) : (
                'Keine Mitarbeitenden für diesen Filter.'
              )}
            </div>
          </div>
        ) : (
          <div class="card" style="padding:0">
            <div class="uk-wrap">
              <table class="uk">
                <thead>
                  <tr>
                    <th class="uk-name">Mitarbeiter</th>
                    {days.map((x) => (
                      <th
                        class={`${off(x) ? 'off' : ''}${x === today ? ' today' : ''}`}
                        title={holidayName(x) ?? ''}
                      >
                        <span>{WEEKDAYS_SHORT[isoWeekday(x)]?.slice(0, 2)}</span>
                        {Number(x.slice(8))}
                      </th>
                    ))}
                    <th class="r" title="Urlaubstage im Monat">
                      U
                    </th>
                    <th class="r" title="Krankheitstage im Monat">
                      K
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {emps.map((e) => {
                    const t = totals(e.id);
                    return (
                      <tr>
                        <td class="uk-name">
                          <a href={`/personal/${e.id}/abwesenheiten`}>
                            {e.last_name}, {e.first_name}
                          </a>
                          <span class="mut small"> {e.personnel_no}</span>
                        </td>
                        {days.map((x) => {
                          const a = cell(e.id, x);
                          const o = off(x);
                          const startBar = a && (x === a.start_date || x === from);
                          const endBar = a && (x === a.end_date || x === to);
                          return (
                            <td
                              class={`${o ? 'off' : ''}${x === today ? ' today' : ''}`}
                              title={
                                a
                                  ? `${ABSENCE_LABEL[a.kind]} ${dateDe(a.start_date)}–${dateDe(a.end_date)} (${ABSENCE_STATUS_LABEL[a.status]})`
                                  : (holidayName(x) ?? '')
                              }
                            >
                              {a && (
                                <a
                                  href={`/urlaub/${a.id}/bearbeiten`}
                                  class={`uk-b uk-${a.kind}${a.status === 'beantragt' ? ' req' : ''}${startBar ? ' s' : ''}${endBar ? ' e' : ''}${o ? ' o' : ''}`}
                                >
                                  {startBar && !o ? ABS_CODE[a.kind] : ''}
                                </a>
                              )}
                            </td>
                          );
                        })}
                        <td class="r">{fmtDays(t.urlaub)}</td>
                        <td class="r">{fmtDays((t.krank ?? 0) + (t.kind_krank ?? 0) || undefined)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <p class="small mut">
          Tage = Arbeitstage ohne Wochenende/Feiertag. Balken anklicken = Abwesenheit ändern.
        </p>
        <style dangerouslySetInnerHTML={{ __html: UK_CSS }} />
      </>,
    );
  });

  app.get('/urlaub/kalender.csv', async (c) => {
    const d = await calendarData(c);
    const safe = (v: string) => (/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/;/g, ',');
    const head = ['Personalnummer', 'Name', ...d.days.map((x) => `${x.slice(8)}.${x.slice(5, 7)}.`)];
    head.push(...(Object.keys(ABSENCE_LABEL) as AbsenceKind[]).map((k) => `${ABSENCE_LABEL[k]} (Tage)`));
    const lines = [head.join(';')];
    for (const e of d.emps) {
      const t = d.totals(e.id);
      lines.push(
        [
          safe(e.personnel_no),
          safe(`${e.last_name}, ${e.first_name}`),
          ...d.days.map((x) => {
            const a = d.cell(e.id, x);
            return a && !d.off(x) ? `${ABS_CODE[a.kind]}${a.status === 'beantragt' ? '?' : ''}` : '';
          }),
          ...(Object.keys(ABSENCE_LABEL) as AbsenceKind[]).map((k) => fmtDays(t[k])),
        ].join(';'),
      );
    }
    return new Response(`\uFEFF${lines.join('\r\n')}\r\n`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="urlaubskalender-${d.month}.csv"`,
      },
    });
  });

  app.get('/urlaub/kalender.pdf', async (c) => {
    const d = await calendarData(c);
    const COLOR: Record<string, [number, number, number]> = {
      urlaub: [0.86, 0.92, 0.99],
      krank: [0.99, 0.88, 0.88],
      kind_krank: [0.99, 0.88, 0.88],
      unbezahlt: [0.93, 0.93, 0.93],
      sonstiges: [0.99, 0.95, 0.85],
    };
    const pdf = await renderTablePdf({
      title: `Urlaubskalender ${d.label}`,
      subtitle: [
        d.kind ? ABSENCE_LABEL[d.kind] : 'alle Arten',
        d.withRequested ? 'genehmigt und beantragt (?)' : 'nur genehmigt',
        d.q ? `Suche „${d.q}“` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      columns: [
        { label: 'Mitarbeiter', width: 120 },
        ...d.days.map((x) => ({
          label: x.slice(8),
          width: 19,
          align: 'center' as const,
        })),
        { label: 'U', width: 22, align: 'right' as const },
        { label: 'K', width: 22, align: 'right' as const },
      ],
      rows: d.emps.map((e) => {
        const t = d.totals(e.id);
        return [
          `${e.last_name}, ${e.first_name}`,
          ...d.days.map((x) => {
            const a = d.cell(e.id, x);
            if (d.off(x)) return { text: '', fill: [0.94, 0.94, 0.95] as [number, number, number] };
            return a
              ? { text: `${ABS_CODE[a.kind]}${a.status === 'beantragt' ? '?' : ''}`, fill: COLOR[a.kind]! }
              : '';
          }),
          fmtDays(t.urlaub),
          fmtDays((t.krank ?? 0) + (t.kind_krank ?? 0) || undefined),
        ];
      }),
      fontSize: 6.5,
      footnote:
        'U Urlaub · K krank · KK Kind krank · UB unbezahlt · S sonstiges · ? = beantragt · grau = Wochenende/Feiertag (Bayern). Vertraulich – Personaldaten.',
    });
    return new Response(pdf, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="urlaubskalender-${d.month}.pdf"`,
        'Cache-Control': 'private, no-store',
      },
    });
  });

  const createAbsence = async (c: Context<AppEnv>, redirect: (employeeId: string) => string) => {
    const b = await c.req.parseBody();
    const employeeId = String(b.employee_id ?? '');
    if (!/^[0-9a-f-]{36}$/.test(employeeId)) throw new BusinessError('Bitte Mitarbeiter wählen');
    const kind = String(b.kind) as AbsenceKind;
    if (!(kind in ABSENCE_LABEL)) throw new BusinessError('Art ungültig');
    await requestAbsence(sql, {
      id: typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : randomUUID(),
      employeeId,
      kind,
      start: String(b.start ?? ''),
      end: String(b.end ?? ''),
      halfDay: b.half_day === '1',
      note: typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null,
      actor: c.get('actor'),
      approved: true,
    });
    return back(c, redirect(employeeId), { ok: 'Abwesenheit erfasst.' });
  };

  app.post('/urlaub', (c) => createAbsence(c, () => '/urlaub/kalender'));

  app.get(`/urlaub/:id{${UUID}}/bearbeiten`, async (c) => {
    const a = await getAbsence(sql, c.req.param('id'));
    if (!a) return c.notFound();
    const editable = ['beantragt', 'genehmigt'].includes(a.status);
    const ret = c.req.query('zurueck')
      ? safeReturn(c.req.query('zurueck'))
      : `/personal/${a.employee_id}/abwesenheiten`;
    return urlaubShell(
      c,
      'alle',
      <div class="cols">
        <form method="post" action={`/urlaub/${a.id}/bearbeiten`} class="card">
          <h3 style="margin-top:0">
            Abwesenheit ändern · <a href={`/personal/${a.employee_id}/abwesenheiten`}>{a.employee_name}</a>
          </h3>
          <p class="small mut" style="margin-top:-6px">
            Status: {ABSENCE_STATUS_LABEL[a.status]}
            {a.status === 'genehmigt' &&
              ' – Stunden je Einsatz werden nach dem Speichern neu berechnet (von Hand geänderte Stunden gehen verloren).'}
          </p>
          <input type="hidden" name="version" value={String(a.version)} />
          <input type="hidden" name="zurueck" value={ret} />
          <div class="grid">
            <div>
              <label for="kind">Art</label>
              <select id="kind" name="kind" disabled={!editable}>
                {(Object.keys(ABSENCE_LABEL) as AbsenceKind[]).map((k) => (
                  <option value={k} selected={k === a.kind}>
                    {ABSENCE_LABEL[k]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label for="start">von</label>
              <input id="start" type="date" name="start" value={a.start_date} required disabled={!editable} />
            </div>
            <div>
              <label for="end">bis</label>
              <input id="end" type="date" name="end" value={a.end_date} required disabled={!editable} />
            </div>
            <div class="chk">
              <input
                type="checkbox"
                id="half_day"
                name="half_day"
                value="1"
                checked={a.half_day}
                disabled={!editable}
              />
              <label for="half_day">halber Tag</label>
            </div>
            <div>
              <label for="note">Notiz</label>
              <input id="note" name="note" value={a.note ?? ''} disabled={!editable} />
            </div>
          </div>
          <div class="formfoot">
            <a class="btn sec" href={ret}>
              Abbrechen
            </a>
            {editable && <button class="btn">Speichern</button>}
          </div>
        </form>
        <form
          method="post"
          action={`/urlaub/${a.id}/loeschen`}
          class="card"
          onsubmit="return confirm('Abwesenheit endgültig löschen? Sie verschwindet aus Kalender, Urlaubskonto und Stundenlisten (bleibt nur im Protokoll).')"
        >
          <input type="hidden" name="zurueck" value={ret} />
          <h3 style="margin-top:0">Löschen</h3>
          <p class="small mut" style="margin-top:0">
            Für falsch erfasste Einträge. Genommener Urlaub, der nur verschoben wird: lieber oben ändern. Ist
            der Urlaub abgesagt, reicht „Stornieren“ (bleibt sichtbar).
          </p>
          <button class="btn danger">Abwesenheit löschen</button>
        </form>
      </div>,
    );
  });

  app.post(`/urlaub/:id{${UUID}}/bearbeiten`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    await updateAbsence(
      sql,
      id,
      {
        kind: String(b.kind) as AbsenceKind,
        start: String(b.start ?? ''),
        end: String(b.end ?? ''),
        halfDay: b.half_day === '1',
        note: typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null,
        expectedVersion: typeof b.version === 'string' && b.version ? Number(b.version) : null,
      },
      c.get('actor'),
    );
    return back(c, b.zurueck ? safeReturn(b.zurueck) : '/urlaub/alle', { ok: 'Abwesenheit geändert.' });
  });

  app.post(`/urlaub/:id{${UUID}}/loeschen`, async (c) => {
    const b = await c.req.parseBody();
    await deleteAbsence(sql, c.req.param('id'), c.get('actor'));
    return back(c, b.zurueck ? safeReturn(b.zurueck) : '/urlaub/alle', { ok: 'Abwesenheit gelöscht.' });
  });

  app.post(`/urlaub/:id{${UUID}}/status`, async (c) => {
    const b = await c.req.parseBody();
    const status = String(b.status);
    if (!['genehmigt', 'abgelehnt', 'storniert'].includes(status)) throw new BusinessError('Status ungültig');
    await decideAbsence(sql, c.req.param('id'), status as 'genehmigt', c.get('actor'));
    const ref = c.req.header('referer');
    return back(c, ref ? new URL(ref).pathname : '/urlaub', { ok: `Abwesenheit ${status}.` });
  });

  app.get(`/personal/:id{${UUID}}/abwesenheiten`, (c) =>
    shells.employee!(c, 'abwesenheiten', async (e) => {
      const year = Number(todayBerlin().slice(0, 4));
      const [bal, list] = await Promise.all([
        leaveBalance(sql, e.id, year),
        listAbsences(sql, { employeeId: e.id }),
      ]);
      const sick = list.filter(
        (a) =>
          a.status === 'genehmigt' &&
          ['krank', 'kind_krank'].includes(a.kind) &&
          a.start_date.startsWith(String(year)),
      );
      return (
        <>
          <div class="kpis">
            <div class="kpi">
              <div class="l">Urlaubsanspruch {year}</div>
              <div class="v">{String(bal.entitlement).replace('.', ',')}</div>
              <div class="s">
                {bal.openingAsOf
                  ? `Stand aus Fortytools vom ${dateDe(bal.openingAsOf)}, danach Urlaub aus der App`
                  : 'Tage (anteilig bei Ein-/Austritt)'}
              </div>
            </div>
            {bal.carried > 0 && (
              <div class="kpi">
                <div class="l">Übertrag aus {year - 1}</div>
                <div class="v">{String(bal.carried).replace('.', ',')}</div>
                <div class="s">
                  {bal.carriedExpired > 0
                    ? `${String(bal.carriedExpired).replace('.', ',')} Tage zum 31.03. verfallen – nur wirksam, wenn rechtzeitig auf den Verfall hingewiesen wurde (BAG 9 AZR 541/15)`
                    : 'bis 31.03. nehmen, sonst Verfall (nur nach Hinweis an den Mitarbeiter)'}
                </div>
              </div>
            )}
            <div class="kpi">
              <div class="l">genommen / beantragt</div>
              <div class="v">
                {String(bal.taken).replace('.', ',')} / {String(bal.requested).replace('.', ',')}
              </div>
            </div>
            <div class="kpi">
              <div class="l">Resturlaub</div>
              <div class="v" style={bal.rest < 0 ? 'color:var(--err)' : ''}>
                {String(bal.rest).replace('.', ',')}
              </div>
            </div>
            <div class="kpi">
              <div class="l">Krankheitstage {year}</div>
              <div class="v">{sick.reduce((s, a) => s + a.days, 0)}</div>
              <div class="s">ab 6 Wochen: BEM anbieten (§ 167 SGB IX)</div>
            </div>
          </div>
          <div class="cols">
            <AbsenceTable rows={list} showEmployee={false} />
            <AbsenceForm employeeId={e.id} action={`/personal/${e.id}/abwesenheiten`} />
          </div>
        </>
      );
    }),
  );

  app.post(`/personal/:id{${UUID}}/abwesenheiten`, (c) =>
    createAbsence(c, (id) => `/personal/${id}/abwesenheiten`),
  );
}
