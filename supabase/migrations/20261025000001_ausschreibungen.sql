-- Ausschreibungen / Angebotsabgabe (Ahmed: „ich lege ja noch kein Angebot mit Frist an, weil ich die Preise noch nicht
-- kenne“). Hier stehen die Termine einer Ausschreibung; das Angebot (Preise) entsteht später daraus.

create table app.tenders (
  id uuid primary key,
  title text not null check (length(trim(title)) > 0),
  authority text not null,                         -- Vergabestelle / Auftraggeber
  customer_id uuid references app.customers (id),  -- falls schon Kunde/Interessent
  reference_no text,                               -- Vergabenummer
  platform text,                                   -- z. B. DTVP, Vergabe.bayern, eVergabe, Subreport
  url text check (url is null or url ~ '^https?://'),
  procedure text,                                  -- offen, nicht offen, beschränkt, Verhandlung, UVgO …
  location text,                                   -- Ort / Objekte
  services text,                                   -- Leistung (z. B. Unterhaltsreinigung 3 Schulen)
  contract_start date,
  contract_term text,                              -- Laufzeit, z. B. 2 Jahre + 2 × 1 Jahr Verlängerung
  estimated_cents bigint check (estimated_cents is null or estimated_cents >= 0),  -- geschätztes Volumen p. a.
  deadline_at timestamptz,                         -- Abgabefrist (Berliner Ortszeit eingegeben)
  questions_until timestamptz,                     -- Bieterfragen bis
  site_visit_at timestamptz,                       -- Ortsbesichtigung
  site_visit_required boolean not null default false,
  binding_until date,                              -- Bindefrist
  status text not null default 'neu' check (status in
    ('neu', 'pruefen', 'bearbeitung', 'abgegeben', 'gewonnen', 'verloren', 'verzichtet', 'aufgehoben')),
  responsible text,
  decision_note text,                              -- warum verzichtet / verloren, Zuschlagspreis Wettbewerb …
  offer_id uuid references app.offers (id),
  submitted_at timestamptz,
  notes text,
  created_by text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1
);
create index on app.tenders (status, deadline_at);
create trigger tenders_version before update on app.tenders for each row execute function app.bump_version();

alter table app.file_links drop constraint file_links_entity_type_check;
alter table app.file_links add constraint file_links_entity_type_check
  check (entity_type in ('offer', 'invoice', 'customer', 'site', 'employee', 'supplier', 'incoming_invoice',
                         'purchase_order', 'order', 'work_report', 'quality_check', 'inbox', 'tender'));

alter table app.tenders enable row level security;
create policy tenders_office on app.tenders for select to authenticated using ((select app.is_office()));
grant select on app.tenders to authenticated;
grant all on app.tenders to service_role;
