import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from './errors.js';
import { uuidOf } from './fortytools-export-import.js';

/*
 * Abgleich Leistungen ↔ Fortytools-Rechnungen (Ahmed 07.10.: Beträge falsch, weil Leistungen aus dem CSV-Export bei
 * gleichnamigen Objekten am falschen Objekt landeten). Maßstab ist je Objekt die letzte volle Monatsrechnung aus
 * Fortytools (Positionen „pauschal“ über einen ganzen Kalendermonat; Stornos/Korrekturen desselben Monats verrechnet).
 * Verglichen wird mit den aktiven monatlichen Leistungen in der App. „Übernehmen“ beendet die monatlichen Leistungen des
 * Objekts zum Ende des Fortytools-Monats und legt die Positionen der Fortytools-Rechnung ab dem Folgemonat an
 * (feste IDs → doppelt ausführen legt nichts doppelt an). Je Ausführung/einmalig bleiben unberührt.
 */

export interface FtLine {
  title: string;
  details: string | null;
  quantity_milli: bigint;
  unit_price_cents: bigint;
  net_cents: bigint;
  service_type: string | null;
  unit: string | null;
}

/** Fortytools-Einheit → Einheitencode (UN/ECE Rec. 20) */
const UNIT: Record<string, string> = { 'std.': 'HUR', 'stk.': 'C62', 'tg.': 'DAY', qm: 'MTK' };

export interface ReconRow {
  site_id: string;
  site_no: string;
  site_name: string;
  street: string | null;
  customer_id: string;
  customer_no: string;
  customer_name: string;
  ft_month: string | null; // JJJJ-MM der letzten Monatsrechnung
  ft_cents: bigint;
  app_cents: bigint;
  ft_lines: FtLine[];
  app_lines: { description: string; amount_cents: bigint; valid_from: string }[];
  status: 'gleich' | 'abweichend' | 'nur_app' | 'nur_fortytools' | 'alt';
}

const monthsBack = (m: string, n: number) => {
  const d = new Date(`${m}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 7);
};
const lastDayOf = (m: string) => {
  const d = new Date(`${m}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
};
const firstOfNext = (m: string) => {
  const d = new Date(`${m}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  return d.toISOString().slice(0, 10);
};

export async function reconcileRows(sql: Sql): Promise<ReconRow[]> {
  const ft = await sql<(FtLine & { site_id: string; month: string })[]>`
    with fl as (
      select x.site_id, to_char(x.period_start, 'YYYY-MM') as month, x.unit, coalesce(nullif(x.title, ''), x.service_type, 'Leistung') as title,
             x.details, x.quantity_milli, x.unit_price_cents, x.net_cents, x.service_type
        from app.legacy_invoice_lines x
       where x.site_id is not null and extract(day from x.period_start) = 1
         and x.period_end = (date_trunc('month', x.period_start) + interval '1 month - 1 day')::date
    ), last as (select site_id, max(month) as month from fl group by site_id)
    select fl.site_id, fl.month, fl.title, fl.unit, max(fl.details) as details, sum(fl.quantity_milli)::bigint as quantity_milli,
           fl.unit_price_cents, sum(fl.net_cents)::bigint as net_cents, max(fl.service_type) as service_type
      from fl join last on last.site_id = fl.site_id and last.month = fl.month
     group by fl.site_id, fl.month, fl.title, fl.unit, fl.unit_price_cents
    having sum(fl.quantity_milli) > 0
     order by fl.title`;
  const today = todayBerlin();
  const app = await sql<{ site_id: string; description: string; amount_cents: bigint; valid_from: string }[]>`
    select v.site_id, v.description, round(v.quantity_milli * v.unit_price_cents / 1000.0)::bigint as amount_cents,
           v.valid_from::text
      from app.site_services v
     where v.active and v.billing_cycle = 'monatlich' and (v.valid_to is null or v.valid_to >= ${today})
     order by v.sort_order, v.description`;
  const siteIds = [...new Set([...ft.map((r) => r.site_id), ...app.map((r) => r.site_id)])];
  if (!siteIds.length) return [];
  const sites = await sql<
    {
      id: string;
      site_no: string;
      name: string;
      street: string | null;
      customer_id: string;
      customer_no: string;
      customer_name: string;
    }[]
  >`select s.id, s.site_no, s.name, s.street, s.customer_id, c.customer_no, c.name as customer_name
      from app.sites s join app.customers c on c.id = s.customer_id
     where s.id in ${sql(siteIds)} and s.active and not c.is_internal
     order by c.customer_no, s.site_no`;
  const recent = monthsBack(today.slice(0, 7), 4);
  return sites.map((s) => {
    const fl = ft.filter((r) => r.site_id === s.id);
    const al = app.filter((r) => r.site_id === s.id);
    const ftCents = fl.reduce((a, r) => a + r.net_cents, 0n);
    const appCents = al.reduce((a, r) => a + r.amount_cents, 0n);
    const month = fl[0]?.month ?? null;
    const status: ReconRow['status'] = !month
      ? 'nur_app'
      : month < recent
        ? 'alt'
        : !al.length
          ? 'nur_fortytools'
          : ftCents === appCents
            ? 'gleich'
            : 'abweichend';
    return {
      site_id: s.id,
      site_no: s.site_no,
      site_name: s.name,
      street: s.street,
      customer_id: s.customer_id,
      customer_no: s.customer_no,
      customer_name: s.customer_name,
      ft_month: month,
      ft_cents: ftCents,
      app_cents: appCents,
      ft_lines: fl,
      app_lines: al,
      status,
    };
  });
}

/** Monatliche Leistungen der gewählten Objekte aus der letzten Fortytools-Monatsrechnung übernehmen. */
export async function applyReconcile(sql: Sql, siteIds: string[], actor: string) {
  const rows = (await reconcileRows(sql)).filter(
    (r) => siteIds.includes(r.site_id) && (r.status === 'abweichend' || r.status === 'nur_fortytools'),
  );
  if (!rows.length) throw new BusinessError('Keine abweichenden Objekte ausgewählt');
  let ended = 0;
  let created = 0;
  await sql.begin(async (tx) => {
    const types = new Map(
      (await tx<{ id: string; name: string }[]>`select id, name from app.service_types`).map((t) => [
        t.name.toLowerCase(),
        t.id,
      ]),
    );
    for (const r of rows) {
      const m = r.ft_month!;
      const off = await tx`
        update app.site_services set active = false, valid_to = greatest(valid_from, ${lastDayOf(m)}::date),
               updated_at = now(), version = version + 1
         where site_id = ${r.site_id} and active and billing_cycle = 'monatlich' returning id`;
      ended += off.length;
      let k = 0;
      for (const l of r.ft_lines) {
        const typeId = l.service_type ? (types.get(l.service_type.toLowerCase()) ?? null) : null;
        const ins = await tx`insert into app.site_services ${tx({
          id: uuidOf(`ft-abgleich:${r.site_id}:${m}:${k++}`),
          site_id: r.site_id,
          kind: 'monthly_flat',
          description: l.title.split('\n')[0]!.slice(0, 200),
          note: l.details,
          unit_code: UNIT[(l.unit ?? '').toLowerCase()] ?? 'LS',
          quantity_milli: l.quantity_milli,
          unit_price_cents: l.unit_price_cents,
          vat_rate_bp: 1900,
          valid_from: firstOfNext(m),
          billing_cycle: 'monatlich',
          service_type_id: typeId,
          cost_center: r.site_no,
        } as Record<
          string,
          unknown
        >)} on conflict (id) do update set active = true, valid_to = null returning id`;
        created += ins.length;
      }
    }
    await tx`insert into app.audit_log (actor, action, entity, details)
             values (${actor}, 'reconcile_fortytools', 'site_services',
                     ${tx.json({ sites: rows.map((r) => [r.site_no, r.ft_month, String(r.ft_cents), String(r.app_cents)]), ended, created } as never)})`;
  });
  return { sites: rows.length, ended, created };
}
