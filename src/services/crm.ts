import { z } from 'zod';
import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';

export type EntityType = 'customer' | 'site' | 'employee' | 'invoice';

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
  body: string;
  author: string;
  created_at: Date;
}

export async function listNotes(sql: Sql, type: EntityType, entityId: string) {
  return sql<Note[]>`select id, body, author, created_at from app.notes
                      where entity_type = ${type} and entity_id = ${entityId} order by created_at desc`;
}

/** `id` vom Formular → doppeltes Absenden legt keine zweite Notiz an. */
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
