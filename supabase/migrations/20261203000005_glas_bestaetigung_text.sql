-- Glasreinigung (Ahmed 19.10.: „Bestätigung bei manchen rausgenommen“): Die Übernahme in die Bestätigungsliste
-- (20261203000003) nahm nur Termine mit gesetztem Häkchen. Termine, bei denen nur der Bestätigungstext stand
-- (z. B. „Tel. bestätigt am …“, Häkchen nicht gesetzt), bekommen ihn jetzt ebenfalls als Bestätigung (Datum unbekannt).
update app.glass_appointments
   set confirmations = confirmations || jsonb_build_array(jsonb_build_object(
         'id', md5('glas-best-text:' || id::text)::uuid, 'at', null,
         'text', left(trim(confirm_note), 300), 'by', created_by)),
       confirmed = true
 where nullif(trim(confirm_note), '') is not null
   and not exists (select 1 from jsonb_array_elements(confirmations) c where c->>'text' = left(trim(confirm_note), 300));
