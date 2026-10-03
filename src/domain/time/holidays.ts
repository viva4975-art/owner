/**
 * Gesetzliche Feiertage in Bayern. Mariä Himmelfahrt (15.08.) gilt nur in Gemeinden mit überwiegend
 * katholischer Bevölkerung – München und Umland ja, daher standardmäßig enthalten.
 * Augsburger Friedensfest (08.08.) nur in Augsburg → nicht enthalten.
 */

/** Ostersonntag (Gauß/Meeus) als 'YYYY-MM-DD'. */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ISO-Wochentag: 1 = Montag … 7 = Sonntag */
export function isoWeekday(date: string): number {
  const w = new Date(`${date}T12:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
}

const cache = new Map<number, Map<string, string>>();

export function holidaysBavaria(year: number, opts: { assumption?: boolean } = {}): Map<string, string> {
  const key = year * 10 + (opts.assumption === false ? 0 : 1);
  const hit = cache.get(key);
  if (hit) return hit;
  const e = easterSunday(year);
  const y = (md: string) => `${year}-${md}`;
  const list: [string, string][] = [
    [y('01-01'), 'Neujahr'],
    [y('01-06'), 'Heilige Drei Könige'],
    [addDays(e, -2), 'Karfreitag'],
    [addDays(e, 1), 'Ostermontag'],
    [y('05-01'), 'Tag der Arbeit'],
    [addDays(e, 39), 'Christi Himmelfahrt'],
    [addDays(e, 50), 'Pfingstmontag'],
    [addDays(e, 60), 'Fronleichnam'],
    [y('10-03'), 'Tag der Deutschen Einheit'],
    [y('11-01'), 'Allerheiligen'],
    [y('12-25'), '1. Weihnachtstag'],
    [y('12-26'), '2. Weihnachtstag'],
  ];
  if (opts.assumption !== false) list.push([y('08-15'), 'Mariä Himmelfahrt']);
  const m = new Map(list.sort(([a], [b]) => a.localeCompare(b)));
  cache.set(key, m);
  return m;
}

export function holidayName(date: string): string | undefined {
  return holidaysBavaria(Number(date.slice(0, 4))).get(date);
}

/** Arbeitstage (Mo–Fr ohne Feiertage) zwischen zwei Daten einschließlich. */
export function workingDays(from: string, to: string): number {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (isoWeekday(d) <= 5 && !holidayName(d)) n++;
  }
  return n;
}

/** Montag der Woche, in der `date` liegt. */
export function mondayOf(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}
