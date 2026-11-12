/**
 * Personaleinsatzliste mit Mindestlohnbestätigung für Kunden (Ahmed 12.11.2026, Vorlage VD-PE-2026-V1): eingesetzte
 * Mitarbeitende werden aus der Einsatzplanung bzw. den erfassten Zeiten des Zeitraums übernommen, weitere lassen sich
 * dazuwählen; Kopfangaben (Leistung, Geltungsbereich, Zeitraum) sind vorbelegt und frei änderbar. Unterschrift wahlweise
 * durch die Firma oder je Mitarbeiter/in (Spalte Datum + Unterschrift, Ahmed 12.11.). Ausgabe als PDF oder Word.
 */
import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { FORM_COLORS, FORM_X, FormDoc } from '../pdf/form-doc.js';
import { BusinessError } from './errors.js';
import { getSeller } from './masterdata.js';

export interface StaffListInput {
  customerId: string;
  siteIds: string[];
  from: string;
  to: string;
  leistung: string;
  geltung: string;
  /** Wer unterschreibt: die Firma (Stempel + Unterschrift) oder jede Person einzeln in ihrer Zeile */
  sign: 'firma' | 'mitarbeiter';
  employeeIds: string[];
  parts: ('liste' | 'mindestlohn')[];
  ort: string;
  datum: string;
}

export interface StaffPerson {
  id: string;
  name: string;
  personnel_no: string;
  birth_date: string | null;
}

/** Mitarbeitende, die im Zeitraum an den Objekten eingeplant sind, vertreten oder Zeiten erfasst haben */
export async function staffAtSites(sql: Sql, siteIds: string[], from: string, to: string): Promise<string[]> {
  if (!siteIds.length) return [];
  const rows = await sql<{ id: string }[]>`
    select distinct x.id from (
      select p.employee_id as id from app.shift_plans p
       where p.site_id = any(${siteIds}::uuid[]) and p.employee_id is not null
         and p.valid_from <= ${to}::date and (p.valid_until is null or p.valid_until >= ${from}::date)
      union
      select x.substitute_employee_id from app.shift_exceptions x join app.shift_plans p on p.id = x.shift_plan_id
       where p.site_id = any(${siteIds}::uuid[]) and x.substitute_employee_id is not null
         and x.work_date between ${from}::date and ${to}::date
      union
      select t.employee_id from app.time_entries t
       where t.site_id = any(${siteIds}::uuid[]) and t.work_date between ${from}::date and ${to}::date
         and t.status in ('erfasst', 'freigegeben')
    ) x join app.employees e on e.id = x.id
     where x.id is not null and e.entry_date <= ${to}::date and (e.exit_date is null or e.exit_date >= ${from}::date)`;
  return rows.map((r) => r.id);
}

export async function loadStaff(sql: Sql, ids: string[]): Promise<StaffPerson[]> {
  if (!ids.length) return [];
  return sql<StaffPerson[]>`
    select e.id, e.last_name || ', ' || e.first_name as name, e.personnel_no,
           to_char(p.birth_date, 'YYYY-MM-DD') as birth_date
      from app.employees e left join app.employee_private p on p.employee_id = e.id
     where e.id = any(${ids}::uuid[]) order by e.last_name, e.first_name`;
}

/** Vorbelegung der Kopfangaben */
export async function staffListDefaults(sql: Sql, customerId: string, siteIds: string[]) {
  const [cust] = await sql<{ name: string; customer_no: string }[]>`
    select name, customer_no from app.customers where id = ${customerId}`;
  if (!cust) throw new BusinessError('Kunde nicht gefunden');
  const sites = siteIds.length
    ? await sql<
        {
          site_no: string;
          name: string;
          street: string | null;
          postal_code: string | null;
          city: string | null;
        }[]
      >`
        select s.site_no, s.name, s.street, s.postal_code, s.city
          from app.sites s
         where s.id = any(${siteIds}::uuid[]) order by s.site_no`
    : [];
  const one = sites.length === 1 ? sites[0]! : null;
  const leistung = one
    ? [
        one.name,
        [one.street, [one.postal_code, one.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      ]
        .filter(Boolean)
        .join(', ')
    : sites.map((s) => s.name).join(', ');
  return { customer: cust, leistung };
}

async function content(sql: Sql, i: StaffListInput) {
  if (!i.employeeIds.length) throw new BusinessError('Bitte mindestens einen Mitarbeiter wählen');
  if (!i.parts.length)
    throw new BusinessError('Bitte Personaleinsatzliste und/oder Mindestlohnbestätigung wählen');
  if (i.to < i.from) throw new BusinessError('„bis“ liegt vor „von“');
  const [cust] = await sql<{ name: string; customer_no: string }[]>`
    select name, customer_no from app.customers where id = ${i.customerId}`;
  if (!cust) throw new BusinessError('Kunde nicht gefunden');
  const staff = await loadStaff(sql, i.employeeIds);
  const seller = await getSeller(sql);
  const d = (x: string | null) => (x ? formatDateDe(x) : '');
  const head: [string, string][] = [
    ['Auftraggeber', `${cust.name} (Kd.-Nr. ${cust.customer_no})`],
    ['Leistung / Baustelle', i.leistung],
    ...(i.geltung ? ([['Geltungsbereich', i.geltung]] as [string, string][]) : []),
    ['Zeitraum', `${d(i.from)} bis ${d(i.to)}`],
  ];
  return {
    cust,
    seller,
    staff,
    head,
    rows: staff.map((s, n) => [String(n + 1), s.name, s.personnel_no, d(s.birth_date)]),
    place: `${i.ort || seller.city}, den ${d(i.datum || todayBerlin())}`,
    file: `Personaleinsatzliste_${cust.customer_no}_${i.from}`,
  };
}

/** Kopfangaben als Kasten: Beschriftung links, Wert rechts, lange Werte umgebrochen (nichts abgeschnitten) */
function headBox(doc: FormDoc, rows: [string, string][]) {
  const x0 = FORM_X.L;
  const vx = x0 + 150;
  const vw = doc.R - vx - 12;
  const lines = rows.map(([, v]) => doc.wrap(v || '–', vw, 9));
  const h = lines.reduce((a, l) => a + Math.max(1, l.length) * 12 + 6, 0) + 10;
  doc.ensure(h);
  doc.rect(x0, doc.y, doc.R - x0, h, FORM_COLORS.BOX);
  doc.rect(x0, doc.y, 2.2, h, FORM_COLORS.BORDEAUX);
  let y = doc.y + 16;
  rows.forEach(([k], i) => {
    doc.cap(k, x0 + 14, y - 1, { size: 6 });
    lines[i]!.forEach((l, j) => doc.text(l, vx, y + j * 12, { size: 9 }));
    y += Math.max(1, lines[i]!.length) * 12 + 6;
  });
  doc.y += h + 12;
}

const HINTS = [
  'Die aufgeführten Mitarbeiter sind sozialversicherungspflichtig bei der Viva-Deluxe Gebäudereinigung GmbH beschäftigt.',
  'Sämtliche Mitarbeiter wurden nach § 28a SGB IV ordnungsgemäß zur Sozialversicherung angemeldet; die Meldungen liegen vor.',
  'Die Einhaltung des Mindestlohngesetzes sowie der einschlägigen Branchenmindestlöhne wird gewährleistet.',
  'Eine Sicherheitsunterweisung nach DGUV Vorschrift 1 wurde durchgeführt und dokumentiert.',
];
const ML_TEXT =
  'Die Viva-Deluxe Gebäudereinigung GmbH bestätigt hiermit, dass den nachstehend aufgeführten Arbeitnehmern im genannten Zeitraum mindestens der gesetzliche Mindestlohn nach dem MiLoG sowie der jeweils einschlägige Branchenmindestlohn gezahlt wurde und wird. Die Löhne wurden fristgerecht abgerechnet und ausgezahlt; Sozialversicherungsbeiträge und Steuern wurden ordnungsgemäß abgeführt.';
const ML_TEXT_MA =
  'Mit meiner Unterschrift bestätige ich, dass ich im genannten Zeitraum von der Viva-Deluxe Gebäudereinigung GmbH mindestens den gesetzlichen Mindestlohn nach dem MiLoG sowie den jeweils einschlägigen Branchenmindestlohn erhalten habe und mein Lohn fristgerecht abgerechnet und ausgezahlt wurde.';
const LIST_TEXT_MA =
  'Mit meiner Unterschrift bestätige ich, dass ich im genannten Zeitraum für die oben genannte Leistung eingesetzt bin.';
const ML_FOOT =
  'Diese Bestätigung wird auf Verlangen des Auftraggebers zur Vorlage im Rahmen der Auftraggeberhaftung nach § 13 MiLoG in Verbindung mit § 14 AEntG ausgestellt.';

/** Spalten, wenn jede Person in ihrer Zeile unterschreibt (Breite gesamt 498 pt) */
const MA_COLS = [
  { label: 'Nr.', width: 26 },
  { label: 'Name, Vorname', width: 160 },
  { label: 'Personal-Nr.', width: 62 },
  { label: 'Geburtsdatum', width: 70 },
  { label: 'Datum', width: 60 },
  { label: 'Unterschrift Mitarbeiter/in', width: 120 },
];
const MA_HEAD = MA_COLS.map((c) => c.label);
const MA_W = [500, 3000, 1300, 1400, 1300, 1900];

export async function staffListPdf(sql: Sql, i: StaffListInput) {
  const k = await content(sql, i);
  const doc = await FormDoc.create({
    title: 'Personaleinsatzliste',
    sideRef: `VD-PE Personaleinsatzliste · ${k.cust.customer_no} · ${formatDateDe(i.from)}–${formatDateDe(i.to)}`,
    date: i.datum || todayBerlin(),
    author: k.seller.legalName,
  });
  const ma = i.sign === 'mitarbeiter';
  let first = true;
  if (i.parts.includes('liste')) {
    first = false;
    doc.title('PERSONALEINSATZLISTE', 'mit Mindestlohnbestätigung');
    headBox(doc, k.head);
    doc.section('Eingesetzte Mitarbeiter');
    if (ma) {
      doc.para(LIST_TEXT_MA, { size: 8.5 });
      doc.table(MA_COLS, k.rows, { size: 9, rowH: 28 });
    } else
      doc.table(
        [
          { label: 'Nr.', width: 34 },
          { label: 'Name, Vorname', width: 220 },
          { label: 'Personal-Nr.', width: 110 },
          { label: 'Geburtsdatum', width: 110 },
        ],
        k.rows,
        { size: 9 },
      );
    doc.section('Hinweise');
    for (const h of HINTS) doc.para(`–  ${h}`, { size: 8.5 });
    if (!ma) doc.signatures('Stempel und Unterschrift Arbeitgeber', '', { leftText: k.place });
  }
  if (i.parts.includes('mindestlohn')) {
    if (!first) doc.newPage();
    doc.title('MINDESTLOHNBESTÄTIGUNG', 'Anlage zur Personaleinsatzliste');
    headBox(doc, k.head);
    doc.para(ma ? ML_TEXT_MA : ML_TEXT, { size: 9 });
    doc.y += 4;
    if (ma) doc.table(MA_COLS, k.rows, { size: 9, rowH: 28 });
    else
      doc.table(
        [
          { label: 'Nr.', width: 30 },
          { label: 'Name, Vorname', width: 180 },
          { label: 'Personal-Nr.', width: 80 },
          { label: 'Geburtsdatum', width: 85 },
          { label: 'Mindestlohn eingehalten', width: 105 },
        ],
        k.rows.map((r) => [...r, 'ja']),
        { size: 9 },
      );
    doc.para(ML_FOOT, { size: 8.5 });
    if (!ma)
      doc.signatures(`Stempel und Unterschrift Arbeitgeber – ${k.seller.legalName}`, '', {
        leftText: k.place,
      });
  }
  return { pdf: await doc.save(), name: `${k.file}.pdf` };
}

export async function staffListDocx(sql: Sql, i: StaffListInput) {
  const k = await content(sql, i);
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const run = (t: string, o: { b?: boolean; sz?: number; color?: string } = {}) =>
    `<w:r><w:rPr>${o.b ? '<w:b/>' : ''}${o.color ? `<w:color w:val="${o.color}"/>` : ''}<w:sz w:val="${o.sz ?? 20}"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
  const par = (inner: string, after = 120, pre = '') =>
    `<w:p><w:pPr>${pre}<w:spacing w:after="${after}"/></w:pPr>${inner}</w:p>`;
  const cell = (inner: string, w: number, fill?: string) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}</w:tcPr>${inner || par('', 0)}</w:tc>`;
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFB8BB"/>`;
  const tbl = (rows: string[][], widths: number[], head?: string[], boldFirst = false, trH = 0) =>
    `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblBorders>${['top', 'bottom', 'insideH', 'insideV', 'left', 'right'].map(border).join('')}</w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
    (head
      ? `<w:tr>${head.map((h, n) => cell(par(run(h, { b: true, sz: 18, color: '6B6266' }), 0), widths[n]!, 'F4F1F2')).join('')}</w:tr>`
      : '') +
    rows
      .map(
        (r) =>
          `<w:tr>${trH ? `<w:trPr><w:trHeight w:val="${trH}"/></w:trPr>` : ''}${r.map((c, n) => cell(par(run(c, boldFirst && n === 0 ? { b: true, sz: 18, color: '6B6266' } : {}), 0), widths[n]!, boldFirst && n === 0 ? 'F4F1F2' : undefined)).join('')}</w:tr>`,
      )
      .join('') +
    '</w:tbl>';
  const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  const sign = (label: string) =>
    par('', 360) +
    par(run(k.place), 600) +
    par(run('_______________________________________'), 0) +
    par(run(label, { sz: 16, color: '6B6266' }), 0);
  const ma = i.sign === 'mitarbeiter';
  const maRows = k.rows.map((r) => [...r, '', '']);
  const parts: string[] = [];
  if (i.parts.includes('liste'))
    parts.push(
      par(run('PERSONALEINSATZLISTE', { b: true, sz: 32 }), 40) +
        par(run(`mit Mindestlohnbestätigung · ${k.seller.legalName}`, { b: true, color: '7D1435' }), 200) +
        tbl(k.head, [3000, 6200], undefined, true) +
        par('', 120) +
        par(run('Eingesetzte Mitarbeiter', { b: true, color: '7D1435' }), 80) +
        (ma
          ? par(run(LIST_TEXT_MA, { sz: 18 }), 80) + tbl(maRows, MA_W, MA_HEAD, false, 560)
          : tbl(k.rows, [700, 4100, 2200, 2200], ['Nr.', 'Name, Vorname', 'Personal-Nr.', 'Geburtsdatum'])) +
        par('', 120) +
        par(run('Hinweise', { b: true, color: '7D1435' }), 80) +
        HINTS.map((h) => par(run(`–  ${h}`, { sz: 18 }), 60)).join('') +
        (ma ? '' : sign('Stempel und Unterschrift Arbeitgeber')),
    );
  if (i.parts.includes('mindestlohn'))
    parts.push(
      par(run('MINDESTLOHNBESTÄTIGUNG', { b: true, sz: 32 }), 40) +
        par(
          run(`Anlage zur Personaleinsatzliste · ${k.seller.legalName}`, { b: true, color: '7D1435' }),
          200,
        ) +
        tbl(k.head, [3000, 6200], undefined, true) +
        par('', 120) +
        par(run(ma ? ML_TEXT_MA : ML_TEXT, { sz: 19 }), 160) +
        (ma
          ? tbl(maRows, MA_W, MA_HEAD, false, 560)
          : tbl(
              k.rows.map((r) => [...r, 'ja']),
              [600, 3400, 1700, 1700, 1800],
              ['Nr.', 'Name, Vorname', 'Personal-Nr.', 'Geburtsdatum', 'Mindestlohn eingehalten'],
            )) +
        par('', 120) +
        par(run(ML_FOOT, { sz: 18 })) +
        (ma ? '' : sign(`Stempel und Unterschrift Arbeitgeber – ${k.seller.legalName}`)),
    );
  const body =
    parts.join(pageBreak) +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1134" w:bottom="1134" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const { strToU8, zipSync } = await import('fflate');
  const data = zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    'word/document.xml': strToU8(doc),
  });
  return { data, name: `${k.file}.docx` };
}
