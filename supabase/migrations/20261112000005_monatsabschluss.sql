-- Monatsabschluss-Assistent: festgehaltener Stand je Monat (wer, wann, Ergebnis jeder Prüfung). Nur anhängen –
-- erneuter Abschluss (z. B. nach Nachbuchungen) legt eine weitere Zeile an.
create table app.month_closings (
  id uuid primary key,
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  snapshot jsonb not null,
  open_points integer not null,
  note text,
  closed_by text not null,
  closed_at timestamptz not null default now()
);
create index on app.month_closings (month);
create trigger month_closings_append_only before update or delete on app.month_closings
  for each row execute function app.guard_append_only();
alter table app.month_closings enable row level security;
create policy month_closings_office on app.month_closings for select to authenticated using ((select app.is_office()));
