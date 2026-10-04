import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';

/*
 * Dokumentenversand (Protokoll aller ausgehenden Dokumente: Rechnungen, Mahnungen) und Dokumenteneingang
 * (Ablage für Post/Scans/E-Mail-Anhänge, die noch keinem Vorgang zugeordnet sind).
 */

export const INBOX_ID = '00000000-0000-4000-8000-00000000eeee';

export interface OutboxRow {
  at: Date;
  kind: 'rechnung' | 'mahnung';
  doc_id: string;
  doc_no: string;
  customer_id: string;
  customer_name: string;
  recipients: string[];
  intended: string[];
  status: string;
  files: number;
  error: string | null;
}

export async function outbox(
  sql: Sql,
  f: { from: string; to: string; kind?: string | null; q?: string | null },
) {
  const rows = await sql<OutboxRow[]>`
    select * from (
      select coalesce(d.sent_at, d.created_at) as at, 'rechnung' as kind, i.id as doc_id,
             coalesce(i.number, 'Entwurf') as doc_no, c.id as customer_id, c.name as customer_name,
             d.actual_recipients as recipients, d.intended_recipients as intended, d.status::text as status,
             jsonb_array_length(d.files)::int as files, d.error
        from app.invoice_deliveries d join app.invoices i on i.id = d.invoice_id join app.customers c on c.id = i.customer_id
      union all
      select coalesce(m.sent_at, m.created_at), 'mahnung', m.id, m.number, c.id, c.name,
             coalesce(m.sent_to, '{}'), coalesce(m.sent_to, '{}'),
             case when m.status = 'versendet' then 'sent' else 'pending' end, 1, null
        from app.dunnings m join app.customers c on c.id = m.customer_id
    ) x
    where (x.at at time zone 'Europe/Berlin')::date between ${f.from} and ${f.to}
      and ${f.kind ? sql`x.kind = ${f.kind}` : sql`true`}
      and ${f.q ? sql`(x.doc_no ilike ${`%${f.q}%`} or x.customer_name ilike ${`%${f.q}%`} or array_to_string(x.intended, ' ') ilike ${`%${f.q}%`})` : sql`true`}
    order by x.at desc limit 500`;
  return rows;
}

export interface InboxFile {
  id: string;
  original_name: string;
  content_type: string;
  size_bytes: bigint;
  category: string | null;
  uploaded_by: string;
  created_at: Date;
}

export async function inboxFiles(sql: Sql) {
  return sql<InboxFile[]>`
    select f.id, f.original_name, f.content_type, f.size_bytes, l.category, f.uploaded_by, f.created_at
      from app.file_links l join app.files f on f.id = l.file_id
     where l.entity_type = 'inbox' and l.entity_id = ${INBOX_ID} and f.status = 'complete'
     order by f.created_at desc`;
}

export const INBOX_TARGETS = {
  customer: 'Kunde',
  supplier: 'Lieferant',
  site: 'Objekt',
  employee: 'Mitarbeiter (Personalakte)',
  incoming_invoice: 'Eingangsrechnung',
} as const;
export type InboxTarget = keyof typeof INBOX_TARGETS;

const TABLE: Record<InboxTarget, string> = {
  customer: 'customers',
  supplier: 'suppliers',
  site: 'sites',
  employee: 'employees',
  incoming_invoice: 'incoming_invoices',
};

/** Datei aus dem Eingang einem Vorgang zuordnen (Verknüpfung umhängen; die Datei selbst bleibt unverändert). */
export async function assignInboxFile(
  sql: Sql,
  fileId: string,
  target: { type: InboxTarget; id: string; category: string | null },
  actor: string,
) {
  if (!(target.type in TABLE)) throw new BusinessError('Ziel ungültig');
  await sql.begin(async (tx) => {
    const [exists] = await tx`select 1 from ${tx(`app.${TABLE[target.type]}`)} where id = ${target.id}`;
    if (!exists) throw new BusinessError(`${INBOX_TARGETS[target.type]} nicht gefunden`);
    const [link] =
      await tx`select 1 from app.file_links where file_id = ${fileId} and entity_type = 'inbox' and entity_id = ${INBOX_ID} for update`;
    if (!link) {
      const [done] =
        await tx`select 1 from app.file_links where file_id = ${fileId} and entity_type = ${target.type} and entity_id = ${target.id}`;
      if (done) return; // schon zugeordnet (doppelt abgeschickt)
      throw new BusinessError('Datei liegt nicht (mehr) im Eingang');
    }
    await tx`insert into app.file_links (file_id, entity_type, entity_id, category, linked_by)
             values (${fileId}, ${target.type}, ${target.id}, ${target.category}, ${actor}) on conflict do nothing`;
    await tx`delete from app.file_links where file_id = ${fileId} and entity_type = 'inbox' and entity_id = ${INBOX_ID}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'assign', 'file', ${fileId}, ${tx.json({ type: target.type, id: target.id })})`;
  });
}
