import { z } from 'zod';
import type { Sql } from '../db/client.js';
import { assertVersion } from './crm.js';
import { BusinessError } from './errors.js';
import type { GroupBilling } from './masterdata.js';

/**
 * Rechnungsgruppe = wiederverwendbare Rechnungseinstellungen eines Kunden (Adresse, E-Mails, Format, Leitweg-ID,
 * Zahlungsziel, Skonto …). Jedes Objekt gehört zu einer Gruppe. Mit „combine“ werden alle Objekte der Gruppe im
 * Monatslauf auf EINER Sammelrechnung abgerechnet, sonst je Objekt eine Rechnung.
 */
export interface InvoiceGroup extends GroupBilling {
  customer_id: string;
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

const blank = (v: unknown) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? null : v);
const opt = z.preprocess(blank, z.string().trim().nullable());
const optInt = (min: number, max: number, msg: string) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : null),
    z.number().int(msg).min(min, msg).max(max, msg).nullable(),
  );

/** Rechnungseinstellungen aus dem Formular (Feldnamen wie in der Datenbank). */
export const groupBillingInput = z
  .object({
    bill_name: opt,
    bill_name2: opt,
    bill_street: opt,
    bill_postal_code: z.preprocess(
      blank,
      z
        .string()
        .trim()
        .regex(/^\d{5}$/, 'PLZ muss 5-stellig sein')
        .nullable(),
    ),
    bill_city: opt,
    bill_contact_name: opt,
    bill_emails: z.preprocess(
      (v) =>
        typeof v === 'string'
          ? v
              .split(/[\s,;]+/)
              .map((x) => x.trim())
              .filter(Boolean)
          : (v ?? []),
      z.array(z.email('Ungültige Rechnungs-E-Mail')),
    ),
    bill_format: z.enum(['pdf', 'zugferd', 'xrechnung']),
    buyer_reference: opt.refine(
      (v) => v === null || /^[0-9]{2,12}(-[0-9A-Za-z]{1,30})?-[0-9]{2}$/.test(v),
      'Leitweg-ID ungültig (Format: Grobadressierung-Feinadressierung-Prüfziffer)',
    ),
    bill_supplier_no: opt,
    bill_payment_terms_days: optInt(0, 365, 'Zahlungsziel: 0–365 Tage'),
    bill_skonto_percent_bp: z.preprocess(
      (v) =>
        typeof v === 'string' && v.trim() !== '' ? Math.round(Number(v.replace(',', '.')) * 100) : null,
      z.number().int('Skonto: max. 2 Nachkommastellen').min(1).max(1000, 'Skonto max. 10 %').nullable(),
    ),
    bill_skonto_days: optInt(1, 90, 'Skonto-Tage: 1–90'),
  })
  .refine((b) => !b.bill_name || (!!b.bill_street && !!b.bill_postal_code && !!b.bill_city), {
    message:
      'Rechnungsadresse: bitte Name, Straße, PLZ und Ort angeben (oder alles leer = Adresse des Kunden)',
    path: ['bill_street'],
  })
  .refine((b) => (b.bill_skonto_percent_bp === null) === (b.bill_skonto_days === null), {
    message: 'Skonto: Prozent und Tage bitte zusammen angeben (oder beide leer = kein Skonto)',
    path: ['bill_skonto_days'],
  })
  .refine((b) => b.bill_format !== 'xrechnung' || !!b.buyer_reference, {
    message: 'XRechnung braucht eine Leitweg-ID',
    path: ['buyer_reference'],
  })
  .refine(
    (b) =>
      !b.bill_skonto_days ||
      b.bill_payment_terms_days === null ||
      b.bill_skonto_days < b.bill_payment_terms_days,
    { message: 'Skontofrist muss kürzer als das Zahlungsziel sein', path: ['bill_skonto_days'] },
  );
export type GroupBillingInput = z.infer<typeof groupBillingInput>;

export interface InvoiceGroupInput {
  customerId: string;
  name: string;
  combine: boolean;
  billing: GroupBillingInput;
  orderReference: string | null;
  note: string | null;
  introText?: string | null;
  closingText?: string | null;
  active: boolean;
  /** null = Zuordnung der Objekte nicht ändern */
  siteIds: string[] | null;
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
      combine: p.combine,
      ...p.billing,
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
    let add: string[] = [];
    if (p.siteIds) {
      const own = await tx<{ id: string; invoice_group_id: string | null }[]>`
        select id, invoice_group_id from app.sites where customer_id = ${p.customerId}`;
      const wanted = new Set(p.siteIds);
      for (const sid of wanted) {
        if (!own.some((s) => s.id === sid)) throw new BusinessError('Objekt gehört nicht zu diesem Kunden');
      }
      // Objekte können nur einer anderen Gruppe zugeordnet, nicht „ohne Gruppe“ gelassen werden
      add = own.filter((s) => wanted.has(s.id) && s.invoice_group_id !== id).map((s) => s.id);
      const removed = own.filter((s) => !wanted.has(s.id) && s.invoice_group_id === id);
      if (removed.length)
        throw new BusinessError(
          'Objekte bitte am Objekt (Reiter „Rechnungsangaben“) einer anderen Rechnungsgruppe zuordnen',
        );
      if (add.length) await tx`update app.sites set invoice_group_id = ${id} where id in ${tx(add)}`;
    }
    const remove: string[] = [];
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'save', 'invoice_group', ${id}, ${tx.json({ ...row, add, remove })})`;
  });
}

/** Objekt einer Rechnungsgruppe zuordnen (Reiter „Rechnungsangaben“ am Objekt). */
export async function setSiteInvoiceGroup(sql: Sql, siteId: string, groupId: string, actor: string) {
  await sql.begin(async (tx) => {
    const [s] = await tx<
      { customer_id: string }[]
    >`select customer_id from app.sites where id = ${siteId} for update`;
    if (!s) throw new BusinessError('Objekt nicht gefunden');
    const [g] = await tx<{ customer_id: string; active: boolean }[]>`
      select customer_id, active from app.invoice_groups where id = ${groupId}`;
    if (!g || g.customer_id !== s.customer_id)
      throw new BusinessError('Rechnungsgruppe gehört nicht zu diesem Kunden');
    if (!g.active) throw new BusinessError('Rechnungsgruppe ist inaktiv');
    await tx`update app.sites set invoice_group_id = ${groupId}, updated_at = now() where id = ${siteId}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'invoice_group', 'site', ${siteId}, ${tx.json({ invoice_group_id: groupId })})`;
  });
}
