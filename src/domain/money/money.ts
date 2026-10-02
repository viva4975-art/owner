/**
 * Cent-genaue Beträge. Alle Geldbeträge sind ganze Cent als `bigint` – nie `number`,
 * damit keine Fließkomma-Fehler entstehen (0,1 + 0,2 ≠ 0,3).
 *
 * Mengen (Stunden, Stück, m²) haben bis zu 3 Nachkommastellen und werden als ganze
 * Tausendstel gespeichert (`Quantity`).
 */

export type Cents = bigint & { readonly __brand: 'Cents' };
export type Quantity = bigint & { readonly __brand: 'Quantity' }; // Tausendstel

export const QUANTITY_SCALE = 1000n;

export function cents(value: bigint | number): Cents {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError(`Kein ganzzahliger Cent-Betrag: ${value}`);
    return BigInt(value) as Cents;
  }
  return value as Cents;
}

/** Division mit kaufmännischer Rundung (half-up, weg von 0). */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('Division durch 0');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return negative ? -q : q;
}

const DECIMAL_RE = /^(-)?(\d+)(?:[.,](\d+))?$/;

function parseScaled(input: string, decimals: number, label: string): bigint {
  const normalized = input.trim().replace(/\s/g, '');
  // Deutsches Format "1.234,56" → Tausenderpunkte entfernen, wenn ein Komma folgt.
  const plain = /,/.test(normalized) ? normalized.replace(/\./g, '') : normalized;
  const m = DECIMAL_RE.exec(plain);
  if (!m) throw new RangeError(`Ungültige ${label}: "${input}"`);
  const [, sign, intPart = '0', frac = ''] = m;
  if (frac.length > decimals) {
    throw new RangeError(`${label} "${input}" hat mehr als ${decimals} Nachkommastellen`);
  }
  const scaled = BigInt(intPart + frac.padEnd(decimals, '0'));
  return sign ? -scaled : scaled;
}

/** "1.234,56" | "1234.56" | "12" → Cent. Mehr als 2 Nachkommastellen = Fehler. */
export function parseEuro(input: string): Cents {
  return parseScaled(input, 2, 'Betrag') as Cents;
}

/** "2,5" → 2500n (Tausendstel). */
export function parseQuantity(input: string): Quantity {
  return parseScaled(input, 3, 'Menge') as Quantity;
}

export function quantity(thousandths: bigint): Quantity {
  return thousandths as Quantity;
}

/** Menge × Einzelpreis, auf Cent gerundet. */
export function lineNet(qty: Quantity, unitPrice: Cents): Cents {
  return divRoundHalfUp(qty * unitPrice, QUANTITY_SCALE) as Cents;
}

/** Steuersatz in Basispunkten der Prozent, z. B. 19 % = 1900. */
export type VatRate = number;

export function vatAmount(net: Cents, rateBasisPoints: VatRate): Cents {
  if (!Number.isInteger(rateBasisPoints) || rateBasisPoints < 0) {
    throw new RangeError(`Ungültiger Steuersatz: ${rateBasisPoints}`);
  }
  return divRoundHalfUp(net * BigInt(rateBasisPoints), 10_000n) as Cents;
}

export function sum(values: readonly Cents[]): Cents {
  return values.reduce<bigint>((a, b) => a + b, 0n) as Cents;
}

/** Cent → "1.234,56 €" */
export function formatEuro(value: Cents): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const euros = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const rest = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${euros},${rest} €`;
}

/** Cent → "1234.56" (Format für XRechnung/ZUGFeRD-XML). */
export function toXmlDecimal(value: Cents): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
