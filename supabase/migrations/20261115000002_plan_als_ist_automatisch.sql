-- Ahmed 09.10.: „Soll als Ist nach zwei Tagen“ – Einsätze ohne erfasste Zeit werden nach N Tagen automatisch mit den
-- Plan-Zeiten als Ist übernommen (Quelle „soll_bestaetigt“, Protokollgrund „automatisch“). Nur Einsätze ab dem Tag
-- des Einschaltens (kein rückwirkendes Auffüllen alter Monate). null = aus.
alter table app.time_settings add column auto_confirm_days int check (auto_confirm_days between 1 and 14);
alter table app.time_settings add column auto_confirm_since date;
update app.time_settings set auto_confirm_days = 2, auto_confirm_since = (now() at time zone 'Europe/Berlin')::date;
