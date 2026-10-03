import { z } from 'zod';
import type { Sql } from '../db/client.js';
import { assertVersion } from './crm.js';
import type { BankAccount, BuyerSnapshot, InvoiceFormat, SellerSnapshot } from '../domain/invoice/types.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';

// ---------------------------------------------------------------------------
// Firma
// ---------------------------------------------------------------------------

export async function getSeller(sql: Sql): Promise<SellerSnapshot> {
  const [c] = await sql`select * from app.company where id = 1`;
  if (!c) throw new Error('Firmenstamm fehlt (app.company) – bitte Seed ausführen');
  return {
    legalName: c.legal_name,
    street: c.street,
    postalCode: c.postal_code,
    city: c.city,
    countryCode: c.country_code,
    vatId: c.vat_id,
    taxNumber: c.tax_number,
    registerCourt: c.register_court,
    registerNumber: c.register_number,
    managingDirector: c.managing_director,
    phone: c.phone,
    fax: c.fax,
    email: c.email,
    website: c.website,
    bankAccounts: c.bank_accounts as BankAccount[],
  };
}

// ---------------------------------------------------------------------------
// Kunden
// ---------------------------------------------------------------------------

export interface Customer {
  id: string;
  customer_no: string;
  name: string;
  name2: string | null;
  street: string;
  postal_code: string;
  city: string;
  country_code: string;
  vat_id: string | null;
  is_public_authority: boolean;
  leitweg_id: string | null;
  supplier_no: string | null;
  invoice_emails: string[];
  invoice_format: InvoiceFormat;
  payment_terms_days: number;
  skonto_percent_bp: number | null;
  skonto_days: number | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  notes: string | null;
  active: boolean;
  version: number;
}

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optText = z.preprocess(emptyToNull, z.string().trim().nullable().default(null));

export const customerInput = z
  .object({
    customer_no: z.string().trim().min(1, 'Kundennummer fehlt'),
    name: z.string().trim().min(1, 'Name fehlt'),
    name2: optText,
    street: z.string().trim().min(1, 'Straße fehlt'),
    postal_code: z
      .string()
      .trim()
      .regex(/^\d{5}$/, 'PLZ muss 5-stellig sein'),
    city: z.string().trim().min(1, 'Ort fehlt'),
    vat_id: optText,
    is_public_authority: z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean()),
    leitweg_id: optText.refine(
      (v) => v === null || /^[0-9]{2,12}(-[0-9A-Za-z]{1,30})?-[0-9]{2}$/.test(v),
      'Leitweg-ID ungültig (Format: Grobadressierung-Feinadressierung-Prüfziffer)',
    ),
    supplier_no: optText,
    invoice_emails: z.preprocess(
      (v) =>
        typeof v === 'string'
          ? v
              .split(/[\s,;]+/)
              .map((s) => s.trim())
              .filter(Boolean)
          : v,
      z.array(z.email('Ungültige Rechnungs-E-Mail')),
    ),
    invoice_format: z.enum(['pdf', 'zugferd', 'xrechnung']),
    payment_terms_days: z.coerce.number().int().min(0).max(365),
    // Skonto in Prozent ("3" oder "2,5") → Basispunkte; leer = kein Skonto
    skonto_percent_bp: z.preprocess(
      (v) =>
        typeof v === 'string' && v.trim() !== '' ? Math.round(Number(v.replace(',', '.')) * 100) : null,
      z
        .number()
        .int('Skonto: max. 2 Nachkommastellen')
        .min(1, 'Skonto muss größer 0 sein')
        .max(1000, 'Skonto max. 10 %')
        .nullable(),
    ),
    skonto_days: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : null),
      z.number().int().min(1).max(90).nullable(),
    ),
    contact_name: optText,
    contact_email: z.preprocess(emptyToNull, z.email('Ungültige Kontakt-E-Mail').nullable().default(null)),
    contact_phone: optText,
    notes: optText,
  })
  .refine((c) => c.invoice_format !== 'xrechnung' || !!c.leitweg_id, {
    message: 'XRechnung braucht eine Leitweg-ID',
    path: ['leitweg_id'],
  })
  .refine((c) => (c.skonto_percent_bp === null) === (c.skonto_days === null), {
    message: 'Skonto: Prozent und Tage bitte zusammen angeben (oder beide leer)',
    path: ['skonto_days'],
  })
  .refine((c) => c.skonto_days === null || c.skonto_days < c.payment_terms_days, {
    message: 'Skontofrist muss kürzer als das Zahlungsziel sein',
    path: ['skonto_days'],
  });

export type CustomerInput = z.infer<typeof customerInput>;

export async function listCustomers(sql: Sql): Promise<(Customer & { site_count: number })[]> {
  return sql`
    select c.*, (select count(*)::int from app.sites s where s.customer_id = c.id) as site_count
      from app.customers c order by c.name`;
}

export async function getCustomer(sql: Sql, id: string): Promise<Customer | undefined> {
  const [c] = await sql<Customer[]>`select * from app.customers where id = ${id}`;
  return c;
}

/** Anlegen/Ändern mit fester ID → idempotent bei Wiederholung. */
export async function saveCustomer(
  sql: Sql,
  id: string,
  input: CustomerInput,
  actor: string,
  expectedVersion: number | null = null,
): Promise<void> {
  await sql.begin(async (tx) => {
    const [cur] = await tx<
      { version: number }[]
    >`select version from app.customers where id = ${id} for update`;
    assertVersion(cur?.version, expectedVersion, 'Der Kunde');
    await tx`
      insert into app.customers ${tx({ id, ...input, invoice_emails: input.invoice_emails })}
      on conflict (id) do update set ${tx({ ...input, invoice_emails: input.invoice_emails, updated_at: new Date() } as Record<string, unknown>)}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'save', 'customer', ${id}, ${tx.json({ customer_no: input.customer_no })})`;
  });
}

// ---------------------------------------------------------------------------
// Objekte & Leistungen
// ---------------------------------------------------------------------------

export interface Site {
  id: string;
  customer_id: string;
  site_no: string;
  name: string;
  street: string | null;
  postal_code: string | null;
  city: string | null;
  order_reference: string | null;
  contract_reference: string | null;
  active: boolean;
  version: number;
}

export const siteInput = z.object({
  customer_id: z.uuid('Kunde fehlt'),
  site_no: z.string().trim().min(1, 'Objektnummer fehlt'),
  name: z.string().trim().min(1, 'Bezeichnung fehlt'),
  street: optText,
  postal_code: optText,
  city: optText,
  order_reference: optText,
  contract_reference: optText,
});
export type SiteInput = z.infer<typeof siteInput>;

export async function listSites(sql: Sql, customerId?: string) {
  return sql<(Site & { customer_name: string; monthly_net_cents: bigint })[]>`
    select s.*, c.name as customer_name,
           coalesce((select sum(round(ss.quantity_milli::numeric * ss.unit_price_cents / 1000))::bigint
                       from app.site_services ss
                      where ss.site_id = s.id and ss.active and ss.kind = 'monthly_flat'), 0) as monthly_net_cents
      from app.sites s join app.customers c on c.id = s.customer_id
     where ${customerId ? sql`s.customer_id = ${customerId}` : sql`true`}
     order by s.site_no`;
}

export async function getSite(sql: Sql, id: string) {
  const [s] = await sql<(Site & { customer_name: string })[]>`
    select s.*, c.name as customer_name from app.sites s join app.customers c on c.id = s.customer_id where s.id = ${id}`;
  return s;
}

export async function saveSite(
  sql: Sql,
  id: string,
  input: SiteInput,
  actor: string,
  expectedVersion: number | null = null,
) {
  await sql.begin(async (tx) => {
    const [cur] = await tx<{ version: number }[]>`select version from app.sites where id = ${id} for update`;
    assertVersion(cur?.version, expectedVersion, 'Das Objekt');
    await tx`insert into app.sites ${tx({ id, ...input })}
             on conflict (id) do update set ${tx({ ...input, updated_at: new Date() } as Record<string, unknown>)}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'save', 'site', ${id}, ${tx.json({ site_no: input.site_no })})`;
  });
}

export interface SiteService {
  id: string;
  site_id: string;
  kind: 'monthly_flat' | 'special' | 'hourly';
  description: string;
  unit_code: string;
  quantity_milli: bigint;
  unit_price_cents: bigint;
  vat_rate_bp: number;
  valid_from: string;
  valid_to: string | null;
  active: boolean;
  sort_order: number;
  note: string | null;
}

export const serviceInput = z.object({
  kind: z.enum(['monthly_flat', 'special', 'hourly']),
  description: z.string().trim().min(1, 'Beschreibung fehlt'),
  unit_code: z.string().trim().min(1),
  quantity: z.string().transform((v, ctx) => {
    try {
      const q = parseQuantity(v);
      if (q <= 0n) throw new RangeError('Menge muss größer 0 sein');
      return q;
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: (e as Error).message });
      return z.NEVER;
    }
  }),
  unit_price: z.string().transform((v, ctx) => {
    try {
      return parseEuro(v);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: (e as Error).message });
      return z.NEVER;
    }
  }),
  vat_rate_bp: z.coerce.number().int().min(1, 'Steuersatz 0 % ist im Prototyp nicht freigegeben').max(10000),
  valid_from: z.iso.date(),
  valid_to: z.preprocess(emptyToNull, z.iso.date().nullable().default(null)),
  note: optText,
});

export async function listServices(sql: Sql, siteId: string) {
  return sql<
    SiteService[]
  >`select * from app.site_services where site_id = ${siteId} order by active desc, sort_order, kind, description`;
}

export async function saveService(
  sql: Sql,
  id: string,
  siteId: string,
  input: z.infer<typeof serviceInput>,
  actor: string,
) {
  const row = {
    site_id: siteId,
    kind: input.kind,
    description: input.description,
    unit_code: input.unit_code,
    quantity_milli: input.quantity,
    unit_price_cents: input.unit_price,
    vat_rate_bp: input.vat_rate_bp,
    valid_from: input.valid_from,
    valid_to: input.valid_to,
    note: input.note,
  };
  await sql.begin(async (tx) => {
    await tx`insert into app.site_services ${tx({ id, ...row })}
             on conflict (id) do update set ${tx({ ...row, updated_at: new Date() } as Record<string, unknown>)}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'save', 'site_service', ${id}, ${tx.json({ description: input.description })})`;
  });
}

export async function setServiceActive(sql: Sql, id: string, active: boolean, actor: string) {
  await sql.begin(async (tx) => {
    await tx`update app.site_services set active = ${active}, updated_at = now() where id = ${id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, ${active ? 'activate' : 'deactivate'}, 'site_service', ${id})`;
  });
}

// ---------------------------------------------------------------------------
// Käufer-Snapshot (wird beim Ausstellen eingefroren)
// ---------------------------------------------------------------------------

export async function buildBuyerSnapshot(
  sql: Sql,
  customerId: string,
  siteId: string | null,
): Promise<BuyerSnapshot> {
  const c = await getCustomer(sql, customerId);
  if (!c) throw new Error('Kunde nicht gefunden');
  const site = siteId ? await getSite(sql, siteId) : undefined;
  return {
    customerNo: c.customer_no,
    name: c.name,
    name2: c.name2,
    street: c.street,
    postalCode: c.postal_code,
    city: c.city,
    countryCode: c.country_code,
    vatId: c.vat_id,
    leitwegId: c.leitweg_id,
    supplierNo: c.supplier_no,
    email: c.invoice_emails[0] ?? c.contact_email,
    contactName: c.contact_name,
    site: site
      ? {
          siteNo: site.site_no,
          name: site.name,
          street: site.street,
          postalCode: site.postal_code,
          city: site.city,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Nummernvorschläge im Fortytools-Schema
// ---------------------------------------------------------------------------

/** Nächste freie Kundennummer: fünfstellig ab 20000 (Fortytools: 20002, 20207 …). */
export async function suggestCustomerNo(sql: Sql): Promise<string> {
  const [r] = await sql<{ n: string | null }[]>`
    select max(customer_no::bigint)::text as n from app.customers where customer_no ~ '^[0-9]+$'`;
  return String(Math.max(Number(r?.n ?? 0) + 1, 20000));
}

/** Nächste Objektnummer: Kundennummer + zweistellig (Kunde 20002 → 2000201, 2000202 …). */
export async function suggestSiteNo(sql: Sql, customerId: string): Promise<string | null> {
  const c = await getCustomer(sql, customerId);
  if (!c || !/^[0-9]+$/.test(c.customer_no)) return null;
  const [r] = await sql<{ n: number | null }[]>`
    select max(substr(site_no, ${c.customer_no.length + 1})::int) as n from app.sites
     where customer_id = ${customerId} and site_no ~ ${'^' + c.customer_no + '[0-9]{2}$'}`;
  return `${c.customer_no}${String((r?.n ?? 0) + 1).padStart(2, '0')}`;
}
