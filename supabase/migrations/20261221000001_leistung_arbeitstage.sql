-- Leistung je Tag/Stunde: Menge je Abrechnungszeitraum aus Arbeitstagen (Ahmed 24.10.)
alter table app.site_services
  add column if not exists work_days smallint[],
  add column if not exists hours_per_day_milli bigint;
alter table app.site_services drop constraint if exists site_services_work_days_ck;
alter table app.site_services add constraint site_services_work_days_ck
  check (work_days is null or (work_days <@ array[1,2,3,4,5,6,7]::smallint[] and cardinality(work_days) between 1 and 7));
alter table app.site_services drop constraint if exists site_services_hours_per_day_ck;
alter table app.site_services add constraint site_services_hours_per_day_ck
  check (hours_per_day_milli is null or (hours_per_day_milli > 0 and hours_per_day_milli <= 24000));
