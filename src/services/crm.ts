import { z } from 'zod';
import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';

export type EntityType = 'customer' | 'site' | 'employee' | 'invoice' | 'tender';

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optText = z.preprocess(emptyToNull, z.string().trim().nullable().default(null));
const bool = z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean());

/**
 * Optimistisches Sperren: `expected` ist die Version, die das Formular geladen hat.
 * Ändert ein anderer Tab/Benutzer den Datensatz dazwischen, wird nicht still überschrieben.
 */
export function assertVersion(
  current: number | undefined,
  expected: number | null | undefined,
  what: string,
) {
  if (current !== undefined && expected != null && current !== expected) {
    throw new BusinessError(
      `${what} wurde zwischenzeitlich geändert (anderer Tab oder Benutzer). Angezeigt wird jetzt der neue Stand; ` +
        'Ihre eigenen Eingaben holen Sie mit „Meine Eingaben übernehmen“ zurück und speichern dann erneut.',
    );
  }
}

export const versionField = z.preprocess(
  (v) => (typeof v === 'string' && v !== '' ? Number(v) : null),
  z.number().int().nullable(),
);

// ---------------------------------------------------------------------------
// Kontakte
// ---------------------------------------------------------------------------

export interface Contact {
  id: string;
  customer_id: string;
  salutation: string | null;
  first_name: string | null;
  last_name: string;
  position: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  invoice_recipient: boolean;
  notes: string | null;
  version: number;
}

export const contactInput = z.object({
  salutation: optText,
  first_name: optText,
  last_name: z.string().trim().min(1, 'Nachname fehlt'),
  position: optText,
  email: z.preprocess(emptyToNull, z.email('Ungültige E-Mail').nullable().default(null)),
  phone: optText,
  mobile: optText,
  invoice_recipient: bool,
  notes: optText,
  version: versionField,
});

export async function listContacts(sql: Sql, customerId: string) {
  return sql<
    Contact[]
  >`select * from app.contacts where customer_id = ${customerId} order by last_name, first_name`;
}

export async function saveContact(
  sql: Sql,
  id: string,
  customerId: string,
  input: z.infer<typeof contactInput>,
) {
  const { version, ...row } = input;
  await sql.begin(async (tx) => {
    const [cur] = await tx<{ version: number; customer_id: string }[]>`
      select version, customer_id from app.contacts where id = ${id} for update`;
    if (cur && cur.customer_id !== customerId)
      throw new BusinessError('Kontakt gehört zu einem anderen Kunden');
    assertVersion(cur?.version, version, 'Der Kontakt');
    if (cur) {
      await tx`update app.contacts set ${tx({ ...row, updated_at: new Date() } as Record<string, unknown>)} where id = ${id}`;
    } else {
      await tx`insert into app.contacts ${tx({ id, customer_id: customerId, ...row } as Record<string, unknown>)}`;
    }
  });
}

export async function deleteContact(sql: Sql, id: string) {
  await sql`delete from app.contacts where id = ${id}`;
}

// ---------------------------------------------------------------------------
// Notizen
// ---------------------------------------------------------------------------

export interface Note {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  note_date: string;
  title: string | null;
  body: string;
  author: string;
  created_at: Date;
  updated_by: string | null;
  updated_at: Date | null;
  version: number;
  /** Anzahl Anhänge */
  files: number;
}

export async function listNotes(sql: Sql, type: EntityType, entityId: string) {
  return sql<Note[]>`
    select n.id, n.entity_type, n.entity_id, n.note_date::text as note_date, n.title, n.body, n.author, n.created_at,
           n.updated_by, n.updated_at, n.version,
           (select count(*)::int from app.file_links l where l.entity_type = 'note' and l.entity_id = n.id) as files
      from app.notes n
     where n.entity_type = ${type} and n.entity_id = ${entityId}
     order by n.note_date desc, n.created_at desc`;
}

export async function getNote(sql: Sql, id: string) {
  const [n] = await sql<Note[]>`
    select n.id, n.entity_type, n.entity_id, n.note_date::text as note_date, n.title, n.body, n.author, n.created_at,
           n.updated_by, n.updated_at, n.version,
           (select count(*)::int from app.file_links l where l.entity_type = 'note' and l.entity_id = n.id) as files
      from app.notes n where n.id = ${id}`;
  return n;
}

export interface NoteInput {
  date: string;
  title: string | null;
  body: string;
  expectedVersion: number | null;
}

/**
 * Notiz anlegen oder ändern. `id` vom Formular → doppeltes Absenden legt keine zweite Notiz an.
 * Der Erfasser bleibt beim Ändern erhalten, die Änderung wird mit Benutzer und Zeit festgehalten.
 */
export async function saveNote(
  sql: Sql,
  id: string,
  type: EntityType,
  entityId: string,
  p: NoteInput,
  actor: string,
) {
  const title = p.title?.trim() || null;
  const body = p.body.trim();
  if (!title && !body) throw new BusinessError('Bitte Titel oder Details angeben');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) throw new BusinessError('Datum ungültig');
  await sql.begin(async (tx) => {
    const [cur] = await tx<{ entity_type: string; entity_id: string; version: number }[]>`
      select entity_type, entity_id, version from app.notes where id = ${id} for update`;
    if (cur && (cur.entity_type !== type || cur.entity_id !== entityId))
      throw new BusinessError('Notiz gehört zu einem anderen Datensatz');
    assertVersion(cur?.version, p.expectedVersion, 'Die Notiz');
    if (cur) {
      await tx`update app.notes set note_date = ${p.date}, title = ${title}, body = ${body},
                 updated_by = ${actor}, updated_at = now() where id = ${id}`;
    } else {
      await tx`insert into app.notes (id, entity_type, entity_id, note_date, title, body, author)
               values (${id}, ${type}, ${entityId}, ${p.date}, ${title}, ${body}, ${actor})`;
    }
  });
}

/** Kurzform (ältere Aufrufer, Demo-Daten): Notiz mit heutigem Datum ohne Titel. */
export async function addNote(
  sql: Sql,
  id: string,
  type: EntityType,
  entityId: string,
  body: string,
  author: string,
) {
  if (!body.trim()) throw new BusinessError('Notiz ist leer');
  await sql`insert into app.notes (id, entity_type, entity_id, body, author)
            values (${id}, ${type}, ${entityId}, ${body.trim()}, ${author}) on conflict (id) do nothing`;
}

// ---------------------------------------------------------------------------
// Aufgaben
// ---------------------------------------------------------------------------

export interface Task {
  id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  assignee: string | null;
  status: 'open' | 'done';
  entity_type: EntityType | null;
  entity_id: string | null;
  created_by: string;
  created_at: Date;
  done_at: Date | null;
  version: number;
  entity_label?: string | null;
}

export const taskInput = z.object({
  title: z.string().trim().min(1, 'Titel fehlt'),
  description: optText,
  due_date: z.preprocess(emptyToNull, z.iso.date().nullable().default(null)),
  assignee: optText,
  entity_type: z.preprocess(
    emptyToNull,
    z.enum(['customer', 'site', 'employee', 'invoice']).nullable().default(null),
  ),
  entity_id: z.preprocess(emptyToNull, z.uuid().nullable().default(null)),
});

const ENTITY_LABEL = (sql: Sql) => sql`
  case t.entity_type
    when 'customer' then (select c.customer_no || ' ' || c.name from app.customers c where c.id = t.entity_id)
    when 'site' then (select s.site_no || ' ' || s.name from app.sites s where s.id = t.entity_id)
    when 'employee' then (select e.last_name || ', ' || e.first_name from app.employees e where e.id = t.entity_id)
    when 'invoice' then (select coalesce(i.number, 'Entwurf') from app.invoices i where i.id = t.entity_id)
    when 'tender' then (select 'Ausschreibung ' || coalesce(x.reference_no || ' ', '') || x.authority
                          from app.tenders x where x.id = t.entity_id)
  end`;

export async function listTasks(
  sql: Sql,
  filter: { status?: 'open' | 'done'; entity?: { type: EntityType; id: string }; withinDays?: number } = {},
) {
  return sql<Task[]>`
    select t.*, ${ENTITY_LABEL(sql)} as entity_label from app.tasks t
     where ${filter.status ? sql`t.status = ${filter.status}` : sql`true`}
       and ${filter.entity ? sql`t.entity_type = ${filter.entity.type} and t.entity_id = ${filter.entity.id}` : sql`true`}
       and ${filter.withinDays !== undefined ? sql`(t.due_date is null or t.due_date <= current_date + ${filter.withinDays}::int)` : sql`true`}
     order by t.status, t.due_date nulls last, t.created_at`;
}

export async function saveTask(sql: Sql, id: string, input: z.infer<typeof taskInput>, actor: string) {
  await sql`
    insert into app.tasks ${sql({ id, ...input, created_by: actor } as Record<string, unknown>)}
    on conflict (id) do nothing`;
}

export async function setTaskDone(sql: Sql, id: string, done: boolean, actor: string) {
  await sql`update app.tasks set status = ${done ? 'done' : 'open'},
              done_at = ${done ? sql`now()` : null}, done_by = ${done ? actor : null}
            where id = ${id}`;
}

export const contactInputSchema = contactInput;

/**
 * Wer kann für Aufgaben zuständig sein: aktive Benutzer (Büro/Objektleitung) und Mitarbeitende mit Tag
 * „Objektleitung“, „Büro“ oder „Verwaltung“ – keine Reinigungskräfte.
 */
export async function assigneeOptions(
  sql: Sql,
): Promise<{ name: string; group: 'Büro' | 'Objektleitung' }[]> {
  const rows = await sql<{ name: string; grp: 'Büro' | 'Objektleitung' }[]>`
    select p.display_name as name, case when p.role = 'objektleitung' then 'Objektleitung' else 'Büro' end as grp
      from app.user_accounts a join app.profiles p on p.user_id = a.id where a.active
    union
    select e.first_name || ' ' || e.last_name,
           case when exists (select 1 from unnest(e.tags) t where lower(t) like 'objektleit%') then 'Objektleitung' else 'Büro' end
      from app.employees e
     where e.status = 'aktiv'
       and exists (select 1 from unnest(e.tags) t where lower(t) similar to '(objektleit|büro|buero|verwaltung)%')`;
  const seen = new Set<string>();
  return rows
    .filter((r) => !seen.has(r.name.toLowerCase()) && seen.add(r.name.toLowerCase()))
    .map((r) => ({ name: r.name, group: r.grp }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name, 'de'));
}
