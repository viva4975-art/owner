-- Push-Nachrichten (Web Push, Ahmed 11.10.): ohne Firebase direkt an die installierte App (Android, iPhone ab iOS 16.4
-- als Home-Bildschirm-App). Schlüssel (VAPID) werden beim ersten Bedarf erzeugt; der private Schlüssel liegt
-- verschlüsselt in der Datenbank (wie beim Bankabruf), ohne Lese-Recht für angemeldete Benutzer.
create table app.push_config (
  id integer primary key default 1 check (id = 1),
  public_key text not null,
  private_key_enc text not null,
  created_at timestamptz not null default now()
);
create table app.push_subscriptions (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  employee_id uuid references app.employees (id) on delete cascade,
  user_id uuid,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failures integer not null default 0,
  check (employee_id is not null or user_id is not null)
);
create index on app.push_subscriptions (employee_id);
create index on app.push_subscriptions (user_id);
-- jede Benachrichtigung höchstens einmal (z. B. Pausen-Hinweis je Zeit)
create table app.push_sent (
  key text primary key,
  sent_at timestamptz not null default now()
);
alter table app.push_config enable row level security;
alter table app.push_subscriptions enable row level security;
alter table app.push_sent enable row level security;
create policy push_subscriptions_office on app.push_subscriptions for select to authenticated
  using ((select app.is_office()));
