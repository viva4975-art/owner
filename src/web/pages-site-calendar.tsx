import type { FC } from 'hono/jsx';
import { addDays, isoWeekday, mondayOf } from '../domain/time/holidays.js';
import type { EmployeeTimeSum, MonthRow } from '../services/site-times.js';
import {
  STATUS_LABEL,
  type PlannedShift,
  type TimeEntryRow,
  clock,
  hm,
  netMinutes,
} from '../services/time.js';
import { dateDe } from './layout.js';

// ---------------------------------------------------------------------------
// Einsatzkalender am Objekt (Tag / 5 Tage / Woche / Monat)
// ---------------------------------------------------------------------------

export type CalView = 'tag' | '5tage' | 'woche' | 'monat' | 'liste';
export const CAL_VIEWS: [CalView, string][] = [
  ['tag', 'Tag'],
  ['5tage', '5 Tage'],
  ['woche', 'Woche'],
  ['monat', 'Monat'],
  ['liste', 'Wiederkehrende Einsätze'],
];
const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
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
export const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

const lastOfMonth = (d: string) => {
  const [y, m] = d.split('-').map(Number) as [number, number];
  return addDays(m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`, -1);
};
const shiftMonth = (d: string, n: number) => {
  const [y, m] = d.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`;
};

/** Sichtbarer Zeitraum (from/to) und Navigation je Ansicht. */
export function calRange(view: CalView, date: string) {
  switch (view) {
    case 'tag':
      return { from: date, to: date, prev: addDays(date, -1), next: addDays(date, 1) };
    case '5tage': {
      const mo = mondayOf(date);
      return { from: mo, to: addDays(mo, 4), prev: addDays(mo, -7), next: addDays(mo, 7) };
    }
    case 'monat': {
      const first = `${date.slice(0, 7)}-01`;
      return {
        from: mondayOf(first),
        to: addDays(mondayOf(lastOfMonth(first)), 6),
        prev: shiftMonth(first, -1),
        next: shiftMonth(first, 1),
      };
    }
    default: {
      const mo = mondayOf(date);
      return { from: mo, to: addDays(mo, 6), prev: addDays(mo, -7), next: addDays(mo, 7) };
    }
  }
}

const shiftState = (s: PlannedShift) =>
  s.exception?.kind === 'ausfall'
    ? { cls: 'cx', label: 'Ausfall' }
    : s.holiday
      ? { cls: 'hol', label: s.holiday }
      : s.entry
        ? { cls: 'done', label: 'erledigt' }
        : s.absence
          ? { cls: 'abs', label: `abwesend – Vertretung nötig` }
          : s.exception?.kind === 'vertretung'
            ? { cls: 'sub', label: `Vertretung für ${s.exception.original}` }
            : s.exception?.kind === 'umgeplant'
              ? { cls: 'sub', label: 'umgeplant' }
              : { cls: 'plan', label: 'geplant' };

const CAL_CSS = `.calbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.calbar .seg{display:inline-flex;border:1px solid var(--line);border-radius:var(--r-sm);overflow:hidden}
.calbar .seg a{padding:5px 11px;color:var(--ink);text-decoration:none;border-right:1px solid var(--line);font-size:13px}
.calbar .seg a:last-child{border-right:0}.calbar .seg a.on{background:var(--brand);color:#fff}
.calbar h3{margin:0 8px;font-size:16px}
.cal{display:grid;gap:0;border:1px solid var(--line);border-radius:var(--r-sm);overflow:hidden;background:var(--panel)}
.cal .dh{background:var(--bg);padding:6px 8px;font-weight:600;font-size:12.5px;border-bottom:1px solid var(--line)}
.cal .dh.today{color:var(--brand)}
.cal .dc{border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:6px;min-height:110px;font-size:12.5px}
.cal .dc.out{background:var(--bg);color:var(--faint)}.cal .dc .n{font-weight:600;margin-bottom:4px}
.cal .dc.today .n{color:var(--brand)}
.sh{border-left:3px solid var(--info);background:var(--info-50);border-radius:3px;padding:3px 6px;margin-bottom:4px;line-height:1.3}
.sh.done{border-color:var(--ok);background:var(--ok-50)}.sh.abs{border-color:var(--err);background:var(--err-50)}
.sh.sub{border-color:var(--warn);background:var(--warn-50)}.sh.hol{border-color:var(--faint);background:var(--bg)}
.sh.cx{border-color:var(--faint);background:var(--bg);text-decoration:line-through;color:var(--mut)}
.sh .t{font-weight:600}.sh .s{color:var(--mut);font-size:11.5px}
.cal-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--mut);margin:8px 0 0}
.cal-legend .sh{display:inline-block;margin:0;padding:0 8px}
.cal-side{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:18px;margin-top:18px}
@media (max-width:900px){.cal-side{grid-template-columns:1fr}.cal.wk{grid-template-columns:1fr!important}}`;

const Chip: FC<{ s: PlannedShift; compact?: boolean }> = ({ s, compact }) => {
  const st = shiftState(s);
  return (
    <div
      class={`sh ${st.cls}`}
      title={`${s.plan.start_time}–${s.plan.end_time} ${s.plan.employee_name} · ${st.label}`}
    >
      <span class="t">
        {s.plan.start_time}
        {!compact && `–${s.plan.end_time}`}
      </span>{' '}
      {s.plan.employee_name}
      {!compact && <div class="s">{st.label}</div>}
    </div>
  );
};

export const SiteCalendar: FC<{
  base: string;
  view: CalView;
  date: string;
  today: string;
  shifts: PlannedShift[];
}> = ({ base, view, date, today, shifts }) => {
  const r = calRange(view, date);
  const days: string[] = [];
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) days.push(d);
  const on = (d: string) => shifts.filter((s) => s.date === d);
  const url = (v: CalView, d: string) => `${base}?ansicht=${v}&datum=${d}`;
  const title =
    view === 'monat'
      ? monthName(date.slice(0, 7))
      : view === 'tag'
        ? `${WD[isoWeekday(date) - 1]}, ${dateDe(date)}`
        : `${dateDe(r.from)} – ${dateDe(r.to)}`;
  const month = date.slice(0, 7);
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CAL_CSS }} />
      <div class="calbar">
        <span class="seg">
          {CAL_VIEWS.map(([k, l]) => (
            <a href={url(k, date)} class={k === view ? 'on' : ''}>
              {l}
            </a>
          ))}
        </span>
        {view !== 'liste' && (
          <>
            <span class="seg">
              <a href={url(view, r.prev)} aria-label="zurück">
                ‹
              </a>
              <a href={url(view, today)}>Heute</a>
              <a href={url(view, r.next)} aria-label="vor">
                ›
              </a>
            </span>
            <h3>{title}</h3>
          </>
        )}
      </div>
      {view === 'liste' ? null : view === 'monat' ? (
        <div class="cal" style="grid-template-columns:repeat(7,minmax(0,1fr))">
          {WD.map((w) => (
            <div class="dh">{w}</div>
          ))}
          {days.map((d) => {
            const list = on(d);
            return (
              <div class={`dc${d.slice(0, 7) !== month ? ' out' : ''}${d === today ? ' today' : ''}`}>
                <div class="n">
                  <a href={url('tag', d)} style="color:inherit">
                    {Number(d.slice(8, 10))}.
                  </a>
                </div>
                {list.slice(0, 4).map((s) => (
                  <Chip s={s} compact />
                ))}
                {list.length > 4 && (
                  <a class="small" href={url('tag', d)}>
                    + {list.length - 4} weitere
                  </a>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div class="cal wk" style={`grid-template-columns:repeat(${days.length},minmax(0,1fr))`}>
          {days.map((d) => (
            <div class={`dh${d === today ? ' today' : ''}`}>
              <a href={url('tag', d)} style="color:inherit">
                {WD[isoWeekday(d) - 1]} {dateDe(d).slice(0, 6)}
              </a>
            </div>
          ))}
          {days.map((d) => {
            const list = on(d);
            return (
              <div class={`dc${d === today ? ' today' : ''}`} style="min-height:160px">
                {list.map((s) => (
                  <Chip s={s} />
                ))}
                {!list.length && <span class="faint">–</span>}
              </div>
            );
          })}
        </div>
      )}
      {view !== 'liste' && (
        <div class="cal-legend">
          <span>
            <span class="sh">geplant</span>
          </span>
          <span>
            <span class="sh done">erledigt (Zeit erfasst)</span>
          </span>
          <span>
            <span class="sh sub">Vertretung / umgeplant</span>
          </span>
          <span>
            <span class="sh abs">abwesend</span>
          </span>
          <span>
            <span class="sh hol">Feiertag</span>
          </span>
          <span>
            <span class="sh cx">Ausfall</span>
          </span>
        </div>
      )}
    </>
  );
};

export const CalSummary: FC<{
  year: string;
  month: string;
  yearShifts: PlannedShift[];
}> = ({ year, month, yearShifts }) => {
  const count = (list: PlannedShift[]) => {
    const real = list.filter((s) => !s.holiday && s.exception?.kind !== 'ausfall');
    return { minutes: real.reduce((a, s) => a + s.minutes, 0), n: real.length };
  };
  const y = count(yearShifts);
  const m = count(yearShifts.filter((s) => s.date.startsWith(month)));
  return (
    <section>
      <h3 class="panel-title">Zusammenfassung</h3>
      <div class="tbl">
        <table>
          <thead>
            <tr>
              <th>Zeitraum</th>
              <th class="right">Stunden</th>
              <th class="right">Termine</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Jahr {year}</td>
              <td class="right">{hm(y.minutes)}</td>
              <td class="right">{y.n}</td>
            </tr>
            <tr>
              <td>{monthName(month)}</td>
              <td class="right">{hm(m.minutes)}</td>
              <td class="right">{m.n}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="small mut">Geplante Einsätze ohne Feiertage und Ausfälle (Stunden netto, ohne Pausen).</p>
    </section>
  );
};

export const NextShifts: FC<{ shifts: PlannedShift[] }> = ({ shifts }) => (
  <section>
    <h3 class="panel-title">Nächste Einsätze</h3>
    <div class="tbl">
      <table>
        <tbody>
          {shifts.map((s) => {
            const st = shiftState(s);
            return (
              <tr>
                <td style="white-space:nowrap">
                  {WD[isoWeekday(s.date) - 1]} {dateDe(s.date)}
                </td>
                <td style="white-space:nowrap">
                  {s.plan.start_time}–{s.plan.end_time}
                </td>
                <td>{s.plan.employee_name}</td>
                <td>
                  {st.cls !== 'plan' && (
                    <span class={`tag ${st.cls === 'abs' ? 'err' : st.cls === 'sub' ? 'warn' : ''}`}>
                      {st.label}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
          {!shifts.length && (
            <tr>
              <td class="mut">Keine geplanten Einsätze.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  </section>
);

// ---------------------------------------------------------------------------
// Erfasste Zeiten am Objekt
// ---------------------------------------------------------------------------

const diffCell = (actual: number, planned: number) => {
  const d = actual - planned;
  return (
    <td class="right" style={planned && Math.abs(d) > planned * 0.1 ? 'color:var(--err)' : ''}>
      {planned || actual ? `${d >= 0 ? '+' : ''}${hm(d)}` : '–'}
    </td>
  );
};

export const TimesOverview: FC<{
  sums: EmployeeTimeSum[];
  total: { actual: number; planned: number; entries: number; pending: number };
}> = ({ sums, total }) => (
  <div class="tbl">
    <table>
      <thead>
        <tr>
          <th>Mitarbeiter</th>
          <th class="right">Einsätze</th>
          <th class="right">Dauer</th>
          <th class="right">Geplant</th>
          <th class="right">Differenz</th>
        </tr>
      </thead>
      <tbody>
        {sums.map((s) => (
          <tr>
            <td>
              <a href={`/personal/${s.employee_id}/zeiten`}>{s.name}</a>{' '}
              <span class="small faint">{s.personnel_no}</span>
              {s.pending > 0 && (
                <span class="tag warn" style="margin-left:6px">
                  {s.pending} Nachtrag offen
                </span>
              )}
            </td>
            <td class="right">{s.entries}</td>
            <td class="right">{hm(s.actual)}</td>
            <td class="right">{hm(s.planned)}</td>
            {diffCell(s.actual, s.planned)}
          </tr>
        ))}
        {!sums.length && (
          <tr>
            <td colspan={5} class="mut">
              Keine Zeiten und keine Einsätze im Zeitraum.
            </td>
          </tr>
        )}
      </tbody>
      <tfoot>
        <tr>
          <th>Gesamtsumme</th>
          <th class="right">{total.entries}</th>
          <th class="right">{hm(total.actual)}</th>
          <th class="right">{hm(total.planned)}</th>
          {diffCell(total.actual, total.planned)}
        </tr>
      </tfoot>
    </table>
  </div>
);

export const TimesDetails: FC<{ entries: (TimeEntryRow & { planned: number | null })[] }> = ({ entries }) => {
  const counted = entries.filter((e) => e.status === 'erfasst' || e.status === 'freigegeben');
  return (
    <div class="tbl">
      <table>
        <thead>
          <tr>
            <th>Datum</th>
            <th>Mitarbeiter</th>
            <th>Beginn</th>
            <th>Ende</th>
            <th class="right">Pause</th>
            <th class="right">Dauer</th>
            <th class="right">Geplant</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr style={e.status === 'abgelehnt' ? 'opacity:.5' : ''}>
              <td style="white-space:nowrap">
                <a href={`/zeiterfassung/${e.id}`}>
                  {WD[isoWeekday(e.work_date) - 1]} {dateDe(e.work_date)}
                </a>
              </td>
              <td>{e.employee_name}</td>
              <td>{clock(e.start_at)}</td>
              <td>{clock(e.end_at)}</td>
              <td class="right">{e.break_minutes ? hm(e.break_minutes) : '–'}</td>
              <td class="right">{e.end_at ? hm(netMinutes(e)) : '–'}</td>
              <td class="right">{e.planned != null ? hm(e.planned) : '–'}</td>
              <td>
                <span
                  class={`tag ${e.status === 'freigegeben' || e.status === 'erfasst' ? 'ok' : e.status === 'abgelehnt' ? '' : 'warn'}`}
                >
                  {STATUS_LABEL[e.status]}
                </span>
              </td>
            </tr>
          ))}
          {!entries.length && (
            <tr>
              <td colspan={8} class="mut">
                Keine Zeiten im Zeitraum.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <th colspan={5}>Gesamtsumme ({counted.length} Zeiten)</th>
            <th class="right">{hm(counted.reduce((a, e) => a + netMinutes(e), 0))}</th>
            <th class="right">{hm(counted.reduce((a, e) => a + (e.planned ?? 0), 0))}</th>
            <th />
          </tr>
        </tfoot>
      </table>
    </div>
  );
};

export const MonthOverview: FC<{
  rows: MonthRow[];
  base: string;
  canConfirm: boolean;
  current: string;
}> = ({ rows, base, canConfirm, current }) => (
  <section style="margin-top:18px">
    <h3 class="panel-title">Monatsübersicht</h3>
    <div class="tbl">
      <table>
        <thead>
          <tr>
            <th>Monat</th>
            <th class="right">Dauer</th>
            <th class="right">Geplant</th>
            <th class="right">Differenz</th>
            <th>Zeiterfassung bestätigt</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr style={r.month === current ? 'background:var(--brand-50)' : ''}>
              <td>
                <a href={`${base}?monat=${r.month}`}>{monthName(r.month)}</a>
              </td>
              <td class="right">{hm(r.actual)}</td>
              <td class="right">{hm(r.planned)}</td>
              {diffCell(r.actual, r.planned)}
              <td>
                {r.confirmed ? (
                  <>
                    <span class="tag ok">✓ bestätigt</span>{' '}
                    <span class="small mut">
                      {r.confirmed.by},{' '}
                      {r.confirmed.at.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}
                    </span>
                    {r.confirmed.minutes !== r.actual && (
                      <div class="small" style="color:var(--err)">
                        seit Bestätigung geändert (bestätigt {hm(r.confirmed.minutes)})
                      </div>
                    )}
                  </>
                ) : (
                  <span class="faint">nein</span>
                )}
                {canConfirm && (
                  <form method="post" action={`${base}/bestaetigen`} style="display:inline;margin-left:8px">
                    <input type="hidden" name="monat" value={r.month} />
                    {r.confirmed && r.confirmed.minutes === r.actual ? (
                      <button class="btn sm ghost" name="bestaetigt" value="0">
                        zurücknehmen
                      </button>
                    ) : (
                      <button class="btn sm sec" name="bestaetigt" value="1">
                        {r.confirmed ? 'erneut bestätigen' : 'bestätigen'}
                      </button>
                    )}
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </section>
);
