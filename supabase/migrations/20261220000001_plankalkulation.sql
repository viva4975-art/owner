-- Plan-Kalkulation (Ahmed 23.10.): Sätze für die Arbeitgeberkosten je nach Lohnhöhe (Minijob / Midijob / regulär)
-- und Zuschlag für Urlaub/Krankheit. Werte in Basispunkten (1 % = 100), Grenzen in Cent. Werte 2026 – jährlich prüfen.
create table app.plan_cost_settings (
  id smallint primary key default 1 check (id = 1),
  -- AG-Anteil Sozialversicherung (RV 9,3 + AV 1,3 + KV 7,3 + halber Ø-Zusatzbeitrag 1,45 + PV 1,8)
  sv_employer_bp int not null default 2115 check (sv_employer_bp between 0 and 5000),
  -- AN-Anteil (für den Faktor F im Übergangsbereich, § 20 Abs. 2a SGB IV)
  sv_employee_bp int not null default 2115 check (sv_employee_bp between 0 and 5000),
  -- Umlagen U1, U2, Insolvenzgeld (regulär/Midijob)
  levies_bp int not null default 220 check (levies_bp between 0 and 2000),
  -- Unfallversicherung (BG) auf das Bruttoentgelt
  accident_bp int not null default 250 check (accident_bp between 0 and 2000),
  -- Minijob gewerblich: KV 13 + RV 15 + Pauschsteuer 2 + U1/U2/Insolvenz
  minijob_flat_bp int not null default 3117 check (minijob_flat_bp between 0 and 6000),
  minijob_limit_cents bigint not null default 60300 check (minijob_limit_cents > 0),
  midijob_upper_cents bigint not null default 200000 check (midijob_upper_cents > minijob_limit_cents),
  -- bezahlte Ausfallzeiten, die im Plan nicht stehen (Urlaub 30 Tage ≈ 13 %, Krankheit)
  absence_bp int not null default 1300 check (absence_bp between 0 and 5000),
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into app.plan_cost_settings (id) values (1) on conflict do nothing;
alter table app.plan_cost_settings enable row level security;
create policy plan_cost_settings_read on app.plan_cost_settings for select to authenticated using (true);
grant select on app.plan_cost_settings to authenticated;
grant all on app.plan_cost_settings to service_role;
