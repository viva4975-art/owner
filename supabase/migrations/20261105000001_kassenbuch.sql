-- Kassenbuch wie die alte App (Kasse je Monat, Karten-Belege-Archiv, Auswertung), aber GoBD-fest:
-- fortlaufende Belegnummer, keine Löschung (Storno mit Grund), jede Änderung im Protokoll, abgeschlossene Monate gesperrt.
create table app.cash_entries (
  id uuid primary key,
  entry_no integer not null unique,                 -- fortlaufende Kassen-Belegnummer (lückenlos)
  kind text not null check (kind in ('einnahme', 'ausgabe')),
  entry_date date not null,
  description text not null check (length(trim(description)) > 0),
  amount_cents bigint not null check (amount_cents > 0),
  receipt_ref text,                                  -- Beleg-Nr. des Lieferanten/Quittung (frei)
  category text,
  note text,
  receipt_path text, receipt_sha256 text, receipt_name text, receipt_type text,
  cancelled_at timestamptz, cancelled_by text, cancel_reason text,
  legacy_id text unique,                             -- Import aus der alten App
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  version integer not null default 1
);
create index on app.cash_entries (entry_date);
create trigger cash_entries_version before update on app.cash_entries for each row execute function app.bump_version();

create table app.cash_openings (
  month text primary key check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount_cents bigint not null check (amount_cents >= 0),
  set_by text not null,
  set_at timestamptz not null default now()
);

create table app.cash_closings (
  month text primary key check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  end_cents bigint not null,
  counted_cents bigint,                              -- Kassensturz (gezählt)
  closed_by text not null,
  closed_at timestamptz not null default now()
);
create trigger cash_closings_append_only before update or delete on app.cash_closings
  for each row execute function app.guard_append_only();

create table app.cash_log (
  id bigserial primary key,
  entry_id uuid,
  action text not null,
  old jsonb,
  new jsonb,
  actor text not null,
  created_at timestamptz not null default now()
);
create trigger cash_log_append_only before update or delete on app.cash_log
  for each row execute function app.guard_append_only();

-- Buchungen nie löschen; abgeschlossene Monate und stornierte Buchungen nicht mehr ändern
create or replace function app.guard_cash_entry() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Kassenbuchungen werden nicht gelöscht – bitte stornieren' using errcode = 'check_violation';
  end if;
  if old.cancelled_at is not null then
    raise exception 'Stornierte Buchung kann nicht geändert werden' using errcode = 'check_violation';
  end if;
  if exists (select 1 from app.cash_closings c
              where c.month in (to_char(old.entry_date, 'YYYY-MM'), to_char(new.entry_date, 'YYYY-MM'))) then
    raise exception 'Der Monat ist abgeschlossen – Buchung nicht mehr änderbar' using errcode = 'check_violation';
  end if;
  if new.entry_no <> old.entry_no then
    raise exception 'Belegnummer ist unveränderlich' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger cash_entries_guard before update or delete on app.cash_entries
  for each row execute function app.guard_cash_entry();

create table app.card_receipts (
  id uuid primary key,
  receipt_date date not null,
  amount_cents bigint not null check (amount_cents > 0),
  note text,
  receipt_path text not null, receipt_sha256 text not null, receipt_name text, receipt_type text,
  legacy_id text unique,
  created_by text not null,
  created_at timestamptz not null default now(),
  version integer not null default 1
);
create index on app.card_receipts (receipt_date);
create trigger card_receipts_version before update on app.card_receipts for each row execute function app.bump_version();

do $$
declare t text;
begin
  foreach t in array array['cash_entries','cash_openings','cash_closings','cash_log','card_receipts'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('create policy %I on app.%I for select to authenticated using ((select app.is_office()))', t || '_office', t);
    execute format('grant select on app.%I to authenticated', t);
    execute format('grant all on app.%I to service_role', t);
  end loop;
end $$;
grant usage on sequence app.cash_log_id_seq to service_role;
