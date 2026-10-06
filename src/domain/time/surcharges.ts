import { addDays, easterSunday, holidayName, isoWeekday } from './holidays.js';

/*
 * Zuschlagsstunden nach Rahmentarifvertrag Gebäudereinigung (RTV vom 31.10.2019, § 10, allgemeinverbindlich):
 * Nachtarbeit (Standard 22–6 Uhr) 30 % (Vorgabe Viva-Deluxe; RTV: 25 %), Sonntag und Feiertag 80 % (Vorgabe Viva-Deluxe; RTV: 100 %/150 %), 80 % bei
 * regelmäßiger Sonn-/Feiertagsarbeit am selben Arbeitsplatz, Neujahr/Ostersonntag/Pfingstsonntag/1. Mai/Weihnachten 200 %.
 * Treffen mehrere Zuschläge zusammen, gilt nur der höchste. Gerechnet wird je Minute der Arbeitszeit ohne Pause,
 * nach Berliner Ortszeit.
 */

export type SurchargeKind = 'nacht' | 'sonntag' | 'feiertag' | 'feiertag_hoch';

export interface SurchargeRates {
  nightFrom: number; // Minuten ab 0:00, z. B. 22 * 60
  nightTo: number; // z. B. 6 * 60
  night: number; // Basispunkte, 2500 = 25 %
  sunday: number;
  sundayRegular: number;
  holiday: number;
  highHoliday: number;
}

export const DEFAULT_RATES: SurchargeRates = {
  nightFrom: 22 * 60,
  nightTo: 6 * 60,
  night: 3000,
  sunday: 8000,
  sundayRegular: 8000,
  holiday: 8000,
  highHoliday: 20000,
};

/** Hohe Feiertage laut RTV: Neujahr, Ostersonntag, Pfingstsonntag, 1. Mai, 25. und 26. Dezember. */
export function isHighHoliday(date: string): boolean {
  const md = date.slice(5);
  if (['01-01', '05-01', '12-25', '12-26'].includes(md)) return true;
  const easter = easterSunday(Number(date.slice(0, 4)));
  return date === easter || date === addDays(easter, 49);
}

const berlin = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Versatz Berlin gegenüber UTC in Minuten zu einem Zeitpunkt. */
function offsetMin(ms: number): number {
  const p = Object.fromEntries(berlin.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!);
  return Math.round((local - Math.floor(ms / 60000) * 60000) / 60000);
}

/**
 * Minuten je Zuschlagsart für eine Arbeitszeit (ohne Pause). Je Minute zählt nur der höchste Zuschlag.
 * `regular` = regelmäßige Sonn-/Feiertagsarbeit am selben Arbeitsplatz (Sonntag 75 % statt 100 %).
 */
export function surchargeMinutes(
  start: Date,
  end: Date,
  breakFrom: Date | null,
  breakTo: Date | null,
  rates: SurchargeRates = DEFAULT_RATES,
  regular = false,
): Record<SurchargeKind, number> {
  const out: Record<SurchargeKind, number> = { nacht: 0, sonntag: 0, feiertag: 0, feiertag_hoch: 0 };
  const s = Math.floor(start.getTime() / 60000) * 60000;
  const e = Math.floor(end.getTime() / 60000) * 60000;
  const bf = breakFrom ? breakFrom.getTime() : 0;
  const bt = breakTo ? breakTo.getTime() : 0;
  const o1 = offsetMin(s);
  const sameOffset = o1 === offsetMin(e);
  const dayCache = new Map<string, { high: boolean; holiday: boolean; sunday: boolean }>();
  const sundayRate = regular ? rates.sundayRegular : rates.sunday;
  for (let t = s; t < e; t += 60000) {
    if (breakFrom && t >= bf && t < bt) continue;
    const local = new Date(t + (sameOffset ? o1 : offsetMin(t)) * 60000);
    const date = local.toISOString().slice(0, 10);
    const minOfDay = local.getUTCHours() * 60 + local.getUTCMinutes();
    let d = dayCache.get(date);
    if (!d) {
      const high = isHighHoliday(date);
      d = { high, holiday: !high && !!holidayName(date), sunday: isoWeekday(date) === 7 };
      dayCache.set(date, d);
    }
    const night =
      rates.nightFrom > rates.nightTo
        ? minOfDay >= rates.nightFrom || minOfDay < rates.nightTo
        : minOfDay >= rates.nightFrom && minOfDay < rates.nightTo;
    // höchster Zuschlag gewinnt
    const cands: [SurchargeKind, number][] = [];
    if (d.high) cands.push(['feiertag_hoch', regular ? sundayRate : rates.highHoliday]);
    if (d.holiday) cands.push(['feiertag', regular ? sundayRate : rates.holiday]);
    if (d.sunday) cands.push(['sonntag', sundayRate]);
    if (night) cands.push(['nacht', rates.night]);
    if (!cands.length) continue;
    cands.sort((a, b) => b[1] - a[1]);
    out[cands[0]![0]]++;
  }
  return out;
}

/** Betrag in Cent: Minuten × Stundenlohn × Satz, kaufmännisch gerundet (ganzzahlig, ohne Gleitkomma). */
export function surchargeCents(minutes: number, wageCents: bigint, bp: number): bigint {
  const num = BigInt(minutes) * wageCents * BigInt(bp);
  const den = 60n * 10000n;
  return (num * 2n + den) / (2n * den);
}
