/**
 * Schulferien Bayern (aus der alten App übernommen). Bitte jährlich mit dem Ferienkalender des Kultusministeriums
 * abgleichen und ergänzen – nach Sommer 2027 fehlen die Daten noch.
 */
export const SCHOOL_HOLIDAYS_BY: { name: string; from: string; to: string }[] = [
  { name: 'Faschingsferien 2025', from: '2025-03-03', to: '2025-03-07' },
  { name: 'Osterferien 2025', from: '2025-04-14', to: '2025-04-26' },
  { name: 'Pfingstferien 2025', from: '2025-06-10', to: '2025-06-21' },
  { name: 'Sommerferien 2025', from: '2025-08-01', to: '2025-09-15' },
  { name: 'Herbstferien 2025', from: '2025-11-03', to: '2025-11-07' },
  { name: 'Weihnachtsferien 2025', from: '2025-12-22', to: '2026-01-05' },
  { name: 'Faschingsferien 2026', from: '2026-02-16', to: '2026-02-20' },
  { name: 'Osterferien 2026', from: '2026-03-30', to: '2026-04-10' },
  { name: 'Pfingstferien 2026', from: '2026-05-26', to: '2026-06-05' },
  { name: 'Sommerferien 2026', from: '2026-08-03', to: '2026-09-14' },
  { name: 'Herbstferien 2026', from: '2026-11-02', to: '2026-11-06' },
  { name: 'Weihnachtsferien 2026', from: '2026-12-24', to: '2027-01-08' },
  { name: 'Faschingsferien 2027', from: '2027-02-08', to: '2027-02-12' },
  { name: 'Osterferien 2027', from: '2027-03-22', to: '2027-04-02' },
  { name: 'Pfingstferien 2027', from: '2027-05-18', to: '2027-05-28' },
  { name: 'Sommerferien 2027', from: '2027-07-30', to: '2027-09-13' },
];

export function schoolHoliday(date: string): string | undefined {
  return SCHOOL_HOLIDAYS_BY.find((f) => date >= f.from && date <= f.to)?.name;
}

/** Buß- und Bettag: Mittwoch vor dem 23. November – in Bayern schulfrei (kein gesetzlicher Feiertag). */
export function bussUndBettag(year: number): string {
  const d = new Date(Date.UTC(year, 10, 22, 12));
  const back = (d.getUTCDay() - 3 + 7) % 7; // 3 = Mittwoch
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** Letzter Tag, bis zu dem Ferientermine vorliegen. */
export const SCHOOL_DATA_UNTIL = SCHOOL_HOLIDAYS_BY.reduce((m, f) => (f.to > m ? f.to : m), '');

/** Alle schulfreien Zeiträume Bayern: Ferien + Buß- und Bettag (je Jahr der Ferienliste). */
export function schoolFreePeriods(): { name: string; from: string; to: string }[] {
  const years = [...new Set(SCHOOL_HOLIDAYS_BY.map((f) => Number(f.from.slice(0, 4))))];
  const extra = years.map((y) => ({
    name: `Buß- und Bettag ${y}`,
    from: bussUndBettag(y),
    to: bussUndBettag(y),
  }));
  return [...SCHOOL_HOLIDAYS_BY, ...extra]
    .filter((p) => !SCHOOL_HOLIDAYS_BY.some((f) => f !== p && p.from >= f.from && p.to <= f.to))
    .sort((a, b) => a.from.localeCompare(b.from));
}
