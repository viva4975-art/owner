-- NU-Abrechnung je Monat (Ahmed 15.11.): Gutschriftverfahren als Möglichkeit je Nachunternehmer,
-- Kündigung einzelner Bestellungen mit Kündigungsschreiben.

-- Steuernummer des Nachunternehmers (Pflichtangabe auf der Gutschrift, § 14 Abs. 4 Nr. 2 UStG)
alter table app.suppliers add column if not exists tax_no text;
-- Gutschriftverfahren vereinbart ab (§ 14 Abs. 2 S. 2 UStG), leer = Nachunternehmer stellt Rechnungen
alter table app.suppliers add column if not exists self_billing_since date;
-- Umsatzsteuer auf der Gutschrift: 13b = Steuerschuldnerschaft des Leistungsempfängers, 19 = mit USt,
-- klein = Kleinunternehmer (§ 19 UStG, ohne USt)
alter table app.suppliers add column if not exists self_billing_vat text
  check (self_billing_vat is null or self_billing_vat in ('13b', '19', 'klein'));

-- Kündigung einer einzelnen Bestellung
alter table app.subcontracts add column if not exists cancelled_on date;
alter table app.subcontracts add column if not exists cancel_reason text;
alter table app.subcontracts add column if not exists cancel_file_id uuid references app.files(id);
alter table app.subcontracts add column if not exists cancelled_at timestamptz;
alter table app.subcontracts add column if not exists cancelled_by text;
-- Stand vor der Kündigung (zum Zurücknehmen)
alter table app.subcontracts add column if not exists cancel_prev_valid_to date;
alter table app.subcontracts add column if not exists cancel_prev_status text;

-- Gutschriften (je Gutschrift eine Eingangsrechnung mit der Gutschrift-Nummer)
create table if not exists app.nu_credit_notes (
  incoming_invoice_id uuid primary key references app.incoming_invoices(id),
  number text not null unique,
  supplier_id uuid not null references app.suppliers(id),
  period_month date not null,
  vat_mode text not null check (vat_mode in ('13b', '19', 'klein')),
  lines jsonb not null,
  file_id uuid references app.files(id),
  created_by text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  sent_to text
);
create index if not exists nu_credit_notes_supplier_idx on app.nu_credit_notes (supplier_id, period_month);
alter table app.nu_credit_notes enable row level security;
create policy nu_credit_notes_office on app.nu_credit_notes for select to authenticated
  using ((select app.is_office()));
