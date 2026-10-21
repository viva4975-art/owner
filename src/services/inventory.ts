import { z } from 'zod';
import type { Sql, Tx } from '../db/client.js';
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
  legal_form?: string | null;
}

export const supplierInput = z.object({
  supplier_no: z.string().trim().min(1, 'Lieferantennummer fehlt'),
  name: z.string().trim().min(1, 'Name fehlt'),
  kind: z.enum(['lieferant', 'nachunternehmer']),
  legal_form: z.preprocess(
    emptyToNull,
    z
      .enum([
        'einzelunternehmen',
        'kleingewerbe',
        'freiberufler',
        'gbr',
        'ek',
        'ohg',
        'kg',
        'gmbh_co_kg',
        'gmbh',
        'ug',
        'ag',
        'kgaa',
        'eg',
        'sonstige',
      ])
      .nullable()
      .default(null),
  ),
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
  const parsed = parse(supplierInput, body) as Record<string, unknown>;
  // Felder, die nicht mehr im Formular stehen (Nachweis-Fristen, Ansprechpartner → eigene Reiter), nicht überschreiben
  const b = (body ?? {}) as Record<string, unknown>;
  const keep = new Set(
    ['exemption_valid_until', 'clearance_valid_until', 'contact_name'].filter((k) => !(k in b)),
  );
  const data = Object.fromEntries(Object.entries(parsed).filter(([k]) => !keep.has(k)));
  await upsert(sql, 'suppliers', id, data as never, expectedVersion, 'Der Lieferant', actor);
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
  sales_price_cents: bigint | null;
  description: string | null;
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
  let sales: bigint | null = null;
  try {
    min = parseQuantity(s('min_stock') || '0');
    if (s('purchase_price')) price = parseEuro(s('purchase_price'));
    if (s('sales_price')) sales = parseEuro(s('sales_price'));
  } catch {
    throw new BusinessError('Mindestbestand, Einkaufs- oder Verkaufspreis ungültig');
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
      ...(body.sales_price !== undefined ? { sales_price_cents: sales } : {}),
      ...(body.description !== undefined ? { description: s('description') || null } : {}),
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
      { stock_milli: bigint; purchase_price_cents: bigint | null }[]
    >`select stock_milli, purchase_price_cents from app.articles where id = ${articleId} for update`;
    if (!a) throw new BusinessError('Artikel nicht gefunden');
    if (a.stock_milli + deltaMilli < 0n)
      throw new BusinessError('Bestand würde negativ – bitte Menge prüfen');
    // EK zum Buchungstag festhalten (Nachkalkulation rechnet damit, nicht mit späteren Preisänderungen)
    await tx`insert into app.stock_movements (id, article_id, delta_milli, reason, site_id, created_by, unit_cost_cents)
             values (${id}, ${articleId}, ${deltaMilli}, ${reason.trim()}, ${siteId}, ${actor}, ${a.purchase_price_cents})`;
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
  kind: string;
  status: string;
  qr_token: string;
}

export const deviceInput = z.object({
  inventory_no: z.string().trim().min(1, 'Inventarnummer fehlt'),
  name: z.string().trim().min(1, 'Bezeichnung fehlt'),
  manufacturer: optText,
  serial_no: optText,
  site_id: z.preprocess(emptyToNull, z.guid().nullable().default(null)),
  purchase_date: optDate,
  next_inspection: optDate,
  notes: optText,
  active: bool,
  kind: z
    .enum([
      'scheuersaugmaschine',
      'staubsauger',
      'nasssauger',
      'wischwagen',
      'reinigungswagen',
      'einscheibenmaschine',
      'hochdruckreiniger',
      'leiter',
      'sonstiges',
    ])
    .default('sonstiges'),
  status: z.enum(['ok', 'defekt', 'reparatur']).default('ok'),
});

export type DeviceListRow = Device & {
  site_name: string | null;
  site_no: string | null;
  days: number | null;
  /** letzter Scan aus der App (Zeitpunkt, wer, Standort) */
  seen_at: Date | null;
  seen_by: string | null;
  seen_lat: string | null;
  seen_lng: string | null;
  seen_days: number | null;
};

export async function listDevices(sql: Sql) {
  return sql<DeviceListRow[]>`
    select d.*, s.name as site_name, s.site_no,
           (d.next_inspection - (now() at time zone 'Europe/Berlin')::date)::int as days,
           e.created_at as seen_at, e.by_name as seen_by, e.lat::text as seen_lat, e.lng::text as seen_lng,
           ((now() at time zone 'Europe/Berlin')::date - (e.created_at at time zone 'Europe/Berlin')::date)::int as seen_days
      from app.devices d left join app.sites s on s.id = d.site_id
      left join lateral (
        select x.created_at, x.by_name, x.lat, x.lng from app.device_events x
         where x.device_id = d.id and x.action in ('hier', 'mitgenommen', 'lager', 'defekt')
         order by x.created_at desc limit 1) e on true
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
  holder_supplier_id: string | null;
  issued_at: string | null;
  notes: string | null;
  version: number;
}

export const keyInput = z.object({
  key_no: z.string().trim().max(60).optional().default(''),
  site_id: z.guid('Bitte ein Objekt wählen'),
  description: z.string().trim().min(1, 'Beschreibung fehlt (z. B. Haupteingang, Generalschlüssel)'),
  quantity: z.coerce.number().int().min(1),
  notes: optText,
});

export async function listKeys(sql: Sql) {
  return sql<(KeyRow & { site_name: string; site_no: string; holder_name: string | null })[]>`
    select k.*, s.name as site_name, s.site_no,
           case when e.id is not null then e.last_name || ', ' || e.first_name
                when sp.id is not null then sp.name || ' (NU)' end as holder_name
      from app.keys k join app.sites s on s.id = k.site_id left join app.employees e on e.id = k.holder_employee_id
      left join app.suppliers sp on sp.id = k.holder_supplier_id
     where k.deleted_at is null
     order by s.site_no, k.key_no`;
}

/** Nächste freie Schlüsselnummer S-<Objektnr.>-NN (gelöschte Nummern werden nicht wieder vergeben). */
export async function nextKeyNo(sql: Sql | Tx, siteId: string): Promise<string> {
  const [s] = await sql<{ site_no: string }[]>`select site_no from app.sites where id = ${siteId}`;
  if (!s) throw new BusinessError('Objekt nicht gefunden');
  const prefix = `S-${s.site_no}-`;
  const rows = await sql<{ key_no: string }[]>`
    select key_no from app.keys where key_no like ${prefix.replace(/[%_\\]/g, '\\$&') + '%'}`;
  let max = 0;
  for (const r of rows) {
    const n = Number(r.key_no.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(2, '0')}`;
}

/** Nächste Nummer je Objekt (für die Vorbelegung im Formular). */
export async function nextKeyNos(sql: Sql): Promise<Record<string, string>> {
  const rows = await sql<{ id: string; site_no: string; max: number | null }[]>`
    select s.id, s.site_no,
           max(case when substring(k.key_no from length('S-' || s.site_no || '-') + 1) ~ '^[0-9]+$'
                    then substring(k.key_no from length('S-' || s.site_no || '-') + 1)::int end) as max
      from app.sites s left join app.keys k on k.key_no like 'S-' || s.site_no || '-%'
     group by s.id, s.site_no`;
  return Object.fromEntries(
    rows.map((r) => [r.id, `S-${r.site_no}-${String((r.max ?? 0) + 1).padStart(2, '0')}`]),
  );
}

/**
 * Schlüssel löschen: ausgegebene erst zurückbuchen. Ohne Protokoll ganz weg, sonst nur ausgeblendet (Nachweis bleibt).
 */
export async function deleteKey(sql: Sql, id: string, actor: string) {
  await sql.begin(async (tx) => {
    const [k] = await tx<
      (KeyRow & { deleted_at: Date | null })[]
    >`select * from app.keys where id = ${id} for update`;
    if (!k || k.deleted_at) throw new BusinessError('Schlüssel nicht gefunden');
    if (k.holder_employee_id || k.holder_supplier_id)
      throw new BusinessError(`Schlüssel ${k.key_no} ist ausgegeben – zuerst Rückgabe buchen`);
    const [{ n }] =
      (await tx`select count(*)::int as n from app.key_log where key_id = ${id}`) as unknown as [
        { n: number },
      ];
    const used = (
      await tx`select 1 from app.handovers where items @> ${tx.json([{ key_id: id }] as never)} limit 1`
    ).length;
    if (n || used) await tx`update app.keys set deleted_at = now(), deleted_by = ${actor} where id = ${id}`;
    else await tx`delete from app.keys where id = ${id}`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'delete', 'keys', ${id}, ${tx.json({ stand: k as never, nur_ausgeblendet: !!(n || used) })})`;
  });
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
  const data = parse(keyInput, body);
  if (!data.key_no) {
    const [cur] = await sql<
      { key_no: string; site_id: string }[]
    >`select key_no, site_id from app.keys where id = ${id}`;
    data.key_no = cur && cur.site_id === data.site_id ? cur.key_no : await nextKeyNo(sql, data.site_id);
  }
  await upsert(sql, 'keys', id, data, expectedVersion, 'Der Schlüssel', actor);
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
  await sql.begin((tx) => keyActionTx(tx, keyId, action, employeeId, at, note, actor));
}

/** Wie keyAction, innerhalb einer laufenden Transaktion (z. B. Übergabe mit Unterschrift). */
export async function keyActionTx(
  tx: Tx,
  keyId: string,
  action: 'ausgabe' | 'rueckgabe' | 'verlust',
  employeeId: string | null,
  at: string,
  note: string | null,
  actor: string,
  supplierId: string | null = null,
) {
  const [k] = await tx<KeyRow[]>`select * from app.keys where id = ${keyId} for update`;
  if (!k || (k as { deleted_at?: Date | null }).deleted_at)
    throw new BusinessError('Schlüssel nicht gefunden');
  if (action === 'ausgabe') {
    if (!employeeId && !supplierId) throw new BusinessError('Bitte Mitarbeiter wählen');
    if (k.holder_employee_id || k.holder_supplier_id)
      throw new BusinessError(`Schlüssel ${k.key_no} ist bereits ausgegeben – zuerst Rückgabe buchen`);
    await tx`update app.keys set holder_employee_id = ${employeeId}, holder_supplier_id = ${employeeId ? null : supplierId},
                    issued_at = ${at} where id = ${keyId}`;
  } else {
    if (!k.holder_employee_id && !k.holder_supplier_id)
      throw new BusinessError(`Schlüssel ${k.key_no} ist nicht ausgegeben`);
    employeeId = k.holder_employee_id;
    supplierId = k.holder_supplier_id;
    await tx`update app.keys set holder_employee_id = null, holder_supplier_id = null, issued_at = null where id = ${keyId}`;
  }
  await tx`insert into app.key_log (key_id, action, employee_id, supplier_id, at, note, created_by)
           values (${keyId}, ${action}, ${employeeId}, ${employeeId ? null : supplierId}, ${at}, ${note}, ${actor})`;
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
