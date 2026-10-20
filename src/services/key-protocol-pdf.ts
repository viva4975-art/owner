import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { FormDoc } from '../pdf/form-doc.js';
import { BusinessError } from './errors.js';
import { uuidFrom } from './photo-stamp.js';
import { type UploadConfig, storeFile } from './uploads.js';

/*
 * Schlüsselübergabeprotokoll aus der App (Ahmed 20.10.: „selber erstellen, aktuelle Liste, Listen zwischenspeichern“):
 * die Schlüssel, die eine Person laut Schlüsselbuch gerade hat (oder eine Auswahl davon), als PDF zum Unterschreiben.
 * Jeder Stand wird mit Nummer SP-JJJJ-NNNN festgehalten (app.key_protocols, nur anhängen, Datei write-once ohne
 * Verknüpfung) – bewusst nicht unter Dokumente: dort kommt nur die unterschriebene Fassung hin.
 */

export interface KeyProtocolItem {
  key_id: string;
  key_no: string;
  site_no: string;
  site_name: string;
  description: string;
  quantity: number;
  issued_at: string | null;
}

export interface KeyProtocolRow {
  id: string;
  protocol_no: string;
  employee_id: string;
  protocol_date: string;
  items: KeyProtocolItem[];
  file_id: string;
  created_by: string;
  created_at: Date;
}

export const PFLICHTEN = [
  'Schlüssel sorgfältig verwahren, nicht an unbefugte Dritte weitergeben. Eine Weitergabe an unterstelltes Personal ist nur mit Wissen der Objektleitung und dokumentiert zulässig.',
  'Keine objektbezogene Beschriftung, keine Kopien anfertigen, keine Mitnahme in den Urlaub.',
  'Verlust oder Diebstahl unverzüglich der Geschäftsführung melden, damit Kunde und Versicherung informiert werden können. Bei Verlust oder Nichtrückgabe können die Kosten der Wiederbeschaffung oder der Schließanlage nach den Grundsätzen der Arbeitnehmerhaftung geltend gemacht werden.',
  'Bei Beendigung oder Objektwechsel alle Schlüssel unaufgefordert, im Übrigen auf Aufforderung vollständig zurückgeben.',
];

export async function heldKeys(sql: Sql, employeeId: string): Promise<KeyProtocolItem[]> {
  return sql<KeyProtocolItem[]>`
    select k.id as key_id, k.key_no, s.site_no, s.name as site_name, k.description, k.quantity,
           k.issued_at::text as issued_at
      from app.keys k join app.sites s on s.id = k.site_id
     where k.holder_employee_id = ${employeeId}
     order by s.site_no, k.key_no`;
}

export async function listKeyProtocols(sql: Sql, employeeId: string) {
  return sql<KeyProtocolRow[]>`
    select id, protocol_no, employee_id, protocol_date::text as protocol_date, items, file_id, created_by, created_at
      from app.key_protocols where employee_id = ${employeeId} order by created_at desc`;
}

export async function getKeyProtocol(sql: Sql, id: string) {
  const [p] = await sql<KeyProtocolRow[]>`
    select id, protocol_no, employee_id, protocol_date::text as protocol_date, items, file_id, created_by, created_at
      from app.key_protocols where id = ${id}`;
  return p;
}

export async function renderKeyProtocolPdf(p: {
  no: string;
  date: string;
  employee: { name: string; personnel_no: string | null };
  items: KeyProtocolItem[];
}): Promise<Uint8Array> {
  const d = await FormDoc.create({
    title: `Schlüsselübergabeprotokoll ${p.employee.name}`,
    sideRef: `Schlüsselübergabeprotokoll ${p.no} · ${p.employee.name} · ${formatDateDe(p.date)}`,
    date: p.date,
    author: 'Viva-Deluxe Gebäudereinigung GmbH',
  });
  d.title('Schlüsselübergabeprotokoll', p.no);
  const sites = new Set(p.items.map((i) => i.site_no));
  d.infoGrid([
    ['Mitarbeiter/in', p.employee.name],
    ['Personal-Nr.', p.employee.personnel_no ?? '–'],
    ['Datum der Übergabe', formatDateDe(p.date)],
    [
      'Objekte',
      sites.size === 1 ? `${p.items[0]!.site_name} (${p.items[0]!.site_no})` : `${sites.size} Objekte`,
    ],
    ['Positionen', String(p.items.length)],
    ['Stück gesamt', String(p.items.reduce((a, i) => a + i.quantity, 0))],
  ]);
  d.section('Übergebene Schlüssel, Transponder und Codes');
  d.table(
    [
      { label: 'Nr.', width: 20 },
      { label: 'Objekt', width: 128 },
      { label: 'Art / Kennung', width: 150 },
      { label: 'Anzahl', width: 46, align: 'right' },
      { label: 'Schlüssel-Nr.', width: 92 },
      { label: 'seit', width: 62 },
    ],
    p.items.map((i, n) => [
      String(n + 1),
      `${i.site_name} (${i.site_no})`,
      i.description,
      String(i.quantity),
      i.key_no,
      i.issued_at ? formatDateDe(i.issued_at) : '–',
    ]),
  );
  d.section('Pflichten');
  for (const t of PFLICHTEN) d.para(`–  ${t}`, { size: 8.5 });
  d.para(
    'Mit der Unterschrift bestätigt der Mitarbeiter bzw. die Mitarbeiterin den Erhalt der oben aufgeführten Schlüssel und die Kenntnis der Pflichten.',
    { size: 8.5 },
  );
  d.signatures('Viva-Deluxe Gebäudereinigung GmbH', `Unterschrift ${p.employee.name}`, {
    leftText: `München, den ${formatDateDe(p.date)}`,
  });
  d.section('Rückgabe – wird erst bei der Rückgabe ausgefüllt');
  d.para('Datum der Rückgabe: ______________________     Rücknahme durch: ______________________', {
    size: 9,
  });
  d.para('Vollständig zurück:  □ ja   □ nein – fehlend: ____________________________________________', {
    size: 9,
  });
  d.signatures('Rücknahme (Viva-Deluxe)', `Unterschrift ${p.employee.name}`);
  return d.pdf.save();
}

/**
 * Neues Protokoll aus dem aktuellen Schlüsselbuch-Stand (oder der Auswahl `keyIds`). Feste ID je Formular;
 * ist der letzte Stand derselben Person inhaltlich gleich (Datum + Schlüssel), wird er zurückgegeben statt doppelt.
 */
export async function createKeyProtocol(
  sql: Sql,
  cfg: UploadConfig,
  p: { id: string; employeeId: string; date?: string | null; keyIds?: string[] | null },
  actor: string,
): Promise<KeyProtocolRow> {
  const done = await getKeyProtocol(sql, p.id);
  if (done) return done;
  const [e] = await sql<{ name: string; personnel_no: string | null; last_name: string }[]>`
    select first_name || ' ' || last_name as name, personnel_no, last_name from app.employees
     where id = ${p.employeeId}`;
  if (!e) throw new BusinessError('Mitarbeiter nicht gefunden');
  const date = p.date && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : todayBerlin();
  let items = await heldKeys(sql, p.employeeId);
  if (p.keyIds) items = items.filter((i) => p.keyIds!.includes(i.key_id));
  if (!items.length)
    throw new BusinessError('Keine Schlüssel ausgewählt – die Person hat laut Schlüsselbuch keine');
  const [last] = await listKeyProtocols(sql, p.employeeId);
  const sig = (xs: KeyProtocolItem[]) => JSON.stringify(xs.map((i) => [i.key_id, i.quantity, i.description]));
  if (last && last.protocol_date === date && sig(last.items) === sig(items)) return last;

  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('app.key_protocols'))`;
    const year = date.slice(0, 4);
    const [{ n }] = (await tx`
      select coalesce(max(substring(protocol_no from 9)::int), 0) + 1 as n from app.key_protocols
       where protocol_no like ${`SP-${year}-%`}`) as unknown as [{ n: number }];
    const no = `SP-${year}-${String(n).padStart(4, '0')}`;
    const pdf = await renderKeyProtocolPdf({ no, date, employee: e, items });
    const fileId = uuidFrom(`${p.id}:schluesselprotokoll-pdf`);
    await storeFile(
      sql,
      cfg,
      {
        id: fileId,
        name: `Schluesselprotokoll_${no}_${e.last_name}.pdf`,
        type: 'application/pdf',
        data: pdf,
        link: null,
        category: null,
      },
      actor,
    );
    const [row] = await tx<KeyProtocolRow[]>`
      insert into app.key_protocols (id, protocol_no, employee_id, protocol_date, items, file_id, created_by)
      values (${p.id}, ${no}, ${p.employeeId}, ${date}, ${tx.json(items as never)}, ${fileId}, ${actor})
      returning id, protocol_no, employee_id, protocol_date::text as protocol_date, items, file_id, created_by,
                created_at`;
    return row!;
  });
}
