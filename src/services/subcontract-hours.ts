import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';

/**
 * Stundennachweis zu NU-Bestellungen „je Stunde“ (Ahmed 09.10.): je Tag Anzahl Personen × Stunden je Person.
 * Dazu Regiestunden (Ahmed 30.10.) bei jeder Abrechnungsart zum Regie-Stundensatz der Bestellung.
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
  /** Regie / Zusatzarbeit zum Regie-Stundensatz der Bestellung */
  regie: boolean;
  site_id: string | null;
  site_name: string | null;
}

export async function listSubcontractHours(sql: Sql, subcontractId: string) {
  return sql<SubcontractHourRow[]>`
    select h.id, h.work_date::text, h.persons, h.minutes_per_person, h.persons * h.minutes_per_person as total_minutes,
           r.rate as rate_cents,
           round(h.persons * h.minutes_per_person * r.rate::numeric / 60)::bigint as amount_cents,
           h.note, h.created_by, h.regie, h.site_id,
           (select x.site_no || ' ' || x.name from app.sites x where x.id = h.site_id) as site_name
      from app.subcontract_hours h join app.subcontracts s on s.id = h.subcontract_id
      cross join lateral (
        select case when h.regie then coalesce(s.regie_rate_cents, 0)
               else coalesce((select p.price_cents from app.subcontract_prices p
                          where p.subcontract_id = s.id and p.valid_from_month <= date_trunc('month', h.work_date)::date
                          order by p.valid_from_month desc limit 1), s.price_cents, 0) end as rate) r
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
    /** Regie / Zusatzarbeit (Regie-Stundensatz der Bestellung) */
    regie?: boolean;
    siteId?: string | null;
  },
) {
  const [sc] = await sql<
    {
      billing: string;
      status: string;
      valid_from: string;
      valid_to: string | null;
      regie_rate_cents: bigint | null;
      site_id: string | null;
    }[]
  >`
    select billing, status, valid_from::text, valid_to::text, regie_rate_cents, site_id
      from app.subcontracts where id = ${p.subcontractId}`;
  if (!sc) throw new BusinessError('Bestellung nicht gefunden');
  const regie = !!p.regie || sc.billing !== 'stunde';
  if (regie && sc.regie_rate_cents === null)
    throw new BusinessError(
      'Für Regiestunden bitte zuerst den Regie-Stundensatz in der Bestellung eintragen',
    );
  let siteId: string | null = null;
  if (regie && p.siteId) {
    const [ok] = await sql`
      select 1 from app.subcontracts s where s.id = ${p.subcontractId}
         and (s.site_id = ${p.siteId}
              or exists (select 1 from app.subcontract_sites x where x.subcontract_id = s.id and x.site_id = ${p.siteId}))`;
    if (!ok) throw new BusinessError('Objekt gehört nicht zu dieser Bestellung');
    siteId = p.siteId;
  }
  if (sc.status === 'storniert') throw new BusinessError('Bestellung ist storniert');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.workDate)) throw new BusinessError('Bitte Datum angeben');
  if (p.workDate < sc.valid_from || (sc.valid_to && p.workDate > sc.valid_to))
    throw new BusinessError('Datum liegt außerhalb des Zeitraums der Bestellung');
  if (!Number.isInteger(p.persons) || p.persons < 1 || p.persons > 200)
    throw new BusinessError('Anzahl Personen 1 bis 200');
  if (!Number.isInteger(p.minutesPerPerson) || p.minutesPerPerson < 1 || p.minutesPerPerson > 1440)
    throw new BusinessError('Stunden je Person bitte als 2:30 oder 2,5 angeben (höchstens 24 Std.)');
  // feste ID je Formular → doppelt absenden legt nichts doppelt an
  await sql`insert into app.subcontract_hours (id, subcontract_id, work_date, persons, minutes_per_person, note, created_by,
                                             regie, site_id)
            values (${p.id}, ${p.subcontractId}, ${p.workDate}, ${p.persons}, ${p.minutesPerPerson}, ${p.note}, ${p.actor},
                    ${regie}, ${siteId})
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

/** Erfasste Stunden und Betrag je Bestellung in einem Monat (JJJJ-MM) – für die Bestelllisten (Ahmed 20.10.).
 * `totalIds`: Bestellungen ohne Monatsbezug (einmalig, quartalsweise …) → alle erfassten Stunden. */
export async function hoursOfMonth(
  sql: Sql,
  ids: string[],
  month: string,
  totalIds: string[] = [],
): Promise<Map<string, { minutes: number; amount: bigint }>> {
  const out = new Map<string, { minutes: number; amount: bigint }>();
  if (!ids.length) return out;
  for (const r of await sql<{ id: string; minutes: number; amount: bigint }[]>`
    select h.subcontract_id as id, sum(h.persons * h.minutes_per_person)::int as minutes,
           sum(round(h.persons * h.minutes_per_person * r.rate::numeric / 60))::bigint as amount
      from app.subcontract_hours h join app.subcontracts s on s.id = h.subcontract_id
      cross join lateral (
        select case when h.regie then coalesce(s.regie_rate_cents, 0)
               else coalesce((select p.price_cents from app.subcontract_prices p
                          where p.subcontract_id = s.id and p.valid_from_month <= date_trunc('month', h.work_date)::date
                          order by p.valid_from_month desc limit 1), s.price_cents, 0) end as rate) r
     where h.subcontract_id = any(${ids}::uuid[]) and not h.regie
       and (h.subcontract_id = any(${totalIds}::uuid[]) or date_trunc('month', h.work_date) = ${`${month}-01`}::date)
     group by h.subcontract_id`)
    out.set(r.id, { minutes: r.minutes, amount: BigInt(r.amount) });
  return out;
}
