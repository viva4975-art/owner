-- Budget-Anpassungen: Nachunternehmerkosten je Monat getrennt (zählt in der Spalte NU), optional statt NU-Bestellungen
alter table app.budget_adjustments add column if not exists sub_month bigint not null default 0;
alter table app.budget_adjustments add column if not exists replace_sub boolean not null default false;
