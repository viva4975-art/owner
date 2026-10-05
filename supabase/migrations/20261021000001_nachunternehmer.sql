-- Nachunternehmer (aus der alten App „Subunternehmer“): Nachweise mit Fristen und Versionen, Upload-Portal für den
-- Nachunternehmer, Aufträge an Nachunternehmer mit Preisnachträgen, Kündigung.

alter table app.suppliers
  add column legal_form text check (legal_form is null or legal_form in (
    'einzelunternehmen', 'kleingewerbe', 'freiberufler', 'gbr', 'ek', 'ohg', 'kg', 'gmbh_co_kg', 'gmbh', 'ug', 'ag',
    'kgaa', 'eg', 'sonstige')),
  add column short_code text unique,
  add column contacts jsonb not null default '[]'::jsonb,   -- weitere Ansprechpartner [{name, phone, email}]
  add column terminated_on date,
  add column termination_reason text,
  add column portal_token text unique,                      -- Link zum Upload-Portal (zufällig, 32 Byte)
  add column portal_pin_hash text,                          -- scrypt, PIN wird nur einmal angezeigt
  add column portal_failed integer not null default 0,
  add column portal_locked_until timestamptz;

-- Nachweisarten (Stammliste; Gültigkeit in Monaten, 0 = einmalig)
create table app.supplier_doc_types (
  id text primary key,
  label text not null,
  category text not null,
  -- 'ja' Pflicht, 'nein' optional, 'hr' Pflicht nur bei eingetragenen Rechtsformen (Handelsregister)
  required text not null check (required in ('ja', 'nein', 'hr')),
  valid_months integer not null check (valid_months between 0 and 120),
  hint text,
  sort integer not null default 0,
  active boolean not null default true
);

insert into app.supplier_doc_types (id, label, category, required, valid_months, hint, sort) values
  ('vertrag', 'Nachunternehmervertrag', 'Stammdokumente', 'ja', 36, 'unterschriebener Rahmenvertrag', 10),
  ('gewerbe', 'Gewerbeanmeldung', 'Stammdokumente', 'ja', 36, null, 20),
  ('handwerk', 'Handwerkskarte / Eintragung Handwerksrolle', 'Stammdokumente', 'ja', 36, 'Gebäudereiniger: zulassungsfreies Handwerk (Anlage B1)', 30),
  ('hr', 'Handelsregisterauszug', 'Stammdokumente', 'hr', 12, 'Pflicht bei e.K., OHG, KG, GmbH, UG, AG …', 40),
  ('haftpflicht', 'Betriebshaftpflicht (Versicherungsbestätigung)', 'Stammdokumente', 'ja', 12, null, 50),
  ('freistellung', 'Freistellungsbescheinigung § 48b EStG', 'Stammdokumente', 'ja', 12, 'sonst 15 % Bauabzugsteuer bei Bauleistungen', 60),
  ('ub_kk_sv', 'Unbedenklichkeit Krankenkasse (SV-Beiträge)', 'Unbedenklichkeit', 'ja', 6, '§ 28e Abs. 3a SGB IV – Haftung des Auftraggebers', 70),
  ('ub_kk_min', 'Unbedenklichkeit Minijob-Zentrale', 'Unbedenklichkeit', 'ja', 6, null, 80),
  ('ub_bg', 'Unbedenklichkeit Berufsgenossenschaft (BG BAU)', 'Unbedenklichkeit', 'ja', 6, '§ 150 Abs. 3 SGB VII', 90),
  ('ub_soka', 'Unbedenklichkeit SOKA-BAU', 'Unbedenklichkeit', 'nein', 6, 'nur falls baugewerblich tätig', 100),
  ('milog', 'Erklärung Mindestlohn (MiLoG/AEntG)', 'Mindestlohn', 'ja', 12, '§ 13 MiLoG, § 14 AEntG – Haftung des Auftraggebers', 110),
  ('tarif', 'Erklärung Tariftreue Gebäudereinigung', 'Mindestlohn', 'nein', 12, null, 120),
  ('selbstauskunft', 'Selbstauskunft Nachunternehmer', 'Stammdokumente', 'ja', 12, null, 130),
  ('a1', 'A1-Bescheinigungen (Entsendung)', 'Mindestlohn', 'nein', 12, 'nur bei Beschäftigten aus dem EU-Ausland', 140),
  ('personal', 'Personalliste (eingesetzte Mitarbeitende)', 'Mindestlohn', 'nein', 0, null, 150),
  ('auftraggeber', 'Auftraggeberbescheinigung / Referenzen', 'Stammdokumente', 'nein', 12, null, 160),
  ('iso', 'Zertifikate (ISO 9001/14001)', 'Stammdokumente', 'nein', 12, null, 170)
on conflict (id) do nothing;

-- Nachweise: jede Datei eine Version (nie löschen). Gültig ist die neueste geprüfte Version je Art.
create table app.supplier_documents (
  id uuid primary key,
  supplier_id uuid not null references app.suppliers (id),
  doc_type text not null references app.supplier_doc_types (id),
  file_name text not null,
  content_type text not null,
  path text not null,                 -- Archiv (write-once)
  sha256 text not null,
  size_bytes integer not null,
  valid_until date,                   -- null bei einmaligen Nachweisen
  source text not null check (source in ('buero', 'portal')),
  status text not null default 'gueltig' check (status in ('zu_pruefen', 'gueltig', 'abgelehnt')),
  reject_reason text,
  reviewed_by text,
  reviewed_at timestamptz,
  uploaded_by text not null,
  created_at timestamptz not null default now(),
  check (status <> 'abgelehnt' or reject_reason is not null)
);
create index on app.supplier_documents (supplier_id, doc_type, created_at desc);

-- Datei und Herkunft sind unveränderbar; nur die Prüfung (zu_pruefen → gueltig/abgelehnt) darf einmal erfolgen.
create or replace function app.guard_supplier_document() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Nachweise werden nicht gelöscht (Nachweispflicht)'; end if;
  if (to_jsonb(new) - 'status' - 'valid_until' - 'reject_reason' - 'reviewed_by' - 'reviewed_at')
     <> (to_jsonb(old) - 'status' - 'valid_until' - 'reject_reason' - 'reviewed_by' - 'reviewed_at') then
    raise exception 'Nachweis-Datei ist unveränderbar';
  end if;
  if old.status <> 'zu_pruefen' then raise exception 'Nachweis ist bereits geprüft'; end if;
  return new;
end $$;
create trigger supplier_documents_guard before update or delete on app.supplier_documents
for each row execute function app.guard_supplier_document();

-- Aufträge an Nachunternehmer (Nummer aus dem Bestell-Nummernkreis BE-JJJJ-NNNN wie in der alten App)
create table app.subcontracts (
  id uuid primary key,
  number text not null unique,
  supplier_id uuid not null references app.suppliers (id),
  site_id uuid not null references app.sites (id),
  service_kind text not null,          -- Unterhaltsreinigung, Glasreinigung …
  frequency text not null check (frequency in ('einmalig', 'woechentlich', 'monatlich', 'quartalsweise', 'halbjaehrlich', 'jaehrlich')),
  billing text not null check (billing in ('pauschale_monat', 'pauschale_einsatz', 'stunde')),
  price_cents bigint not null check (price_cents >= 0),     -- netto; Stunde: je Stunde
  max_hours_month numeric(7,2),                             -- bei Stundenabrechnung: Obergrenze
  valid_from date not null,
  valid_to date,
  description text,
  note text,
  status text not null default 'entwurf' check (status in ('entwurf', 'erteilt', 'beendet', 'storniert')),
  issued_at timestamptz,
  signed_file_path text,               -- unterschriebener Auftrag (Scan), Archiv write-once
  signed_file_sha256 text,
  created_by text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1,
  check (valid_to is null or valid_to >= valid_from)
);
create index on app.subcontracts (supplier_id);
create index on app.subcontracts (site_id);
create trigger subcontracts_version before update on app.subcontracts for each row execute function app.bump_version();

-- Preisnachträge ab Monat (append-only); gültiger Preis = letzter Nachtrag ≤ Monat, sonst Auftragspreis
create table app.subcontract_prices (
  id uuid primary key,
  subcontract_id uuid not null references app.subcontracts (id),
  valid_from_month date not null check (extract(day from valid_from_month) = 1),
  price_cents bigint not null check (price_cents >= 0),
  reason text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (subcontract_id, valid_from_month)
);
create trigger subcontract_prices_append_only before update or delete on app.subcontract_prices
for each row execute function app.deny_change();

alter table app.incoming_invoices add column subcontract_id uuid references app.subcontracts (id);
create index on app.incoming_invoices (subcontract_id, service_month);

alter table app.supplier_doc_types enable row level security;
alter table app.supplier_documents enable row level security;
alter table app.subcontracts enable row level security;
alter table app.subcontract_prices enable row level security;
create policy supplier_doc_types_read on app.supplier_doc_types for select to authenticated using (true);
create policy supplier_documents_office on app.supplier_documents for select to authenticated using ((select app.is_office()));
create policy subcontracts_office on app.subcontracts for select to authenticated using ((select app.is_office()));
create policy subcontract_prices_office on app.subcontract_prices for select to authenticated using ((select app.is_office()));
grant select on app.supplier_doc_types, app.supplier_documents, app.subcontracts, app.subcontract_prices to authenticated;
grant all on app.supplier_doc_types, app.supplier_documents, app.subcontracts, app.subcontract_prices to service_role;
