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
  {
    // 306 m² = 162,18 € (Fortytools-Auftragsliste, Ahmed 17.10.); Fläche der Grube am TG-Objekt
    key: 'grube',
    description: 'Mechanische Reinigung der Grube - Tiefgaragenreinigung',
    basis: 'pit',
    unit: 'MTK',
    price: 53n,
  },
] as const;
export type MwKey = (typeof MW_POSITIONS)[number]['key'];

/** Lohnkostenanteil der Tiefgaragen-Leistungen Münchner Wohnen (Ahmed 17.10.: 85 %). */
export const MW_LABOR_PCT = 85;

const qtyFor = (basis: string, sqm: number | null, duplex: number | null, pit: number | null) => {
  const v = basis === 'sqm' ? sqm : basis === 'duplex' ? duplex : pit;
  return v && v > 0 ? v : null;
};

/**
 * Vorhandene Leistung derselben Position erkennen – auch mit anderem Wortlaut aus Fortytools („1. Scheuersaugen“,
 * „3. Scheuersaugen“ = 3. Durchgang, „Mechanische Reinigung der Grube“).
 */
const MATCH: Record<MwKey, RegExp> = {
  scheuer1: /^\s*1\.?\s*scheuersaugen/i,
  scheuer2: /^\s*2\.?\s*scheuersaugen/i,
  kehr3: /^\s*3\.?\s*(kehrsaugen|scheuersaugen)/i,
  duplex1: /^\s*1\.?\s*reinigung\s+duplex/i,
  duplex2: /^\s*2\.?\s*reinigung\s+duplex/i,
  grube: /grube/i,
};
export const matches = (key: MwKey, description: string) => MATCH[key].test(description);

export interface MwPreviewRow {
  objectId: string;
  name: string;
  siteId: string | null;
  siteNo: string | null;
  siteName: string | null;
  sqm: number | null;
  duplex: number | null;
  /** Fläche der Grube (m²) */
  pit: number | null;
  /** Fläche/Duplex stammen aus vorhandenen Leistungen (Fortytools), nicht aus dem TG-Objekt */
  fromServices: boolean;
  positions: { key: MwKey; quantity: number | null; existing: boolean }[];
  problem: string | null;
}

/** Vorschau: alle aktiven TG-Objekte von Münchner Wohnen mit Fläche, Duplex und vorhandenen Leistungen. */
export async function previewMwServices(sql: Sql, objectId?: string): Promise<MwPreviewRow[]> {
  const objs = await sql<
    {
      id: string;
      name: string;
      sqm: number | null;
      spaces_duplex: number | null;
      pit_sqm: number | null;
      site_id: string | null;
      site_no: string | null;
      site_name: string | null;
    }[]
  >`
    select o.id, o.name, o.sqm, o.spaces_duplex, o.pit_sqm, o.site_id, s.site_no, s.name as site_name
      from app.tg_objects o left join app.sites s on s.id = o.site_id
     where o.active and o.customer ilike '%münchner wohnen%'
       and ${objectId ? sql`o.id = ${objectId}` : sql`true`}
     order by o.postal_code nulls last, o.name`;
  const siteIds = objs.map((o) => o.site_id).filter((x): x is string => !!x);
  const svcs = siteIds.length
    ? await sql<
        { id: string; site_id: string; description: string; unit_code: string; quantity_milli: bigint }[]
      >`
        select id, site_id, description, unit_code, quantity_milli from app.site_services
         where site_id in ${sql(siteIds)} and active and (valid_to is null or valid_to >= ${todayBerlin()})`
    : [];
  // Fortytools liefert die Fläche nicht am Objekt – sie steht aber in den übernommenen Rechnungen (Menge der
  // Positionen „1. Scheuersaugen …“ usw.); die jüngste Rechnung zählt
  const billed = siteIds.length
    ? await sql<{ site_id: string; title: string; quantity_milli: bigint }[]>`
        select distinct on (l.site_id, lower(l.title)) l.site_id, l.title, l.quantity_milli
          from app.legacy_invoice_lines l join app.legacy_invoices i on i.id = l.invoice_id
         where l.site_id in ${sql(siteIds)} and l.quantity_milli > 0 and l.title ~* 'saugen|duplex|grube'
         order by l.site_id, lower(l.title), i.issue_date desc`
    : [];
  return objs.map((o): MwPreviewRow => {
    const own = svcs.filter((s) => s.site_id === o.site_id);
    const inv = billed.filter((b) => b.site_id === o.site_id);
    const invQty = (re: RegExp) =>
      inv
        .filter((b) => re.test(b.title))
        .map((b) => Number(b.quantity_milli / 1000n))
        .reduce((m, x) => Math.max(m, x), 0) || null;
    // Fläche/Duplex aus vorhandenen Leistungen, falls am TG-Objekt nichts steht
    const qtyOf = (re: RegExp, unit: string) =>
      own
        .filter((s) => s.unit_code === unit && re.test(s.description))
        .map((s) => Number(s.quantity_milli / 1000n))
        .reduce((m, x) => Math.max(m, x), 0) || null;
    const sqmSvc = qtyOf(/^(?!.*(grube|duplex)).*saugen/i, 'MTK') ?? invQty(/^(?!.*(grube|duplex)).*saugen/i);
    const pitSvc = qtyOf(/grube/i, 'MTK') ?? invQty(/grube/i);
    const duplexSvc = qtyOf(/duplex/i, 'C62') ?? invQty(/duplex/i);
    const sqm = o.sqm ?? sqmSvc;
    const duplex = o.spaces_duplex ?? duplexSvc;
    const pit = o.pit_sqm ?? pitSvc;
    const fromServices =
      (o.sqm == null && sqmSvc != null) ||
      (o.spaces_duplex == null && duplexSvc != null) ||
      (o.pit_sqm == null && pitSvc != null);
    return {
      objectId: o.id,
      name: o.name,
      siteId: o.site_id,
      siteNo: o.site_no,
      siteName: o.site_name,
      sqm,
      duplex,
      pit,
      fromServices,
      positions: MW_POSITIONS.map((p) => ({
        key: p.key,
        quantity: qtyFor(p.basis, sqm, duplex, pit),
        existing: own.some((s) => s.id === uuidOf(`tg-mw:${o.id}:${p.key}`) || matches(p.key, s.description)),
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
  await sql`insert into app.service_types (id, name, sort_order, labor_share_bp)
            values (${id}, 'Tiefgaragenreinigung', 50, ${MW_LABOR_PCT * 100}) on conflict do nothing`;
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
  p: {
    prices: Record<MwKey, bigint>;
    validFrom: string;
    update: boolean;
    /** nur diese Positionen (Standard: alle) */
    keys?: readonly MwKey[];
    /** nur dieses TG-Objekt (Standard: alle von Münchner Wohnen) */
    objectId?: string;
  },
  actor: string,
): Promise<{ created: number; updated: number; skipped: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.validFrom)) throw new BusinessError('Datum „gültig ab“ ungültig');
  for (const pos of MW_POSITIONS)
    if (!(p.prices[pos.key] > 0n)) throw new BusinessError(`Preis für „${pos.description}“ fehlt`);
  const typeId = await tgServiceType(sql);
  const rows = await previewMwServices(sql, p.objectId);
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
                       spaces_duplex = coalesce(spaces_duplex, ${r.duplex}),
                       pit_sqm = coalesce(pit_sqm, ${r.pit}) where id = ${r.objectId}`;
    for (const pos of MW_POSITIONS) {
      if (p.keys && !p.keys.includes(pos.key)) continue;
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
          labor_share: String(MW_LABOR_PCT),
          version: '',
        }),
        actor,
      );
      created++;
    }
  }
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'mw_services', 'tg_objects', null,
                    ${sql.json({ v: MW_VERSION, created, updated, skipped, prices: Object.fromEntries(Object.entries(p.prices).map(([k, v]) => [k, Number(v)])) })})`;
  return { created, updated, skipped };
}

/** Arbeitsschein-Positionen Münchner Wohnen: die Leistungen des Objekts (mit Preis), sonst die Standardpositionen. */
export async function mwWorkReportLines(
  sql: Sql,
  objectId: string,
  siteId: string,
  sqm: number | null,
  duplex: number | null,
  pit: number | null = null,
) {
  const svcs = await sql<{ id: string; description: string; unit_code: string; quantity_milli: bigint }[]>`
    select id, description, unit_code, quantity_milli from app.site_services
     where site_id = ${siteId} and active and (valid_to is null or valid_to >= ${todayBerlin()})`;
  const out: { description: string; quantity: bigint; unitCode: string; serviceId: string | null }[] = [];
  for (const pos of MW_POSITIONS) {
    const qty = qtyFor(pos.basis, sqm, duplex, pit);
    const sv = svcs.find(
      (s) => s.id === uuidOf(`tg-mw:${objectId}:${pos.key}`) || matches(pos.key, s.description),
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

/**
 * Objekte „TG …“/„Tiefgarage …“ von Münchner Wohnen ohne Eintrag unter Disposition → Tiefgaragenreinigung bekommen
 * einen (feste ID, verknüpft mit dem Objekt) – sonst fehlen ihnen die Standard-Leistungen.
 */
export async function ensureMwTgObjects(sql: Sql) {
  const r = await sql`
    insert into app.tg_objects (id, customer, name, address, postal_code, city, object_no, site_id)
    select md5('tg-site:' || s.id::text)::uuid, 'Münchner Wohnen GmbH', s.name, s.street, s.postal_code, s.city,
           s.site_no, s.id
      from app.sites s join app.customers c on c.id = s.customer_id
     where s.active and c.name ilike '%münchner wohnen%' and s.name ~* '^(tg|tiefgarage)\\M'
       and not exists (select 1 from app.tg_objects o where o.site_id = s.id)
    on conflict (id) do nothing returning id`;
  return r.length;
}

/**
 * Stand der Standard-Leistungen: 1 = Scheuer-/Kehrsaugen + Duplex, 2 = zusätzlich Grube (17.10.), 3 = Fläche aus den
 * übernommenen Rechnungen und TG-Objekte für alle „TG …“-Objekte von Münchner Wohnen (Ahmed 17.10.: TG 3 leer).
 */
const MW_VERSION = 3;

/**
 * Beim Start: fehlende Standard-Leistungen anlegen, je Stand nur einmal (Protokoll `mw_services`).
 */
export async function ensureMwServices(
  sql: Sql,
): Promise<{ created: number; updated: number; skipped: number } | null> {
  const [last] = await sql<{ v: number }[]>`
    select coalesce(max((details->>'v')::int), 1) as v from app.audit_log where action = 'mw_services'
    having count(*) > 0`;
  if (last && last.v >= MW_VERSION) return null;
  await ensureMwTgObjects(sql);
  // Lohnkostenanteil 85 % für alle Tiefgaragen-Leistungen der MW-Objekte (auch die aus Fortytools übernommenen)
  await sql`update app.site_services s set labor_share_bp = ${MW_LABOR_PCT * 100}, updated_at = now()
             from app.tg_objects o
            where o.site_id = s.site_id and o.customer ilike '%münchner wohnen%'
              and s.description ilike '%tiefgarage%' and s.labor_share_bp is distinct from ${MW_LABOR_PCT * 100}`;
  const prices = Object.fromEntries(MW_POSITIONS.map((p) => [p.key, p.price])) as Record<MwKey, bigint>;
  return applyMwServices(sql, { prices, validFrom: '2026-01-01', update: false }, 'automatisch');
}

/** Nach dem Speichern eines TG-Objekts (z. B. Grube-Fläche nachgetragen): fehlende Leistungen dieses Objekts anlegen. */
export async function ensureMwServicesFor(sql: Sql, objectId: string, actor: string) {
  const prices = Object.fromEntries(MW_POSITIONS.map((p) => [p.key, p.price])) as Record<MwKey, bigint>;
  return applyMwServices(sql, { prices, validFrom: '2026-01-01', update: false, objectId }, actor);
}
