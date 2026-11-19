-- Raumbuch: Gebäude als eigene Spalte (Ahmed 19.11.2026: „zu einem Objekt gehören manchmal mehrere Gebäude, die stehen
-- nicht im Raumbuch“). Gebäude (Haus, Liegenschaft) ≠ Gebäudeteil (Bauteil, Trakt).
alter table app.rooms add column if not exists building text
  check (building is null or length(building) <= 120);
