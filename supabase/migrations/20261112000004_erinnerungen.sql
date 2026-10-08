-- Erinnerungen: täglicher Sammel-Hinweis per E-Mail (Fristen: Aufenthaltstitel, NU-Nachweise, HU/Inspektion,
-- Ausschreibungen, Eigen-Compliance, Aufgaben, Skonto, nicht gestempelte Einsätze). Genau einmal je Tag (last_sent).
create table app.reminder_settings (
  id integer primary key default 1 check (id = 1),
  enabled boolean not null default false,
  emails text[] not null default '{}',
  send_hour integer not null default 7 check (send_hour between 0 and 23),
  last_sent date,
  updated_at timestamptz not null default now()
);
insert into app.reminder_settings (id) values (1) on conflict do nothing;
alter table app.reminder_settings enable row level security;
create policy reminder_settings_office on app.reminder_settings for select to authenticated using ((select app.is_office()));
