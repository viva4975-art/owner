import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';

/*
 * Nummernkreise anzeigen und anheben (Einstellungen → Nummernkreise, nur Admin). Senken ist ausgeschlossen: eine schon
 * vergebene Nummer darf nie ein zweites Mal entstehen (Rechnungen: § 14 Abs. 4 Nr. 4 UStG – einmalige Nummer).
 */

const LABEL: Record<string, string> = {
  invoice: 'Rechnungen (auch Storno/Korrektur)',
  offer: 'Angebote',
  dunning: 'Mahnungen',
  payment_run: 'Zahlungsläufe (SEPA)',
};

const YEARLY: Record<string, string> = {
  handover: 'Übergaben',
  order: 'Aufträge',
  payment_run: 'Zahlungsläufe',
  po: 'Bestellungen / NU-Aufträge',
  quality_check: 'Qualitätskontrollen',
  site_ticket: 'Tickets',
  work_report: 'Arbeitsscheine',
  cash: 'Kassenbelege',
  dunning: 'Mahnungen',
};

export const rangeLabel = (key: string) => {
  if (LABEL[key]) return LABEL[key];
  const m = /^([a-z_]+?)[_:-]?(\d{4})$/.exec(key);
  return m ? `${YEARLY[m[1]!] ?? m[1]} ${m[2]}` : key;
};

const ORDER = ['invoice', 'offer', 'dunning'];

export interface RangeRow {
  key: string;
  prefix: string;
  next_value: bigint;
  updated_at: Date;
  /** höchste bereits vergebene Nummer (nur Rechnungen/Angebote bekannt) */
  used_max: bigint | null;
}

export async function listRanges(sql: Sql): Promise<RangeRow[]> {
  const rows = await sql<
    Omit<RangeRow, 'used_max'>[]
  >`select key, prefix, next_value, updated_at from app.number_ranges order by key`;
  const [inv] = await sql<{ m: bigint | null }[]>`select max(number_seq)::bigint as m from app.invoices`;
  const [legacy] = await sql<{ m: bigint | null }[]>`
    select max(number::bigint) as m from app.legacy_invoices where number ~ '^[0-9]{1,15}$'`;
  const [off] = await sql<{ m: bigint | null }[]>`
    select max(number::bigint) as m from app.offers where number ~ '^[0-9]{1,15}$'`;
  const maxOf = (...v: (bigint | null | undefined)[]) =>
    v.reduce<bigint | null>((a, b) => (b != null && (a == null || b > a) ? b : a), null);
  rows.sort((a, b) => {
    const ia = ORDER.indexOf(a.key);
    const ib = ORDER.indexOf(b.key);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.key.localeCompare(b.key);
  });
  return rows.map((r) => ({
    ...r,
    used_max: r.key === 'invoice' ? maxOf(inv?.m, legacy?.m) : r.key === 'offer' ? maxOf(off?.m) : null,
  }));
}

/** Nächste Nummer anheben (nie senken, nie unter eine vergebene Nummer). */
export async function raiseRange(sql: Sql, key: string, next: bigint, actor: string) {
  const r = (await listRanges(sql)).find((x) => x.key === key);
  if (!r) throw new BusinessError('Nummernkreis nicht gefunden');
  if (next <= r.next_value)
    throw new BusinessError(
      `Nummernkreise können nur angehoben werden (derzeit nächste Nr. ${r.next_value})`,
    );
  if (r.used_max != null && next <= r.used_max)
    throw new BusinessError(`Nummer ${r.used_max} ist schon vergeben – bitte höher wählen`);
  const res = await sql`update app.number_ranges set next_value = ${next}, updated_at = now()
                         where key = ${key} and next_value < ${next} returning key`;
  if (!res.length) throw new BusinessError('Wurde zwischenzeitlich geändert – bitte neu laden');
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'raise_number_range', 'number_ranges', null,
                    ${sql.json({ key, from: String(r.next_value), to: String(next) })})`;
}
