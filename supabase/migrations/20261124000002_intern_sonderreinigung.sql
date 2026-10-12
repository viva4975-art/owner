-- Interne Kostenstelle „Sonderreinigung“ (Ahmed 12.10.): Sonderreiniger arbeiten ständig an wechselnden Orten mit
-- einmaligen Einsätzen – Planung, Zeiten und Kosten laufen auf dieses interne Objekt. Keine Rechnungen (interner Kunde).
insert into app.sites (id, customer_id, site_no, name, street, postal_code, city)
select md5('intern:sonderreinigung')::uuid, c.id, 'INT-SONDER', 'Sonderreinigung', c.street, c.postal_code, c.city
  from app.customers c
 where c.id = md5('intern:kunde')::uuid
   and not exists (select 1 from app.sites s where s.customer_id = c.id and lower(s.name) = 'sonderreinigung')
on conflict do nothing;
