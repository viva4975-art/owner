/**
 * Aushang „App installieren“ (Ahmed 23.11.): A4 mit QR-Codes für iPhone (App Store, nicht gelistete App) und
 * Android (Web-App). Wird als JPEG gezeichnet (sharp) und für den Druck als PDF (A4, Bild ganzseitig) ausgegeben.
 */
import { resolve } from 'node:path';
import { PDFDocument } from '@cantoo/pdf-lib';
import QRCode from 'qrcode';
import sharp, { type OverlayOptions } from 'sharp';

/** Link der App im App Store („Nicht gelistete App“, Apple-ID 6823292857). */
export const APP_STORE_URL = 'https://apps.apple.com/de/app/viva-deluxe-team/id6823292857';
/** Web-App (Android, Browser) – Anmeldung mit Personalnummer + PIN bzw. Benutzer + Passwort. */
export const webAppUrl = (base?: string | null) =>
  `${(base || 'https://app.viva-deluxe-reinigung.de').replace(/\/+$/, '')}/app`;

const FONT = resolve('assets/fonts/inter/Inter-Regular.ttf');
const FONT_BOLD = resolve('assets/fonts/inter/Inter-SemiBold.ttf');
const LOGO = resolve('assets/web/logo-hell.png');
const W = 1654; // A4 bei 200 dpi
const H = 2339;
const BORDEAUX = '#7D1435';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function text(
  markup: string,
  opts: { size: number; bold?: boolean; color?: string; width: number; align?: 'left' | 'centre' },
) {
  return sharp({
    text: {
      text: `<span foreground="${opts.color ?? '#1d1d1f'}" size="${Math.round(opts.size * 1024)}">${markup}</span>`,
      fontfile: opts.bold ? FONT_BOLD : FONT,
      font: opts.bold ? 'Inter SemiBold' : 'Inter',
      width: opts.width,
      align: opts.align ?? 'centre',
      rgba: true,
      dpi: 72,
      wrap: 'word',
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
}

const qr = (url: string, size: number) =>
  QRCode.toBuffer(url, {
    type: 'png',
    width: size,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#1d1d1f' },
  });

/** Aushang als JPEG (A4 hoch, 1654 × 2339 px). */
export async function appPosterJpeg(base?: string | null): Promise<Buffer> {
  const web = webAppUrl(base);
  const layers: OverlayOptions[] = [];
  const headH = 470;
  const center = (w: number) => Math.round((W - w) / 2);

  // Kopf: Bordeaux mit hellem Logo
  layers.push({
    input: Buffer.from(
      `<svg width="${W}" height="${headH}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${headH}" fill="${BORDEAUX}"/></svg>`,
    ),
    top: 0,
    left: 0,
  });
  const logo = await sharp(LOGO).resize({ height: 170 }).png().toBuffer({ resolveWithObject: true });
  layers.push({ input: logo.data, top: 70, left: center(logo.info.width) });
  const t1 = await text('Unsere App für alle Mitarbeitenden', {
    size: 58,
    bold: true,
    color: '#ffffff',
    width: W - 160,
  });
  layers.push({ input: t1.data, top: 290, left: center(t1.info.width) });
  const t2 = await text('Zeiten · Einsätze · Urlaub · Dokumente · Lohnabrechnung', {
    size: 34,
    color: '#f3dfe6',
    width: W - 160,
  });
  layers.push({ input: t2.data, top: 380, left: center(t2.info.width) });

  // Zwei Spalten: iPhone | Android
  const colW = 640;
  const gap = 120;
  const left = Math.round((W - 2 * colW - gap) / 2);
  const qrSize = 520;
  const cols = [
    { title: 'iPhone', sub: 'QR-Code scannen → im App Store „Laden“', url: APP_STORE_URL, x: left },
    {
      title: 'Android',
      sub: 'QR-Code scannen → in Chrome „App installieren“ bzw. „Zum Startbildschirm“',
      url: web,
      x: left + colW + gap,
    },
  ];
  const top = headH + 120;
  for (const c of cols) {
    layers.push({
      input: Buffer.from(
        `<svg width="${colW}" height="980" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="${colW - 4}" height="976" rx="36" fill="#ffffff" stroke="#e5e5ea" stroke-width="4"/><rect x="2" y="2" width="${colW - 4}" height="12" rx="6" fill="${BORDEAUX}"/></svg>`,
      ),
      top,
      left: c.x,
    });
    const h = await text(c.title, { size: 64, bold: true, width: colW - 60 });
    layers.push({ input: h.data, top: top + 60, left: c.x + Math.round((colW - h.info.width) / 2) });
    const code = await qr(c.url, qrSize);
    layers.push({ input: code, top: top + 180, left: c.x + Math.round((colW - qrSize) / 2) });
    const s = await text(esc(c.sub), { size: 30, width: colW - 80 });
    layers.push({
      input: s.data,
      top: top + 180 + qrSize + 40,
      left: c.x + Math.round((colW - s.info.width) / 2),
    });
  }

  // Anmeldung + Fuß
  const login = await text(
    '<b>Anmelden:</b> Personalnummer + PIN (Mitarbeitende)\noder Benutzername + Passwort (Büro, Objektleitung)\n' +
      'Beim ersten Mal mit dem Geburtsdatum TTMMJJ – danach eigene PIN festlegen.',
    { size: 34, width: W - 240 },
  );
  layers.push({ input: login.data, top: top + 1080, left: center(login.info.width) });
  const foot = await text(
    `Ohne App: im Browser ${esc(web.replace(/^https?:\/\//, ''))} öffnen · Fragen? Im Büro melden.`,
    { size: 28, color: '#6e6e73', width: W - 240 },
  );
  layers.push({ input: foot.data, top: H - 150, left: center(foot.info.width) });

  return sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
    .composite(layers)
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

/** Aushang als PDF (A4 hoch, Bild ganzseitig). */
export async function appPosterPdf(base?: string | null): Promise<Uint8Array> {
  const jpg = await appPosterJpeg(base);
  const pdf = await PDFDocument.create();
  pdf.setTitle('App installieren – Aushang');
  pdf.setCreator('Viva-Deluxe');
  const img = await pdf.embedJpg(jpg);
  const page = pdf.addPage([595.28, 841.89]);
  page.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
  return pdf.save();
}
