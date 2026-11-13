-- Leistungsarten als Katalog ohne Preis (Ahmed 13.11.: „Preise sind überall anders“, „Leistungswert unnötig“):
-- Einheit, Standardtext, übliche Abrechnung, Arbeitsschein – füllen neue Leistungen vor. Nur ergänzt.
alter table app.service_types
  add column if not exists unit_code text,
  add column if not exists default_text text check (default_text is null or length(default_text) <= 1000),
  add column if not exists default_cycle text check (default_cycle is null or default_cycle in
    ('monatlich', 'zweimonatlich', 'quartalsweise', 'halbjaehrlich', 'jaehrlich', 'einmalig', 'je_ausfuehrung')),
  add column if not exists work_report boolean not null default false;
