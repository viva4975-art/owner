import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Child, FC } from 'hono/jsx';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays, holidayName, isoWeekday, mondayOf } from '../domain/time/holidays.js';
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
import { listSites } from '../services/masterdata.js';
import {
  type ShiftPlanRow,
  WEEKDAYS,
  WEEKDAYS_SHORT,
  endShiftPlan,
  hm,
  listShiftPlans,
  plannedShifts,
  saveShiftPlan,
} from '../services/time.js';
import { type AppEnv, type Ctx, UUID, assertSite } from './app.js';
import { arr } from './forms.js';
import { Icon } from './icons.js';
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
const short = (name: string) => {
  const [last, first] = name.split(', ');
  return `${last}${first ? ` ${first[0]}.` : ''}`;
};

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

const PlanTable: FC<{ plans: ShiftPlanRow[]; show: 'employee' | 'site' | 'both' }> = ({ plans, show }) => (
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
                <a class="btn sm sec" href={`/einsatzplanung/${p.id}`}>
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

  // ------------------------------------------------------------------ Einsatzplanung: Wochenplan

  app.get('/einsatzplanung', async (c) => {
    const monday = mondayOf(isDate(c.req.query('woche')) ? c.req.query('woche')! : todayBerlin());
    const sunday = addDays(monday, 6);
    const siteFilter = c.req.query('objekt') || undefined;
    const scope = c.get('sites');
    const [allShifts, allSites] = await Promise.all([
      plannedShifts(sql, { from: monday, to: sunday, ...(siteFilter ? { siteId: siteFilter } : {}) }),
      listSites(sql),
    ]);
    const shifts = scope ? allShifts.filter((s) => scope.includes(s.plan.site_id)) : allShifts;
    const sites = scope ? allSites.filter((s) => scope.includes(s.id)) : allSites;
    const days = [...Array(7).keys()].map((i) => addDays(monday, i));
    const siteIds = [...new Set(shifts.map((s) => s.plan.site_id))];
    const bySite = siteIds
      .map((id) => ({
        id,
        name: shifts.find((s) => s.plan.site_id === id)!.plan.site_name,
        no: shifts.find((s) => s.plan.site_id === id)!.plan.site_no,
      }))
      .sort((a, b) => a.no.localeCompare(b.no));
    const totalMin = shifts.filter((s) => !s.absence).reduce((a, s) => a + s.minutes, 0);
    const gaps = shifts.filter((s) => s.absence && !s.holiday).length;
    // ISO-Kalenderwoche: Woche, in der der Donnerstag liegt
    const kw = (() => {
      const thu = new Date(`${addDays(monday, 3)}T00:00:00Z`);
      const start = Date.UTC(thu.getUTCFullYear(), 0, 1);
      return Math.ceil(((thu.getTime() - start) / 86400000 + 1) / 7);
    })();
    return page(
      c,
      'Einsatzplanung',
      'disposition',
      <>
        <PageHead title="Einsatzplanung" no={`KW ${kw}`}>
          <a class="btn" href={`/einsatzplanung/${randomUUID()}`} style="margin-left:auto">
            <Icon name="plus" /> Einsatz planen
          </a>
        </PageHead>
        <form method="get" action="/einsatzplanung" class="actions" style="margin-top:0">
          <a
            class="btn sec"
            href={`/einsatzplanung?woche=${addDays(monday, -7)}${siteFilter ? `&objekt=${siteFilter}` : ''}`}
          >
            ← Vorwoche
          </a>
          <input
            type="date"
            name="woche"
            value={monday}
            style="max-width:170px"
            onchange="this.form.submit()"
          />
          <a
            class="btn sec"
            href={`/einsatzplanung?woche=${addDays(monday, 7)}${siteFilter ? `&objekt=${siteFilter}` : ''}`}
          >
            Nächste Woche →
          </a>
          <select name="objekt" onchange="this.form.submit()" style="max-width:300px">
            <option value="">alle Objekte</option>
            {sites.map((s) => (
              <option value={s.id} selected={s.id === siteFilter}>
                {s.site_no} · {s.name}
              </option>
            ))}
          </select>
          <span class="mut small">
            {dateDe(monday)} – {dateDe(sunday)} · {hm(totalMin)} Std. geplant
          </span>
          {gaps > 0 && (
            <a class="badge err" href={`/einsatzplanung/vertretungen?von=${monday}&bis=${sunday}`}>
              {gaps} Einsätze ohne Vertretung (Urlaub/Krank) – jetzt regeln
            </a>
          )}
          <a class="btn sm sec" href={`/einsatzplanung/monat?monat=${monday.slice(0, 7)}`}>
            Monatstafel
          </a>
        </form>
        <div class="tbl">
          <table class="plan">
            <thead>
              <tr>
                <th style="min-width:180px">Objekt</th>
                {days.map((d) => (
                  <th style={holidayName(d) || isoWeekday(d) >= 6 ? 'background:#f1f2f5' : ''}>
                    {WEEKDAYS_SHORT[isoWeekday(d)]} {dateDe(d).slice(0, 6)}
                    {holidayName(d) && (
                      <div class="small" style="color:var(--warn);font-weight:500">
                        {holidayName(d)}
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bySite.length === 0 && (
                <tr>
                  <td colspan={8}>
                    <div class="empty">
                      In dieser Woche ist nichts geplant.{' '}
                      <a href={`/einsatzplanung/${randomUUID()}`}>Ersten Einsatz planen</a>
                    </div>
                  </td>
                </tr>
              )}
              {bySite.map((site) => (
                <tr>
                  <td>
                    <a href={`/objekte/${site.id}/einsaetze`}>
                      <b>{site.name}</b>
                    </a>
                    <div class="small mut">{site.no}</div>
                  </td>
                  {days.map((d) => (
                    <td style="min-width:120px">
                      {shifts
                        .filter((s) => s.plan.site_id === site.id && s.date === d)
                        .map((s) => (
                          <a
                            href={`/einsatzplanung/${s.plan.id}/tag/${s.date}?zurueck=${encodeURIComponent(`/einsatzplanung?woche=${monday}${siteFilter ? `&objekt=${siteFilter}` : ''}`)}`}
                            class="small"
                            style={`display:block;padding:4px 6px;margin-bottom:4px;border-radius:6px;text-decoration:none;color:var(--ink);border:1px solid ${s.absence ? '#fecdca' : s.entry ? '#bbf7d0' : 'var(--line)'};background:${s.absence ? 'var(--err-50)' : s.entry ? 'var(--ok-50)' : '#fff'}`}
                            title={
                              s.absence
                                ? `${ABSENCE_LABEL[s.absence as AbsenceKind]} – Vertretung nötig`
                                : s.entry
                                  ? 'Zeit erfasst'
                                  : s.exception
                                    ? `${s.exception.kind === 'vertretung' ? 'Vertretung für' : 'umgeplant, sonst'} ${s.exception.original}`
                                    : 'geplant – klicken zum Umplanen'
                            }
                          >
                            <b style={s.absence ? 'text-decoration:line-through' : ''}>
                              {short(s.plan.employee_name)}
                            </b>
                            <br />
                            {s.plan.start_time}–{s.plan.end_time}
                            {s.exception && (
                              <span style="color:var(--brand)">
                                {' '}
                                · {s.exception.kind === 'vertretung' ? 'Vertr.' : 'umgepl.'}
                              </span>
                            )}
                            {s.absence && (
                              <span style="color:var(--err)">
                                {' '}
                                · {ABSENCE_LABEL[s.absence as AbsenceKind]}
                              </span>
                            )}
                          </a>
                        ))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p class="small mut">
          Grün = Zeit erfasst, rot = Mitarbeiter abwesend (Vertretung planen). Feiertage nach bayerischem
          Recht. Einsätze wiederholen sich wöchentlich ab dem Gültigkeitsdatum.
        </p>
      </>,
    );
  });

  // Einsatz anlegen/ändern
  app.get(`/einsatzplanung/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const [[plan], emps, sites] = await Promise.all([
      sql<ShiftPlanRow[]>`
        select p.*, to_char(p.start_time, 'HH24:MI') as start_time, to_char(p.end_time, 'HH24:MI') as end_time,
               e.last_name || ', ' || e.first_name as employee_name, e.personnel_no, s.name as site_name, s.site_no
          from app.shift_plans p join app.employees e on e.id = p.employee_id join app.sites s on s.id = p.site_id where p.id = ${id}`,
      listEmployees(sql, { status: 'aktiv' }),
      listSites(sql).then((l) => l.filter((s) => !c.get('sites') || c.get('sites')!.includes(s.id))),
    ]);
    if (plan) assertSite(c, plan.site_id);
    const q = c.req.query();
    const v = {
      employee: plan?.employee_id ?? q.mitarbeiter ?? '',
      site: plan?.site_id ?? q.objekt ?? '',
      weekdays: plan ? [plan.weekday] : [1, 2, 3, 4, 5],
      start: plan?.start_time ?? '',
      end: plan?.end_time ?? '',
      brk: plan?.break_minutes ?? 0,
      from: plan?.valid_from ?? todayBerlin(),
      until: plan?.valid_until ?? '',
      note: plan?.note ?? '',
    };
    return page(
      c,
      plan ? 'Einsatz ändern' : 'Einsatz planen',
      'disposition',
      <>
        <PageHead
          title={plan ? `Einsatz: ${plan.employee_name}` : 'Einsatz planen'}
          crumbs={[['Einsatzplanung', '/einsatzplanung']]}
        />
        <div class="cols">
          <form
            method="post"
            action={`/einsatzplanung/${id}`}
            class="card"
            data-autosave={`/einsatzplanung/${id}`}
            data-version={String(plan?.version ?? '')}
          >
            <div class="grid">
              <div>
                <label for="employee_id">Mitarbeiter</label>
                <select id="employee_id" name="employee_id" required>
                  <option value="">– bitte wählen –</option>
                  {emps.map((e) => (
                    <option value={e.id} selected={e.id === v.employee}>
                      {e.last_name}, {e.first_name} ({e.personnel_no})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label for="site_id">Objekt</label>
                <select id="site_id" name="site_id" required>
                  <option value="">– bitte wählen –</option>
                  {sites.map((s) => (
                    <option value={s.id} selected={s.id === v.site}>
                      {s.site_no} · {s.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <label style="margin-top:14px">{plan ? 'Wochentag' : 'Wochentage (je Tag ein Einsatz)'}</label>
            <div class="actions" style="margin-top:0">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <span class="chk">
                  <input
                    type={plan ? 'radio' : 'checkbox'}
                    id={`wd${d}`}
                    name="weekday"
                    value={String(d)}
                    checked={v.weekdays.includes(d)}
                  />
                  <label for={`wd${d}`}>{WEEKDAYS_SHORT[d]}</label>
                </span>
              ))}
            </div>
            <div class="grid">
              <div>
                <label for="start">Beginn</label>
                <input id="start" type="time" name="start" value={v.start} required />
              </div>
              <div>
                <label for="end">Ende</label>
                <input id="end" type="time" name="end" value={v.end} required />
              </div>
              <div>
                <label for="break_minutes">Pause (Min.)</label>
                <input
                  id="break_minutes"
                  type="number"
                  name="break_minutes"
                  min="0"
                  max="180"
                  value={String(v.brk)}
                />
              </div>
              <div>
                <label for="valid_from">gültig ab</label>
                <input id="valid_from" type="date" name="valid_from" value={v.from} required />
              </div>
              <div class="chk">
                <input type="checkbox" id="has-until" data-reveal="#until-box" checked={!!v.until} />
                <label for="has-until">befristet (sonst unbefristet)</label>
              </div>
              <div id="until-box" hidden={!v.until}>
                <label for="valid_until">gültig bis</label>
                <input id="valid_until" type="date" name="valid_until" value={v.until} />
              </div>
            </div>
            <div style="margin-top:12px">
              <label for="note">Notiz (z. B. Revier, Besonderheiten)</label>
              <input id="note" name="note" value={v.note} />
            </div>
            <div class="formfoot">
              <a class="btn sec" href="/einsatzplanung">
                Abbrechen
              </a>
              <button class="btn">Speichern</button>
            </div>
          </form>
          {plan && (
            <form method="post" action={`/einsatzplanung/${id}/beenden`} class="card">
              <h3>Einsatz beenden</h3>
              <p class="small mut" style="margin-top:0">
                Der Einsatz bleibt für die Vergangenheit erhalten (Soll/Ist, Nachkalkulation) und endet am
                gewählten Tag.
              </p>
              <label for="last_day">letzter Einsatztag</label>
              <input id="last_day" type="date" name="last_day" value={todayBerlin()} required />
              <div class="actions" style="margin-bottom:0">
                <button class="btn danger">Beenden</button>
              </div>
            </form>
          )}
        </div>
      </>,
    );
  });

  app.post(`/einsatzplanung/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody({ all: true });
    const one = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '');
    assertSite(c, one('site_id'));
    const [old] = await sql<{ site_id: string }[]>`select site_id from app.shift_plans where id = ${id}`;
    if (old) assertSite(c, old.site_id);
    await saveShiftPlan(
      sql,
      id,
      {
        employeeId: one('employee_id'),
        siteId: one('site_id'),
        weekdays: arr(b, 'weekday').map(Number),
        startTime: one('start'),
        endTime: one('end'),
        breakMinutes: Number(one('break_minutes')) || 0,
        validFrom: one('valid_from'),
        validUntil: one('valid_until') || null,
        note: one('note') || null,
      },
      c.get('actor'),
    );
    return back(
      c,
      `/einsatzplanung?woche=${mondayOf(one('valid_from') > todayBerlin() ? one('valid_from') : todayBerlin())}`,
      {
        ok: 'Einsatz gespeichert.',
      },
    );
  });

  app.post(`/einsatzplanung/:id{${UUID}}/beenden`, async (c) => {
    const b = await c.req.parseBody();
    if (!isDate(b.last_day)) throw new BusinessError('Datum ungültig');
    const [old] = await sql<
      { site_id: string }[]
    >`select site_id from app.shift_plans where id = ${c.req.param('id')}`;
    assertSite(c, old?.site_id);
    await endShiftPlan(sql, c.req.param('id'), b.last_day, c.get('actor'));
    return back(c, '/einsatzplanung', { ok: 'Einsatz beendet.' });
  });

  app.get(`/personal/:id{${UUID}}/einsaetze`, (c) =>
    shells.employee!(c, 'einsaetze', async (e) => (
      <>
        <div class="actions" style="margin-top:0">
          <a class="btn sm" href={`/einsatzplanung/${randomUUID()}?mitarbeiter=${e.id}`}>
            + Einsatz planen
          </a>
        </div>
        <PlanTable plans={await listShiftPlans(sql, { employeeId: e.id })} show="site" />
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
            <a class="btn sm" href={`/einsatzplanung/${randomUUID()}?objekt=${s.id}`}>
              + Einsatz planen
            </a>
            <a class="btn sm sec" href={`/einsatzplanung/vertretungen`}>
              Einsätze für abwesende Mitarbeiter
            </a>
          </div>
          {view === 'liste' ? (
            <>
              <SiteCalendar base={base} view={view} date={date} today={today} shifts={[]} />
              <PlanTable plans={await listShiftPlans(sql, { siteId: s.id })} show="employee" />
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
      <p class="small mut">Vom Büro erfasste Abwesenheiten gelten sofort als genehmigt.</p>
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
