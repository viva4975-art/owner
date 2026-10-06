-- Runde 13: Arbeitserlaubnis getrennt von Aufenthaltserlaubnis, Beschäftigungszeiten (Austritt/Wiedereintritt),
-- Beschäftigungsart als Tag, regelmäßige-Sonntagsarbeit-Häkchen entfällt (Zuschläge gelten tariflich für alle).
alter table app.employee_private
  add column work_permit_until date,
  add column work_permit_info text;

create table app.employee_employments (
  id uuid primary key,
  employee_id uuid not null references app.employees (id),
  entry_date date not null,
  exit_date date not null,
  exit_reason text,
  recorded_by text not null,
  recorded_at timestamptz not null default now(),
  check (exit_date >= entry_date)
);
create index on app.employee_employments (employee_id, entry_date);
create trigger employee_employments_append_only before update or delete on app.employee_employments
for each row execute function app.deny_change();
alter table app.employee_employments enable row level security;
create policy employee_employments_read on app.employee_employments for select to authenticated using ((select app.is_hr()));
grant select on app.employee_employments to authenticated;
grant all on app.employee_employments to service_role;

alter table app.employees add column exit_reason text;

update app.employees set regular_sunday_work = false where regular_sunday_work;

-- Beschäftigungsart als Tag (vorn), andere Beschäftigungsart-Tags entfernen
update app.employees e set tags = array_prepend(
    case e.employment_type when 'vollzeit' then 'Vollzeit' when 'teilzeit' then 'Teilzeit' when 'minijob' then 'Minijob'
                           when 'werkstudent' then 'Werkstudent' else 'Aushilfe' end,
    array(select t from unnest(e.tags) t
           where lower(t) not in ('vollzeit', 'teilzeit', 'minijob', 'werkstudent', 'aushilfe')));
