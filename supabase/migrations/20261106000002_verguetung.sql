-- Runde 10: Vergütung je Mitarbeiter – Tariflohn (Lohngruppe), individueller Stundenlohn oder Festgehalt.
alter table app.employees
  add column pay_model text check (pay_model in ('tarif', 'individuell', 'festgehalt')),
  add column monthly_salary_cents bigint check (monthly_salary_cents > 0);

update app.employees set pay_model = case
  when hourly_wage_cents is not null then 'individuell'
  when wage_level_id is not null then 'tarif' end
 where pay_model is null;

-- Tariflöhne Gebäudereinigung (Ahmed 06.10.2026), unter Einstellungen → Tariflöhne änderbar
insert into app.wage_levels (id, name, hourly_wage_cents, note) values
  ('00000000-0000-4000-8000-00000000a101', 'Tariflohn 1', 1500, 'Lohngruppe 1 Gebäudereinigung'),
  ('00000000-0000-4000-8000-00000000a104', 'Tariflohn 4', 1666, 'Lohngruppe 4'),
  ('00000000-0000-4000-8000-00000000a106', 'Tariflohn 6 Glasreiniger', 1840, 'Lohngruppe 6 Glas- und Fassadenreinigung')
on conflict do nothing;

-- Wirksamer Stundenlohn: Festgehalt → Stundensatz = Monatsgehalt × 3 / 13 / Wochenstunden (übliche Umrechnung)
create or replace function app.effective_wage_cents(e app.employees) returns bigint
language sql stable as $$
  select case
    when e.pay_model = 'festgehalt' then
      case when e.monthly_salary_cents is not null and coalesce(e.weekly_hours, 0) > 0
           then round(e.monthly_salary_cents * 3 / 13.0 / e.weekly_hours)::bigint end
    else coalesce(e.hourly_wage_cents, (select w.hourly_wage_cents from app.wage_levels w where w.id = e.wage_level_id))
  end
$$;
