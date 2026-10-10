import type { InvoiceDocument } from '../domain/invoice/types.js';
import { renderInvoiceDesign2 } from './invoice-design2.js';

/*
 * Sichtbare Rechnungs-/Angebots-/AB-PDF (Grundlage auch für ZUGFeRD). Seit 10.10.2026 Gestaltung „edel“
 * (Ahmed: Objekt als Band über der Anrede, ohne Bankverbindung/Verwendungszweck – steht in der Fußzeile bzw. im
 * GiroCode). Die bisherige Gestaltung bleibt als `renderInvoicePdfClassic` in render.ts (nicht mehr verwendet).
 * Bereits archivierte PDFs bleiben unverändert (write-once).
 */
export interface InvoicePdfOptions {
  watermark?: string;
  /** Für Angebote u. Ä.: eigener Titel statt „Rechnung“ */
  title?: string;
  /** Betreffzeile; „Objekt: …“ wird als Objekt-Band gezeigt */
  subject?: string;
  /** Angaben im Kopfblock (ersetzt die Rechnungsangaben) */
  info?: [string, string][];
  /** Text unter den Summen (ersetzt die Zahlungsbedingung) */
  terms?: string;
  /** Schlusssatz */
  closing?: string;
  /** GiroCode anzeigen (Standard: bei offenen Rechnungsbeträgen) */
  qr?: boolean;
  /** abweichende Einheiten-Texte */
  units?: Record<string, string>;
  /** Summen getrennt ausweisen (Angebot: monatlich / einmalig) */
  totalsSplit?: { label: string; net: bigint; vat: bigint; gross: bigint }[];
  /** Angebot: Ansprechpartner-Karte */
  contact?: { name: string; phone?: string | null; email?: string | null };
  /** Angebot: Feld „Auftragserteilung“ zum Unterschreiben */
  acceptance?: boolean;
  validUntil?: string;
}

export function renderInvoicePdf(doc: InvoiceDocument, opts: InvoicePdfOptions = {}): Promise<Uint8Array> {
  return renderInvoiceDesign2(doc, { variant: 'edel', objPos: 'band', ...opts });
}
