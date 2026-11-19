-- Raumbuch: Gebäudeteil als eigene Spalte (Ahmed 19.11.2026: „Gebäudeteile wie in der Excel, filtern“).
-- Bisher stand der Gebäudeteil aus dem Import zusammen mit der Etage („A · UG“) → aufteilen.
alter table app.rooms add column if not exists building_part text
  check (building_part is null or length(building_part) <= 80);

update app.rooms
   set building_part = nullif(trim(split_part(floor, ' · ', 1)), ''),
       floor = nullif(trim(substr(floor, length(split_part(floor, ' · ', 1)) + 4)), '')
 where floor like '% · %' and building_part is null;
