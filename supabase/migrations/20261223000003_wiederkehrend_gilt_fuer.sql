-- Wiederkehrende Zahlungen: für welchen Zeitraum gilt die Zahlung (Ahmed 26.10.)?
-- laufend = Kalender-Zeitraum der Fälligkeit, im Voraus (Miete 01.09. → September, Gewerbesteuer 15.05. → Q2)
-- vorher  = vorheriger Zeitraum, nachträglich
alter table app.recurring_payments
  add column applies_to text not null default 'laufend' check (applies_to in ('laufend', 'vorher'));
