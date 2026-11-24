import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { listEntries, plannedShifts } from '../services/time.js';
import { type CalView, calRange } from './pages-site-calendar.js';

const VIEWS: CalView[] = ['tag', '5tage', 'woche', 'monat', 'liste'];

/** Daten für den Einsatzkalender eines Mitarbeiters (Mitarbeiter-Reiter, Zeiterfassung, Meine Zeiten). */
export async function employeeCalendarData(
  sql: Sql,
  employeeId: string,
  q: Record<string, string | undefined>,
  opts: { defaultView?: CalView; siteScope?: string[] | null } = {},
) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q.datum ?? '')
    ? q.datum!
    : /^\d{4}-\d{2}$/.test(q.monat ?? '')
      ? `${q.monat}-01`
      : todayBerlin();
  const view = (VIEWS.find((v) => v === q.ansicht) ?? opts.defaultView ?? 'monat') as CalView;
  const r = calRange(view === 'liste' ? 'monat' : view, date);
  const [allShifts, entries, absences] = await Promise.all([
    plannedShifts(sql, { from: r.from, to: r.to, employeeId }),
    listEntries(sql, { from: r.from, to: r.to, employeeId }),
    sql<{ kind: string; start_date: string; end_date: string; half_day: boolean }[]>`
      select kind::text, start_date::text, end_date::text, half_day from app.absences
       where employee_id = ${employeeId} and status = 'genehmigt' and start_date <= ${r.to} and end_date >= ${r.from}`,
  ]);
  // Abwesende Person: Einsätze, für die eine Vertretung, ein Nachunternehmer oder Ausfall eingetragen ist, fallen sonst
  // aus ihrem Kalender (Ahmed 24.11.) – an Abwesenheitstagen weiter zeigen, mit „vertreten durch …“.
  const orig = (
    await plannedShifts(sql, { from: r.from, to: r.to, employeeId, originalAssignee: true })
  ).filter((s) => s.absence && s.exception);
  if (orig.length) {
    const ex = await sql<{ id: string; who: string | null; sub: string | null; note: string | null }[]>`
      select x.id, e.first_name || ' ' || e.last_name as who, su.name as sub, x.note
        from app.shift_exceptions x
        left join app.employees e on e.id = x.substitute_employee_id
        left join app.subcontracts c on c.id = x.subcontract_id
        left join app.suppliers su on su.id = c.supplier_id
       where x.id in ${sql(orig.map((s) => s.exception!.id))}`;
    const have = new Set(allShifts.map((s) => `${s.plan.id}|${s.date}`));
    for (const s of orig) {
      if (have.has(`${s.plan.id}|${s.date}`)) continue;
      const x = ex.find((y) => y.id === s.exception!.id);
      const cover = x?.who
        ? `vertreten durch ${x.who}`
        : x?.sub
          ? `Nachunternehmer ${x.sub}`
          : s.exception!.kind === 'ausfall'
            ? 'Einsatz entfällt'
            : 'umgeplant';
      const { exception: _x, ...rest } = s;
      allShifts.push({ ...rest, cover });
    }
    allShifts.sort(
      (a, b) => a.date.localeCompare(b.date) || a.plan.start_time.localeCompare(b.plan.start_time),
    );
  }
  const scope = opts.siteScope;
  const shifts = scope ? allShifts.filter((s) => scope.includes(s.plan.site_id)) : allShifts;
  const used = new Set(allShifts.map((s) => s.entry?.id).filter(Boolean));
  const extra = entries.filter(
    (x) => !used.has(x.id) && x.status !== 'abgelehnt' && (!scope || scope.includes(x.site_id)),
  );
  const siteIds = [...new Set([...shifts.map((s) => s.plan.site_id), ...extra.map((e) => e.site_id)])];
  const addr = siteIds.length
    ? await sql<{ id: string; a: string }[]>`
        select id, concat_ws(', ', nullif(street, ''), nullif(trim(concat_ws(' ', postal_code, city)), '')) as a
          from app.sites where id in ${sql(siteIds)}`
    : [];
  return {
    view,
    date,
    shifts,
    extra,
    absences,
    siteAddr: Object.fromEntries(addr.map((x) => [x.id, x.a])),
  };
}
