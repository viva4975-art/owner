import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { BusinessError } from './errors.js';
import { uuidOf } from './fortytools-export-import.js';
import { saveService, serviceInput } from './masterdata.js';

/**
 * Münchner Wohnen: Tiefgaragenreinigung immer mit drei Leistungen nach Fläche (1./2. Scheuersaugen, 3. Kehrsaugen),
 * dazu bei Duplex-Stellplätzen zwei Duplex-Leistungen je Stellplatz (Ahmed 17.10., Fortytools-Bild). Preise je m² bzw.
 * Stellplatz aus der Fortytools-Liste (2.400 m²: 1.128,00 / 624,00 / 768,00 €; 17 Duplex: 89,59 / 35,87 €) –
 * einmalig beim Start angelegt (`ensureMwServices`), danach je Leistung am Objekt änderbar.
 */
export const MW_POSITIONS = [
  {
    key: 'scheuer1',
    description: '1. Scheuersaugen - Tiefgaragenreinigung',
    basis: 'sqm',
    unit: 'MTK',
    price: 47n,
  },
  {
    key: 'scheuer2',
    description: '2. Scheuersaugen - Tiefgaragenreinigung',
    basis: 'sqm',
    unit: 'MTK',
    price: 26n,
  },
  {
    key: 'kehr3',
    description: '3. Kehrsaugen - Tiefgaragenreinigung',
    basis: 'sqm',
    unit: 'MTK',
    price: 32n,
  },
  {
    key: 'duplex1',
    description: '1. Reinigung Duplex - Tiefgaragenreinigung',
    basis: 'duplex',
    unit: 'C62',
    price: 527n,
  },
  {
    key: 'duplex2',
    description: '2. Reinigung Duplex - Tiefgaragenreinigung',
    basis: 'duplex',
    unit: 'C62',
    price: 211n,
  },
] as const;
export type MwKey = (typeof MW_POSITIONS)[number]['key'];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '');

export interface MwPreviewRow {
  objectId: string;
  name: string;
  siteId: string | null;
  siteNo: string | null;
  siteName: string | null;
  sqm: number | null;
  duplex: number | null;
  /** Fläche/Duplex stammen aus vorhandenen Leistungen (Fortytools), nicht aus dem TG-Objekt */
  fromServices: boolean;
  positions: { key: MwKey; quantity: number | null; existing: boolean }[];
  problem: string | null;
}

/** Vorschau: alle aktiven TG-Objekte von Münchner Wohnen mit Fläche, Duplex und vorhandenen Leistungen. */
export async function previewMwServices(sql: Sql): Promise<MwPreviewRow[]> {
  const objs = await sql<
    {
      id: string;
      name: string;
      sqm: number | null;
      spaces_duplex: number | null;
      site_id: string | null;
      site_no: string | null;
      site_name: string | null;
    }[]
  >`
    select o.id, o.name, o.sqm, o.spaces_duplex, o.site_id, s.site_no, s.name as site_name
      from app.tg_objects o left join app.sites s on s.id = o.site_id
     where o.active and o.customer ilike '%münchner wohnen%'
     order by o.postal_code nulls last, o.name`;
  const siteIds = objs.map((o) => o.site_id).filter((x): x is string => !!x);
  const svcs = siteIds.length
    ? await sql<
        { id: string; site_id: string; description: string; unit_code: string; quantity_milli: bigint }[]
      >`
        select id, site_id, description, unit_code, quantity_milli from app.site_services
         where site_id in ${sql(siteIds)} and active and (valid_to is null or valid_to >= ${todayBerlin()})`
    : [];
  return objs.map((o): MwPreviewRow => {
    const own = svcs.filter((s) => s.site_id === o.site_id);
    // Fläche/Duplex aus vorhandenen Leistungen, falls am TG-Objekt nichts steht
    const qtyOf = (re: RegExp, unit: string) =>
      own
        .filter((s) => s.unit_code === unit && re.test(s.description))
        .map((s) => Number(s.quantity_milli / 1000n))
        .reduce((m, x) => Math.max(m, x), 0) || null;
    const sqmSvc = qtyOf(/saugen|tiefgarage/i, 'MTK');
    const duplexSvc = qtyOf(/duplex/i, 'C62');
    const sqm = o.sqm ?? sqmSvc;
    const duplex = o.spaces_duplex ?? duplexSvc;
    const fromServices = (o.sqm == null && sqmSvc != null) || (o.spaces_duplex == null && duplexSvc != null);
    return {
      objectId: o.id,
      name: o.name,
      siteId: o.site_id,
      siteNo: o.site_no,
      siteName: o.site_name,
      sqm,
      duplex,
      fromServices,
      positions: MW_POSITIONS.map((p) => ({
        key: p.key,
        quantity: p.basis === 'sqm' ? sqm : duplex && duplex > 0 ? duplex : null,
        existing: own.some(
          (s) => s.id === uuidOf(`tg-mw:${o.id}:${p.key}`) || norm(s.description) === norm(p.description),
        ),
      })),
      problem: !o.site_id ? 'kein Objekt (Kostenstelle) verknüpft' : !sqm ? 'Fläche (m²) fehlt' : null,
    };
  });
}

async function tgServiceType(sql: Sql): Promise<string> {
  const [t] = await sql<{ id: string }[]>`
    select id from app.service_types where lower(name) = 'tiefgaragenreinigung' limit 1`;
  if (t) return t.id;
  const id = uuidOf('service-type:tiefgaragenreinigung');
  await sql`insert into app.service_types (id, name, sort_order) values (${id}, 'Tiefgaragenreinigung', 50)
            on conflict do nothing`;
  return id;
}

const euro = (cents: bigint) => `${cents / 100n},${String(cents % 100n).padStart(2, '0')}`;

/**
 * Leistungen anlegen (je Ausführung, 19 %): feste ID je TG-Objekt + Position → doppelt ausführen legt nichts doppelt
 * an. Gibt es schon eine gleichnamige Leistung (z. B. aus Fortytools), wird nichts angelegt. Mit `update` werden
 * die von hier angelegten Leistungen auf Menge/Preis gesetzt. Fläche/Duplex werden am TG-Objekt ergänzt, falls leer.
 */
export async function applyMwServices(
  sql: Sql,
  p: { prices: Record<MwKey, bigint>; validFrom: string; update: boolean },
  actor: string,
): Promise<{ created: number; updated: number; skipped: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.validFrom)) throw new BusinessError('Datum „gültig ab“ ungültig');
  for (const pos of MW_POSITIONS)
    if (!(p.prices[pos.key] > 0n)) throw new BusinessError(`Preis für „${pos.description}“ fehlt`);
  const typeId = await tgServiceType(sql);
  const rows = await previewMwServices(sql);
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const r of rows) {
    if (r.problem || !r.siteId) {
      skipped++;
      continue;
    }
    if (r.fromServices)
      await sql`update app.tg_objects set sqm = coalesce(sqm, ${r.sqm}),
                       spaces_duplex = coalesce(spaces_duplex, ${r.duplex}) where id = ${r.objectId}`;
    for (const pos of MW_POSITIONS) {
      const q = r.positions.find((x) => x.key === pos.key)!;
      if (!q.quantity) continue;
      const id = uuidOf(`tg-mw:${r.objectId}:${pos.key}`);
      const [mine] = await sql`select 1 from app.site_services where id = ${id}`;
      if (mine) {
        if (p.update) {
          await sql`update app.site_services set quantity_milli = ${BigInt(q.quantity) * 1000n},
                           unit_price_cents = ${p.prices[pos.key]}, updated_at = now() where id = ${id}`;
          updated++;
        }
        continue;
      }
      if (q.existing) continue; // gleichnamige Leistung schon vorhanden (z. B. aus Fortytools)
      await saveService(
        sql,
        id,
        r.siteId,
        serviceInput.parse({
          description: pos.description,
          unit_code: pos.unit,
          quantity: String(q.quantity),
          unit_price: euro(p.prices[pos.key]),
          vat_rate_bp: '1900',
          valid_from: p.validFrom,
          billing_cycle: 'je_ausfuehrung',
          service_type_id: typeId,
          version: '',
        }),
        actor,
      );
      created++;
    }
  }
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'mw_services', 'tg_objects', null,
                    ${sql.json({ created, updated, skipped, prices: Object.fromEntries(Object.entries(p.prices).map(([k, v]) => [k, Number(v)])) })})`;
  return { created, updated, skipped };
}

/** Arbeitsschein-Positionen Münchner Wohnen: die Leistungen des Objekts (mit Preis), sonst die Standardpositionen. */
export async function mwWorkReportLines(
  sql: Sql,
  objectId: string,
  siteId: string,
  sqm: number | null,
  duplex: number | null,
) {
  const svcs = await sql<{ id: string; description: string; unit_code: string; quantity_milli: bigint }[]>`
    select id, description, unit_code, quantity_milli from app.site_services
     where site_id = ${siteId} and active and (valid_to is null or valid_to >= ${todayBerlin()})`;
  const out: { description: string; quantity: bigint; unitCode: string; serviceId: string | null }[] = [];
  for (const pos of MW_POSITIONS) {
    const qty = pos.basis === 'sqm' ? sqm : duplex;
    const sv = svcs.find(
      (s) => s.id === uuidOf(`tg-mw:${objectId}:${pos.key}`) || norm(s.description) === norm(pos.description),
    );
    if (sv)
      out.push({
        description: sv.description,
        quantity: sv.quantity_milli,
        unitCode: sv.unit_code,
        serviceId: sv.id,
      });
    else if (qty && qty > 0)
      out.push({
        description: pos.description,
        quantity: BigInt(qty) * 1000n,
        unitCode: pos.unit,
        serviceId: null,
      });
  }
  return out;
}

/** Einmalig beim Start: Leistungen mit den Standardpreisen anlegen, falls noch nie geschehen (Protokoll `mw_services`). */
export async function ensureMwServices(
  sql: Sql,
): Promise<{ created: number; updated: number; skipped: number } | null> {
  const [done] = await sql`select 1 from app.audit_log where action = 'mw_services' limit 1`;
  if (done) return null;
  const prices = Object.fromEntries(MW_POSITIONS.map((p) => [p.key, p.price])) as Record<MwKey, bigint>;
  return applyMwServices(sql, { prices, validFrom: '2026-01-01', update: false }, 'automatisch');
}
