-- Ahmed 18.10.: alle Bestellungen aus der alten App (Nummern nicht im Format BE-JJJJ-NNNN) gelten als unterschrieben –
-- die Aufträge lagen dort unterschrieben vor. Bestellungen mit neuer Nummer bleiben, wie sie sind.
alter table app.subcontracts add column if not exists signed_external text;
update app.subcontracts
   set signed_external = 'unterschrieben (alte App)'
 where number !~ '^BE-[0-9]{4}-[0-9]{4}$' and signed_file_path is null and signed_external is null
   and status in ('erteilt', 'beendet');
