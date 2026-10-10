-- Festgehalt → Stundensatz einheitlich mit 4,33 Wochen je Monat (Ahmed 10.10.: „Gehalt / 4,33 / Wochenstunden“),
-- wie Vertragssoll und Arbeitszeitkonto. Vorher Gehalt × 3 ÷ 13 ÷ Wochenstunden (= ÷ 4,333…; Unterschied < 0,1 %).
create or replace function app.effective_wage_cents(e app.employees) returns bigint
language sql stable as $$
  select case
    when e.pay_model = 'festgehalt' then
      case when e.monthly_salary_cents is not null and coalesce(e.weekly_hours, 0) > 0
           then round(e.monthly_salary_cents / 4.33 / e.weekly_hours)::bigint end
    else coalesce(e.hourly_wage_cents, (select w.hourly_wage_cents from app.wage_levels w where w.id = e.wage_level_id))
  end
$$;
