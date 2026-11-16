import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';

/*
 * Auftragsgruppen (Ahmed 16.11.): mehrere Objekte – z. B. alle Lose einer Ausschreibung – gemeinsam bewerten
 * („ist der Gesamtauftrag bei einem guten Deckungsbeitrag?“). Nach- und Plan-Kalkulation zeigen sie als Ansicht
 * „je Auftragsgruppe“. Jedes Objekt ist höchstens in einer Gruppe.
 */

export interface ContractGroup {
  id: string;
  name: string;
  note: string | null;
  tender_id: string | null;
  tender_title: string | null;
  site_ids: string[];
}

export async function listContractGroups(sql: Sql): Promise<ContractGroup[]> {
  return sql<ContractGroup[]>`
    select g.id, g.name, g.note, g.tender_id, t.title as tender_title,
           coalesce(array_agg(gs.site_id order by s.site_no) filter (where gs.site_id is not null), '{}') as site_ids
      from app.contract_groups g
      left join app.tenders t on t.id = g.tender_id
      left join app.contract_group_sites gs on gs.group_id = g.id
      left join app.sites s on s.id = gs.site_id
     group by g.id, t.title
     order by lower(g.name)`;
}

/** Objekt → Gruppe (für die Ansicht „je Auftragsgruppe“). */
export async function contractGroupOfSite(sql: Sql): Promise<Map<string, { id: string; name: string }>> {
  const rows = await sql<{ site_id: string; id: string; name: string }[]>`
    select gs.site_id, g.id, g.name from app.contract_group_sites gs join app.contract_groups g on g.id = gs.group_id`;
  return new Map(rows.map((r) => [r.site_id, { id: r.id, name: r.name }]));
}

export async function saveContractGroup(
  sql: Sql,
  g: { id: string; name: string; note: string | null; tenderId: string | null; siteIds: string[] },
  actor: string,
) {
  const name = g.name.trim();
  if (!name) throw new BusinessError('Bitte einen Namen angeben (z. B. Ausschreibung Gemeinde 2026).');
  if (!g.siteIds.length) throw new BusinessError('Bitte mindestens ein Objekt wählen.');
  await sql.begin(async (tx) => {
    const taken = await tx<{ site_no: string; name: string; grp: string }[]>`
      select s.site_no, s.name, g.name as grp from app.contract_group_sites gs
        join app.sites s on s.id = gs.site_id join app.contract_groups g on g.id = gs.group_id
       where gs.site_id = any(${g.siteIds}::uuid[]) and gs.group_id <> ${g.id}`;
    if (taken.length)
      throw new BusinessError(
        `Schon in einer anderen Auftragsgruppe: ${taken.map((t) => `${t.site_no} ${t.name} („${t.grp}“)`).join(', ')}. ` +
          'Dort zuerst entfernen.',
      );
    await tx`
      insert into app.contract_groups (id, name, note, tender_id, created_by)
      values (${g.id}, ${name}, ${g.note}, ${g.tenderId}, ${actor})
      on conflict (id) do update set name = excluded.name, note = excluded.note, tender_id = excluded.tender_id`;
    await tx`delete from app.contract_group_sites where group_id = ${g.id}`;
    for (const s of [...new Set(g.siteIds)])
      await tx`insert into app.contract_group_sites (site_id, group_id) values (${s}, ${g.id})`;
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'save', 'contract_group', ${g.id}, ${tx.json({ name, sites: g.siteIds.length })})`;
  });
}

export async function deleteContractGroup(sql: Sql, id: string, actor: string) {
  await sql.begin(async (tx) => {
    const [g] = await tx<{ name: string }[]>`delete from app.contract_groups where id = ${id} returning name`;
    if (!g) throw new BusinessError('Auftragsgruppe nicht gefunden');
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'delete', 'contract_group', ${id}, ${tx.json({ name: g.name })})`;
  });
}
