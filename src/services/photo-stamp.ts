import { resolve } from 'node:path';
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
  /** Bewertung des Standorts: am_objekt / nicht_am_objekt / ungenau / kein_standort / ohne Objekt null */
  geo: string | null;
  distanceM: number | null;
  lat: number | null;
  lng: number | null;
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
      : i.geo === 'nicht_am_objekt'
        ? `nicht am Objekt${i.distanceM != null ? ` (${dist(i.distanceM)} entfernt)` : ''}`
        : i.geo === 'ungenau'
          ? 'Standort ungenau'
          : coord
            ? ''
            : 'kein Standort freigegeben';
  return [
    [i.site ?? 'ohne Objekt', i.address].filter(Boolean).join(' · '),
    `${when.replace(',', ' ·')} Uhr · ${i.by}`,
    ['Standort', [geo, coord].filter(Boolean).join(' · ')].join(': '),
  ];
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
  const text = async (markup: string, font: string, size: number) =>
    sharp({
      text: {
        text: `<span foreground="white" size="${Math.round(size * 1024)}">${markup}</span>`,
        fontfile: font,
        font: 'Inter',
        width: textW,
        rgba: true,
        dpi: 72,
        wrap: 'char',
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
  const t1 = await text(l1, FONT_BOLD, fs * 1.05);
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
