import { z } from 'zod';
import type { Sql } from '../db/client.js';
import { parseEuro, parseQuantity } from '../domain/money/money.js';
import { assertVersion } from './crm.js';
import { BusinessError } from './errors.js';

/*
 * Lieferanten & Nachunternehmer, Artikel mit Bestand/Nachbestellung, Geräte mit Prüfterminen, Schlüsselbuch.
 * Alle Schreibvorgänge mit fester ID (idempotent) und optimistischer Sperre (version).
 */

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optText = z.preprocess(emptyToNull, z.string().trim().nullable().default(null));
const optDate = z.preprocess(emptyToNull, z.iso.date('Datum ungültig').nullable().default(null));
const bool = z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean());

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BusinessError(r.error.issues.map((i) => i.message).join('\n'));
  return r.data;
}

async function upsert(
  sql: Sql,
  table: string,
  id: string,
  data: Record<string, unknown>,
  expectedVersion: number | null,
  label: string,
  actor: string,
) {
  await sql.begin(async (tx) => {
    const [cur] = await tx<
      { version: number }[]
    >`select version from ${tx('app.' + table)} where id = ${id} for update`;
    assertVersion(cur?.version, expectedVersion, label);
    try {
      if (cur)
        await tx`update ${tx('app.' + table)} set ${tx({ ...data, updated_at: new Date() })} where id = ${id}`;
      else await tx`insert into ${tx('app.' + table)} ${tx({ id, ...data })}`;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new BusinessError('Nummer ist bereits vergeben');
      throw err;
    }
    await tx`insert into app.audit_log (actor, action, entity, entity_id) values (${actor}, ${cur ? 'update' : 'create'}, ${table}, ${id})`;
  });
}

async function nextNo(sql: Sql, table: string, col: string, start: number): Promise<string> {
  const [r] = await sql<{ n: string }[]>`
    select (coalesce(max(${sql(col)}::bigint) filter (where ${sql(col)} ~ '^[0-9]+$'), ${start - 1}) + 1)::text as n from ${sql('app.' + table)}`;
  return r!.n;
}

// ---------------------------------------------------------------------------
// Lieferanten & Nachunternehmer
// ---------------------------------------------------------------------------

export interface Supplier {
  id: string;
  supplier_no: string;
  name: string;
  kind: 'lieferant' | 'nachunternehmer';
  street: string | null;
  postal_code: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
  contact_name: string | null;
  vat_id: string | null;
  iban: string | null;
  bic: string | null;
  payment_terms_days: number;
  exemption_valid_until: string | null;
  clearance_valid_until: string | null;
  notes: string | null;
  active: boolean;
  version: number;
}

export const supplierInput = z.object({
  supplier_no: z.string().trim().min(1, 'Lieferantennummer fehlt'),
  name: z.string().trim().min(1, 'Name fehlt'),
  kind: z.enum(['lieferant', 'nachunternehmer']),
  street: optText,
  postal_code: optText,
  city: optText,
  email: z.preprocess(emptyToNull, z.email('E-Mail ungültig').nullable().default(null)),
  phone: optText,
  contact_name: optText,
  vat_id: optText,
  iban: z.preprocess(
    (v) => (typeof v === 'string' ? v.replace(/\s/g, '').toUpperCase() || null : v),
    z
      .string()
      .regex(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/, 'IBAN ungültig')
      .nullable()
      .default(null),
  ),
  bic: optText,
  payment_terms_days: z.coerce.number().int().min(0).max(365),
  exemption_valid_until: optDate,
  clearance_valid_until: optDate,
  notes: optText,
  active: bool,
});

export async function listSuppliers(sql: Sql) {
  return sql<(Supplier & { exemption_days: number | null; clearance_days: number | null })[]>`
    select s.*, (s.exemption_valid_until - (now() at time zone 'Europe/Berlin')::date)::int as exemption_days,
           (s.clearance_valid_until - (now() at time zone 'Europe/Berlin')::date)::int as clearance_days
      from app.suppliers s order by s.active desc, s.name`;
}

export async function getSupplier(sql: Sql, id: string) {
  const [s] = await sql<Supplier[]>`select * from app.suppliers where id = ${id}`;
  return s;
}

export async function saveSupplier(
  sql: Sql,
  id: string,
  body: unknown,
  expectedVersion: number | null,
  actor: string,
) {
  const data = parse(supplierInput, body);
  await upsert(sql, 'suppliers', id, data, expectedVersion, 'Der Lieferant', actor);
}

export const suggestSupplierNo = (sql: Sql) => nextNo(sql, 'suppliers', 'supplier_no', 70001);

/** Nachunternehmer, deren Nachweise in ≤ 30 Tagen ablaufen oder fehlen. */
export async function supplierWarnings(sql: Sql) {
  return sql<
    { id: string; name: string; exemption_valid_until: string | null; clearance_valid_until: string | null }[]
  >`
    select id, name, exemption_valid_until, clearance_valid_until from app.suppliers
     where active and kind = 'nachunternehmer'
       and (exemption_valid_until is null or exemption_valid_until < (now() at time zone 'Europe/Berlin')::date + 30
            or clearance_valid_until is null or clearance_valid_until < (now() at time zone 'Europe/Berlin')::date + 30)
     order by least(coalesce(exemption_valid_until, '1900-01-01'), coalesce(clearance_valid_until, '1900-01-01'))`;
}

// ---------------------------------------------------------------------------
// Artikel & Bestand
// ---------------------------------------------------------------------------

export interface Article {
  id: string;
  article_no: string;
  name: string;
  unit: string;
  stock_milli: bigint;
  min_stock_milli: bigint;
  supplier_id: string | null;
  purchase_price_cents: bigint | null;
  active: boolean;
  version: number;
}

export async function listArticles(sql: Sql, opts: { reorder?: boolean } = {}) {
  return sql<(Article & { supplier_name: string | null })[]>`
    select a.*, s.name as supplier_name from app.articles a left join app.suppliers s on s.id = a.supplier_id
     where ${opts.reorder ? sql`a.active and a.stock_milli <= a.min_stock_milli` : sql`true`}
     order by a.active desc, a.name`;
}

export async function getArticle(sql: Sql, id: string) {
  const [a] = await sql<Article[]>`select * from app.articles where id = ${id}`;
  return a;
}

export async function saveArticle(
  sql: Sql,
  id: string,
  body: Record<string, unknown>,
  expectedVersion: number | null,
  actor: string,
) {
  const s = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
  if (!s('article_no') || !s('name')) throw new BusinessError('Artikelnummer und Bezeichnung angeben');
  let min: bigint;
  let price: bigint | null = null;
  try {
    min = parseQuantity(s('min_stock') || '0');
    if (s('purchase_price')) price = parseEuro(s('purchase_price'));
  } catch {
    throw new BusinessError('Mindestbestand oder Einkaufspreis ungültig');
  }
  await upsert(
    sql,
    'articles',
    id,
    {
      article_no: s('article_no'),
      name: s('name'),
      unit: s('unit') || 'Stk.',
      min_stock_milli: min,
      supplier_id: s('supplier_id') || null,
      purchase_price_cents: price,
      active: body.active === 'on' || body.active === 'true',
    },
    expectedVersion,
    'Der Artikel',
    actor,
  );
}

export const suggestArticleNo = (sql: Sql) => nextNo(sql, 'articles', 'article_no', 1001);

/** Zu-/Abgang buchen. Feste ID → doppeltes Absenden bucht nur einmal. Bestand darf nicht negativ werden. */
export async function bookStock(
  sql: Sql,
  id: string,
  articleId: string,
  deltaMilli: bigint,
  reason: string,
  siteId: string | null,
  actor: string,
) {
  if (deltaMilli === 0n) throw new BusinessError('Menge darf nicht 0 sein');
  if (!reason.trim())
    throw new BusinessError('Bitte einen Grund angeben (z. B. Lieferung, Ausgabe an Objekt)');
  await sql.begin(async (tx) => {
    const [done] = await tx`select 1 from app.stock_movements where id = ${id}`;
    if (done) return;
    const [a] = await tx<
      { stock_milli: bigint }[]
    >`select stock_milli from app.articles where id = ${articleId} for update`;
    if (!a) throw new BusinessError('Artikel nicht gefunden');
    if (a.stock_milli + deltaMilli < 0n)
      throw new BusinessError('Bestand würde negativ – bitte Menge prüfen');
    await tx`insert into app.stock_movements (id, article_id, delta_milli, reason, site_id, created_by)
             values (${id}, ${articleId}, ${deltaMilli}, ${reason.trim()}, ${siteId}, ${actor})`;
    await tx`update app.articles set stock_milli = stock_milli + ${deltaMilli}, updated_at = now() where id = ${articleId}`;
  });
}

export async function listMovements(sql: Sql, articleId: string) {
  return sql<
    {
      id: string;
      delta_milli: bigint;
      reason: string;
      site_name: string | null;
      created_by: string;
      created_at: Date;
    }[]
  >`
    select m.*, s.name as site_name from app.stock_movements m left join app.sites s on s.id = m.site_id
     where m.article_id = ${articleId} order by m.created_at desc limit 100`;
}

// ---------------------------------------------------------------------------
// Geräte
// ---------------------------------------------------------------------------

export interface Device {
  id: string;
  inventory_no: string;
  name: string;
  manufacturer: string | null;
  serial_no: string | null;
  site_id: string | null;
  purchase_date: string | null;
  next_inspection: string | null;
  notes: string | null;
  active: boolean;
  version: number;
}

export const deviceInput = z.object({
  inventory_no: z.string().trim().min(1, 'Inventarnummer fehlt'),
  name: z.string().trim().min(1, 'Bezeichnung fehlt'),
  manufacturer: optText,
  serial_no: optText,
  site_id: z.preprocess(emptyToNull, z.uuid().nullable().default(null)),
  purchase_date: optDate,
  next_inspection: optDate,
  notes: optText,
  active: bool,
});

export async function listDevices(sql: Sql) {
  return sql<(Device & { site_name: string | null; days: number | null })[]>`
    select d.*, s.name as site_name, (d.next_inspection - (now() at time zone 'Europe/Berlin')::date)::int as days
      from app.devices d left join app.sites s on s.id = d.site_id
     order by d.active desc, d.next_inspection nulls last, d.name`;
}

export async function getDevice(sql: Sql, id: string) {
  const [d] = await sql<Device[]>`select * from app.devices where id = ${id}`;
  return d;
}

export async function saveDevice(
  sql: Sql,
  id: string,
  body: unknown,
  expectedVersion: number | null,
  actor: string,
) {
  await upsert(sql, 'devices', id, parse(deviceInput, body), expectedVersion, 'Das Gerät', actor);
}

export const suggestInventoryNo = (sql: Sql) => nextNo(sql, 'devices', 'inventory_no', 5001);

// ---------------------------------------------------------------------------
// Schlüsselbuch
// ---------------------------------------------------------------------------

export interface KeyRow {
  id: string;
  key_no: string;
  site_id: string;
  description: string;
  quantity: number;
  holder_employee_id: string | null;
  issued_at: string | null;
  notes: string | null;
  version: number;
}

export const keyInput = z.object({
  key_no: z.string().trim().min(1, 'Schlüsselnummer fehlt'),
  site_id: z.uuid('Bitte ein Objekt wählen'),
  description: z.string().trim().min(1, 'Beschreibung fehlt (z. B. Haupteingang, Generalschlüssel)'),
  quantity: z.coerce.number().int().min(1),
  notes: optText,
});

export async function listKeys(sql: Sql) {
  return sql<(KeyRow & { site_name: string; site_no: string; holder_name: string | null })[]>`
    select k.*, s.name as site_name, s.site_no,
           case when e.id is null then null else e.last_name || ', ' || e.first_name end as holder_name
      from app.keys k join app.sites s on s.id = k.site_id left join app.employees e on e.id = k.holder_employee_id
     order by s.site_no, k.key_no`;
}

export async function getKey(sql: Sql, id: string) {
  const [k] = await sql<KeyRow[]>`select * from app.keys where id = ${id}`;
  return k;
}

export async function saveKey(
  sql: Sql,
  id: string,
  body: unknown,
  expectedVersion: number | null,
  actor: string,
) {
  await upsert(sql, 'keys', id, parse(keyInput, body), expectedVersion, 'Der Schlüssel', actor);
}

/** Ausgabe / Rückgabe / Verlust – immer mit Protokolleintrag (unveränderbar). */
export async function keyAction(
  sql: Sql,
  keyId: string,
  action: 'ausgabe' | 'rueckgabe' | 'verlust',
  employeeId: string | null,
  at: string,
  note: string | null,
  actor: string,
) {
  await sql.begin(async (tx) => {
    const [k] = await tx<KeyRow[]>`select * from app.keys where id = ${keyId} for update`;
    if (!k) throw new BusinessError('Schlüssel nicht gefunden');
    if (action === 'ausgabe') {
      if (!employeeId) throw new BusinessError('Bitte Mitarbeiter wählen');
      if (k.holder_employee_id)
        throw new BusinessError('Schlüssel ist bereits ausgegeben – zuerst Rückgabe buchen');
      await tx`update app.keys set holder_employee_id = ${employeeId}, issued_at = ${at} where id = ${keyId}`;
    } else {
      if (!k.holder_employee_id) throw new BusinessError('Schlüssel ist nicht ausgegeben');
      employeeId = k.holder_employee_id;
      await tx`update app.keys set holder_employee_id = null, issued_at = null where id = ${keyId}`;
    }
    await tx`insert into app.key_log (key_id, action, employee_id, at, note, created_by)
             values (${keyId}, ${action}, ${employeeId}, ${at}, ${note}, ${actor})`;
  });
}

export async function keyLog(sql: Sql, keyId: string) {
  return sql<
    {
      action: string;
      at: string;
      note: string | null;
      employee_name: string | null;
      created_by: string;
      created_at: Date;
    }[]
  >`
    select l.action, l.at, l.note, l.created_by, l.created_at,
           case when e.id is null then null else e.last_name || ', ' || e.first_name end as employee_name
      from app.key_log l left join app.employees e on e.id = l.employee_id
     where l.key_id = ${keyId} order by l.created_at desc`;
}
