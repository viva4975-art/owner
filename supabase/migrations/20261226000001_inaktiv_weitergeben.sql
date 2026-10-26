-- Ahmed 26.10.: Inaktive Kunden setzen ihre Objekte inaktiv, inaktive Objekte ihre Leistungen.
-- Nur beim Deaktivieren (wieder aktiv setzen schaltet nichts automatisch zurück). Protokoll je Datensatz.

create or replace function app.cascade_customer_inactive() returns trigger
language plpgsql security definer set search_path = app, public as $$
begin
  if old.active and not new.active then
    insert into app.audit_log (actor, action, entity, entity_id, details)
    select 'automatisch', 'deactivate', 'site', s.id, jsonb_build_object('grund', 'Kunde inaktiv', 'kunde', new.id)
      from app.sites s where s.customer_id = new.id and s.active;
    update app.sites set active = false where customer_id = new.id and active;
  end if;
  return new;
end $$;

create or replace function app.cascade_site_inactive() returns trigger
language plpgsql security definer set search_path = app, public as $$
begin
  if old.active and not new.active then
    insert into app.audit_log (actor, action, entity, entity_id, details)
    select 'automatisch', 'deactivate', 'site_service', ss.id, jsonb_build_object('grund', 'Objekt inaktiv', 'objekt', new.id)
      from app.site_services ss where ss.site_id = new.id and ss.active;
    update app.site_services set active = false where site_id = new.id and active;
  end if;
  return new;
end $$;

create trigger customers_cascade_inactive after update of active on app.customers
  for each row execute function app.cascade_customer_inactive();
create trigger sites_cascade_inactive after update of active on app.sites
  for each row execute function app.cascade_site_inactive();

-- Bestand: Objekte inaktiver Kunden und Leistungen inaktiver Objekte nachziehen
insert into app.audit_log (actor, action, entity, entity_id, details)
select 'migration', 'deactivate', 'site', s.id, jsonb_build_object('grund', 'Kunde inaktiv')
  from app.sites s join app.customers c on c.id = s.customer_id where s.active and not c.active;
update app.sites s set active = false from app.customers c
 where c.id = s.customer_id and s.active and not c.active;
insert into app.audit_log (actor, action, entity, entity_id, details)
select 'migration', 'deactivate', 'site_service', ss.id, jsonb_build_object('grund', 'Objekt inaktiv')
  from app.site_services ss join app.sites s on s.id = ss.site_id where ss.active and not s.active;
update app.site_services ss set active = false from app.sites s
 where s.id = ss.site_id and ss.active and not s.active;
