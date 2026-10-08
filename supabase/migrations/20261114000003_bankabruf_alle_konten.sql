-- Konten aus der Bank-Anmeldung sind eigene Konten – auch wenn die IBAN in den Firmendaten fehlt oder abweicht
-- (Fund 08.10.: Targobank wurde nicht abgerufen, weil die IBAN unter Firmendaten nicht passte). Je IBAN bleibt nur das
-- Konto der neuesten aktiven Freigabe aktiv.
update app.bank_feed_accounts a set active = true
  from app.bank_connections c
 where c.id = a.connection_id and c.status = 'aktiv' and a.iban is not null and not a.active
   and not exists (
     select 1 from app.bank_feed_accounts b join app.bank_connections cb on cb.id = b.connection_id
      where b.iban = a.iban and b.uid <> a.uid and cb.status = 'aktiv' and cb.activated_at > c.activated_at);
