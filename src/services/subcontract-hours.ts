import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';

/**
 * Stundennachweis zu NU-Bestellungen „je Stunde“ (Ahmed 09.10.): je Tag Anzahl Personen × Stunden je Person.
 * Betrag = Personen × Minuten × Stundensatz des Monats ÷ 60, je Eintrag kaufmännisch auf Cent gerundet.
 */
export interface SubcontractHourRow {
  id: string;
  work_date: string;
  persons: number;
  minutes_per_person: number;
  total_minutes: number;
  rate_cents: bigint;
  amount_cents: bigint;
  note: string | null;
  created_by: string;
}

export async function listSubcontractHours(sql: Sql, subcontractId: string) {
  return sql<SubcontractHourRow[]>`
    select h.id, h.work_date::text, h.persons, h.minutes_per_person, h.persons * h.minutes_per_person as total_minutes,
           r.rate as rate_cents,
           round(h.persons * h.minutes_per_person * r.rate::numeric / 60)::bigint as amount_cents,
           h.note, h.created_by
      from app.subcontract_hours h join app.subcontracts s on s.id = h.subcontract_id
      cross join lateral (
        select coalesce((select p.price_cents from app.subcontract_prices p
                          where p.subcontract_id = s.id and p.valid_from_month <= date_trunc('month', h.work_date)::date
                          order by p.valid_from_month desc limit 1), s.price_cents, 0) as rate) r
     where h.subcontract_id = ${subcontractId}
     order by h.work_date desc, h.created_at desc`;
}

export async function addSubcontractHours(
  sql: Sql,
  p: {
    id: string;
    subcontractId: string;
    workDate: string;
    persons: number;
    minutesPerPerson: number;
    note: string | null;
    actor: string;
  },
) {
  const [sc] = await sql<{ billing: string; status: string; valid_from: string; valid_to: string | null }[]>`
    select billing, status, valid_from::text, valid_to::text from app.subcontracts where id = ${p.subcontractId}`;
  if (!sc) throw new BusinessError('Bestellung nicht gefunden');
  if (sc.billing !== 'stunde') throw new BusinessError('Stunden nur bei Abrechnung „je Stunde“');
  if (sc.status === 'storniert') throw new BusinessError('Bestellung ist storniert');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.workDate)) throw new BusinessError('Bitte Datum angeben');
  if (p.workDate < sc.valid_from || (sc.valid_to && p.workDate > sc.valid_to))
    throw new BusinessError('Datum liegt außerhalb des Zeitraums der Bestellung');
  if (!Number.isInteger(p.persons) || p.persons < 1 || p.persons > 200)
    throw new BusinessError('Anzahl Personen 1 bis 200');
  if (!Number.isInteger(p.minutesPerPerson) || p.minutesPerPerson < 1 || p.minutesPerPerson > 1440)
    throw new BusinessError('Stunden je Person bitte als 2:30 oder 2,5 angeben (höchstens 24 Std.)');
  // feste ID je Formular → doppelt absenden legt nichts doppelt an
  await sql`insert into app.subcontract_hours (id, subcontract_id, work_date, persons, minutes_per_person, note, created_by)
            values (${p.id}, ${p.subcontractId}, ${p.workDate}, ${p.persons}, ${p.minutesPerPerson}, ${p.note}, ${p.actor})
            on conflict (id) do nothing`;
}

export async function deleteSubcontractHours(sql: Sql, id: string, subcontractId: string, actor: string) {
  await sql.begin(async (tx) => {
    const [row] = await tx<Record<string, unknown>[]>`
      delete from app.subcontract_hours where id = ${id} and subcontract_id = ${subcontractId} returning *`;
    if (!row) return;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'delete', 'subcontract_hours', ${id}, ${tx.json(JSON.parse(JSON.stringify(row)))})`;
  });
}
