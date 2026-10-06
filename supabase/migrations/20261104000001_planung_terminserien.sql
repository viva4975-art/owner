-- Planung wie Fortytools („Termin oder Terminserie planen“, Ahmed 06.10.):
-- Einsätze ohne Mitarbeiter (= „zu planende Einsätze“), einmalig / wöchentlich (alle n Wochen) / monatlich
-- (am selben Tag im Monat, alle n Monate), nur in ausgewählten Monaten, Einsatzgruppe, Terminserie (gemeinsam ändern).
alter table app.shift_plans alter column employee_id drop not null;
alter table app.shift_plans
  add column recurrence text not null default 'woechentlich' check (recurrence in ('einmalig', 'woechentlich', 'monatlich')),
  add column every smallint not null default 1 check (every between 1 and 12),
  add column months smallint[] check (months is null or months <@ array[1,2,3,4,5,6,7,8,9,10,11,12]::smallint[]),
  add column series_id uuid,
  add column planning_group text;
update app.shift_plans set series_id = id where series_id is null;
alter table app.shift_plans add constraint shift_plans_once check (recurrence <> 'einmalig' or valid_until = valid_from);
create index on app.shift_plans (series_id);
