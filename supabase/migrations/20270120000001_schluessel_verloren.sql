-- Schlüssel „verloren“ als eigener Stand (Audit 08.11.): vorher wurde beim Verlust nur der Inhaber gelöscht – der
-- Schlüssel stand danach als „im Büro“ und wurde wieder zur Ausgabe angeboten. „gefunden“ hebt den Verlust auf.
alter table app.keys add column if not exists lost_at date;
alter table app.keys add column if not exists lost_note text;
alter table app.keys add column if not exists lost_by text;

alter table app.key_log drop constraint if exists key_log_action_check;
alter table app.key_log add constraint key_log_action_check
  check (action in ('ausgabe', 'rueckgabe', 'verlust', 'gefunden'));

-- Bestand: Schlüssel, deren letzte Buchung ein Verlust ist und die niemand hat, gelten als verloren
update app.keys k
   set lost_at = l.at, lost_note = l.note, lost_by = l.created_by
  from (select distinct on (key_id) key_id, action, at, note, created_by
          from app.key_log order by key_id, created_at desc, id desc) l
 where l.key_id = k.id and l.action = 'verlust'
   and k.holder_employee_id is null and k.holder_supplier_id is null and k.lost_at is null;
