import { z } from 'zod';
import type { Sql } from '../db/client.js';
import { assertVersion } from './crm.js';
import type { BillingCycle } from '../domain/invoice/calc.js';
import { BusinessError } from './errors.js';
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
  status: 'kunde' | 'interessent';
  dunning_block: boolean;
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
    status: z.enum(['kunde', 'interessent']).default('kunde'),
    dunning_block: z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean()),
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
  manager_user_id?: string | null;
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
  // Objektleitung: nur setzen, wenn das Feld mitgeschickt wird (Import lässt es unverändert)
  manager_user_id: z.preprocess(emptyToNull, z.uuid('Objektleitung ungültig').nullable()).optional(),
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
    const data = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    await tx`insert into app.sites ${tx({ id, ...data })}
             on conflict (id) do update set ${tx({ ...data, updated_at: new Date() } as Record<string, unknown>)}`;
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
  service_type_id: string | null;
  billing_cycle: BillingCycle;
  hours_target_milli: bigint | null;
  execution_notes: string | null;
  cost_center: string | null;
  labor_share_bp: number | null;
  always_unfinished: boolean;
  invoice_group_id: string | null;
  separate_invoice: boolean;
  version: number;
}

const optMilli = z.preprocess(
  emptyToNull,
  z
    .string()
    .nullable()
    .default(null)
    .transform((v, ctx) => {
      if (v == null) return null;
      try {
        const q = parseQuantity(v);
        if (q < 0n) throw new RangeError('darf nicht negativ sein');
        return q;
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: `Stundenvorgabe: ${(e as Error).message}` });
        return z.NEVER;
      }
    }),
);
const optPercentBp = z.preprocess(
  emptyToNull,
  z
    .string()
    .nullable()
    .default(null)
    .transform((v, ctx) => {
      if (v == null) return null;
      const n = Number(v.replace(',', '.'));
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        ctx.addIssue({ code: 'custom', message: 'Lohnkostenanteil bitte in % (0–100)' });
        return z.NEVER;
      }
      return Math.round(n * 100);
    }),
);

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
  service_type_id: z.preprocess(emptyToNull, z.uuid().nullable().default(null)),
  billing_cycle: z
    .enum(['monatlich', 'zweimonatlich', 'quartalsweise', 'halbjaehrlich', 'jaehrlich'])
    .default('monatlich'),
  hours_target: optMilli,
  execution_notes: optText,
  cost_center: optText,
  labor_share: optPercentBp,
  always_unfinished: z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean()),
  // „objekt“ = Rechnungsgruppe/Rechnung des Objekts, „separat“ = eigene Rechnung, sonst ID einer Rechnungsgruppe
  invoice_target: z.preprocess(emptyToNull, z.string().nullable().default(null)),
  version: z.preprocess(
    (v) => (typeof v === 'string' && v !== '' ? Number(v) : null),
    z.number().int().nullable(),
  ),
});

export type SiteServiceRow = SiteService & {
  type_name: string | null;
  group_name: string | null;
  last_billed_month: string | null;
};

export async function listServices(sql: Sql, siteId: string) {
  return sql<SiteServiceRow[]>`
    select ss.*, t.name as type_name, g.name as group_name,
           (select max(month) from app.monthly_run_services r where r.service_id = ss.id) as last_billed_month
      from app.site_services ss
      left join app.service_types t on t.id = ss.service_type_id
      left join app.invoice_groups g on g.id = ss.invoice_group_id
     where ss.site_id = ${siteId}
     order by ss.active desc, ss.sort_order, ss.kind, ss.description`;
}

export async function getService(sql: Sql, id: string) {
  const [s] = await sql<SiteService[]>`select * from app.site_services where id = ${id}`;
  return s;
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
    service_type_id: input.service_type_id,
    billing_cycle: input.billing_cycle,
    hours_target_milli: input.hours_target,
    execution_notes: input.execution_notes,
    cost_center: input.cost_center,
    labor_share_bp: input.labor_share,
    always_unfinished: input.always_unfinished,
    separate_invoice: input.invoice_target === 'separat',
    invoice_group_id:
      input.invoice_target && /^[0-9a-f-]{36}$/.test(input.invoice_target) ? input.invoice_target : null,
  };
  await sql.begin(async (tx) => {
    const [cur] = await tx<{ version: number; site_id: string }[]>`
      select version, site_id from app.site_services where id = ${id} for update`;
    if (cur && cur.site_id !== siteId) throw new BusinessError('Leistung gehört zu einem anderen Objekt');
    assertVersion(cur?.version, input.version, 'Die Leistung');
    const [pos] = await tx<{ next: number }[]>`
      select coalesce(max(sort_order), 0) + 1 as next from app.site_services where site_id = ${siteId}`;
    const sortOrder = cur
      ? (await tx<{ sort_order: number }[]>`select sort_order from app.site_services where id = ${id}`)[0]!
          .sort_order
      : pos!.next;
    await tx`insert into app.site_services ${tx({ id, ...row, sort_order: sortOrder } as Record<string, unknown>)}
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

// ---------------------------------------------------------------------------
// Rechnungsangaben je Objekt („wie Kunde“ oder abweichend)
// ---------------------------------------------------------------------------

export interface SiteBilling {
  billing_mode: 'kunde' | 'eigen';
  bill_name: string | null;
  bill_name2: string | null;
  bill_street: string | null;
  bill_postal_code: string | null;
  bill_city: string | null;
  bill_contact_name: string | null;
  bill_emails: string[] | null;
  bill_format: InvoiceFormat | null;
  bill_leitweg_id: string | null;
  bill_supplier_no: string | null;
  bill_payment_terms_days: number | null;
  bill_skonto_custom: boolean;
  bill_skonto_percent_bp: number | null;
  bill_skonto_days: number | null;
}

export interface EffectiveBilling {
  source: 'kunde' | 'objekt';
  name: string;
  name2: string | null;
  street: string;
  postalCode: string;
  city: string;
  contactName: string | null;
  emails: string[];
  format: InvoiceFormat;
  leitwegId: string | null;
  supplierNo: string | null;
  paymentTermsDays: number;
  skonto: { percentBp: number; days: number } | null;
}

/** Gültige Rechnungsangaben: Objekt (wenn „abweichend“) vor Kunde; leere Einzelfelder → Kunde. */
export function resolveBilling(c: Customer, s: Partial<SiteBilling> | null | undefined): EffectiveBilling {
  const own = s?.billing_mode === 'eigen';
  const addr = own && s?.bill_name;
  const custSkonto =
    c.skonto_percent_bp && c.skonto_days ? { percentBp: c.skonto_percent_bp, days: c.skonto_days } : null;
  return {
    source: own ? 'objekt' : 'kunde',
    name: addr ? s.bill_name! : c.name,
    name2: addr ? (s.bill_name2 ?? null) : c.name2,
    street: addr ? s.bill_street! : c.street,
    postalCode: addr ? s.bill_postal_code! : c.postal_code,
    city: addr ? s.bill_city! : c.city,
    contactName: (own && s?.bill_contact_name) || c.contact_name,
    emails: own && s?.bill_emails?.length ? s.bill_emails : c.invoice_emails,
    format: (own && s?.bill_format) || c.invoice_format,
    leitwegId: (own && s?.bill_leitweg_id) || c.leitweg_id,
    supplierNo: (own && s?.bill_supplier_no) || c.supplier_no,
    paymentTermsDays:
      own && s?.bill_payment_terms_days != null ? s.bill_payment_terms_days : c.payment_terms_days,
    skonto:
      own && s?.bill_skonto_custom
        ? s.bill_skonto_percent_bp && s.bill_skonto_days
          ? { percentBp: s.bill_skonto_percent_bp, days: s.bill_skonto_days }
          : null
        : custSkonto,
  };
}

export async function effectiveBilling(sql: Sql, customerId: string, siteId: string | null) {
  const c = await getCustomer(sql, customerId);
  if (!c) throw new BusinessError('Kunde nicht gefunden');
  const [s] = siteId
    ? await sql<SiteBilling[]>`select * from app.sites where id = ${siteId} and customer_id = ${customerId}`
    : [];
  return resolveBilling(c, s);
}

const emailList = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split(/[\s,;]+/)
          .map((x) => x.trim())
          .filter(Boolean)
      : v,
  z.array(z.email('Ungültige Rechnungs-E-Mail')),
);

export const siteBillingInput = z
  .object({
    billing_mode: z.enum(['kunde', 'eigen']),
    bill_name: optText,
    bill_name2: optText,
    bill_street: optText,
    bill_postal_code: z.preprocess(
      emptyToNull,
      z
        .string()
        .trim()
        .regex(/^\d{5}$/, 'PLZ muss 5-stellig sein')
        .nullable(),
    ),
    bill_city: optText,
    bill_contact_name: optText,
    bill_emails: emailList,
    bill_format: z.preprocess(emptyToNull, z.enum(['pdf', 'zugferd', 'xrechnung']).nullable()),
    bill_leitweg_id: optText.refine(
      (v) => v === null || /^[0-9]{2,12}(-[0-9A-Za-z]{1,30})?-[0-9]{2}$/.test(v),
      'Leitweg-ID ungültig (Format: Grobadressierung-Feinadressierung-Prüfziffer)',
    ),
    bill_supplier_no: optText,
    bill_payment_terms_days: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : null),
      z.number().int().min(0).max(365).nullable(),
    ),
    bill_skonto_custom: z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean()),
    bill_skonto_percent_bp: z.preprocess(
      (v) =>
        typeof v === 'string' && v.trim() !== '' ? Math.round(Number(v.replace(',', '.')) * 100) : null,
      z.number().int('Skonto: max. 2 Nachkommastellen').min(1).max(1000, 'Skonto max. 10 %').nullable(),
    ),
    bill_skonto_days: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : null),
      z.number().int().min(1).max(90).nullable(),
    ),
  })
  .refine((b) => !b.bill_name || (!!b.bill_street && !!b.bill_postal_code && !!b.bill_city), {
    message: 'Abweichende Rechnungsadresse: bitte Name, Straße, PLZ und Ort angeben',
    path: ['bill_street'],
  })
  .refine((b) => (b.bill_skonto_percent_bp === null) === (b.bill_skonto_days === null), {
    message: 'Skonto: Prozent und Tage bitte zusammen angeben (oder beide leer = kein Skonto)',
    path: ['bill_skonto_days'],
  });

/** Rechnungsangaben des Objekts speichern; „wie Kunde“ leert alle abweichenden Felder. */
export async function saveSiteBilling(
  sql: Sql,
  siteId: string,
  input: z.infer<typeof siteBillingInput>,
  actor: string,
  expectedVersion: number | null = null,
) {
  const [site] = await sql<(Site & SiteBilling)[]>`select * from app.sites where id = ${siteId}`;
  if (!site) throw new BusinessError('Objekt nicht gefunden');
  assertVersion(site.version, expectedVersion, 'Das Objekt');
  const data: SiteBilling =
    input.billing_mode === 'kunde'
      ? {
          billing_mode: 'kunde',
          bill_name: null,
          bill_name2: null,
          bill_street: null,
          bill_postal_code: null,
          bill_city: null,
          bill_contact_name: null,
          bill_emails: null,
          bill_format: null,
          bill_leitweg_id: null,
          bill_supplier_no: null,
          bill_payment_terms_days: null,
          bill_skonto_custom: false,
          bill_skonto_percent_bp: null,
          bill_skonto_days: null,
        }
      : {
          ...input,
          bill_emails: input.bill_emails.length ? input.bill_emails : null,
          bill_skonto_percent_bp: input.bill_skonto_custom ? input.bill_skonto_percent_bp : null,
          bill_skonto_days: input.bill_skonto_custom ? input.bill_skonto_days : null,
        };
  const c = await getCustomer(sql, site.customer_id);
  const eff = resolveBilling(c!, data);
  if (eff.format === 'xrechnung' && !eff.leitwegId)
    throw new BusinessError('XRechnung braucht eine Leitweg-ID (beim Objekt oder beim Kunden)');
  if (eff.format !== 'pdf' && !eff.emails.length && input.billing_mode === 'eigen')
    throw new BusinessError('Bitte mindestens eine Rechnungs-E-Mail angeben (oder beim Kunden hinterlegen)');
  if (eff.skonto && eff.skonto.days >= eff.paymentTermsDays)
    throw new BusinessError('Skontofrist muss kürzer als das Zahlungsziel sein');
  await sql.begin(async (tx) => {
    await tx`update app.sites set ${tx(data as unknown as Record<string, unknown>)}, updated_at = now() where id = ${siteId}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'billing', 'site', ${siteId}, ${tx.json({ mode: data.billing_mode })})`;
  });
}

export async function buildBuyerSnapshot(
  sql: Sql,
  customerId: string,
  siteId: string | null,
): Promise<BuyerSnapshot> {
  const c = await getCustomer(sql, customerId);
  if (!c) throw new Error('Kunde nicht gefunden');
  const site = siteId ? await getSite(sql, siteId) : undefined;
  const [dd] = await sql<
    { mandate_ref: string; iban: string; scheme: 'CORE' | 'B2B'; creditor_id: string | null }[]
  >`
    select m.mandate_ref, m.iban, m.scheme, (select creditor_id from app.company where id = 1) as creditor_id
      from app.sepa_mandates m where m.customer_id = ${customerId} and m.active`;
  const b = resolveBilling(c, site as Partial<SiteBilling> | undefined);
  return {
    directDebit: dd?.creditor_id
      ? { mandateRef: dd.mandate_ref, iban: dd.iban, creditorId: dd.creditor_id, scheme: dd.scheme }
      : null,
    customerNo: c.customer_no,
    name: b.name,
    name2: b.name2,
    street: b.street,
    postalCode: b.postalCode,
    city: b.city,
    countryCode: c.country_code,
    vatId: c.vat_id,
    leitwegId: b.leitwegId,
    supplierNo: b.supplierNo,
    email: b.emails[0] ?? c.contact_email,
    contactName: b.contactName,
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

// ---------------------------------------------------------------------------
// Leistungsarten (Stammliste wie Fortytools)
// ---------------------------------------------------------------------------

export interface ServiceType {
  id: string;
  name: string;
  labor_share_bp: number | null;
  sort_order: number;
  active: boolean;
  version: number;
}

export async function listServiceTypes(sql: Sql, all = false) {
  return sql<ServiceType[]>`
    select * from app.service_types where ${all ? sql`true` : sql`active`} order by sort_order, name`;
}

export async function saveServiceType(
  sql: Sql,
  id: string,
  p: { name: string; laborShareBp: number | null; active: boolean; expectedVersion: number | null },
) {
  if (!p.name.trim()) throw new BusinessError('Bitte Bezeichnung angeben');
  const [cur] = await sql<{ version: number }[]>`select version from app.service_types where id = ${id}`;
  assertVersion(cur?.version, p.expectedVersion, 'Die Leistungsart');
  try {
    await sql`
      insert into app.service_types (id, name, labor_share_bp, sort_order, active)
      values (${id}, ${p.name.trim()}, ${p.laborShareBp},
              (select coalesce(max(sort_order), 0) + 10 from app.service_types), ${p.active})
      on conflict (id) do update set name = excluded.name, labor_share_bp = excluded.labor_share_bp,
                                     active = excluded.active`;
  } catch (e) {
    if ((e as { code?: string }).code === '23505')
      throw new BusinessError(`„${p.name.trim()}“ gibt es schon`);
    throw e;
  }
}
