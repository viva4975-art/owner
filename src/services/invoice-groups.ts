import type { Sql } from '../db/client.js';
import { assertVersion } from './crm.js';
import { BusinessError } from './errors.js';

/** Rechnungsgruppe: mehrere Objekte eines Kunden → eine Sammelrechnung im Monatslauf. */
export interface InvoiceGroup {
  id: string;
  customer_id: string;
  name: string;
  buyer_reference: string | null;
  order_reference: string | null;
  note: string | null;
  intro_text: string | null;
  closing_text: string | null;
  active: boolean;
  version: number;
}
export type InvoiceGroupRow = InvoiceGroup & { site_ids: string[]; site_names: string[] };

export async function listInvoiceGroups(sql: Sql, customerId: string) {
  return sql<InvoiceGroupRow[]>`
    select g.*,
           coalesce(array_agg(s.id order by s.site_no) filter (where s.id is not null), '{}') as site_ids,
           coalesce(array_agg(s.name || ' (' || s.site_no || ')' order by s.site_no) filter (where s.id is not null), '{}')
             as site_names
      from app.invoice_groups g left join app.sites s on s.invoice_group_id = g.id
     where g.customer_id = ${customerId}
     group by g.id order by g.active desc, g.name`;
}

export async function getInvoiceGroup(sql: Sql, id: string) {
  const [g] = await sql<InvoiceGroup[]>`select * from app.invoice_groups where id = ${id}`;
  return g;
}

export interface InvoiceGroupInput {
  customerId: string;
  name: string;
  buyerReference: string | null;
  orderReference: string | null;
  note: string | null;
  introText?: string | null;
  closingText?: string | null;
  active: boolean;
  siteIds: string[];
  expectedVersion: number | null;
}

export async function saveInvoiceGroup(sql: Sql, id: string, p: InvoiceGroupInput, actor: string) {
  if (!p.name.trim()) throw new BusinessError('Bitte Namen der Rechnungsgruppe angeben');
  await sql.begin(async (tx) => {
    const [cur] = await tx<InvoiceGroup[]>`select * from app.invoice_groups where id = ${id} for update`;
    if (cur && cur.customer_id !== p.customerId)
      throw new BusinessError('Rechnungsgruppe gehört zu einem anderen Kunden');
    assertVersion(cur?.version, p.expectedVersion, 'Die Rechnungsgruppe');
    const row = {
      name: p.name.trim(),
      buyer_reference: p.buyerReference,
      order_reference: p.orderReference,
      note: p.note,
      intro_text: p.introText ?? null,
      closing_text: p.closingText ?? null,
      active: p.active,
    };
    try {
      await tx`
        insert into app.invoice_groups ${tx({ id, customer_id: p.customerId, ...row } as Record<string, unknown>)}
        on conflict (id) do update set ${tx(row as Record<string, unknown>)}`;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new BusinessError(`Eine Rechnungsgruppe „${row.name}“ gibt es bei diesem Kunden schon`);
      }
      throw e;
    }
    const own = await tx<{ id: string; invoice_group_id: string | null }[]>`
      select id, invoice_group_id from app.sites where customer_id = ${p.customerId}`;
    const wanted = new Set(p.siteIds);
    for (const sid of wanted) {
      if (!own.some((s) => s.id === sid)) throw new BusinessError('Objekt gehört nicht zu diesem Kunden');
    }
    const add = own.filter((s) => wanted.has(s.id) && s.invoice_group_id !== id).map((s) => s.id);
    const remove = own.filter((s) => !wanted.has(s.id) && s.invoice_group_id === id).map((s) => s.id);
    if (add.length) await tx`update app.sites set invoice_group_id = ${id} where id in ${tx(add)}`;
    if (remove.length) await tx`update app.sites set invoice_group_id = null where id in ${tx(remove)}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'save', 'invoice_group', ${id}, ${tx.json({ ...row, add, remove })})`;
  });
}
