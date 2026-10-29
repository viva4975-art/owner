import { PDFDocument } from '@cantoo/pdf-lib';
import { sha256 as hashOf } from '../archive/store.js';
import type { InvoiceDocument } from '../domain/invoice/types.js';
import { generateXRechnungUbl, generateZugferd, type EmbeddedFile } from '../einvoice/generate.js';
import { rejectReason, validateWithKosit } from '../einvoice/kosit.js';
import { BusinessError } from './errors.js';

/**
 * „Eine Datei je E-Mail“ (Ahmed 29.10., Deutsche Bahn: „Je E-Mail kann nur eine Datei verarbeitet werden, in dieser
 * Datei muss der vollständige Vorgang enthalten sein“). Rechnung + Anlagen (Arbeitsscheine, Stundennachweise …)
 * werden zu genau einer Datei:
 *  - PDF: eine PDF – Rechnung, danach die Anlagen als weitere Seiten.
 *  - ZUGFeRD: sichtbare PDF = Rechnung + Anlagen-Seiten, darin das CII-XML wie sonst (KoSIT-geprüft).
 *  - XRechnung: das XML mit eingebetteter Rechnungs-PDF und Anlagen (BG-24), vor dem Versand gegen KoSIT geprüft.
 */
export interface BundleFile {
  kind: string;
  filename: string;
  content_type: string;
  storage_path: string;
  sha256: string;
}
export interface Bundle {
  filename: string;
  contentType: string;
  content: Uint8Array;
  storage_path: string;
  sha256: string;
  size: number;
}

const XR_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
]);

const mimeOf = (f: BundleFile) => {
  const t = f.content_type.toLowerCase().split(';')[0]!.trim();
  if (t === 'image/jpg') return 'image/jpeg';
  if (t === 'application/octet-stream' && /\.pdf$/i.test(f.filename)) return 'application/pdf';
  return t;
};

/** Hängt PDFs bzw. Bilder (je Bild eine A4-Seite) an die Rechnungs-PDF an. */
export async function mergePdf(
  main: Uint8Array,
  extras: { filename: string; mime: string; bytes: Uint8Array }[],
) {
  const out = await PDFDocument.load(main, { updateMetadata: false });
  for (const x of extras) {
    if (x.mime === 'application/pdf') {
      const src = await PDFDocument.load(x.bytes, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const p of pages) out.addPage(p);
    } else if (x.mime === 'image/png' || x.mime === 'image/jpeg') {
      const img = x.mime === 'image/png' ? await out.embedPng(x.bytes) : await out.embedJpg(x.bytes);
      const W = 595.28,
        H = 841.89,
        m = 28;
      const k = Math.min((W - 2 * m) / img.width, (H - 2 * m) / img.height, 1);
      const page = out.addPage([W, H]);
      page.drawImage(img, {
        x: (W - img.width * k) / 2,
        y: (H - img.height * k) / 2,
        width: img.width * k,
        height: img.height * k,
      });
    } else {
      throw new BusinessError(
        `Anlage „${x.filename}“ (${x.mime}) lässt sich nicht in die Rechnung einfügen – nur PDF, JPG oder PNG. Anlage als PDF hochladen oder „eine Datei je E-Mail“ in der Rechnungsgruppe abschalten.`,
      );
    }
  }
  return out.save();
}

export async function buildMailBundle(p: {
  doc: InvoiceDocument;
  format: string;
  /** Hauptbelege der Mail (PDF / ZUGFeRD / XRechnung + PDF) */
  main: BundleFile[];
  /** sichtbare Rechnungs-PDF der aktuellen Fassung */
  pdf: BundleFile;
  attachments: BundleFile[];
  baseName: string;
  archiveBase: string;
  get: (path: string) => Promise<Uint8Array>;
  put: (path: string, bytes: Uint8Array) => Promise<{ sha256: string; size: number }>;
  kositUrl: string;
}): Promise<Bundle> {
  const { doc, format } = p;
  // Schon nur eine Datei: unverändert verwenden
  if (!p.attachments.length && p.main.length === 1) {
    const f = p.main[0]!;
    const content = await p.get(f.storage_path);
    return {
      filename: f.filename,
      contentType: f.content_type,
      content,
      storage_path: f.storage_path,
      sha256: f.sha256,
      size: content.byteLength,
    };
  }
  const extras = await Promise.all(
    p.attachments.map(async (a) => ({
      filename: a.filename,
      mime: mimeOf(a),
      bytes: await p.get(a.storage_path),
    })),
  );
  let filename: string;
  let contentType: string;
  let content: Uint8Array;
  if (format === 'xrechnung') {
    const bad = extras.find((x) => !XR_MIMES.has(x.mime));
    if (bad)
      throw new BusinessError(
        `Anlage „${bad.filename}“ (${bad.mime}) darf nicht in eine XRechnung eingebettet werden – nur PDF, JPG, PNG, CSV, XLSX, ODS.`,
      );
    const files: EmbeddedFile[] = [
      {
        buffer: await p.get(p.pdf.storage_path),
        filename: p.pdf.filename,
        mimetype: 'application/pdf',
        description: 'Rechnung als PDF (Sichtbeleg)',
      },
      ...extras.map((x) => ({
        buffer: x.bytes,
        filename: x.filename,
        mimetype: x.mime,
        description: 'Anlage',
      })),
    ];
    const xml = await generateXRechnungUbl(doc, files);
    const res = await validateWithKosit(xml, p.kositUrl);
    if (!res.valid)
      throw new BusinessError(
        `XRechnung mit eingebetteten Anlagen hat die KoSIT-Prüfung nicht bestanden – Versand gesperrt. ${rejectReason(res)}`,
      );
    filename = `${p.baseName}_xrechnung.xml`;
    contentType = 'application/xml';
    content = Buffer.from(xml, 'utf8');
  } else if (format === 'zugferd') {
    const visible = await mergePdf(await p.get(p.pdf.storage_path), extras);
    content = await generateZugferd(doc, visible, `${p.baseName}.pdf`);
    filename = `${p.baseName}_zugferd.pdf`;
    contentType = 'application/pdf';
  } else {
    content = await mergePdf(await p.get(p.pdf.storage_path), extras);
    filename = `${p.baseName}.pdf`;
    contentType = 'application/pdf';
  }
  // write-once ablegen: genau diese Datei ist versendet worden (Versandprotokoll nennt Pfad + Prüfsumme)
  const storage_path = `${p.archiveBase}/versand/${hashOf(content).slice(0, 12)}_${filename}`;
  const { sha256, size } = await p.put(storage_path, content);
  return { filename, contentType, content, storage_path, sha256, size };
}
