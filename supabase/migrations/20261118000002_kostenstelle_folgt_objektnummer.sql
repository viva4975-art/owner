-- Kostenstelle an der Leistung = Objektnummer (Text). Ändert sich die Objektnummer (von Hand, Fortytools-Import mit
-- Neunummerierung) oder wird eine Leistung beim Zusammenführen umgehängt, blieb die alte Nummer stehen (Ahmed 09.10.).
create or replace function app.sync_service_cost_center() returns trigger
language plpgsql as $$
begin
  if new.site_no is distinct from old.site_no then
    update app.site_services set cost_center = new.site_no
     where site_id = new.id and cost_center = old.site_no;
  end if;
  return new;
end $$;
create trigger sites_sync_cost_center after update of site_no on app.sites
for each row execute function app.sync_service_cost_center();

-- Bestand: Kostenstelle zeigt die Nummer eines anderen Objekts oder eine Zwischennummer des Imports („…~…“) → eigene.
-- Allgemeine Kostenstellen (9000 Verwaltung …) und frei vergebene Texte bleiben.
update app.site_services v set cost_center = s.site_no
  from app.sites s
 where s.id = v.site_id and v.cost_center is distinct from s.site_no
   and (v.cost_center like '%~%'
        or exists (select 1 from app.sites o where o.id <> s.id and o.site_no = v.cost_center));
