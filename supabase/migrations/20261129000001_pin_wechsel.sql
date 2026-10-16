-- Anmeldung mit dem Geburtsdatum (Standard-PIN TTMMJJ) → danach muss eine eigene PIN festgelegt werden (Ahmed 17.10.).
alter table app.employee_pins add column if not exists must_change boolean not null default false;

-- automatisch aus dem Geburtsdatum angelegte PINs: beim nächsten Öffnen der App neue PIN verlangen
update app.employee_pins set must_change = true where set_by = 'Geburtsdatum (automatisch)';
