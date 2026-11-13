import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { BusinessError } from './errors.js';

/** Vorschläge für die Auswahl (frei ergänzbar) */
export const QUALIFICATION_SUGGESTIONS = [
  'Führerschein Klasse B',
  'Hebebühne / Arbeitsbühne',
  'Ersthelfer',
  'Hygieneschulung',
  'Glas- und Gebäudereiniger (Gesellenbrief)',
  'Desinfektor/in',
  'Staplerschein',
  'Führungszeugnis liegt vor',
  'Brandschutzhelfer',
];

export interface Qualification {
  id: string;
  employee_id: string;
  name: string;
  valid_until: string | null;
  note: string | null;
}

export async function listQualifications(sql: Sql, employeeId: string) {
  return sql<Qualification[]>`
    select id, employee_id, name, valid_until::text as valid_until, note from app.employee_qualifications
     where employee_id = ${employeeId} order by name`;
}

export async function addQualification(
  sql: Sql,
  id: string,
  employeeId: string,
  p: { name: string; validUntil: string | null; note: string | null },
  actor: string,
) {
  const name = p.name.trim();
  if (!name) throw new BusinessError('Bitte die Qualifikation angeben');
  if (name.length > 80) throw new BusinessError('Bezeichnung höchstens 80 Zeichen');
  if (p.validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(p.validUntil)) throw new BusinessError('Datum ungültig');
  await sql`
    insert into app.employee_qualifications (id, employee_id, name, valid_until, note, created_by)
    values (${id}, ${employeeId}, ${name}, ${p.validUntil || null}, ${p.note?.trim() || null}, ${actor})
    on conflict (id) do nothing`;
}

export async function deleteQualification(sql: Sql, employeeId: string, id: string, actor: string) {
  const [q] = await sql<Qualification[]>`
    delete from app.employee_qualifications where id = ${id} and employee_id = ${employeeId}
    returning id, employee_id, name, valid_until::text as valid_until, note`;
  if (q)
    await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
              values (${actor}, 'delete', 'qualification', ${employeeId}, ${sql.json({ ...q })})`;
}

/** Abgelaufene bzw. in 30 Tagen ablaufende Qualifikationen aktiver Mitarbeitender (für den Eingang) */
export async function expiringQualifications(sql: Sql, days = 30) {
  return sql<{ id: string; employee_id: string; employee_name: string; name: string; valid_until: string }[]>`
    select q.id, q.employee_id, e.first_name || ' ' || e.last_name as employee_name, q.name,
           q.valid_until::text as valid_until
      from app.employee_qualifications q join app.employees e on e.id = q.employee_id
     where e.status = 'aktiv' and q.valid_until is not null and q.valid_until <= ${addDays(todayBerlin(), days)}
     order by q.valid_until`;
}
