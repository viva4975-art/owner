-- Fund (Ahmed 19.10.): Bei der Umstellung auf mehrere Bestätigungen bekam die bisherige Bestätigung das Anlagedatum des
-- Termins als „bestätigt am“ – das echte Datum war nie gespeichert. Datum dort leeren (Text bleibt).
update app.glass_appointments a
   set confirmations = (
         select coalesce(jsonb_agg(case when c->>'at' = a.created_at::date::text and c->>'by' = a.created_by
                                        then jsonb_set(c, '{at}', 'null'::jsonb) else c end), '[]'::jsonb)
           from jsonb_array_elements(a.confirmations) c)
 where confirmations <> '[]'::jsonb;
