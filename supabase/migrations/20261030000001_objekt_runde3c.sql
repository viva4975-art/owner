-- Runde 3c: Notizen wie Fortytools (Datum, Titel, Details, Anhänge, änderbar), Stundenvorgabe von Hand.

-- ---------------------------------------------------------------- Notizen
alter table app.notes
  add column title text,
  add column note_date date,
  add column version integer not null default 1,
  add column updated_at timestamptz,
  add column updated_by text;
update app.notes set note_date = (created_at at time zone 'Europe/Berlin')::date where note_date is null;
alter table app.notes
  alter column note_date set not null,
  alter column note_date set default ((now() at time zone 'Europe/Berlin')::date),
  alter column body set default '';
alter table app.notes drop constraint if exists notes_body_check;
alter table app.notes add constraint notes_content_check
  check (length(trim(coalesce(title, ''))) > 0 or length(trim(body)) > 0);
create trigger notes_version before update on app.notes for each row execute function app.bump_version();

-- Anhänge an Notizen
alter table app.file_links drop constraint file_links_entity_type_check;
alter table app.file_links add constraint file_links_entity_type_check
  check (entity_type in ('offer', 'invoice', 'customer', 'site', 'employee', 'supplier', 'incoming_invoice',
                         'purchase_order', 'order', 'work_report', 'quality_check', 'inbox', 'tender', 'note'));

-- ---------------------------------------------------------------- Stundenvorgabe (von Hand)
-- Eingabe wahlweise je Wochentag (Mo–So), je Monat oder je Jahr; gespeichert in Minuten.
create table app.site_hour_targets (
  site_id uuid primary key references app.sites (id),
  mode text not null check (mode in ('woche', 'monat', 'jahr')),
  day_minutes integer[] not null default '{0,0,0,0,0,0,0}'
    check (cardinality(day_minutes) = 7 and 0 <= all (day_minutes) and 1440 >= all (day_minutes)),
  month_minutes integer check (month_minutes between 0 and 744 * 60),
  year_minutes integer check (year_minutes between 0 and 8784 * 60),
  note text,
  version integer not null default 1,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  check (mode <> 'monat' or month_minutes is not null),
  check (mode <> 'jahr' or year_minutes is not null)
);
create trigger site_hour_targets_version before update on app.site_hour_targets
  for each row execute function app.bump_version();
alter table app.site_hour_targets enable row level security;
create policy site_hour_targets_read on app.site_hour_targets for select to authenticated
  using ((select app.is_office()) or site_id in (select id from app.sites where manager_user_id = (select auth.uid())));
grant select on app.site_hour_targets to authenticated;
grant all on app.site_hour_targets to service_role;
