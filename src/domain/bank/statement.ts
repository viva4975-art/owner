import { create } from 'xmlbuilder2';
import { unescapeXml } from '../xml.js';

/*
 * Kontoauszüge einlesen: CAMT.053 (ISO 20022, Standard der deutschen Banken seit 2014/DK) und CSV-Export
 * (Spalten werden über die Kopfzeile erkannt: Buchungstag, Valuta, Betrag, Verwendungszweck, Name, IBAN).
 * Beträge als ganze Cent, + = Eingang (Gutschrift), − = Ausgang (Lastschrift/Überweisung).
 */

export interface StatementLine {
  accountIban: string | null;
  bookingDate: string; // YYYY-MM-DD
  valueDate: string | null;
  amountCents: bigint;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  purpose: string;
  endToEndId: string | null;
  bankRef: string | null;
}

type Node = Record<string, unknown>;
const arr = (v: unknown): Node[] => (v == null ? [] : Array.isArray(v) ? (v as Node[]) : [v as Node]);
const txt = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === 'string') return unescapeXml(v).trim() || null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object' && '#' in (v as Node)) return txt((v as Node)['#']);
  return null;
};
const get = (n: unknown, ...path: string[]): unknown => {
  let cur: unknown = n;
  for (const p of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    const c = cur as Node;
    cur = Array.isArray(c) ? (c[0] as Node | undefined)?.[p] : c[p];
  }
  return cur;
};

/** „1.234,56“ / „-1234.56“ / „1234,5“ → Cent. Wirft bei unklarem Format. */
export function parseAmount(raw: string): bigint {
  let s = raw.replace(/\s|€|EUR/g, '');
  const neg = /^-|-$/.test(s) || /^\(.*\)$/.test(s);
  s = s.replace(/^[-+(]|[-)]$/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new RangeError(`Betrag nicht lesbar: ${raw}`);
  const c = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  return neg ? -c : c;
}

/** „31.10.2026“, „31.10.26“ oder „2026-10-31“ → YYYY-MM-DD */
export function parseDate(raw: string): string {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(s);
  if (!m) throw new RangeError(`Datum nicht lesbar: ${raw}`);
  const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  return `${y}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
}

export function parseCamt053(xml: string): StatementLine[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new RangeError('XML mit DTD/Entitäten wird nicht verarbeitet');
  const obj = create(xml).end({ format: 'object' }) as Node;
  const docKey = Object.keys(obj).find((k) => /(^|:)Document$/.test(k));
  const doc = docKey ? (obj[docKey] as Node) : undefined;
  const root = doc ? (get(doc, 'BkToCstmrStmt') as Node | undefined) : undefined;
  if (!root) throw new RangeError('Keine CAMT.053-Datei (BkToCstmrStmt fehlt)');
  const out: StatementLine[] = [];
  for (const stmt of arr(root.Stmt)) {
    const iban = txt(get(stmt, 'Acct', 'Id', 'IBAN'));
    for (const e of arr(stmt.Ntry)) {
      if (txt(get(e, 'Sts', 'Cd')) === 'PDNG' || txt(e.Sts) === 'PDNG') continue; // vorgemerkt
      const amt = parseAmount(txt(get(e, 'Amt')) ?? '');
      const sign = txt(e.CdtDbtInd) === 'DBIT' ? -1n : 1n;
      const booking = txt(get(e, 'BookgDt', 'Dt')) ?? txt(get(e, 'BookgDt', 'DtTm'));
      if (!booking) throw new RangeError('Buchungsdatum fehlt');
      const value = txt(get(e, 'ValDt', 'Dt'));
      const details = arr(get(e, 'NtryDtls')).flatMap((d) => arr(d.TxDtls));
      const credit = sign > 0n;
      // Sammelbuchung mit mehreren Einzelumsätzen: je Einzelumsatz eine Zeile (Beträge der TxDtls)
      const parts = details.length > 1 ? details : [details[0] ?? {}];
      parts.forEach((d) => {
        const partyPath = credit ? 'Dbtr' : 'Cdtr';
        const acctPath = credit ? 'DbtrAcct' : 'CdtrAcct';
        const name =
          txt(get(d, 'RltdPties', partyPath, 'Nm')) ?? txt(get(d, 'RltdPties', partyPath, 'Pty', 'Nm'));
        const cpIban = txt(get(d, 'RltdPties', acctPath, 'Id', 'IBAN'));
        const ustrd = arr(get(d, 'RmtInf'))
          .flatMap((r) => (Array.isArray(r.Ustrd) ? (r.Ustrd as unknown[]) : [r.Ustrd]))
          .map(txt)
          .filter(Boolean)
          .join(' ');
        const partAmt =
          details.length > 1 ? (txt(get(d, 'Amt')) ?? txt(get(d, 'AmtDtls', 'TxAmt', 'Amt'))) : null;
        out.push({
          accountIban: iban,
          bookingDate: parseDate(booking),
          valueDate: value ? parseDate(value) : null,
          amountCents: (partAmt ? parseAmount(partAmt) : amt) * sign,
          counterpartyName: name,
          counterpartyIban: cpIban,
          purpose: (ustrd || txt(e.AddtlNtryInf) || '').replace(/\s+/g, ' ').trim(),
          endToEndId: ((v) => (v && v !== 'NOTPROVIDED' ? v : null))(txt(get(d, 'Refs', 'EndToEndId'))),
          bankRef: txt(e.AcctSvcrRef) ?? txt(get(d, 'Refs', 'AcctSvcrRef')),
        });
      });
    }
  }
  return out;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');

export function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** CSV-Export der Bank (Sparkasse, VR-Bank, Targobank u. a.): Kopfzeile wird gesucht, Spalten über Namen erkannt. */
export function parseBankCsv(text: string, accountIban: string | null = null): StatementLine[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const sep = (lines.find((l) => l.includes(';')) ? ';' : ',') as string;
  const COLS = {
    booking: ['buchungstag', 'buchungsdatum', 'datum', 'buchung'],
    value: ['valuta', 'valutadatum', 'wertstellung'],
    amount: ['betrag', 'betrageur', 'umsatz'],
    purpose: ['verwendungszweck', 'buchungstext', 'vorgang', 'zweck'],
    name: [
      'beguenstigterzahlungspflichtiger',
      'namezahlungsbeteiligter',
      'empfaengerauftraggeber',
      'name',
      'auftraggeberempfaenger',
      'zahlungsempfaenger',
      'auftraggeber',
    ],
    iban: ['kontonummeriban', 'ibanzahlungsbeteiligter', 'iban', 'kontonummer'],
    e2e: ['endtoendid', 'endtoendreferenz'],
    own: ['auftragskonto', 'ibanauftragskonto'],
  } as const;
  const headerIdx = lines.findIndex((l) => {
    const cells = splitCsvLine(l, sep).map(norm);
    return (
      cells.some((c) => (COLS.booking as readonly string[]).includes(c)) &&
      cells.some((c) => (COLS.amount as readonly string[]).includes(c))
    );
  });
  if (headerIdx < 0) throw new RangeError('CSV: Kopfzeile mit Buchungstag und Betrag nicht gefunden');
  const head = splitCsvLine(lines[headerIdx]!, sep).map(norm);
  const col = (names: readonly string[]) => {
    for (const n of names) {
      const i = head.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const c = Object.fromEntries(Object.entries(COLS).map(([k, v]) => [k, col(v)])) as Record<
    keyof typeof COLS,
    number
  >;
  // mehrere Zweck-Spalten (z. B. „Verwendungszweck 1..14“) zusammenfassen
  const purposeCols = head.map((h, i) => (h.startsWith('verwendungszweck') ? i : -1)).filter((i) => i >= 0);
  const out: StatementLine[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line, sep);
    const at = (i: number) => (i >= 0 ? (cells[i] ?? '').trim() : '');
    if (!at(c.booking) || !at(c.amount)) continue;
    const purpose = (purposeCols.length ? purposeCols.map(at) : [at(c.purpose)]).filter(Boolean).join(' ');
    out.push({
      accountIban: at(c.own).replace(/\s/g, '') || accountIban,
      bookingDate: parseDate(at(c.booking)),
      valueDate: at(c.value) ? parseDate(at(c.value)) : null,
      amountCents: parseAmount(at(c.amount)),
      counterpartyName: at(c.name) || null,
      counterpartyIban: at(c.iban).replace(/\s/g, '') || null,
      purpose: purpose.replace(/\s+/g, ' ').trim(),
      endToEndId: at(c.e2e) && at(c.e2e) !== 'NOTPROVIDED' ? at(c.e2e) : null,
      bankRef: null,
    });
  }
  return out;
}

/** Rechnungsnummern im Verwendungszweck (Fortytools-Format 7-stellig, z. B. 1038301; auch „RE 1038301“, „Re.-Nr.1038301“). */
export function invoiceNumbersIn(purpose: string, known: (n: string) => boolean): string[] {
  const found = new Set<string>();
  for (const m of purpose.matchAll(/(?<![\d])(\d{6,8})(?![\d])/g)) if (known(m[1]!)) found.add(m[1]!);
  for (const m of purpose.matchAll(/\b(RE-\d{4}-\d{3,6})\b/gi))
    if (known(m[1]!.toUpperCase())) found.add(m[1]!.toUpperCase());
  return [...found];
}
