import { PDFDocument, rgb } from '@cantoo/pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { BusinessError } from '../services/errors.js';
import { embedUiFonts } from './fonts.js';

/**
 * Fotos (Ausweis, Krankenkassenkarte, Bankkarte …) als ein PDF: je Foto eine A4-Seite mit Überschrift, Bild
 * eingepasst. JPEG und PNG; andere Formate (z. B. HEIC ohne Umwandlung) werden mit klarer Meldung abgelehnt.
 */
export async function photosToPdf(
  photos: { label: string; file: File }[],
  person: string,
): Promise<Uint8Array> {
  const total = photos.reduce((n, p) => n + p.file.size, 0);
  if (total > 40 * 1024 * 1024) throw new BusinessError('Fotos zu groß (zusammen höchstens 40 MB)');
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`Unterlagen ${person}`);
  pdf.setCreator('Viva-Deluxe App');
  pdf.setProducer('Viva-Deluxe App');
  pdf.setCreationDate(new Date());
  const { regular, bold } = await embedUiFonts(pdf);
  const W = 595.28;
  const H = 841.89;
  const M = 40;
  let n = 0;
  for (const p of photos) {
    const bytes = new Uint8Array(await p.file.arrayBuffer());
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!isPng && !isJpg)
      throw new BusinessError(`${p.label}: Bildformat nicht lesbar – bitte als JPG/PNG fotografieren`);
    const img = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    n++;
    const page = pdf.addPage([W, H]);
    page.drawText(p.label, { x: M, y: H - M - 14, size: 14, font: bold, color: rgb(0.1, 0.09, 0.1) });
    page.drawText(`${person} · Foto ${n} von ${photos.length}`, {
      x: M,
      y: H - M - 32,
      size: 9,
      font: regular,
      color: rgb(0.45, 0.4, 0.42),
    });
    const boxW = W - 2 * M;
    const boxH = H - 2 * M - 50;
    const s = Math.min(boxW / img.width, boxH / img.height, 2);
    const w = img.width * s;
    const h = img.height * s;
    page.drawImage(img, { x: M + (boxW - w) / 2, y: M + (boxH - h), width: w, height: h });
  }
  return pdf.save();
}
