-- Verzugspauschale 40 € (§ 288 Abs. 5 BGB): je Rechnung höchstens einmal, nicht bei Verbrauchern.
-- Wird ab der Stufe mit late_fee = true berechnet (Vorschlag: ab 1. Mahnung, da Verzug dann sicher eingetreten ist).
alter table app.customers add column is_consumer boolean not null default false;
comment on column app.customers.is_consumer is 'Privatkunde/Verbraucher (§ 13 BGB): keine Verzugspauschale, ab 2027 PDF-Rechnung zulässig';
alter table app.dunning_settings add column late_fee boolean not null default false;
update app.dunning_settings set late_fee = true where level >= 2;
alter table app.dunnings add column late_fee_cents bigint not null default 0 check (late_fee_cents >= 0);
alter table app.dunning_items add column late_fee_cents bigint not null default 0 check (late_fee_cents in (0, 4000));
-- je Rechnung nur einmal
create unique index dunning_items_late_fee_once on app.dunning_items (invoice_id) where late_fee_cents > 0;
