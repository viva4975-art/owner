/**
 * Soll-Stunden aus Wochenstunden (Ahmed 09.10.: „bei Planungen gehen wir immer von 4,33 Wochen aus“).
 * Ein voller Monat = Wochenstunden × 4,33 – unabhängig von Feiertagen und Zahl der Arbeitstage. Angebrochene Monate
 * (Eintritt, Austritt, Stundenänderung) anteilig nach Kalendertagen.
 */
export const WEEKS_PER_MONTH = 4.33;

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayNo = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;

/** Soll-Minuten für Wochenstunden `hours` im Zeitraum [from, to] (JJJJ-MM-TT, beide einschließlich). */
export function sollMinutesFor(hours: number, from: string, to: string): number {
  if (!hours || from > to) return 0;
  let total = 0;
  let y = +from.slice(0, 4);
  let m = +from.slice(5, 7);
  for (;;) {
    const dim = daysInMonth(y, m);
    const mFrom = `${y}-${String(m).padStart(2, '0')}-01`;
    const mTo = `${y}-${String(m).padStart(2, '0')}-${String(dim).padStart(2, '0')}`;
    const s = from > mFrom ? from : mFrom;
    const e = to < mTo ? to : mTo;
    if (s <= e) total += (hours * 60 * WEEKS_PER_MONTH * (dayNo(e) - dayNo(s) + 1)) / dim;
    if (mTo >= to) break;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return Math.round(total);
}
