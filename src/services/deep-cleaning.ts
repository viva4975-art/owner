import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';

/*
 * Planung Grundreinigung (wie die alte App): Jahresplanung je Objekt, Verkaufspreis nach Belägen oder pauschal,
 * Kalkulation Deckungsbeitrag / Material / Geräte, Vorschlag an den Nachunternehmer bzw. Stunden in Eigenleistung
 * (40 € netto/Stunde). Alles in ganzen Cent und Basispunkten – keine Gleitkomma-Rundung.
 */

export const DC_STATUS = ['Geplant', 'Übergeben', 'Ausgeführt'] as const;
export const DC_STATUS_TONE: Record<string, string> = { Geplant: '', Übergeben: 'info', Ausgeführt: 'ok' };
export const BELAEGE = [
  'Linoleum',
  'PVC',
  'Stein',
  'Fliesen',
  'Parkett',
  'Holz',
  'Teppich',
  'Beton',
  'Marmor',
  'Kautschuk',
  'Estrich',
  'Sonstiges',
];
export const HOURLY_RATE_CENTS = 4000n;

export interface Floor {
  belag: string;
  sqm_x100: number;
  price_cents: number;
}

export interface DcPlan {
  id: string;
  year: number;
  customer: string | null;
  object: string;
  site_id: string | null;
  date_from: string | null;
  date_to: string | null;
  execution: 'eigen' | 'sub';
  supplier_id: string | null;
  supplier_name: string | null;
  mode: 'belaege' | 'pauschal';
  flat_sqm_x100: bigint | null;
  flat_price_cents: bigint | null;
  floors: Floor[];
  db_bp: number;
  material_bp: number;
  devices_bp: number;
  material_from: 'uns' | 'sub';
  devices_from: 'uns' | 'sub';
  sub_price_cents: bigint | null;
  max_hours: string | null;
  status: string;
  note: string | null;
  version: number;
}

/** kaufmännisch runden (half-up) bei Division ganzer Zahlen */
const div = (a: bigint, b: bigint) => (a >= 0n ? (a * 2n + b) / (2n * b) : -((-a * 2n + b) / (2n * b)));

export function calc(
  p: Pick<
    DcPlan,
    | 'mode'
    | 'flat_price_cents'
    | 'floors'
    | 'db_bp'
    | 'material_bp'
    | 'devices_bp'
    | 'material_from'
    | 'devices_from'
    | 'sub_price_cents'
  >,
) {
  const vk =
    p.mode === 'pauschal'
      ? (p.flat_price_cents ?? 0n)
      : p.floors.reduce((a, f) => a + div(BigInt(f.sqm_x100) * BigInt(f.price_cents), 100n), 0n);
  const db = div(vk * BigInt(p.db_bp), 10000n);
  const mat = div(vk * BigInt(p.material_bp), 10000n);
  const ger = div(vk * BigInt(p.devices_bp), 10000n);
  const ownMat = p.material_from === 'uns' ? mat : 0n;
  const ownGer = p.devices_from === 'uns' ? ger : 0n;
  const proposal = vk - db - ownMat - ownGer > 0n ? vk - db - ownMat - ownGer : 0n;
  const sub = p.sub_price_cents && p.sub_price_cents > 0n ? p.sub_price_cents : proposal;
  const effDb = vk - sub - ownMat - ownGer;
  // Stunden in Hundertstel (vk / 40 €)
  const hours100 = div(vk * 100n, HOURLY_RATE_CENTS);
  return { vk, db, mat, ger, proposal, sub, effDb, hours100 };
}

export function summary(p: DcPlan) {
  return p.mode === 'pauschal'
    ? `Pauschal ${fmtSqm(p.flat_sqm_x100 ?? 0n)} m²`
    : p.floors.map((f) => `${f.belag} ${fmtSqm(BigInt(f.sqm_x100))} m²`).join('; ');
}
export const fmtSqm = (x100: bigint) => {
  const s = (Number(x100) / 100).toFixed(2).replace('.', ',');
  return s.endsWith(',00') ? s.slice(0, -3) : s;
};

export async function listPlans(sql: Sql, year: number) {
  return sql<DcPlan[]>`
    select p.*, p.date_from::text, p.date_to::text, s.name as supplier_name
      from app.deep_cleaning_plans p left join app.suppliers s on s.id = p.supplier_id
     where p.year = ${year} order by p.date_from nulls last, p.object`;
}

export async function getPlan(sql: Sql, id: string) {
  const [p] = await sql<DcPlan[]>`
    select p.*, p.date_from::text, p.date_to::text, s.name as supplier_name
      from app.deep_cleaning_plans p left join app.suppliers s on s.id = p.supplier_id where p.id = ${id}`;
  return p;
}

export type PlanInput = Omit<DcPlan, 'id' | 'version' | 'supplier_name' | 'year'> & {
  expectedVersion: number | null;
};

export async function savePlan(sql: Sql, id: string, p: PlanInput, actor: string) {
  if (!p.object.trim()) throw new BusinessError('Objekt / Adresse fehlt');
  if (!p.date_from) throw new BusinessError('Bitte den Zeitraum (von) angeben');
  if (p.date_to && p.date_to < p.date_from) throw new BusinessError('„Bis“ liegt vor „Von“');
  if (!DC_STATUS.includes(p.status as never)) throw new BusinessError('Status ungültig');
  for (const bp of [p.db_bp, p.material_bp, p.devices_bp])
    if (!Number.isInteger(bp) || bp < 0 || bp > 10000) throw new BusinessError('Prozentwerte 0–100');
  if (p.mode === 'belaege') {
    if (!p.floors.length)
      throw new BusinessError('Bitte mindestens einen Belag mit Fläche und Preis angeben');
    for (const f of p.floors)
      if (!BELAEGE.includes(f.belag) || !(f.sqm_x100 > 0) || !(f.price_cents >= 0))
        throw new BusinessError(`Belag ${f.belag}: Fläche und Preis prüfen`);
  } else if (!p.flat_price_cents || p.flat_price_cents <= 0n)
    throw new BusinessError('Verkaufspreis gesamt fehlt');
  // wie alte App: Nachunternehmer gewählt und noch „Geplant“ → „Übergeben“
  const status = p.execution === 'sub' && p.supplier_id && p.status === 'Geplant' ? 'Übergeben' : p.status;
  const row = {
    year: Number(p.date_from.slice(0, 4)),
    customer: p.customer?.trim() || null,
    object: p.object.trim(),
    site_id: p.site_id || null,
    date_from: p.date_from,
    date_to: p.date_to || null,
    execution: p.execution,
    supplier_id: p.execution === 'sub' ? p.supplier_id || null : null,
    mode: p.mode,
    flat_sqm_x100: p.mode === 'pauschal' ? p.flat_sqm_x100 : null,
    flat_price_cents: p.mode === 'pauschal' ? p.flat_price_cents : null,
    floors: sql.json((p.mode === 'belaege' ? p.floors : []) as never),
    db_bp: p.db_bp,
    material_bp: p.material_bp,
    devices_bp: p.devices_bp,
    material_from: p.material_from,
    devices_from: p.devices_from,
    sub_price_cents: p.execution === 'sub' ? p.sub_price_cents : null,
    max_hours: p.execution === 'eigen' ? p.max_hours : null,
    status,
    note: p.note?.trim() || null,
  };
  const [cur] = await sql<
    { version: number }[]
  >`select version from app.deep_cleaning_plans where id = ${id}`;
  if (cur) {
    if (p.expectedVersion != null && cur.version !== p.expectedVersion)
      throw new BusinessError('Die Planung wurde zwischenzeitlich geändert – bitte neu laden');
    await sql`update app.deep_cleaning_plans set ${sql(row as never)} where id = ${id}`;
  } else
    await sql`insert into app.deep_cleaning_plans ${sql({ id, ...row, created_by: actor } as never)} on conflict (id) do nothing`;
}

export async function setPlanStatus(sql: Sql, id: string, status: string) {
  if (!DC_STATUS.includes(status as never)) throw new BusinessError('Status ungültig');
  await sql`update app.deep_cleaning_plans set status = ${status} where id = ${id}`;
}

export async function deletePlan(sql: Sql, id: string) {
  await sql`delete from app.deep_cleaning_plans where id = ${id}`;
}
