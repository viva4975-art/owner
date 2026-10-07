-- Artikel wie Fortytools: Verkaufspreis (für „+ Artikel hinzufügen“ in Rechnungen), Beschreibung, Hersteller-Nr.
alter table app.articles
  add column sales_price_cents bigint check (sales_price_cents is null or sales_price_cents >= 0),
  add column description text,
  add column maker_no text;
