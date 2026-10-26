-- Wiederkehrende Zahlungen (Ahmed 26.10.): Finanzamt, Miete, BG BAU, Versicherungen … – monatlich, quartalsweise,
-- halbjährlich oder jährlich. Erscheinen im Fälligkeitsmonat in der Zahlungsliste, bis sie als bezahlt festgehalten sind.
-- Buchhalterisch nur eine Merkliste: gebucht wird über den Kontoauszug (DATEV), nicht von hier aus.
create table app.recurring_payments (
  id uuid primary key,
  name text not null check (length(trim(name)) between 1 and 200),
  payee text not null check (length(trim(payee)) between 1 and 200),
  iban text check (iban is null or iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
  purpose text check (purpose is null or length(purpose) <= 140),
  amount_cents bigint check (amount_cents is null or amount_cents > 0),  -- leer = Betrag wechselt (z. B. USt-VA)
  cycle text not null check (cycle in ('monatlich', 'quartalsweise', 'halbjaehrlich', 'jaehrlich')),
  due_day integer not null check (due_day between 1 and 31),
  start_month date not null check (extract(day from start_month) = 1),
  end_month date check (end_month is null or (extract(day from end_month) = 1 and end_month >= start_month)),
  method text not null default 'ueberweisung' check (method in ('ueberweisung', 'lastschrift', 'dauerauftrag')),
  category text,
  note text check (note is null or length(note) <= 1000),
  active boolean not null default true,
  version integer not null default 1,
  created_by text not null,
  created_at timestamptz not null default now()
);
alter table app.recurring_payments enable row level security;
create policy recurring_payments_read on app.recurring_payments for select to authenticated
  using ((select app.is_office()));

-- Je Zahlung und Fälligkeitsmonat höchstens ein Eintrag „bezahlt“ (zurücknehmen = löschen, mit Protokoll).
create table app.recurring_payment_items (
  id uuid primary key,
  recurring_id uuid not null references app.recurring_payments (id),
  period date not null check (extract(day from period) = 1),
  amount_cents bigint not null check (amount_cents > 0),
  paid_at date not null,
  method text not null,
  note text check (note is null or length(note) <= 500),
  paid_by text not null,
  created_at timestamptz not null default now(),
  unique (recurring_id, period)
);
alter table app.recurring_payment_items enable row level security;
create policy recurring_payment_items_read on app.recurring_payment_items for select to authenticated
  using ((select app.is_office()));
