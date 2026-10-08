import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Sql, Tx } from '../db/client.js';
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
  /** § 13b: Kunde ist selbst Gebäudereiniger → Rechnungen standardmäßig mit Steuerschuldnerschaft des Leistungsempfängers */
  reverse_charge: boolean;
  is_consumer: boolean;
  /** Interner Bereich (Büro …): Einsatzort/Kostenstelle, keine Rechnungen */
  is_internal: boolean;
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
  billing_hint: string | null;
  site_notes: string | null;
  warning: string | null;
  customer_since: string | null;
  created_at: Date;
  active: boolean;
  status: 'kunde' | 'interessent';
  dunning_block: boolean;
  version: number;
}

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optText = z.preprocess(emptyToNull, z.string().trim().nullable().default(null));
/** Wie optText, aber nicht mitgeschickt (undefined) bleibt undefined → Feld wird beim Ändern nicht überschrieben. */
const keepText = z.preprocess(
  (v) => (v === undefined ? undefined : emptyToNull(v)),
  z.string().trim().nullable().optional(),
);

const optBool = z.preprocess(
  (v) => (v === undefined ? undefined : v === 'on' || v === 'true' || v === true),
  z.boolean().optional(),
);

/**
 * Kunde. Rechnungsangaben (Format, Leitweg-ID, E-Mails, Zahlungsziel, Skonto) werden seit 06.10.2026 in den
 * Rechnungsgruppen gepflegt – hier optional (Import, Startwerte der Gruppe „Standard“). Nicht mitgeschickte Felder
 * bleiben beim Ändern unverändert.
 */
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
    is_public_authority: optBool,
    leitweg_id: keepText.refine(
      (v) => v == null || /^[0-9]{2,12}(-[0-9A-Za-z]{1,30})?-[0-9]{2}$/.test(v),
      'Leitweg-ID ungültig (Format: Grobadressierung-Feinadressierung-Prüfziffer)',
    ),
    supplier_no: keepText,
    invoice_emails: z
      .preprocess(
        (v) =>
          typeof v === 'string'
            ? v
                .split(/[\s,;]+/)
                .map((s) => s.trim())
                .filter(Boolean)
            : v,
        z.array(z.email('Ungültige Rechnungs-E-Mail')),
      )
      .optional(),
    invoice_format: z.enum(['pdf', 'zugferd', 'xrechnung']).optional(),
    payment_terms_days: z.coerce.number().int().min(0).max(365).optional(),
    // Skonto in Prozent ("3" oder "2,5") → Basispunkte; leer = kein Skonto
    skonto_percent_bp: z
      .preprocess(
        (v) =>
          typeof v === 'string' && v.trim() !== ''
            ? Math.round(Number(v.replace(',', '.')) * 100)
            : v === undefined
              ? undefined
              : null,
        z
          .number()
          .int('Skonto: max. 2 Nachkommastellen')
          .min(1, 'Skonto muss größer 0 sein')
          .max(1000, 'Skonto max. 10 %')
          .nullable(),
      )
      .optional(),
    skonto_days: z
      .preprocess(
        (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v === undefined ? undefined : null),
        z.number().int().min(1).max(90).nullable(),
      )
      .optional(),
    contact_name: keepText,
    contact_email: z.preprocess(
      (v) => (v === undefined ? undefined : emptyToNull(v)),
      z.email('Ungültige Kontakt-E-Mail').nullable().optional(),
    ),
    contact_phone: keepText,
    notes: keepText, // Kurzinfo
    billing_hint: keepText,
    site_notes: keepText,
    warning: keepText,
    // kunde (grün) · interessent (gelb) · ehemalig (rot = inaktiv)
    status: z.enum(['kunde', 'interessent', 'ehemalig']).optional(),
    dunning_block: optBool,
    reverse_charge: optBool,
    is_consumer: optBool,
  })
  .refine((c) => !c.reverse_charge || !!c.vat_id, {
    message: '§ 13b: Bitte die USt-IdNr. des Kunden angeben (Pflicht in der E-Rechnung)',
    path: ['vat_id'],
  })
  .refine((c) => c.invoice_format !== 'xrechnung' || !!c.leitweg_id, {
    message: 'XRechnung braucht eine Leitweg-ID',
    path: ['leitweg_id'],
  })
  .refine(
    (c) =>
      c.skonto_percent_bp === undefined ||
      c.skonto_days === undefined ||
      (c.skonto_percent_bp === null) === (c.skonto_days === null),
    { message: 'Skonto: Prozent und Tage bitte zusammen angeben (oder beide leer)', path: ['skonto_days'] },
  )
  .refine(
    (c) => !c.skonto_days || c.payment_terms_days === undefined || c.skonto_days < c.payment_terms_days,
    {
      message: 'Skontofrist muss kürzer als das Zahlungsziel sein',
      path: ['skonto_days'],
    },
  );

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

export const customerStatusOf = (
  c: Pick<Customer, 'active' | 'status'>,
): 'kunde' | 'interessent' | 'ehemalig' =>
  !c.active ? 'ehemalig' : c.status === 'interessent' ? 'interessent' : 'kunde';

/** Feste ID der Rechnungsgruppe „Standard“ eines Kunden (wie in der Migration). */
export function standardGroupId(customerId: string): string {
  const h = createHash('md5').update(`standard-group:${customerId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Anlegen/Ändern mit fester ID → idempotent bei Wiederholung. Beim Anlegen entsteht die Rechnungsgruppe „Standard“
 * (Rechnungsangaben aus den Startwerten), der neue Objekte zugeordnet werden.
 */
export async function saveCustomer(
  sql: Sql,
  id: string,
  input: CustomerInput,
  actor: string,
  expectedVersion: number | null = null,
): Promise<void> {
  const { status, ...rest } = input;
  const data: Record<string, unknown> = Object.fromEntries(
    Object.entries(rest).filter(([, v]) => v !== undefined),
  );
  if (status) {
    data.status = status === 'interessent' ? 'interessent' : 'kunde';
    data.active = status !== 'ehemalig';
  }
  await sql.begin(async (tx) => {
    const [cur] = await tx<
      { version: number }[]
    >`select version from app.customers where id = ${id} for update`;
    assertVersion(cur?.version, expectedVersion, 'Der Kunde');
    if (cur) {
      await tx`update app.customers set ${tx({ ...data, updated_at: new Date() })} where id = ${id}`;
    } else {
      await tx`insert into app.customers ${tx({ id, ...data })}`;
      const [c] = await tx<Customer[]>`select * from app.customers where id = ${id}`;
      await tx`
        insert into app.invoice_groups (id, customer_id, name, combine, bill_emails, bill_format, buyer_reference,
                                        bill_supplier_no, bill_payment_terms_days, bill_skonto_percent_bp,
                                        bill_skonto_days, bill_contact_name)
        values (${standardGroupId(id)}, ${id}, 'Standard', false, ${c!.invoice_emails}, ${c!.invoice_format},
                ${c!.leitweg_id}, ${c!.supplier_no}, ${c!.payment_terms_days}, ${c!.skonto_percent_bp},
                ${c!.skonto_days}, ${c!.contact_name})
        on conflict (id) do nothing`;
    }
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
  // Rechnungsgruppe (Rechnungseinstellungen); neu angelegte Objekte ohne Angabe → Gruppe „Standard“ des Kunden
  invoice_group_id: z.preprocess(emptyToNull, z.uuid('Rechnungsgruppe ungültig').nullable()).optional(),
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
     order by length(s.site_no), s.site_no`;
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
    const data: Record<string, unknown> = Object.fromEntries(
      Object.entries(input).filter(([, v]) => v !== undefined),
    );
    if (!cur && !data.invoice_group_id) data.invoice_group_id = await defaultGroupId(tx, input.customer_id);
    await tx`insert into app.sites ${tx({ id, ...data })}
             on conflict (id) do update set ${tx({ ...data, updated_at: new Date() } as Record<string, unknown>)}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'save', 'site', ${id}, ${tx.json({ site_no: input.site_no })})`;
  });
}

/** Gruppe „Standard“ des Kunden (wird bei Bedarf angelegt), sonst erste aktive Gruppe. */
async function defaultGroupId(tx: Tx, customerId: string): Promise<string> {
  const [g] = await tx<{ id: string }[]>`
    select id from app.invoice_groups where customer_id = ${customerId} and active
     order by (id = ${standardGroupId(customerId)}) desc, (name = 'Standard') desc, name limit 1`;
  if (g) return g.id;
  const [c] = await tx<Customer[]>`select * from app.customers where id = ${customerId}`;
  if (!c) throw new BusinessError('Kunde nicht gefunden');
  const id = standardGroupId(customerId);
  await tx`
    insert into app.invoice_groups (id, customer_id, name, combine, bill_emails, bill_format, buyer_reference,
                                    bill_supplier_no, bill_payment_terms_days, bill_skonto_percent_bp, bill_skonto_days,
                                    bill_contact_name)
    values (${id}, ${customerId}, ${(await tx`select 1 from app.invoice_groups where customer_id = ${customerId} and name = 'Standard'`).length ? 'Standard (je Objekt)' : 'Standard'},
            false, ${c.invoice_emails}, ${c.invoice_format}, ${c.leitweg_id}, ${c.supplier_no}, ${c.payment_terms_days},
            ${c.skonto_percent_bp}, ${c.skonto_days}, ${c.contact_name})
    on conflict (id) do update set active = true`;
  return id;
}

/** Objekte ohne Rechnungsgruppe der Gruppe „Standard“ ihres Kunden zuordnen (z. B. nach Seed/Altdaten). */
export async function ensureSiteGroups(sql: Sql): Promise<number> {
  const open = await sql<{ id: string; customer_id: string }[]>`
    select id, customer_id from app.sites where invoice_group_id is null`;
  for (const st of open) {
    await sql.begin(async (tx) => {
      const gid = await defaultGroupId(tx, st.customer_id);
      await tx`update app.sites set invoice_group_id = ${gid} where id = ${st.id} and invoice_group_id is null`;
    });
  }
  return open.length;
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
  order_reference: string | null;
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
  // Art wird aus Zyklus/Einheit abgeleitet (siehe serviceKindOf); Angabe nur noch für Altaufrufer
  kind: z.enum(['monthly_flat', 'special', 'hourly']).optional(),
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
  // immer 19 %; § 13b (0 %) wird je Kunde/Rechnung gesetzt
  vat_rate_bp: z.coerce.number().int().min(1).max(10000).default(1900),
  valid_from: z.iso.date(),
  valid_to: z.preprocess(emptyToNull, z.iso.date().nullable().default(null)),
  note: optText,
  service_type_id: z.preprocess(emptyToNull, z.uuid().nullable().default(null)),
  billing_cycle: z
    .enum([
      'monatlich',
      'zweimonatlich',
      'quartalsweise',
      'halbjaehrlich',
      'jaehrlich',
      'einmalig',
      'je_ausfuehrung',
    ])
    .default('monatlich'),
  hours_target: optMilli,
  execution_notes: optText,
  cost_center: optText,
  order_reference: optText,
  labor_share: optPercentBp,
  always_unfinished: z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean()),
  // „objekt“ = Rechnungsgruppe/Rechnung des Objekts, „separat“ = eigene Rechnung, sonst ID einer Rechnungsgruppe
  invoice_target: z.preprocess(emptyToNull, z.string().nullable().default(null)),
  version: z.preprocess(
    (v) => (typeof v === 'string' && v !== '' ? Number(v) : null),
    z.number().int().nullable(),
  ),
});

/**
 * Art der Leistung aus Einheit und Zyklus: Stunden (HUR) = Regiestundensatz, regelmäßiger Zyklus = Pauschale im
 * Monatslauf, „einmalig“/„je Ausführung“ = Sonderleistung (Abrechnung über „Leistungen verrichten“).
 */
export function serviceKindOf(unitCode: string, cycle: BillingCycle): 'monthly_flat' | 'special' | 'hourly' {
  if (unitCode === 'HUR') return 'hourly';
  return cycle === 'einmalig' || cycle === 'je_ausfuehrung' ? 'special' : 'monthly_flat';
}

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
  const [site] = await sql<{ site_no: string }[]>`select site_no from app.sites where id = ${siteId}`;
  // Stunden sind nie Monatspauschale → bei Einheit Stunde immer „je Ausführung“
  const cycle = input.unit_code === 'HUR' ? 'je_ausfuehrung' : input.billing_cycle;
  const row = {
    site_id: siteId,
    kind: serviceKindOf(input.unit_code, cycle),
    description: input.description,
    unit_code: input.unit_code,
    quantity_milli: input.quantity,
    unit_price_cents: input.unit_price,
    vat_rate_bp: input.vat_rate_bp,
    valid_from: input.valid_from,
    valid_to: input.valid_to,
    note: input.note,
    service_type_id: input.service_type_id,
    billing_cycle: cycle,
    ...(input.hours_target != null ? { hours_target_milli: input.hours_target } : {}),
    execution_notes: input.execution_notes,
    // Kostenstelle = Objektnummer, wenn nichts anderes eingetragen ist
    cost_center: input.cost_center ?? site?.site_no ?? null,
    labor_share_bp: input.labor_share,
    order_reference: input.order_reference ? input.order_reference.slice(0, 100) : null,
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
  source: 'kunde' | 'gruppe' | 'objekt';
  groupName: string | null;
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

/** Rechnungseinstellungen einer Rechnungsgruppe (Teil von InvoiceGroup). */
export interface GroupBilling {
  id: string;
  name: string;
  combine: boolean;
  bill_name: string | null;
  bill_name2: string | null;
  bill_street: string | null;
  bill_postal_code: string | null;
  bill_city: string | null;
  bill_contact_name: string | null;
  bill_emails: string[];
  bill_format: InvoiceFormat;
  buyer_reference: string | null;
  bill_supplier_no: string | null;
  bill_payment_terms_days: number | null;
  bill_skonto_percent_bp: number | null;
  bill_skonto_days: number | null;
}

/**
 * Gültige Rechnungsangaben. Reihenfolge: (alt) abweichende Angaben direkt am Objekt → Rechnungsgruppe → Kunde.
 * Bei der Gruppe sind Format, E-Mails und Skonto verbindlich; leere Adresse/Leitweg-ID/Zahlungsziel → Kunde.
 */
export function resolveBilling(
  c: Customer,
  s: Partial<SiteBilling> | null | undefined,
  g?: GroupBilling | null,
): EffectiveBilling {
  const own = s?.billing_mode === 'eigen';
  const custSkonto =
    c.skonto_percent_bp && c.skonto_days ? { percentBp: c.skonto_percent_bp, days: c.skonto_days } : null;
  // Basis: Gruppe (falls vorhanden), sonst Kunde
  const base = g
    ? {
        name: g.bill_name ?? c.name,
        name2: g.bill_name ? g.bill_name2 : c.name2,
        street: g.bill_name ? g.bill_street! : c.street,
        postalCode: g.bill_name ? g.bill_postal_code! : c.postal_code,
        city: g.bill_name ? g.bill_city! : c.city,
        contactName: g.bill_contact_name ?? c.contact_name,
        emails: g.bill_emails,
        format: g.bill_format,
        leitwegId: g.buyer_reference ?? c.leitweg_id,
        supplierNo: g.bill_supplier_no ?? c.supplier_no,
        paymentTermsDays: g.bill_payment_terms_days ?? c.payment_terms_days,
        skonto:
          g.bill_skonto_percent_bp && g.bill_skonto_days
            ? { percentBp: g.bill_skonto_percent_bp, days: g.bill_skonto_days }
            : null,
      }
    : {
        name: c.name,
        name2: c.name2,
        street: c.street,
        postalCode: c.postal_code,
        city: c.city,
        contactName: c.contact_name,
        emails: c.invoice_emails,
        format: c.invoice_format,
        leitwegId: c.leitweg_id,
        supplierNo: c.supplier_no,
        paymentTermsDays: c.payment_terms_days,
        skonto: custSkonto,
      };
  if (!own) return { source: g ? 'gruppe' : 'kunde', groupName: g?.name ?? null, ...base };
  const addr = !!s?.bill_name;
  return {
    source: 'objekt',
    groupName: g?.name ?? null,
    name: addr ? s.bill_name! : base.name,
    name2: addr ? (s.bill_name2 ?? null) : base.name2,
    street: addr ? s.bill_street! : base.street,
    postalCode: addr ? s.bill_postal_code! : base.postalCode,
    city: addr ? s.bill_city! : base.city,
    contactName: s?.bill_contact_name || base.contactName,
    emails: s?.bill_emails?.length ? s.bill_emails : base.emails,
    format: s?.bill_format || base.format,
    leitwegId: s?.bill_leitweg_id || base.leitwegId,
    supplierNo: s?.bill_supplier_no || base.supplierNo,
    paymentTermsDays: s?.bill_payment_terms_days != null ? s.bill_payment_terms_days : base.paymentTermsDays,
    skonto: s?.bill_skonto_custom
      ? s.bill_skonto_percent_bp && s.bill_skonto_days
        ? { percentBp: s.bill_skonto_percent_bp, days: s.bill_skonto_days }
        : null
      : base.skonto,
  };
}

/** Rechnungsangaben für Kunde + Objekt; Gruppe = angegebene (z. B. der Rechnung), sonst die des Objekts. */
export async function effectiveBilling(
  sql: Sql,
  customerId: string,
  siteId: string | null,
  groupId?: string | null,
) {
  const c = await getCustomer(sql, customerId);
  if (!c) throw new BusinessError('Kunde nicht gefunden');
  const [s] = siteId
    ? await sql<(SiteBilling & { invoice_group_id: string | null })[]>`
        select * from app.sites where id = ${siteId} and customer_id = ${customerId}`
    : [];
  const gid = groupId ?? s?.invoice_group_id ?? null;
  const [g] = gid
    ? await sql<
        GroupBilling[]
      >`select * from app.invoice_groups where id = ${gid} and customer_id = ${customerId}`
    : [];
  return resolveBilling(c, s, g ?? null);
}

export async function buildBuyerSnapshot(
  sql: Sql,
  customerId: string,
  siteId: string | null,
  groupId?: string | null,
): Promise<BuyerSnapshot> {
  const c = await getCustomer(sql, customerId);
  if (!c) throw new Error('Kunde nicht gefunden');
  const b = await effectiveBilling(sql, customerId, siteId, groupId);
  const site = siteId ? await getSite(sql, siteId) : undefined;
  return {
    // SEPA-Lastschrift entfernt (06.10.2026): keine Vorabankündigung mehr auf der Rechnung
    directDebit: null,
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
