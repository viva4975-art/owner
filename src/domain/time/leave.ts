/**
 * Urlaubsanspruch laut Rahmentarifvertrag Gebäudereinigung (Ahmed 12.10.2026): 30 Arbeitstage im Jahr bei einer
 * 5-Tage-Woche, für alle gleich. Bei weniger/mehr Arbeitstagen anteilig (Tage ÷ 5); im Ein-/Austrittsjahr nach § 5 BUrlG.
 */
export const LEAVE_DAYS_5DAY = 30;

/** Jahresanspruch für eine Wochen-Arbeitstage-Zahl (auf halbe Tage gerundet). */
export const leaveDaysForWeek = (daysPerWeek: number) =>
  Math.round(((LEAVE_DAYS_5DAY * daysPerWeek) / 5) * 2) / 2;
