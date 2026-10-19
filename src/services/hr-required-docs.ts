import type { Sql } from '../db/client.js';
import { todayBerlin } from '../domain/invoice/calc.js';
import { addDays } from '../domain/time/holidays.js';
import { monthLabel, timesheet } from './timesheet.js';

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
import { BusinessError } from './errors.js';
import { validSvNumber, validTaxId } from '../domain/hr/ids.js';
import { validIban } from './employees.js';

/** Pflichtunterlagen, die je Mitarbeiter als „nicht nötig“ markiert werden können (z. B. hat keinen Schlüssel). */
export const OPTIONAL_PER_EMPLOYEE = ['Unterweisung', 'Arbeitskleidung', 'Schlüssel'] as const;

export async function setDocNotNeeded(
  sql: Sql,
  employeeId: string,
  doc: string,
  notNeeded: boolean,
  actor: string,
) {
  if (!(OPTIONAL_PER_EMPLOYEE as readonly string[]).includes(doc))
    throw new BusinessError('Diese Unterlage bleibt Pflicht');
  await sql.begin(async (tx) => {
    const [r] = await tx`
      update app.employees
         set docs_not_needed = ${
           notNeeded
             ? tx`array(select distinct x from unnest(docs_not_needed || ${[doc]}::text[]) x)`
             : tx`array_remove(docs_not_needed, ${doc})`
         }
       where id = ${employeeId} returning id`;
    if (!r) throw new BusinessError('Mitarbeiter nicht gefunden');
    await tx`insert into app.audit_log (actor, action, entity, entity_id, details)
             values (${actor}, ${notNeeded ? 'unterlage_nicht_noetig' : 'unterlage_wieder_pflicht'}, 'employee',
                     ${employeeId}, ${tx.json({ unterlage: doc })})`;
  });
}

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

/** Aufenthaltstitel/Arbeitserlaubnis nötig? Nein bei EU/EWR/Schweiz, ja bei anderen und unbekannter Staatsangehörigkeit. */
export const permitNeeded = (nat: string | null | undefined) => !nat?.trim() || !freeMovement(nat);

export interface MissingRow {
  employee_id: string;
  personnel_no: string;
  name: string;
  managers: string[];
  sites: string[];
  missing: string[];
}

/** Stundenlisten erst ab Echtbetrieb prüfen – frühere Monate stammen aus dem Import (nie in der App unterschrieben). */
export const TIMESHEET_CHECK_FROM = '2026-10';
let sheetCache: { key: string; at: number; map: Map<string, string[]> } | null = null;

/**
 * Nicht (mehr) gültig unterschriebene Stundenlisten der letzten zwei abgeschlossenen Monate (Ahmed 19.10.): Monat mit
 * erfasster Zeit und ohne Unterschrift bzw. nach der Unterschrift geändert. 10 Min. zwischengespeichert.
 */
export async function unsignedTimesheets(sql: Sql, today = todayBerlin()): Promise<Map<string, string[]>> {
  const prev = addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  const months = [addDays(`${prev}-01`, -1).slice(0, 7), prev].filter((m) => m >= TIMESHEET_CHECK_FROM);
  const key = months.join(',');
  if (sheetCache && sheetCache.key === key && Date.now() - sheetCache.at < 600_000) return sheetCache.map;
  const map = new Map<string, string[]>();
  for (const m of months) {
    const rows = await sql<{ employee_id: string; sheet_hash: string | null }[]>`
      select t.employee_id,
             (select s.sheet_hash from app.timesheet_signatures s
               where s.employee_id = t.employee_id and s.month = ${m} order by s.signed_at desc limit 1) as sheet_hash
        from app.time_entries t join app.employees e on e.id = t.employee_id
       where t.work_date between ${`${m}-01`}::date and (${`${m}-01`}::date + interval '1 month - 1 day')
         and t.status <> 'abgelehnt' and e.status = 'aktiv'
       group by t.employee_id`;
    for (const r of rows) {
      let text: string | null = `Stundenliste ${monthLabel(m)} nicht unterschrieben`;
      if (r.sheet_hash) {
        const sh = await timesheet(sql, r.employee_id, m);
        text = sh.hash === r.sheet_hash ? null : `Stundenliste ${monthLabel(m)} nach Unterschrift geändert`;
      }
      if (text) map.set(r.employee_id, [...(map.get(r.employee_id) ?? []), text]);
    }
  }
  sheetCache = { key, at: Date.now(), map };
  return map;
}
export const resetTimesheetCache = () => {
  sheetCache = null;
};

export async function missingDocs(
  sql: Sql,
  opts: {
    siteIds?: string[] | null;
    /** Objektleitung: ohne Stammdaten/Nummern (vertraulich) */
    limited?: boolean;
    today?: string;
  } = {},
): Promise<MissingRow[]> {
  const today = opts.today ?? todayBerlin();
  const sheets = await unsignedTimesheets(sql, today);
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
      not_needed: string[];
      signed_instruction: boolean;
      tax_id: string | null;
      social_security_no: string | null;
      iban: string | null;
    }[]
  >`
    select e.id, e.docs_not_needed as not_needed, p.tax_id, p.social_security_no, p.iban, e.personnel_no, e.last_name || ', ' || e.first_name as name, p.nationality,
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
           exists (select 1 from app.sign_requests sr join app.sign_documents sd on sd.id = sr.document_id
                    where sr.employee_id = e.id and sr.status = 'unterschrieben'
                      and sd.category = 'unterweisung') as signed_instruction,
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
      if (r.not_needed.includes(d)) continue;
      const ok =
        cats.has(d) ||
        (d === 'Unterweisung' && r.signed_instruction) ||
        (d === 'Arbeitskleidung' && ho.has('kleidung')) ||
        (d === 'Schlüssel' && ho.has('schluessel'));
      if (!ok) missing.push(d);
    }
    if (r.data_missing?.length && !opts.limited) missing.push(`Stammdaten: ${r.data_missing.join(', ')}`);
    // vorhandene Nummern prüfen (z. B. aus dem Import oder vor Einführung der Prüfung erfasst)
    const bad = [
      r.tax_id?.trim() && !validTaxId(r.tax_id) ? 'Steuer-ID' : null,
      r.social_security_no?.trim() && !validSvNumber(r.social_security_no) ? 'SV-Nummer' : null,
      r.iban?.trim() && !validIban(r.iban) ? 'IBAN' : null,
    ].filter(Boolean);
    if (bad.length && !opts.limited) missing.push(`Ungültig: ${bad.join(', ')}`);
    const nat = r.nationality ?? '';
    if (!nat.trim()) missing.push('Staatsangehörigkeit');
    else if (!freeMovement(nat)) {
      // Kopie liegt meist in den Personalunterlagen (Ahmed 12.10.) → nur Stammdaten prüfen: gültig bis fehlt/abgelaufen
      const until = [r.residence_permit_until, r.work_permit_until].filter(Boolean).sort()[0] ?? null;
      if (!until) missing.push('Aufenthaltstitel: gültig bis fehlt');
      else if (until < today)
        missing.push(`Aufenthaltstitel abgelaufen (${until.split('-').reverse().join('.')})`);
    }
    missing.push(...(sheets.get(r.id) ?? []));
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
