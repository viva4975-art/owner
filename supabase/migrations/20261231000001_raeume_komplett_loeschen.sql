-- Räume im Raumbuch werden beim Löschen immer ganz gelöscht (Ahmed 27.10.2026), auch wenn sie in
-- Qualitätskontrollen oder Tickets vorkommen.
-- Abgeschlossene Kontrollen sind unveränderbar (Trigger) → dort bleibt die Raum-ID als Kennung stehen
-- (ohne Fremdschlüssel; Bereichsname steht in quality_check_items.area). Tickets verlieren nur den Raum.
do $$
declare r record;
begin
  for r in
    select c.conname, c.conrelid::regclass::text as tbl
      from pg_constraint c
     where c.contype = 'f' and c.confrelid = 'app.rooms'::regclass
       and c.conrelid in ('app.quality_check_items'::regclass, 'app.quality_check_ratings'::regclass,
                          'app.site_tickets'::regclass)
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

alter table app.site_tickets add constraint site_tickets_room_id_fkey
  foreign key (room_id) references app.rooms (id) on delete set null;
