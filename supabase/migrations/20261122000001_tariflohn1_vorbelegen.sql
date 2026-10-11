-- Ahmed 11.10.2026: Alle Mitarbeitenden ohne Vergütung bekommen Tariflohn 1; die wenigen Abweichungen ändert er von Hand.
-- Nur wo nichts hinterlegt ist (kein individueller Lohn, kein Festgehalt, keine Lohngruppe). Die geänderten IDs stehen
-- im Protokoll (audit_log, action 'tariflohn1_vorbelegt') – so lässt sich die Vorbelegung bei Bedarf zurücknehmen.
with ziel as (
  select e.id from app.employees e
   where (e.pay_model is null or (e.pay_model = 'tarif' and e.wage_level_id is null))
     and e.hourly_wage_cents is null and e.monthly_salary_cents is null
     and exists (select 1 from app.wage_levels w where w.id = '00000000-0000-4000-8000-00000000a101')
), upd as (
  update app.employees e
     set pay_model = 'tarif', wage_level_id = '00000000-0000-4000-8000-00000000a101'
    from ziel where e.id = ziel.id
  returning e.id
)
insert into app.audit_log (actor, action, entity, entity_id, details)
select 'migration', 'tariflohn1_vorbelegt', 'employee', null,
       jsonb_build_object('anzahl', count(*), 'ids', coalesce(jsonb_agg(id), '[]'::jsonb))
  from upd
having count(*) > 0;
