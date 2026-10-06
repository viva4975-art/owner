-- Sonderleistungen und Regiestunden werden nicht im Monatslauf abgerechnet → Zyklus „je Ausführung“
update app.site_services set billing_cycle = 'je_ausfuehrung' where kind in ('special', 'hourly');
