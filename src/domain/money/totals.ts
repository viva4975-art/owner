import { type Cents, type Quantity, type VatRate, lineNet, sum, vatAmount } from './money.js';

export interface TotalsLine {
  quantity: Quantity;
  unitPrice: Cents;
  vatRate: VatRate;
}

export interface VatBreakdown {
  vatRate: VatRate;
  taxableAmount: Cents;
  taxAmount: Cents;
}

export interface InvoiceTotals {
  lines: Cents[];
  netTotal: Cents;
  vat: VatBreakdown[];
  vatTotal: Cents;
  grossTotal: Cents;
}

/**
 * Rechnungssummen nach EN 16931: Positionen werden auf Cent gerundet, die USt wird je
 * Steuersatz auf die Summe der Positionen berechnet (BR-CO-17), nicht je Position.
 */
export function computeTotals(lines: readonly TotalsLine[]): InvoiceTotals {
  const lineAmounts = lines.map((l) => lineNet(l.quantity, l.unitPrice));
  const byRate = new Map<VatRate, Cents[]>();
  lines.forEach((l, i) => {
    const list = byRate.get(l.vatRate) ?? [];
    list.push(lineAmounts[i] as Cents);
    byRate.set(l.vatRate, list);
  });
  const vat = [...byRate.entries()]
    .sort(([a], [b]) => b - a)
    .map(([vatRate, amounts]) => {
      const taxableAmount = sum(amounts);
      return { vatRate, taxableAmount, taxAmount: vatAmount(taxableAmount, vatRate) };
    });
  const netTotal = sum(lineAmounts);
  const vatTotal = sum(vat.map((v) => v.taxAmount));
  return { lines: lineAmounts, netTotal, vat, vatTotal, grossTotal: (netTotal + vatTotal) as Cents };
}
