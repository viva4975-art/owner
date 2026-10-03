-- Leistungen am Objekt wie die Fortytools-„Aufträge“: Leistungsart, Abrechnungszyklus, Stundenvorgabe,
-- Ausführungshinweise, Kostenstelle, Lohnkostenanteil, „immer unfertig“, abweichende Rechnungsgruppe bzw. eigene
-- Rechnung. Rechnungsgruppen mit Kopf-/Fußtext. Rechnungsdatum im Abrechnungslauf wählbar.

-- Leistungsarten (Stammliste, wie Fortytools)
create table app.service_types (
  id uuid primary key,
  name text not null unique check (length(trim(name)) > 0),
  labor_share_bp integer check (labor_share_bp between 0 and 10000), -- Lohnkostenanteil-Vorgabe
  sort_order integer not null default 0,
  active boolean not null default true,
  version integer not null default 1
);
create trigger service_types_version before update on app.service_types for each row execute function app.bump_version();

insert into app.service_types (id, name, sort_order) values
  ('00000000-0000-4000-8000-0000000b1001', 'Unterhaltsreinigung', 10),
  ('00000000-0000-4000-8000-0000000b1002', 'Grundreinigung', 20),
  ('00000000-0000-4000-8000-0000000b1003', 'Glasreinigung', 30),
  ('00000000-0000-4000-8000-0000000b1004', 'Sonderreinigung', 40),
  ('00000000-0000-4000-8000-0000000b1005', 'Treppenhausreinigung', 50),
  ('00000000-0000-4000-8000-0000000b1006', 'Tiefgaragenreinigung', 60),
  ('00000000-0000-4000-8000-0000000b1007', 'Streckenreinigung', 70),
  ('00000000-0000-4000-8000-0000000b1008', 'Spüldienste', 80),
  ('00000000-0000-4000-8000-0000000b1009', 'Hausmeisterdienst', 90),
  ('00000000-0000-4000-8000-0000000b100a', 'Winterdienst', 100),
  ('00000000-0000-4000-8000-0000000b100b', 'Gartenpflege', 110),
  ('00000000-0000-4000-8000-0000000b100c', 'Bauendreinigung', 120),
  ('00000000-0000-4000-8000-0000000b100d', 'Verbrauchsmaterial', 130);

create type app.billing_cycle as enum ('monatlich', 'zweimonatlich', 'quartalsweise', 'halbjaehrlich', 'jaehrlich');

alter table app.site_services
  add column service_type_id uuid references app.service_types (id),
  add column billing_cycle app.billing_cycle not null default 'monatlich',
  add column hours_target_milli bigint check (hours_target_milli >= 0),   -- Stundenvorgabe je Monat
  add column execution_notes text,                                        -- Ausführungshinweise (Arbeitsschein)
  add column cost_center text,
  add column labor_share_bp integer check (labor_share_bp between 0 and 10000),
  add column always_unfinished boolean not null default false,            -- Rechnung muss vor Ausstellung geprüft werden
  add column invoice_group_id uuid references app.invoice_groups (id),    -- abweichend vom Objekt
  add column separate_invoice boolean not null default false,             -- immer eigene Rechnung
  add check (not (separate_invoice and invoice_group_id is not null));

-- Rechnungsgruppe der Leistung muss zum Kunden des Objekts gehören
create or replace function app.check_service_invoice_group() returns trigger
language plpgsql as $$
begin
  if new.invoice_group_id is not null and not exists (
       select 1 from app.invoice_groups g join app.sites s on s.customer_id = g.customer_id
        where g.id = new.invoice_group_id and s.id = new.site_id) then
    raise exception 'Rechnungsgruppe gehört zu einem anderen Kunden' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger site_services_invoice_group before insert or update of invoice_group_id, site_id on app.site_services
for each row execute function app.check_service_invoice_group();

alter table app.invoice_groups add column intro_text text, add column closing_text text;

alter table app.invoices
  add column planned_issue_date date,                       -- Rechnungsdatum aus dem Abrechnungslauf
  add column review_required boolean not null default false; -- „immer unfertig“: erst prüfen, dann ausstellen

-- Je Leistung und Abrechnungsmonat höchstens einmal abgerechnet (ersetzt die Prüfung je Objekt, weil Leistungen
-- eines Objekts jetzt auf verschiedenen Rechnungen landen können).
create table app.monthly_run_services (
  service_id uuid not null references app.site_services (id),
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  invoice_id uuid not null references app.invoices (id) on delete cascade,
  primary key (service_id, month)
);
create index on app.monthly_run_services (invoice_id);

insert into app.monthly_run_services (service_id, month, invoice_id)
select distinct l.source_service_id, to_char(i.period_start, 'YYYY-MM'), i.id
  from app.invoices i join app.invoice_lines l on l.invoice_id = i.id
 where i.monthly_run_key is not null and l.source_service_id is not null and i.period_start is not null
on conflict do nothing;

alter table app.service_types enable row level security;
create policy service_types_read on app.service_types for select to authenticated using (true);
alter table app.monthly_run_services enable row level security;
create policy monthly_run_services_office on app.monthly_run_services for select to authenticated
  using ((select app.is_office()));
grant select on app.service_types, app.monthly_run_services to authenticated;
grant all on app.service_types, app.monthly_run_services to service_role;
