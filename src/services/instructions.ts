import type { Sql } from '../db/client.js';
import { formatDateDe, todayBerlin } from '../domain/invoice/calc.js';
import { FormDoc } from '../pdf/form-doc.js';
import { BusinessError } from './errors.js';
import { SIGN_CATEGORY, type SignCategory } from './sign-documents.js';

/**
 * Unterweisungen als Textvorlagen (Ahmed 15.10.): Büro wählt eine Vorlage, ändert bei Bedarf den Text und gibt sie
 * frei; die Mitarbeitenden lesen den Text direkt in der App und unterschreiben. Format: Absätze durch Leerzeile,
 * „## “ = Überschrift, „- “ = Aufzählungspunkt.
 */
export interface InstructionTemplate {
  id: string;
  title: string;
  category: SignCategory;
  body: string;
  active: boolean;
  sort: number;
  version: number;
  updated_at: Date | null;
  updated_by: string | null;
}

export type Block = { kind: 'h' | 'p' | 'li'; text: string };

/** Text in Blöcke zerlegen (für App-Anzeige und PDF). */
export function parseBody(body: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  for (const raw of body.replace(/\r/g, '').split('\n')) {
    const l = raw.trim();
    if (!l) flush();
    else if (l.startsWith('## ')) {
      flush();
      out.push({ kind: 'h', text: l.slice(3).trim() });
    } else if (/^[-•*] /.test(l)) {
      flush();
      out.push({ kind: 'li', text: l.slice(2).trim() });
    } else para.push(l);
  }
  flush();
  return out;
}

export async function listInstructionTemplates(sql: Sql, all = false) {
  return sql<InstructionTemplate[]>`
    select * from app.instruction_templates where ${all ? sql`true` : sql`active`} order by sort, title`;
}

export async function getInstructionTemplate(sql: Sql, id: string) {
  const [t] = await sql<InstructionTemplate[]>`select * from app.instruction_templates where id = ${id}`;
  return t;
}

export async function saveInstructionTemplate(
  sql: Sql,
  id: string,
  p: { title: string; category: string; body: string; active: boolean; version: number | null },
  actor: string,
) {
  const title = p.title.trim();
  const body = p.body.replace(/\r/g, '').trim();
  if (!title) throw new BusinessError('Bitte Titel angeben');
  if (body.length < 20) throw new BusinessError('Bitte den Text der Unterweisung eingeben');
  if (!(p.category in SIGN_CATEGORY)) throw new BusinessError('Bitte Art wählen');
  const [cur] = await sql<
    { version: number }[]
  >`select version from app.instruction_templates where id = ${id}`;
  if (cur) {
    if (p.version != null && cur.version !== p.version)
      throw new BusinessError('Die Vorlage wurde inzwischen geändert – bitte neu laden.');
    await sql`update app.instruction_templates set title = ${title}, category = ${p.category}, body = ${body},
                     active = ${p.active}, version = version + 1, updated_by = ${actor}, updated_at = now()
               where id = ${id}`;
  } else {
    await sql`insert into app.instruction_templates (id, title, category, body, active, created_by)
              values (${id}, ${title}, ${p.category}, ${body}, ${p.active}, ${actor})
              on conflict (id) do nothing`;
  }
  await sql`insert into app.audit_log (actor, action, entity, entity_id)
            values (${actor}, ${cur ? 'update' : 'create'}, 'instruction_template', ${id})`;
}

/** PDF der Unterweisung (Logo, Titel, Text, Hinweis zur Unterschrift) – wird als Original archiviert. */
export async function instructionPdf(title: string, body: string, date = todayBerlin()): Promise<Uint8Array> {
  const doc = await FormDoc.create({
    title,
    sideRef: `Unterweisung · ${formatDateDe(date)}`,
    date,
    author: 'Viva-Deluxe Gebäudereinigung GmbH',
    plain: true,
  });
  doc.title(title, formatDateDe(date));
  for (const b of parseBody(body)) {
    if (b.kind === 'h') doc.heading(b.text, 11);
    else if (b.kind === 'li') doc.para(`•  ${b.text}`, { indent: 8 });
    else doc.para(b.text);
  }
  doc.section('Bestätigung');
  doc.para(
    'Mit meiner Unterschrift bestätige ich, dass ich die Unterweisung gelesen und verstanden habe und Gelegenheit ' +
      'hatte, Fragen zu stellen. Die Unterschrift erfolgt in der Viva-Deluxe-App; der Nachweis (Zeitpunkt, Name, ' +
      'Gerät, Prüfsumme) wird diesem Dokument angehängt.',
    { size: 8.5 },
  );
  return doc.save();
}
