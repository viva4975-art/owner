-- Leistungen mit gesetztem Ende werden nach dem Ende automatisch inaktiv (Server-Lauf stündlich).
-- ended_auto = durch das Ende inaktiv gesetzt: letzter Zeitraum bleibt abrechenbar.
alter table app.site_services add column if not exists ended_auto boolean not null default false;
