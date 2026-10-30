import type { Sql } from '../db/client.js';
import { uuidOf } from './fortytools-export-import.js';
import { saveService, serviceInput } from './masterdata.js';

/**
 * Gemeinde Planegg, Los 9 Glasreinigung (Kalkulationsdatei Stand 03.12.25, Preisblatt; Ahmed 30.10.): je Gebäude eine
 * Leistung „Glasreinigung“, halbjährlich, Abrechnung nach Ausführung (Leistungen verrichten). Preis je Ausführung =
 * Jahrespreis laut Preisblatt ÷ 2, kaufmännisch auf Cent (aus dem ungerundeten Wert der Datei). Ausführungsbeginn laut
 * Preisblatt 01.08.2026. Zuordnung über Straße + Hausnummer des Objekts beim Kunden 20022.
 */
export const PLANEGG_GLASS = [
  { key: 'a', street: 'Pasingerstr. 20a', name: 'Josefstift, Verwaltung Kiga und Krippe', cents: 37311n },
  { key: 'b', street: 'Josef-von-Hirsch-Str. 3a', name: 'Kindergarten Würmeulen', cents: 16960n },
  { key: 'c', street: 'Pasingerstr. 18', name: 'Mensagebäude mit Kindergarten im OG', cents: 42447n },
  { key: 'd', street: 'Pasingerstr. 8a', name: 'Kinderhort Planegg', cents: 27592n },
  { key: 'e', street: 'Bräuhausstr. 1', name: 'Jugendtreff Waaghäusl', cents: 15245n },
  { key: 'f', street: 'Pasingerstr. 8', name: 'Rathaus', cents: 145720n },
  { key: 'g', street: 'Planeggerstr. 14', name: 'Feuerwehrhaus Martinsried', cents: 18320n },
  { key: 'h', street: 'Pasingerstr. 24a', name: 'Feuerwehrhaus Planegg', cents: 56269n },
  { key: 'i', street: 'Pasingerstr. 22', name: 'Betriebshof u. Archiv', cents: 13398n },
  { key: 'j', street: 'Fürstenriederstr. 17', name: 'Friedhofsgebäude', cents: 13648n },
  { key: 'k', street: 'Im Grund 24', name: 'Bauhof', cents: 13358n },
  { key: 'l', street: 'Feodor-Lynen-Str. 5', name: 'Kupferhaus', cents: 75784n },
  { key: 'm', street: 'Pasingerstr. 14', name: 'Büchereigebäude', cents: 92166n },
  { key: 'n', street: 'Pasingerstr. 25', name: 'Obdachlosenunterkunft', cents: 2595n },
  { key: 'o', street: 'Josef-von-Hirsch-Str. 3', name: 'Grundschule Planegg', cents: 124437n },
  { key: 'p', street: 'Einsteinstr. 13', name: 'Grundschule Martinsried', cents: 121289n },
  { key: 'q', street: 'Pasingerstr. 16', name: 'Musikschule Planegg-Krailling', cents: 19786n },
  { key: 'r', street: 'Feodor-Lynen-Str. 3', name: 'Dreifachturnhalle I', cents: 91001n },
  { key: 's', street: 'Feodor-Lynen-Str. 3a', name: 'Dreifachturnhalle II', cents: 107794n },
] as const;

export const PLANEGG_VALID_FROM = '2026-08-01';

/** „Pasinger Straße 20 a“ = „Pasingerstr. 20a“ */
export const normStreet = (s: string | null) =>
  (s ?? '')
    .toLowerCase()
    .replace(/straße|strasse/g, 'str')
    .replace(/[\s.-]/g, '');

const euro = (c: bigint) => `${c / 100n},${String(c % 100n).padStart(2, '0')}`;

/** Einmalig (Protokoll `planegg_glass`): fehlende Glasreinigungs-Leistungen anlegen; nichts doppelt (feste IDs). */
export async function ensurePlaneggGlass(sql: Sql, actor = 'automatisch') {
  const [done] = await sql`select 1 from app.audit_log where action = 'planegg_glass' limit 1`;
  if (done) return null;
  const sites = await sql<{ id: string; name: string; street: string | null }[]>`
    select s.id, s.name, s.street from app.sites s join app.customers c on c.id = s.customer_id
     where s.active and (c.customer_no = '20022' or c.name ilike 'gemeinde planegg%')`;
  if (!sites.length) return null; // Kunde (noch) nicht da – beim nächsten Start erneut
  const [t] = await sql<{ id: string; labor_share_bp: number | null }[]>`
    select id, labor_share_bp from app.service_types where lower(name) = 'glasreinigung' order by sort_order limit 1`;
  const created: string[] = [];
  const missing: string[] = [];
  const existing: string[] = [];
  for (const g of PLANEGG_GLASS) {
    const site = sites.find((s) => normStreet(s.street) === normStreet(g.street));
    if (!site) {
      missing.push(`${g.key} ${g.name}`);
      continue;
    }
    const id = uuidOf(`planegg-glas:${site.id}`);
    const [have] = await sql`
      select 1 from app.site_services where site_id = ${site.id} and active
         and (id = ${id} or (description ilike 'glasreinigung%' and billing_cycle = 'halbjaehrlich'))`;
    if (have) {
      existing.push(site.name);
      continue;
    }
    await saveService(
      sql,
      id,
      site.id,
      serviceInput.parse({
        description: 'Glasreinigung',
        unit_code: 'LS',
        quantity: '1',
        unit_price: euro(g.cents),
        vat_rate_bp: '1900',
        valid_from: PLANEGG_VALID_FROM,
        billing_cycle: 'halbjaehrlich',
        bill_mode: 'ausfuehrung',
        service_type_id: t?.id ?? '',
        labor_share: t?.labor_share_bp != null ? String(t.labor_share_bp / 100) : '',
        version: '',
      }),
      actor,
    );
    created.push(site.name);
  }
  await sql`insert into app.audit_log (actor, action, entity, entity_id, details)
            values (${actor}, 'planegg_glass', 'site_services', null,
                    ${sql.json({ created, existing, missing })})`;
  return { created: created.length, existing: existing.length, missing };
}
