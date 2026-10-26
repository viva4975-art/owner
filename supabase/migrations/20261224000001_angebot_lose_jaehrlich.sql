-- Angebote (Ahmed 26.10.): Positionen „jährlich“ (z. B. Grundreinigung 1×/Jahr – nicht im Monatspreis) und Lose
-- (Ausschreibung mit mehreren Losen, je Los Zuschlag / Absage / aufgehoben).
alter table app.offer_lines
  add column if not exists yearly boolean not null default false,
  add column if not exists lot_no integer check (lot_no between 1 and 99);
alter table app.offer_lines drop constraint if exists offer_lines_cycle_check;
alter table app.offer_lines add constraint offer_lines_cycle_check check (not (recurring and yearly));

create table app.offer_lots (
  offer_id uuid not null references app.offers (id) on delete cascade,
  lot_no integer not null check (lot_no between 1 and 99),
  title text check (char_length(title) <= 200),
  status text not null default 'offen' check (status in ('offen', 'angenommen', 'abgelehnt', 'aufgehoben')),
  decided_at timestamptz,
  decided_by text,
  primary key (offer_id, lot_no)
);
alter table app.offer_lots enable row level security;
create policy offer_lots_office on app.offer_lots for select to authenticated using ((select app.is_office()));
grant select on app.offer_lots to authenticated;
grant all on app.offer_lots to service_role;
