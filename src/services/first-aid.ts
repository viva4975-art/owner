import type { Sql } from '../db/client.js';
import { BusinessError } from './errors.js';

/*
 * Verbandbuch (Ahmed 19.10.): je Erste-Hilfe-Leistung ein Eintrag beim Mitarbeiter (DGUV Vorschrift 1 § 24 Abs. 6,
 * 5 Jahre aufbewahren). Admin/Personal sehen alles, die Objektleitung nur Einträge ihrer Objekte und legt nur für
 * Mitarbeitende an, die an ihren Objekten eingesetzt sind. Jede Änderung mit altem Stand im Protokoll.
 */

export interface FirstAidEntry {
  id: string;
  employee_id: string;
  employee_name: string;
  personnel_no: string;
  site_id: string | null;
  site_name: string | null;
  site_no: string | null;
  occurred_at: Date;
  place: string | null;
  what_happened: string;
  injury: string;
  measures: string;
  first_aider: string | null;
  witnesses: string | null;
  doctor: boolean;
  lost_days: boolean;
  note: string | null;
  created_by: string;
  created_at: Date;
  updated_by: string | null;
  updated_at: Date | null;
  version: number;
}

/** Aufbewahrung: 5 Jahre nach dem Eintrag (DGUV Vorschrift 1 § 24 Abs. 6). */
export const FIRST_AID_KEEP_YEARS = 5;

export async function listFirstAid(
  sql: Sql,
  f: { employeeId?: string | null; siteIds?: string[] | null; year?: number | null; q?: string | null } = {},
) {
  const q = f.q?.trim() ? `%${f.q.trim().toLowerCase()}%` : null;
  return sql<FirstAidEntry[]>`
    select a.*, e.last_name || ', ' || e.first_name as employee_name, e.personnel_no,
           s.name as site_name, s.site_no
      from app.first_aid_entries a join app.employees e on e.id = a.employee_id
      left join app.sites s on s.id = a.site_id
     where ${f.employeeId ? sql`a.employee_id = ${f.employeeId}` : sql`true`}
       and ${f.siteIds ? sql`a.site_id = any(${f.siteIds}::uuid[])` : sql`true`}
       and ${f.year ? sql`extract(year from a.occurred_at at time zone 'Europe/Berlin') = ${f.year}` : sql`true`}
       and ${
         q
           ? sql`lower(e.last_name || ' ' || e.first_name || ' ' || e.personnel_no || ' ' || coalesce(s.name, '') || ' '
                   || a.what_happened || ' ' || a.injury) like ${q}`
           : sql`true`
       }
     order by a.occurred_at desc`;
}

export async function getFirstAid(sql: Sql, id: string) {
  const [r] = await sql<FirstAidEntry[]>`
    select a.*, e.last_name || ', ' || e.first_name as employee_name, e.personnel_no, s.name as site_name, s.site_no
      from app.first_aid_entries a join app.employees e on e.id = a.employee_id
      left join app.sites s on s.id = a.site_id where a.id = ${id}`;
  return r;
}

/** Mitarbeitende, für die die Objektleitung eintragen darf: zugeordnet oder im letzten Jahr/künftig eingeplant. */
export async function employeesOfSites(sql: Sql, siteIds: string[] | null) {
  return sql<{ id: string; name: string; personnel_no: string }[]>`
    select e.id, e.last_name || ', ' || e.first_name as name, e.personnel_no
      from app.employees e
     where e.status = 'aktiv'
       and ${
         siteIds
           ? sql`(exists (select 1 from app.employee_sites es where es.employee_id = e.id and es.site_id = any(${siteIds}::uuid[]))
                  or exists (select 1 from app.shift_plans p where p.employee_id = e.id and p.site_id = any(${siteIds}::uuid[])
                              and (p.valid_until is null or p.valid_until >= current_date - 365)))`
           : sql`true`
       }
     order by e.last_name, e.first_name`;
}

export interface FirstAidInput {
  id: string;
  employeeId: string;
  siteId: string | null;
  /** 'YYYY-MM-DDTHH:mm' Berliner Ortszeit */
  occurredAt: string;
  place: string | null;
  whatHappened: string;
  injury: string;
  measures: string;
  firstAider: string | null;
  witnesses: string | null;
  doctor: boolean;
  lostDays: boolean;
  note: string | null;
  version: number | null;
}

const t = (v: string | null, max = 2000) => (v?.trim() ? v.trim().slice(0, max) : null);

/**
 * Anlegen oder ändern (feste ID je Formular → doppelt absenden legt nichts doppelt an). `siteIds` = Objekte der
 * Objektleitung (null = Büro): Objekt Pflicht und eigenes, Mitarbeiter muss dort eingesetzt sein.
 */
export async function saveFirstAid(sql: Sql, p: FirstAidInput, actor: string, siteIds: string[] | null) {
  const what = t(p.whatHappened);
  const injury = t(p.injury);
  const measures = t(p.measures);
  if (!what) throw new BusinessError('Bitte den Hergang beschreiben');
  if (!injury) throw new BusinessError('Bitte Art und Umfang der Verletzung angeben');
  if (!measures) throw new BusinessError('Bitte die Erste-Hilfe-Maßnahmen angeben');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(p.occurredAt))
    throw new BusinessError('Bitte Datum und Uhrzeit angeben');
  const [chk] = await sql<{ at: Date; future: boolean }[]>`
    select (${p.occurredAt}::timestamp at time zone 'Europe/Berlin') as at,
           (${p.occurredAt}::timestamp at time zone 'Europe/Berlin') > now() + interval '5 minutes' as future`;
  const { at, future } = chk!;
  if (future) throw new BusinessError('Datum liegt in der Zukunft');
  if (siteIds) {
    if (!p.siteId || !siteIds.includes(p.siteId)) throw new BusinessError('Bitte eines Ihrer Objekte wählen');
    if (!(await employeesOfSites(sql, siteIds)).some((e) => e.id === p.employeeId))
      throw new BusinessError('Mitarbeiter ist an Ihren Objekten nicht eingesetzt');
  }
  await sql.begin(async (tx) => {
    const [old] = await tx<
      FirstAidEntry[]
    >`select * from app.first_aid_entries where id = ${p.id} for update`;
    if (old && p.version == null) return; // neues Formular doppelt abgeschickt → schon gespeichert
    if (old) {
      if (siteIds && (!old.site_id || !siteIds.includes(old.site_id)))
        throw new BusinessError('Eintrag gehört zu keinem Ihrer Objekte');
      if (p.version != null && old.version !== p.version)
        throw new BusinessError('Der Eintrag wurde inzwischen geändert – bitte neu laden');
    } else if (p.version != null) {
      throw new BusinessError('Eintrag nicht gefunden');
    }
    const row = {
      employee_id: p.employeeId,
      site_id: p.siteId,
      occurred_at: at,
      place: t(p.place, 300),
      what_happened: what,
      injury,
      measures,
      first_aider: t(p.firstAider, 200),
      witnesses: t(p.witnesses, 500),
      doctor: p.doctor,
      lost_days: p.lostDays,
      note: t(p.note),
    };
    if (old) {
      await tx`update app.first_aid_entries set ${tx(row as never)}, updated_by = ${actor}, updated_at = now()
                where id = ${p.id}`;
      await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
               values (${actor}, 'update', 'first_aid', ${p.id}, ${tx.json({ vorher: old } as never)})`;
    } else {
      const r =
        await tx`insert into app.first_aid_entries ${tx({ id: p.id, ...row, created_by: actor } as never)}
                          on conflict (id) do nothing`;
      if (r.count)
        await tx`insert into app.audit_log (actor, action, entity, entity_id)
                 values (${actor}, 'create', 'first_aid', ${p.id})`;
    }
  });
  return p.id;
}

/** Löschen nur Admin (Falscheintrag), alter Stand ins Protokoll. Sonst 5 Jahre aufbewahren. */
export async function deleteFirstAid(sql: Sql, id: string, actor: string) {
  await sql.begin(async (tx) => {
    const [old] = await tx`delete from app.first_aid_entries where id = ${id} returning *`;
    if (!old) throw new BusinessError('Eintrag nicht gefunden');
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, 'delete', 'first_aid', ${id}, ${tx.json({ vorher: old } as never)})`;
  });
}
