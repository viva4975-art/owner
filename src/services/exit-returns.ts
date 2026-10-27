import type { Sql } from '../db/client.js';
import { addDays, todayBerlin } from '../domain/invoice/calc.js';
import { holdings } from './handovers.js';
import { uuidFrom } from './photo-stamp.js';

/**
 * Vorlauf: Die Aufgabe entsteht, sobald ein Austritt eingetragen ist (Ahmed 27.10.: „wenn er in Zukunft austreten soll
 * oder ausgetreten ist“) – bis zu einem Jahr im Voraus.
 */
export const EXIT_RETURN_LEAD_DAYS = 366;
/** Kennung der automatisch angelegten Aufgaben (created_by). */
const MARK = 'automatisch: Austritt';

const de = (d: string) => d.split('-').reverse().join('.');

/**
 * Austritt steht bevor (oder war vor kurzem) und die Person hat laut Übergaben noch Arbeitskleidung bzw. laut
 * Schlüsselbuch Schlüssel → Aufgabe „Arbeitskleidung zurückholen“ fürs Büro (ohne Zuständigen = alle im Büro) und je
 * Objektleitung der Objekte, an denen die Person eingesetzt ist. Fällig am Austrittstag, feste IDs (nichts doppelt).
 * Ist alles zurück bzw. der Austritt aufgehoben/verschoben, werden offene Aufgaben dieser Art erledigt bzw. entfernt.
 */
export async function syncExitReturnTasks(sql: Sql, today = todayBerlin()) {
  const emps = await sql<{ id: string; name: string; exit_date: string }[]>`
    select id, first_name || ' ' || last_name as name, exit_date::text from app.employees
     where exit_date is not null and exit_date <= ${addDays(today, EXIT_RETURN_LEAD_DAYS)}::date
       and (exit_date >= ${addDays(today, -60)}::date
            or exists (select 1 from app.tasks t where t.entity_type = 'employee' and t.entity_id = app.employees.id
                          and t.created_by = ${MARK} and t.status = 'open'))`;
  const keep = new Set<string>();
  let created = 0;
  for (const e of emps) {
    const h = await holdings(sql, e.id);
    if (!h.clothing.length && !h.keys.length) continue;
    const items = [
      ...h.clothing.map((c) => `• ${c.qty} × ${c.name}${c.size ? ` (Gr. ${c.size})` : ''}`),
      ...h.keys.map((k) => `• Schlüssel ${k.key_no} – ${k.description} (${k.site_name})`),
    ];
    const what = h.clothing.length
      ? h.keys.length
        ? 'Arbeitskleidung und Schlüssel'
        : 'Arbeitskleidung'
      : 'Schlüssel';
    const title = `${what} zurückholen: ${e.name} (Austritt ${de(e.exit_date)})`;
    const description =
      `${e.name} tritt am ${de(e.exit_date)} aus und hat laut App noch:\n${items.join('\n')}\n\n` +
      'Rückgabe beim Mitarbeiter unter Übergaben → Schlüssel bzw. Arbeitskleidung erfassen – dann erledigt sich diese Aufgabe von selbst.';
    const managers = await sql<{ user_id: string; name: string }[]>`
      select distinct a.id as user_id, coalesce(nullif(p.display_name, ''), a.login) as name
        from app.sites s join app.user_accounts a on a.id = s.manager_user_id and a.active
        join app.profiles p on p.user_id = a.id
       where s.id in (select site_id from app.employee_sites where employee_id = ${e.id}
                      union
                      select site_id from app.shift_plans where employee_id = ${e.id}
                         and (valid_until is null or valid_until >= ${addDays(e.exit_date, -90)}::date))`;
    const targets: { id: string; assignee: string | null }[] = [
      { id: uuidFrom(`austritt-rueckgabe:${e.id}:${e.exit_date}`), assignee: null },
      ...managers.map((m) => ({
        id: uuidFrom(`austritt-rueckgabe:${e.id}:${e.exit_date}:${m.user_id}`),
        assignee: m.name,
      })),
    ];
    for (const t of targets) {
      keep.add(t.id);
      const r = await sql`
        insert into app.tasks (id, title, description, due_date, assignee, entity_type, entity_id, created_by)
        values (${t.id}, ${title}, ${description}, ${e.exit_date}, ${t.assignee}, 'employee', ${e.id}, ${MARK})
        on conflict (id) do update set title = excluded.title, description = excluded.description
          where app.tasks.status = 'open'
        returning (xmax = 0) as inserted`;
      if (r[0]?.inserted) created++;
    }
  }
  // Nicht mehr nötig (alles zurück, Austritt aufgehoben/verschoben): offene Aufgaben dieser Art erledigen
  const stale = await sql<{ id: string }[]>`
    select id from app.tasks where created_by = ${MARK} and status = 'open'
       and not (id = any(${[...keep]}::uuid[]))`;
  if (stale.length)
    await sql`update app.tasks set status = 'done', done_at = now(), done_by = ${MARK}
               where id = any(${stale.map((s) => s.id)}::uuid[])`;
  return { created, closed: stale.length };
}
