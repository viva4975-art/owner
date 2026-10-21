-- Rechte je Rolle selbst einstellen (Einstellungen → Rechte der Benutzergruppen): nur Abweichungen von der Vorgabe
create table app.role_permissions (
  role text not null check (role in ('buchhaltung', 'personal', 'objektleitung')),
  area text not null check (length(area) between 1 and 60),
  allowed boolean not null,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (role, area)
);
alter table app.role_permissions enable row level security;
create policy role_permissions_read on app.role_permissions for select to authenticated using (true);
create policy role_permissions_admin on app.role_permissions for all to authenticated
  using ((select app.current_role()) = 'admin') with check ((select app.current_role()) = 'admin');
grant select, insert, update, delete on app.role_permissions to authenticated;
