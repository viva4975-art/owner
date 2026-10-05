-- Zahlungsliste statt SEPA-Zahlungslauf (Ahmed: SEPA-Datei nicht nötig). Bezahlt wird im Online-Banking; hier wird die
-- Zahlung je Eingangsrechnung festgehalten (Datum, Betrag, Skonto, Zahlart). Alte Zahlungsläufe bleiben unverändert.
alter table app.incoming_invoices
  add column paid_amount_cents bigint check (paid_amount_cents is null or paid_amount_cents >= 0),
  add column paid_skonto_cents bigint not null default 0 check (paid_skonto_cents >= 0),
  add column paid_method text check (paid_method is null or paid_method in ('ueberweisung', 'lastschrift', 'bar', 'kreditkarte', 'verrechnung')),
  add column paid_note text,
  add column paid_by text;

-- Bezahlt bleibt abgeschlossen; nur eine von Hand erfasste Zahlung (nicht aus einem Zahlungslauf) darf zurückgenommen werden.
create or replace function app.guard_incoming() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'erfasst' then
      raise exception 'Freigegebene oder bezahlte Eingangsrechnungen werden nicht gelöscht' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status = 'bezahlt' and new.status = 'freigegeben'
     and not exists (select 1 from app.payment_run_items where incoming_invoice_id = old.id)
     and (new.net_cents, new.vat_cents, new.supplier_id, new.invoice_no)
         is not distinct from (old.net_cents, old.vat_cents, old.supplier_id, old.invoice_no) then
    return new;
  end if;
  if old.status = 'bezahlt' and (new.net_cents, new.vat_cents, new.supplier_id, new.invoice_no, new.status)
       is distinct from (old.net_cents, old.vat_cents, old.supplier_id, old.invoice_no, old.status) then
    raise exception 'Bezahlte Eingangsrechnung ist abgeschlossen' using errcode = 'check_violation';
  end if;
  return new;
end $$;
