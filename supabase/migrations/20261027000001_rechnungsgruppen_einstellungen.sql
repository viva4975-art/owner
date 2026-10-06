-- Rechnungsgruppen = wiederverwendbare Rechnungseinstellungen (Ahmed 06.10.2026): Rechnungsadresse, Ansprechpartner,
-- Rechnungs-E-Mails, Format, Leitweg-ID (buyer_reference), Lieferantennummer, Zahlungsziel, Skonto, Bestellnummer, Texte.
-- Jedes Objekt wählt eine Gruppe. „combine“ = alle Objekte der Gruppe auf EINER Sammelrechnung (bisheriges Verhalten),
-- sonst je Objekt eine eigene Rechnung mit den Einstellungen der Gruppe. Am Kunden werden keine Rechnungsangaben mehr gepflegt.

alter table app.invoice_groups
  add column combine boolean not null default false,
  add column bill_name text,
  add column bill_name2 text,
  add column bill_street text,
  add column bill_postal_code text check (bill_postal_code is null or bill_postal_code ~ '^[0-9]{5}$'),
  add column bill_city text,
  add column bill_contact_name text,
  add column bill_emails text[] not null default '{}',
  add column bill_format app.invoice_format not null default 'zugferd',
  add column bill_supplier_no text,
  add column bill_payment_terms_days integer check (bill_payment_terms_days is null or bill_payment_terms_days between 0 and 365),
  add column bill_skonto_percent_bp integer check (bill_skonto_percent_bp is null or bill_skonto_percent_bp between 1 and 1000),
  add column bill_skonto_days integer check (bill_skonto_days is null or bill_skonto_days between 1 and 90),
  add constraint invoice_groups_bill_address_complete check (
    bill_name is null or (bill_street is not null and bill_postal_code is not null and bill_city is not null)),
  add constraint invoice_groups_skonto_pair check ((bill_skonto_percent_bp is null) = (bill_skonto_days is null));

-- Bestehende Gruppen: waren Sammelrechnungen; Rechnungsangaben vom Kunden übernehmen
update app.invoice_groups g set
  combine = true,
  bill_emails = c.invoice_emails,
  bill_format = c.invoice_format,
  buyer_reference = coalesce(g.buyer_reference, c.leitweg_id),
  bill_supplier_no = c.supplier_no,
  bill_payment_terms_days = c.payment_terms_days,
  bill_skonto_percent_bp = case when c.skonto_days is not null then c.skonto_percent_bp end,
  bill_skonto_days = case when c.skonto_percent_bp is not null then c.skonto_days end
from app.customers c where c.id = g.customer_id;

-- Objekte mit abweichenden Rechnungsangaben (ohne Sammelrechnung): eigene Gruppe daraus machen
with eigen as (
  select s.*, c.invoice_emails as c_emails, c.invoice_format as c_format, c.leitweg_id as c_leitweg,
         c.supplier_no as c_supplier, c.payment_terms_days as c_terms, c.skonto_percent_bp as c_sk_pct,
         c.skonto_days as c_sk_days,
         (substr(md5('site-billing:' || s.id), 1, 8) || '-' || substr(md5('site-billing:' || s.id), 9, 4) || '-4' ||
          substr(md5('site-billing:' || s.id), 14, 3) || '-8' || substr(md5('site-billing:' || s.id), 18, 3) || '-' ||
          substr(md5('site-billing:' || s.id), 21, 12))::uuid as gid
    from app.sites s join app.customers c on c.id = s.customer_id
   where s.billing_mode = 'eigen' and s.invoice_group_id is null
)
insert into app.invoice_groups (id, customer_id, name, combine, bill_name, bill_name2, bill_street, bill_postal_code,
                                bill_city, bill_contact_name, bill_emails, bill_format, buyer_reference, bill_supplier_no,
                                bill_payment_terms_days, bill_skonto_percent_bp, bill_skonto_days)
select gid, customer_id, 'Objekt ' || site_no || ' ' || name, false, bill_name, bill_name2, bill_street, bill_postal_code,
       bill_city, bill_contact_name, coalesce(nullif(bill_emails, '{}'), c_emails), coalesce(bill_format, c_format),
       coalesce(bill_leitweg_id, c_leitweg), coalesce(bill_supplier_no, c_supplier),
       coalesce(bill_payment_terms_days, c_terms),
       case when bill_skonto_custom then bill_skonto_percent_bp else case when c_sk_days is not null then c_sk_pct end end,
       case when bill_skonto_custom then bill_skonto_days else case when c_sk_pct is not null then c_sk_days end end
  from eigen;
update app.sites s set invoice_group_id = g.id, billing_mode = 'kunde', bill_name = null, bill_name2 = null,
       bill_street = null, bill_postal_code = null, bill_city = null, bill_contact_name = null, bill_emails = null,
       bill_format = null, bill_leitweg_id = null, bill_supplier_no = null, bill_payment_terms_days = null,
       bill_skonto_custom = false, bill_skonto_percent_bp = null, bill_skonto_days = null
  from app.invoice_groups g
 where s.billing_mode = 'eigen' and s.invoice_group_id is null
   and g.id = (substr(md5('site-billing:' || s.id), 1, 8) || '-' || substr(md5('site-billing:' || s.id), 9, 4) || '-4' ||
               substr(md5('site-billing:' || s.id), 14, 3) || '-8' || substr(md5('site-billing:' || s.id), 18, 3) || '-' ||
               substr(md5('site-billing:' || s.id), 21, 12))::uuid;

-- Je Kunde eine Gruppe „Standard“ (Rechnungsangaben des Kunden) für alle Objekte ohne Gruppe
insert into app.invoice_groups (id, customer_id, name, combine, bill_emails, bill_format, buyer_reference, bill_supplier_no,
                                bill_payment_terms_days, bill_skonto_percent_bp, bill_skonto_days, bill_contact_name)
select (substr(md5('standard-group:' || c.id), 1, 8) || '-' || substr(md5('standard-group:' || c.id), 9, 4) || '-4' ||
        substr(md5('standard-group:' || c.id), 14, 3) || '-8' || substr(md5('standard-group:' || c.id), 18, 3) || '-' ||
        substr(md5('standard-group:' || c.id), 21, 12))::uuid,
       c.id,
       case when exists (select 1 from app.invoice_groups x where x.customer_id = c.id and x.name = 'Standard')
            then 'Standard (je Objekt)' else 'Standard' end,
       false, c.invoice_emails, c.invoice_format, c.leitweg_id, c.supplier_no, c.payment_terms_days,
       case when c.skonto_days is not null then c.skonto_percent_bp end,
       case when c.skonto_percent_bp is not null then c.skonto_days end, c.contact_name
  from app.customers c
 where exists (select 1 from app.sites s where s.customer_id = c.id and s.invoice_group_id is null)
    or not exists (select 1 from app.invoice_groups g where g.customer_id = c.id)
on conflict (id) do nothing;
update app.sites s set invoice_group_id =
       (substr(md5('standard-group:' || s.customer_id), 1, 8) || '-' || substr(md5('standard-group:' || s.customer_id), 9, 4) || '-4' ||
        substr(md5('standard-group:' || s.customer_id), 14, 3) || '-8' || substr(md5('standard-group:' || s.customer_id), 18, 3) || '-' ||
        substr(md5('standard-group:' || s.customer_id), 21, 12))::uuid
 where s.invoice_group_id is null;

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

revoke execute on function app.issue_invoice(uuid, date, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function app.issue_invoice(uuid, date, jsonb, jsonb, uuid) to service_role;


alter table app.customers alter column invoice_format set default 'zugferd';
