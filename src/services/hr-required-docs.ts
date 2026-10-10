import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';

/*
 * Pflichtunterlagen der Personalakte (Ahmed 07.10.: „alles Pflicht“): Arbeitsvertrag, Unterweisung, Arbeitskleidung,
 * Schlüssel; Aufenthaltstitel/Arbeitserlaubnis für Staatsangehörige außerhalb EU/EWR/Schweiz (gültig bis nicht
 * abgelaufen). Kleidung und Schlüssel zählen auch über unterschriebene Übergaben. Ohne Staatsangehörigkeit lässt sich
 * die Aufenthaltspflicht nicht prüfen → eigener Punkt „Staatsangehörigkeit fehlt“.
 */
export const REQUIRED_DOCS = [
  'Arbeitsvertrag',
  'Unterweisung',
  'Arbeitskleidung',
  'Schlüssel',
  'Personalunterlagen',
] as const;

import { countryOf, isFreeMovementCountry } from '../domain/hr/lists.js';

const EU_EWR_CH = [
  'deutsch',
  'deutschland',
  'österreich',
  'belgien',
  'bulgarien',
  'kroatien',
  'zypern',
  'tschechien',
  'dänemark',
  'estland',
  'finnland',
  'frankreich',
  'griechenland',
  'ungarn',
  'irland',
  'italien',
  'lettland',
  'litauen',
  'luxemburg',
  'malta',
  'niederlande',
  'polen',
  'portugal',
  'rumänien',
  'slowakei',
  'slowenien',
  'spanien',
  'schweden',
  'island',
  'liechtenstein',
  'norwegen',
  'schweiz',
];
/** Staatsangehörigkeit EU/EWR/Schweiz? (auch Adjektive: „rumänisch“, „polnisch“ …) */
export function freeMovement(nat: string): boolean {
  const n = nat.trim().toLowerCase();
  if (!n) return false;
  const c = countryOf(nat);
  if (c) return isFreeMovementCountry(c);
  const stems = EU_EWR_CH.map((x) => x.replace(/(ien|land|en|ei)$/, '').slice(0, 5));
  return EU_EWR_CH.some((x) => n.includes(x)) || stems.some((s) => s.length >= 4 && n.startsWith(s));
}

export interface MissingRow {
  employee_id: string;
  personnel_no: string;
  name: string;
  managers: string[];
  sites: string[];
  missing: string[];
}

export async function missingDocs(sql: Sql, opts: { siteIds?: string[] | null } = {}): Promise<MissingRow[]> {
  const today = todayBerlin();
  const rows = await sql<
    {
      id: string;
      personnel_no: string;
      name: string;
      nationality: string | null;
      data_missing: string[] | null;
      residence_permit_until: string | null;
      work_permit_until: string | null;
      cats: string[] | null;
      ho: string[] | null;
      managers: string[] | null;
      sites: string[] | null;
      site_ids: string[] | null;
    }[]
  >`
    select e.id, e.personnel_no, e.last_name || ', ' || e.first_name as name, p.nationality,
           p.residence_permit_until::text, p.work_permit_until::text,
           array_remove(array[
             case when coalesce(p.tax_id, '') = '' then 'Steuer-ID' end,
             case when coalesce(p.social_security_no, '') = '' then 'SV-Nummer' end,
             case when coalesce(p.iban, '') = '' then 'IBAN' end,
             case when coalesce(p.health_insurance, '') = '' then 'Krankenkasse' end,
             case when p.birth_date is null then 'Geburtsdatum' end,
             case when coalesce(p.street, '') = '' or coalesce(p.city, '') = '' then 'Anschrift' end
           ], null) as data_missing,
           (select array_agg(distinct l.category) from app.file_links l join app.files f on f.id = l.file_id
             where l.entity_type = 'employee' and l.entity_id = e.id and f.status = 'complete' and l.archived_at is null) as cats,
           (select array_agg(distinct h.kind) from app.handovers h
             where h.employee_id = e.id and h.status in ('unterschrieben', 'ohne_unterschrift')) as ho,
           (select array_agg(distinct coalesce(pr.display_name, 'ohne Objektleitung')) from app.employee_sites es
              join app.sites s on s.id = es.site_id left join app.profiles pr on pr.user_id = s.manager_user_id
             where es.employee_id = e.id) as managers,
           (select array_agg(distinct s.name) from app.employee_sites es join app.sites s on s.id = es.site_id
             where es.employee_id = e.id) as sites,
           (select array_agg(es.site_id) from app.employee_sites es where es.employee_id = e.id) as site_ids
      from app.employees e left join app.employee_private p on p.employee_id = e.id
     where e.status = 'aktiv'
     order by e.last_name, e.first_name`;
  const out: MissingRow[] = [];
  for (const r of rows) {
    if (opts.siteIds && !(r.site_ids ?? []).some((s) => opts.siteIds!.includes(s))) continue;
    const cats = new Set(r.cats ?? []);
    const ho = new Set(r.ho ?? []);
    const missing: string[] = [];
    for (const d of REQUIRED_DOCS) {
      const ok =
        cats.has(d) ||
        (d === 'Arbeitskleidung' && ho.has('kleidung')) ||
        (d === 'Schlüssel' && ho.has('schluessel'));
      if (!ok) missing.push(d);
    }
    if (r.data_missing?.length) missing.push(`Stammdaten: ${r.data_missing.join(', ')}`);
    const nat = r.nationality ?? '';
    if (!nat.trim()) missing.push('Staatsangehörigkeit');
    else if (!freeMovement(nat)) {
      const doc = cats.has('Aufenthalts-/Arbeitserlaubnis');
      const until = [r.residence_permit_until, r.work_permit_until].filter(Boolean).sort()[0] ?? null;
      if (!doc) missing.push('Aufenthaltstitel/Arbeitserlaubnis');
      else if (!until) missing.push('Aufenthaltstitel: gültig bis fehlt');
      else if (until < today)
        missing.push(`Aufenthaltstitel abgelaufen (${until.split('-').reverse().join('.')})`);
    }
    if (missing.length)
      out.push({
        employee_id: r.id,
        personnel_no: r.personnel_no,
        name: r.name,
        managers: r.managers?.length ? r.managers.sort() : ['ohne Objekt'],
        sites: r.sites ?? [],
        missing,
      });
  }
  return out;
}
