/*
 * Prüfung von Steuer-ID und Sozialversicherungsnummer (Ahmed 12.10.: „immer prüfen lassen“).
 * Nur Format und Prüfziffer – ob die Nummer wirklich vergeben ist, kann nur das Finanzamt bzw. die
 * Rentenversicherung sagen (ELStAM-Abruf bzw. DEÜV-Meldung über das Lohnprogramm).
 */

/** Steuer-ID ohne Leerzeichen/Punkte/Striche. */
export const normTaxId = (s: string) => s.replace(/[\s./-]/g, '');

/**
 * Steuerliche Identifikationsnummer (§ 139b AO): 11 Ziffern, erste nicht 0, in den ersten 10 Ziffern
 * kommt genau eine Ziffer zwei- oder dreimal vor (bei dreimal nicht direkt hintereinander), Prüfziffer
 * nach ISO 7064 MOD 11,10.
 */
export function validTaxId(raw: string): boolean {
  const s = normTaxId(raw);
  if (!/^[1-9]\d{10}$/.test(s)) return false;
  const d = [...s].map(Number);
  const counts = new Map<number, number>();
  for (const x of d.slice(0, 10)) counts.set(x, (counts.get(x) ?? 0) + 1);
  const multi = [...counts.entries()].filter(([, n]) => n > 1);
  if (multi.length !== 1 || multi[0]![1] > 3) return false;
  if (multi[0]![1] === 3) {
    const x = multi[0]![0];
    for (let i = 0; i < 8; i++) if (d[i] === x && d[i + 1] === x && d[i + 2] === x) return false;
  }
  let product = 10;
  for (let i = 0; i < 10; i++) {
    let sum = (d[i]! + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }
  let check = 11 - product;
  if (check === 10) check = 0;
  return check === d[10];
}

/** SV-Nummer ohne Leerzeichen, Großbuchstaben. */
export const normSvNumber = (s: string) => s.replace(/[\s./-]/g, '').toUpperCase();

/**
 * Versicherungsnummer der Rentenversicherung (§ 147 SGB VI, VKVV): 2 Ziffern Bereich, 6 Ziffern
 * Geburtsdatum TTMMJJ, Anfangsbuchstabe des Geburtsnamens, 2 Ziffern Seriennummer, 1 Prüfziffer.
 * Prüfziffer: Buchstabe → zweistellige Zahl (A = 01 … Z = 26), Gewichte 2 1 2 5 7 1 2 1 2 1 2 1,
 * je Produkt die Quersumme, Summe modulo 10.
 */
export function validSvNumber(raw: string): boolean {
  const s = normSvNumber(raw);
  const m = /^(\d{8})([A-Z])(\d{3})$/.exec(s);
  if (!m) return false;
  const day = Number(s.slice(2, 4));
  const month = Number(s.slice(4, 6));
  // Tag kann um 50 erhöht sein (Vergabe bei vielen gleichen Geburtsdaten)
  if (!((day >= 1 && day <= 31) || (day >= 51 && day <= 81)) || month < 1 || month > 12) return false;
  const letter = String(m[2]!.charCodeAt(0) - 64).padStart(2, '0');
  const digits = [...(m[1]! + letter + m[3]!.slice(0, 2))].map(Number);
  const weights = [2, 1, 2, 5, 7, 1, 2, 1, 2, 1, 2, 1];
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const p = digits[i]! * weights[i]!;
    sum += Math.floor(p / 10) + (p % 10);
  }
  return sum % 10 === Number(m[3]![2]);
}
