import { type DraftLineInput } from '../domain/invoice/calc.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import { BusinessError } from '../services/invoices.js';

/** Cent → Eingabewert "1234,56" (ohne Tausenderpunkte, damit eindeutig). */
export function centsToInput(c: bigint): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  return `${neg ? '-' : ''}${abs / 100n},${(abs % 100n).toString().padStart(2, '0')}`;
}

/** Tausendstel → "2,5" */
export function milliToInput(m: bigint): string {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const frac = (abs % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${abs / 1000n}${frac ? `,${frac}` : ''}`;
}

type Body = Record<string, string | File | (string | File)[]>;

export function arr(body: Body, key: string): string[] {
  const v = body[key] ?? body[`${key}[]`];
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'string' ? x : ''));
}

export function str(body: Body, key: string): string | null {
  const v = body[key];
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t === '' ? null : t;
}

/** Positionen aus dem Formular lesen (leere Zeilen werden ignoriert). */
export function parseLines(body: Body, opts: { allowNegative?: boolean } = {}): DraftLineInput[] {
  const desc = arr(body, 'desc');
  const detail = arr(body, 'detail');
  const qty = arr(body, 'qty');
  const unit = arr(body, 'unit');
  const price = arr(body, 'price');
  const vat = arr(body, 'vat');
  const src = arr(body, 'src');
  const stype = arr(body, 'stype');
  const lps = arr(body, 'lps');
  const lpe = arr(body, 'lpe');
  const isoD = (v: string | undefined) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const out: DraftLineInput[] = [];
  desc.forEach((d, i) => {
    const description = d.trim();
    if (!description && !(price[i] ?? '').trim()) return;
    const n = i + 1;
    if (!description) throw new BusinessError(`Position ${n}: Beschreibung fehlt`);
    let quantity, unitPrice;
    try {
      quantity = parseQuantity(qty[i] || '1');
    } catch {
      throw new BusinessError(`Position ${n}: Menge „${qty[i]}“ ist ungültig (max. 3 Nachkommastellen)`);
    }
    try {
      unitPrice = parseEuro(price[i] || '');
    } catch {
      throw new BusinessError(
        `Position ${n}: Einzelpreis „${price[i]}“ ist ungültig (max. 2 Nachkommastellen)`,
      );
    }
    if (unitPrice < 0n)
      throw new BusinessError(`Position ${n}: Einzelpreis darf nicht negativ sein – Menge negativ angeben`);
    if (quantity === 0n) throw new BusinessError(`Position ${n}: Menge darf nicht 0 sein`);
    if (quantity < 0n && !opts.allowNegative) {
      throw new BusinessError(`Position ${n}: negative Mengen sind hier nicht erlaubt`);
    }
    const vatRate = Number(vat[i] || '1900');
    if (![1900, 700, 0].includes(vatRate)) throw new BusinessError(`Position ${n}: Steuersatz nicht erlaubt`);
    out.push({
      description,
      detail: (detail[i] ?? '').trim() || null,
      quantity,
      unitCode: unit[i] || 'C62',
      unitPrice,
      vatRate,
      sourceServiceId: (src[i] ?? '').trim() || null,
      serviceTypeId: /^[0-9a-f-]{36}$/i.test(stype[i] ?? '') ? stype[i]! : null,
      ...(isoD(lps[i]) ? { periodStart: isoD(lps[i]), periodEnd: isoD(lpe[i]) ?? isoD(lps[i]) } : {}),
    });
  });
  return out;
}
