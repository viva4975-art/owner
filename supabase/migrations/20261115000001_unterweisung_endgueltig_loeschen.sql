-- Ahmed 09.10.: Unterweisungen (z. B. Tests) auch nach Unterschrift löschen können. Nur über app.purge = 'force'
-- (Server, nur Admin); der vollständige Stand wird vorher ins audit_log geschrieben. Die unterschriebenen PDFs
-- bleiben write-once im Archiv (Dateien werden nie gelöscht).
create or replace function app.guard_sign_document() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('app.purge', true), '') not in ('on', 'force') then
      raise exception 'Dokumente werden nur über „Löschen“ entfernt' using errcode = 'check_violation';
    end if;
    if coalesce(current_setting('app.purge', true), '') <> 'force'
       and exists (select 1 from app.sign_requests r where r.document_id = old.id and r.status = 'unterschrieben') then
      raise exception 'Bereits unterschrieben – nur beenden, nicht löschen' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if (to_jsonb(new) - 'archived_at' - 'archived_by') is distinct from (to_jsonb(old) - 'archived_at' - 'archived_by') then
    raise exception 'Dokument ist unveränderbar' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create or replace function app.guard_sign_request() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('app.purge', true), '') = 'force'
       or (coalesce(current_setting('app.purge', true), '') = 'on' and old.status <> 'unterschrieben') then
      return old;
    end if;
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
