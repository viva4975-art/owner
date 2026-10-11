-- Qualitätskontrolle: Gewichtung je Kontrollgegenstand (Ahmed 11.10., wie Neumann & Neumann: „Boden nicht gereinigt ist
-- schlimmer als Steckdose vergessen“). 1 gering, 2 normal, 3 wichtig, 4 sehr wichtig, 5 kritisch.
-- Raumergebnis = gewichteter Durchschnitt; die Gewichtung wird je Bewertung festgehalten (spätere Änderungen in den
-- Einstellungen verändern alte Audits nicht).

alter table app.qm_items add column weight smallint not null default 2 check (weight between 1 and 5);
alter table app.quality_check_ratings add column weight smallint not null default 2 check (weight between 1 and 5);

update app.qm_items set weight = v.w
  from (values
    ('00000000-0000-4000-8000-0000000f0001'::uuid, 2), -- Gesamteindruck
    ('00000000-0000-4000-8000-0000000f0002'::uuid, 4), -- Boden
    ('00000000-0000-4000-8000-0000000f0003'::uuid, 1), -- Türen
    ('00000000-0000-4000-8000-0000000f0004'::uuid, 1), -- Fensterbänke
    ('00000000-0000-4000-8000-0000000f0005'::uuid, 2), -- Tische / Arbeitsflächen
    ('00000000-0000-4000-8000-0000000f0006'::uuid, 1), -- Heizkörper
    ('00000000-0000-4000-8000-0000000f0007'::uuid, 3), -- Abfallbehälter geleert
    ('00000000-0000-4000-8000-0000000f0008'::uuid, 1), -- Spinnweben
    ('00000000-0000-4000-8000-0000000f0009'::uuid, 4), -- Waschbecken / Armaturen
    ('00000000-0000-4000-8000-0000000f000a'::uuid, 5), -- WC / Urinal
    ('00000000-0000-4000-8000-0000000f000b'::uuid, 2), -- Spiegel
    ('00000000-0000-4000-8000-0000000f000c'::uuid, 4), -- Verbrauchsmaterial
    ('00000000-0000-4000-8000-0000000f000d'::uuid, 1), -- Glasflächen / Türglas
    ('00000000-0000-4000-8000-0000000f000e'::uuid, 2), -- Handläufe / Geländer
    ('00000000-0000-4000-8000-0000000f000f'::uuid, 3)  -- Küchenzeile / Spüle
  ) as v(id, w)
 where app.qm_items.id = v.id;

-- Bestehende Bewertungen bekommen die Gewichtung ihres Gegenstands (nur Kennzeichen, Ergebnis abgeschlossener Audits bleibt)
alter table app.quality_check_ratings disable trigger quality_check_ratings_guard;
update app.quality_check_ratings r set weight = i.weight from app.qm_items i where i.id = r.item_id;
alter table app.quality_check_ratings enable trigger quality_check_ratings_guard;
