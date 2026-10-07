import type { Sql } from '../db/client.js';

/**
 * Globale Suche wie Fortytools: durchsucht (fast) alles – Stammdaten, Rechnungen inkl. Positionstexten, Leistungen,
 * Angebote, Aufträge, Arbeitsscheine, Dokumente (Dateinamen), Notizen, Aufgaben … Mehrere Wörter müssen alle
 * vorkommen (egal wo im Datensatz). Je Treffer ein Textausschnitt mit der Fundstelle.
 */
export const SEARCH_TYPES = [
  'Kunde',
  'Objekt',
  'Mitarbeiter',
  'Kontakt',
  'Rechnung',
  'Aktive Leistung',
  'Angebot',
  'Auftrag',
  'Arbeitsschein',
  'Ausschreibung',
  'Lieferant',
  'NU-Auftrag',
  'Bestellung',
  'Eingangsrechnung',
  'Dokument',
  'Notiz',
  'Aufgabe',
  'Akquise',
  'Bewerber',
  'Fahrzeug',
  'Artikel',
] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchHit {
  type: SearchType;
  label: string;
  sub: string | null;
  /** Textausschnitt um die Fundstelle */
  snippet: string;
  href: string;
  /** Objekt-ID (für Objektleitung: nur eigene Objekte) */
  siteId?: string | null;
}

export interface SearchResult {
  q: string;
  groups: { type: SearchType; hits: SearchHit[]; more: boolean }[];
}

type Row = {
  id: string;
  label: string;
  sub: string | null;
  hay: string;
  href?: string;
  site_id?: string | null;
};

const esc = (s: string) => s.replace(/[%_\\]/g, (m) => `\\${m}`);

/** Ausschnitt ±45 Zeichen um das erste gefundene Wort. */
export function snippetOf(hay: string, words: string[], width = 45): string {
  const text = hay.replace(/\s+/g, ' ').trim();
  const low = text.toLowerCase();
  let pos = -1;
  for (const w of words) {
    const p = low.indexOf(w.toLowerCase());
    if (p >= 0 && (pos < 0 || p < pos)) pos = p;
  }
  if (pos < 0) return text.slice(0, width * 2);
  const from = Math.max(0, pos - width);
  const to = Math.min(text.length, pos + width);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

export async function search(
  sql: Sql,
  q: string,
  opts: { limit?: number; types?: SearchType[]; siteScope?: string[] | null } = {},
): Promise<SearchResult> {
  const term = q.trim().replace(/\s+/g, ' ');
  if (term.length < 2) return { q: term, groups: [] };
  const words = term.split(' ').filter(Boolean).slice(0, 6);
  const likes = words.map((w) => `%${esc(w)}%`);
  const limit = opts.limit ?? 5;
  const want = (t: SearchType) => !opts.types || opts.types.includes(t);
  const L = limit + 1;
  const all = sql`${likes}::text[]`;

  const queries: Partial<Record<SearchType, Promise<Row[]>>> = {};
  const q2 = <T extends SearchType>(t: T, p: () => Promise<Row[]>) => {
    if (want(t)) queries[t] = p();
  };

  q2(
    'Kunde',
    () => sql<Row[]>`
    select * from (
      select id, name || coalesce(' · ' || name2, '') as label, customer_no as sub,
             concat_ws(' ', customer_no, name, name2, street, postal_code, city, vat_id, leitweg_id, supplier_no,
                       array_to_string(invoice_emails, ' '), contact_name, contact_phone, contact_email, notes,
                       billing_hint, site_notes, warning) as hay
        from app.customers) x
     where hay ilike all(${all}) order by label limit ${L}`,
  );
  q2(
    'Objekt',
    () => sql<Row[]>`
    select * from (
      select s.id, s.name || ' (' || s.site_no || ')' as label, c.name as sub, s.id as site_id,
             concat_ws(' ', s.site_no, s.name, s.street, s.postal_code, s.city, s.order_reference, s.contract_reference,
                       c.name, c.customer_no) as hay
        from app.sites s join app.customers c on c.id = s.customer_id) x
     where hay ilike all(${all}) order by label limit ${L}`,
  );
  q2(
    'Mitarbeiter',
    () => sql<Row[]>`
    select * from (
      select id, last_name || ', ' || first_name as label, 'Pers.-Nr. ' || personnel_no as sub,
             concat_ws(' ', personnel_no, first_name, last_name, first_name || ' ' || last_name, email, email_private,
                       phone, mobile, array_to_string(tags, ' '), info) as hay
        from app.employees) x
     where hay ilike all(${all}) order by label limit ${L}`,
  );
  q2(
    'Kontakt',
    () => sql<Row[]>`
    select * from (
      select k.customer_id as id, trim(concat_ws(' ', k.first_name, k.last_name)) as label, c.name as sub,
             concat_ws(' ', k.first_name, k.last_name, k.position, k.email, k.phone, k.mobile, k.notes, c.name) as hay,
             '/kunden/' || k.customer_id || '/kontakte' as href
        from app.contacts k join app.customers c on c.id = k.customer_id) x
     where hay ilike all(${all}) order by label limit ${L}`,
  );
  q2(
    'Rechnung',
    () => sql<Row[]>`
    select * from (
      select i.id, s.site_id,
             case when i.number is null then 'Entwurf' else
               (case i.kind when 'cancellation' then 'Storno ' when 'correction' then 'Korrektur ' else 'Rechnung ' end)
               || i.number end
             || coalesce(' - ' || to_char(i.issue_date, 'DD.MM.YYYY'), '')
             || ' - ' || translate(to_char(i.gross_cents / 100.0, 'FM999,999,990.00'), ',.', '.,') || ' €' as label,
             c.name as sub,
             concat_ws(' ', i.number, i.order_reference, i.buyer_reference, c.name, c.customer_no,
                       i.buyer_snapshot ->> 'name', i.buyer_snapshot ->> 'street', i.buyer_snapshot ->> 'city',
                       i.intro_text, i.closing_text,
                       (select string_agg(concat_ws(' ', l.description, l.detail), ' | ') from app.invoice_lines l
                         where l.invoice_id = i.id)) as hay
        from app.invoices i join app.customers c on c.id = i.customer_id
        left join lateral (select i.site_id) s on true) x
     where hay ilike all(${all}) order by label desc limit ${L}`,
  );
  q2(
    'Aktive Leistung',
    () => sql<Row[]>`
    select * from (
      select ss.site_id as id, ss.site_id, ss.description as label, s.name || ' (' || s.site_no || ')' as sub,
             concat_ws(' ', ss.description, ss.note, ss.execution_notes, ss.cost_center, s.name, s.site_no) as hay,
             '/objekte/' || ss.site_id || '/leistungen' as href
        from app.site_services ss join app.sites s on s.id = ss.site_id
       where ss.active and (ss.valid_to is null or ss.valid_to >= current_date)) x
     where hay ilike all(${all}) order by label limit ${L}`,
  );
  q2(
    'Angebot',
    () => sql<Row[]>`
    select * from (
      select o.id, o.site_id, 'Angebot ' || coalesce(o.number, 'Entwurf') || ' - ' || to_char(o.offer_date, 'DD.MM.YYYY')
               || ' · ' || o.title as label, c.name as sub,
             concat_ws(' ', o.number, o.title, o.tender_reference, o.intro_text, o.closing_text, c.name, c.street,
                       c.postal_code, c.city,
                       (select string_agg(concat_ws(' ', l.description, l.detail), ' | ') from app.offer_lines l
                         where l.offer_id = o.id)) as hay
        from app.offers o join app.customers c on c.id = o.customer_id) x
     where hay ilike all(${all}) order by label desc limit ${L}`,
  );
  q2(
    'Auftrag',
    () => sql<Row[]>`
    select * from (
      select o.id, o.site_id, o.number || ' · ' || o.title as label, c.name as sub,
             concat_ws(' ', o.number, o.title, o.description, o.order_reference, c.name) as hay,
             '/auftraege/' || o.id as href
        from app.orders o join app.customers c on c.id = o.customer_id) x
     where hay ilike all(${all}) order by label desc limit ${L}`,
  );
  q2(
    'Arbeitsschein',
    () => sql<Row[]>`
    select * from (
      select w.id, w.site_id, w.number || ' - ' || to_char(w.work_date, 'DD.MM.YYYY') as label,
             s.name || ' (' || s.site_no || ')' as sub,
             concat_ws(' ', w.number, w.description, w.materials, w.remarks, w.signed_by_name, s.name, s.site_no) as hay,
             '/arbeitsscheine/' || w.id as href
        from app.work_reports w join app.sites s on s.id = w.site_id) x
     where hay ilike all(${all}) order by label desc limit ${L}`,
  );
  q2(
    'Ausschreibung',
    () => sql<Row[]>`
    select * from (
      select id, title as label, authority as sub,
             concat_ws(' ', title, authority, reference_no, platform, procedure, location, services, notes) as hay,
             '/ausschreibungen/' || id as href
        from app.tenders) x
     where hay ilike all(${all}) order by label limit ${L}`,
  );
  q2(
    'Lieferant',
    () => sql<Row[]>`
    select * from (
      select id, name as label,
             supplier_no || ' · ' || case kind when 'nachunternehmer' then 'Nachunternehmer' else 'Lieferant' end as sub,
             concat_ws(' ', supplier_no, name, street, postal_code, city, email, phone, contact_name, vat_id, iban,
                       short_code, notes) as hay,
             '/lieferanten/' || id as href
        from app.suppliers) x
     where hay ilike all(${all}) order by label limit ${L}`,
  );
  q2(
    'NU-Auftrag',
    () => sql<Row[]>`
    select * from (
      select sc.id, sc.site_id, sc.number || ' · ' || sp.name as label,
             coalesce(s.name || ' (' || s.site_no || ')', '') as sub,
             concat_ws(' ', sc.number, sc.service_kind, sc.description, sc.note, sp.name, s.name, s.site_no) as hay,
             '/nachunternehmer/auftraege/' || sc.id as href
        from app.subcontracts sc join app.suppliers sp on sp.id = sc.supplier_id
        left join app.sites s on s.id = sc.site_id) x
     where hay ilike all(${all}) order by label desc limit ${L}`,
  );
  q2(
    'Bestellung',
    () => sql<Row[]>`
    select * from (
      select po.id, po.site_id, po.number || ' · ' || sp.name as label, to_char(po.order_date, 'DD.MM.YYYY') as sub,
             concat_ws(' ', po.number, po.note, sp.name) as hay, '/bestellungen/' || po.id as href
        from app.purchase_orders po join app.suppliers sp on sp.id = po.supplier_id) x
     where hay ilike all(${all}) order by label desc limit ${L}`,
  );
  q2(
    'Eingangsrechnung',
    () => sql<Row[]>`
    select * from (
      select ii.id, ii.site_id, ii.invoice_no || ' · ' || sp.name as label,
             to_char(ii.invoice_date, 'DD.MM.YYYY') || ' · ' || translate(to_char(ii.gross_cents / 100.0, 'FM999,999,990.00'), ',.', '.,') || ' €' as sub,
             concat_ws(' ', ii.invoice_no, ii.note, sp.name, sp.supplier_no) as hay,
             '/rechnungseingang/' || ii.id as href
        from app.incoming_invoices ii join app.suppliers sp on sp.id = ii.supplier_id) x
     where hay ilike all(${all}) order by label desc limit ${L}`,
  );
  q2(
    'Dokument',
    () => sql<Row[]>`
    select * from (
      select distinct on (f.id) f.id, f.original_name as label,
             case fl.entity_type when 'customer' then 'Kunde' when 'site' then 'Objekt' when 'employee' then 'Personalakte'
               when 'supplier' then 'Lieferant' when 'offer' then 'Angebot' when 'incoming_invoice' then 'Eingangsrechnung'
               when 'note' then 'Notiz' else coalesce(fl.entity_type, 'Eingang') end
             || coalesce(' · ' || fl.category, '') as sub,
             concat_ws(' ', f.original_name, fl.category) as hay, '/dateien/' || f.id as href,
             case fl.entity_type when 'site' then fl.entity_id end as site_id,
             fl.entity_type as etype
        from app.files f left join app.file_links fl on fl.file_id = f.id
       where f.status = 'complete'
       order by f.id) x
     where hay ilike all(${all}) order by label limit ${L}`,
  );
  q2(
    'Notiz',
    () => sql<Row[]>`
    select * from (
      select n.id, coalesce(nullif(n.title, ''), left(n.body, 60)) as label,
             to_char(coalesce(n.note_date, n.created_at::date), 'DD.MM.YYYY') || ' · ' || n.author as sub,
             concat_ws(' ', n.title, n.body) as hay,
             case n.entity_type::text when 'customer' then '/kunden/' || n.entity_id || '/notizen'
               when 'site' then '/objekte/' || n.entity_id || '/notizen'
               when 'employee' then '/personal/' || n.entity_id || '/notizen' else '/' end as href,
             case n.entity_type::text when 'site' then n.entity_id end as site_id
        from app.notes n) x
     where hay ilike all(${all}) order by sub desc limit ${L}`,
  );
  q2(
    'Aufgabe',
    () => sql<Row[]>`
    select * from (
      select id, title as label,
             coalesce('fällig ' || to_char(due_date, 'DD.MM.YYYY'), '') || case when status::text = 'done' then ' · erledigt' else '' end as sub,
             concat_ws(' ', title, description, assignee) as hay, '/aufgaben' as href
        from app.tasks) x
     where hay ilike all(${all}) order by label limit ${L}`,
  );
  q2(
    'Akquise',
    () => sql<Row[]>`
    select * from (
      select id, company as label, concat_ws(' · ', contact, city) as sub,
             concat_ws(' ', company, contact, phone, email, city, object, source, followup_reason) as hay,
             '/akquise/' || id as href
        from app.prospects) x
     where hay ilike all(${all}) order by label limit ${L}`,
  );
  q2(
    'Bewerber',
    () => sql<Row[]>`
    select * from (
      select id, name as label, concat_ws(' · ', job_type, city, status) as sub,
             concat_ws(' ', name, phone, email, postal_code, city, language, job_type, note) as hay,
             '/bewerber/pool/' || id as href
        from app.applicants) x
     where hay ilike all(${all}) order by label limit ${L}`,
  );
  q2(
    'Fahrzeug',
    () => sql<Row[]>`
    select * from (
      select id, plate as label, concat_ws(' ', make, model) as sub,
             concat_ws(' ', plate, make, model, vin, insurer, insurance_no, fuel_card, note) as hay,
             '/fahrzeuge/' || id as href
        from app.vehicles) x
     where hay ilike all(${all}) order by label limit ${L}`,
  );
  q2(
    'Artikel',
    () => sql<Row[]>`
    select * from (
      select id, article_no || ' · ' || name as label, 'Artikel' as sub,
             concat_ws(' ', article_no, name) as hay, '/artikel/' || id as href
        from app.articles) x
     where hay ilike all(${all}) order by label limit ${L}`,
  );

  const HREF: Partial<Record<SearchType, (id: string) => string>> = {
    Kunde: (id) => `/kunden/${id}`,
    Objekt: (id) => `/objekte/${id}`,
    Mitarbeiter: (id) => `/personal/${id}`,
    Rechnung: (id) => `/rechnungen/${id}`,
    Angebot: (id) => `/angebote/${id}`,
  };
  const groups: SearchResult['groups'] = [];
  for (const t of SEARCH_TYPES) {
    const p = queries[t];
    if (!p) continue;
    let rows = await p;
    if (opts.siteScope && rows.some((r) => 'site_id' in r))
      rows = rows.filter((r) => r.site_id && opts.siteScope!.includes(r.site_id));
    if (!rows.length) continue;
    groups.push({
      type: t,
      more: rows.length > limit,
      hits: rows.slice(0, limit).map((r) => ({
        type: t,
        label: r.label,
        sub: r.sub,
        snippet: snippetOf(r.hay ?? '', words),
        href: r.href ?? HREF[t]?.(r.id) ?? '/',
        siteId: r.site_id ?? null,
        ...((r as { etype?: string }).etype ? { etype: (r as { etype?: string }).etype } : {}),
      })),
    });
  }
  return { q: term, groups };
}
