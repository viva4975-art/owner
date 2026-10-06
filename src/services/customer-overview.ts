import { randomUUID } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { validIban } from './employees.js';
import { BusinessError } from './errors.js';

/*
 * Kundenübersicht wie Fortytools: Netto-Umsatz je Monat (nach Rechnungsdatum oder Leistungszeitraum, ab Jahr)
 * und Bankverbindungen des Kunden.
 */

export type RevenueMode = 'rechnung' | 'leistung';

/** Netto-Umsatz je Monat ab Januar `fromYear` bis zum aktuellen Monat (ausgestellte Belege inkl. Storno/Korrektur). */
export async function customerRevenue(sql: Sql, customerId: string, mode: RevenueMode, fromYear: number) {
  return sql<{ month: string; net_cents: bigint }[]>`
    with months as (
      select to_char(d, 'YYYY-MM') as month
        from generate_series(make_date(${fromYear}::int, 1, 1), date_trunc('month', current_date), interval '1 month') d
    )
    select m.month, coalesce(sum(i.net_cents), 0)::bigint as net_cents
      from months m
      left join app.invoices i
        on i.status = 'issued' and i.customer_id = ${customerId}
       and to_char(${mode === 'leistung' ? sql`coalesce(i.period_start, i.issue_date)` : sql`i.issue_date`}, 'YYYY-MM') = m.month
     group by m.month order by m.month`;
}

/** Jahre mit Rechnungen (für die Auswahl „ab Jahr“). */
export async function customerRevenueYears(sql: Sql, customerId: string): Promise<number[]> {
  const rows = await sql<{ y: number }[]>`
    select distinct extract(year from issue_date)::int as y from app.invoices
     where customer_id = ${customerId} and status = 'issued' order by y`;
  const cur = new Date().getFullYear();
  const ys = new Set([...rows.map((r) => r.y), cur]);
  return [...ys].sort((a, b) => a - b);
}

export interface CustomerBankAccount {
  id: string;
  holder: string;
  iban: string;
  bic: string | null;
}

export async function listCustomerBankAccounts(sql: Sql, customerId: string) {
  return sql<CustomerBankAccount[]>`
    select id, holder, iban, bic from app.customer_bank_accounts where customer_id = ${customerId} order by created_at`;
}

export async function saveCustomerBankAccount(
  sql: Sql,
  customerId: string,
  p: { id?: string | null; holder: string; iban: string; bic: string | null },
  actor: string,
) {
  const iban = p.iban.replace(/\s+/g, '').toUpperCase();
  if (!p.holder.trim()) throw new BusinessError('Bitte Kontoinhaber angeben');
  if (!validIban(iban)) throw new BusinessError('IBAN ungültig (Prüfziffer)');
  const bic = p.bic?.replace(/\s+/g, '').toUpperCase() || null;
  if (bic && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(bic)) throw new BusinessError('BIC ungültig');
  const id = p.id ?? randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      insert into app.customer_bank_accounts (id, customer_id, holder, iban, bic, created_by)
      values (${id}, ${customerId}, ${p.holder.trim()}, ${iban}, ${bic}, ${actor})
      on conflict (id) do update set holder = excluded.holder, iban = excluded.iban, bic = excluded.bic`.catch(
      (e: { code?: string }) => {
        if (e.code === '23505') throw new BusinessError('Diese IBAN ist beim Kunden schon hinterlegt');
        throw e;
      },
    );
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'bank_account', 'customer', ${customerId}, ${tx.json({ iban })})`;
  });
}

export async function deleteCustomerBankAccount(sql: Sql, customerId: string, id: string, actor: string) {
  await sql.begin(async (tx) => {
    await tx`delete from app.customer_bank_accounts where id = ${id} and customer_id = ${customerId}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'bank_account_delete', 'customer', ${customerId}, ${tx.json({ id })})`;
  });
}
