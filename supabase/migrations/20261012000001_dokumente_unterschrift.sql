-- Dokumente digital unterschreiben (Mitarbeitende am Handy): Unterweisungen, Datenschutz-Verpflichtung,
-- Arbeits-/Betriebsanweisungen u. Ä. Einfache elektronische Signatur = Kenntnisnahme/Beweis.
-- NICHT zulässig (Schriftform): Kündigung und Aufhebungsvertrag (§ 623 BGB), Befristungsabrede (§ 14 Abs. 4 TzBfG),
-- Zeugnis (§ 630 BGB). Deshalb gibt es dafür keine Kategorie; der Server lehnt solche Titel zusätzlich ab.

create type app.sign_category as enum ('unterweisung', 'datenschutz', 'arbeitsanweisung', 'betriebsanweisung',
                                       'vereinbarung', 'sonstiges');
create type app.sign_status as enum ('offen', 'unterschrieben', 'zurueckgezogen');

create table app.sign_documents (
  id uuid primary key,
  title text not null check (length(trim(title)) > 0),
  category app.sign_category not null,
  description text,
  file_name text not null,
  file_path text not null,                          -- Original-PDF im Archiv (write-once)
  file_sha256 text not null,
  file_size bigint not null,
  page_count integer not null,
  due_date date,
  created_by text not null,
  created_at timestamptz not null default now()
);
create trigger sign_documents_append_only before update or delete on app.sign_documents
for each row execute function app.deny_change();

create table app.sign_requests (
  id uuid primary key,
  document_id uuid not null references app.sign_documents (id),
  employee_id uuid not null references app.employees (id),
  status app.sign_status not null default 'offen',
  created_by text not null,
  created_at timestamptz not null default now(),
  signed_at timestamptz,
  signed_name text,
  signature_path text,
  signature_sha256 text,
  client_ip text,
  user_agent text,
  signed_pdf_path text,
  signed_pdf_sha256 text,
  withdrawn_at timestamptz,
  withdrawn_by text,
  unique (document_id, employee_id),
  check (status <> 'unterschrieben' or (signed_at is not null and signature_sha256 is not null))
);
create index on app.sign_requests (employee_id, status);

-- Unterschrieben = eingefroren (nur das signierte PDF darf einmal nachgetragen werden). Nie löschen.
create or replace function app.guard_sign_request() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Unterschriftsanforderungen werden nicht gelöscht' using errcode = 'check_violation';
  end if;
  if old.status <> 'offen' and (
       (new.status, new.signed_at, new.signed_name, new.signature_sha256, new.document_id, new.employee_id,
        new.withdrawn_at)
       is distinct from
       (old.status, old.signed_at, old.signed_name, old.signature_sha256, old.document_id, old.employee_id,
        old.withdrawn_at)
       or (old.signed_pdf_path is not null and new.signed_pdf_path is distinct from old.signed_pdf_path)) then
    raise exception 'Unterschrift ist abgeschlossen und unveränderbar' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger sign_requests_guard before update or delete on app.sign_requests
for each row execute function app.guard_sign_request();

alter table app.sign_documents enable row level security;
create policy sign_documents_hr on app.sign_documents for select to authenticated using ((select app.is_hr()));
alter table app.sign_requests enable row level security;
create policy sign_requests_hr on app.sign_requests for select to authenticated using ((select app.is_hr()));
grant select on app.sign_documents, app.sign_requests to authenticated;
grant all on app.sign_documents, app.sign_requests to service_role;
