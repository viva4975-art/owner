/*
 * Arbeitgeberkosten eines Monatsentgelts für die Plan-Kalkulation (Ahmed 23.10.):
 *  - Minijob (Beschäftigungsart Minijob bzw. Entgelt bis zur Minijobgrenze): Pauschalabgaben auf das Entgelt
 *  - Midijob / Übergangsbereich (über Minijobgrenze bis 2.000 €): AG-Anteil = Gesamtbeitrag aus BE − AN-Anteil aus BE2
 *    (§ 20 Abs. 2a SGB IV, Faktor F = 28 % ÷ Gesamtsozialversicherungsbeitragssatz)
 *  - regulär: AG-Anteil Sozialversicherung
 * Dazu Umlagen (nicht beim Minijob – dort in der Pauschale) und Unfallversicherung auf das Entgelt.
 * Schätzung für die Kalkulation – die Lohnabrechnung rechnet je Person genau (Kasse, Kinder, Beitragsgruppen).
 */

export interface PlanCostRates {
  sv_employer_bp: number;
  sv_employee_bp: number;
  levies_bp: number;
  accident_bp: number;
  minijob_flat_bp: number;
  minijob_limit_cents: bigint;
  midijob_upper_cents: bigint;
  absence_bp: number;
}

export type PayBand = 'minijob' | 'midijob' | 'regulaer';

export const PAY_BAND_LABEL: Record<PayBand, string> = {
  minijob: 'Minijob',
  midijob: 'Midijob',
  regulaer: 'regulär',
};

/**
 * Beschäftigung: „minijob“ = Beschäftigungsart Minijob, „sv“ = sozialversicherungspflichtig (Teilzeit, Vollzeit …) –
 * dann nie Minijob, auch wenn im Plan weniger als die Minijobgrenze steht; null = nur nach Lohnhöhe.
 */
export type EmploymentKind = 'minijob' | 'sv' | null;

export function payBand(grossCents: bigint, kind: EmploymentKind, r: PlanCostRates): PayBand {
  if (kind === 'minijob' || (kind === null && grossCents <= r.minijob_limit_cents)) return 'minijob';
  return grossCents <= r.midijob_upper_cents ? 'midijob' : 'regulaer';
}

/** AG-Anteil Sozialversicherung im Übergangsbereich (ohne Umlagen/Unfall), in Cent (Gleitkomma). */
function midijobEmployerShare(ae: number, r: PlanCostRates): number {
  const g = Number(r.minijob_limit_cents);
  // unter der Untergrenze (nur bei unvollständigem Plan): Satz an der Untergrenze
  if (ae <= g) return (ae * midijobEmployerShare(g + 1, r)) / (g + 1);
  const og = Number(r.midijob_upper_cents);
  const total = (r.sv_employer_bp + r.sv_employee_bp) / 10000;
  const f = 0.28 / total;
  const be = f * g + (og / (og - g) - (g / (og - g)) * f) * (ae - g);
  const be2 = (og / (og - g)) * (ae - g);
  return be * total - (be2 * r.sv_employee_bp) / 10000;
}

/** Arbeitgeberkosten über dem Bruttoentgelt eines Monats (Cent, kaufmännisch gerundet). */
export function employerCost(
  grossCents: bigint,
  kind: EmploymentKind,
  r: PlanCostRates,
): { band: PayBand; costCents: bigint } {
  const band = payBand(grossCents, kind, r);
  if (grossCents <= 0n) return { band, costCents: 0n };
  const ae = Number(grossCents);
  let cost: number;
  if (band === 'minijob') cost = (ae * (r.minijob_flat_bp + r.accident_bp)) / 10000;
  else {
    const sv = band === 'midijob' ? midijobEmployerShare(ae, r) : (ae * r.sv_employer_bp) / 10000;
    cost = sv + (ae * (r.levies_bp + r.accident_bp)) / 10000;
  }
  return { band, costCents: BigInt(Math.round(cost)) };
}
