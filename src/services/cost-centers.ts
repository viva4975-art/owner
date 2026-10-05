import type { Sql, Tx } from '../db/client.js';
import { assertVersion } from './crm.js';
import { BusinessError } from './errors.js';

/*
 * Kostenstellen: jedes Objekt (site) ist eine Kostenstelle, dazu allgemeine Kostenstellen (cost_centers).
 * Eingangsrechnungen werden auf Kostenstellen × Leistungsmonat aufgeteilt; Summe = Nettobetrag der Rechnung.
 * Ohne eigene Aufteilung gilt automatisch: Objekt der Rechnung + Leistungsmonat (auto).
 */

export interface CostCenter {
  id: string;
  number: string;
  name: string;
  active: boolean;
  version: number;
}

export async function listCostCenters(sql: Sql, all = false) {
  return sql<CostCenter[]>`select * from app.cost_centers where ${all} or active order by number`;
}

export async function saveCostCenter(
  sql: Sql,
  id: string,
  p: { number: string; name: string; active: boolean; version?: number | null },
  actor: string,
) {
  if (!p.number.trim() || !p.name.trim()) throw new BusinessError('Bitte Nummer und Bezeichnung angeben');
  const [clash] = await sql`select 1 from app.sites where site_no = ${p.number.trim()}`;
  if (clash)
    throw new BusinessError('Diese Nummer ist schon eine Objektnummer – bitte andere wählen (z. B. 9xxx)');
  await sql
    .begin(async (tx) => {
      const [cur] = await tx<CostCenter[]>`select * from app.cost_centers where id = ${id} for update`;
      assertVersion(cur?.version, p.version, 'Die Kostenstelle');
      const row = { number: p.number.trim(), name: p.name.trim(), active: p.active };
      if (cur) await tx`update app.cost_centers set ${tx(row)} where id = ${id}`;
      else await tx`insert into app.cost_centers ${tx({ id, ...row })}`;
      await tx`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, ${cur ? 'update' : 'create'}, 'cost_center', ${id})`;
    })
    .catch((e: { code?: string }) => {
      if (e.code === '23505') throw new BusinessError('Kostenstellen-Nummer ist schon vergeben');
      throw e;
    });
}

/** Auswahlliste: Objekte (aktiv) und allgemeine Kostenstellen, als „site:<id>“ bzw. „cc:<id>“. */
export async function costTargets(sql: Sql) {
  const [sites, ccs] = await Promise.all([
    sql<
      { id: string; site_no: string; name: string }[]
    >`select id, site_no, name from app.sites where active order by site_no`,
    listCostCenters(sql),
  ]);
  return [
    ...ccs.map((c) => ({ value: `cc:${c.id}`, label: `${c.number} · ${c.name}`, group: 'Allgemein' })),
    ...sites.map((s) => ({ value: `site:${s.id}`, label: `${s.site_no} · ${s.name}`, group: 'Objekte' })),
  ];
}

export interface Allocation {
  id: string;
  site_id: string | null;
  cost_center_id: string | null;
  month: string;
  net_cents: bigint;
  auto: boolean;
  note: string | null;
  label: string;
}

export async function getAllocations(sql: Sql, invoiceId: string) {
  return sql<Allocation[]>`
    select a.id, a.site_id, a.cost_center_id, a.month, a.net_cents, a.auto, a.note,
           coalesce(s.site_no || ' · ' || s.name, cc.number || ' · ' || cc.name) as label
      from app.cost_allocations a
      left join app.sites s on s.id = a.site_id
      left join app.cost_centers cc on cc.id = a.cost_center_id
     where a.incoming_invoice_id = ${invoiceId}
     order by a.month, label`;
}

/** Betrag Cent-genau auf n Teile verteilen (Rest auf die ersten Teile). */
export function splitEvenly(total: bigint, n: number): bigint[] {
  if (n < 1) throw new BusinessError('Mindestens ein Monat');
  const sign = total < 0n ? -1n : 1n;
  const abs = total * sign;
  const base = abs / BigInt(n);
  const rest = Number(abs % BigInt(n));
  return Array.from({ length: n }, (_, i) => (base + (i < rest ? 1n : 0n)) * sign);
}

export function addMonths(month: string, k: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + k, 1));
  return d.toISOString().slice(0, 7);
}

export interface AllocationInput {
  target: string; // site:<uuid> | cc:<uuid>
  month: string; // JJJJ-MM
  net: bigint;
  note: string | null;
}

const parseTarget = (t: string) => {
  const m = /^(site|cc):([0-9a-f-]{36})$/.exec(t);
  if (!m) throw new BusinessError('Bitte Kostenstelle wählen');
  return m[1] === 'site'
    ? { site_id: m[2]!, cost_center_id: null }
    : { site_id: null, cost_center_id: m[2]! };
};

/** Eigene Aufteilung speichern (ersetzt die bisherige). Summe muss dem Nettobetrag entsprechen. */
export async function saveAllocations(sql: Sql, invoiceId: string, rows: AllocationInput[], actor: string) {
  const clean = rows.filter((r) => r.net !== 0n);
  for (const r of clean)
    if (!/^\d{4}-\d{2}$/.test(r.month)) throw new BusinessError('Leistungsmonat ungültig');
  await sql.begin(async (tx) => {
    const [inv] = await tx<{ net_cents: bigint }[]>`
      select net_cents from app.incoming_invoices where id = ${invoiceId} for update`;
    if (!inv) throw new BusinessError('Rechnung nicht gefunden');
    const sum = clean.reduce((a, r) => a + r.net, 0n);
    if (clean.length && sum !== inv.net_cents)
      throw new BusinessError(
        `Aufteilung ergibt ${(Number(sum) / 100).toFixed(2).replace('.', ',')} €, die Rechnung hat netto ${(
          Number(inv.net_cents) / 100
        )
          .toFixed(2)
          .replace('.', ',')} € – bitte angleichen`,
      );
    await tx`delete from app.cost_allocations where incoming_invoice_id = ${invoiceId}`;
    for (const r of clean) {
      await tx`insert into app.cost_allocations ${tx({
        id: crypto.randomUUID(),
        incoming_invoice_id: invoiceId,
        ...parseTarget(r.target),
        month: `${r.month}-01`,
        net_cents: r.net,
        auto: false,
        note: r.note?.trim() || null,
        created_by: actor,
      })}`;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'allocation', 'incoming_invoice', ${invoiceId}, ${tx.json({ rows: clean.length })})`;
  });
}

/** Nach dem Speichern einer Eingangsrechnung: automatische Zuordnung nachziehen (nur wenn keine eigene Aufteilung). */
export async function syncAutoAllocation(tx: Tx, invoiceId: string, actor: string) {
  const own =
    await tx`select 1 from app.cost_allocations where incoming_invoice_id = ${invoiceId} and not auto limit 1`;
  if (own.length) return;
  await tx`delete from app.cost_allocations where incoming_invoice_id = ${invoiceId} and auto`;
  await tx`
    insert into app.cost_allocations (id, incoming_invoice_id, site_id, month, net_cents, auto, created_by)
    select gen_random_uuid(), i.id, i.site_id, coalesce(i.service_month, date_trunc('month', i.invoice_date)::date),
           i.net_cents, true, ${actor}
      from app.incoming_invoices i where i.id = ${invoiceId} and i.site_id is not null and i.net_cents <> 0`;
}

/** Auswertung je Kostenstelle und Kategorie für einen Zeitraum (Monate einschließlich). */
export async function costCenterReport(sql: Sql, from: string, to: string) {
  const rows = await sql<
    {
      key: string;
      label: string;
      kind: 'objekt' | 'allgemein';
      site_id: string | null;
      category: string;
      net: bigint;
    }[]
  >`
    select coalesce('site:' || a.site_id, 'cc:' || a.cost_center_id) as key,
           coalesce(s.site_no || ' · ' || s.name, cc.number || ' · ' || cc.name) as label,
           case when a.site_id is null then 'allgemein' else 'objekt' end as kind, a.site_id,
           i.category::text as category, sum(a.net_cents)::bigint as net
      from app.cost_allocations a
      join app.incoming_invoices i on i.id = a.incoming_invoice_id and i.status in ('erfasst', 'freigegeben', 'bezahlt')
      left join app.sites s on s.id = a.site_id
      left join app.cost_centers cc on cc.id = a.cost_center_id
     where a.month between ${`${from}-01`}::date and ${`${to}-01`}::date
     group by 1, 2, 3, 4, 5
     order by kind, label`;
  const map = new Map<
    string,
    {
      key: string;
      label: string;
      kind: string;
      site_id: string | null;
      byCat: Record<string, bigint>;
      total: bigint;
    }
  >();
  for (const r of rows) {
    const e = map.get(r.key) ?? {
      key: r.key,
      label: r.label,
      kind: r.kind,
      site_id: r.site_id,
      byCat: {},
      total: 0n,
    };
    e.byCat[r.category] = (e.byCat[r.category] ?? 0n) + r.net;
    e.total += r.net;
    map.set(r.key, e);
  }
  const unallocated = await sql<
    {
      id: string;
      invoice_no: string;
      supplier_name: string;
      invoice_date: string;
      net_cents: bigint;
      allocated: bigint;
    }[]
  >`
    select i.id, i.invoice_no, s.name as supplier_name, i.invoice_date, i.net_cents,
           coalesce((select sum(a.net_cents) from app.cost_allocations a where a.incoming_invoice_id = i.id), 0)::bigint as allocated
      from app.incoming_invoices i join app.suppliers s on s.id = i.supplier_id
     where i.status in ('erfasst', 'freigegeben', 'bezahlt')
       and date_trunc('month', coalesce(i.service_month, i.invoice_date))::date between ${`${from}-01`}::date and ${`${to}-01`}::date
       and i.net_cents <> coalesce((select sum(a.net_cents) from app.cost_allocations a where a.incoming_invoice_id = i.id), 0)
     order by i.invoice_date desc`;
  return { rows: [...map.values()], unallocated };
}
