import type { FC } from 'hono/jsx';
import { monthLabelDe } from '../domain/invoice/calc.js';
import { ABSENCE_LABEL, type AbsenceKind } from '../services/absences.js';
import type { CalendarDay } from '../services/hr-month.js';

export const hhmm = (m: number | null) =>
  m == null
    ? '–'
    : `${m < 0 ? '-' : ''}${Math.floor(Math.abs(m) / 60)}:${String(Math.abs(m) % 60).padStart(2, '0')}`;

/** „Dispo & Zeiterfassung“ wie Fortytools: Soll / Plan / Ist je Monat, Abweichung farbig. */
export const MonthBox: FC<{
  employeeId: string;
  rows: { month: string; soll: number | null; plan: number; ist: number }[];
  current: string;
}> = ({ employeeId, rows, current }) => (
  <div class="card">
    <h3>Dispo &amp; Zeiterfassung</h3>
    <div class="tbl">
      <table>
        <thead>
          <tr>
            <th>Monat</th>
            <th class="r">Soll</th>
            <th class="r">Plan</th>
            <th class="r">Ist</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const planOff = r.soll != null && Math.abs(r.plan - r.soll) > 60;
            const istOff = r.month <= current && r.soll != null && r.ist < r.soll - 60;
            return (
              <tr style={r.month === current ? 'font-weight:600' : ''}>
                <td>
                  <a href={`/personal/${employeeId}/kalender?monat=${r.month}`} style="white-space:nowrap">
                    {monthLabelDe(r.month).replace(/^(\S{3})\S{2,}/, '$1.')}
                  </a>
                </td>
                <td class="r">{hhmm(r.soll)}</td>
                <td class="r" style={planOff ? 'background:#fde2e2' : ''}>
                  {hhmm(r.plan)}
                </td>
                <td class="r" style={istOff ? 'background:#fde2e2' : r.ist ? 'background:#e7f6ec' : ''}>
                  {hhmm(r.ist)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    <p class="small mut" style="margin-bottom:0">
      Soll = Wochenstunden × 4,33 je Monat (anteilig). Rot: Plan weicht über 1 Std. ab bzw. Ist liegt unter
      Soll.
    </p>
  </div>
);

const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** Monatskalender je Mitarbeiter (Einsätze, Abwesenheiten, Feiertage, Ist-Zeiten). */
export const EmployeeCalendar: FC<{
  employeeId: string;
  month: string;
  days: CalendarDay[];
  prev: string;
  next: string;
}> = ({ employeeId, month, days, prev, next }) => {
  const first = new Date(`${days[0]!.date}T12:00:00Z`).getUTCDay(); // 0 = So
  const lead = (first + 6) % 7;
  const cells: (CalendarDay | null)[] = [...Array(lead).fill(null), ...days];
  while (cells.length % 7) cells.push(null);
  const sum = days.reduce((a, d) => a + d.shifts.reduce((b, s) => b + s.minutes, 0), 0);
  return (
    <>
      <style
        dangerouslySetInnerHTML={{
          __html: `.cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}
.cal .h{font-size:12px;font-weight:600;color:var(--mut);padding:4px}
.cal .d{background:#fff;border:1px solid var(--line);border-radius:8px;min-height:86px;padding:4px 6px;font-size:12px}
.cal .d.we{background:#f7f7f9}.cal .d.hol{background:#fff8d6}.cal .d.abs{background:#eef2ff}
.cal .n{font-weight:600}.cal .s{background:var(--brand);color:#fff;border-radius:4px;padding:1px 4px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cal .s.ok{background:#3b6b4d}.cal .x{background:#e7f6ec;border-radius:4px;padding:1px 4px;margin-top:3px}
@media (max-width:700px){.cal .d{min-height:60px}.cal .s{font-size:10px}}`,
        }}
      />
      <div class="actions" style="margin-top:0">
        <a class="btn sm sec" href={`/personal/${employeeId}/kalender?monat=${prev}`}>
          ←
        </a>
        <b>{monthLabelDe(month)}</b>
        <a class="btn sm sec" href={`/personal/${employeeId}/kalender?monat=${next}`}>
          →
        </a>
        <span class="small mut" style="margin-left:auto">
          geplant {hhmm(sum)} Std. · <span style="color:var(--brand)">■</span> Einsatz{' '}
          <span style="color:#3b6b4d">■</span> erledigt <span style="color:#9bd3ae">■</span> Ist ohne Einsatz
        </span>
      </div>
      <div class="cal">
        {WD.map((w) => (
          <div class="h">{w}</div>
        ))}
        {cells.map((d, i) =>
          d ? (
            <div class={`d ${i % 7 >= 5 ? 'we' : ''} ${d.holiday ? 'hol' : ''} ${d.absence ? 'abs' : ''}`}>
              <div class="n">{Number(d.date.slice(8))}.</div>
              {d.holiday && <div class="small">{d.holiday}</div>}
              {d.absence && <div class="small">{ABSENCE_LABEL[d.absence as AbsenceKind] ?? d.absence}</div>}
              {d.shifts.map((s) => (
                <div class={`s ${s.done ? 'ok' : ''}`} title={`${s.site} ${s.from}–${s.to}`}>
                  {s.from} {s.site}
                </div>
              ))}
              {d.extra.map((x) => (
                <div class="x" title={x.site}>
                  {hhmm(x.minutes)} {x.site}
                </div>
              ))}
            </div>
          ) : (
            <div></div>
          ),
        )}
      </div>
    </>
  );
};
