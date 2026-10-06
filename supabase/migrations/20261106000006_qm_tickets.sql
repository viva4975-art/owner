-- QM-App (wie Fortytools-Audit-App): Tickets je Objekt (Mangel, Kundenwunsch, Schaden …), optional Raum aus dem Raumbuch.
create table app.site_tickets (
  id uuid primary key,
  number text not null unique,                  -- T-JJJJ-NNNN
  site_id uuid not null references app.sites (id),
  room_id uuid references app.rooms (id),
  title text not null check (length(trim(title)) > 0),
  description text,
  priority text not null default 'normal' check (priority in ('niedrig', 'normal', 'hoch')),
  status text not null default 'offen' check (status in ('offen', 'in_arbeit', 'erledigt')),
  quality_check_id uuid references app.quality_checks (id),
  created_by text not null,
  created_at timestamptz not null default now(),
  done_by text,
  done_at timestamptz,
  version integer not null default 1
);
create index on app.site_tickets (site_id, status);
create trigger site_tickets_version before update on app.site_tickets for each row execute function app.bump_version();
alter table app.site_tickets enable row level security;
create policy site_tickets_read on app.site_tickets for select to authenticated
  using ((select app.is_office()) or site_id in (select id from app.sites where manager_user_id = (select auth.uid())));
grant select on app.site_tickets to authenticated;
grant all on app.site_tickets to service_role;
