import { MonthOverview, TimesDetails, TimesOverview, monthName } from './pages-site-calendar.js';
import { SiteOptions } from './site-options.js';
import {
  confirmSiteMonth,
  monthRange,
  plannedFor,
  siteMonthOverview,
  siteTimes,
} from '../services/site-times.js';
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Child, FC } from 'hono/jsx';
import QRCode from 'qrcode';
import { filteredSites, parseSiteFilter } from '../services/site-list.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import { addDays, holidayName } from '../domain/time/holidays.js';
import { hasPin, setPin } from '../services/employee-auth.js';
import { listEmployees } from '../services/employees.js';
import { BusinessError } from '../services/errors.js';
import { listSites } from '../services/masterdata.js';
import {
  type TimeEntryRow,
  SOURCE_LABEL,
  STATUS_LABEL,
  clock,
  decideCorrection,
  entryLog,
  getEntry,
  getTimeSettings,
  hm,
  listEntries,
  listShiftPlans,
  monthSummary,
  netMinutes,
  officeSave,
  officeRemove,
  purgeEntries,
  officeConfirmPlanned,
  listDeletions,
  plannedShifts,
  saveTimeSettings,
  warningsFor,
  WEEKDAYS_SHORT,
  geoCheckEnabled,
} from '../services/time.js';
import { GEO_LABEL, parseCoordinates } from '../domain/time/geo.js';
import { type AppEnv, type Ctx, UUID, assertSite, inScope } from './app.js';
import { centsToInput } from './forms.js';
import { canAccess } from './permissions.js';
import { Icon } from './icons.js';
import { PageHead, dateDe, euro } from './layout.js';
import { AbsentCard } from './pages-crm.js';
import { EmployeeCalendarView } from './pages-employee-calendar.js';
import { employeeCalendarData } from './employee-calendar-data.js';
import { linkedEmployee } from '../services/users.js';
import { absentBetween } from '../services/absences.js';

const versionOf = (v: unknown) => (typeof v === 'string' && v !== '' ? Number(v) : null);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v);
const weekdayDe = (d: string) => WEEKDAYS_SHORT[((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7) + 1];

export const StatusPill: FC<{ e: Pick<TimeEntryRow, 'status'> }> = ({ e }) => (
  <span
    class={`badge ${e.status === 'laeuft' ? 'info' : e.status === 'beantragt' ? 'warn' : e.status === 'abgelehnt' ? 'err' : 'ok'}`}
  >
    {STATUS_LABEL[e.status]}
  </span>
);

export const Warnings: FC<{ e: TimeEntryRow }> = ({ e }) => {
  const w = warningsFor(e);
  return w.length ? (
    <div class="small" style="color:var(--warn)">
      {w.map((x) => (
        <div>
          <Icon name="alert" size={12} /> {x}
        </div>
      ))}
    </div>
  ) : (
    <></>
  );
};

/** Tabelle erfasster Zeiten (wird auch bei Mitarbeiter/Objekt verwendet). */
export const EntryTable: FC<{
  rows: TimeEntryRow[];
  show?: 'employee' | 'site' | 'both';
  /** Auswahl-Häkchen für „endgültig löschen“ (nur Admin); Wert = id des Formulars */
  selectForm?: string;
}> = ({ rows, show = 'both', selectForm }) => {
  const total = rows
    .filter((r) => r.end_at && r.status !== 'abgelehnt' && r.status !== 'beantragt')
    .reduce((s, r) => s + netMinutes(r), 0);
  return (
    <div class="tbl">
      <table>
        <thead>
          <tr>
            {selectForm && (
              <th style="width:28px">
                <input type="checkbox" data-check-all={selectForm} aria-label="alle markieren" />
              </th>
            )}
            <th>Datum</th>
            {show !== 'site' && <th>Mitarbeiter</th>}
            {show !== 'employee' && <th>Objekt</th>}
            <th>Beginn – Ende</th>
            <th class="r">Pause</th>
            <th class="r">Dauer</th>
            <th>Art</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colspan={selectForm ? 10 : 9}>
                <div class="empty">Keine Zeiten im gewählten Zeitraum.</div>
              </td>
            </tr>
          )}
          {rows.map((e) => (
            <tr>
              {selectForm && (
                <td>
                  <input
                    type="checkbox"
                    name="ids"
                    value={e.id}
                    form={selectForm}
                    data-check-of={selectForm}
                    aria-label="markieren"
                  />
                </td>
              )}
              <td>
                {weekdayDe(e.work_date)} {dateDe(e.work_date)}
              </td>
              {show !== 'site' && (
                <td>
                  <a href={`/personal/${e.employee_id}/zeiten`}>{e.employee_name}</a>
                </td>
              )}
              {show !== 'employee' && (
                <td>
                  <a href={`/objekte/${e.site_id}/zeiten`}>{e.site_name}</a>
                </td>
              )}
              <td>
                {clock(e.start_at)} – {e.end_at ? clock(e.end_at) : '…'}
                <Warnings e={e} />
              </td>
              <td class="r">{e.break_minutes ? `${e.break_minutes} Min.` : '–'}</td>
              <td class="r">{e.end_at ? hm(netMinutes(e)) : hm(e.gross_minutes)}</td>
              <td class="small">
                {SOURCE_LABEL[e.source]}
                {e.via_qr && ' · QR'}
                <GeoBadge e={e} />
              </td>
              <td>
                <StatusPill e={e} />
              </td>
              <td>
                <a class="btn sm sec" href={`/zeiterfassung/${e.id}`}>
                  Öffnen
                </a>
              </td>
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr>
              <td colspan={(show === 'both' ? 5 : 4) + (selectForm ? 1 : 0)} class="r">
                <b>Summe (erfasst/freigegeben)</b>
              </td>
              <td class="r">
                <b>{hm(total)}</b>
              </td>
              <td colspan={3}></td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
};

/** Standort beim Stempeln: nur auffällige Fälle hervorheben (nicht am Objekt / ungenau / kein Standort). */
const GeoBadge = ({
  e,
}: {
  e: {
    start_geo?: string | null;
    start_geo_m?: number | null;
    end_geo?: string | null;
    end_geo_m?: number | null;
  };
}) => {
  const part = (g: string | null | undefined, m: number | null | undefined, what: string) => {
    if (!g || g === 'objekt_ohne_standort') return null;
    const km = m != null ? (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${m} m`) : '';
    return (
      <span
        class={`badge ${g === 'am_objekt' ? 'ok' : g === 'entfernt' ? 'err' : 'warn'}`}
        title={`${what}: ${GEO_LABEL[g as keyof typeof GEO_LABEL]}`}
      >
        {what} {g === 'am_objekt' ? '✓' : GEO_LABEL[g as keyof typeof GEO_LABEL]}
        {g === 'entfernt' && km ? ` (${km})` : ''}
      </span>
    );
  };
  const a = part(e.start_geo, e.start_geo_m, 'Ein');
  const b = part(e.end_geo, e.end_geo_m, 'Aus');
  return a || b ? (
    <div style="display:flex;gap:4px;margin-top:2px;flex-wrap:wrap">
      {a}
      {b}
    </div>
  ) : null;
};

export function registerTimeRoutes({ app, deps, page, back, shells }: Ctx) {
  const { sql, env } = deps;

  const shell = async (c: Context<AppEnv>, active: string, title: string, body: Child, nav = 'personal') => {
    const scope = c.get('sites');
    const [[cnt]] = await Promise.all([
      sql<{ running: number; requests: number }[]>`
        select count(*) filter (where status = 'laeuft')::int as running, count(*) filter (where status = 'beantragt')::int as requests
          from app.time_entries where ${scope ? sql`site_id in ${sql(scope.length ? scope : ['00000000-0000-0000-0000-000000000000'])}` : sql`true`}`,
    ]);
    void active; // Bereiche stehen links im Menü (keine doppelte Reiterzeile)
    return page(
      c,
      title,
      nav,
      <>
        <PageHead title="Zeiterfassung">
          <span class="badge info" style="margin-left:4px">
            {cnt!.running} jetzt im Einsatz
          </span>
          {cnt!.requests > 0 && canAccess(c.get('user').role, '/zeiterfassung/freigaben') && (
            <a class="badge warn" href="/zeiterfassung#nachtraege">
              {cnt!.requests} Nachträge freigeben
            </a>
          )}
          <a class="btn sec" href="/m" target="_blank" style="margin-left:auto">
            <Icon name="user" /> Mitarbeiter-Ansicht
          </a>
          <a class="btn" href={`/zeiterfassung/${randomUUID()}`}>
            <Icon name="plus" /> Zeit erfassen
          </a>
        </PageHead>
        {body}
      </>,
    );
  };

  // ------------------------------------------------------------------ Tagesübersicht

  // Ansicht wählen (ein Tag / Zeitraum) und offene Nachträge – oben auf beiden Zeiterfassungs-Seiten (Ahmed 07.10.)
  const viewHead = async (c: Context<AppEnv>, mode: 'person' | 'tag' | 'liste', day: string) => {
    const [requests, running] = (
      await Promise.all([
        listEntries(sql, { status: ['beantragt'] }),
        listEntries(sql, { status: ['laeuft'] }),
      ])
    ).map((l) => inScope(c, l)) as [TimeEntryRow[], TimeEntryRow[]];
    const stale = running.filter((e) => e.gross_minutes > 12 * 60);
    return (
      <>
        <div class="chips" style="margin:0 0 12px">
          <a href="/zeiterfassung/mitarbeiter" class={mode === 'person' ? 'on' : ''}>
            Je Mitarbeiter
          </a>
          <a href={`/zeiterfassung?datum=${day}`} class={mode === 'tag' ? 'on' : ''}>
            Ein Tag
          </a>
          <a href="/zeiterfassung/liste" class={mode === 'liste' ? 'on' : ''}>
            Zeitraum / alle Zeiten
          </a>
        </div>
        {(requests.length > 0 || stale.length > 0) && (
          <details class="card" id="nachtraege" open>
            <summary>
              <b>Nachträge freigeben ({requests.length})</b>
            </summary>
            <RequestsList requests={requests} stale={stale} />
          </details>
        )}
      </>
    );
  };

  // Zeiterfassung je Mitarbeiter wie Fortytools: Kalender/Liste mit Geplant/Erfasst und „Plan-Zeiten als Ist-Zeiten“
  app.get('/zeiterfassung/mitarbeiter', async (c) => {
    const scope = c.get('sites');
    const emps = (
      await sql<{ id: string; name: string; personnel_no: string; site_ids: string[] | null }[]>`
        select e.id, e.last_name || ', ' || e.first_name as name, e.personnel_no,
               (select array_agg(es.site_id) from app.employee_sites es where es.employee_id = e.id) as site_ids
          from app.employees e where e.status = 'aktiv' order by e.last_name, e.first_name`
    ).filter((e) => !scope || (e.site_ids ?? []).some((s) => scope.includes(s)));
    const q = c.req.query();
    const sel = emps.find((e) => e.id === q.mitarbeiter) ?? emps[0];
    const head = await viewHead(c, 'person', todayBerlin());
    if (!sel)
      return shell(
        c,
        'person',
        'Zeiterfassung',
        <>
          {head}
          <div class="empty">Keine Mitarbeitenden.</div>
        </>,
      );
    const d = await employeeCalendarData(sql, sel.id, q, { siteScope: scope });
    return shell(
      c,
      'person',
      `Zeiterfassung für ${sel.name.split(', ').reverse().join(' ')}`,
      <>
        {head}
        <EmployeeCalendarView
          employeeId={sel.id}
          today={todayBerlin()}
          holiday={holidayName}
          canEdit
          canDeleteTime={['admin', 'personal'].includes(c.get('user').role)}
          base="/zeiterfassung/mitarbeiter"
          keep={`mitarbeiter=${sel.id}`}
          confirmAction="/zeiterfassung/plan-als-ist"
          head={
            <form method="get" action="/zeiterfassung/mitarbeiter" style="margin:0">
              <input type="hidden" name="ansicht" value={d.view} />
              <input type="hidden" name="datum" value={d.date} />
              <select
                name="mitarbeiter"
                onchange="this.form.submit()"
                aria-label="Mitarbeiter"
                style="min-width:240px"
              >
                {emps.map((e) => (
                  <option value={e.id} selected={e.id === sel.id}>
                    {e.name} ({e.personnel_no})
                  </option>
                ))}
              </select>
            </form>
          }
          {...d}
        />
      </>,
    );
  });

  app.post('/zeiterfassung/plan-als-ist', async (c) => {
    const b = await c.req.parseBody();
    const emp = String(b.mitarbeiter ?? '');
    const own = await linkedEmployee(sql, c.get('user').id);
    const role = c.get('user').role;
    if (emp !== own && !['admin', 'personal', 'objektleitung'].includes(role))
      throw new BusinessError('Keine Berechtigung');
    const from = String(b.von ?? '');
    const to = String(b.bis ?? '');
    if (!isDate(from) || !isDate(to)) throw new BusinessError('Zeitraum ungültig');
    const r = await officeConfirmPlanned(sql, {
      employeeId: emp,
      from,
      to,
      actor: c.get('actor'),
      siteScope: emp === own ? null : c.get('sites'),
    });
    const z =
      typeof b.zurueck === 'string' && b.zurueck.startsWith('/') && !b.zurueck.startsWith('//')
        ? b.zurueck
        : '/zeiterfassung/mitarbeiter';
    return back(c, z, {
      ok: `${r.created} Einsätze als Ist-Zeit eingetragen.${r.skipped.length ? ` Übersprungen: ${r.skipped.slice(0, 5).join('; ')}` : ''}`,
    });
  });

  app.get('/zeiterfassung', async (c) => {
    // Einstieg wie Fortytools: Zeiterfassung je Mitarbeiter; Tagesübersicht über „Ein Tag“ (?datum=)
    if (!c.req.query('datum')) {
      const qs = new URL(c.req.url).search;
      return c.redirect(`/zeiterfassung/mitarbeiter${qs}`);
    }
    const day = isDate(c.req.query('datum')) ? c.req.query('datum')! : todayBerlin();
    const [allShifts, allEntries] = await Promise.all([
      plannedShifts(sql, { from: day, to: day }),
      listEntries(sql, { from: day, to: day }),
    ]);
    const scope = c.get('sites');
    const shifts = scope ? allShifts.filter((s) => scope.includes(s.plan.site_id)) : allShifts;
    const entries = inScope(c, allEntries);
    const nowHm = new Date().toLocaleTimeString('de-DE', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
    });
    const isPast = (s: (typeof shifts)[number]) =>
      s.date < todayBerlin() || (s.date === todayBerlin() && s.plan.end_time <= nowHm);
    const planned = new Set(shifts.map((s) => s.entry?.id).filter(Boolean));
    const unplanned = entries.filter((e) => !planned.has(e.id) && e.status !== 'abgelehnt');
    const missing = shifts.filter((s) => !s.entry && !s.absence && isPast(s)).length;
    const sollMin = shifts.filter((s) => !s.absence).reduce((a, s) => a + s.minutes, 0);
    const istMin = entries
      .filter((e) => e.end_at && ['erfasst', 'freigegeben'].includes(e.status))
      .reduce((a, e) => a + netMinutes(e), 0);
    const hol = holidayName(day);
    const absent = await absentBetween(sql, day, addDays(day, 14), scope);
    const head = await viewHead(c, 'tag', day);
    return shell(
      c,
      'tag',
      'Zeiterfassung',
      <>
        {head}
        <AbsentCard
          absent={absent}
          today={day}
          href={canAccess(c.get('user').role, '/urlaub/kalender') ? '/urlaub/kalender' : undefined}
        />
        <form method="get" action="/zeiterfassung" class="actions" style="margin-top:0">
          <a class="btn sec" href={`/zeiterfassung?datum=${addDays(day, -1)}`}>
            ←
          </a>
          <input type="date" name="datum" value={day} style="max-width:180px" onchange="this.form.submit()" />
          <a class="btn sec" href={`/zeiterfassung?datum=${addDays(day, 1)}`}>
            →
          </a>
          <b>
            {weekdayDe(day)} {dateDe(day)}
          </b>
          {hol && <span class="badge warn">Feiertag: {hol}</span>}
        </form>
        <div class="kpis">
          <div class="kpi">
            <div class="l">Soll laut Einsatzplan</div>
            <div class="v">{hm(sollMin)} Std.</div>
            <div class="s">{shifts.length} Einsätze</div>
          </div>
          <div class="kpi">
            <div class="l">Ist erfasst</div>
            <div class="v">{hm(istMin)} Std.</div>
            <div class="s">{entries.length} Einträge</div>
          </div>
          <div class="kpi">
            <div class="l">Einsatz vorbei, keine Zeit</div>
            <div class="v" style={missing ? 'color:var(--err)' : ''}>
              {missing}
            </div>
            <div class="s">Mitarbeiter fragen oder erfassen</div>
          </div>
        </div>
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Objekt</th>
                <th>Mitarbeiter</th>
                <th>Soll</th>
                <th>Ist</th>
                <th class="r">Dauer</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shifts.length + unplanned.length === 0 && (
                <tr>
                  <td colspan={7}>
                    <div class="empty">
                      Für diesen Tag ist nichts geplant und nichts erfasst.{' '}
                      <a href="/einsatzplanung">Zur Einsatzplanung</a>
                    </div>
                  </td>
                </tr>
              )}
              {shifts.map((s) => (
                <tr style={s.absence ? 'opacity:.6' : ''}>
                  <td>
                    <a href={`/objekte/${s.plan.site_id}/einsaetze`}>{s.plan.site_name}</a>
                  </td>
                  <td>
                    <a href={`/personal/${s.plan.employee_id}/zeiten`}>{s.plan.employee_name}</a>
                  </td>
                  <td>
                    {s.plan.start_time}–{s.plan.end_time}
                  </td>
                  <td>
                    {s.entry ? (
                      <>
                        {clock(s.entry.start_at)}–{s.entry.end_at ? clock(s.entry.end_at) : '…'}
                        <Warnings e={s.entry} />
                      </>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td class="r">{s.entry?.end_at ? hm(netMinutes(s.entry)) : ''}</td>
                  <td>
                    {s.absence ? (
                      <span class="badge">
                        {s.absence === 'urlaub' ? 'Urlaub' : s.absence === 'krank' ? 'krank' : 'abwesend'}
                      </span>
                    ) : s.entry ? (
                      <StatusPill e={s.entry} />
                    ) : isPast(s) ? (
                      <span class="badge err">fehlt</span>
                    ) : (
                      <span class="badge">geplant</span>
                    )}
                  </td>
                  <td>
                    {s.entry ? (
                      <a class="btn sm sec" href={`/zeiterfassung/${s.entry.id}`}>
                        Öffnen
                      </a>
                    ) : (
                      !s.absence && (
                        <a
                          class="btn sm sec"
                          href={`/zeiterfassung/${randomUUID()}?mitarbeiter=${s.plan.employee_id}&objekt=${s.plan.site_id}&datum=${s.date}&von=${s.plan.start_time}&bis=${s.plan.end_time}&pause=${s.plan.break_minutes}`}
                        >
                          Erfassen
                        </a>
                      )
                    )}
                  </td>
                </tr>
              ))}
              {unplanned.map((e) => (
                <tr>
                  <td>
                    <a href={`/objekte/${e.site_id}/zeiten`}>{e.site_name}</a>
                  </td>
                  <td>
                    <a href={`/personal/${e.employee_id}/zeiten`}>{e.employee_name}</a>
                  </td>
                  <td class="mut">ungeplant</td>
                  <td>
                    {clock(e.start_at)}–{e.end_at ? clock(e.end_at) : '…'}
                    <Warnings e={e} />
                  </td>
                  <td class="r">{e.end_at ? hm(netMinutes(e)) : hm(e.gross_minutes)}</td>
                  <td>
                    <StatusPill e={e} />
                  </td>
                  <td>
                    <a class="btn sm sec" href={`/zeiterfassung/${e.id}`}>
                      Öffnen
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>,
    );
  });

  // ------------------------------------------------------------------ Freigaben

  app.get('/zeiterfassung/freigaben', async (c) => {
    const [requests, running] = (
      await Promise.all([
        listEntries(sql, { status: ['beantragt'] }),
        listEntries(sql, { status: ['laeuft'] }),
      ])
    ).map((l) => inScope(c, l)) as [TimeEntryRow[], TimeEntryRow[]];
    const stale = running.filter((e) => e.gross_minutes > 12 * 60);
    return shell(
      c,
      'freigaben',
      'Freigaben',
      <>
        <p class="mut" style="margin-top:0">
          Nachträge der Mitarbeitenden (vergessen zu stempeln). Freigegebene Zeiten zählen für Lohn,
          Nachkalkulation und Prüfbericht.
        </p>
        <RequestsList requests={requests} stale={stale} />
      </>,
    );
  });

  app.post(`/zeiterfassung/:id{${UUID}}/entscheiden`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const ok = b.ok === '1';
    assertSite(c, (await getEntry(sql, id))?.site_id);
    await decideCorrection(sql, id, ok, c.get('actor'), typeof b.reason === 'string' ? b.reason : null);
    const ret =
      typeof b.zurueck === 'string' && b.zurueck.startsWith('/zeiterfassung') ? b.zurueck : '/zeiterfassung';
    return back(c, ret, { ok: ok ? 'Freigegeben.' : 'Abgelehnt.' });
  });

  // ------------------------------------------------------------------ Liste

  app.get('/zeiterfassung/liste', async (c) => {
    const q = c.req.query();
    const from = isDate(q.von) ? q.von : addDays(todayBerlin(), -13);
    const to = isDate(q.bis) ? q.bis : todayBerlin();
    const [allRows, emps, allSites] = await Promise.all([
      listEntries(sql, {
        from,
        to,
        ...(q.mitarbeiter ? { employeeId: q.mitarbeiter } : {}),
        ...(q.objekt ? { siteId: q.objekt } : {}),
      }),
      listEmployees(sql, { status: 'aktiv' }),
      listSites(sql),
    ]);
    const src = q.quelle === 'import' || q.quelle === 'entfernt' ? q.quelle : '';
    const rows = inScope(c, allRows).filter((r) =>
      src === 'import'
        ? r.created_by.startsWith('ft-import')
        : src === 'entfernt'
          ? r.status === 'abgelehnt'
          : true,
    );
    const sites = allSites.filter((s) => !c.get('sites') || c.get('sites')!.includes(s.id));
    const head = await viewHead(c, 'liste', to);
    const admin = ['admin', 'personal'].includes(c.get('user').role);
    const deletions = admin ? await listDeletions(sql, 50) : [];
    const self = c.req.url.replace(/^https?:\/\/[^/]+/, '');
    return shell(
      c,
      'liste',
      'Zeiterfassung',
      <>
        {head}
        <form method="get" action="/zeiterfassung/liste" class="card grid" style="align-items:end">
          <div>
            <label for="von">von</label>
            <input id="von" type="date" name="von" value={from} />
          </div>
          <div>
            <label for="bis">bis</label>
            <input id="bis" type="date" name="bis" value={to} />
          </div>
          <div>
            <label for="mitarbeiter">Mitarbeiter</label>
            <select id="mitarbeiter" name="mitarbeiter">
              <option value="">alle</option>
              {emps.map((e) => (
                <option value={e.id} selected={e.id === q.mitarbeiter}>
                  {e.last_name}, {e.first_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label for="objekt">Objekt</label>
            <select id="objekt" name="objekt">
              <option value="">alle</option>
              <SiteOptions sites={sites} selected={q.objekt} />
            </select>
          </div>
          <div>
            <label for="quelle">Herkunft</label>
            <select id="quelle" name="quelle" data-nosearch>
              <option value="">alle Zeiten</option>
              <option value="import" selected={src === 'import'}>
                aus Fortytools übernommen
              </option>
              <option value="entfernt" selected={src === 'entfernt'}>
                abgelehnt / entfernt
              </option>
            </select>
          </div>
          <div>
            <button class="btn">Anzeigen</button>
          </div>
          <div class="actions" style="grid-column:1/-1;margin:0">
            <span class="small mut">Schnell:</span>
            {(
              [
                ['Heute', todayBerlin(), todayBerlin()],
                ['Gestern', addDays(todayBerlin(), -1), addDays(todayBerlin(), -1)],
                ['Letzte 7 Tage', addDays(todayBerlin(), -6), todayBerlin()],
                ['Dieser Monat', `${todayBerlin().slice(0, 7)}-01`, todayBerlin()],
              ] as const
            ).map(([l, a, z]) => (
              <a
                class={`btn sm ${from === a && to === z ? '' : 'sec'}`}
                href={`/zeiterfassung/liste?von=${a}&bis=${z}${q.mitarbeiter ? `&mitarbeiter=${q.mitarbeiter}` : ''}${q.objekt ? `&objekt=${q.objekt}` : ''}`}
              >
                {l}
              </a>
            ))}
          </div>
        </form>
        {admin && rows.length > 0 && (
          <form
            id="purge"
            method="post"
            action="/zeiterfassung/loeschen"
            class="card"
            style="border-color:var(--err)"
            onsubmit="var n=document.querySelectorAll('input[name=ids][form=purge]:checked').length;if(!n){alert('Bitte zuerst Zeiten markieren.');return false}return confirm(n+' Zeit(en) endgültig löschen? Das kann nicht rückgängig gemacht werden.')"
          >
            <input type="hidden" name="zurueck" value={self} />
            <b>Markierte Zeiten endgültig löschen</b> <span class="small mut">(Admin, Personal)</span>
            <p class="small mut" style="margin:4px 0 8px">
              Nur für Testdaten und falsch übernommene Zeiten. Echte Arbeitszeiten bitte korrigieren oder
              „entfernen“ – sie müssen 2 Jahre aufbewahrt werden (§ 17 MiLoG). Gelöschte Zeiten stehen mit
              vollem Stand im Löschprotokoll.
            </p>
            <div class="actions" style="margin:0">
              <input name="reason" placeholder="Grund (freiwillig)" style="max-width:360px" />
              <button class="btn danger sm">Markierte löschen</button>
            </div>
          </form>
        )}
        <EntryTable rows={rows} {...(admin ? { selectForm: 'purge' } : {})} />
        {admin && deletions.length > 0 && (
          <details class="card">
            <summary>
              <b>Löschprotokoll</b> <span class="small mut">(letzte {deletions.length})</span>
            </summary>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Gelöscht</th>
                    <th>von</th>
                    <th>Grund</th>
                    <th>Zeit</th>
                    <th>Mitarbeiter</th>
                    <th>Objekt</th>
                  </tr>
                </thead>
                <tbody>
                  {deletions.map((d) => (
                    <tr>
                      <td class="small">
                        {d.deleted_at.toLocaleString('de-DE', {
                          timeZone: 'Europe/Berlin',
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </td>
                      <td class="small">{d.actor}</td>
                      <td class="small">{d.reason}</td>
                      <td class="small">
                        {dateDe(d.work_date)} {clock(new Date(d.start_at))}–
                        {d.end_at ? clock(new Date(d.end_at)) : '…'}
                      </td>
                      <td class="small">{d.employee_name ?? '–'}</td>
                      <td class="small">{d.site_name ?? '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
        <script
          dangerouslySetInnerHTML={{
            __html: `document.addEventListener('change',function(e){var a=e.target.closest&&e.target.closest('input[data-check-all]');if(!a)return;document.querySelectorAll('input[data-check-of="'+a.dataset.checkAll+'"]').forEach(function(x){x.checked=a.checked})});`,
          }}
        />
      </>,
    );
  });

  app.post('/zeiterfassung/loeschen', async (c) => {
    if (!['admin', 'personal'].includes(c.get('user').role))
      throw new BusinessError('Zeiten löschen dürfen nur Admin und Personal');
    const b = await c.req.parseBody({ all: true });
    const ids = ([] as unknown[]).concat(b.ids ?? []).map(String);
    const n = await purgeEntries(sql, ids, String(b.reason ?? ''), c.get('actor'));
    const z =
      typeof b.zurueck === 'string' && b.zurueck.startsWith('/') && !b.zurueck.startsWith('//')
        ? b.zurueck
        : '/zeiterfassung/liste';
    return back(c, z, { ok: n === 1 ? 'Zeit gelöscht.' : `${n} Zeiten gelöscht.` });
  });

  // ------------------------------------------------------------------ Einzelner Eintrag (ansehen, korrigieren, neu)

  app.get(`/zeiterfassung/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const q = c.req.query();
    const [e, emps, allSites] = await Promise.all([getEntry(sql, id), listEmployees(sql), listSites(sql)]);
    if (e) assertSite(c, e.site_id);
    const sites = allSites.filter((s) => !c.get('sites') || c.get('sites')!.includes(s.id));
    const log = e ? await entryLog(sql, id) : [];
    const v = {
      employee: e?.employee_id ?? q.mitarbeiter ?? '',
      site: e?.site_id ?? q.objekt ?? '',
      date: e?.work_date ?? (isDate(q.datum) ? q.datum : todayBerlin()),
      start: e ? clock(e.start_at) : (q.von ?? ''),
      end: e?.end_at ? clock(e.end_at) : (q.bis ?? ''),
      brk: String(e?.break_minutes ?? q.pause ?? 0),
    };
    const fmt = (r: Record<string, unknown> | null | undefined) =>
      r
        ? `${clock(new Date(String(r.start_at)))}–${r.end_at ? clock(new Date(String(r.end_at))) : '…'}, Pause ${String(r.break_minutes)}, ${STATUS_LABEL[r.status as 'erfasst']}`
        : '';
    return shell(
      c,
      'liste',
      e ? 'Zeit' : 'Zeit erfassen',
      <div class="cols">
        <form
          method="post"
          action={`/zeiterfassung/${id}`}
          class="card"
          data-autosave={`/zeiterfassung/${id}`}
          data-version={String(e?.version ?? '')}
        >
          <h2 style="margin-top:0">
            {e ? `${e.employee_name} · ${dateDe(e.work_date)}` : 'Zeit erfassen (Büro)'}
          </h2>
          {e && (
            <p class="small mut" style="margin-top:-6px">
              {SOURCE_LABEL[e.source]}
              {e.via_qr ? ' (QR am Objekt)' : ''} · aufgezeichnet{' '}
              {e.recorded_at.toLocaleString('de-DE', {
                timeZone: 'Europe/Berlin',
                dateStyle: 'short',
                timeStyle: 'short',
              })}{' '}
              von {e.created_by} · <StatusPill e={e} />
            </p>
          )}
          {e && <Warnings e={e} />}
          <input type="hidden" name="version" value={String(e?.version ?? '')} />
          <div class="grid">
            <div>
              <label for="employee_id">Mitarbeiter</label>
              <select id="employee_id" name="employee_id" required>
                <option value="">– bitte wählen –</option>
                {emps.map((m) => (
                  <option value={m.id} selected={m.id === v.employee}>
                    {m.last_name}, {m.first_name} ({m.personnel_no})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label for="site_id">Objekt</label>
              <select id="site_id" name="site_id" required>
                <option value="">– bitte wählen –</option>
                <SiteOptions sites={sites} selected={v.site} />
              </select>
            </div>
            <div>
              <label for="date">Arbeitstag</label>
              <input id="date" type="date" name="date" value={v.date} required />
            </div>
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
              <input id="break_minutes" type="number" name="break_minutes" min="0" max="240" value={v.brk} />
            </div>
          </div>
          <div style="margin-top:12px">
            <label for="reason">Begründung (Pflicht, wird protokolliert)</label>
            <input
              id="reason"
              name="reason"
              required
              placeholder="z. B. lt. Stundenzettel / Rücksprache Objektleitung"
            />
          </div>
          <p class="small mut">
            Ende vor Beginn = über Mitternacht. Falsche Einträge korrigieren oder unten „Zeit entfernen“ – sie
            zählen dann nirgends mehr, bleiben aber im Protokoll (§ 17 MiLoG).
          </p>
          <div class="formfoot">
            <a class="btn sec" href="/zeiterfassung">
              Abbrechen
            </a>
            <button class="btn">Speichern</button>
          </div>
        </form>
        <div class="card">
          {e && ['admin', 'personal'].includes(c.get('user').role) && (
            <form
              method="post"
              action="/zeiterfassung/loeschen"
              style="margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--line)"
              onsubmit="return confirm('Diese Zeit endgültig löschen? Das kann nicht rückgängig gemacht werden.')"
            >
              <h3 style="margin-top:0">Zeit löschen</h3>
              <p class="small mut" style="margin-top:0">
                Nur für Testdaten oder falsch übernommene Zeiten. Der Stand bleibt im Löschprotokoll.
              </p>
              <input type="hidden" name="ids" value={id} />
              <input type="hidden" name="zurueck" value="/zeiterfassung/liste" />
              <input name="reason" placeholder="Grund (freiwillig)" aria-label="Grund" />
              <div class="actions">
                <button class="btn danger sm">Endgültig löschen</button>
              </div>
            </form>
          )}
          {e && e.status !== 'abgelehnt' && (
            <form
              method="post"
              action={`/zeiterfassung/${id}/entfernen`}
              style="margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--line)"
              onsubmit="return confirm('Diese Zeit entfernen? Sie zählt danach nicht mehr (Stundenliste, Lohn, Soll/Ist), bleibt aber im Protokoll.')"
            >
              <h3 style="margin-top:0">Zeit entfernen</h3>
              <label for="rm-reason">Begründung (Pflicht)</label>
              <input
                id="rm-reason"
                name="reason"
                required
                placeholder="z. B. doppelt gestempelt / falscher Mitarbeiter"
              />
              <div class="actions">
                <button class="btn danger sm">Zeit entfernen</button>
              </div>
            </form>
          )}
          <h3>Änderungsprotokoll</h3>
          {log.length === 0 && <div class="mut small">Noch keine Einträge.</div>}
          {log.map((l) => (
            <div class="small" style="padding:6px 0;border-bottom:1px solid var(--line)">
              <b>
                {l.at.toLocaleString('de-DE', {
                  timeZone: 'Europe/Berlin',
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}
              </b>{' '}
              · {l.actor ?? 'System'}
              {l.reason && <> · „{l.reason}“</>}
              <div class="mut">
                {l.old_row ? (
                  <>
                    {fmt(l.old_row as Record<string, unknown>)} →{' '}
                    {fmt(l.new_row as unknown as Record<string, unknown>)}
                  </>
                ) : (
                  <>angelegt: {fmt(l.new_row as unknown as Record<string, unknown>)}</>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>,
    );
  });

  app.post(`/zeiterfassung/:id{${UUID}}`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const cur = await getEntry(sql, id);
    if (cur) assertSite(c, cur.site_id);
    assertSite(c, String(b.site_id ?? ''));
    await officeSave(sql, {
      id,
      employeeId: String(b.employee_id ?? ''),
      siteId: String(b.site_id ?? ''),
      date: String(b.date ?? ''),
      start: String(b.start ?? ''),
      end: String(b.end ?? ''),
      breakMinutes: Number(b.break_minutes ?? 0) || 0,
      reason: String(b.reason ?? ''),
      expectedVersion: versionOf(b.version),
      actor: c.get('actor'),
    });
    return back(c, `/zeiterfassung/${id}`, { ok: 'Zeit gespeichert und protokolliert.' });
  });

  app.post(`/zeiterfassung/:id{${UUID}}/entfernen`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const cur = await getEntry(sql, id);
    if (!cur) return c.notFound();
    assertSite(c, cur.site_id);
    await officeRemove(sql, id, String(b.reason ?? ''), c.get('actor'));
    const back2 =
      typeof b.zurueck === 'string' && b.zurueck.startsWith('/') && !b.zurueck.startsWith('//')
        ? b.zurueck
        : `/zeiterfassung/${id}`;
    return back(c, back2, { ok: 'Zeit entfernt – zählt nicht mehr, steht im Protokoll.' });
  });

  // ------------------------------------------------------------------ Monat Soll/Ist

  app.get('/zeiterfassung/monat', async (c) => {
    const month = isMonth(c.req.query('monat')) ? c.req.query('monat')! : todayBerlin().slice(0, 7);
    const s = await monthSummary(sql, month);
    return shell(
      c,
      'monat',
      'Monat Soll/Ist',
      <>
        <form method="get" action="/zeiterfassung/monat" class="actions" style="margin-top:0">
          <input
            type="month"
            name="monat"
            value={month}
            style="max-width:200px"
            onchange="this.form.submit()"
          />
          <span class="mut small">
            Soll aus dem Einsatzplan (ohne Urlaub/Krank), Ist aus erfassten und freigegebenen Zeiten.
            Mindestlohn-Prüfung gegen {euro(s.minWage)}/Std. (
            <a href="/zeiterfassung/einstellungen">ändern</a>).
          </span>
        </form>
        <div class="tbl">
          <table>
            <thead>
              <tr>
                <th>Mitarbeiter</th>
                <th class="r">Soll</th>
                <th class="r">Ist</th>
                <th class="r">Differenz</th>
                <th class="r">fehlende Zeiten</th>
                <th class="r">Hinweise</th>
                <th>Stundenlohn</th>
              </tr>
            </thead>
            <tbody>
              {s.rows.map((r) => (
                <tr>
                  <td>
                    <a href={`/personal/${r.id}/zeiten`}>{r.name}</a>{' '}
                    <span class="mut small">{r.personnel_no}</span>
                  </td>
                  <td class="r">{hm(r.soll)}</td>
                  <td class="r">{hm(r.ist)}</td>
                  <td
                    class="r"
                    style={
                      r.ist - r.soll < -60
                        ? 'color:var(--err)'
                        : r.ist - r.soll > 60
                          ? 'color:var(--warn)'
                          : ''
                    }
                  >
                    {r.ist - r.soll > 0 ? '+' : ''}
                    {hm(r.ist - r.soll)}
                  </td>
                  <td class="r">{r.missing ? <span class="badge err">{r.missing}</span> : '–'}</td>
                  <td class="r">{r.warnings ? <span class="badge warn">{r.warnings}</span> : '–'}</td>
                  <td>
                    {r.hourly_wage_cents !== null ? euro(r.hourly_wage_cents) : '–'}
                    {r.belowMinWage && (
                      <>
                        {' '}
                        <span class="badge err">unter Mindestlohn</span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>,
    );
  });

  // Prüfbericht Zoll entfernt (Ahmed 07.10.) – die Stundenliste je Mitarbeiter enthält Beginn, Ende, Dauer (§ 17 MiLoG)
  app.get('/zeiterfassung/pruefbericht', (c) => c.redirect('/zeiterfassung/stundenzettel', 301));
  app.get('/zeiterfassung/pruefbericht.csv', (c) => c.redirect('/zeiterfassung/stundenzettel', 301));

  app.get('/zeiterfassung/einstellungen', async (c) => {
    const s = await getTimeSettings(sql);
    const [autoCfg] = await sql<{ days: number | null; since: string | null }[]>`
      select auto_confirm_days as days, auto_confirm_since::text as since from app.time_settings`;
    const geo = await geoCheckEnabled(sql);
    const [withGeo] = await sql<{ n: number; all: number }[]>`
      select count(*) filter (where geo_lat is not null)::int as n, count(*)::int as all from app.sites where active`;
    return shell(
      c,
      'einstellungen',
      'Einstellungen Zeiterfassung',
      <>
        <form
          method="post"
          action="/zeiterfassung/einstellungen/standort"
          class="card"
          style="max-width:720px"
        >
          <h3 style="margin-top:0">Stempeln mit Standort</h3>
          <div class="chk">
            <input type="checkbox" id="geo" name="geo" checked={geo} />
            <label for="geo">Beim Ein- und Ausstempeln den Standort prüfen</label>
          </div>
          <p class="small mut">
            Das Handy fragt nur im Moment des Stempelns nach dem Standort. Gespeichert wird nur, ob die Person
            am Objekt war (Entfernung in Metern, Genauigkeit) – keine Koordinaten, kein Bewegungsprofil.
            Stempeln wird nie verweigert; „nicht am Objekt“ erscheint in der Zeiterfassung zur Klärung.
            Standort je Objekt: Objekt → Bearbeiten (Google-Maps-Link einfügen) oder in der App vor Ort
            „Standort hier speichern“. Derzeit {withGeo!.n} von {withGeo!.all} aktiven Objekten mit Standort.
          </p>
          <p class="small" style="color:var(--warn)">
            <b>Datenschutz:</b> Mitarbeitende vorher schriftlich informieren (Art. 13 DSGVO, Zweck: Nachweis
            der Anwesenheit am Einsatzort); gibt es einen Betriebsrat, ist er zu beteiligen (§ 87 Abs. 1 Nr. 6
            BetrVG). Ins Verzeichnis der Verarbeitungstätigkeiten aufnehmen.
          </p>
          <div class="formfoot">
            <button class="btn">Speichern</button>
          </div>
        </form>
        <form
          method="post"
          action="/zeiterfassung/einstellungen/plan-als-ist"
          class="card"
          style="max-width:720px"
        >
          <h3 style="margin-top:0">Soll als Ist automatisch</h3>
          <label for="auto_days">
            Einsätze ohne erfasste Zeit nach … Tagen mit den Plan-Zeiten übernehmen
          </label>
          <select id="auto_days" name="days" style="max-width:220px">
            <option value="">aus</option>
            {[1, 2, 3, 5, 7].map((n) => (
              <option value={String(n)} selected={autoCfg?.days === n}>
                nach {n} {n === 1 ? 'Tag' : 'Tagen'}
              </option>
            ))}
          </select>
          <p class="small mut">
            Nicht bei Abwesenheit, Ausfall, Feiertag oder Überschneidung. Im Protokoll steht „automatisch“;
            die Zeit lässt sich wie jede andere ändern oder löschen.
            {autoCfg?.since ? ` Gilt für Einsätze ab ${dateDe(autoCfg.since)}.` : ''}
          </p>
          <p class="small" style="color:var(--warn)">
            <b>§ 17 MiLoG:</b> Aufgezeichnet werden muss die tatsächliche Arbeitszeit. Wer anders gearbeitet
            hat (später gekommen, früher gegangen), muss innerhalb der Frist korrigiert werden – sonst ist die
            Aufzeichnung falsch (Bußgeld bis 30.000 €).
          </p>
          <div class="formfoot">
            <button class="btn">Speichern</button>
          </div>
        </form>
        <form method="post" action="/zeiterfassung/einstellungen" class="card" style="max-width:720px">
          <div class="grid">
            <div>
              <label for="min_wage">Mindest-Stundenlohn für die Prüfung (€)</label>
              <input id="min_wage" name="min_wage" value={centsToInput(s.min_wage_cents)} required />
            </div>
          </div>
          <div style="margin-top:12px">
            <label for="note">Notiz</label>
            <textarea id="note" name="note">
              {s.min_wage_note ?? ''}
            </textarea>
          </div>
          <p class="small mut">
            Für die Gebäudereinigung gilt der allgemeinverbindliche Branchen-Mindestlohn (Lohngruppe 1), der
            über dem gesetzlichen Mindestlohn liegt. Bitte den aktuellen Wert aus dem Tarifvertrag eintragen.
          </p>
          <div class="formfoot">
            <button class="btn">Speichern</button>
          </div>
        </form>
      </>,
    );
  });

  app.post('/zeiterfassung/einstellungen/plan-als-ist', async (c) => {
    const b = await c.req.parseBody();
    const d = Number(b.days);
    const days = Number.isInteger(d) && d >= 1 && d <= 14 ? d : null;
    // beim Einschalten ab heute (kein rückwirkendes Auffüllen), beim Ändern der Tage Stichtag behalten
    await sql`update app.time_settings set auto_confirm_days = ${days},
                     auto_confirm_since = case when ${days}::int is null then null
                       else coalesce(auto_confirm_since, (now() at time zone 'Europe/Berlin')::date) end`;
    await sql`insert into app.audit_log (actor, action, entity, details)
              values (${c.get('actor')}, 'save', 'time_settings', ${sql.json({ auto_confirm_days: days })})`;
    return back(c, '/zeiterfassung/einstellungen', {
      ok: days ? `Soll als Ist nach ${days} Tag(en) eingeschaltet.` : 'Soll als Ist automatisch aus.',
    });
  });

  app.post('/zeiterfassung/einstellungen/standort', async (c) => {
    const b = await c.req.parseBody();
    const on = b.geo === 'on';
    await sql`update app.time_settings set geo_check = ${on}`;
    await sql`insert into app.audit_log (actor, action, entity, details)
              values (${c.get('actor')}, 'save', 'time_settings', ${sql.json({ geo_check: on })})`;
    return back(c, '/zeiterfassung/einstellungen', {
      ok: on ? 'Standortprüfung eingeschaltet.' : 'Standortprüfung aus.',
    });
  });

  app.post('/zeiterfassung/einstellungen', async (c) => {
    const b = await c.req.parseBody();
    let cents: bigint;
    try {
      cents = parseEuro(String(b.min_wage ?? ''));
    } catch {
      throw new BusinessError('Betrag ungültig');
    }
    await saveTimeSettings(
      sql,
      cents,
      typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null,
      c.get('actor'),
    );
    return back(c, '/zeiterfassung/einstellungen', { ok: 'Gespeichert.' });
  });

  // ------------------------------------------------------------------ Reiter bei Mitarbeiter und Objekt

  // Zeiten beim Mitarbeiter: gleiche Ansicht wie Einsatzkalender/Zeiterfassung, standardmäßig als Liste (Ahmed 08.10.)
  app.get(`/personal/:id{${UUID}}/zeiten`, (c) =>
    shells.employee!(c, 'zeiten', async (e) => {
      const d = await employeeCalendarData(sql, e.id, c.req.query(), {
        defaultView: 'liste',
        siteScope: c.get('sites'),
      });
      return (
        <EmployeeCalendarView
          employeeId={e.id}
          today={todayBerlin()}
          holiday={holidayName}
          canEdit
          canDeleteTime={['admin', 'personal'].includes(c.get('user').role)}
          base={`/personal/${e.id}/zeiten`}
          confirmAction="/zeiterfassung/plan-als-ist"
          {...d}
        />
      );
    }),
  );

  app.get(`/personal/:id{${UUID}}/app-zugang`, (c) =>
    shells.employee!(c, 'app', async (e) => {
      const pin = await hasPin(sql, e.id);
      return (
        <div class="cols">
          <form method="post" action={`/personal/${e.id}/app-zugang`} class="card">
            <h3>PIN für die Handy-Zeiterfassung</h3>
            <p class="small mut" style="margin-top:0">
              Anmeldung unter <b>/m</b> mit Personalnummer <b>{e.personnel_no}</b> und PIN. Die PIN wird nur
              verschlüsselt gespeichert und kann nicht angezeigt werden – bei „vergessen“ einfach neu setzen.
              Nach 5 Fehlversuchen ist der Zugang 15 Minuten gesperrt; neu setzen entsperrt sofort.
            </p>
            <p class="small" style="background:var(--warn-50,#fffaeb);padding:8px 10px;border-radius:6px">
              <b>Ohne eigene PIN:</b> Geburtsdatum als <b>TTMMJJ</b> (z. B. 15.03.1985 → 150385), sobald es in
              den Stammdaten steht. Hinweis: Kollegen kennen oft Personalnummer und Geburtstag – wer sicher
              gehen will, setzt hier eine eigene PIN.
            </p>
            <p>
              Status:{' '}
              {!pin ? (
                <span class="badge">keine eigene PIN – Geburtsdatum TTMMJJ</span>
              ) : pin.locked ? (
                <span class="badge err">gesperrt</span>
              ) : (
                <span class="badge ok">aktiv</span>
              )}
            </p>
            <label for="pin">Neue PIN (4–6 Ziffern)</label>
            <input
              id="pin"
              name="pin"
              inputmode="numeric"
              pattern="[0-9]{4,6}"
              autocomplete="off"
              required
              style="max-width:200px"
            />
            <div class="formfoot">
              <button class="btn">PIN setzen</button>
            </div>
          </form>
          <div class="card">
            <h3>So stempeln Mitarbeitende</h3>
            <ol class="small" style="padding-left:18px;margin:0">
              <li>
                QR-Code am Objekt mit der Handy-Kamera scannen (Aushang unter Objekt → „QR-Aushang
                Zeiterfassung“).
              </li>
              <li>Einmalig mit Personalnummer und PIN anmelden (bleibt 14 Tage angemeldet).</li>
              <li>„Arbeit beginnen“ – am Ende „Arbeit beenden“ mit Pause.</li>
              <li>Vergessen? „Zeit nachtragen“ – das Büro gibt frei.</li>
            </ol>
            <p class="small mut">
              Sprachen: Deutsch, Englisch, Rumänisch, Türkisch, Polnisch, Kroatisch/Bosnisch/Serbisch,
              Bulgarisch.
            </p>
          </div>
        </div>
      );
    }),
  );

  app.post(`/personal/:id{${UUID}}/app-zugang`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    await setPin(sql, id, String(b.pin ?? '').trim(), c.get('actor'));
    return back(c, `/personal/${id}/app-zugang`, {
      ok: 'PIN gesetzt. Bitte dem Mitarbeiter persönlich mitteilen.',
    });
  });

  app.get(`/objekte/:id{${UUID}}/zeiten`, (c) =>
    shells.site!(c, 'zeiten', async (s) => {
      const today = todayBerlin();
      const qm = c.req.query('monat');
      const month = qm && /^\d{4}-(0[1-9]|1[0-2])$/.test(qm) ? qm : today.slice(0, 7);
      const custom = isDate(c.req.query('von')) && isDate(c.req.query('bis'));
      const { from, to } = custom
        ? { from: c.req.query('von')!, to: c.req.query('bis')! }
        : monthRange(month);
      const details = c.req.query('ansicht') === 'details';
      const base = `/objekte/${s.id}/zeiten`;
      const [t, months] = await Promise.all([
        // Geplant nur bis heute, sonst zählt der Rest des laufenden Monats als Fehlzeit
        siteTimes(sql, s.id, from, to < today ? to : today),
        siteMonthOverview(sql, s.id, today.slice(0, 7), 12, today),
      ]);
      const qs = (over: Record<string, string>) =>
        `${base}?${new URLSearchParams({
          ...(custom ? { von: from, bis: to } : { monat: month }),
          ...(details ? { ansicht: 'details' } : {}),
          ...over,
        }).toString()}`;
      const canConfirm = c.get('user').role !== 'objektleitung';
      return (
        <>
          <div class="calbar" style="display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin-bottom:12px">
            <form method="get" action={base} style="display:flex;gap:8px;align-items:end;margin:0">
              <div>
                <label for="monat" class="small">
                  Monat
                </label>
                <input type="month" id="monat" name="monat" value={custom ? '' : month} />
              </div>
              {details && <input type="hidden" name="ansicht" value="details" />}
              <button class="btn sm sec">Anzeigen</button>
            </form>
            <form method="get" action={base} style="display:flex;gap:8px;align-items:end;margin:0">
              <div>
                <label for="von" class="small">
                  oder von
                </label>
                <input type="date" id="von" name="von" value={custom ? from : ''} />
              </div>
              <div>
                <label for="bis" class="small">
                  bis
                </label>
                <input type="date" id="bis" name="bis" value={custom ? to : ''} />
              </div>
              {details && <input type="hidden" name="ansicht" value="details" />}
              <button class="btn sm sec">Zeitraum</button>
            </form>
            <span style="margin-left:auto" class="seg-links">
              <a class={`btn sm ${details ? 'sec' : ''}`} href={qs({ ansicht: 'uebersicht' })}>
                Übersicht
              </a>{' '}
              <a class={`btn sm ${details ? '' : 'sec'}`} href={qs({ ansicht: 'details' })}>
                Details
              </a>{' '}
              <a class="btn sm sec" href={`/zeiterfassung/${randomUUID()}?objekt=${s.id}`}>
                + Zeit erfassen
              </a>
            </span>
          </div>
          <p class="small mut" style="margin-top:0">
            {custom ? `${dateDe(from)} – ${dateDe(to)}` : monthName(month)}: Dauer = erfasste und freigegebene
            Zeiten (netto, ohne Pausen), Geplant = Einsatzplan ohne Feiertage, höchstens bis heute.
            {t.total.pending > 0 && <b> {t.total.pending} Nachtrag/Nachträge warten auf Freigabe.</b>}
          </p>
          {details ? (
            <TimesDetails entries={t.entries.map((e) => ({ ...e, planned: plannedFor(t.shifts, e) }))} />
          ) : (
            <TimesOverview sums={t.sums} total={t.total} />
          )}
          <MonthOverview rows={months} base={base} canConfirm={canConfirm} current={custom ? '' : month} />
        </>
      );
    }),
  );

  app.post(`/objekte/:id{${UUID}}/zeiten/bestaetigen`, async (c) => {
    const siteId = c.req.param('id');
    assertSite(c, siteId);
    if (c.get('user').role === 'objektleitung') throw new BusinessError('Zeiterfassung bestätigt das Büro');
    const b = await c.req.parseBody();
    const month = String(b.monat ?? '');
    const yes = b.bestaetigt === '1';
    await confirmSiteMonth(sql, siteId, month, yes, c.get('actor'), todayBerlin());
    return back(c, `/objekte/${siteId}/zeiten?monat=${month}`, {
      ok: yes
        ? `Zeiterfassung ${monthName(month)} bestätigt.`
        : `Bestätigung ${monthName(month)} zurückgenommen.`,
    });
  });

  // QR-Aushang am Objekt
  const qrUrl = (c: Context<AppEnv>, token: string) =>
    `${env.PUBLIC_URL ?? new URL(c.req.url).origin}/m/o/${token}`;

  // Sammeldruck: QR-Aushänge aller Objekte der aktuellen Auswahl (je Seite ein Aushang)
  app.get('/objekte/qr-druck', async (c) => {
    const { rows } = await filteredSites(
      sql,
      c.get('sites'),
      parseSiteFilter((k) => c.req.query(k)),
    );
    const list = rows.filter((s) => s.active).slice(0, 200);
    const posters = await Promise.all(
      list.map(async (s) => ({
        s,
        url: qrUrl(c, s.clock_token),
        svg: await QRCode.toString(qrUrl(c, s.clock_token), {
          type: 'svg',
          margin: 1,
          errorCorrectionLevel: 'M',
        }),
      })),
    );
    return c.html(
      `<!doctype html>${(
        <html lang="de">
          <head>
            <meta charset="utf-8" />
            <title>QR-Aushänge</title>
            <style
              dangerouslySetInnerHTML={{
                __html: `body{font-family:Inter,system-ui,sans-serif;margin:0;color:#1a1a1a}
.p{page-break-after:always;break-after:page;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px}
.k{font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:#7D1435;font-weight:700}
h1{font-size:34px;margin:10px 0 4px}.n{color:#666;font-size:16px}
.q{width:380px;margin:28px auto}.t{font-size:18px;font-weight:600}.l{font-size:13px;color:#555;margin-top:6px}
.bar{position:fixed;top:0;left:0;right:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 16px;display:flex;gap:12px;align-items:center}
@media print{.bar{display:none}}`,
              }}
            />
          </head>
          <body>
            <div class="bar">
              <b>{list.length} Aushänge</b>
              <button onclick="window.print()">Drucken</button>
              <span style="color:#666;font-size:13px">nur aktive Objekte · je Seite ein Aushang</span>
            </div>
            {posters.map(({ s, svg }) => (
              <div class="p">
                <img
                  src="/static/logo-transparent.png"
                  alt="Viva-Deluxe"
                  style="height:56px;margin-bottom:18px"
                />
                <div class="k">Zeiterfassung</div>
                <h1>{s.name}</h1>
                <div class="n">
                  Objekt {s.site_no} · {s.customer_name}
                </div>
                <div class="q" dangerouslySetInnerHTML={{ __html: svg }} />
                <div class="t">Arbeit beginnen / beenden: Code mit der Handy-Kamera scannen.</div>
                <div class="l">
                  Start work · Începe lucrul · İşe başla · Rozpocznij pracę · Početak rada · Започни работа
                </div>
              </div>
            ))}
            {!posters.length && <p style="padding:80px 20px">Keine aktiven Objekte in der Auswahl.</p>}
          </body>
        </html>
      ).toString()}`,
    );
  });

  app.get(`/objekte/:id{${UUID}}/qr`, (c) =>
    shells.site!(c, 'qr', async (s) => {
      const url = qrUrl(c, s.clock_token);
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      const plans = await listShiftPlans(sql, { siteId: s.id, activeOn: todayBerlin() });
      return (
        <div class="cols">
          <div class="card" style="text-align:center">
            <div style="font-size:13px;color:var(--mut);letter-spacing:.06em;text-transform:uppercase">
              Zeiterfassung
            </div>
            <h2 style="margin:6px 0 2px">{s.name}</h2>
            <div class="mut">Objekt {s.site_no}</div>
            <div style="max-width:320px;margin:16px auto" dangerouslySetInnerHTML={{ __html: svg }} />
            <div class="small">
              <b>Arbeit beginnen / beenden: Code mit der Handy-Kamera scannen.</b>
              <br />
              Start work · Începe lucrul · İşe başla · Rozpocznij pracę · Početak rada · Започни работа
            </div>
            <div class="small mut" style="margin-top:8px;word-break:break-all">
              {url}
            </div>
          </div>
          <div>
            <div class="card">
              <h3>Aushang</h3>
              <p class="small" style="margin-top:0">
                Diese Seite drucken (Strg+P), laminieren und gut sichtbar im Objekt aufhängen, z. B. am
                Putzraum. Wer den Code scannt, kommt direkt zur Stempelseite dieses Objekts. Stempeln dort
                wird als „QR am Objekt“ gekennzeichnet.
              </p>
              <p class="small mut">
                Hinweis: Ein abfotografierter Code funktioniert auch von zu Hause. Für echte
                Anwesenheitsprüfung später optional Standort-Abgleich oder NFC-Aufkleber.
              </p>
              <form
                method="post"
                action={`/objekte/${s.id}/qr/neu`}
                onsubmit="return confirm('Neuen Code erzeugen? Alte Aushänge funktionieren dann nicht mehr.')"
              >
                <button class="btn sec">Neuen Code erzeugen (alter wird ungültig)</button>
              </form>
            </div>
            <div class="card">
              <h3>Standort für das Stempeln</h3>
              {(() => {
                const g = s as unknown as {
                  geo_lat: string | null;
                  geo_lng: string | null;
                  geo_radius_m: number;
                };
                return (
                  <form method="post" action={`/objekte/${s.id}/standort`} data-no-autosave>
                    <p class="small" style="margin-top:0">
                      {g.geo_lat
                        ? `Hinterlegt: ${g.geo_lat}, ${g.geo_lng} (Umkreis ${g.geo_radius_m} m).`
                        : 'Noch kein Standort hinterlegt.'}{' '}
                      Wird nur genutzt, wenn unter Zeiterfassung → Einstellungen „Stempeln mit Standort“
                      eingeschaltet ist.
                    </p>
                    <label for="geo_input">Google-Maps-Link oder Koordinaten („48.137, 11.575“)</label>
                    <input id="geo_input" name="geo" value={g.geo_lat ? `${g.geo_lat}, ${g.geo_lng}` : ''} />
                    <label for="geo_radius">Umkreis in Metern</label>
                    <input
                      id="geo_radius"
                      name="radius"
                      type="number"
                      min={50}
                      max={5000}
                      value={String(g.geo_radius_m ?? 250)}
                    />
                    <div class="actions">
                      <button class="btn sec sm">Standort speichern</button>
                      <button
                        type="button"
                        class="btn sec sm"
                        onclick="var b=this,f=b.form;b.disabled=true;navigator.geolocation.getCurrentPosition(function(p){f.geo.value=p.coords.latitude.toFixed(6)+', '+p.coords.longitude.toFixed(6);b.disabled=false;},function(){alert('Standort nicht verfügbar');b.disabled=false;},{enableHighAccuracy:true,timeout:10000})"
                      >
                        Mein aktueller Standort (vor Ort)
                      </button>
                    </div>
                  </form>
                );
              })()}
            </div>
            <div class="card">
              <h3>Aktuell eingeplant</h3>
              {plans.length === 0 && <div class="mut small">Noch niemand eingeplant.</div>}
              {plans.map((p) => (
                <div class="small">
                  {WEEKDAYS_SHORT[p.weekday]} {p.start_time}–{p.end_time} · {p.employee_name}
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    }),
  );

  app.post(`/objekte/:id{${UUID}}/standort`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const raw = typeof b.geo === 'string' ? b.geo.trim() : '';
    const radius = Math.round(Number(b.radius ?? 250));
    if (!(radius >= 50 && radius <= 5000)) throw new BusinessError('Umkreis bitte zwischen 50 und 5000 m');
    const pos = raw ? parseCoordinates(raw) : null;
    if (raw && !pos)
      throw new BusinessError(
        'Koordinaten nicht erkannt – Google-Maps-Link (mit @48.1…,11.5…) oder „48.137, 11.575“',
      );
    await sql`update app.sites set geo_lat = ${pos?.lat ?? null}, geo_lng = ${pos?.lng ?? null}, geo_radius_m = ${radius},
                     updated_at = now() where id = ${id}`;
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${c.get('actor')}, 'site_geo', 'site', ${id}, ${sql.json({ lat: pos?.lat ?? null, lng: pos?.lng ?? null, radius })})`;
    return back(c, `/objekte/${id}/qr`, { ok: pos ? 'Standort gespeichert.' : 'Standort entfernt.' });
  });

  app.post(`/objekte/:id{${UUID}}/qr/neu`, async (c) => {
    const id = c.req.param('id');
    await sql`update app.sites set clock_token = replace(gen_random_uuid()::text, '-', '') where id = ${id}`;
    await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${c.get('actor')}, 'new_clock_token', 'site', ${id})`;
    return back(c, `/objekte/${id}/qr`, { ok: 'Neuer QR-Code erzeugt. Bitte neu ausdrucken und aufhängen.' });
  });
}

/** Nachträge zur Freigabe (auch direkt auf der Zeiterfassungs-Seite) */
const RequestsList = ({ requests, stale }: { requests: TimeEntryRow[]; stale: TimeEntryRow[] }) => (
  <>
    {requests.length === 0 && <div class="empty">Keine offenen Nachträge.</div>}
    {requests.map((e) => (
      <div class="card">
        <div class="actions" style="margin-top:0">
          <b>{e.employee_name}</b>
          <span class="mut">
            {weekdayDe(e.work_date)} {dateDe(e.work_date)} · {e.site_name}
          </span>
          <span style="margin-left:auto" class="sum">
            {clock(e.start_at)}–{clock(e.end_at)} · Pause {e.break_minutes} Min. · {hm(netMinutes(e))} Std.
          </span>
        </div>
        <div class="small">
          Grund: <b>{e.note}</b> · beantragt{' '}
          {e.recorded_at.toLocaleString('de-DE', {
            timeZone: 'Europe/Berlin',
            dateStyle: 'short',
            timeStyle: 'short',
          })}
        </div>
        <Warnings e={e} />
        <div class="actions" style="margin-bottom:0">
          <form method="post" action={`/zeiterfassung/${e.id}/entscheiden`}>
            <input type="hidden" name="ok" value="1" />
            <button class="btn">
              <Icon name="check" /> Freigeben
            </button>
          </form>
          <form method="post" action={`/zeiterfassung/${e.id}/entscheiden`} class="actions" style="margin:0">
            <input name="reason" placeholder="Grund der Ablehnung" required style="max-width:260px" />
            <button class="btn danger">Ablehnen</button>
          </form>
          <a class="btn ghost" href={`/zeiterfassung/${e.id}`}>
            Ändern …
          </a>
        </div>
      </div>
    ))}
    {stale.length > 0 && (
      <div class="warnbox">
        <h3>Seit über 12 Stunden eingestempelt</h3>
        {stale.map((e) => (
          <div>
            <a href={`/zeiterfassung/${e.id}`}>{e.employee_name}</a> – seit {dateDe(e.work_date)}{' '}
            {clock(e.start_at)} ({e.site_name})
          </div>
        ))}
      </div>
    )}
  </>
);
