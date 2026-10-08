import type { Sql, Tx } from '../db/client.js';
import { uuidOf } from './fortytools-export-import.js';

/*
 * Dubletten aus den Fortytools-Importen zusammenführen (Fund 07.10.: erst XML-, dann CSV-Import → jedes Objekt und viele
 * Interessenten doppelt, Leistungen doppelt, Monatsbeträge falsch).
 * Behalten wird immer der Datensatz aus dem XML-Import (Fortytools-Nummer, Rechnungsarchiv, Tiefgaragen hängen daran),
 * zusammengeführt wird nur der aus dem CSV-Import mit gleichem Kunden und gleichem Namen. Alles, was am doppelten Datensatz
 * hängt (Leistungen, Kontakte, Einsätze …), wird umgehängt; danach wird die Dublette gelöscht – geht das nicht (z. B. schon
 * ausgestellte Rechnung), wird sie deaktiviert und als „(Dublette)“ markiert. Die aus Rechnungen abgeleiteten
 * Monatspauschalen werden abgeschaltet, wenn das Objekt danach echte Leistungen aus dem CSV-Export hat.
 */

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');

export interface DupPair {
  kind: 'Kunde' | 'Objekt';
  keepId: string;
  keepLabel: string;
  dupId: string;
  dupLabel: string;
  customer: string;
  services: number;
}

export interface DupResult {
  pairs: DupPair[];
  merged: number;
  deactivated: string[];
  derivedOff: number;
}

async function findPairs(sql: Sql | Tx): Promise<DupPair[]> {
  const pairs: DupPair[] = [];
  const customers = await (sql as Sql)<
    { id: string; customer_no: string; name: string; external_ref: string | null }[]
  >`select id, customer_no, name, external_ref from app.customers order by customer_no`;
  const byName = new Map<string, (typeof customers)[number][]>();
  for (const c of customers) byName.set(norm(c.name), [...(byName.get(norm(c.name)) ?? []), c]);
  for (const list of byName.values()) {
    const keep = list.filter((c) => c.external_ref?.startsWith('ftx:c:'));
    const dups = list.filter((c) => c.external_ref?.startsWith('ft:k') && !c.external_ref.startsWith('ftx'));
    for (let i = 0; i < Math.min(keep.length, dups.length); i++)
      pairs.push({
        kind: 'Kunde',
        keepId: keep[i]!.id,
        keepLabel: `${keep[i]!.customer_no} ${keep[i]!.name}`,
        dupId: dups[i]!.id,
        dupLabel: `${dups[i]!.customer_no} ${dups[i]!.name}`,
        customer: keep[i]!.name,
        services: 0,
      });
  }
  const sites = await (sql as Sql)<
    {
      id: string;
      site_no: string;
      name: string;
      street: string | null;
      customer_id: string;
      customer_name: string;
      external_ref: string | null;
      services: number;
    }[]
  >`select s.id, s.site_no, s.name, s.street, s.customer_id, c.name as customer_name, s.external_ref,
           (select count(*)::int from app.site_services v where v.site_id = s.id and v.active) as services
      from app.sites s join app.customers c on c.id = s.customer_id order by s.site_no`;
  // Kunden-Dubletten werden zuerst zusammengeführt → Objekte über den behaltenen Kunden vergleichen
  const custOf = new Map(pairs.map((p) => [p.dupId, p.keepId]));
  const groups = new Map<string, (typeof sites)[number][]>();
  for (const s of sites) {
    const k = `${custOf.get(s.customer_id) ?? s.customer_id}|${norm(s.name)}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  for (const list of groups.values()) {
    const keep = list.filter((s) => s.external_ref?.startsWith('ftx:f:'));
    const dups = list.filter((s) => s.external_ref?.startsWith('ft:o:'));
    const free = [...keep];
    for (const d of dups) {
      if (!free.length) break;
      // nur gleiche Adresse zusammenführen (Fund: „Treppenhaus“ Baaderstr. wurde sonst in Stollbergstr. gelegt)
      let i = free.findIndex((k) => norm(k.street ?? '') === norm(d.street ?? ''));
      if (i < 0 && free.length === 1 && dups.length === 1 && (!free[0]!.street || !d.street)) i = 0;
      if (i < 0) continue;
      const k = free.splice(i, 1)[0]!;
      pairs.push({
        kind: 'Objekt',
        keepId: k.id,
        keepLabel: `${k.site_no} ${k.name}`,
        dupId: d.id,
        dupLabel: `${d.site_no} ${d.name}`,
        customer: k.customer_name,
        services: d.services,
      });
    }
  }
  return pairs;
}

/** Alle Fremdschlüssel auf app.<table>(id) umhängen; Tabellen, bei denen das nicht geht, werden übersprungen. */
async function moveRefs(tx: Tx, table: 'sites' | 'customers', from: string, to: string, skip: string[] = []) {
  const fks = await tx<{ tbl: string; col: string }[]>`
    select conrelid::regclass::text as tbl, a.attname as col
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
     where c.contype = 'f' and c.confrelid = ${`app.${table}`}::regclass and array_length(c.conkey, 1) = 1`;
  const blocked: string[] = [];
  for (const f of fks) {
    if (skip.includes(f.tbl)) continue;
    try {
      await tx.savepoint(async (sp) => {
        await sp.unsafe(`update ${f.tbl} set ${f.col} = $1 where ${f.col} = $2`, [to, from]);
      });
    } catch {
      blocked.push(f.tbl);
    }
  }
  return blocked;
}

export async function importDuplicates(
  sql: Sql,
  opts: { apply: boolean; actor: string },
): Promise<DupResult> {
  if (!opts.apply) return { pairs: await findPairs(sql), merged: 0, deactivated: [], derivedOff: 0 };
  return sql.begin(async (tx) => {
    const pairs = await findPairs(tx);
    const res: DupResult = { pairs, merged: 0, deactivated: [], derivedOff: 0 };
    for (const p of pairs.filter((x) => x.kind === 'Kunde')) {
      // Objekte des doppelten Kunden landen in der Standard-Rechnungsgruppe des behaltenen
      const [g] = await tx<{ id: string }[]>`
        select id from app.invoice_groups where customer_id = ${p.keepId} and active order by (name = 'Standard') desc limit 1`;
      await tx`update app.sites set customer_id = ${p.keepId}, invoice_group_id = ${g?.id ?? null}
                where customer_id = ${p.dupId}`;
      await moveRefs(tx, 'customers', p.dupId, p.keepId, ['app.invoice_groups', 'app.sites']);
      await removeOrDeactivate(tx, 'customers', p, res);
    }
    for (const p of pairs.filter((x) => x.kind === 'Objekt')) {
      await moveRefs(tx, 'sites', p.dupId, p.keepId);
      await removeOrDeactivate(tx, 'sites', p, res);
    }
    // abgeleitete Monatspauschalen (XML) abschalten, wo jetzt echte monatliche Leistungen (CSV) daneben stehen
    const sites = await tx<{ id: string; ref: string }[]>`
      select s.id, s.external_ref as ref from app.sites s
       where s.external_ref like 'ftx:f:%'
         and exists (select 1 from app.site_services v where v.site_id = s.id and v.active
                       and v.billing_cycle not in ('je_ausfuehrung', 'einmalig'))`;
    for (const s of sites) {
      const derived = Array.from({ length: 40 }, (_, k) => uuidOf(`ftx-service:${s.ref.slice(6)}:${k}`));
      const [real] = await tx`
        select 1 from app.site_services where site_id = ${s.id} and active and id not in ${tx(derived)}
           and billing_cycle not in ('je_ausfuehrung', 'einmalig') limit 1`;
      if (!real) continue;
      const off = await tx`
        update app.site_services set active = false, valid_to = coalesce(valid_to, greatest(valid_from, current_date - 1)),
                              updated_at = now(), version = version + 1
         where site_id = ${s.id} and id in ${tx(derived)} and active returning id`;
      res.derivedOff += off.length;
    }
    await tx`insert into app.audit_log (actor, action, entity, details)
             values (${opts.actor}, 'merge_duplicates', 'import',
                     ${tx.json({ merged: res.merged, deactivated: res.deactivated, derivedOff: res.derivedOff, pairs: pairs.map((p) => [p.kind, p.keepLabel, p.dupLabel]) } as never)})`;
    return res;
  });
}

async function removeOrDeactivate(tx: Tx, table: 'sites' | 'customers', p: DupPair, res: DupResult) {
  try {
    await tx.savepoint(async (sp) => {
      if (table === 'customers') await sp`delete from app.invoice_groups where customer_id = ${p.dupId}`;
      await sp.unsafe(`delete from app.${table} where id = $1`, [p.dupId]);
    });
    res.merged++;
  } catch {
    if (table === 'sites')
      await tx`update app.sites set active = false, name = name || ' (Dublette)', updated_at = now() where id = ${p.dupId}`;
    else
      await tx`update app.customers set active = false, name = name || ' (Dublette)', updated_at = now() where id = ${p.dupId}`;
    res.deactivated.push(p.dupLabel);
  }
}
