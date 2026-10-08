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

async function pageTexts(pdf: Uint8Array): Promise<string[]> {
  const doc = await getDocumentProxy(pdf.slice());
  const { text } = await extractText(doc, { mergePages: false });
  return text as string[];
}

export interface PayslipReport {
  assigned: { personnel_no: string; name: string; pages: number; fileId: string }[];
  unassigned: string[];
}

export async function importPayslips(
  sql: Sql,
  cfg: UploadConfig,
  p: { name: string; bytes: Uint8Array; month: string; release: boolean; actor: string },
): Promise<PayslipReport> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p.month)) throw new BusinessError('Bitte Abrechnungsmonat wählen');
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

  // je Person gesammelte Seiten (Quelle + Seitenindex)
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
    const fromName = findPersonnelNo(s.name.replace(/[_.-]/g, ' '), known);
    let current: string | null = null;
    texts.forEach((t, i) => {
      const no = findPersonnelNo(t, known) ?? (sources.length > 1 ? fromName : null) ?? current;
      if (!no) {
        unassigned.push(`${s.name}, Seite ${i + 1}: keine Personalnummer gefunden`);
        return;
      }
      current = no;
      const list = parts.get(no) ?? [];
      const last = list.at(-1);
      if (last && last.src === s.data) last.pages.push(i);
      else list.push({ src: s.data, pages: [i] });
      parts.set(no, list);
    });
  }
  const assigned: PayslipReport['assigned'] = [];
  for (const [no, list] of parts) {
    const e = byNo.get(no)!;
    const out = await PDFDocument.create();
    let pages = 0;
    for (const part of list) {
      const src = await PDFDocument.load(part.src, { ignoreEncryption: true });
      for (const pg of await out.copyPages(src, part.pages)) out.addPage(pg);
      pages += part.pages.length;
    }
    out.setTitle(`Lohnabrechnung ${p.month} ${e.name}`);
    // feste Zeitstempel: dieselbe Quelle ergibt dieselbe Datei (erneut hochladen legt nichts doppelt an)
    out.setCreationDate(new Date(`${p.month}-01T00:00:00Z`));
    out.setModificationDate(new Date(`${p.month}-01T00:00:00Z`));
    const bytes = await out.save({ useObjectStreams: false });
    // ID aus Quelle + Seiten, nicht aus den erzeugten Bytes
    const srcKey = list
      .map((x) => `${createHash('sha256').update(x.src).digest('hex')}:${x.pages.join(',')}`)
      .join('|');
    const fileId = uuidFrom(`lohn:${e.id}:${p.month}:${srcKey}`);
    await storeFile(
      sql,
      cfg,
      {
        id: fileId,
        name: `Lohnabrechnung_${p.month}_${no}.pdf`,
        type: 'application/pdf',
        data: bytes,
        link: { type: 'employee', id: e.id },
        category: 'Lohnabrechnung',
      },
      p.actor,
    );
    await sql`insert into app.payslips (file_id, employee_id, month, released, imported_by)
              values (${fileId}, ${e.id}, ${p.month}, ${p.release}, ${p.actor})
              on conflict (file_id) do update set released = app.payslips.released or excluded.released`;
    assigned.push({ personnel_no: no, name: e.name, pages, fileId });
  }
  await sql`insert into app.audit_log (actor, action, entity, details)
            values (${p.actor}, 'payslip_import', 'payslips', ${sql.json({ month: p.month, file: p.name, assigned: assigned.length, unassigned: unassigned.length })})`;
  assigned.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return { assigned, unassigned };
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
