-- Fund 07.10.: Der Fortytools-XML-Import hat XML-Entitäten nicht aufgelöst („Rußbach GmbH &amp; Co.KG“).
-- Einmalige Korrektur der übernommenen Texte (nur die Zeichenkodierung, kein inhaltlicher Eingriff); Schutz-Trigger
-- der Tabellen werden dafür kurz ausgesetzt.
do $$
declare
  t text;
  c record;
  expr text;
begin
  foreach t in array array['customers', 'sites', 'site_services', 'employees', 'employee_private', 'invoice_groups',
                           'offers', 'offer_lines', 'service_types', 'tg_objects', 'legacy_invoices', 'legacy_invoice_lines']
  loop
    execute format('alter table app.%I disable trigger user', t);
    for c in select column_name from information_schema.columns
              where table_schema = 'app' and table_name = t and data_type = 'text' loop
      expr := format($f$replace(replace(replace(replace(replace(%1$I, '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&apos;', ''''), '&amp;', '&')$f$, c.column_name);
      execute format($f$update app.%I set %I = %s where %I ~ '&(amp|lt|gt|quot|apos);'$f$, t, c.column_name, expr, c.column_name);
    end loop;
    execute format('alter table app.%I enable trigger user', t);
  end loop;
end $$;
