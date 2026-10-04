-- Angebote wie Fortytools: Alternativpositionen (nicht in der Summe), Folgeangebot (ersetzt das vorige Angebot).

alter table app.offer_lines add column alternative boolean not null default false;

alter table app.offers add column predecessor_id uuid references app.offers (id);
-- je Angebot höchstens ein direktes Folgeangebot (doppeltes Absenden legt keins doppelt an)
create unique index offers_one_successor on app.offers (predecessor_id) where predecessor_id is not null;

-- „zuletzt bearbeitete Kunden“ je Benutzer
create index if not exists audit_log_actor_at on app.audit_log (actor, at desc);
