-- Rechnungseingang (Ahmed 30.10.): Zeile einer Sammelbestellung nur einem Objekt zuordnen (Regie/Zusatzarbeiten).
-- Leer = wie bisher auf die Objekte der Sammelbestellung verteilt.
alter table app.incoming_invoice_subcontracts add column site_id uuid references app.sites (id);
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'app.incoming_invoice_subcontracts'::regclass and contype = 'u';
  if c is not null then execute format('alter table app.incoming_invoice_subcontracts drop constraint %I', c); end if;
end $$;
create unique index incoming_invoice_subcontracts_line_uq on app.incoming_invoice_subcontracts
  (incoming_invoice_id, subcontract_id, period_month, coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Planegg-Glasreinigung: Hinweistext wieder entfernen (Ahmed 30.10.)
update app.site_services set note = null, updated_at = now()
 where note = 'Los 9 Glasreinigung (Preisblatt 03.12.25): halber Jahrespreis je Ausführung';
