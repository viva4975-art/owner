-- Kontakt der Objektleitung überall neben dem Namen (Ahmed 07.10.): Telefon/E-Mail aus dem Benutzerkonto, sonst aus dem
-- Personalstamm (gleicher Name, aktiv).
create or replace view app.manager_contacts with (security_invoker = true) as
select p.user_id, p.display_name as name,
       coalesce(nullif(p.phone, ''), e.mobile, e.phone) as phone,
       coalesce(nullif(p.email, ''), e.email) as email
  from app.profiles p
  left join lateral (
    select nullif(x.mobile, '') as mobile, nullif(x.phone, '') as phone, nullif(x.email, '') as email
      from app.employees x
     where x.status = 'aktiv' and lower(trim(x.first_name || ' ' || x.last_name)) = lower(trim(p.display_name))
     order by x.personnel_no limit 1) e on true;
grant select on app.manager_contacts to authenticated, service_role;
