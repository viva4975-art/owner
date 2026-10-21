-- Briefarchiv (Ahmed 21.10.): freie Briefe unter Verwaltung → Briefe, an Kunde, Objekt oder frei eingegebene Anschrift.
-- Jeder Brief mit Nummer BR-JJJJ-NNNN, Anschrift und Text wie gedruckt, PDF write-once; nur anhängen.
create table app.letters (
  id uuid primary key,
  letter_no text not null unique,
  letter_date date not null,
  target text not null check (target in ('kunde', 'objekt', 'lieferant', 'mitarbeiter', 'frei')),
  customer_id uuid references app.customers (id),
  site_id uuid references app.sites (id),
  supplier_id uuid references app.suppliers (id),
  employee_id uuid references app.employees (id),
  recipient text not null,
  subject text not null,
  greeting text,
  body text not null,
  file_id uuid not null references app.files (id),
  created_by text not null,
  created_at timestamptz not null default now()
);
create index on app.letters (letter_date desc);
create index on app.letters (customer_id);
create index on app.letters (site_id);

create trigger letters_append_only before update or delete on app.letters
for each row execute function app.deny_change();

alter table app.letters enable row level security;
create policy letters_office on app.letters for select to authenticated
  using ((select app.is_office()));
grant select on app.letters to authenticated;
grant all on app.letters to service_role;
