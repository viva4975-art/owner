/**
 * Anschrift als ein Textfeld wie in Fortytools (Ahmed 21.10.): eine Zeile im Feld = eine Zeile im Brief.
 * Gespeichert wird weiter aufgeteilt (Name, Zusatz, z. Hd., Straße, PLZ, Ort) – die E-Rechnung braucht die Teile.
 * Regel: erste Zeile Name, vorletzte Straße/Postfach, letzte „PLZ Ort“; Zeilen dazwischen Zusatz
 * (mehrere Zeilen bleiben Zeilen), eine Zeile „z. Hd. …“ = Ansprechpartner.
 */
export interface AddressParts {
  name: string;
  name2: string | null;
  contactName: string | null;
  street: string;
  postalCode: string;
  city: string;
}

const CONTACT = /^(?:z\.\s*H(?:d|än)\.?|zu\s+H(?:ä|ae)nden|z\.?\s*Hd\.?)\s*:?\s*/i;

export function formatAddressBlock(a: Partial<AddressParts> | null | undefined): string {
  if (!a) return '';
  return [
    a.name,
    ...(a.name2 ?? '').split('\n'),
    a.contactName ? `z. Hd. ${a.contactName}` : null,
    a.street,
    [a.postalCode, a.city].filter(Boolean).join(' '),
  ]
    .map((x) => (x ?? '').trim())
    .filter(Boolean)
    .join('\n');
}

export class AddressBlockError extends Error {}

export function parseAddressBlock(text: string): AddressParts {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (lines.length < 3)
    throw new AddressBlockError('Anschrift: mindestens Name, Straße und „PLZ Ort“ – je eine Zeile');
  if (lines.length > 8) throw new AddressBlockError('Anschrift: höchstens 8 Zeilen');
  const m = /^(?:D(?:E)?\s*-?\s*)?(\d{5})\s+(.+)$/i.exec(lines[lines.length - 1]!);
  if (!m) throw new AddressBlockError('Anschrift: letzte Zeile „PLZ Ort“, z. B. 81375 München');
  const middle = lines.slice(1, -2);
  let contactName: string | null = null;
  const rest: string[] = [];
  for (const l of middle) {
    if (!contactName && CONTACT.test(l)) contactName = l.replace(CONTACT, '').trim() || null;
    else rest.push(l);
  }
  return {
    name: lines[0]!,
    name2: rest.length ? rest.join('\n') : null,
    contactName,
    street: lines[lines.length - 2]!,
    postalCode: m[1]!,
    city: m[2]!.trim(),
  };
}
