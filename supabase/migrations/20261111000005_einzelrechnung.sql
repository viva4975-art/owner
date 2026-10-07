-- Runde 23 (Ahmed: Einzelrechnungen wie Fortytools, z. B. Münchner Wohnen mit bis zu 600 Bestellungen im Jahr):
-- abweichende Rechnungsadresse je Rechnung, Kundenreferenz, Zahlungsbedingung je Rechnung, Leistungszeitraum je
-- Position (BT-134/135) und berichtigte Fassungen ausgestellter Rechnungen (Anschrift) mit eigener Belegversion.
alter table app.invoices
  add column bill_address jsonb,
  add column customer_reference text,
  add column payment_terms_days smallint check (payment_terms_days is null or payment_terms_days between 0 and 180),
  add column no_skonto boolean not null default false;

alter table app.invoice_lines
  add column period_start date,
  add column period_end date,
  add constraint invoice_lines_period check (period_start is null or period_end is null or period_end >= period_start);

-- Belege je Fassung (0 = Original, 1.. = berichtigte Anschrift). Original bleibt unverändert im Archiv.
alter table app.invoice_documents add column revision integer not null default 0;

create table app.invoice_revisions (
  id uuid primary key,
  invoice_id uuid not null references app.invoices (id),
  revision integer not null check (revision > 0),
  buyer_snapshot jsonb not null,
  reason text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (invoice_id, revision)
);
create trigger invoice_revisions_append_only before update or delete on app.invoice_revisions
for each row execute function app.deny_change();
alter table app.invoice_revisions enable row level security;
create policy invoice_revisions_office on app.invoice_revisions for select to authenticated
  using ((select app.is_office()));
grant select on app.invoice_revisions to authenticated;
grant all on app.invoice_revisions to service_role;

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
  v_site app.sites;
  v_skonto boolean;
  v_terms integer;
  v_sk_pct integer;
  v_sk_days integer;
  v_group app.invoice_groups;
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
  v_terms := v_cust.payment_terms_days;
  v_sk_pct := v_cust.skonto_percent_bp;
  v_sk_days := v_cust.skonto_days;
  -- Rechnungsgruppe (Rechnungseinstellungen) vor Kunde: Gruppe der Rechnung, sonst die des Objekts
  if v_inv.site_id is not null then
    select * into v_site from app.sites where id = v_inv.site_id;
  end if;
  select * into v_group from app.invoice_groups
   where id = coalesce(v_inv.invoice_group_id, v_site.invoice_group_id);
  if found then
    v_terms := coalesce(v_group.bill_payment_terms_days, v_terms);
    v_sk_pct := v_group.bill_skonto_percent_bp;
    v_sk_days := v_group.bill_skonto_days;
  end if;
  -- Alt: abweichende Rechnungsangaben direkt am Objekt gehen vor (Zahlungsziel, Skonto)
  if v_inv.site_id is not null then
    if v_site.billing_mode = 'eigen' then
      v_terms := coalesce(v_site.bill_payment_terms_days, v_terms);
      if v_site.bill_skonto_custom then
        v_sk_pct := v_site.bill_skonto_percent_bp;
        v_sk_days := v_site.bill_skonto_days;
      end if;
    end if;
  end if;
  -- Einzelrechnung (Runde 23): Zahlungsbedingung je Rechnung geht vor
  if v_inv.payment_terms_days is not null then
    v_terms := v_inv.payment_terms_days;
  end if;
  if v_inv.no_skonto then
    v_sk_pct := null;
  end if;
  -- Skonto nur auf Forderungen (nicht auf Storno/Korrektur/negative Beträge)
  v_skonto := v_sk_pct is not null and v_inv.kind in ('invoice', 'partial', 'final')
              and v_inv.payable_cents > 0;

  update app.invoices set
    status = 'issued',
    number = v_number,
    number_year = extract(year from p_issue_date)::integer,
    number_seq = v_seq,
    issue_date = p_issue_date,
    due_date = p_issue_date + case when v_inv.kind = 'cancellation' or v_inv.payable_cents <= 0 then 0
                                   else coalesce(v_terms, 30) end,
    skonto_percent_bp = case when v_skonto then v_sk_pct end,
    skonto_days = case when v_skonto then v_sk_days end,
    skonto_date = case when v_skonto then p_issue_date + v_sk_days end,
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
