-- Word-Vorlagen mit Fortytools-Platzhaltern (${Mitarbeiter.Vorname} …): hochladen (einzeln oder als ZIP),
-- beim Mitarbeiter/Kunden/Objekt „aus Vorlage erstellen“ → ausgefüllte .docx wird in der Akte abgelegt.
create table app.word_templates (
  id uuid primary key,
  code text,                                   -- z. B. VD-AV-2026-V2
  name text not null check (length(trim(name)) > 0),
  audience text not null check (audience in ('mitarbeiter', 'kunde', 'objekt', 'nachunternehmer')),
  category text not null,                      -- Ablage-Kategorie des erzeugten Dokuments
  file_id uuid not null references app.files (id),
  sha256 text not null unique,                 -- gleiche Datei zweimal hochladen = eine Vorlage
  placeholders text[] not null default '{}',
  active boolean not null default true,
  created_by text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1
);
create trigger word_templates_version before update on app.word_templates for each row execute function app.bump_version();
alter table app.word_templates enable row level security;
create policy word_templates_office on app.word_templates for select to authenticated using ((select app.is_office()));
grant select on app.word_templates to authenticated;
grant all on app.word_templates to service_role;

-- Vorlagendatei selbst hängt an der Vorlage (nicht im Dokumenteneingang)
alter table app.file_links drop constraint file_links_entity_type_check;
alter table app.file_links add constraint file_links_entity_type_check
  check (entity_type in ('offer', 'invoice', 'customer', 'site', 'employee', 'supplier', 'incoming_invoice',
                         'purchase_order', 'order', 'work_report', 'quality_check', 'inbox', 'tender', 'note',
                         'legacy_import', 'vehicle', 'word_template'));
