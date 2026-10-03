import type { Sql } from '../db/client.js';

export interface SearchHit {
  type: 'Kunde' | 'Objekt' | 'Rechnung' | 'Angebot' | 'Mitarbeiter' | 'Kontakt' | 'Lieferant' | 'Artikel';
  label: string;
  sub: string | null;
  href: string;
}

/** Globale Suche (mind. 3 Zeichen, wie Fortytools) über Kunden, Objekte, Rechnungen, Mitarbeiter, Kontakte. */
export async function search(sql: Sql, q: string): Promise<SearchHit[]> {
  const term = q.trim();
  if (term.length < 3) return [];
  const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const [customers, sites, invoices, employees, contacts, offers, suppliers, articles] = await Promise.all([
    sql<{ id: string; label: string; sub: string }[]>`
      select id, customer_no || ' · ' || name as label, street || ', ' || postal_code || ' ' || city as sub
        from app.customers where name ilike ${like} or customer_no ilike ${like} or coalesce(leitweg_id, '') ilike ${like}
        order by name limit 10`,
    sql<{ id: string; label: string; sub: string }[]>`
      select s.id, s.site_no || ' · ' || s.name as label, c.name as sub
        from app.sites s join app.customers c on c.id = s.customer_id
       where s.name ilike ${like} or s.site_no ilike ${like} or coalesce(s.street, '') ilike ${like}
       order by s.site_no limit 10`,
    sql<{ id: string; label: string; sub: string }[]>`
      select i.id, coalesce(i.number, 'Entwurf') as label, c.name as sub
        from app.invoices i join app.customers c on c.id = i.customer_id
       where coalesce(i.number, '') ilike ${like} or coalesce(i.order_reference, '') ilike ${like}
       order by i.number desc nulls last limit 10`,
    sql<{ id: string; label: string; sub: string }[]>`
      select id, last_name || ', ' || first_name as label, 'Pers.-Nr. ' || personnel_no as sub
        from app.employees
       where (last_name || ' ' || first_name || ' ' || first_name || ' ' || last_name) ilike ${like} or personnel_no ilike ${like}
       order by last_name limit 10`,
    sql<{ id: string; customer_id: string; label: string; sub: string }[]>`
      select k.id, k.customer_id, trim(coalesce(k.first_name, '') || ' ' || k.last_name) as label, c.name as sub
        from app.contacts k join app.customers c on c.id = k.customer_id
       where (coalesce(k.first_name, '') || ' ' || k.last_name || ' ' || coalesce(k.email, '')) ilike ${like}
       order by k.last_name limit 10`,
    sql<{ id: string; label: string; sub: string }[]>`
      select o.id, o.number || ' · ' || o.title as label, c.name as sub
        from app.offers o join app.customers c on c.id = o.customer_id
       where o.number ilike ${like} or o.title ilike ${like} or coalesce(o.tender_reference, '') ilike ${like}
       order by o.created_at desc limit 10`,
    sql<{ id: string; label: string; sub: string }[]>`
      select id, supplier_no || ' · ' || name as label, case kind when 'nachunternehmer' then 'Nachunternehmer' else 'Lieferant' end as sub
        from app.suppliers where name ilike ${like} or supplier_no ilike ${like} order by name limit 10`,
    sql<{ id: string; label: string; sub: string }[]>`
      select id, article_no || ' · ' || name as label, 'Artikel' as sub
        from app.articles where name ilike ${like} or article_no ilike ${like} order by name limit 10`,
  ]);
  return [
    ...customers.map((r) => ({
      type: 'Kunde' as const,
      label: r.label,
      sub: r.sub,
      href: `/kunden/${r.id}`,
    })),
    ...sites.map((r) => ({ type: 'Objekt' as const, label: r.label, sub: r.sub, href: `/objekte/${r.id}` })),
    ...invoices.map((r) => ({
      type: 'Rechnung' as const,
      label: r.label,
      sub: r.sub,
      href: `/rechnungen/${r.id}`,
    })),
    ...offers.map((r) => ({
      type: 'Angebot' as const,
      label: r.label,
      sub: r.sub,
      href: `/angebote/${r.id}`,
    })),
    ...suppliers.map((r) => ({
      type: 'Lieferant' as const,
      label: r.label,
      sub: r.sub,
      href: `/lieferanten/${r.id}`,
    })),
    ...articles.map((r) => ({
      type: 'Artikel' as const,
      label: r.label,
      sub: r.sub,
      href: `/artikel/${r.id}`,
    })),
    ...employees.map((r) => ({
      type: 'Mitarbeiter' as const,
      label: r.label,
      sub: r.sub,
      href: `/personal/${r.id}`,
    })),
    ...contacts.map((r) => ({
      type: 'Kontakt' as const,
      label: r.label,
      sub: r.sub,
      href: `/kunden/${r.customer_id}/kontakte`,
    })),
  ];
}
