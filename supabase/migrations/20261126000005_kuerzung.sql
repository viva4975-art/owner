-- Kürzung durch den Kunden (Ahmed 15.10.: „gekürzt überwiesen, intern verrechnen, nicht verschicken“): Restbetrag einer
-- Rechnung ausbuchen. Kein Beleg an den Kunden – im DATEV-Export als Hinweis zur Erlösschmälerung (§ 17 UStG).
alter type app.payment_method add value if not exists 'kuerzung';
alter table app.legacy_payments drop constraint if exists legacy_payments_method_check;
alter table app.legacy_payments add constraint legacy_payments_method_check
  check (method in ('zahlung', 'skonto', 'kuerzung'));
