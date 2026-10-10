-- Systemwächter: Zustand der Prüfungen (Datenbank, KoSIT, Speicherplatz, Sicherung, Mail, Archiv-Kopie).
-- Eine Zeile je Prüfung; alerted_on = Tag der letzten Störungsmeldung (höchstens eine Mail je Störung und Tag).
create table app.system_checks (
  key text primary key,
  label text not null,
  ok boolean not null,
  level text not null check (level in ('rot', 'gelb')),
  detail text not null default '',
  since timestamptz not null default now(),
  checked_at timestamptz not null default now(),
  alerted_on date
);
alter table app.system_checks enable row level security;
create policy system_checks_office on app.system_checks for select to authenticated using ((select app.is_office()));
