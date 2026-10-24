-- Übernommene Leistungen mit dem Objektnamen als Titel (Fortytools-Positionstitel) → Leistungsart (Ahmed 25.10.)
with fix as (
  select ss.id, coalesce(nullif(trim(t.name), ''), 'Unterhaltsreinigung') as title
    from app.site_services ss
    join app.sites s on s.id = ss.site_id
    left join app.service_types t on t.id = ss.service_type_id
   where lower(regexp_replace(trim(ss.description), '\s+', ' ', 'g'))
       = lower(regexp_replace(trim(s.name), '\s+', ' ', 'g'))
)
update app.site_services ss set description = fix.title, updated_at = now(), version = version + 1
  from fix where ss.id = fix.id;

-- dieselbe Korrektur in noch offenen Rechnungsentwürfen (Positionen aus diesen Leistungen)
update app.invoice_lines l set description = ss.description
  from app.site_services ss, app.invoices i, app.sites s
 where l.source_service_id = ss.id and i.id = l.invoice_id and i.status = 'draft' and s.id = ss.site_id
   and lower(regexp_replace(trim(l.description), '\s+', ' ', 'g'))
     = lower(regexp_replace(trim(s.name), '\s+', ' ', 'g'));
