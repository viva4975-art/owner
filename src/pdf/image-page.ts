import type { PDFDocument } from '@cantoo/pdf-lib';

/** Foto/Scan (PNG/JPG) als eigene A4-Seite einfügen – hoch oder quer je nach Bild, mit Rand, Seitenverhältnis bleibt. */
export async function embedImageFile(pdf: PDFDocument, data: Uint8Array, type: string) {
  const img = /png/i.test(type) ? await pdf.embedPng(data) : await pdf.embedJpg(data);
  const landscape = img.width > img.height;
  const [W, H] = landscape ? [841.89, 595.28] : [595.28, 841.89];
  const page = pdf.addPage([W, H]);
  const m = 28;
  const s = Math.min((W - 2 * m) / img.width, (H - 2 * m) / img.height);
  const w = img.width * s;
  const h = img.height * s;
  page.drawImage(img, { x: (W - w) / 2, y: (H - h) / 2, width: w, height: h });
  return page;
}
