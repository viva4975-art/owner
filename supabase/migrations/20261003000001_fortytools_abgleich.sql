-- Abgleich mit Fortytools (Screenshots + Rechnung 1038193 vom 25.09.2026):
--   * Rechnungsnummern fortlaufend ohne Jahr (Fortytools: 1038193, nächste Nr. 1038301)
--   * Skonto je Kunde ("mit 3% Skonto bis ... oder ohne Abzug bis ...")
--   * Zusatztext je Leistung (z. B. "3.099,86 € + 5,07% Tariflohnerhöhung ab 01.01.2026")
--   * Fax im Firmenstamm

-- ---------------------------------------------------------------------------
-- Nummernkreise: ein fortlaufender Zähler je Kreis, Startwert einstellbar
-- ---------------------------------------------------------------------------

create table app.number_ranges (
  key text primary key,
  prefix text not null default '',
  next_value bigint not null check (next_value > 0),
  updated_at timestamptz not null default now()
);
alter table app.number_ranges enable row level security;
grant all on app.number_ranges to service_role;

-- Startwert: nächste freie Fortytools-Nummer. Vor dem Live-Start auf den dann aktuellen Wert setzen,
-- damit sich die Kreise nicht überschneiden (siehe CLAUDE.md).
insert into app.number_ranges (key, prefix, next_value) values ('invoice', '', 1038301)
on conflict (key) do nothing;

alter table app.invoices alter column number_seq type bigint;
drop table app.invoice_number_counters;

-- ---------------------------------------------------------------------------
-- Skonto
-- ---------------------------------------------------------------------------

alter table app.customers
  add column skonto_percent_bp integer check (skonto_percent_bp between 1 and 1000),
  add column skonto_days integer check (skonto_days between 1 and 90),
  add constraint skonto_complete check ((skonto_percent_bp is null) = (skonto_days is null)),
  add constraint skonto_before_due check (skonto_days is null or skonto_days < payment_terms_days);

alter table app.invoices
  add column skonto_percent_bp integer,
  add column skonto_days integer,
  add column skonto_date date;

-- ---------------------------------------------------------------------------
-- Zusatztext je Leistung, Fax
-- ---------------------------------------------------------------------------

alter table app.site_services add column note text;
alter table app.company add column fax text;

-- ---------------------------------------------------------------------------
-- Ausstellen: Nummer aus dem fortlaufenden Kreis, Skonto einfrieren
-- ---------------------------------------------------------------------------

create or replace function app.issue_invoice(
  p_invoice_id uuid,
  p_issue_date date,
  p_seller jsonb,
  p_buyer jsonb,
  p_actor uuid default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_inv app.invoices;
  v_seq bigint;
  v_prefix text;
  v_number text;
  v_lines integer;
  v_cust app.customers;
  v_skonto boolean;
begin
  select * into v_inv from app.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'Rechnung % nicht gefunden', p_invoice_id;
  end if;
  if v_inv.status = 'issued' then
    return v_inv.number; -- idempotent: erneuter Aufruf liefert dieselbe Nummer
  end if;

  select count(*) into v_lines from app.invoice_lines where invoice_id = p_invoice_id;
  if v_lines = 0 then
    raise exception 'Rechnung ohne Positionen kann nicht ausgestellt werden' using errcode = 'check_violation';
  end if;

  -- Gegenprobe: gespeicherte Summen müssen zu den Positionen passen (Cent-genau).
  if exists (
    select 1 from app.invoice_lines
     where invoice_id = p_invoice_id
       and net_cents <> round(quantity_milli::numeric * unit_price_cents / 1000)
  ) or v_inv.net_cents <> (select sum(net_cents) from app.invoice_lines where invoice_id = p_invoice_id)
    or v_inv.gross_cents <> v_inv.net_cents + v_inv.vat_cents
    or v_inv.payable_cents <> v_inv.gross_cents - v_inv.prepaid_cents
  then
    raise exception 'Rechnungssummen sind inkonsistent – bitte Entwurf neu berechnen' using errcode = 'check_violation';
  end if;

  if p_issue_date > (now() at time zone 'Europe/Berlin')::date then
    raise exception 'Rechnungsdatum darf nicht in der Zukunft liegen' using errcode = 'check_violation';
  end if;

  -- Zeilensperre auf dem Nummernkreis: bricht die Transaktion ab, wird auch der Zähler
  -- zurückgerollt → keine Lücken.
  update app.number_ranges
     set next_value = next_value + 1, updated_at = now()
   where key = 'invoice'
  returning next_value - 1, prefix into v_seq, v_prefix;
  if v_seq is null then
    raise exception 'Nummernkreis "invoice" ist nicht eingerichtet';
  end if;
  v_number := v_prefix || v_seq::text;

  select * into v_cust from app.customers where id = v_inv.customer_id;
  -- Skonto nur auf Forderungen (nicht auf Storno/Korrektur/negative Beträge)
  v_skonto := v_cust.skonto_percent_bp is not null and v_inv.kind in ('invoice', 'partial', 'final')
              and v_inv.payable_cents > 0;

  update app.invoices set
    status = 'issued',
    number = v_number,
    number_year = extract(year from p_issue_date)::integer,
    number_seq = v_seq,
    issue_date = p_issue_date,
    due_date = p_issue_date + case when v_inv.kind = 'cancellation' or v_inv.payable_cents <= 0 then 0
                                   else coalesce(v_cust.payment_terms_days, 30) end,
    skonto_percent_bp = case when v_skonto then v_cust.skonto_percent_bp end,
    skonto_days = case when v_skonto then v_cust.skonto_days end,
    skonto_date = case when v_skonto then p_issue_date + v_cust.skonto_days end,
    seller_snapshot = p_seller,
    buyer_snapshot = p_buyer,
    issued_at = now(),
    issued_by = p_actor
  where id = p_invoice_id;

  insert into app.audit_log (actor, action, entity, entity_id, details)
  values (coalesce(p_actor::text, 'system'), 'issue', 'invoice', p_invoice_id,
          jsonb_build_object('number', v_number, 'gross_cents', v_inv.gross_cents));

  return v_number;
end $$;

revoke execute on function app.issue_invoice(uuid, date, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function app.issue_invoice(uuid, date, jsonb, jsonb, uuid) to service_role;
