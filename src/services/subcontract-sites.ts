/**
 * Sammelbestellung an Nachunternehmer (Ahmed 19.10.): eine Bestellung für mehrere Objekte (z. B. alle Tiefgaragen
 * eines Kunden). Kosten je Objekt:
 * - „je m²“ (billing qm): Preis je m² × Fläche des Objekts,
 * - Pauschale: nach Fläche verteilt,
 * - „Anteil am Umsatz“ (billing umsatz): unser Netto-Erlös des Objekts im Monat × (100 % − unsere Marge).
 * Fehlt die Fläche, wird gleichmäßig verteilt. Aufteilung immer centgenau (größter Rest).
 */
import type { Sql, Tx } from '../db/client.js';

type Db = Sql | Tx;
import { BusinessError } from './errors.js';

export interface SammelSite {
  site_id: string;
  site_no: string;
  name: string;
  street: string | null;
  city: string | null;
  customer_name: string;
  sqm: string | null;
  /** fester Betrag je Objekt (netto, Cent) – geht bei Pauschalen vor der Fläche */
  share_cents: string | null;
  /** Vorschlag aus Tiefgaragen-Stammdaten bzw. Raumbuch */
  sqm_hint: string | null;
}

/** m² als ganze Hundertstel (kein Gleitkomma) */
export const sqmCenti = (v: string | null | undefined): bigint | null => {
  if (v === null || v === undefined || v === '') return null;
  const m = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(
    String(v)
      .trim()
      .replace(/\.(?=\d{3}(\D|$))/g, ''),
  );
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
};

/** Betrag centgenau nach Gewichten aufteilen (größter Rest); ohne Gewichte gleichmäßig. */
export function splitByWeights(total: bigint, weights: bigint[]): bigint[] {
  if (!weights.length) return [];
  const w = weights.some((x) => x > 0n) ? weights.map((x) => (x > 0n ? x : 0n)) : weights.map(() => 1n);
  const sum = w.reduce((a, x) => a + x, 0n);
  const neg = total < 0n;
  const t = neg ? -total : total;
  const base = w.map((x) => (t * x) / sum);
  let rest = t - base.reduce((a, x) => a + x, 0n);
  const order = w
    .map((x, i) => ({ i, r: (t * x) % sum }))
    .sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (const o of order) {
    if (rest <= 0n) break;
    base[o.i]! += 1n;
    rest -= 1n;
  }
  return neg ? base.map((x) => -x) : base;
}

const sqmHint = (sql: Sql) => sql`coalesce(
  (select sum(t.sqm)::numeric(12,2)::text from app.tg_objects t where t.site_id = s.id and t.active),
  (select (sum(r.area_centi) / 100.0)::numeric(12,2)::text from app.rooms r where r.site_id = s.id and r.active))`;

/** Objekte der Sammelbestellung (nur dieser Bestellung) */
export async function subcontractSites(sql: Sql, id: string): Promise<SammelSite[]> {
  return sql<SammelSite[]>`
    select x.site_id, s.site_no, s.name, s.street, s.city, c.name as customer_name, x.sqm::text as sqm,
           x.share_cents::text as share_cents, ${sqmHint(sql)} as sqm_hint
      from app.subcontract_sites x join app.sites s on s.id = x.site_id join app.customers c on c.id = s.customer_id
     where x.subcontract_id = ${id}
     order by s.site_no`;
}

async function assertEditable(tx: Tx, id: string) {
  const [sc] = await tx<{ status: string; site_id: string }[]>`
    select status, site_id from app.subcontracts where id = ${id} for update`;
  if (!sc) throw new BusinessError('Bestellung nicht gefunden');
  if (sc.status === 'storniert') throw new BusinessError('Stornierte Bestellung kann nicht geändert werden');
  return sc;
}

/** Objekte hinzufügen (einzeln oder alle aktiven eines Kunden); Fläche aus Tiefgarage/Raumbuch vorbelegt. */
export async function addSubcontractSites(
  sql: Sql,
  id: string,
  p: { siteIds?: string[]; customerId?: string | null },
  actor: string,
) {
  return sql.begin(async (tx) => {
    const sc = await assertEditable(tx, id);
    const ids = new Set(p.siteIds ?? []);
    if (p.customerId)
      for (const r of await tx<{ id: string }[]>`
        select id from app.sites where customer_id = ${p.customerId} and active`)
        ids.add(r.id);
    // die Hauptobjekt-Zeile gehört immer dazu
    ids.add(sc.site_id);
    if (!ids.size) return 0;
    const added = await tx`
      insert into app.subcontract_sites (subcontract_id, site_id, sqm, created_by)
      select ${id}, s.id,
             coalesce((select sum(t.sqm) from app.tg_objects t where t.site_id = s.id and t.active),
                      (select sum(r.area_centi) / 100.0 from app.rooms r where r.site_id = s.id and r.active))::numeric(12,2),
             ${actor}
        from app.sites s where s.id = any(${[...ids]}::uuid[])
      on conflict do nothing returning site_id`;
    if (added.length)
      await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
               values (${actor}, 'sites_add', 'subcontract', ${id}, ${tx.json({ sites: added.map((r) => r.site_id as string) })})`;
    return added.length;
  });
}

/** Flächen speichern und Objekte entfernen (Hauptobjekt bleibt; fällt es weg, wird das nächste Hauptobjekt). */
export async function saveSubcontractSites(
  sql: Sql,
  id: string,
  rows: { siteId: string; sqm: string; share?: bigint | null | undefined; remove: boolean }[],
  actor: string,
) {
  await sql.begin(async (tx) => {
    const sc = await assertEditable(tx, id);
    const before =
      await tx`select site_id, sqm::text from app.subcontract_sites where subcontract_id = ${id}`;
    for (const r of rows) {
      if (r.remove) {
        await tx`delete from app.subcontract_sites where subcontract_id = ${id} and site_id = ${r.siteId}`;
        continue;
      }
      const c = r.sqm.trim() === '' ? null : sqmCenti(r.sqm);
      if (r.sqm.trim() !== '' && c === null) throw new BusinessError(`Fläche „${r.sqm}“ ungültig`);
      await tx`update app.subcontract_sites set sqm = ${c === null ? null : (Number(c) / 100).toFixed(2)}
                where subcontract_id = ${id} and site_id = ${r.siteId}`;
      if (r.share !== undefined)
        await tx`update app.subcontract_sites set share_cents = ${r.share}
                  where subcontract_id = ${id} and site_id = ${r.siteId}`;
    }
    const left = await tx<{ site_id: string }[]>`
      select x.site_id from app.subcontract_sites x join app.sites s on s.id = x.site_id
       where x.subcontract_id = ${id} order by s.site_no`;
    if (left.length && !left.some((l) => l.site_id === sc.site_id))
      await tx`update app.subcontracts set site_id = ${left[0]!.site_id} where id = ${id}`;
    // nur noch ein Objekt → wieder normale Bestellung
    if (left.length === 1) await tx`delete from app.subcontract_sites where subcontract_id = ${id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'sites_update', 'subcontract', ${id}, ${tx.json({ vorher: before as never })})`;
  });
}

/** Netto-Erlös je Objekt in einem Monat (eigene + übernommene Rechnungen, Leistungszeitraum sonst Rechnungsdatum). */
export async function siteRevenueMonth(
  sql: Db,
  siteIds: string[],
  month: string,
): Promise<Map<string, bigint>> {
  const from = `${month}-01`;
  const out = new Map<string, bigint>();
  if (!siteIds.length) return out;
  const rows = await sql<{ site_id: string; net: bigint }[]>`
    select site_id, sum(net)::bigint as net from (
      select coalesce(ss.site_id, i.site_id) as site_id, l.net_cents as net
        from app.invoices i join app.invoice_lines l on l.invoice_id = i.id
        left join app.site_services ss on ss.id = l.source_service_id
       where i.status = 'issued' and coalesce(ss.site_id, i.site_id) = any(${siteIds}::uuid[])
         and date_trunc('month', coalesce(i.period_start, i.issue_date)) = ${from}::date
      union all
      select l.site_id, l.net_cents
        from app.legacy_invoice_lines l join app.legacy_invoices i on i.id = l.invoice_id
       where l.site_id = any(${siteIds}::uuid[])
         and date_trunc('month', coalesce(l.period_start, i.issue_date)) = ${from}::date
    ) x group by site_id`;
  for (const r of rows) out.set(r.site_id, BigInt(r.net));
  return out;
}

/** Gewichte für Pauschalen: fester Betrag je Objekt, sonst Fläche */
const flatWeights = (sites: { sqm: string | null; share_cents: string | null }[]) =>
  sites.some((s) => s.share_cents !== null && BigInt(s.share_cents) > 0n)
    ? sites.map((s) => BigInt(s.share_cents ?? '0'))
    : sites.map((s) => sqmCenti(s.sqm) ?? 0n);

/**
 * Netto einer NU-Rechnung (oder einer Schätzung) auf die Objekte einer Sammelbestellung verteilen.
 * null = keine Sammelbestellung.
 */
export async function allocateSammel(
  sql: Db,
  subcontractId: string,
  month: string,
  net: bigint,
): Promise<{ site_id: string; net: bigint }[] | null> {
  const [sc] = await sql<
    { billing: string }[]
  >`select billing from app.subcontracts where id = ${subcontractId}`;
  const sites = await sql<{ site_id: string; sqm: string | null; share_cents: string | null }[]>`
    select x.site_id, x.sqm::text as sqm, x.share_cents::text as share_cents
      from app.subcontract_sites x join app.sites s on s.id = x.site_id
     where x.subcontract_id = ${subcontractId} order by s.site_no`;
  if (!sc || sites.length < 2) return null;
  let weights: bigint[];
  if (sc.billing === 'umsatz') {
    const rev = await siteRevenueMonth(
      sql,
      sites.map((s) => s.site_id),
      month,
    );
    weights = sites.map((s) => rev.get(s.site_id) ?? 0n);
    if (!weights.some((w) => w > 0n)) weights = sites.map((s) => sqmCenti(s.sqm) ?? 0n);
  } else if (sc.billing === 'qm') weights = sites.map((s) => sqmCenti(s.sqm) ?? 0n);
  else weights = flatWeights(sites);
  const parts = splitByWeights(net, weights);
  return sites.map((s, i) => ({ site_id: s.site_id, net: parts[i]! }));
}

/**
 * Erwartete Kosten je Objekt für einen Monat (Schätzung, solange keine NU-Rechnung gebucht ist).
 * qm: Preis × Fläche; Pauschale je Monat: nach Fläche; umsatz: Erlös × (1 − Marge).
 */
export async function sammelMonthCost(
  sql: Sql,
  sc: { id: string; billing: string; price_cents: bigint; margin_bp: number | null },
  month: string,
): Promise<{ site_id: string; cost: bigint }[]> {
  const sites = await sql<{ site_id: string; sqm: string | null; share_cents: string | null }[]>`
    select x.site_id, x.sqm::text as sqm, x.share_cents::text as share_cents
      from app.subcontract_sites x join app.sites s on s.id = x.site_id
     where x.subcontract_id = ${sc.id} order by s.site_no`;
  if (!sites.length) return [];
  if (sc.billing === 'qm')
    return sites.map((s) => ({
      site_id: s.site_id,
      // Preis je m² (Cent) × m²-Hundertstel / 100, kaufmännisch gerundet
      cost: (BigInt(sc.price_cents) * (sqmCenti(s.sqm) ?? 0n) * 2n + 100n) / 200n,
    }));
  if (sc.billing === 'umsatz') {
    const rev = await siteRevenueMonth(
      sql,
      sites.map((s) => s.site_id),
      month,
    );
    const keep = BigInt(10000 - (sc.margin_bp ?? 0));
    return sites.map((s) => {
      const r = rev.get(s.site_id) ?? 0n;
      return { site_id: s.site_id, cost: (r * keep * 2n + 10000n) / 20000n };
    });
  }
  if (sc.billing === 'pauschale_monat') {
    const parts = splitByWeights(BigInt(sc.price_cents), flatWeights(sites));
    return sites.map((s, i) => ({ site_id: s.site_id, cost: parts[i]! }));
  }
  return [];
}

/** Gesamtfläche der Sammelbestellung in m²-Hundertsteln (für „Preis je m² × Fläche“). */
export async function sammelSqmCenti(sql: Sql, ids: string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (!ids.length) return out;
  for (const r of await sql<{ id: string; c: string | null }[]>`
    select subcontract_id as id, (sum(sqm) * 100)::bigint::text as c from app.subcontract_sites
     where subcontract_id = any(${ids}::uuid[]) group by subcontract_id`)
    out.set(r.id, BigInt(r.c ?? '0'));
  return out;
}
