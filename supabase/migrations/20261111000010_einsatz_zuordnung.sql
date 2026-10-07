-- Mitarbeitende mit laufendem/künftigem Einsatz an einem Objekt sind diesem Objekt zugeordnet (Liste „Mitarbeitende“,
-- Stempeln nur an zugeordneten Objekten). Der Zeiten-Import aus Fortytools hatte die Zuordnung nicht gesetzt.
-- Nur ergänzen, nichts löschen.
insert into app.employee_sites (employee_id, site_id)
select distinct p.employee_id, p.site_id
  from app.shift_plans p
 where p.employee_id is not null
   and (p.valid_until is null or p.valid_until >= current_date)
on conflict do nothing;
