-- Bestand: offene Ausschreibungen mit Abgabefrist → je eine Aufgabe (feste ID wie im Code: md5('tender-task:' || id)).
insert into app.tasks (id, title, description, due_date, status, entity_type, entity_id, created_by)
select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid,
       'Abgabefrist Ausschreibung: ' || t.title,
       t.authority || ' – Abgabe bis ' || to_char(t.deadline_at at time zone 'Europe/Berlin', 'DD.MM.YYYY HH24:MI') || ' Uhr',
       (t.deadline_at at time zone 'Europe/Berlin')::date, 'open', 'tender', t.id, 'system'
  from app.tenders t, lateral (select md5('tender-task:' || t.id::text) as h) x
 where t.deadline_at is not null and t.status in ('neu', 'pruefen', 'bearbeitung')
on conflict (id) do nothing;
