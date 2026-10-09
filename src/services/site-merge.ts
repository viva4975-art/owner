/**
 * Objekte zusammenführen (Ahmed 09.10.: „bei ARGE ist ein Objekt doppelt“). Alles, was am doppelten Objekt hängt
 * (Leistungen, Einsätze, Zeiten, Rechnungen, Raumbuch, Dateien, Notizen, Aufgaben …), wird auf das behaltene Objekt
 * umgehängt; danach wird das doppelte gelöscht. Geht ein Datensatz nicht umzuhängen (z. B. ausgestellte Rechnung ist
 * unveränderbar, oder dasselbe gibt es am Ziel schon), bleibt er am alten Objekt – das wird dann deaktiviert und als
 * „(zusammengeführt in …)“ gekennzeichnet. Die Fortytools-ID wird gemerkt (app.site_merges), damit ein erneuter
 * XML-Import das Objekt nicht wieder anlegt.
 */
import { randomUUID } from 'node:crypto';
import type { Sql, Tx } from '../db/client.js';
import { BusinessError } from './errors.js';

export interface MergeResult {
  moved: Record<string, number>;
  left: Record<string, number>;
  deleted: boolean;
}

/** Fremdschlüssel einer Tabelle umhängen: erst alles auf einmal, sonst Zeile für Zeile (Rest bleibt). */
async function moveColumn(tx: Tx, tbl: string, col: string, from: string, to: string, extra = '') {
  const where = `${col} = $2${extra}`;
  try {
    const n = await tx.savepoint((sp) =>
      sp.unsafe(`update ${tbl} set ${col} = $1 where ${where}`, [to, from]),
    );
    return { moved: n.count, left: 0 };
  } catch {
    const rows = await tx.unsafe<{ t: string }[]>(
      `select ctid::text as t from ${tbl} where ${col} = $1${extra}`,
      [from],
    );
    let moved = 0;
    for (const r of rows) {
      try {
        await tx.savepoint((sp) =>
          sp.unsafe(`update ${tbl} set ${col} = $1 where ctid = $2::tid`, [to, r.t]),
        );
        moved++;
      } catch {
        /* bleibt am alten Objekt */
      }
    }
    return { moved, left: rows.length - moved };
  }
}

export async function mergeSites(
  sql: Sql,
  fromId: string,
  intoId: string,
  actor: string,
): Promise<MergeResult> {
  if (fromId === intoId) throw new BusinessError('Bitte ein anderes Objekt wählen');
  return sql.begin(async (tx) => {
    const sites = await tx<
      { id: string; site_no: string; name: string; customer_id: string; external_ref: string | null }[]
    >`select id, site_no, name, customer_id, external_ref from app.sites where id in ${tx([fromId, intoId])} for update`;
    const from = sites.find((s) => s.id === fromId);
    const into = sites.find((s) => s.id === intoId);
    if (!from || !into) throw new BusinessError('Objekt nicht gefunden');
    if (from.customer_id !== into.customer_id)
      throw new BusinessError('Nur Objekte desselben Kunden lassen sich zusammenführen');

    const res: MergeResult = { moved: {}, left: {}, deleted: false };
    // Zeiteinträge: Änderung nur mit Begründung, landet im Änderungsprotokoll (§ 17 MiLoG)
    await tx`select set_config('app.actor', ${actor}, true),
                    set_config('app.reason', ${`Objekt ${from.site_no} zusammengeführt in ${into.site_no}`}, true)`;
    const note = (tbl: string, m: { moved: number; left: number }) => {
      if (m.moved) res.moved[tbl] = (res.moved[tbl] ?? 0) + m.moved;
      if (m.left) res.left[tbl] = (res.left[tbl] ?? 0) + m.left;
    };
    // Fortytools-ID: hatte das behaltene keine, übernimmt es die des doppelten
    if (from.external_ref && !into.external_ref) {
      await tx`update app.sites set external_ref = null where id = ${fromId}`;
      await tx`update app.sites set external_ref = ${from.external_ref} where id = ${intoId}`;
    }
    const fks = await tx<{ tbl: string; col: string }[]>`
      select conrelid::regclass::text as tbl, a.attname as col
        from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
       where c.contype = 'f' and c.confrelid = 'app.sites'::regclass and array_length(c.conkey, 1) = 1
         and conrelid <> 'app.site_merges'::regclass`;
    for (const f of fks) note(f.tbl, await moveColumn(tx, f.tbl, f.col, fromId, intoId));
    for (const tbl of ['app.file_links', 'app.notes', 'app.tasks'])
      note(tbl, await moveColumn(tx, tbl, 'entity_id', fromId, intoId, ` and entity_type = 'site'`));

    // reine Zuordnungen, die es am Ziel schon gibt, sind doppelt → weg
    for (const [tbl, q] of [
      ['app.employee_sites', tx`delete from app.employee_sites where site_id = ${fromId}`],
      ['app.file_links', tx`delete from app.file_links where entity_type = 'site' and entity_id = ${fromId}`],
    ] as const) {
      const r = await q;
      if (r.count && res.left[tbl]) {
        const rest = res.left[tbl] - r.count;
        res.left = Object.fromEntries(Object.entries({ ...res.left, [tbl]: rest }).filter(([, n]) => n > 0));
      }
    }
    try {
      await tx.savepoint((sp) => sp`delete from app.sites where id = ${fromId}`);
      res.deleted = true;
    } catch {
      await tx`update app.sites set active = false, external_ref = null,
                      name = left(name || ' (zusammengeführt in ' || ${into.site_no} || ')', 200), updated_at = now()
                where id = ${fromId}`;
    }
    await tx`insert into app.site_merges (id, from_site_id, from_label, from_ref, into_site_id, moved, from_deleted, created_by)
             values (${randomUUID()}, ${fromId}, ${`${from.site_no} ${from.name}`}, ${from.external_ref}, ${intoId},
                     ${tx.json({ moved: res.moved, left: res.left } as never)}, ${res.deleted}, ${actor})`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'merge', 'site', ${intoId},
                     ${tx.json({ from: `${from.site_no} ${from.name}`, from_id: fromId, ...res } as never)})`;
    return res;
  });
}

/** Fortytools-IDs zusammengeführter Objekte → behaltenes Objekt (für den XML-Import). */
export async function mergedRefs(sql: Sql | Tx) {
  const rows = await (sql as Sql)<{ ref: string; into: string }[]>`
    select m.from_ref as ref, m.into_site_id as into from app.site_merges m
      join app.sites s on s.id = m.into_site_id where m.from_ref is not null`;
  return new Map(rows.map((r) => [r.ref, r.into]));
}
