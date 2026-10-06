-- QM wie Fortytools: Bewertungsmodus Note 1–6, Gut/Mittel/Schlecht, Ja/Nein, Punkte 1–5.
-- Je Bewertung wird der Prozentwert festgehalten (Auswertung unabhängig vom Modus).
alter table app.qm_items drop constraint if exists qm_items_kind_check;
alter table app.qm_items add constraint qm_items_kind_check check (kind in ('note', 'janein', 'gms', 'punkte'));

alter table app.quality_check_ratings add column percent smallint check (percent between 0 and 100);
alter table app.quality_check_ratings disable trigger quality_check_ratings_guard;
update app.quality_check_ratings set percent = (6 - value) * 20 where value is not null and percent is null;
alter table app.quality_check_ratings enable trigger quality_check_ratings_guard;
alter table app.quality_check_ratings add constraint quality_check_ratings_percent_chk
  check (skipped or percent is not null) not valid;

-- Gesamteindruck wie Fortytools: Punkte 1 bis 5
update app.qm_items set kind = 'punkte'
 where id = '00000000-0000-4000-8000-0000000f0001'
   and not exists (select 1 from app.quality_check_ratings r where r.item_id = '00000000-0000-4000-8000-0000000f0001');
