/**
 * Sicherheitsdatenblätter (SDB) der eingesetzten Reinigungsmittel (Ahmed 14.10.). Firmenweit unter Einstellungen →
 * Objektordner-Vorlagen hochgeladen, liegen automatisch in jedem Objektordner (PDF und ZIP) und als eigener Druck.
 * § 14 GefStoffV: Die Beschäftigten müssen Zugang zu den Sicherheitsdatenblättern haben. Die Hersteller aktualisieren
 * SDB laufend – deshalb Hinweis, wenn eine Fassung älter als 3 Jahre ist.
 */
import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';
import type { Deps } from './workflow.js';

export interface SafetySheet {
  id: string;
  product: string;
  manufacturer: string | null;
  issued_on: string | null;
  storage_path: string;
  file_name: string;
  uploaded_by: string;
  uploaded_at: Date;
}

export async function listSafetySheets(sql: Sql): Promise<SafetySheet[]> {
  return sql<SafetySheet[]>`
    select id, product, manufacturer, to_char(issued_on, 'YYYY-MM-DD') as issued_on, storage_path, file_name,
           uploaded_by, uploaded_at
      from app.safety_data_sheets where active order by lower(product)`;
}

/** Fassung älter als 3 Jahre → beim Lieferanten die aktuelle anfordern. */
export const sheetOutdated = (issued: string | null, today: string) =>
  !!issued && issued < `${Number(today.slice(0, 4)) - 3}${today.slice(4)}`;

export async function saveSafetySheet(
  deps: Deps,
  input: { product: string; manufacturer?: string; issuedOn?: string; bytes: Uint8Array; fileName: string },
  actor: string,
) {
  const product = input.product.trim();
  if (!product) throw new BusinessError('Produktname fehlt');
  if (input.bytes.length > 20 * 1024 * 1024) throw new BusinessError('Datei zu groß (höchstens 20 MB)');
  if (strHead(input.bytes) !== '%PDF')
    throw new BusinessError('Bitte das Sicherheitsdatenblatt als PDF hochladen');
  try {
    await PDFDocument.load(input.bytes, { ignoreEncryption: true });
  } catch {
    throw new BusinessError('PDF lässt sich nicht lesen');
  }
  const issued = input.issuedOn?.trim() || null;
  if (issued && !/^\d{4}-\d{2}-\d{2}$/.test(issued)) throw new BusinessError('Datum der Fassung ungültig');
  const sha = createHash('sha256').update(input.bytes).digest('hex');
  const path = `sicherheitsdatenblaetter/${sha}.pdf`;
  try {
    await deps.archive.put(path, input.bytes);
  } catch {
    /* gleiche Datei schon im Archiv (write-once) */
  }
  const id = randomUUID();
  await deps.sql.begin(async (tx) => {
    // gleiches Produkt: neue Fassung ersetzt die alte (alte bleibt erhalten)
    await tx`update app.safety_data_sheets set active = false, replaced_at = now()
              where active and lower(trim(product)) = lower(${product})`;
    await tx`insert into app.safety_data_sheets
               (id, product, manufacturer, issued_on, storage_path, sha256, file_name, uploaded_by)
             values (${id}, ${product.slice(0, 200)}, ${input.manufacturer?.trim() || null}, ${issued}, ${path},
                     ${sha}, ${input.fileName.slice(0, 200)}, ${actor})`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'sdb_hochgeladen', 'safety_data_sheet', ${id}, ${tx.json({ produkt: product })})`;
  });
  return id;
}

export async function removeSafetySheet(sql: Sql, id: string, actor: string) {
  const [r] = await sql`update app.safety_data_sheets set active = false, replaced_at = now()
                         where id = ${id} and active returning id`;
  if (!r) throw new BusinessError('Sicherheitsdatenblatt nicht gefunden');
  await sql`insert into app.audit_log (actor, action, entity, entity_id)
            values (${actor}, 'sdb_entfernt', 'safety_data_sheet', ${id})`;
}

export async function safetySheetFile(deps: Deps, id: string) {
  const [s] = await deps.sql<{ storage_path: string; product: string }[]>`
    select storage_path, product from app.safety_data_sheets where id = ${id}`;
  if (!s) throw new BusinessError('Sicherheitsdatenblatt nicht gefunden');
  return { bytes: await deps.archive.get(s.storage_path), name: `SDB_${safeName(s.product)}.pdf` };
}

/** Alle aktuellen SDB in einer PDF (zum Drucken für den Objektordner). */
export async function safetySheetsPdf(deps: Deps): Promise<Uint8Array | null> {
  const list = await listSafetySheets(deps.sql);
  if (!list.length) return null;
  const out = await PDFDocument.create();
  out.setTitle('Sicherheitsdatenblätter');
  for (const s of list) {
    try {
      const src = await PDFDocument.load(await deps.archive.get(s.storage_path), { ignoreEncryption: true });
      for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
    } catch {
      /* nicht lesbares PDF überspringen */
    }
  }
  return out.getPageCount() ? out.save() : null;
}

export const safeName = (s: string) =>
  s
    .replace(/[^\p{L}\p{N}._ -]+/gu, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'Produkt';

const strHead = (b: Uint8Array) => String.fromCharCode(...b.slice(0, 4));
