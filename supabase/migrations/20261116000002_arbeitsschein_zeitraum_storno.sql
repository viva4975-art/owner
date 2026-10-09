-- Arbeitsschein (Ahmed 09.10.): Zeitraum von–bis bei mehrtägigen Arbeiten, Datum je Stundenzeile, Löschen (Entwurf)
-- und Stornieren (abgeschlossen; bleibt mit Grund sichtbar, zählt nicht mehr, nicht abrechenbar).
alter table app.work_reports
  add column work_date_to date,
  add column cancelled_at timestamptz,
  add column cancelled_by text,
  add column cancel_reason text,
  add constraint work_reports_date_to_check check (work_date_to is null or work_date_to >= work_date),
  add constraint work_reports_cancel_check check (cancelled_at is null or (cancelled_by is not null and length(trim(cancel_reason)) > 0));

alter table app.work_report_lines add column line_date date;

-- Schutz wie bisher; zusätzlich: work_date_to eingefroren, Storno nur einmal setzen, danach gar nichts mehr ändern.
create or replace function app.guard_work_report() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'entwurf' then
      raise exception 'Abgeschlossene Arbeitsscheine werden nicht gelöscht – bitte stornieren' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.cancelled_at is not null then
    raise exception 'Arbeitsschein % ist storniert und unveränderbar', old.number using errcode = 'check_violation';
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
       or (old.invoice_id is not null and new.invoice_id is distinct from old.invoice_id)) then
    raise exception 'Arbeitsschein % ist abgeschlossen und unveränderbar', old.number using errcode = 'check_violation';
  end if;
  return new;
end $$;
