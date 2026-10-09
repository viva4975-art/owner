-- Einzelaufträge je Kunde (Ahmed 09.10., z. B. Münchner Wohnen – Bestellungen ohne eigenes Objekt): Auftrag mit
-- Leistungsort als Text, Termin (Datum + Uhrzeit), eingeteilte Mitarbeitende/Vorarbeiter (Termin erscheint in deren
-- App und im Kalender-Abo) und wahlweise „Arbeitsschein erforderlich“ (dann Rechnung erst mit unterschriebenem Schein).
alter table app.orders
  add column if not exists place text,
  add column if not exists start_time time,
  add column if not exists end_time time,
  add column if not exists employee_ids uuid[] not null default '{}',
  add column if not exists work_report_required boolean not null default false;
create index if not exists orders_planned_date_idx on app.orders (planned_date) where status in ('offen', 'in_arbeit');
