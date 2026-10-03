import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Child, FC } from 'hono/jsx';
import QRCode from 'qrcode';
import { todayBerlin } from '../domain/invoice/calc.js';
import { parseEuro } from '../domain/money/money.js';
import { addDays, holidayName } from '../domain/time/holidays.js';
import { hasPin, setPin } from '../services/employee-auth.js';
import { listEmployees } from '../services/employees.js';
import { BusinessError } from '../services/errors.js';
import { listSites } from '../services/masterdata.js';
import {
  type ReportRow,
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
  plannedShifts,
  saveTimeSettings,
  warningsFor,
  WEEKDAYS_SHORT,
  zollCsv,
  zollReport,
} from '../services/time.js';
import { type AppEnv, type Ctx, UUID, assertSite, inScope } from './app.js';
import { centsToInput } from './forms.js';
import { canAccess } from './permissions.js';
import { Icon } from './icons.js';
import { PageHead, type Tab, Tabs, dateDe, euro } from './layout.js';

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
export const EntryTable: FC<{ rows: TimeEntryRow[]; show?: 'employee' | 'site' | 'both' }> = ({
  rows,
  show = 'both',
}) => {
  const total = rows
    .filter((r) => r.end_at && r.status !== 'abgelehnt' && r.status !== 'beantragt')
    .reduce((s, r) => s + netMinutes(r), 0);
  return (
    <div class="tbl">
      <table>
        <thead>
          <tr>
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
              <td colspan={9}>
                <div class="empty">Keine Zeiten im gewählten Zeitraum.</div>
              </td>
            </tr>
          )}
          {rows.map((e) => (
            <tr>
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
              <td colspan={show === 'both' ? 5 : 4} class="r">
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

export function registerTimeRoutes({ app, deps, page, back, shells }: Ctx) {
  const { sql, env } = deps;

  const shell = async (c: Context<AppEnv>, active: string, title: string, body: Child, nav = 'personal') => {
    const scope = c.get('sites');
    const [[cnt]] = await Promise.all([
      sql<{ running: number; requests: number }[]>`
        select count(*) filter (where status = 'laeuft')::int as running, count(*) filter (where status = 'beantragt')::int as requests
          from app.time_entries where ${scope ? sql`site_id in ${sql(scope.length ? scope : ['00000000-0000-0000-0000-000000000000'])}` : sql`true`}`,
    ]);
    const tabs: Tab[] = [
      { key: 'tag', label: 'Tagesübersicht', href: '/zeiterfassung' },
      { key: 'freigaben', label: 'Freigaben', href: '/zeiterfassung/freigaben', count: cnt!.requests },
      { key: 'liste', label: 'Alle Zeiten', href: '/zeiterfassung/liste' },
      { key: 'monat', label: 'Monat Soll/Ist', href: '/zeiterfassung/monat' },
      { key: 'zoll', label: 'Prüfbericht Zoll', href: '/zeiterfassung/pruefbericht' },
      { key: 'einstellungen', label: 'Einstellungen', href: '/zeiterfassung/einstellungen' },
    ].filter((t) => canAccess(c.get('user').role, t.href));
    return page(
      c,
      title,
      nav,
      <>
        <PageHead title="Zeiterfassung">
          <span class="badge info" style="margin-left:4px">
            {cnt!.running} jetzt im Einsatz
          </span>
          <a class="btn sec" href="/m" target="_blank" style="margin-left:auto">
            <Icon name="user" /> Mitarbeiter-Ansicht
          </a>
          <a class="btn" href={`/zeiterfassung/${randomUUID()}`}>
            <Icon name="plus" /> Zeit erfassen
          </a>
        </PageHead>
        <Tabs tabs={tabs} active={active} />
        {body}
      </>,
    );
  };

  // ------------------------------------------------------------------ Tagesübersicht

  app.get('/zeiterfassung', async (c) => {
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
    return shell(
      c,
      'tag',
      'Zeiterfassung',
      <>
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
        {requests.length === 0 && <div class="empty">Keine offenen Nachträge.</div>}
        {requests.map((e) => (
          <div class="card">
            <div class="actions" style="margin-top:0">
              <b>{e.employee_name}</b>
              <span class="mut">
                {weekdayDe(e.work_date)} {dateDe(e.work_date)} · {e.site_name}
              </span>
              <span style="margin-left:auto" class="sum">
                {clock(e.start_at)}–{clock(e.end_at)} · Pause {e.break_minutes} Min. · {hm(netMinutes(e))}{' '}
                Std.
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
              <form
                method="post"
                action={`/zeiterfassung/${e.id}/entscheiden`}
                class="actions"
                style="margin:0"
              >
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
      </>,
    );
  });

  app.post(`/zeiterfassung/:id{${UUID}}/entscheiden`, async (c) => {
    const id = c.req.param('id');
    const b = await c.req.parseBody();
    const ok = b.ok === '1';
    assertSite(c, (await getEntry(sql, id))?.site_id);
    await decideCorrection(sql, id, ok, c.get('actor'), typeof b.reason === 'string' ? b.reason : null);
    return back(c, '/zeiterfassung/freigaben', { ok: ok ? 'Freigegeben.' : 'Abgelehnt.' });
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
    const rows = inScope(c, allRows);
    const sites = allSites.filter((s) => !c.get('sites') || c.get('sites')!.includes(s.id));
    return shell(
      c,
      'liste',
      'Alle Zeiten',
      <>
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
              {sites.map((s) => (
                <option value={s.id} selected={s.id === q.objekt}>
                  {s.site_no} · {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <button class="btn">Anzeigen</button>
          </div>
        </form>
        <EntryTable rows={rows} />
      </>,
    );
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
                {sites.map((s) => (
                  <option value={s.id} selected={s.id === v.site}>
                    {s.site_no} · {s.name}
                  </option>
                ))}
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
            Ende vor Beginn = über Mitternacht. Zeiten werden nie gelöscht; falsche Einträge bitte korrigieren
            oder ablehnen.
          </p>
          <div class="formfoot">
            <a class="btn sec" href="/zeiterfassung">
              Abbrechen
            </a>
            <button class="btn">Speichern</button>
          </div>
        </form>
        <div class="card">
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

  // ------------------------------------------------------------------ Prüfbericht Zoll

  const reportRange = (c: Context<AppEnv>) => {
    const q = c.req.query();
    const m = todayBerlin().slice(0, 7);
    const from = isDate(q.von) ? q.von : `${m}-01`;
    const to = isDate(q.bis) ? q.bis : todayBerlin();
    return { from, to, employeeId: q.mitarbeiter || undefined };
  };

  app.get('/zeiterfassung/pruefbericht', async (c) => {
    const r = reportRange(c);
    const [{ rows, open }, emps] = await Promise.all([
      zollReport(sql, { from: r.from, to: r.to, ...(r.employeeId ? { employeeId: r.employeeId } : {}) }),
      listEmployees(sql),
    ]);
    const qs = new URLSearchParams({
      von: r.from,
      bis: r.to,
      ...(r.employeeId ? { mitarbeiter: r.employeeId } : {}),
    }).toString();
    const byEmp = new Map<string, ReportRow[]>();
    for (const x of rows) byEmp.set(x.employee_id, [...(byEmp.get(x.employee_id) ?? []), x] as typeof rows);
    return shell(
      c,
      'zoll',
      'Prüfbericht Zoll',
      <>
        <div class="hint" style="margin-bottom:14px">
          Aufzeichnungspflicht nach § 17 MiLoG (Gebäudereinigung): Beginn, Ende und Dauer der täglichen
          Arbeitszeit, spätestens bis zum Ablauf des 7. Folgetags aufgezeichnet, mindestens 2 Jahre
          aufzubewahren und auf Verlangen der Finanzkontrolle Schwarzarbeit vorzulegen. Die Liste enthält auch
          den Aufzeichnungszeitpunkt jedes Eintrags.
        </div>
        <form method="get" action="/zeiterfassung/pruefbericht" class="card grid" style="align-items:end">
          <div>
            <label for="von">von</label>
            <input id="von" type="date" name="von" value={r.from} />
          </div>
          <div>
            <label for="bis">bis</label>
            <input id="bis" type="date" name="bis" value={r.to} />
          </div>
          <div>
            <label for="mitarbeiter">Mitarbeiter</label>
            <select id="mitarbeiter" name="mitarbeiter">
              <option value="">alle</option>
              {emps.map((e) => (
                <option value={e.id} selected={e.id === r.employeeId}>
                  {e.last_name}, {e.first_name}
                </option>
              ))}
            </select>
          </div>
          <div class="actions" style="margin:0">
            <button class="btn">Anzeigen</button>
            <a class="btn sec" href={`/zeiterfassung/pruefbericht.csv?${qs}`}>
              <Icon name="download" /> CSV (Excel)
            </a>
          </div>
        </form>
        {open > 0 && (
          <div class="warnbox">
            {open} Einträge im Zeitraum sind noch offen (läuft oder Nachtrag nicht freigegeben) und fehlen in
            dieser Liste. <a href="/zeiterfassung/freigaben">Zu den Freigaben</a>
          </div>
        )}
        {rows.length === 0 && <div class="empty">Keine Zeiten im Zeitraum.</div>}
        {[...byEmp.values()].map((list) => (
          <div class="card flush" style="margin-bottom:16px">
            <div style="padding:14px 16px 6px">
              <b>{list[0]!.employee_name}</b> <span class="mut">Personalnummer {list[0]!.personnel_no}</span>
              <span style="float:right" class="sum">
                Summe {hm(list.reduce((s, x) => s + x.net_minutes, 0))} Std.
              </span>
            </div>
            <div class="tbl">
              <table>
                <thead>
                  <tr>
                    <th>Datum</th>
                    <th>Objekt</th>
                    <th>Beginn</th>
                    <th>Ende</th>
                    <th class="r">Pause</th>
                    <th class="r">Dauer</th>
                    <th>Aufgezeichnet</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((x) => (
                    <tr>
                      <td>
                        {weekdayDe(x.work_date)} {dateDe(x.work_date)}
                      </td>
                      <td>{x.site_name}</td>
                      <td>{clock(x.start_at)}</td>
                      <td>{clock(x.end_at)}</td>
                      <td class="r">{x.break_minutes}</td>
                      <td class="r">{hm(x.net_minutes)}</td>
                      <td class="small">
                        {x.recorded_at.toLocaleString('de-DE', {
                          timeZone: 'Europe/Berlin',
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                        {x.late && (
                          <>
                            {' '}
                            <span class="badge err">nach 7 Tagen</span>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </>,
    );
  });

  app.get('/zeiterfassung/pruefbericht.csv', async (c) => {
    const r = reportRange(c);
    const { rows } = await zollReport(sql, {
      from: r.from,
      to: r.to,
      ...(r.employeeId ? { employeeId: r.employeeId } : {}),
    });
    return c.body(zollCsv(rows), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="arbeitszeiten-${r.from}-bis-${r.to}.csv"`,
      'Cache-Control': 'no-store',
    });
  });

  // ------------------------------------------------------------------ Einstellungen

  app.get('/zeiterfassung/einstellungen', async (c) => {
    const s = await getTimeSettings(sql);
    return shell(
      c,
      'einstellungen',
      'Einstellungen Zeiterfassung',
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
      </form>,
    );
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

  app.get(`/personal/:id{${UUID}}/zeiten`, (c) =>
    shells.employee!(c, 'zeiten', async (e) => {
      const from = isDate(c.req.query('von')) ? c.req.query('von')! : addDays(todayBerlin(), -30);
      const rows = await listEntries(sql, { employeeId: e.id, from });
      return (
        <>
          <div class="actions" style="margin-top:0">
            <a class="btn sm" href={`/zeiterfassung/${randomUUID()}?mitarbeiter=${e.id}`}>
              + Zeit erfassen
            </a>
            <a class="btn sm sec" href={`/zeiterfassung/pruefbericht?mitarbeiter=${e.id}`}>
              Prüfbericht
            </a>
            <span class="mut small">ab {dateDe(from)}</span>
          </div>
          <EntryTable rows={rows} show="site" />
        </>
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
            <p>
              Status:{' '}
              {!pin ? (
                <span class="badge">kein Zugang</span>
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
      const from = isDate(c.req.query('von')) ? c.req.query('von')! : addDays(todayBerlin(), -30);
      const rows = await listEntries(sql, { siteId: s.id, from });
      return (
        <>
          <div class="actions" style="margin-top:0">
            <a class="btn sm" href={`/zeiterfassung/${randomUUID()}?objekt=${s.id}`}>
              + Zeit erfassen
            </a>
            <span class="mut small">ab {dateDe(from)}</span>
          </div>
          <EntryTable rows={rows} show="employee" />
        </>
      );
    }),
  );

  // QR-Aushang am Objekt
  const qrUrl = (c: Context<AppEnv>, token: string) =>
    `${env.PUBLIC_URL ?? new URL(c.req.url).origin}/m/o/${token}`;

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

  app.post(`/objekte/:id{${UUID}}/qr/neu`, async (c) => {
    const id = c.req.param('id');
    await sql`update app.sites set clock_token = replace(gen_random_uuid()::text, '-', '') where id = ${id}`;
    await sql`insert into app.audit_log (actor, action, entity, entity_id) values (${c.get('actor')}, 'new_clock_token', 'site', ${id})`;
    return back(c, `/objekte/${id}/qr`, { ok: 'Neuer QR-Code erzeugt. Bitte neu ausdrucken und aufhängen.' });
  });
}
