-- Vorschüsse an Nachunternehmer (Ahmed 09.10.): Zahlung vor der Rechnung erfassen, später mit Eingangsrechnungen
-- verrechnen (Zahlbetrag der Rechnung sinkt um den verrechneten Teil). Löschen geht, solange nichts verrechnet ist
-- (Stand ins Protokoll). Ein Vorschuss kann aus einem Kontoumsatz entstehen (bank_transaction_id).
create table app.subcontractor_advances (
  id uuid primary key,
  supplier_id uuid not null references app.suppliers (id),
  subcontract_id uuid references app.subcontracts (id) on delete set null,
  paid_on date not null,
  amount_cents bigint not null check (amount_cents > 0),
  method text not null default 'ueberweisung' check (method in ('ueberweisung', 'bar', 'lastschrift', 'kreditkarte')),
  purpose text,
  bank_transaction_id uuid unique references app.bank_transactions (id),
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on app.subcontractor_advances (supplier_id, paid_on);

create table app.subcontractor_advance_offsets (
  id uuid primary key,
  advance_id uuid not null references app.subcontractor_advances (id),
  incoming_invoice_id uuid not null references app.incoming_invoices (id),
  amount_cents bigint not null check (amount_cents > 0),
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (advance_id, incoming_invoice_id)
);
create index on app.subcontractor_advance_offsets (incoming_invoice_id);

-- Verrechnung nie über den Vorschuss hinaus
create or replace function app.guard_advance_offset() returns trigger
language plpgsql as $$
declare total bigint; used bigint;
begin
  select amount_cents into total from app.subcontractor_advances where id = new.advance_id for update;
  select coalesce(sum(amount_cents), 0) into used from app.subcontractor_advance_offsets
   where advance_id = new.advance_id and id <> new.id;
  if used + new.amount_cents > total then
    raise exception 'Verrechnung übersteigt den Vorschuss' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger subcontractor_advance_offsets_guard before insert or update on app.subcontractor_advance_offsets
for each row execute function app.guard_advance_offset();

alter table app.subcontractor_advances enable row level security;
alter table app.subcontractor_advance_offsets enable row level security;
create policy subcontractor_advances_office on app.subcontractor_advances for select to authenticated
  using ((select app.is_office()));
create policy subcontractor_advance_offsets_office on app.subcontractor_advance_offsets for select to authenticated
  using ((select app.is_office()));
