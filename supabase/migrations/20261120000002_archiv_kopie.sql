-- Revisionssichere Archiv-Kopie: jede Datei des GoBD-Archivs (ARCHIVE_DIR) und buchhaltungsrelevante Uploads
-- (Rechnungseingang, Rechnungsanhänge, Lohnabrechnungen) werden in S3 mit Object Lock (Compliance-Modus) kopiert.
-- Eine Zeile je Objekt; ok = vorhanden, gesperrt und Prüfsumme bestätigt.
create table app.archive_replicas (
  key text primary key,
  sha256 text,
  size_bytes bigint,
  retain_until date,
  status text not null check (status in ('ok', 'fehler')),
  attempts integer not null default 0,
  last_error text,
  version_id text,
  replicated_at timestamptz,
  updated_at timestamptz not null default now()
);
create index on app.archive_replicas (status);
alter table app.archive_replicas enable row level security;
create policy archive_replicas_office on app.archive_replicas for select to authenticated using ((select app.is_office()));
