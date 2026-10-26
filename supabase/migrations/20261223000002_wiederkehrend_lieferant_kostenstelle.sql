-- Wiederkehrende Zahlungen, Runde 2 (Ahmed 26.10.): Empfänger als Lieferant (auch Finanzamt, Krankenkasse, Vermieter),
-- Kostenstelle für die Nachkalkulation (Miete, Versicherung … auf „Verwaltung / Büro“; Steuern und Sozialabgaben nicht),
-- USt-Satz zum Herausrechnen des Nettobetrags, und Aufnahme in die SEPA-Datei der Zahlungsliste.
alter table app.recurring_payments
  add column supplier_id uuid references app.suppliers (id),
  add column cost_center_id uuid references app.cost_centers (id),
  add column vat_rate_bp integer not null default 0 check (vat_rate_bp in (0, 700, 1900));

-- Wiederkehrende Zahlungen in einem SEPA-Zahlungslauf (je Fälligkeit höchstens einmal, nur anhängen)
create table app.payment_run_recurring (
  run_id uuid not null references app.payment_runs (id),
  item_id uuid not null unique references app.recurring_payment_items (id),
  amount_cents bigint not null check (amount_cents > 0),
  creditor_name text not null,
  creditor_iban text not null,
  creditor_bic text,
  remittance text not null,
  primary key (run_id, item_id)
);
create trigger payment_run_recurring_append_only before update or delete on app.payment_run_recurring
for each row execute function app.deny_change();
alter table app.payment_run_recurring enable row level security;
create policy payment_run_recurring_read on app.payment_run_recurring for select to authenticated
  using ((select app.is_office()));
