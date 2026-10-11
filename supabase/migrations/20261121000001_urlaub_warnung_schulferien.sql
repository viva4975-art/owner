-- Ahmed 11.10.: Warnung bei 0 / negativem Resturlaub (als erledigt markierbar) und Objekte „Schule“:
-- in den Schulferien automatisch Urlaub (soweit vorhanden) und Rest unbezahlt eintragen.

create table app.leave_warning_acks (
  employee_id uuid not null references app.employees (id),
  year integer not null check (year between 2000 and 2100),
  rest numeric(6, 1) not null,       -- Rest beim Abhaken; sinkt er weiter, erscheint die Warnung erneut
  acked_by text not null,
  acked_at timestamptz not null default now(),
  primary key (employee_id, year)
);
alter table app.leave_warning_acks enable row level security;
create policy leave_warning_acks_read on app.leave_warning_acks for select to authenticated
  using ((select app.is_hr()) or (select app.is_office()));

alter table app.sites add column if not exists school_closure boolean not null default false;
alter table app.absences add column if not exists auto_school boolean not null default false;
