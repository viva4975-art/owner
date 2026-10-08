-- Ahmed 08.10.: Bei der Preisanpassung auch übrige Kosten (Material, Sachkosten …) erhöhen können und Leistungen ohne
-- hinterlegten Lohnkostenanteil mit einem angenommenen Anteil rechnen.
-- neuer Preis = alt + alt × Lohnanteil × Lohnerhöhung + alt × (1 − Lohnanteil) × Sachkostenerhöhung
alter table app.price_adjustments drop constraint if exists price_adjustments_raise_bp_check;
alter table app.price_adjustments add constraint price_adjustments_raise_bp_check check (raise_bp between 0 and 5000);
alter table app.price_adjustments add column other_raise_bp integer not null default 0
  check (other_raise_bp between 0 and 5000);
alter table app.price_adjustments add column other_label text;
alter table app.price_adjustments add column default_labor_bp integer check (default_labor_bp between 0 and 10000);
alter table app.price_adjustments add constraint price_adjustments_some_raise check (raise_bp > 0 or other_raise_bp > 0);
-- true = Lohnanteil war an der Leistung nicht hinterlegt, es wurde der angenommene Anteil des Laufs verwendet
alter table app.price_adjustment_items add column labor_assumed boolean not null default false;
