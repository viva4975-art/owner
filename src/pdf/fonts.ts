import { readFile } from 'node:fs/promises';
import type { PDFDocument, PDFFont } from '@cantoo/pdf-lib';

/*
 * Schriften für alle PDFs im Stil „edel“ (Ahmed 10.10.: Bestellungen, Arbeitsscheine, Listen wie die Rechnung): Inter
 * (SIL OFL) Regular + SemiBold. Zeichen, die Inter nicht hat (☐ ☒ ✔ aus Word-Vorlagen), werden durch gleichwertige
 * ersetzt (□ ■ ✓) – eine Ersatzschrift lässt sich mit fontkit nicht als Teilmenge einbetten.
 */

const ASSETS = new URL('../../assets/', import.meta.url);

/** Inter: kontextabhängige Formen (calt/case) verschieben Klammern/Striche ohne passende Breiten in der PDF → aus */
export const NOFEAT = { calt: false, case: false, ccmp: false, liga: false, kern: true } as const;

let cache: Promise<{ regular: Uint8Array; bold: Uint8Array }> | null = null;
export function uiFontBytes() {
  cache ??= Promise.all([
    readFile(new URL('fonts/inter/Inter-Regular.ttf', ASSETS)),
    readFile(new URL('fonts/inter/Inter-SemiBold.ttf', ASSETS)),
  ]).then(([regular, bold]) => ({ regular, bold }));
  return cache;
}

/** Zeichen ohne Glyphe in Inter ersetzen (Kästchen aus Word-Vorlagen) */
export function uiText(t: string): string {
  return t.replace(/☐/g, '□').replace(/[☑☒]/g, '■').replace(/✔/g, '✓');
}

/** Inter Regular/SemiBold (vollständig eingebettet) in ein PDF einbetten. */
export async function embedUiFonts(pdf: PDFDocument): Promise<{ regular: PDFFont; bold: PDFFont }> {
  const f = await uiFontBytes();
  return {
    regular: await pdf.embedFont(f.regular, { subset: false, features: NOFEAT }),
    bold: await pdf.embedFont(f.bold, { subset: false, features: NOFEAT }),
  };
}
