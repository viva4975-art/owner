import { createHash } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import { unzipSync } from 'fflate';
import { extractText, getDocumentProxy } from 'unpdf';
import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';
import { storeFile, type UploadConfig } from './uploads.js';

/*
 * Lohnabrechnungen (Ahmed 08.10.: „jede einzeln einzufügen wäre zu kompliziert – automatisch aus einer ZIP?“):
 * ZIP mit Einzel-PDFs oder eine Sammel-PDF aus dem Lohnprogramm hochladen. Je PDF bzw. Seite wird die Personalnummer
 * gesucht (Text „Pers.-Nr.“/„Personalnummer“, sonst Dateiname); Folgeseiten ohne Nummer gehören zur vorigen Person.
 * Ergebnis je Mitarbeiter ein PDF in der Personalakte (Kategorie „Lohnabrechnung“, write-once) und auf Wunsch in der
 * Mitarbeiter-App. Nicht zuordenbare Seiten werden gemeldet, nichts wird geraten.
 */

const uuidFrom = (s: string) => {
  const h = createHash('md5').update(s).digest('hex').split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16]!, 16) % 4]!;
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

/** Personalnummer im Text: zuerst ausdrücklich beschriftet, sonst eine bekannte Nummer als eigenes Wort. */
export function findPersonnelNo(text: string, known: Set<string>): string | null {
  const m =
    /(?:Pers(?:onal)?\.?\s*-?\s*(?:Nr|Nummer)\.?|Personalnummer|Mitarbeiter(?:-?Nr\.?|nummer))\s*:?\s*(\d{1,8})/i.exec(
      text,
    );
  if (m && known.has(m[1]!.replace(/^0+(?=\d)/, ''))) return m[1]!.replace(/^0+(?=\d)/, '');
  if (m && known.has(m[1]!)) return m[1]!;
  const hits = new Set<string>();
  for (const w of text.match(/\b\d{3,6}\b/g) ?? []) if (known.has(w)) hits.add(w);
  return hits.size === 1 ? [...hits][0]! : null;
}

const MONTHS_DE = [
  'januar',
  'februar',
  'märz',
  'april',
  'mai',
  'juni',
  'juli',
  'august',
  'september',
  'oktober',
  'november',
  'dezember',
];
/**
 * Dateiname aus Lexware (Financial Office / lohn+gehalt), z. B.
 * „Lohnabrechnung_2025_August_1234_Ozog_Jakub.pdf“ → Personalnummer 1234, Monat 2025-08.
 * Umlaute stehen in der ZIP teils als „#U00e4“.
 */
export function lexwareName(name: string): { no: string; month: string } | null {
  const base = (name.split('/').pop() ?? name).replace(/#U([0-9a-f]{4})/gi, (_, h: string) =>
    String.fromCharCode(parseInt(h, 16)),
  );
  const m = /Lohnabrechnung_(\d{4})_([A-Za-zÄÖÜäöü]+)_(\d{1,8})_/i.exec(base);
  if (!m) return null;
  const mi = MONTHS_DE.indexOf(m[2]!.toLowerCase());
  if (mi < 0) return null;
  return { no: m[3]!.replace(/^0+(?=\d)/, ''), month: `${m[1]}-${String(mi + 1).padStart(2, '0')}` };
}

/**
 * Abrechnungsmonat aus dem Text der Abrechnung (andere Lohnprogramme): „Abrechnungsmonat: August 2025“,
 * „Abrechnung für August 2025“, „Zeitraum 08/2025“ … – nur ausdrücklich beschriftet, sonst nichts geraten.
 */
export function monthFromText(text: string): string | null {
  const t = text.replace(/\s+/g, ' ');
  const label =
    '(?:Abrechnungs(?:monat|zeitraum)|Abrechnung (?:für|vom)|Lohnabrechnung|Gehaltsabrechnung|Monat)';
  const named = new RegExp(`${label}\\s*:?\\s*(${MONTHS_DE.join('|')}|Maerz)\\s+(20\\d\\d)`, 'i').exec(t);
  if (named) {
    const w = named[1]!.toLowerCase() === 'maerz' ? 'märz' : named[1]!.toLowerCase();
    return `${named[2]}-${String(MONTHS_DE.indexOf(w) + 1).padStart(2, '0')}`;
  }
  const num = new RegExp(`${label}\\s*:?\\s*(0?[1-9]|1[0-2])\\s*[/.]\\s*(20\\d\\d)`, 'i').exec(t);
  if (num) return `${num[2]}-${num[1]!.padStart(2, '0')}`;
  return null;
}

/** „2025-08“ → „August 2025“ */
export const monthLabel = (m: string) => {
  const n = MONTHS_DE[Number(m.slice(5, 7)) - 1] ?? '';
  return `${n.charAt(0).toUpperCase()}${n.slice(1)} ${m.slice(0, 4)}`;
};

/** Dateiname in der Personalakte: Monat zuerst, damit man ihn sofort sieht – „Lohnabrechnung 2025-08 August 2025 – Name (1234).pdf“ */
export const payslipFileName = (month: string, name: string, no: string) =>
  `Lohnabrechnung ${month} ${monthLabel(month)} – ${name.replace(/[\\/:*?"<>|]/g, '')} (${no}).pdf`.slice(
    0,
    200,
  );

async function pageTexts(pdf: Uint8Array): Promise<string[]> {
  const doc = await getDocumentProxy(pdf.slice());
  const { text } = await extractText(doc, { mergePages: false });
  return text as string[];
}

export interface PayslipReport {
  assigned: { personnel_no: string; name: string; pages: number; fileId: string; month: string }[];
  unassigned: string[];
  /** erkannte Abrechnungsmonate mit Anzahl (gemischte ZIP möglich) */
  months: { month: string; count: number }[];
}

export async function importPayslips(
  sql: Sql,
  cfg: UploadConfig,
  /** month: nur Ausweichwert, wenn Dateiname und Text keinen Monat nennen */
  p: { name: string; bytes: Uint8Array; month?: string; release: boolean; actor: string },
): Promise<PayslipReport> {
  const emps = await sql<{ id: string; personnel_no: string; name: string }[]>`
    select id, personnel_no, first_name || ' ' || last_name as name from app.employees`;
  const known = new Set(emps.map((e) => e.personnel_no));
  const byNo = new Map(emps.map((e) => [e.personnel_no, e]));
  // Quellen: ZIP → je PDF; PDF → eine Quelle
  const isZip = p.bytes[0] === 0x50 && p.bytes[1] === 0x4b;
  const sources: { name: string; data: Uint8Array }[] = [];
  if (isZip) {
    const files = unzipSync(p.bytes);
    for (const [n, d] of Object.entries(files))
      if (/\.pdf$/i.test(n) && !n.startsWith('__MACOSX')) sources.push({ name: n, data: d });
    if (!sources.length) throw new BusinessError('In der ZIP sind keine PDF-Dateien');
  } else if (new TextDecoder().decode(p.bytes.slice(0, 5)) === '%PDF-')
    sources.push({ name: p.name, data: p.bytes });
  else throw new BusinessError('Bitte eine PDF- oder ZIP-Datei hochladen');
  const fallback = p.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(p.month) ? p.month : null;

  // je Person und Monat gesammelte Seiten (Quelle + Seitenindex); Monat je Datei bzw. Seite erkannt
  const parts = new Map<string, { src: Uint8Array; pages: number[] }[]>();
  const unassigned: string[] = [];
  for (const s of sources) {
    let texts: string[];
    try {
      texts = await pageTexts(s.data);
    } catch {
      unassigned.push(`${s.name}: PDF nicht lesbar`);
      continue;
    }
    const lex = lexwareName(s.name);
    if (lex && !known.has(lex.no)) {
      unassigned.push(`${s.name.split('/').pop()}: Personalnummer ${lex.no} gibt es in der App nicht`);
      continue;
    }
    const fromName =
      lex && known.has(lex.no) ? lex.no : findPersonnelNo(s.name.replace(/[_.-]/g, ' '), known);
    let current: string | null = null;
    let curMonth: string | null = null;
    texts.forEach((t, i) => {
      // Lexware-Datei: Dateiname ist eindeutig (eine Person je Datei) und geht vor
      const no =
        (lex && fromName) || findPersonnelNo(t, known) || (sources.length > 1 ? fromName : null) || current;
      if (!no) {
        unassigned.push(`${s.name}, Seite ${i + 1}: keine Personalnummer gefunden`);
        return;
      }
      // Monat: Lexware-Dateiname, sonst Text der Seite, sonst wie die vorige Seite, sonst die Auswahl
      const month = lex?.month ?? monthFromText(t) ?? (current === no ? curMonth : null) ?? fallback;
      if (!month) {
        unassigned.push(
          `${s.name.split('/').pop()}, Seite ${i + 1}: Abrechnungsmonat nicht erkannt – bitte Monat wählen`,
        );
        return;
      }
      current = no;
      curMonth = month;
      const key = `${no}|${month}`;
      const list = parts.get(key) ?? [];
      const last = list.at(-1);
      if (last && last.src === s.data) last.pages.push(i);
      else list.push({ src: s.data, pages: [i] });
      parts.set(key, list);
    });
  }
  const assigned: PayslipReport['assigned'] = [];
  const monthCount = new Map<string, number>();
  for (const [key, list] of parts) {
    const [no, month] = key.split('|') as [string, string];
    const e = byNo.get(no)!;
    const out = await PDFDocument.create();
    let pages = 0;
    for (const part of list) {
      const src = await PDFDocument.load(part.src, { ignoreEncryption: true });
      for (const pg of await out.copyPages(src, part.pages)) out.addPage(pg);
      pages += part.pages.length;
    }
    out.setTitle(`Lohnabrechnung ${monthLabel(month)} ${e.name}`);
    // feste Zeitstempel: dieselbe Quelle ergibt dieselbe Datei (erneut hochladen legt nichts doppelt an)
    out.setCreationDate(new Date(`${month}-01T00:00:00Z`));
    out.setModificationDate(new Date(`${month}-01T00:00:00Z`));
    const bytes = await out.save({ useObjectStreams: false });
    // ID aus Quelle + Seiten, nicht aus den erzeugten Bytes
    const srcKey = list
      .map((x) => `${createHash('sha256').update(x.src).digest('hex')}:${x.pages.join(',')}`)
      .join('|');
    const fileId = uuidFrom(`lohn:${e.id}:${month}:${srcKey}`);
    await storeFile(
      sql,
      cfg,
      {
        id: fileId,
        name: payslipFileName(month, e.name, no),
        type: 'application/pdf',
        data: bytes,
        link: { type: 'employee', id: e.id },
        category: 'Lohnabrechnung',
      },
      p.actor,
    );
    await sql`insert into app.payslips (file_id, employee_id, month, released, imported_by)
              values (${fileId}, ${e.id}, ${month}, ${p.release}, ${p.actor})
              on conflict (file_id) do update set released = app.payslips.released or excluded.released`;
    assigned.push({ personnel_no: no, name: e.name, pages, fileId, month });
    monthCount.set(month, (monthCount.get(month) ?? 0) + 1);
  }
  await sql`insert into app.audit_log (actor, action, entity, details)
            values (${p.actor}, 'payslip_import', 'payslips', ${sql.json({ months: [...monthCount.keys()].sort(), file: p.name, assigned: assigned.length, unassigned: unassigned.length })})`;
  assigned.sort((a, b) => b.month.localeCompare(a.month) || a.name.localeCompare(b.name, 'de'));
  const months = [...monthCount].map(([month, count]) => ({ month, count }));
  months.sort((a, b) => b.month.localeCompare(a.month));
  return { assigned, unassigned, months };
}

export async function listPayslips(
  sql: Sql,
  f: { employeeId?: string; month?: string; releasedOnly?: boolean },
) {
  return sql<
    {
      file_id: string;
      employee_id: string;
      name: string;
      personnel_no: string;
      month: string;
      released: boolean;
      viewed_at: Date | null;
      imported_at: Date;
    }[]
  >`
    select p.file_id, p.employee_id, e.first_name || ' ' || e.last_name as name, e.personnel_no, p.month, p.released,
           p.viewed_at, p.imported_at
      from app.payslips p join app.employees e on e.id = p.employee_id
     where ${f.employeeId ? sql`p.employee_id = ${f.employeeId}` : sql`true`}
       and ${f.month ? sql`p.month = ${f.month}` : sql`true`}
       and ${f.releasedOnly ? sql`p.released` : sql`true`}
     order by p.month desc, e.last_name, e.first_name`;
}

export async function releasePayslips(sql: Sql, month: string, actor: string) {
  const r =
    await sql`update app.payslips set released = true where month = ${month} and not released returning file_id`;
  await sql`insert into app.audit_log (actor, action, entity, details)
            values (${actor}, 'payslip_release', 'payslips', ${sql.json({ month, count: r.length })})`;
  return r.length;
}
