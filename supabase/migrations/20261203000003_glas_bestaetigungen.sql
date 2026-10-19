-- Glasreinigung: mehrere Terminbestätigungen je Termin (Ahmed 19.10.), z. B. Hausmeister telefonisch, Schule per Mail.
-- Liste am Termin selbst → wird der Termin verschoben, bleiben die Bestätigungen dabei. [{id, at, text, by}]
alter table app.glass_appointments add column confirmations jsonb not null default '[]'::jsonb;
update app.glass_appointments
   set confirmations = jsonb_build_array(jsonb_build_object(
         'id', gen_random_uuid(), 'at', created_at::date::text,
         'text', coalesce(nullif(trim(confirm_note), ''), 'bestätigt'), 'by', created_by))
 where confirmed and confirmations = '[]'::jsonb;
