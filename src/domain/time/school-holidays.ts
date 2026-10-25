/**
 * Schulferien Bayern (bis 2027 aus der alten App, danach laut Ferienordnung des Kultusministeriums für die
 * Schuljahre bis 2029/30). Die Herbst- und Weihnachtsferien 2030/31 sind noch nicht festgelegt – nach Sommer 2030
 * fehlen die Daten; dann mit der neuen Ferienordnung ergänzen.
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
  { name: 'Herbstferien 2027', from: '2027-11-02', to: '2027-11-05' },
  { name: 'Weihnachtsferien 2027', from: '2027-12-24', to: '2028-01-07' },
  { name: 'Faschingsferien 2028', from: '2028-02-28', to: '2028-03-03' },
  { name: 'Osterferien 2028', from: '2028-04-10', to: '2028-04-21' },
  { name: 'Pfingstferien 2028', from: '2028-06-06', to: '2028-06-16' },
  { name: 'Sommerferien 2028', from: '2028-07-31', to: '2028-09-11' },
  { name: 'Herbstferien 2028', from: '2028-10-30', to: '2028-11-03' },
  { name: 'Weihnachtsferien 2028', from: '2028-12-23', to: '2029-01-05' },
  { name: 'Faschingsferien 2029', from: '2029-02-12', to: '2029-02-16' },
  { name: 'Osterferien 2029', from: '2029-03-26', to: '2029-04-06' },
  { name: 'Pfingstferien 2029', from: '2029-05-22', to: '2029-06-01' },
  { name: 'Sommerferien 2029', from: '2029-07-30', to: '2029-09-10' },
  { name: 'Herbstferien 2029', from: '2029-10-29', to: '2029-11-02' },
  { name: 'Weihnachtsferien 2029', from: '2029-12-24', to: '2030-01-04' },
  { name: 'Faschingsferien 2030', from: '2030-03-04', to: '2030-03-08' },
  { name: 'Osterferien 2030', from: '2030-04-15', to: '2030-04-26' },
  { name: 'Pfingstferien 2030', from: '2030-06-11', to: '2030-06-21' },
  { name: 'Sommerferien 2030', from: '2030-07-29', to: '2030-09-09' },
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
