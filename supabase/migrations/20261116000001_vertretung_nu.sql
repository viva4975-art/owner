-- Einsätze für abwesende Mitarbeiter: Tag als „nicht notwendig“ markieren oder durch eine Nachunternehmer-Bestellung
-- abdecken. Beides ist für die eigene Planung ein Ausfall (kein eigener Mitarbeiter, kein Soll); die Bestellung wird
-- zur Nachvollziehbarkeit am Tag vermerkt.
alter table app.shift_exceptions add column subcontract_id uuid references app.subcontracts (id);
create index on app.shift_exceptions (subcontract_id) where subcontract_id is not null;
