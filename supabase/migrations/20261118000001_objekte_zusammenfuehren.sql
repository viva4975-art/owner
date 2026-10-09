-- Objekte zusammenführen (Ahmed 09.10.: Objekt beim Kunden doppelt). Protokoll der Zusammenführung; die
-- Fortytools-ID des aufgelösten Objekts bleibt hier stehen, damit ein erneuter XML-Import es nicht neu anlegt.
create table app.site_merges (
  id uuid primary key,
  from_site_id uuid not null,            -- kein Fremdschlüssel: das Objekt ist danach gelöscht
  from_label text not null,
  from_ref text,
  into_site_id uuid not null references app.sites(id),
  moved jsonb not null default '{}',
  from_deleted boolean not null,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index site_merges_from_ref on app.site_merges (from_ref) where from_ref is not null;

alter table app.site_merges enable row level security;
create policy site_merges_office on app.site_merges for select to authenticated
  using ((select app.is_office()));
