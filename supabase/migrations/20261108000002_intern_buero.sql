-- Interner Bereich (Ahmed 07.10.): eigener „Kunde“ Viva-Deluxe intern mit Objekt „Büro“ – eigene Kostenstelle und als
-- Einsatzort für Büromitarbeitende planbar (Einsatzplanung, Zeiterfassung, Stundenzettel). Keine Rechnungen.
alter table app.customers add column if not exists is_internal boolean not null default false;

insert into app.customers (id, customer_no, name, street, postal_code, city, is_internal, invoice_format)
select md5('intern:kunde')::uuid, 'INTERN', 'Viva-Deluxe intern', coalesce(co.street, 'Würmtalstr. 10'),
       coalesce(co.postal_code, '81375'), coalesce(co.city, 'München'), true, 'pdf'
  from (select 1) x left join app.company co on co.id = 1
on conflict do nothing;

insert into app.sites (id, customer_id, site_no, name, street, postal_code, city)
select md5('intern:buero')::uuid, md5('intern:kunde')::uuid, 'INT-BUERO', 'Büro', c.street, c.postal_code, c.city
  from app.customers c where c.id = md5('intern:kunde')::uuid
on conflict do nothing;
