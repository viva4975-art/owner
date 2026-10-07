-- Fortytools-Rechnungen: Objekt-Zuordnung reparierbar machen (Fund 07.10.: gleichnamige Objekte wurden beim XML-Import
-- zusammengelegt). Inhalt der Positionen bleibt unveränderbar; nur die Zuordnung zum Objekt darf korrigiert werden.
alter table app.legacy_invoice_lines add column facility_ref text;   -- Fortytools-Objekt-ID (invoiceable-id)
alter table app.legacy_invoices add column header_text text, add column footer_text text;

create or replace function app.legacy_invoice_line_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Fortytools-Rechnungen werden nicht gelöscht' using errcode = 'check_violation'; end if;
  if (new.id, new.invoice_id, new.position, new.title, new.details, new.quantity_milli, new.unit, new.unit_price_cents,
      new.net_cents, new.service_type, new.period_start, new.period_end)
     is distinct from (old.id, old.invoice_id, old.position, old.title, old.details, old.quantity_milli, old.unit,
      old.unit_price_cents, old.net_cents, old.service_type, old.period_start, old.period_end)
     or (old.facility_ref is not null and new.facility_ref is distinct from old.facility_ref) then
    raise exception 'Fortytools-Rechnungen sind unveränderbar' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger legacy_invoice_lines_guard on app.legacy_invoice_lines;
create trigger legacy_invoice_lines_guard before update or delete on app.legacy_invoice_lines
for each row execute function app.legacy_invoice_line_guard();

-- Kopf-/Fußtext nur nachtragen, nicht ändern
create or replace function app.legacy_invoice_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'Fortytools-Rechnungen werden nicht gelöscht' using errcode = 'check_violation'; end if;
  if (new.number, new.issue_date, new.net_cents, new.gross_cents, new.customer_no, new.parent_number)
     is distinct from (old.number, old.issue_date, old.net_cents, old.gross_cents, old.customer_no, old.parent_number)
     or (old.header_text is not null and new.header_text is distinct from old.header_text)
     or (old.footer_text is not null and new.footer_text is distinct from old.footer_text) then
    raise exception 'Fortytools-Rechnungen sind unveränderbar' using errcode = 'check_violation';
  end if;
  return new;
end $$;
