import { InvoiceService } from '@e-invoice-eu/core';
import type { InvoiceDocument } from '../domain/invoice/types.js';
import { toEInvoice } from './mapping.js';

const silentLogger = { log: () => {}, warn: () => {}, error: console.error };
const service = new InvoiceService(silentLogger);

/** XRechnung 3.0 in UBL-Syntax (reines XML). */
export async function generateXRechnungUbl(doc: InvoiceDocument): Promise<string> {
  const out = await service.generate(toEInvoice(doc), { format: 'XRECHNUNG-UBL', lang: 'de-de' });
  if (typeof out !== 'string') throw new Error('Unerwartete Ausgabe beim Erzeugen der XRechnung');
  return out;
}

/** XRechnung-Profil in CII-Syntax – genau das XML, das in ZUGFeRD eingebettet wird. */
export async function generateCii(doc: InvoiceDocument): Promise<string> {
  const out = await service.generate(toEInvoice(doc), { format: 'XRECHNUNG-CII', lang: 'de-de' });
  if (typeof out !== 'string') throw new Error('Unerwartete Ausgabe beim Erzeugen des CII-XML');
  return out;
}

/**
 * ZUGFeRD 2.x / Factur-X, Profil XRECHNUNG: die sichtbare PDF wird nach PDF/A-3 überführt
 * und das CII-XML als factur-x.xml / xrechnung.xml eingebettet.
 */
export async function generateZugferd(
  doc: InvoiceDocument,
  pdf: Uint8Array,
  filename: string,
): Promise<Uint8Array> {
  const out = await service.generate(toEInvoice(doc), {
    format: 'Factur-X-XRechnung',
    lang: 'de-de',
    pdf: { buffer: pdf, filename, mimetype: 'application/pdf' },
  });
  if (typeof out === 'string') throw new Error('Unerwartete Ausgabe beim Erzeugen der ZUGFeRD-PDF');
  return out;
}
