-- Abgeschlossenen Arbeitsschein wieder bearbeiten (Ahmed 09.10.): zurück in den Entwurf über app.reopen.
create or replace function app.guard_work_report() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    -- abgeschlossene nur über app.purge (nur Admin, nicht abgerechnet; PDF/Unterschrift bleiben im Archiv)
    if old.status <> 'entwurf' and coalesce(current_setting('app.purge', true), '') <> 'on' then
      raise exception 'Abgeschlossene Arbeitsscheine werden nicht gelöscht – bitte stornieren' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  -- „Wieder bearbeiten“ (Ahmed 09.10.): abgeschlossener Schein zurück in den Entwurf – nur über app.reopen, nicht storniert,
  -- nicht mit ausgestellter Rechnung; Unterschrift/PDF werden geleert (Dateien bleiben write-once im Archiv, alter Stand im
  -- Protokoll). Der Schein muss danach neu abgeschlossen bzw. unterschrieben werden.
  if coalesce(current_setting('app.reopen', true), '') = 'on' and old.status <> 'entwurf' and new.status = 'entwurf'
     and old.cancelled_at is null and new.cancelled_at is null
     and new.signed_by_name is null and new.signed_at is null and new.signature_sha256 is null and new.pdf_path is null
     and (new.invoice_id is null
          or exists (select 1 from app.invoices i where i.id = new.invoice_id and i.status = 'draft')) then
    return new;
  end if;
  if old.cancelled_at is not null then
    -- storniert: nur noch die Verknüpfung zu einem Rechnungsentwurf lösen
    if not (old.invoice_id is not null and new.invoice_id is null
            and exists (select 1 from app.invoices i where i.id = old.invoice_id and i.status = 'draft')
            and (to_jsonb(new) - 'invoice_id' - 'version') = (to_jsonb(old) - 'invoice_id' - 'version')) then
      raise exception 'Arbeitsschein % ist storniert und unveränderbar', old.number using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if (new.cancelled_at is not null) and old.status = 'entwurf' then
    raise exception 'Entwürfe werden gelöscht, nicht storniert' using errcode = 'check_violation';
  end if;
  if old.status <> 'entwurf' and (
       (new.customer_id, new.site_id, new.work_date, new.work_date_to, new.start_time, new.end_time, new.employee_ids,
        new.description, new.materials, new.remarks, new.status, new.signed_by_name, new.signed_at,
        new.signature_sha256, new.order_id)
       is distinct from
       (old.customer_id, old.site_id, old.work_date, old.work_date_to, old.start_time, old.end_time, old.employee_ids,
        old.description, old.materials, old.remarks, old.status, old.signed_by_name, old.signed_at,
        old.signature_sha256, old.order_id)
       or (old.pdf_path is not null and new.pdf_path is distinct from old.pdf_path)
       or (old.invoice_id is not null and new.invoice_id is distinct from old.invoice_id
           and not (new.invoice_id is null
                    and exists (select 1 from app.invoices i where i.id = old.invoice_id and i.status = 'draft')))) then
    raise exception 'Arbeitsschein % ist abgeschlossen und unveränderbar', old.number using errcode = 'check_violation';
  end if;
  return new;
end $$;
