import { createHash } from 'node:crypto';
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { FormDoc } from '../pdf/form-doc.js';
import { BusinessError } from './errors.js';
import { frequencyLabel, listRooms } from './facility.js';
import { uuidOf } from './fortytools-export-import.js';
import { archiveLink, storeFile, type UploadConfig } from './uploads.js';

/*
 * Raumbuch als PDF (Ahmed 11.10.: „in die Dokumente soll eine PDF mit unserem Logo rein – Raumbuch für Objekte“).
 * A4 quer, nur Logo (Ahmed 19.11.: „wie die Excel“): Kopf mit Kunde/Objekt/Stand, eine Tabelle aller Räume (Gebäudeteil,
 * Etage, Nr., Raum, Nutzungsart, Belag, Fläche, Intervall, Hinweise) mit Summe, danach Übersicht je Nutzungsart. Beim Import und auf Knopfdruck wird es unter Objekt → Dokumente (Kategorie „Raumbuch“) abgelegt;
 * ein älteres, von der App erzeugtes Raumbuch-PDF wandert dort ins Archiv (Datei bleibt write-once).
 */

const m2 = (centi: bigint | number) =>
  (Number(centi) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function renderRoomBookPdf(sql: Sql, siteId: string): Promise<Uint8Array> {
  const [s] = await sql<
    { name: string; site_no: string; address: string; customer_name: string; customer_no: string | null }[]
  >`
    select s.name, s.site_no, concat_ws(', ', s.street, concat_ws(' ', s.postal_code, s.city)) as address,
           c.name as customer_name, c.customer_no
      from app.sites s join app.customers c on c.id = s.customer_id where s.id = ${siteId}`;
  if (!s) throw new BusinessError('Objekt nicht gefunden');
  const rooms = await listRooms(sql, siteId);
  if (!rooms.length) throw new BusinessError('Das Raumbuch ist leer');
  const today = todayBerlin();
  const total = rooms.reduce((a, r) => a + BigInt(r.area_centi), 0n);
  const d = await FormDoc.create({
    title: `Raumbuch ${s.name}`,
    sideRef: `Raumbuch ${s.name} (${s.site_no}) · Stand ${formatDateDe(today)}`,
    date: today,
    author: 'Viva-Deluxe Gebäudereinigung GmbH',
    plain: true,
    landscape: true,
  });
  d.title('Raumbuch', s.site_no);
  d.infoGrid([
    ['Kunde', `${s.customer_name}${s.customer_no ? ` (${s.customer_no})` : ''}`],
    ['Objekt', s.name],
    ['Adresse', s.address || '–'],
    ['Stand', formatDateDe(today)],
    ['Räume', String(rooms.length)],
    ['Fläche gesamt', `${m2(total)} m²`],
  ]);

  // Räume als eine Tabelle wie in Excel (Ahmed 19.11.: „Querformat, ungefähr wie die Excel, mit Logo“)
  const rows: (string[] | { sum: string[]; strong?: boolean })[] = rooms.map((r) => [
    r.building_part ?? '',
    r.floor ?? '',
    r.room_no ?? '',
    r.name,
    r.type_name,
    r.floor_covering ?? '',
    m2(r.area_centi),
    [r.turnus, r.visits_per_year != null ? frequencyLabel(r.visits_per_year) : '']
      .filter(Boolean)
      .join(' · '),
    r.notes?.trim() ?? '',
  ]);
  rows.push({ sum: ['Summe', '', '', `${rooms.length} Räume`, '', '', m2(total), '', ''], strong: true });
  d.table(
    [
      { label: 'Gebäudeteil', width: 66 },
      { label: 'Etage', width: 50 },
      { label: 'Raum-Nr.', width: 56 },
      { label: 'Raum', width: 180 },
      { label: 'Nutzungsart', width: 90 },
      { label: 'Bodenbelag', width: 72 },
      { label: 'Fläche m²', width: 62, align: 'right' },
      { label: 'Intervall', width: 80 },
      { label: 'Hinweise', width: 79 },
    ],
    rows,
    { size: 7.8 },
  );

  // Übersicht je Nutzungsart
  const byType = new Map<string, { n: number; area: bigint }>();
  for (const r of rooms) {
    const e = byType.get(r.type_name) ?? { n: 0, area: 0n };
    e.n++;
    e.area += BigInt(r.area_centi);
    byType.set(r.type_name, e);
  }
  d.ensure(90 + byType.size * 16);
  d.section('Übersicht nach Nutzungsart');
  d.table(
    [
      { label: 'Nutzungsart', width: 230 },
      { label: 'Räume', width: 70, align: 'right' },
      { label: 'Fläche m²', width: 100, align: 'right' },
      { label: 'Anteil', width: 98, align: 'right' },
    ],
    [
      ...[...byType]
        .sort((a, b) => Number(b[1].area - a[1].area))
        .map(([t, e]) => [
          t,
          String(e.n),
          m2(e.area),
          total
            ? `${((Number(e.area) * 100) / Number(total)).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`
            : '',
        ]),
      { sum: ['Summe', String(rooms.length), m2(total), '100 %'], strong: true },
    ],
  );
  return d.save();
}

/** Raumbuch-PDF unter Objekt → Dokumente ablegen (gleicher Inhalt = gleiche Datei; ältere App-Fassung ins Archiv). */
/** Name der von der App erzeugten Raumbuch-PDF („Raumbuch_<Objektnr.>_JJJJ-MM-TT.pdf“) – hochgeladene Raumbücher
 * (z. B. „Raumbuch_Grundschule_Neubiberg.pdf“) bleiben unberührt und dienen als Import-Quelle. */
export const APP_ROOMBOOK_RE = '^Raumbuch_.*_[0-9]{4}-[0-9]{2}-[0-9]{2}\\.pdf$';

export async function storeRoomBookPdf(sql: Sql, cfg: UploadConfig, siteId: string, actor: string) {
  const pdf = await renderRoomBookPdf(sql, siteId);
  // ID aus dem Inhalt ohne Zeitstempel: Raumliste bestimmt die Datei
  const rooms = await listRooms(sql, siteId);
  const key = createHash('sha256')
    .update(
      JSON.stringify(
        rooms.map((r) => [
          r.building_part,
          r.floor,
          r.room_no,
          r.name,
          r.type_name,
          r.floor_covering,
          String(r.area_centi),
          r.visits_per_year,
          r.notes,
        ]),
      ),
    )
    .digest('hex');
  const id = uuidOf(`raumbuch-pdf:${siteId}:${key}`);
  const [s] = await sql<{ site_no: string }[]>`select site_no from app.sites where id = ${siteId}`;
  const file = await storeFile(
    sql,
    cfg,
    {
      id,
      name: `Raumbuch_${s?.site_no ?? ''}_${todayBerlin()}.pdf`,
      type: 'application/pdf',
      data: pdf,
      link: { type: 'site', id: siteId },
      category: 'Raumbuch',
    },
    actor,
  );
  const older = await sql<{ file_id: string }[]>`
    select l.file_id from app.file_links l join app.files f on f.id = l.file_id
     where l.entity_type = 'site' and l.entity_id = ${siteId} and l.category = 'Raumbuch' and l.archived_at is null
       and f.original_name ~ ${APP_ROOMBOOK_RE} and f.content_type = 'application/pdf' and l.file_id <> ${id}`;
  for (const o of older) await archiveLink(sql, { type: 'site', id: siteId }, o.file_id, true, actor);
  return file;
}
