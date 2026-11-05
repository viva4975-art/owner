-- Kostenarten Umsatzsteuer und Körperschaftsteuer (Ahmed 05.11.2026)
alter table app.bank_transactions drop constraint if exists bank_transactions_expense_category_check;
alter table app.bank_transactions add constraint bank_transactions_expense_category_check
  check (expense_category in ('material', 'nachunternehmer', 'geraete', 'fahrzeuge', 'miete', 'sonstiges',
                              'personal', 'steuern', 'umsatzsteuer', 'koerperschaftsteuer', 'versicherung', 'bank', 'privat'));
