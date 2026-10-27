-- Plan-Kalkulation: Material pauschal in % vom Erlös (Ahmed 27.10.: 2 %, kein Durchschnitt mehr)
alter table app.plan_cost_settings add column if not exists material_bp integer not null default 200
  check (material_bp between 0 and 5000);
