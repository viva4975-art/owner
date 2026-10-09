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

interface CoverInvoice {
  subcontract_id: string | null;
  supplier_id: string;
  site_id: string | null;
  /** 'JJJJ-MM' – Zeitraum der Verknüpfung bzw. Leistungsmonat/Rechnungsdatum */
  m: string;
  id: string;
  invoice_no: string;
  net: bigint | null;
  /** link = ausdrücklich verknüpft, direct = am Auftrag erfasst, loose = gleicher NU + Objekt ohne Auftrag */
  how: 'link' | 'direct' | 'loose';
}

/** Laufend (regelmäßig eine Rechnung je Monat erwartet) sind nur monatliche/wöchentliche Bestellungen (Ahmed 09.10.);
 * einmalig, quartalsweise, halbjährlich, jährlich = nach Ausführung, keine „Rechnung erwartet“-Meldung. */
export const isRecurringOrder = (frequency: string) =>
  frequency === 'monatlich' || frequency === 'woechentlich';

/**
 * Selbst prüfen (Ahmed 09.10.: „soll selber checken“): Ein Zeitraum gilt als abgerechnet, wenn eine Eingangsrechnung
 * ihn abdeckt – ausdrücklich verknüpft (Zeitraum irgendwo im Abrechnungszeitraum), am Auftrag erfasst oder vom selben
 * Nachunternehmer für dasselbe Objekt ohne Auftrag – mit Leistungsmonat (sonst Rechnungsdatum) im Zeitraum; bei
 * längeren Zeiträumen auch bis 2 Monate nach Ende. Abgelehnte Rechnungen zählen nicht.
 */
async function coverInvoices(
  sql: Sql,
  orders: { id: string; supplier_id: string; site_id: string | null }[],
): Promise<CoverInvoice[]> {
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const sups = [...new Set(orders.map((o) => o.supplier_id))];
  return sql<CoverInvoice[]>`
    select l.subcontract_id, i.supplier_id, i.site_id, to_char(l.period_month, 'YYYY-MM') as m, i.id, i.invoice_no,
           l.net_cents as net, 'link' as how
      from app.incoming_invoice_subcontracts l join app.incoming_invoices i on i.id = l.incoming_invoice_id
     where l.subcontract_id in ${sql(ids)} and i.status <> 'abgelehnt'
    union all
    select i.subcontract_id, i.supplier_id, i.site_id, to_char(coalesce(i.service_month, i.invoice_date), 'YYYY-MM'),
           i.id, i.invoice_no, i.net_cents, case when i.subcontract_id is null then 'loose' else 'direct' end
      from app.incoming_invoices i
     where i.status <> 'abgelehnt' and i.supplier_id in ${sql(sups)}
       and (i.subcontract_id in ${sql(ids)} or i.subcontract_id is null)
       and not exists (select 1 from app.incoming_invoice_subcontracts l where l.incoming_invoice_id = i.id)`;
}

function coverFor(
  list: CoverInvoice[],
  o: { id: string; supplier_id: string; site_id: string | null; frequency: string },
  p: { start: string; end: string },
) {
  const step = STEP[o.frequency] ?? 1;
  const last = monthAdd(p.end.slice(0, 7), step >= 3 ? 2 : 0);
  const out = new Map<string, { id: string; invoice_no: string; net: bigint | null }>();
  for (const c of list) {
    const mine =
      c.subcontract_id === o.id ||
      (c.how === 'loose' && c.supplier_id === o.supplier_id && !!o.site_id && c.site_id === o.site_id);
    if (!mine) continue;
    const upper = c.how === 'link' ? p.end.slice(0, 7) : last;
    if (c.m >= p.start && c.m <= upper && !out.has(c.id))
      out.set(c.id, { id: c.id, invoice_no: c.invoice_no, net: c.net });
  }
  return [...out.values()];
}

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
    coverInvoices(sql, orders),
    sql<{ subcontract_id: string; m: string }[]>`
      select subcontract_id, to_char(period_month, 'YYYY-MM') as m from app.subcontract_expected_skips
       where subcontract_id in ${sql(ids)}`,
    sql<{ subcontract_id: string; m: string; price_cents: bigint }[]>`
      select subcontract_id, to_char(valid_from_month, 'YYYY-MM') as m, price_cents from app.subcontract_prices
       where subcontract_id in ${sql(ids)} order by valid_from_month`,
  ]);
  const has = new Set(skipped.map((r) => `${r.subcontract_id}|${r.m}`));
  const rows: ExpectedRow[] = [];
  for (const o of orders) {
    if (!isRecurringOrder(o.frequency)) continue;
    for (const p of periodsOf(o.frequency, o.valid_from, o.valid_to, today)) {
      if (has.has(`${o.id}|${p.start}`)) continue;
      if (coverFor(covered, o, p).length) continue;
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

/** bedarf = nicht monatlich, Rechnung nach Ausführung (keine Meldung) */
export type BillingState = 'abgerechnet' | 'keine' | 'offen' | 'laufend' | 'bedarf';
export interface BillingPeriod {
  start: string;
  end: string;
  state: BillingState;
  invoices: { id: string; invoice_no: string; net: bigint | null }[];
  skipReason: string | null;
}

/**
 * Rechnungsverfolgung je Bestellung: alle Zeiträume bis einschließlich des laufenden (im Oktober also auch
 * Oktober), höchstens `limit` neueste, mit Status abgerechnet / keine Rechnung / offen (abgelaufen, ohne Rechnung) /
 * laufend (Zeitraum noch nicht vorbei, noch keine Rechnung).
 */
export async function billingTracking(
  sql: Sql,
  ids: string[],
  opts: { today?: string; limit?: number } = {},
): Promise<Map<string, BillingPeriod[]>> {
  const today = opts.today ?? todayBerlin();
  const out = new Map<string, BillingPeriod[]>();
  if (!ids.length) return out;
  const [orders, skipped] = await Promise.all([
    sql<
      {
        id: string;
        supplier_id: string;
        site_id: string | null;
        frequency: string;
        valid_from: string;
        valid_to: string | null;
        status: string;
      }[]
    >`
      select id, supplier_id, site_id, frequency, valid_from::text, valid_to::text, status
        from app.subcontracts where id in ${sql(ids)}`,
    sql<{ subcontract_id: string; m: string; reason: string }[]>`
      select subcontract_id, to_char(period_month, 'YYYY-MM') as m, reason from app.subcontract_expected_skips
       where subcontract_id in ${sql(ids)}`,
  ]);
  const covered = await coverInvoices(sql, orders);
  const skip = new Map(skipped.map((s) => [`${s.subcontract_id}|${s.m}`, s.reason]));
  for (const o of orders) {
    if (o.status !== 'erteilt' && o.status !== 'beendet') {
      out.set(o.id, []);
      continue;
    }
    const step = STEP[o.frequency] ?? 1;
    const periods: { start: string; end: string }[] = [];
    if (step === 0) {
      const end = lastDay((o.valid_to ?? o.valid_from).slice(0, 7));
      if (o.valid_from <= today) periods.push({ start: o.valid_from.slice(0, 7), end });
    } else {
      for (let m = o.valid_from.slice(0, 7), i = 0; i < 600; m = monthAdd(m, step), i++) {
        if (o.valid_to && `${m}-01` > o.valid_to) break;
        if (`${m}-01` > today) break;
        let end = lastDay(monthAdd(m, step - 1));
        if (o.valid_to && end > o.valid_to) end = o.valid_to;
        periods.push({ start: m, end });
      }
    }
    const list = periods.slice(-(opts.limit ?? 13)).map((p): BillingPeriod => {
      const k = `${o.id}|${p.start}`;
      const invoices = coverFor(covered, o, p);
      const reason = skip.get(k) ?? null;
      const state: BillingState = invoices.length
        ? 'abgerechnet'
        : reason
          ? 'keine'
          : !isRecurringOrder(o.frequency)
            ? 'bedarf'
            : p.end < today
              ? 'offen'
              : 'laufend';
      return { ...p, state, invoices, skipReason: reason };
    });
    out.set(o.id, list.reverse());
  }
  return out;
}
