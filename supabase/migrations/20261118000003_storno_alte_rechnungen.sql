-- Storno/Korrektur von Rechnungen aus der Zeit vor der Umstellung (Fortytools) in der neuen App (Ahmed 09.10.):
-- Fortytools nutzt denselben Nummernkreis – dort stornieren würde eine Nummer doppelt vergeben.
alter table app.invoices add column original_legacy_invoice_id uuid references app.legacy_invoices (id);
create index on app.invoices (original_legacy_invoice_id) where original_legacy_invoice_id is not null;
create unique index invoices_one_legacy_cancellation on app.invoices (original_legacy_invoice_id)
  where kind = 'cancellation';

alter table app.invoices drop constraint invoices_check1;
alter table app.invoices add constraint invoices_check1
  check (kind not in ('cancellation', 'correction') or original_invoice_id is not null
         or original_legacy_invoice_id is not null);

-- Offene Posten der alten Rechnungen: ausgestellte Storno-/Korrekturrechnungen der neuen App mindern den offenen Betrag
create or replace view app.legacy_open_items with (security_invoker = true) as
 select l.id as invoice_id,
        l.number,
        l.customer_id,
        l.issue_date,
        l.due_date,
        l.gross_cents,
        (l.gross_cents::numeric +
           case
             when l.ft_root_id is null or l.id <> (select p.id from app.legacy_invoices p
                                                    where p.ft_root_id = l.ft_root_id and not p.paid and p.gross_cents > 0
                                                    order by p.number limit 1) then 0::numeric
             else coalesce((select sum(k.gross_cents) from app.legacy_invoices k
                             where k.ft_root_id = l.ft_root_id and not k.paid and k.gross_cents < 0
                               and not k.customer_id is distinct from l.customer_id), 0::numeric)
           end
         - l.paid_part_cents::numeric
         + coalesce((select sum(d.payable_cents) from app.invoices d
                      where d.original_legacy_invoice_id = l.id and d.status = 'issued'), 0::numeric))::bigint as open_cents
   from app.legacy_invoices l
  where not l.paid and l.gross_cents > 0;
