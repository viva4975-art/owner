-- Budgetplanung (Ahmed 22.11.): Ausfallzeiten Urlaub (30 Tage) und Krankheit (Ø der letzten Daten) als eigene Kosten
-- auf den Lohn der Objekte; Stunden von Hand für neue Objekte bzw. Neugeschäft (Stunden je Monat × Stundensatz).
alter table app.budgets
  add column if not exists vacation_days numeric(5, 1) not null default 30 check (vacation_days between 0 and 60),
  add column if not exists sick_days numeric(5, 1) check (sick_days is null or sick_days between 0 and 100),
  add column if not exists sick_days_auto numeric(5, 1),
  add column if not exists sick_basis text;

alter table app.budget_adjustments
  add column if not exists hours_month numeric(9, 2) not null default 0 check (hours_month >= 0),
  add column if not exists wage_cents bigint not null default 0 check (wage_cents >= 0),
  add column if not exists replace_plan boolean not null default false;
