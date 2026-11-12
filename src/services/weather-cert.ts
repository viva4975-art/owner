/**
 * Bestätigung witterungsbedingter Arbeitsausfall (Ahmed 12.11.2026): Mitarbeiter/in kann wegen der Witterung vom … bis
 * … nicht arbeiten, ist bei uns als … beschäftigt und nimmt die Arbeit ab dem … wieder auf. Felder vorbelegt aus den
 * Stammdaten, Ausgabe als PDF (Briefpapier „edel“) oder Word; optional in der Personalakte ablegen.
 */
import type { Sql } from '../db/client.js';
import { addDays, formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { FormDoc } from '../pdf/form-doc.js';
import { BusinessError } from './errors.js';
import { getSeller } from './masterdata.js';

export const WEATHER_ACTIVITIES = ['Glasreiniger', 'Vorarbeiter', 'Reinigungskraft', 'Objektleiter'] as const;
export const WEATHER_PAY = [
  ['', 'keine Angabe'],
  ['unbezahlt', 'Arbeitsverhältnis ruht ohne Entgelt (unbezahlte Freistellung)'],
  ['bezahlt', 'Entgelt wird weitergezahlt'],
] as const;
export const WEATHER_REASON_DEFAULT =
  'Aufgrund der Witterung (Frost, Schnee, Eis bzw. anhaltende Nässe) können die Arbeiten im Außenbereich, ' +
  'insbesondere die Glas- und Fassadenreinigung, in diesem Zeitraum nicht ausgeführt werden.';

export interface WeatherCertInput {
  from: string;
  to: string;
  resume: string;
  activity: string;
  reason: string;
  pay: string;
  /** Vorlage bei (optional), z. B. Agentur für Arbeit, Jobcenter, Vermieter */
  recipient: string;
  withBirth: boolean;
  place: string;
  date: string;
  signer: string;
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Vorschlag Tätigkeit aus den Tags/der Beschäftigung */
export function suggestActivity(tags: string[] | null): string {
  const t = (tags ?? []).join(' ').toLowerCase();
  if (t.includes('vorarbeit')) return 'Vorarbeiter';
  if (t.includes('glas')) return 'Glasreiniger';
  if (t.includes('objektleit')) return 'Objektleiter';
  return 'Glasreiniger';
}

async function content(sql: Sql, employeeId: string, i: WeatherCertInput) {
  const [e] = await sql<
    {
      first_name: string;
      last_name: string;
      salutation: string | null;
      personnel_no: string;
      entry_date: string;
      employment_type: string | null;
      birth_date: string | null;
      street: string | null;
      postal_code: string | null;
      city: string | null;
    }[]
  >`select e.first_name, e.last_name, e.salutation, e.personnel_no, to_char(e.entry_date, 'YYYY-MM-DD') as entry_date,
           e.employment_type, to_char(p.birth_date, 'YYYY-MM-DD') as birth_date, p.street, p.postal_code, p.city
      from app.employees e left join app.employee_private p on p.employee_id = e.id where e.id = ${employeeId}`;
  if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
  if (!isDate(i.from) || !isDate(i.to)) throw new BusinessError('Bitte den Zeitraum (von – bis) angeben');
  if (i.to < i.from) throw new BusinessError('„bis“ liegt vor „von“');
  const resume = isDate(i.resume) ? i.resume : addDays(i.to, 1);
  if (resume <= i.to) throw new BusinessError('Der Wiederbeginn muss nach dem Ende des Ausfalls liegen');
  const activity = i.activity.trim();
  if (!activity) throw new BusinessError('Bitte angeben, als was die Person beschäftigt ist');
  const seller = await getSeller(sql);
  const [co] = await sql<
    { managing_director: string | null }[]
  >`select managing_director from app.company where id = 1`;
  const female = e.salutation === 'Frau';
  const male = e.salutation === 'Herr';
  const name = `${e.first_name} ${e.last_name}`;
  const fullName = `${female ? 'Frau ' : male ? 'Herr ' : ''}${name}`;
  const pron = female ? 'sie' : male ? 'er' : 'die Person';
  const Pron = female ? 'Sie' : male ? 'Er' : 'Die Person';
  const role = female && !/in$/.test(activity) && /er$/.test(activity) ? `${activity}in` : activity;
  const date = isDate(i.date) ? i.date : todayBerlin();
  const d = formatDateDe;
  const birth = i.withBirth && e.birth_date ? `, geboren am ${d(e.birth_date)}` : '';
  const addr = [e.street, [e.postal_code, e.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const payText =
    i.pay === 'unbezahlt'
      ? 'Für diesen Zeitraum ruht das Arbeitsverhältnis; ein Arbeitsentgelt wird nicht gezahlt.'
      : i.pay === 'bezahlt'
        ? 'Das Arbeitsentgelt wird für diesen Zeitraum weitergezahlt.'
        : '';
  const paras = [
    `hiermit bestätigen wir, dass ${fullName}${birth}${addr ? `, wohnhaft ${addr}` : ''}, seit dem ${d(e.entry_date)} ` +
      `bei der ${seller.legalName} als ${role} beschäftigt ist (Personal-Nr. ${e.personnel_no}).`,
    `Wegen der Witterung kann ${pron} in der Zeit vom ${d(i.from)} bis ${d(i.to)} nicht arbeiten.` +
      (i.reason.trim() ? ` ${i.reason.trim()}` : ''),
    `Das Arbeitsverhältnis besteht unverändert fort. ${Pron} nimmt die Arbeit voraussichtlich ab dem ${d(resume)} ` +
      'wieder auf.' +
      (payText ? ` ${payText}` : ''),
  ];
  const facts: [string, string][] = [
    ['Mitarbeiter/in', fullName],
    ['Personal-Nr.', e.personnel_no],
    ...(i.withBirth && e.birth_date ? ([['Geburtsdatum', d(e.birth_date)]] as [string, string][]) : []),
    ['Beschäftigt seit', d(e.entry_date)],
    ['Tätigkeit', role],
    ['Kein Einsatz', `${d(i.from)} – ${d(i.to)} (Witterung)`],
    ['Wiederbeginn', `ab ${d(resume)}`],
  ];
  const signer = i.signer.trim() || co?.managing_director || seller.legalName;
  return {
    seller,
    title: 'Bestätigung',
    subtitle: 'Witterungsbedingter Arbeitsausfall',
    recipient: i.recipient.trim(),
    facts,
    paras,
    place: `${i.place.trim() || seller.city}, den ${d(date)}`,
    signer: `${signer} · Geschäftsführung · ${seller.legalName}`,
    date,
    personnelNo: e.personnel_no,
    file: `Bestaetigung_Witterung_${e.personnel_no}_${name.replace(/[^\p{L}\p{N}]+/gu, '_')}_${i.from}`,
  };
}

export async function weatherCertPdf(sql: Sql, employeeId: string, i: WeatherCertInput) {
  const k = await content(sql, employeeId, i);
  const doc = await FormDoc.create({
    title: `${k.title} – ${k.subtitle}`,
    sideRef: `VD-BW Bestätigung Witterung · ${k.personnelNo} · ${formatDateDe(k.date)}`,
    date: k.date,
    author: k.seller.legalName,
  });
  doc.title(k.title.toUpperCase(), k.subtitle);
  if (k.recipient) doc.para(`Zur Vorlage bei: ${k.recipient}`, { size: 10, bold: true });
  doc.kvBox(k.facts.map(([key, v], n) => ({ k: key, v, strong: n === 0 })));
  doc.y += 4;
  doc.para('Sehr geehrte Damen und Herren,', { size: 10.5 });
  for (const p of k.paras) {
    doc.para(p, { size: 10.5 });
    doc.y += 4;
  }
  doc.y += 4;
  doc.para('Mit freundlichen Grüßen', { size: 10.5 });
  doc.signatures(`Stempel und Unterschrift Arbeitgeber – ${k.signer}`, '', { leftText: k.place });
  return { pdf: await doc.save(), name: `${k.file}.pdf` };
}

export async function weatherCertDocx(sql: Sql, employeeId: string, i: WeatherCertInput) {
  const k = await content(sql, employeeId, i);
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const run = (t: string, o: { b?: boolean; sz?: number; color?: string } = {}) =>
    `<w:r><w:rPr>${o.b ? '<w:b/>' : ''}${o.color ? `<w:color w:val="${o.color}"/>` : ''}<w:sz w:val="${o.sz ?? 21}"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
  const par = (inner: string, after = 160) =>
    `<w:p><w:pPr><w:spacing w:after="${after}"/></w:pPr>${inner}</w:p>`;
  const cell = (inner: string, w: number, fill?: string) =>
    `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}</w:tcPr>${inner}</w:tc>`;
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFB8BB"/>`;
  const facts =
    `<w:tbl><w:tblPr><w:tblW w:w="9200" w:type="dxa"/><w:tblBorders>${['top', 'bottom', 'insideH'].map(border).join('')}</w:tblBorders><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="6200"/></w:tblGrid>` +
    k.facts
      .map(
        ([key, v]) =>
          `<w:tr>${cell(par(run(key, { b: true, sz: 18, color: '6B6266' }), 0), 3000, 'F4F1F2')}${cell(par(run(v), 0), 6200)}</w:tr>`,
      )
      .join('') +
    '</w:tbl>';
  const body =
    par(run(k.title.toUpperCase(), { b: true, sz: 32 }), 40) +
    par(run(`${k.subtitle} · ${k.seller.legalName}`, { b: true, color: '7D1435' }), 200) +
    (k.recipient ? par(run(`Zur Vorlage bei: ${k.recipient}`, { b: true })) : '') +
    facts +
    par('', 160) +
    par(run('Sehr geehrte Damen und Herren,')) +
    k.paras.map((p) => par(run(p))).join('') +
    par(run('Mit freundlichen Grüßen'), 360) +
    par(run(k.place), 700) +
    par(run('_______________________________________'), 0) +
    par(run(`Stempel und Unterschrift Arbeitgeber – ${k.signer}`, { sz: 16, color: '6B6266' }), 0) +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1134" w:bottom="1134" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>';
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const { strToU8, zipSync } = await import('fflate');
  const data = zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    'word/document.xml': strToU8(xml),
  });
  return { data, name: `${k.file}.docx` };
}
