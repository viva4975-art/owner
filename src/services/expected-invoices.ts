import type { Sql, Tx } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from './errors.js';

/**
 * „Rechnung erwartet“: Für jeden laufenden Nachunternehmer-Auftrag wird je abgelaufenem Abrechnungszeitraum eine
 * Eingangsrechnung erwartet (monatlich bzw. laut Turnus). Sie verschwindet, sobald eine Eingangsrechnung den Auftrag
 * und Zeitraum abdeckt – eine Rechnung darf mehrere Aufträge/Zeiträume abdecken (z. B. Glasreinigung mehrerer
 * Objekte) – oder der Zeitraum mit Grund als „keine Rechnung“ markiert ist.
 */
const STEP: Record<string, number> = {
  einmalig: 0,
  woechentlich: 1,
  monatlich: 1,
  quartalsweise: 3,
  halbjaehrlich: 6,
  jaehrlich: 12,
};
/** Rückblick: ältere Zeiträume werden nicht mehr gemeldet (Altbestand). */
const LOOKBACK_MONTHS = 12;

const monthAdd = (m: string, k: number) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, mo - 1 + k, 1));
  return d.toISOString().slice(0, 7);
};
const lastDay = (m: string) =>
  new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);

export interface ExpectedRow {
  subcontract_id: string;
  number: string;
  supplier_id: string;
  supplier_name: string;
  site_id: string | null;
  site_name: string | null;
  site_no: string | null;
  customer_name: string | null;
  billing: string;
  frequency: string;
  /** 'JJJJ-MM' Beginn des Zeitraums */
  period: string;
  periodEnd: string;
  months: number;
  /** erwarteter Nettobetrag (nur Monatspauschale), sonst null = nach Aufwand */
  expectedNet: bigint | null;
  daysOverdue: number;
}

/** Zeiträume eines Auftrags, die bis `today` abgelaufen sind (Beginn 'JJJJ-MM', Ende, Monate). */
export function periodsOf(
  frequency: string,
  validFrom: string,
  validTo: string | null,
  today: string,
): { start: string; end: string; months: number }[] {
  const step = STEP[frequency] ?? 1;
  const first = validFrom.slice(0, 7);
  const out: { start: string; end: string; months: number }[] = [];
  if (step === 0) {
    const endM = (validTo ?? validFrom).slice(0, 7);
    const end = lastDay(endM);
    if (end < today) out.push({ start: first, end, months: 1 });
    return out;
  }
  const minStart = monthAdd(today.slice(0, 7), -LOOKBACK_MONTHS);
  for (let m = first, i = 0; i < 600; m = monthAdd(m, step), i++) {
    if (validTo && `${m}-01` > validTo) break;
    let end = lastDay(monthAdd(m, step - 1));
    if (validTo && end > validTo) end = validTo;
    if (end >= today) break;
    if (m >= minStart) out.push({ start: m, end, months: step });
  }
  return out;
}

export async function expectedInvoices(sql: Sql, opts: { supplierId?: string; today?: string } = {}) {
  const today = opts.today ?? todayBerlin();
  const orders = await sql<
    {
      id: string;
      number: string;
      supplier_id: string;
      supplier_name: string;
      site_id: string | null;
      site_name: string | null;
      site_no: string | null;
      customer_name: string | null;
      billing: string;
      frequency: string;
      price_cents: bigint;
      valid_from: string;
      valid_to: string | null;
    }[]
  >`
    select sc.id, sc.number, sc.supplier_id, sp.name as supplier_name, sc.site_id, s.name as site_name, s.site_no,
           c.name as customer_name, sc.billing, sc.frequency, sc.price_cents, sc.valid_from::text, sc.valid_to::text
      from app.subcontracts sc join app.suppliers sp on sp.id = sc.supplier_id
      left join app.sites s on s.id = sc.site_id left join app.customers c on c.id = s.customer_id
     where sc.status in ('erteilt', 'beendet')
       and ${opts.supplierId ? sql`sc.supplier_id = ${opts.supplierId}` : sql`true`}
     order by sp.name, sc.number`;
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const [covered, skipped, prices] = await Promise.all([
    sql<{ subcontract_id: string; m: string }[]>`
      select subcontract_id, to_char(period_month, 'YYYY-MM') as m from app.incoming_invoice_subcontracts
       where subcontract_id in ${sql(ids)}`,
    sql<{ subcontract_id: string; m: string }[]>`
      select subcontract_id, to_char(period_month, 'YYYY-MM') as m from app.subcontract_expected_skips
       where subcontract_id in ${sql(ids)}`,
    sql<{ subcontract_id: string; m: string; price_cents: bigint }[]>`
      select subcontract_id, to_char(valid_from_month, 'YYYY-MM') as m, price_cents from app.subcontract_prices
       where subcontract_id in ${sql(ids)} order by valid_from_month`,
  ]);
  const has = new Set([...covered, ...skipped].map((r) => `${r.subcontract_id}|${r.m}`));
  const rows: ExpectedRow[] = [];
  for (const o of orders) {
    for (const p of periodsOf(o.frequency, o.valid_from, o.valid_to, today)) {
      if (has.has(`${o.id}|${p.start}`)) continue;
      let price = o.price_cents;
      for (const pr of prices) if (pr.subcontract_id === o.id && pr.m <= p.start) price = pr.price_cents;
      const days = Math.round(
        (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${p.end}T12:00:00Z`)) / 86400000,
      );
      rows.push({
        subcontract_id: o.id,
        number: o.number,
        supplier_id: o.supplier_id,
        supplier_name: o.supplier_name,
        site_id: o.site_id,
        site_name: o.site_name,
        site_no: o.site_no,
        customer_name: o.customer_name,
        billing: o.billing,
        frequency: o.frequency,
        period: p.start,
        periodEnd: p.end,
        months: p.months,
        expectedNet: o.billing === 'pauschale_monat' ? price * BigInt(p.months) : null,
        daysOverdue: days,
      });
    }
  }
  return rows;
}

/** Zeitraum „keine Rechnung erwartet“ (mit Grund). */
export async function skipExpected(
  sql: Sql,
  subcontractId: string,
  month: string,
  reason: string,
  actor: string,
) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new BusinessError('Zeitraum ungültig');
  if (!reason.trim()) throw new BusinessError('Bitte Grund angeben');
  await sql`insert into app.subcontract_expected_skips (subcontract_id, period_month, reason, created_by)
            values (${subcontractId}, ${`${month}-01`}, ${reason.trim()}, ${actor}) on conflict do nothing`;
}

export interface SubcontractLink {
  subcontractId: string;
  /** 'JJJJ-MM' */
  month: string;
  net: bigint | null;
}

/** Zuordnung Eingangsrechnung ↔ Aufträge/Zeiträume ersetzen (in der Transaktion des Speicherns). */
export async function replaceLinks(
  tx: Tx,
  invoiceId: string,
  supplierId: string,
  links: SubcontractLink[],
  actor: string,
) {
  const seen = new Set<string>();
  for (const l of links) {
    if (!/^\d{4}-\d{2}$/.test(l.month)) throw new BusinessError('Zeitraum der Auftragszuordnung ungültig');
    const k = `${l.subcontractId}|${l.month}`;
    if (seen.has(k)) throw new BusinessError('Ein Auftrag/Zeitraum ist doppelt zugeordnet');
    seen.add(k);
  }
  if (links.length) {
    const ok = await tx<{ id: string }[]>`
      select id from app.subcontracts where id in ${tx(links.map((l) => l.subcontractId))} and supplier_id = ${supplierId}`;
    if (new Set(ok.map((r) => r.id)).size !== new Set(links.map((l) => l.subcontractId)).size)
      throw new BusinessError('Nachunternehmer-Auftrag gehört nicht zu diesem Lieferanten');
  }
  await tx`delete from app.incoming_invoice_subcontracts where incoming_invoice_id = ${invoiceId}`;
  for (const l of links)
    await tx`insert into app.incoming_invoice_subcontracts (incoming_invoice_id, subcontract_id, period_month, net_cents, created_by)
             values (${invoiceId}, ${l.subcontractId}, ${`${l.month}-01`}, ${l.net}, ${actor})`;
}

export async function linksOf(sql: Sql, invoiceId: string) {
  return sql<
    {
      subcontract_id: string;
      m: string;
      net_cents: bigint | null;
      number: string;
      site_name: string | null;
    }[]
  >`
    select l.subcontract_id, to_char(l.period_month, 'YYYY-MM') as m, l.net_cents, sc.number, s.name as site_name
      from app.incoming_invoice_subcontracts l join app.subcontracts sc on sc.id = l.subcontract_id
      left join app.sites s on s.id = sc.site_id
     where l.incoming_invoice_id = ${invoiceId} order by sc.number, l.period_month`;
}
