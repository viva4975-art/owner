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

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v);
const ABS_CLASS: Record<AbsenceKind, string> = {
  urlaub: 'info',
  krank: 'err',
  kind_krank: 'err',
  unbezahlt: '',
  sonstiges: '',
};
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
                </a>
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

  app.get(`/personal/:id{${UUID}}/einsaetze`, (c) =>
    shells.employee!(c, 'einsaetze', async (e) => (
      <>
        <div class="actions" style="margin-top:0">
          <a
            class="btn sm"
            href={`/einsatzplanung/${randomUUID()}?mitarbeiter=${e.id}&zurueck=${encodeURIComponent(`/personal/${e.id}/einsaetze`)}`}
          >
            + Einsatz planen
          </a>
        </div>
        <PlanTable
          plans={await listShiftPlans(sql, { employeeId: e.id })}
          show="site"
          ret={`/personal/${e.id}/einsaetze`}
        />
      </>
    )),
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
            <SiteCalendar base={base} view={view} date={date} today={today} shifts={shifts} />
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
      'personal',
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

  app.get('/urlaub/kalender', async (c) => {
    const month = isMonth(c.req.query('monat')) ? c.req.query('monat')! : todayBerlin().slice(0, 7);
    const from = `${month}-01`;
    const to = addDays(`${addDays(from, 32).slice(0, 7)}-01`, -1);
    const [emps, abs] = await Promise.all([
      listEmployees(sql, { status: 'aktiv' }),
      listAbsences(sql, { from, to, status: ['beantragt', 'genehmigt'] }),
    ]);
    const days: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const prev = addDays(from, -1).slice(0, 7);
    const next = addDays(to, 1).slice(0, 7);
    return urlaubShell(
      c,
      'kalender',
      <>
        <div class="actions" style="margin-top:0">
          <a class="btn sec" href={`/urlaub/kalender?monat=${prev}`}>
            ←
          </a>
          <b>
            {new Date(`${from}T12:00:00Z`).toLocaleDateString('de-DE', {
              month: 'long',
              year: 'numeric',
              timeZone: 'UTC',
            })}
          </b>
          <a class="btn sec" href={`/urlaub/kalender?monat=${next}`}>
            →
          </a>
          <span class="small mut">
            U Urlaub · K krank · KK Kind krank · UB unbezahlt · S sonstiges · heller = beantragt
          </span>
        </div>
        <div class="tbl">
          <table style="font-size:12px">
            <thead>
              <tr>
                <th>Mitarbeiter</th>
                {days.map((d) => (
                  <th
                    style={`padding:6px 3px;text-align:center;${isoWeekday(d) >= 6 || holidayName(d) ? 'background:#eceef2' : ''}`}
                    title={holidayName(d) ?? ''}
                  >
                    {WEEKDAYS_SHORT[isoWeekday(d)]?.[0]}
                    <br />
                    {d.slice(8)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {emps.map((e) => (
                <tr>
                  <td style="white-space:nowrap">
                    <a href={`/personal/${e.id}/abwesenheiten`}>
                      {e.last_name}, {e.first_name}
                    </a>
                  </td>
                  {days.map((d) => {
                    const a = abs.find((x) => x.employee_id === e.id && x.start_date <= d && x.end_date >= d);
                    const off = isoWeekday(d) >= 6 || !!holidayName(d);
                    return (
                      <td
                        style={`padding:6px 3px;text-align:center;${off ? 'background:#f4f5f7;' : ''}${
                          a && !off
                            ? `background:${a.kind === 'urlaub' ? 'var(--info-50)' : 'var(--err-50)'};color:${a.kind === 'urlaub' ? 'var(--info)' : 'var(--err)'};font-weight:650;${a.status === 'beantragt' ? 'opacity:.55' : ''}`
                            : ''
                        }`}
                        title={a ? `${ABSENCE_LABEL[a.kind]} (${ABSENCE_STATUS_LABEL[a.status]})` : ''}
                      >
                        {a && !off ? ABS_CODE[a.kind] : ''}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>,
    );
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
              <div class="s">Tage (anteilig bei Ein-/Austritt)</div>
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
