-- Ahmed 09.10.: Leistungen mit Zyklus 2-monatlich … jährlich werden nach Ausführung abgerechnet („Leistungen
-- verrichten“), nicht mehr automatisch im Voraus im Monatslauf. Art „special“ = über Ausführungen abgerechnet;
-- der Zyklus zeigt nur noch die Fälligkeit. Wer weiter automatisch abrechnen will, stellt es in der Leistung um.
update app.site_services
   set kind = 'special', updated_at = now()
 where kind = 'monthly_flat'
   and billing_cycle in ('zweimonatlich', 'quartalsweise', 'halbjaehrlich', 'jaehrlich');
