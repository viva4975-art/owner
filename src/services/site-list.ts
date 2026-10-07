import type { Sql } from '../db/client.js';
import { toCsv } from './reports.js';

/*
 * Objektliste wie Fortytools: Nummer, Objekt/Adresse, Kunde (+ Kundennummer), Objektleitung; Filter Status,
 * Objektleitung, A–Z/0–9, Suche; Sortierung; Seiten; CSV; QR-Codes der Auswahl drucken.
 */

export const SITE_PAGE_SIZE = 25;
export type SiteSort = 'nummer' | 'name' | 'kunde' | 'ort';

export interface SiteFilter {
  status: 'aktiv' | 'inaktiv' | null;
  manager: string | null; // User-ID oder 'ohne'
  letter: string | null; // A–Z oder 0–9
  q: string | null;
  sort: SiteSort;
  desc: boolean;
}

export interface SiteListRow {
  id: string;
  site_no: string;
  name: string;
  street: string | null;
  postal_code: string | null;
  city: string | null;
  active: boolean;
  clock_token: string;
  customer_id: string;
  customer_name: string;
  customer_no: string;
  manager_user_id: string | null;
  manager_name: string | null;
  manager_phone: string | null;
  manager_email: string | null;
  employees: number;
}

export function parseSiteFilter(get: (k: string) => string | undefined): SiteFilter {
  const st = get('status');
  const l = get('buchstabe')?.toUpperCase();
  const so = get('sort');
  const ol = get('ol');
  return {
    status: st === 'aktiv' || st === 'inaktiv' ? st : null,
    manager: ol && (ol === 'ohne' || /^[0-9a-f-]{36}$/.test(ol)) ? ol : null,
    letter: l && /^[A-Z0-9]$/.test(l) ? l : null,
    q: get('q')?.trim() || null,
    sort: so === 'name' || so === 'kunde' || so === 'ort' ? so : 'nummer',
    desc: get('ab') === '1',
  };
}

export async function filteredSites(sql: Sql, scope: string[] | null, f: SiteFilter) {
  const all = await sql<SiteListRow[]>`
    select s.id, s.site_no, s.name, s.street, s.postal_code, s.city, s.active, s.clock_token, s.customer_id,
           c.name as customer_name, c.customer_no, s.manager_user_id, p.name as manager_name,
           p.phone as manager_phone, p.email as manager_email,
           (select count(*)::int from app.employee_sites es join app.employees e on e.id = es.employee_id
             where es.site_id = s.id and e.status = 'aktiv' and not ('Objektleitung' = any(e.tags))) as employees
      from app.sites s
      join app.customers c on c.id = s.customer_id
      left join app.manager_contacts p on p.user_id = s.manager_user_id
     where (${scope === null} or s.id = any(${scope ?? []}::uuid[]))`;
  const counts = { aktiv: all.filter((s) => s.active).length, inaktiv: all.filter((s) => !s.active).length };
  const t = f.q?.trim().toLowerCase() ?? '';
  const first = (n: string) =>
    n.trim().charAt(0).toUpperCase().replace('Ä', 'A').replace('Ö', 'O').replace('Ü', 'U');
  const rows = all.filter(
    (s) =>
      (!f.status || (f.status === 'aktiv') === s.active) &&
      (!f.manager || (f.manager === 'ohne' ? !s.manager_user_id : s.manager_user_id === f.manager)) &&
      (!f.letter || first(s.name) === f.letter) &&
      (!t ||
        `${s.site_no} ${s.name} ${s.street ?? ''} ${s.postal_code ?? ''} ${s.city ?? ''} ${s.customer_name} ${s.customer_no}`
          .toLowerCase()
          .includes(t)),
  );
  const key = (s: SiteListRow): string =>
    f.sort === 'name'
      ? s.name.toLowerCase()
      : f.sort === 'kunde'
        ? `${s.customer_name.toLowerCase()} ${s.site_no.padStart(12, '0')}`
        : f.sort === 'ort'
          ? `${(s.city ?? '').toLowerCase()} ${s.name.toLowerCase()}`
          : s.site_no.padStart(12, '0');
  rows.sort((a, b) => key(a).localeCompare(key(b), 'de') * (f.desc ? -1 : 1));
  return { rows, counts, total: all.length };
}

/** Objektleitungen für den Filter (Benutzer mit Rolle Objektleitung oder mit zugeordneten Objekten). */
export async function managers(sql: Sql) {
  return sql<{ id: string; name: string; sites: number }[]>`
    select p.user_id as id, p.display_name as name,
           (select count(*)::int from app.sites s where s.manager_user_id = p.user_id) as sites
      from app.profiles p
     where p.role = 'objektleitung' or exists (select 1 from app.sites s where s.manager_user_id = p.user_id)
     order by p.display_name`;
}

export function sitesCsv(rows: SiteListRow[]): string {
  return toCsv(
    [
      'Objektnummer',
      'Objekt',
      'Straße',
      'PLZ',
      'Ort',
      'Kundennummer',
      'Kunde',
      'Objektleitung',
      'Mitarbeitende',
      'Status',
    ],
    rows.map((s) => [
      s.site_no,
      s.name,
      s.street ?? '',
      s.postal_code ?? '',
      s.city ?? '',
      s.customer_no,
      s.customer_name,
      s.manager_name ?? '',
      s.employees,
      s.active ? 'aktiv' : 'inaktiv',
    ]),
  );
}
