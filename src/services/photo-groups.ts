import fontkit from '@pdf-lib/fontkit';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PDFDocument, rgb } from '@cantoo/pdf-lib';
import type { Sql } from '../db/client.js';
import { embedUiFonts, uiText } from '../pdf/fonts.js';
import { BusinessError } from './errors.js';
import { type StampInfo, saveStampedPhoto, stampLines, uuidFrom } from './photo-stamp.js';
import { type FileRow, type UploadConfig, filePath, storeFile } from './uploads.js';

/*
 * Fotos als Gruppe (Ahmed 18.10.): ein Absenden = eine Gruppe → ein PDF mit allen Fotos (Angaben über jedem Foto,
 * kein Stempel im Bild) und eine Aufgabe für Admin. Nicht beim Objekt, nicht im Dokumenteneingang. Ist die Aufgabe
 * erledigt, lässt sich die Gruppe löschen. Fotos und Originale bleiben write-once ohne Verknüpfung (Nachweis).
 */

export interface PhotoGroupRow {
  id: string;
  site_id: string | null;
  site_no: string | null;
  site_name: string | null;
  place: string | null;
  note: string | null;
  photo_count: number;
  pdf_file_id: string | null;
  created_by: string;
  created_at: Date;
  photos: string[];
}

export function groupTitle(g: {
  site_no?: string | null;
  site_name?: string | null;
  place?: string | null;
  note?: string | null;
}) {
  const where = [g.site_no && g.site_name ? `${g.site_no} ${g.site_name}` : null, g.place]
    .filter(Boolean)
    .join(' · ');
  return [where || 'ohne Objekt', g.note].filter(Boolean).join(' – ');
}

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);

interface GroupPdfInfo {
  title: string;
  site: string | null;
  address: string | null;
  place: string | null;
  note: string | null;
  by: string;
}

/**
 * PDF mit allen Fotos der Gruppe: je Foto eine A4-Seite, oben Logo und die Angaben (Objekt/Ort, Schaden/Bemerkung,
 * Datum/Uhrzeit, Name, Standort), darunter das Foto ohne Stempel.
 */
export async function buildGroupPdf(
  sql: Sql,
  cfg: UploadConfig,
  groupId: string,
  g: GroupPdfInfo,
): Promise<Uint8Array> {
  const files = await sql<
    (FileRow & {
      taken_at: Date;
      geo: string | null;
      geo_m: number | null;
      lat: string | null;
      lng: string | null;
    })[]
  >`
    select f.*, p.taken_at, p.geo, p.geo_m, p.lat::text as lat, p.lng::text as lng
      from app.photo_stamps p join app.files f on f.id = p.file_id
     where p.group_id = ${groupId} order by p.taken_at, f.original_name, f.id`;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`Fotos – ${g.title}`);
  pdf.setCreator('Viva-Deluxe App');
  pdf.setProducer('Viva-Deluxe App');
  pdf.setCreationDate(new Date(0));
  pdf.setModificationDate(new Date(0));
  const { regular, bold } = await embedUiFonts(pdf);
  const logo = await pdf.embedPng(await readFile(resolve('assets/web/logo-transparent.png')));
  const BORDEAUX = rgb(0x7d / 255, 0x14 / 255, 0x35 / 255);
  const DARK = rgb(0.1, 0.09, 0.1);
  const MUT = rgb(0.42, 0.4, 0.42);
  const wrap = (t: string, size: number, max: number, font = regular) => {
    const out: string[] = [];
    for (const para of uiText(t).split('\n')) {
      let line = '';
      for (const w of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${w}` : w;
        if (font.widthOfTextAtSize(next, size) <= max || !line) line = next;
        else {
          out.push(line);
          line = w;
        }
      }
      if (line) out.push(line);
    }
    return out.slice(0, 4);
  };
  let n = 0;
  for (const f of files) {
    n++;
    const img = await pdf.embedJpg(await readFile(filePath(cfg, f)));
    const land = img.width > img.height;
    const [W, H] = land ? [842, 595] : [595, 842];
    const page = pdf.addPage([W, H]);
    const m = 32;
    const maxW = W - 2 * m;
    const lw = 110;
    const lh = (logo.height / logo.width) * lw;
    page.drawImage(logo, { x: m, y: H - m - lh, width: lw, height: lh });
    const right = `Foto ${n} von ${files.length}`;
    page.drawText(right, {
      x: W - m - regular.widthOfTextAtSize(right, 9),
      y: H - m - 10,
      size: 9,
      font: regular,
      color: MUT,
    });
    let y = H - m - lh - 16;
    const [where, when, standort] = stampLines({
      site: g.site,
      address: g.address,
      at: f.taken_at,
      by: g.by,
      geo: f.geo,
      distanceM: f.geo_m,
      lat: f.lat != null ? Number(f.lat) : null,
      lng: f.lng != null ? Number(f.lng) : null,
      place: g.place,
    });
    const line = (t: string, size: number, font = regular, color = DARK) => {
      for (const l of wrap(t, size, maxW, font)) {
        page.drawText(l, { x: m, y, size, font, color });
        y -= size * 1.3;
      }
    };
    line(where, 12, bold);
    if (g.note) line(g.note, 12, bold, BORDEAUX);
    line(when, 9.5);
    line(standort, 9.5, regular, MUT);
    y -= 2;
    page.drawRectangle({ x: m, y, width: maxW, height: 1.2, color: BORDEAUX });
    const top = y - 10;
    const maxH = top - m;
    const r = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * r;
    const h = img.height * r;
    page.drawImage(img, { x: (W - w) / 2, y: top - h, width: w, height: h });
  }
  return pdf.save();
}

/** Aufgabe zur Fotogruppe (feste ID). */
export const photoTaskId = (groupId: string) => uuidFrom(`fotogruppe-aufgabe:${groupId}`);

export async function savePhotoGroup(
  sql: Sql,
  cfg: UploadConfig,
  p: {
    id: string;
    siteId: string | null;
    siteLabel: string | null;
    address: string | null;
    place: string | null;
    note: string | null;
    files: { data: Uint8Array; name: string; type: string }[];
    by: string;
    geo: string | null;
    distanceM: number | null;
    accuracy: number | null;
    lat: number | null;
    lng: number | null;
    actor: string;
  },
): Promise<{ saved: number; failed: string[]; pdfId: string | null }> {
  const [done] = await sql<{ pdf_file_id: string | null; photo_count: number }[]>`
    select pdf_file_id, photo_count from app.photo_groups where id = ${p.id}`;
  if (done?.pdf_file_id) return { saved: done.photo_count, failed: [], pdfId: done.pdf_file_id };
  await sql`insert into app.photo_groups (id, site_id, place, note, created_by)
            values (${p.id}, ${p.siteId}, ${p.place}, ${p.note}, ${p.actor}) on conflict (id) do nothing`;
  const at = new Date();
  const failed: string[] = [];
  let saved = 0;
  let i = 0;
  for (const f of p.files) {
    i++;
    const label = f.name || `Foto ${i}`;
    if (!/^image\//.test(f.type) || f.data.byteLength > cfg.maxBytes) {
      failed.push(`${label} (${f.data.byteLength > cfg.maxBytes ? 'zu groß' : 'kein Bild'})`);
      continue;
    }
    const info: StampInfo = {
      site: p.siteLabel,
      address: p.address,
      at,
      by: p.by,
      geo: p.geo,
      distanceM: p.distanceM,
      lat: p.lat,
      lng: p.lng,
      place: p.place,
      note: p.note,
    };
    // ein fehlerhaftes Bild (z. B. Format) hält die anderen nicht auf
    try {
      await saveStampedPhoto(sql, cfg, {
        id: uuidFrom(`foto:${p.id}:${i}`),
        data: f.data,
        name: f.name || `foto_${i}.jpg`,
        type: f.type,
        link: null,
        category: null,
        source: 'foto',
        siteId: p.siteId,
        groupId: p.id,
        note: [p.place, p.note].filter(Boolean).join(' – ') || null,
        info,
        accuracy: p.accuracy,
        actor: p.actor,
        stamp: false,
      });
      saved++;
    } catch (e) {
      console.error('Foto fehlgeschlagen', label, e);
      failed.push(`${label} (Bild konnte nicht gelesen werden)`);
    }
  }
  const [{ count } = { count: 0 }] = await sql<{ count: number }[]>`
    select count(*)::int as count from app.photo_stamps where group_id = ${p.id}`;
  if (!count) {
    await sql`delete from app.photo_groups where id = ${p.id} and pdf_file_id is null`;
    return { saved: 0, failed, pdfId: null };
  }
  const title = groupTitle({ site_no: null, site_name: p.siteLabel, place: p.place, note: p.note }).replace(
    /^ohne Objekt/,
    p.siteLabel ?? 'ohne Objekt',
  );
  const bytes = await buildGroupPdf(sql, cfg, p.id, {
    title,
    site: p.siteLabel,
    address: p.address,
    place: p.place,
    note: p.note,
    by: p.by,
  });
  const pdfId = uuidFrom(`fotogruppe:${p.id}`);
  const day = at.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
  // Ahmed 18.10.: weder beim Objekt noch im Dokumenteneingang – nur als Aufgabe für Admin
  await storeFile(
    sql,
    cfg,
    {
      id: pdfId,
      name: `Fotos_${day}_${slug(title) || 'Gruppe'}.pdf`,
      type: 'application/pdf',
      data: bytes,
      link: null,
      category: null,
    },
    p.actor,
  );
  await sql.begin(async (tx) => {
    await tx`update app.photo_groups set pdf_file_id = ${pdfId}, photo_count = ${count} where id = ${p.id}`;
    const [admin] = await tx<{ name: string }[]>`
      select coalesce(nullif(p.display_name, ''), a.login) as name
        from app.user_accounts a join app.profiles p on p.user_id = a.id
       where a.active and p.role = 'admin' order by a.created_at limit 1`;
    await tx`
      insert into app.tasks (id, title, description, due_date, assignee, entity_type, entity_id, created_by)
      values (${photoTaskId(p.id)}, ${`Fotos prüfen: ${title}`.slice(0, 300)},
              ${`${count === 1 ? '1 Foto' : `${count} Fotos`} von ${p.by}`}, ${day}, ${admin?.name ?? null},
              'photo_group', ${p.id}, ${p.actor})
      on conflict (id) do nothing`;
  });
  return { saved, failed, pdfId };
}

export async function listPhotoGroups(
  sql: Sql,
  f: { createdBy?: string | undefined; siteIds?: string[] | null; limit?: number },
): Promise<PhotoGroupRow[]> {
  const scope =
    f.siteIds == null
      ? sql`true`
      : f.siteIds.length
        ? sql`(g.site_id is null or g.site_id in ${sql(f.siteIds)})`
        : sql`g.site_id is null`;
  return sql<PhotoGroupRow[]>`
    select g.id, g.site_id, s.site_no, s.name as site_name, g.place, g.note, g.photo_count, g.pdf_file_id,
           g.created_by, g.created_at,
           coalesce((select array_agg(p.file_id order by p.taken_at, p.file_id) from app.photo_stamps p
                      where p.group_id = g.id), '{}') as photos
      from app.photo_groups g left join app.sites s on s.id = g.site_id
     where g.deleted_at is null and g.pdf_file_id is not null
       and ${f.createdBy ? sql`g.created_by = ${f.createdBy}` : sql`true`} and ${scope}
     order by g.created_at desc limit ${f.limit ?? 20}`;
}

/** Gruppe löschen: ausblenden, Aufgabe entfernen (ältere Gruppen: PDF-Verknüpfung). Dateien bleiben write-once. */
export async function deletePhotoGroup(sql: Sql, id: string, actor: string) {
  return sql.begin(async (tx) => {
    const [g] = await tx<
      { pdf_file_id: string | null; deleted_at: Date | null; place: string | null; note: string | null }[]
    >`
      select pdf_file_id, deleted_at, place, note from app.photo_groups where id = ${id} for update`;
    if (!g) throw new BusinessError('Fotogruppe nicht gefunden');
    if (g.deleted_at) return false;
    await tx`update app.photo_groups set deleted_at = now(), deleted_by = ${actor} where id = ${id}`;
    if (g.pdf_file_id) await tx`delete from app.file_links where file_id = ${g.pdf_file_id}`;
    await tx`delete from app.tasks where id = ${photoTaskId(id)}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'delete', 'photo_groups', ${id}, ${tx.json({ place: g.place, note: g.note })})`;
    return true;
  });
}

/** Gruppe zu einer PDF-Datei (Dokumenteneingang), falls vorhanden. */
export async function photoGroupsByPdf(sql: Sql, pdfIds: string[]) {
  if (!pdfIds.length) return new Map<string, PhotoGroupRow>();
  const rows = await sql<PhotoGroupRow[]>`
    select g.id, g.site_id, s.site_no, s.name as site_name, g.place, g.note, g.photo_count, g.pdf_file_id,
           g.created_by, g.created_at,
           coalesce((select array_agg(p.file_id order by p.taken_at, p.file_id) from app.photo_stamps p
                      where p.group_id = g.id), '{}') as photos
      from app.photo_groups g left join app.sites s on s.id = g.site_id
     where g.pdf_file_id in ${sql(pdfIds)} and g.deleted_at is null`;
  return new Map(rows.map((r) => [r.pdf_file_id!, r]));
}
