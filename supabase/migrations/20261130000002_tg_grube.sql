-- Tiefgarage: Fläche der Grube (m²) für „Mechanische Reinigung der Grube“ (Münchner Wohnen, Ahmed 17.10.)
alter table app.tg_objects add column if not exists pit_sqm integer check (pit_sqm is null or pit_sqm >= 0);
