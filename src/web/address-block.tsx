import {
  AddressBlockError,
  type AddressParts,
  formatAddressBlock,
  parseAddressBlock,
} from '../domain/letter/address-block.js';
import { BusinessError } from '../services/errors.js';

/**
 * Formularfelder `<präfix>block` (Anschrift als ein Textfeld) in die Einzelfelder zerlegen. Leeres Feld = alle
 * Einzelfelder leer (z. B. Rechnungsgruppe „wie Kunde“). Ungültige Anschrift → verständliche Meldung.
 */
export function expandAddressBlocks<T extends Record<string, unknown>>(body: T): T {
  const keys = Object.keys(body).filter((k) => k.endsWith('block') && typeof body[k] === 'string');
  if (!keys.length) return body;
  const out: Record<string, unknown> = { ...body };
  for (const k of keys) {
    const p = k.slice(0, -'block'.length);
    if (!p.endsWith('_')) continue;
    const text = (body[k] as string).trim();
    let a: AddressParts = { name: '', name2: null, contactName: null, street: '', postalCode: '', city: '' };
    if (text) {
      try {
        a = parseAddressBlock(text);
      } catch (e) {
        if (e instanceof AddressBlockError) throw new BusinessError(e.message);
        throw e;
      }
    }
    out[`${p}name`] = a.name;
    out[`${p}name2`] = a.name2 ?? '';
    // Ansprechpartner: aus „z. Hd. …“; hat das Formular dafür ein eigenes Feld (Rechnungsgruppe), bleibt es ohne
    // z.-Hd.-Zeile unverändert
    for (const ck of [`${p}contact`, `${p}contact_name`])
      if (a.contactName || !(ck in body)) out[ck] = a.contactName ?? '';
    out[`${p}street`] = a.street;
    out[`${p}postal_code`] = a.postalCode;
    out[`${p}city`] = a.city;
  }
  return out as T;
}

/** Anschrift als ein Textfeld mit Zeilenumbrüchen (wie Fortytools). */
export const AddressBlock = (p: {
  id: string;
  name?: string;
  value: Partial<AddressParts> | null | undefined;
  required?: boolean;
  label?: string;
}) => (
  <div class="addr-block">
    <label for={p.id}>{p.label ?? 'Anschrift'}</label>
    <textarea
      id={p.id}
      name={p.name ?? 'bill_block'}
      rows={6}
      required={p.required}
      style="font-family:inherit;line-height:1.45;max-width:460px"
      placeholder={'Firma\nAbteilung / Zusatz\nz. Hd. Frau Muster\nStraße 1\n81375 München'}
    >
      {formatAddressBlock(p.value)}
    </textarea>
    <div class="small mut">
      Eine Zeile je Zeile im Brief: Name, ggf. Zusatz, ggf. „z. Hd. …“, Straße bzw. Postfach, zuletzt „PLZ
      Ort“.
    </div>
  </div>
);
