-- Outlook-Kalender (Ahmed 02.11.): mehrere Exchange-Konten je Benutzer und je Konto mehrere Kalender (Unterkalender,
-- freigegebene Kalender anderer Postfächer). calendars = angezeigte Kalender [{id, name, color}], leer = Hauptkalender.
alter table app.exchange_accounts add column id uuid not null default gen_random_uuid();
alter table app.exchange_accounts drop constraint exchange_accounts_pkey;
alter table app.exchange_accounts add primary key (id);
create unique index exchange_accounts_user_email on app.exchange_accounts (user_id, email);
alter table app.exchange_accounts add column calendars jsonb;
