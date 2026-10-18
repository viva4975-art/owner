import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Sql } from '../db/client.js';
import { type LinkTarget, type UploadConfig, storeFile } from './uploads.js';
import sharp, { type OverlayOptions } from 'sharp';

/*
 * Fotos mit Stempel (Ahmed 18.10.): unten ein Balken mit Logo, Objekt, Datum/Uhrzeit, Standort und Name.
 * Der Stempel entsteht auf dem Server – Uhrzeit vom Server, Entfernung zum Objekt vom Server gerechnet –, damit er
 * sich nicht am Handy verändern lässt. Das Original ohne Stempel wird zusätzlich write-once archiviert.
 */

const FONT = resolve('assets/fonts/inter/Inter-Regular.ttf');
const FONT_BOLD = resolve('assets/fonts/inter/Inter-SemiBold.ttf');
const LOGO = resolve('assets/web/logo-hell.png');

export interface StampInfo {
  /** z. B. „2001704 · TG 3 Sendling-Westpark“, leer = ohne Objekt */
  site: string | null;
  address: string | null;
  /** Aufnahmezeit (Serverzeit) */
  at: Date;
  by: string;
  /** Bewertung des Standorts (GeoStatus), ohne Objekt null */
  geo: string | null;
  distanceM: number | null;
  lat: number | null;
  lng: number | null;
  /** freier Ort / Adresse (z. B. „Treppenhaus Haus 3“), optional */
  place?: string | null;
  /** Schaden / Bemerkung (z. B. „Urin im Aufzug“), steht fett auf dem Foto */
  note?: string | null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function stampLines(i: StampInfo): [string, string, string] {
  const when = i.at.toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const dist = (m: number) =>
    m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
  const coord = i.lat != null && i.lng != null ? `${i.lat.toFixed(5)}, ${i.lng.toFixed(5)}` : '';
  const geo =
    i.geo === 'am_objekt'
      ? `am Objekt${i.distanceM != null ? ` (${dist(i.distanceM)})` : ''}`
      : i.geo === 'entfernt'
        ? `nicht am Objekt${i.distanceM != null ? ` (${dist(i.distanceM)} entfernt)` : ''}`
        : i.geo === 'ungenau'
          ? 'Standort ungenau'
          : i.geo === 'objekt_ohne_standort'
            ? 'Objekt ohne hinterlegten Standort'
            : coord
              ? ''
              : 'kein Standort freigegeben';
  const place = i.place?.trim() || null;
  return [
    [i.site ?? place ?? 'ohne Objekt', i.address, i.site ? place : null].filter(Boolean).join(' · '),
    `${when.replace(',', ' ·')} Uhr · ${i.by}`,
    ['Standort', [geo, coord].filter(Boolean).join(' · ')].join(': '),
  ];
}

/** Foto nur drehen (EXIF) und auf höchstens 2000 px verkleinern → JPEG. */
export async function plainPhoto(input: Uint8Array): Promise<Uint8Array> {
  const out = await sharp(input, { failOn: 'none' })
    .rotate()
    .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  return new Uint8Array(out);
}

/** Foto drehen (EXIF), auf höchstens 2000 px verkleinern und den Stempel unten einsetzen → JPEG. */
export async function stampPhoto(input: Uint8Array, info: StampInfo): Promise<Uint8Array> {
  const base = sharp(input, { failOn: 'none' }).rotate().resize({
    width: 2000,
    height: 2000,
    fit: 'inside',
    withoutEnlargement: true,
  });
  const { data: img, info: meta } = await base.jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
  const W = meta.width;
  const H = meta.height;
  const band = Math.max(96, Math.round(Math.min(W, H) * 0.16));
  const pad = Math.round(band * 0.14);
  const logoH = Math.round(band * 0.36);
  const logo = await sharp(LOGO).resize({ height: logoH }).png().toBuffer({ resolveWithObject: true });
  const textX = pad;
  const textW = W - 2 * pad;
  const fs = Math.max(11, Math.round(band * 0.15));
  const [l1, l2, l3] = stampLines(info).map(esc) as [string, string, string];
  const text = async (markup: string, font: string, size: number, family = 'Inter') =>
    sharp({
      text: {
        text: `<span foreground="white" size="${Math.round(size * 1024)}">${markup}</span>`,
        fontfile: font,
        font: family,
        width: textW,
        rgba: true,
        dpi: 72,
        wrap: 'char',
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
  const note = info.note?.trim();
  const t1 = await text(note ? `${l1}\n${esc(note)}` : l1, FONT_BOLD, fs * 1.05, 'Inter SemiBold');
  const t23 = await text(`${l2}\n${l3}`, FONT, fs * 0.9);
  // Balken so hoch wie nötig (lange Objektnamen brechen um)
  const need =
    pad + logoH + Math.round(pad * 0.6) + t1.info.height + Math.round(pad * 0.3) + t23.info.height + pad;
  const bandH = Math.max(band, need);
  const svg = Buffer.from(
    `<svg width="${W}" height="${bandH}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${W}" height="${bandH}" fill="#1c0d12" fill-opacity="0.78"/>` +
      `<rect width="${W}" height="${Math.max(3, Math.round(band * 0.035))}" fill="#7D1435"/></svg>`,
  );
  const top = H - bandH;
  let y = top + pad;
  const layers: OverlayOptions[] = [
    { input: svg, top, left: 0 },
    { input: logo.data, top: y, left: textX },
  ];
  y += logoH + Math.round(pad * 0.6);
  layers.push({ input: t1.data, top: y, left: textX });
  y += t1.info.height + Math.round(pad * 0.3);
  layers.push({ input: t23.data, top: y, left: textX });
  const out = await sharp(img)
    .extend({ bottom: bandH > H * 0.45 ? bandH : 0, background: '#1c0d12' })
    .composite(layers.map((l) => ({ ...l, top: (l.top ?? 0) + (bandH > H * 0.45 ? bandH : 0) })))
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  return new Uint8Array(out);
}

/**
 * Foto stempeln und ablegen: gestempeltes JPEG mit Verknüpfung (`link`), Original write-once ohne Verknüpfung,
 * Stand in `app.photo_stamps`. IDs fest je Formular-Foto → doppelt absenden legt nichts doppelt an.
 */
export async function saveStampedPhoto(
  sql: Sql,
  cfg: UploadConfig,
  p: {
    id: string;
    data: Uint8Array;
    name: string;
    type: string;
    link: LinkTarget | null;
    category: string | null;
    source: 'qm' | 'foto';
    groupId?: string | null;
    siteId: string | null;
    note?: string | null;
    info: StampInfo;
    accuracy: number | null;
    actor: string;
    /** false = kein Stempel im Bild, nur drehen/verkleinern (Fotogruppen: Angaben stehen im PDF über dem Foto) */
    stamp?: boolean;
  },
): Promise<string> {
  const [done] = await sql`select 1 from app.photo_stamps where file_id = ${p.id}`;
  if (done) return p.id;
  const stamped = p.stamp === false ? await plainPhoto(p.data) : await stampPhoto(p.data, p.info);
  const origId = uuidFrom(`${p.id}:original`);
  await storeFile(
    sql,
    cfg,
    {
      id: origId,
      name: `original_${p.name || 'foto.jpg'}`,
      type: p.type,
      data: p.data,
      link: null,
      category: null,
    },
    p.actor,
  );
  const base = (p.name || 'foto').replace(/\.[a-z0-9]+$/i, '');
  await storeFile(
    sql,
    cfg,
    { id: p.id, name: `${base}.jpg`, type: 'image/jpeg', data: stamped, link: p.link, category: p.category },
    p.actor,
  );
  const i = p.info;
  await sql`
    insert into app.photo_stamps (file_id, original_file_id, site_id, source, taken_at, geo, geo_m, geo_acc_m, lat, lng,
                                  note, created_by, group_id)
    values (${p.id}, ${origId}, ${p.siteId}, ${p.source}, ${i.at}, ${i.geo}, ${i.distanceM}, ${p.accuracy},
            ${i.lat != null ? i.lat.toFixed(5) : null}, ${i.lng != null ? i.lng.toFixed(5) : null},
            ${p.note ?? null}, ${p.actor}, ${p.groupId ?? null})
    on conflict (file_id) do nothing`;
  return p.id;
}

/** Feste UUID aus einem Text (für idempotente IDs). */
export function uuidFrom(s: string): string {
  const h = createHash('md5').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function siteAddress(s: {
  street: string | null;
  postal_code: string | null;
  city: string | null;
}): string | null {
  const town = [s.postal_code, s.city].filter(Boolean).join(' ');
  return [s.street, town].filter(Boolean).join(', ') || null;
}
