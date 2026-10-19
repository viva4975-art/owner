-- Audit einheitlich Punkte 1 bis 5 (Ahmed 19.10.): Note 1–6 und Gut/Mittel/Schlecht → Punkte; Ja/Nein bleibt
-- (Abfallbehälter, Spinnweben, Verbrauchsmaterial). Bisherige Bewertungen behalten ihren Prozentwert (Ergebnis
-- unverändert); der gespeicherte Wert wird auf die nächstliegende Punktzahl umgerechnet, damit die Anzeige passt.
alter table app.quality_check_ratings disable trigger quality_check_ratings_guard;
update app.quality_check_ratings r
   set value = least(5, greatest(1, round(r.percent / 25.0)::int + 1))
  from app.qm_items i
 where i.id = r.item_id and i.kind in ('note', 'gms') and not r.skipped and r.percent is not null;
alter table app.quality_check_ratings enable trigger quality_check_ratings_guard;

update app.qm_items set kind = 'punkte', version = version + 1 where kind in ('note', 'gms');
alter table app.qm_items alter column kind set default 'punkte';
