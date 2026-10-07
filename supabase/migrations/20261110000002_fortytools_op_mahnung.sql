-- Offene Posten und Mahnwesen für Rechnungen aus Fortytools (Ahmed 07.10.: „Offene Posten wie Fortytools, Mahnwesen
-- steht nichts“). Fortytools führt Rechnung und Storno/Korrektur als Gruppe („open-items-root“): eine Korrektur zu
-- einer bereits bezahlten Rechnung ist kein offener Posten.
alter table app.legacy_invoices add column ft_root_id text,
  -- Teilzahlungen (stehen nicht im Fortytools-Export) werden hier nachgetragen
  add column paid_part_cents bigint not null default 0 check (paid_part_cents >= 0);

-- Offener Betrag je Fortytools-Rechnung: Rechnung + offene Korrekturen derselben Gruppe (nur unbezahlte)
create or replace view app.legacy_open_items with (security_invoker = true) as
select l.id as invoice_id, l.number, l.customer_id, l.issue_date, l.due_date, l.gross_cents,
       (l.gross_cents + case when l.ft_root_id is null or l.id <> (
          select p.id from app.legacy_invoices p
           where p.ft_root_id = l.ft_root_id and not p.paid and p.gross_cents > 0 order by p.number limit 1)
        then 0 else coalesce((
          select sum(k.gross_cents) from app.legacy_invoices k
           where k.ft_root_id = l.ft_root_id and not k.paid and k.gross_cents < 0
             and k.customer_id is not distinct from l.customer_id), 0) end - l.paid_part_cents)::bigint as open_cents
  from app.legacy_invoices l
 where not l.paid and l.gross_cents > 0;
grant select on app.legacy_open_items to authenticated, service_role;

-- Mahnungen dürfen Rechnungen aus Fortytools enthalten: Fremdschlüssel → Prüfung auf eine der beiden Tabellen
alter table app.dunning_items drop constraint dunning_items_invoice_id_fkey;
create or replace function app.dunning_item_invoice_exists() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from app.invoices where id = new.invoice_id)
     and not exists (select 1 from app.legacy_invoices where id = new.invoice_id) then
    raise exception 'Rechnung % nicht gefunden', new.invoice_id using errcode = 'foreign_key_violation';
  end if;
  return new;
end $$;
create trigger dunning_items_invoice_exists before insert on app.dunning_items
for each row execute function app.dunning_item_invoice_exists();
